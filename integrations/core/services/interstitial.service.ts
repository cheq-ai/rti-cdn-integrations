// cspell:ignore CHEQ
import { Action } from "../models/action.model";
import { Config } from "../models/config.interface";
import {
  ClientBinding,
  HmacHex32,
  InterstitialAnswer,
  InterstitialFacts,
  InterstitialOutcome,
  InterstitialRequest,
  InterstitialSettings,
  ResolvedInterstitialSettings,
  ValidMark,
} from "../models/interstitial.model";
import { InterstitialScriptValues, interstitialPage } from "../helpers/interstitial-page-helpers";
import { isHttpsUrl, isLanguageTag, isLogoUrl, isTextUpTo } from "../helpers/page-setting-checks";
import { RTIStatelessUtils } from "./rti-stateless-utils";

/** For isAction, errorMessage, getCookieValue, parseExpiresAt and originalReferer. It holds no state. */
const utils = new RTIStatelessUtils();

/** The problem of readTagLine for a line that is missing, blank or still `REPLACE_ME`. */
const TAG_NOT_SET = "it is not set";

/** The longest tag line that is read, in characters, without the whitespace around it. */
const MAX_TAG_LINE_LENGTH = 800;

/** The attribute names that the page's script sets: a letter, then letters, digits, `_`, `.`, `:` or `-`. */
const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

/** The character references that are read in a value, and the characters they stand for. */
const REFERENCES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };

/** U+2028 and U+2029, built from their codes so that this file does not hold them. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** The default of `binding`: the default of the CAPTCHA's `sessionBinding`. */
const DEFAULT_BINDING: ClientBinding = { ip: "exact", userAgent: true };

/** The mark's cookie name. */
const MARK_NAME = "_cq_it";

/** The mark's Max-Age, in seconds, which the page's script writes. */
const MARK_MAX_AGE_SECONDS = 60;

/**
 * How long readMark accepts a mark beyond maxWaitMs after page made it, in milliseconds: the 60 seconds of the mark's
 * Max-Age, plus 10 seconds for the page to arrive.
 */
const MARK_ACCEPTED_AFTER_WAIT_MS = 70000;

/**
 * A mark after `<setup id>|`, as page writes it: `<expiresAt>.<signature>|<ray id>|<page tag>|<Referer>`. The expiry in
 * digits, the signature in 32 and the page tag in 16 lower-case hex characters. The ray id and the Referer are
 * URL-encoded, so neither holds a `|`. The Referer is empty when there is none.
 */
const MARK_PARTS = /^(\d+)\.([0-9a-f]{32})\|([^|]*)\|([0-9a-f]{16})\|([^|]*)$/;

/**
 * Reads the CHEQ tag line of `config.interstitial.tag`, once, at cold start. The answer is the line's attributes as
 * [name, value] pairs, in the line's order, or the problem that keeps the interstitial off.
 *
 * The line is never written into the page as text. The page's script builds the `<script>` element itself and sets
 * these pairs on it one by one, so nothing in the line can become markup or code of our page. Left out:
 * - `async` and `defer`: the design says that a script added by code is asynchronous anyway.
 * - an attribute whose name starts with `on`: an event handler would be code in our page.
 * The other attributes are kept, so that the tag gets the settings it has on the customer's own pages.
 *
 * A value can be in double quotes, in single quotes or without quotes. As in HTML, the names come out in lower case, and
 * of two attributes with the same name the first is kept (the HTML standard, "Attribute name state", read on
 * 2026-11-23). In a value, `&amp;`, `&quot;`, `&#39;`, `&lt;` and `&gt;` are read as the characters they stand for, in
 * one pass. Any other `&…;` stays as written.
 *
 * The problems, in the order they are checked: the line is not set (missing, blank, `REPLACE_ME` or not a string). It
 * is longer than 800 characters, without the whitespace around it. It is not one `<script …></script>` element. It has
 * text between the two tags. It has an attribute name outside `^[A-Za-z][A-Za-z0-9_.:-]*$`. It has a value with `<`,
 * `>` or a control character, U+2028 and U+2029 included (the design says: to keep the page small and its script
 * simple). Its `src` does not start with `https://` or is not a URL. It has no `class` (the design says that the tag
 * finds its own element by its class). The attributes that are left out are not checked.
 * @param line the value of the setting, as the customer wrote it
 */
