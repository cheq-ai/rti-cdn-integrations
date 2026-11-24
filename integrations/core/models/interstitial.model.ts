// cspell:ignore CHEQ
import { Action } from "./action.model";

/** Which client a mark of the interstitial belongs to. The same shape and default as the CAPTCHA's `sessionBinding`. */
export interface ClientBinding {
  /**
   * `"exact"`: the mark is valid only from the same client IP address (on Cloudflare `CF-Connecting-IP`). `"none"`:
   * from any IP address.
   */
  ip: "exact" | "none";
  /** `true`: the mark is valid only with the same User-Agent. `false`: with any User-Agent. */
  userAgent: boolean;
}

/**
 * `config.interstitial`, as the customer writes it. A GET page load that RTI wants challenged first gets a short CHEQ
 * page: it runs the customer's CHEQ tag and reloads, and RTI then decides a second time with the tag's data.
 * Only a GET page load can get it, and `challengingStrategy` is not used for such a request. Every other request (a
 * POST, a HEAD, a script's fetch) gets the answer it gets with the interstitial off, `challengingStrategy` included.
 * While the interstitial is on, a wrong value of another setting gets a warning and its default. A wrong `enabled` or
 * `tag` switches it off.
 */
export interface InterstitialSettings {
  /**
   * Turns the interstitial on or off.
   * - `true`: on, as soon as {@link tag} holds a tag line that can be read. In BLOCKING mode a GET page load that RTI
   *   wants challenged can then get the page; in MONITORING mode the Worker only logs a `would-show` line.
   * - `false`: off ("Standard mode"). A suspicious page load gets what it got before the interstitial existed (by
   *   default the CAPTCHA of `challenge`).
   * - Any other value, or a block without `enabled`: off, with a warning. Only the boolean `true` switches it on.
   * Every setting in full: the Cloudflare README, "Interstitial", "Settings".
   */
  enabled: boolean;
  /**
   * The customer's CHEQ tag line, pasted as one string from the tag snippet in the CHEQ console: the whole
   * `<script …></script>` element, in single quotes. The Worker reads its attributes once, leaves out `async`, `defer`
   * and every `on…` attribute, and the page's script builds the tag from the rest; the line is never written into the
   * page as text.
   * - Not set (`"REPLACE_ME"`, empty): off, with a warning. A line that cannot be read: off, with a warning that says
   *   why.
   * - The hash in its `src` (`/i/<hash>.js`) must be `tagHash`, otherwise a warning (the interstitial stays on).
   * - The tag needs its option `ck4`: the page waits for the tag's `_cq_pvid` cookie, which the tag writes only with
   *   `ck4` (read in adserver on 2026-11-17).
   */
  tag?: string;
  /**
   * What a suspicious GET page load gets when RTI has found the tag's session (`sessionFound: true`): on the reload
   * after the interstitial, and on a later page of a visitor whose tag ran on an earlier page (no interstitial then).
   * - `Action.ALLOW` (default): forwarded to the origin with `x-cheq-rti-result`.
   * - `Action.BLOCK`: what `blockingStrategy` gives (by default the block page).
   * - `Action.REDIRECT`: a 302 to `redirectLocation`.
   * - `Action.CHALLENGE`: the CAPTCHA of `challenge`, whatever `challengingStrategy` says. A valid CAPTCHA pass skips
   *   it; without a `challenge` the request is forwarded with the verdict.
   * A benign or malicious verdict is not affected. A wrong value: a warning, and `Action.ALLOW`.
   */
  onSecondVerdict?: Action;
  /**
   * What a suspicious GET page load gets when RTI has no tag session (`sessionFound` false or missing) and the request
   * carries a valid mark: the reload of a visitor whose tag was blocked, failed or came too late. It replaces a second
   * interstitial for that visitor (the product spec's loop guard, FR-6). The mark counts on every page of the site for
   * its 60 seconds.
   * - The same four values as {@link onSecondVerdict}, with the same results. Default `Action.ALLOW` ("open", FR-6).
   * - `ALLOW` lets a client that blocks the tag pass after one extra request; `BLOCK` or `CHALLENGE` also stops real
   *   visitors whose ad blocker blocks the tag.
   * A wrong value: a warning, and `Action.ALLOW`.
   */
  onSessionNotFound?: Action;
  /**
   * The longest time the page waits for the tag, in milliseconds: a whole number from 1000 to 30000, default 5000.
   * The page reloads sooner when the tag writes a new `_cq_pvid` (checked every 50 ms), or when the tag's script fails
   * to load. Too short: the reload can come before the tag's data reached RTI, and {@link onSessionNotFound} decides.
   * The Worker accepts the page's mark until `maxWaitMs` plus 70 seconds after the page was served.
   * A wrong value: a warning, and 5000.
   */
  maxWaitMs?: number;
  /**
   * The HTTP status the interstitial page is sent with: 200, or a whole number from 400 to 599. Default 403.
   * The visitor sees the same page either way; the status tells crawlers, monitors and log tools whether the answer is
   * the page's content (403: it is not). The page is also no-store and noindex. The product spec leaves the status to
   * an SEO review. A prefetch never gets the page (it gets an empty 403). A wrong value: a warning, and 403.
   */
  statusCode?: number;
  /**
   * How the origin learns where the visitor came from, after the interstitial (the reload's own Referer is the page
   * itself). The same setting as the CAPTCHA's `originalRefererVia`; use the same value in both.
   * - `"header"` (default): the reload reaches the origin, and RTI, with `x-cheq-original-referer`.
   * - `"cookie"`: the page's script writes a `_cq_ref` cookie (60 seconds, the CAPTCHA's format), when there is an
   *   original Referer; neither the origin nor RTI gets `x-cheq-original-referer`.
   * A wrong value: a warning, and `"header"`.
   */
  originalRefererVia?: "header" | "cookie";
  /**
   * Which client a mark belongs to, as the CAPTCHA's `sessionBinding`. Default `{ ip: "exact", userAgent: true }`.
   * A request from another IP address or with another User-Agent has no valid mark: if RTI still wants it challenged,
   * the page comes again and stops with "We could not check your browser." and a Try again button (no loop).
   * `ip: "none"` spares visitors whose IP changes (a VPN, iCloud Private Relay); a copied mark is then accepted from
   * any IP for its 60 seconds. Give both fields: a wrong value gets a warning and the default.
   */
  binding?: ClientBinding;
  /**
   * The logo on the page: the https:// address of an image the customer hosts, at most 200 characters (also as the URL
   * parser writes it). Default: CHEQ's logo, inline in the page. A wrong value: a warning, and CHEQ's logo.
   */
  logoUrl?: string;
  /** The page's heading and `<title>`, 1 to 60 characters. Default "Checking your browser". Escaped for HTML. */
  headline?: string;
  /**
   * The text under the heading, 1 to 160 characters, in a live region that screen readers announce. Default "This
   * usually takes about a second." Escaped for HTML.
   */
  message?: string;
  /**
   * The page's language (`<html lang>`): a tag such as "en" or "en-US", at most 35 characters. Default "en". The
   * page's fixed texts ("We could not check your browser.", Try again, the cookie and JavaScript texts, Ray ID, the
   * footer) stay in English.
   */
  lang?: string;
  /**
   * Send one info line per interstitial decision to the RTI logger: `shown`, `would-show` (MONITORING), and on the
   * reload `passed`, `blocked`, `redirected`, `second-verdict:<ACTION>` or `no-session:<ACTION>`, each with the ray
   * ids, the verdict, the reasons and the request id. They feed the count of what the interstitial does (FR-6).
   * Default `true`. `false`: no such line to the logger; with `debug` they still go to the console.
   */
  logOutcomes?: boolean;
}

/** {@link InterstitialSettings} once InterstitialService has checked them: every value set. */
export interface ResolvedInterstitialSettings {
  /**
   * The tag line's attributes as [name, value] pairs, in the line's order, without `async`, `defer` and `on…`. The
   * names are in lower case, and the values are read (`&amp;` is `&`). The page's script sets them on the `<script>`
   * element it builds.
   */
  tagAttributes: [string, string][];
  onSecondVerdict: Action;
  onSessionNotFound: Action;
  maxWaitMs: number;
  statusCode: number;
  originalRefererVia: "header" | "cookie";
  binding: ClientBinding;
  /** `undefined`: CHEQ's inline logo. */
  logoUrl?: string;
  headline: string;
  message: string;
  lang: string;
  logOutcomes: boolean;
}

/** The plain facts about one request that InterstitialService.decide needs. The CDN glue works them out. */
export interface InterstitialFacts {
  /** The request is a page load (RTIStatelessUtils.isPageLoad). */
  pageLoad: boolean;
  /** RTI's `metadata.sessionFound`: whether RTI found the tag's session. `null` when RTI does not say. */
  sessionFound: boolean | null;
  /** The request has a valid mark (`_cq_it`), which the page's script writes before the reload. */
  validMark: boolean;
}

/**
 * The answer of InterstitialService.decide:
 * - `forward`: the request goes to the origin with the verdict.
 * - `show`: the interstitial page is the answer.
 * - `act`: carry out `action`, the value of the setting onSecondVerdict or onSessionNotFound.
 */
export type InterstitialOutcome =
  | { kind: "forward"; reason: "not-a-page-load" }
  | { kind: "show" }
  | { kind: "act"; action: Action; reason: "second-verdict" | "no-session" };

/**
 * HMAC-SHA256 of `message` with `key`, as its first 32 hex characters. The CDN glue passes it in, so that core uses no
 * `crypto`.
 */
export type HmacHex32 = (key: string, message: string) => Promise<string>;

/**
 * The plain facts of one request that InterstitialService.readMark and InterstitialService.page need. The CDN glue
 * reads them.
 */
export interface InterstitialRequest {
  /** The request's absolute URL. */
  url: string;
  /** The Cookie header, `""` without one. */
  cookie: string;
  /** The request's own Referer header, `null` without one. */
  referer: string | null;
  /** The glue's sessionBindingKey for `settings.binding`: the client's IP and User-Agent as one text. */
  bindingKey: string;
  /** The request is a page load (RTIStatelessUtils.isPageLoad). */
  pageLoad: boolean;
}

/**
 * A mark (`_cq_it`) that InterstitialService.readMark found valid: InterstitialService.page made it for a client with
 * the same binding key, and it has not expired.
 */
export interface ValidMark {
  /** The ray id of RTI call 1, the call that got the interstitial. */
  firstRayId: string;
  /** The mark was made for the path of this request. Whether a mark is valid does not depend on the path. */
  forThisPage: boolean;
  /**
   * The original Referer of the request that got the interstitial. Only on a page load of the mark's own path whose own
   * Referer is missing or is the page itself (the same host, path and query). Left out when the mark has none.
   */
  referer?: string;
}

/** The interstitial page as a plain answer. The CDN glue turns it into its own answer type. */
export interface InterstitialAnswer {
  /** The setting statusCode. */
  status: number;
  /** `Content-Type`, `Cache-Control` and `X-Robots-Tag`. */
  headers: Record<string, string>;
  /** The page's HTML. */
  body: string;
}