export function readTagLine(line: unknown): { attributes: [string, string][] } | { problem: string } {
  const text = typeof line === "string" ? line.trim() : "";
  if (text === "" || text === "REPLACE_ME") {
    return { problem: TAG_NOT_SET };
  }
  if (text.length > MAX_TAG_LINE_LENGTH) {
    return { problem: `it is longer than ${MAX_TAG_LINE_LENGTH} characters` };
  }
  const element = readScriptElement(text);
  if (element === undefined) {
    return { problem: "it is not one <script …></script> element" };
  }
  if (element.content.trim() !== "") {
    return { problem: "it has text between <script> and </script>" };
  }
  const attributes: [string, string][] = [];
  const seen = new Set<string>();
  for (const [writtenName, writtenValue] of element.attributes) {
    const name = writtenName.toLowerCase();
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    if (name === "async" || name === "defer" || name.startsWith("on")) {
      continue;
    }
    if (!ATTRIBUTE_NAME.test(writtenName)) {
      return { problem: `it has an attribute name a page cannot set: ${writtenName}` };
    }
    const value = writtenValue.replace(/&(?:amp|quot|#39|lt|gt);/g, reference => REFERENCES[reference]);
    if (hasUnsafeCharacter(value)) {
      return { problem: "it has a value with <, > or a control character" };
    }
    attributes.push([name, value]);
  }
  if (!isHttpsUrl(attributeValue(attributes, "src"))) {
    return { problem: "its src does not start with https://" };
  }
  if (attributeValue(attributes, "class").trim() === "") {
    return { problem: "it has no class" };
  }
  return { attributes };
}

/**
 * The passive interstitial in core, for the CDN glue. It reads `config.interstitial` and its tag line once, at cold
 * start, and decides per request. Building it never throws. The instance, its settings and its problems are frozen. It
 * holds only the API key, the checked settings, the on/off fact, the problems and the HMAC function: nothing of a
 * request. The API key and the HMAC function are private fields (`#`), not properties of the instance, so
 * JSON.stringify and Object.keys do not show them.
 */
export class InterstitialService {
  /** Whether the interstitial is on: `enabled` is `true` and the tag line can be read. */
  readonly on: boolean;
  /** The checked settings, every value set, frozen. `undefined` while the interstitial is off. */
  readonly settings: ResolvedInterstitialSettings | undefined;
  /** One text per problem in the settings, for the cold-start warnings. Empty when there is none. Frozen. */
  readonly problems: string[];
  /** The config's apiKey. The key of the mark is made from it, per call. */
  readonly #apiKey: string;
  /** HMAC-SHA256 as 32 hex characters, passed in by the CDN glue, so that core uses no `crypto`. */
  readonly #hmac: HmacHex32;

  /**
   * Reads and checks `config.interstitial`. It does not call `hmac`. Anything that throws while the settings are read
   * turns the interstitial off, with one problem text that says so.
   * @param config the integration's config
   * @param hmac HMAC-SHA256 as its first 32 hex characters, for the mark
   */
  constructor(config: Config, hmac: HmacHex32) {
    let apiKey = "";
    let read: { settings?: ResolvedInterstitialSettings; problems: string[] };
    try {
      apiKey = config.apiKey;
      read = readSettings(config);
    } catch (e) {
      read = { problems: [`interstitial settings could not be read (${utils.errorMessage(e)}), the interstitial is off`] };
    }
    this.#apiKey = apiKey;
    this.#hmac = hmac;
    this.settings = read.settings === undefined ? undefined : freezeSettings(read.settings);
    this.on = read.settings !== undefined;
    this.problems = read.problems;
    Object.freeze(this.problems);
    Object.freeze(this);
  }

  /**
   * What a page load that RTI wants challenged gets while the interstitial is on (the strategy INTERSTITIAL). The first
   * row that matches wins:
   * 1. Not a page load: forward with the verdict. A guard: such a request is not meant to get this strategy.
   * 2. RTI found the tag's session (`sessionFound` is `true`): the action of onSecondVerdict.
   * 3. A valid mark: the page ran, and RTI found no session. The action of onSessionNotFound.
   * 4. Otherwise: show the page.
   * While the interstitial is off, the answer is row 1 whatever the facts. It is not asked then, and so a wrong call
   * stays harmless.
   * @param facts the plain facts about this request
   */
  decide(facts: InterstitialFacts): InterstitialOutcome {
    if (this.settings === undefined) {
      return { kind: "forward", reason: "not-a-page-load" };
    }
    // A declared good bot (a crawler such as Google's or Bing's) is not checked here. RTI is expected to give it a
    // benign verdict, so it does not reach the interstitial (agreed with the PM on 2026-11-24; the product spec's FR-2
    // had asked for a check). If a site's good bots get a suspicious verdict, set that in the policy screen of the CHEQ
    // console: here they would get the interstitial like any visitor.
    if (!facts.pageLoad) {
      return { kind: "forward", reason: "not-a-page-load" };
    }
    if (facts.sessionFound === true) {
      return { kind: "act", action: this.settings.onSecondVerdict, reason: "second-verdict" };
    }
    if (facts.validMark) {
      return { kind: "act", action: this.settings.onSessionNotFound, reason: "no-session" };
    }
    return { kind: "show" };
  }

  /**
   * The interstitial page for this request, as a plain answer: the status of the settings, three headers and the HTML.
   * It makes the mark (`_cq_it`) that the page's script writes right before the reload:
   * `<setup id>|<expiresAt>.<signature>|<ray id>|<page tag>|<Referer>`, the ray id and the Referer URL-encoded.
   * - The key is made from the API key. The setup id, the page tag and the signature are made with the key. All of them
   *   per call: none is kept.
   * - The page tag is a short keyed hash of the URL's path, so that the mark stays short for any URL.
   * - The Referer is the original Referer: `carriedReferer`, else the request's own Referer, as
   *   RTIStatelessUtils.originalReferer gives it. `""` when there is none.
   * - The signature covers the expiry, the ray id, the page tag, the Referer and the binding key, as the CAPTCHA signs
   *   `_cq_rf`.
   * In `"cookie"` mode the script also gets the Referer, for `_cq_ref`. It rejects while the interstitial is off, and
   * when the HMAC rejects. Neither is client input, and the glue catches it.
   * @param request the plain facts of this request
   * @param rayId the ray id of RTI call 1
   * @param carriedReferer an original Referer that the glue already has for this request. It wins over the request's
   *   own Referer.
   */
  async page(request: InterstitialRequest, rayId: string, carriedReferer?: string): Promise<InterstitialAnswer> {
    const settings = this.settings;
    if (settings === undefined) {
      throw new Error("the interstitial is off");
    }
    const url = new URL(request.url);
    const { key, setupId } = await this.#markKey();
    const pageTag = await this.#pageTag(key, url.pathname);
    const referer = utils.originalReferer(carriedReferer || request.referer, url.host) ?? "";
    // The script writes the mark with Max-Age=60, up to maxWaitMs after it starts. So readMark accepts it for those 60
    // seconds after maxWaitMs, plus 10 seconds for the page to arrive.
    const expiresAt = Date.now() + settings.maxWaitMs + MARK_ACCEPTED_AFTER_WAIT_MS;
    const signature = await this.#signature(key, expiresAt, rayId, pageTag, referer, request.bindingKey);
    const markValue = `${setupId}|${expiresAt}.${signature}|${encodeURIComponent(rayId)}|${pageTag}|`
      + encodeURIComponent(referer);
    const values: InterstitialScriptValues = {
      markName: MARK_NAME,
      markValue,
      setupId,
      // No Secure on plain http, so that a local run works (design, "The mark").
      cookieAttributes: url.protocol === "https:" ? "; Path=/; SameSite=Lax; Secure" : "; Path=/; SameSite=Lax",
      maxAgeSeconds: MARK_MAX_AGE_SECONDS,
      tag: settings.tagAttributes,
      maxWaitMs: settings.maxWaitMs,
    };
    if (settings.originalRefererVia === "cookie" && referer !== "") {
      // As it is: the script encodes it for _cq_ref itself.
      values.referer = referer;
    }
    return {
      status: settings.statusCode,
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-Robots-Tag": "noindex",
      },
      body: interstitialPage(settings, rayId, values),
    };
  }

  /**
   * The valid mark of this request, or `undefined`. The glue asks for it before RTI is called (design, handler step 1).
   *
   * What the mark is for: the page's script writes it right before the reload, and the reload brings it. It tells two
   * things. The page ran, so a visitor whose tag did not run gets the action of onSessionNotFound (decide, row 3), and
   * not the page again. And it carries the original Referer of the request that got the page.
   *
   * Why a cookie that the page's script writes, and not a Set-Cookie of ours: a Set-Cookie on the page would hand the
   * mark to any client that keeps cookies, also to one that does not run the page (design, "Approaches").
   *
   * Option C, not built: the Worker remembers the IP, User-Agent, URL and Referer in Cloudflare's Cache API or in KV
   * for 60 seconds, and nothing goes into the browser. The design says that the Cache API works per data center and
   * does nothing on `*.workers.dev`, and that a visitor whose IP changes is not recognized.
   *
   * The client sends any text it likes. The text is read in a `try`, and a part that cannot be parsed or decoded means
   * no mark. Only the first `_cq_it` whose value starts with this setup's id is checked. A mark of another setup is no
   * mark: no HMAC is made for it beyond the key and the id. While the interstitial is off, or without a `_cq_it`
   * cookie, the HMAC is not called. It rejects when the HMAC rejects: that is not client input, and the glue catches
   * it.
   * @param request the plain facts of this request
   */
  async readMark(request: InterstitialRequest): Promise<ValidMark | undefined> {
    if (this.settings === undefined) {
      return undefined;
    }
    const cookies = request.cookie.split(";").map(cookie => cookie.trim());
    if (!cookies.some(cookie => cookie.startsWith(`${MARK_NAME}=`))) {
      return undefined;
    }
    const { key, setupId } = await this.#markKey();
    const mark = readMarkParts(utils.getCookieValue(cookies, `${MARK_NAME}=${setupId}|`));
    if (mark === undefined || Date.now() > mark.expiresAt) {
      return undefined;
    }
    const { expiresAt, rayId, pageTag, referer } = mark;
    const expected = await this.#signature(key, expiresAt, rayId, pageTag, referer, request.bindingKey);
    if (!sameSignature(expected, mark.signature)) {
      return undefined;
    }
    // A valid mark counts on every page of the site, not only on the page it was made for (the owner's decision of
    // 2026-11-22).
    // - Why: an origin often answers the reload with a redirect (a trailing slash, a locale, a campaign URL). A mark
    //   for one page only would give a visitor whose tag did not run a second interstitial on the redirect target.
    // - Whom it concerns: only a client for whom RTI has no tag session: its tag did not run, or the reload came too
    //   early (design, "Reload too early"). The decision does not use the mark when RTI has the session: decide takes
    //   row 2 (sessionFound) before row 3 (a valid mark).
    // - The price: for the 60 seconds of the mark, such a client gets the no-session action on every page of the site,
    //   without a new interstitial. The mark's Referer and customId3 stay on the mark's own page: the Referer below
    //   only with forThisPage, and customId3 only on a request with forThisPage (design, handler step 5).
    const url = new URL(request.url);
    const forThisPage = pageTag === await this.#pageTag(key, url.pathname);
    const valid: ValidMark = { firstRayId: rayId, forThisPage };
    if (forThisPage && request.pageLoad && referer !== "" && isMissingOrThisPage(request.referer, url)) {
      valid.referer = referer;
    }
    return valid;
  }

  /** The mark's key, made from the API key, and this setup's id, made from the key. Per call: neither is kept. */
  async #markKey(): Promise<{ key: string; setupId: string }> {
    const key = await this.#hmac(this.#apiKey, "cheq-interstitial-mark-v1");
    // 8 characters of a keyed hash: the id does not reveal the key (design, "The mark").
    return { key, setupId: (await this.#hmac(key, "cheq-interstitial-setup-id")).slice(0, 8) };
  }

  /** The page tag of a path: the first 16 characters of its keyed hash. */
  async #pageTag(key: string, path: string): Promise<string> {
    return (await this.#hmac(key, JSON.stringify(["page", path]))).slice(0, 16);
  }

  /** The mark's signature, made the way the CAPTCHA signs `_cq_rf`, with its own label `it`. */
  #signature(
    key: string, expiresAt: number, rayId: string, pageTag: string, referer: string, bindingKey: string,
  ): Promise<string> {
    return this.#hmac(key, JSON.stringify(["it", expiresAt, rayId, pageTag, referer, bindingKey]));
  }
}

/**
 * Reads `config.interstitial`: the checked settings while the interstitial is on, and the problems. The other settings
 * are checked only when `enabled` is `true` and the tag line can be read.
 */
function readSettings(config: Config): { settings?: ResolvedInterstitialSettings; problems: string[] } {
  const settings: InterstitialSettings | undefined | null = config.interstitial;
  if (settings === undefined || settings === null) {
    return { problems: [] };
  }
  if (settings.enabled !== true) {
    return {
      problems: settings.enabled === false
        ? []
        : [`interstitial.enabled: ${JSON.stringify(settings.enabled)} is not true or false, the interstitial is off`],
    };
  }
  const tag = readTagLine(settings.tag);
  if ("problem" in tag) {
    return {
      problems: [tag.problem === TAG_NOT_SET
        ? "interstitial.tag is not set, the interstitial is off: paste the tag line from the CHEQ console"
        : `interstitial.tag cannot be read (${tag.problem}), the interstitial is off`],
    };
  }

  // The interstitial is on. A problem from here on leaves it on.
  const problems: string[] = [];
  // Also when both are missing: a src without /i/<hash>.js, and no tagHash.
  const hash = hashInSrc(tag.attributes);
  if (hash === undefined || hash !== config.tagHash) {
    problems.push("interstitial.tag: the hash in its src is not tagHash, check that the tag line and tagHash belong to the same tag");
  }
  // A setting's value when it is valid. Left out: its default. Any other value: its default, and a problem text.
  const valueOf = <T>(name: keyof InterstitialSettings, isValid: (value: unknown) => value is T, allowed: string,
    fallback: T, writtenFallback = String(JSON.stringify(fallback))): T => {
    const value: unknown = settings[name];
    if (value === undefined) {
      return fallback;
    }
    if (isValid(value)) {
      return value;
    }
    problems.push(`interstitial.${name}: ${JSON.stringify(value)} is not ${allowed}, using ${writtenFallback}`);
    return fallback;
  };
  // Read in the order of the settings, so that the problem texts come in that order too.
  const onSecondVerdict = valueOf("onSecondVerdict", isAction, "an Action", Action.ALLOW, "Action.ALLOW");
  const onSessionNotFound = valueOf("onSessionNotFound", isAction, "an Action", Action.ALLOW, "Action.ALLOW");
  const maxWaitMs = valueOf("maxWaitMs", isWholeNumberFrom(1000, 30000), "a whole number from 1000 to 30000", 5000);
  const statusCode = valueOf("statusCode", isStatusCode, "200 or a whole number from 400 to 599", 403);
  const originalRefererVia = valueOf("originalRefererVia", isRefererMode, '"header" or "cookie"', "header");
  const binding = valueOf("binding", isClientBinding, '{ ip: "exact" or "none", userAgent: true or false }', DEFAULT_BINDING);
  const logoUrl = valueOf<string | undefined>("logoUrl", isLogoUrl, "an https:// URL of at most 200 characters", undefined);
  const headline = valueOf("headline", isTextUpTo(60), "text of 1 to 60 characters", "Checking your browser");
  const message = valueOf("message", isTextUpTo(160), "text of 1 to 160 characters", "This usually takes about a second.");
  const lang = valueOf("lang", isLanguageTag, 'a language tag such as "en" or "en-US"', "en");
  const logOutcomes = valueOf("logOutcomes", isBoolean, "true or false", true);
  if (config.challengingStrategy !== undefined) {
    problems.push('challengingStrategy is set but not used for page loads while the interstitial is on');
  }
  return {
    settings: {
      tagAttributes: tag.attributes,
      onSecondVerdict,
      onSessionNotFound,
      maxWaitMs,
      statusCode,
      originalRefererVia,
      // A copy of the two values, so that the settings share no object with the config.
      binding: { ip: binding.ip, userAgent: binding.userAgent },
      logoUrl: logoUrl === undefined ? undefined : new URL(logoUrl).href,
      headline,
      message,
      lang,
      logOutcomes,
    },
    problems,
  };
}

/**
 * Splits a line into the attributes of its start tag, as written, and the text between `<script …>` and the first
 * `</script>`. `undefined` when the line is not one such element: another element, no end tag, something after the end
 * tag, or a start tag that cannot be read (a quote that is not closed, for example).
 */
function readScriptElement(text: string): { attributes: [string, string][]; content: string } | undefined {
  if (!/^<script[\s>]/i.test(text)) {
    return undefined;
  }
  // One attribute, after optional whitespace: a name, and optionally `=` and a value in double quotes, in single quotes
  // or without quotes (up to whitespace or `>`).
  const attribute = /\s*([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>][^\s>]*)))?/y;
  const attributes: [string, string][] = [];
  let position = "<script".length;
  for (;;) {
    attribute.lastIndex = position;
    const match = attribute.exec(text);
    if (match === null) {
      break;
    }
    attributes.push([match[1], match[2] ?? match[3] ?? match[4] ?? ""]);
    position = attribute.lastIndex;
  }
  // The end of the start tag, then the text up to the first end tag, which must end the line.
  const rest = /^\s*>([\s\S]*?)<\/script\s*>/i.exec(text.slice(position));
  if (rest === null || position + rest[0].length !== text.length) {
    return undefined;
  }
  return { attributes, content: rest[1] };
}

/** The value of the attribute `name` among the pairs, or `""` when it is not there. */
function attributeValue(attributes: [string, string][], name: string): string {
  return attributes.find(([attributeName]) => attributeName === name)?.[1] ?? "";
}

/** The hash in the tag's `src`: the `<hash>` of `…/i/<hash>.js` at the end of its path, or `undefined`. */
function hashInSrc(attributes: [string, string][]): string | undefined {
  return /\/i\/([^/]+)\.js$/.exec(new URL(attributeValue(attributes, "src")).pathname)?.[1];
}

/** Whether a value holds `<`, `>`, a control character (U+0000 to U+001F, U+007F to U+009F), U+2028 or U+2029. */
function hasUnsafeCharacter(value: string): boolean {
  return /[<>\x00-\x1F\x7F-\x9F]/.test(value) || value.includes(LINE_SEPARATOR) || value.includes(PARAGRAPH_SEPARATOR);
}

const isAction = (value: unknown): value is Action => utils.isAction(value);

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** A whole number from `min` to `max`. */
const isWholeNumberFrom = (min: number, max: number) => (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

const isStatusCode = (value: unknown): value is number => value === 200 || isWholeNumberFrom(400, 599)(value);

const isRefererMode = (value: unknown): value is "header" | "cookie" => value === "header" || value === "cookie";

/** `{ ip: "exact" or "none", userAgent: true or false }`. Other keys do not matter. */
const isClientBinding = (value: unknown): value is ClientBinding =>
  typeof value === "object" && value !== null
  && ((value as ClientBinding).ip === "exact" || (value as ClientBinding).ip === "none")
  && typeof (value as ClientBinding).userAgent === "boolean";

/** Freezes the settings, their tag attributes, each pair of them and their binding, and gives the settings back. */
function freezeSettings(settings: ResolvedInterstitialSettings): ResolvedInterstitialSettings {
  settings.tagAttributes.forEach(pair => Object.freeze(pair));
  Object.freeze(settings.tagAttributes);
  Object.freeze(settings.binding);
  return Object.freeze(settings);
}

/** The parts of a mark after its setup id, read and decoded. */
interface MarkParts {
  expiresAt: number;
  signature: string;
  rayId: string;
  pageTag: string;
  referer: string;
}

/**
 * The parts of `text`, the client's text after `_cq_it=<setup id>|`, or `undefined` when it is not written exactly as
 * page writes it ({@link MARK_PARTS}). It is read in a `try`: a part that cannot be decoded means no mark, such as a
 * lone `%`, or `%ED%A0%80` (U+D800, half of a surrogate pair, which UTF-8 does not allow). Only the spelling that page
 * writes counts, as RTIStatelessUtils.parseExpiresAt does for the expiry: `+<expiry>`, `0<expiry>`, upper-case hex, or
 * a part encoded another way (`ray%2D1` for `ray-1`) is no mark.
 */
function readMarkParts(text: string | undefined): MarkParts | undefined {
  try {
    const match = MARK_PARTS.exec(text ?? "");
    if (match === null) {
      return undefined;
    }
    const expiresAt = utils.parseExpiresAt(match[1]);
    if (expiresAt === undefined) {
      return undefined;
    }
    const [, , signature, encodedRayId, pageTag, encodedReferer] = match;
    const rayId = decodeURIComponent(encodedRayId);
    const referer = decodeURIComponent(encodedReferer);
    if (encodeURIComponent(rayId) !== encodedRayId || encodeURIComponent(referer) !== encodedReferer) {
      return undefined;
    }
    return { expiresAt, signature, rayId, pageTag, referer };
  } catch {
    return undefined;
  }
}

/**
 * Whether the request's own Referer is missing (`null` or `""`), or is the page itself: a URL with the same host (after
 * RTIStatelessUtils.normalizeHost), the same path and the same query as the request. The design says that Chrome sends
 * the page's own URL as the Referer of a script's reload (tested on 2026-11-17). A Referer that is not a URL is not the
 * page itself.
 */
function isMissingOrThisPage(referer: string | null, url: URL): boolean {
  if (!referer) {
    return true;
  }
  try {
    const own = new URL(referer);
    return RTIStatelessUtils.normalizeHost(own.host) === RTIStatelessUtils.normalizeHost(url.host)
      && own.pathname === url.pathname
      && own.search === url.search;
  } catch {
    return false;
  }
}

/**
 * Compares two signatures in constant time for equal lengths: every character is compared, wherever they first differ.
 * Two lengths that differ never match, so a short HMAC value cannot match the first characters of a signature.
 */
function sameSignature(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return difference === 0;
}
