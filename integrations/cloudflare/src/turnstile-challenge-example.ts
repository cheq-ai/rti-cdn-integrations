// cspell:ignore cheq siteverify duid unkeyed gclid
import { RTIResponse } from "../../core/models/rti-response.model";
import { RTIStatelessUtils } from "../../core/services/rti-stateless-utils";
import type { CloudflareConfig } from "./config";
import { ResponseHeaders } from "./response-headers";

// Defined in core, so the debug logs mask the same parameter.
const TURNSTILE_RESPONSE_QUERY_PARAM = RTIStatelessUtils.TURNSTILE_RESPONSE_QUERY_PARAM;

// The challenge page and our redirects are never cached.
const responseHeaders = new ResponseHeaders();

// For the instance helpers (e.g. originalReferer, errorMessage). The class holds no state, so one instance serves all.
const statelessUtils = new RTIStatelessUtils();

/**
 * The Turnstile action of the CHEQ challenge widget: set as `data-action` on the challenge page and required in the
 * siteverify result, so a token solved on another widget (another site, or the site's own login form) is rejected.
 */
const CHALLENGE_ACTION = "cheq-challenge";

// Cloudflare's Turnstile tokens are at most 2048 characters. A longer one is junk: it is not sent to siteverify.
const MAX_TOKEN_LENGTH = 2048;

// Shown on the retry page. A token that did not pass is the visitor's to fix; a Cloudflare error is not.
const VERIFICATION_FAILED_MESSAGE = "Verification failed. Please try again.";
const VERIFICATION_UNAVAILABLE_MESSAGE = "We couldn't verify you right now. Please try again.";

// How long _cq_rf and _cq_ref live after a solved CAPTCHA: only long enough for the landing page.
const ORIGINAL_REFERER_COOKIE_MAX_AGE_SECONDS = 60;


/** Settings for the example Turnstile challenge, set in config.ts. */
export interface TurnstileSettings {
    /** Site key from the Cloudflare Turnstile dashboard. */
    siteKey: string;
    /** Secret key from the Turnstile dashboard, sent to Cloudflare's siteverify endpoint. */
    secretKey: string;
    /**
     * Signs the `_cq_se` session cookie so it cannot be forged. NOT the Turnstile secret: any long random
     * string, e.g. `openssl rand -hex 32`. Changing it invalidates every session (visitors are challenged again).
     */
    sessionSigningSecret: string;
    /** How long a solved challenge is remembered, in seconds. */
    sessionTtlSeconds: number;
    /**
     * What the `_cq_se` session is bound to, so a copied cookie does not work from another client. Optional: the
     * default is `{ ip: "exact", userAgent: true }`. A session that no longer matches only means a new CAPTCHA.
     */
    sessionBinding?: SessionBinding;
    /**
     * siteverify errors in a row (timeout, network, 5xx) before the CAPTCHA is paused. A 4xx doesn't count. Default 3.
     * Any other error while answering a solved CAPTCHA (e.g. signing the session) counts too.
     * Counted per Worker isolate, not for the whole site (see SiteverifyPause).
     * 0 turns the pause off: during a Cloudflare outage visitors get the CAPTCHA again, but it is never skipped.
     */
    siteverifyErrorsToPause?: number;
    /** How long the CAPTCHA is paused, in seconds. During the pause challenged traffic is forwarded with x-cheq-rti-result. Default 60. */
    siteverifyPauseSeconds?: number;
    /**
     * The site's hostnames, e.g. `["example.com"]`. A solved token is accepted only if Cloudflare says it was solved on
     * one of them or on a subdomain of one (`example.com` also covers `www.example.com` and `shop.eu.example.com`, not
     * `evilexample.com`). Optional: without it, the token must have been solved on the request's own host (the host of
     * its URL). Set it when the site has several domains. Case and a `:port` are ignored.
     */
    allowedHostnames?: string[];
    /**
     * How the original Referer (where the visitor came from before the CAPTCHA) reaches the site after a solve.
     * - `"header"` (default): the origin and RTI get it in the `x-cheq-original-referer` request header. It is carried
     *   from the 302 to the landing page in `_cq_rf`, a signed HttpOnly cookie, so page scripts can't read or plant it.
     * - `"cookie"`: the site's own scripts read it from `_cq_ref` (not HttpOnly). The Worker never reads it back.
     */
    originalRefererVia?: "header" | "cookie";
}

/** See {@link sessionBindingKey}. */
export interface SessionBinding {
    /** `"exact"`: the client's address. `"none"`: not bound to the IP. */
    ip: "exact" | "none";
    /** Bind to the exact User-Agent. */
    userAgent: boolean;
}

/** The settings once createTurnstileChallenge has checked them: every optional setting has its value. */
type ResolvedTurnstileSettings = TurnstileSettings & {
    sessionBinding: SessionBinding;
    siteverifyErrorsToPause: number;
    siteverifyPauseSeconds: number;
    /** Normalized (lower case, no port). Empty: check against the request's own host (the host of its URL). */
    allowedHostnames: string[];
    originalRefererVia: "header" | "cookie";
};

const ORIGINAL_REFERER_MODES: readonly string[] = ["header", "cookie"];

const DEFAULT_SESSION_BINDING: SessionBinding = { ip: "exact", userAgent: true };

const SESSION_BINDING_IP_MODES: readonly string[] = ["exact", "none"];

const isSessionBinding = (value: unknown): value is SessionBinding =>
    typeof value === "object" && value !== null
    && SESSION_BINDING_IP_MODES.includes((value as SessionBinding).ip)
    && typeof (value as SessionBinding).userAgent === "boolean";

const isPlaceholder = (value: string | undefined): boolean => !value || value.trim() === "" || value.trim() === "REPLACE_ME";

const DEFAULT_SESSION_TTL_SECONDS = 300;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// RTI already took part of the time the visitor waits for this answer.
const SITEVERIFY_TIMEOUT_MS = 1500;
const DEFAULT_SITEVERIFY_ERRORS_TO_PAUSE = 3;
const DEFAULT_SITEVERIFY_PAUSE_SECONDS = 60;

/**
 * Pauses the CAPTCHA when siteverify keeps failing, so visitors don't loop on a check that can't pass. Any other error
 * while answering a solved CAPTCHA counts too (see turnstileChallengeExample): it can't pass either.
 * After the pause it needs the same number of errors to pause again, but only when no reply overlaps (see below).
 *
 * The count lives in memory, so it is per isolate: Cloudflare runs many isolates of the Worker (in its data centers
 * around the world, often several in one), and each pauses on its own errors. An isolate keeps its count and pause
 * between requests.
 *
 * One isolate serves several requests at the same time, so replies overlap (a Lambda instance serves one at a time).
 * A reply checks the pause before it calls siteverify, so one that was already at siteverify when the pause started
 * still records its result when it comes back, during the pause or after it:
 * - A success ends the running pause and resets the count (see recordSuccess): siteverify answered, so it works.
 * - An error counts from 0 again (starting the pause reset the count), and that count is still there after the pause:
 *   errors that came back during the pause mean fewer new errors pause the CAPTCHA again after it. At the limit an
 *   error starts the pause again, for the full siteverifyPauseSeconds from then, and logs again.
 *
 * Cloudflare can drop an isolate at any moment (for example after a deploy, or to free resources): a new one starts at
 * 0 errors, not paused, and the old count and pause are gone with it. In a real outage every busy isolate reaches the
 * limit within seconds, but until then a visitor may get the CAPTCHA from one isolate and pass through another. That is
 * the usual trade-off for an in-memory breaker; sharing the count would need a store (e.g. a Durable Object) that is
 * read on every challenged request.
 * If Turnstile itself fails while the Worker runs (challenges.cloudflare.com does not answer, or the widget cannot load
 * or produce a token), no reply is sent and siteverify is never called, so this pause never starts: visitors with a
 * CAPTCHA verdict stay on a CAPTCHA they can't solve until Turnstile is back, as with any CAPTCHA vendor outage.
 */
export class SiteverifyPause {
    private errorsInRow = 0;
    private pausedUntilTimestamp = 0;

    constructor(private readonly errorsToPause: number, private readonly pauseSeconds: number) {}

    isPaused(): boolean {
        return Date.now() < this.pausedUntilTimestamp;
    }

    recordSuccess(): void {
        this.errorsInRow = 0;
        // Not only for clarity: in a Worker this can end a running pause. A reply that was already at siteverify when the
        // pause started can come back during it, and an answer from siteverify means siteverify works again.
        this.pausedUntilTimestamp = 0;
    }

    recordError(): void {
        this.errorsInRow++;
        // 0 = pause turned off: never skip the CAPTCHA.
        if (this.errorsToPause === 0) {
            return;
        }
        if (this.errorsInRow >= this.errorsToPause) {
            this.errorsInRow = 0;
            this.pausedUntilTimestamp = Date.now() + this.pauseSeconds * 1000;
            console.error(`[turnstile] siteverify (or answering the reply) failed ${this.errorsToPause} times in a row: CAPTCHA paused for ${this.pauseSeconds}s`);
        }
    }
}

/** siteverify answered 4xx: it refused this call (bad request, rate limit). Cloudflare is up, so it is no outage. */
class SiteverifyRefusedError extends Error {}

// A whole number from `min` up, else the default (with a warning).
function integerSetting(name: string, value: number | undefined, min: number, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    if (Number.isInteger(value) && value >= min) {
        return value;
    }
    console.warn(`[turnstile] invalid ${name} ${JSON.stringify(value)}, using ${fallback} (set a whole number of at least ${min} in config.ts)`);
    return fallback;
}

/**
 * The longest session: 400 days, the most browsers keep a cookie (RFC 6265bis caps Max-Age there; Chrome enforces it),
 * so a longer TTL could not last longer anyway. It also keeps the expiry far below Number.MAX_SAFE_INTEGER: a TTL like
 * 1e13 s made `${expiresAt}` unreadable to validateChallenge, so every session was rejected and visitors looped.
 */
const MAX_SESSION_TTL_SECONDS = 400 * 24 * 60 * 60;

// Escapes a value for an HTML text node or a quoted attribute. Every value put into the challenge page goes
// through it: the path and the query come from the client, and a raw `"` in any value would otherwise close the
// attribute and let the rest of it inject markup or a script on the customer's site.
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// All cookies of the request: the Cookie header split on ";".
const requestCookies = (request: Request): string[] =>
    (request.headers.get("cookie") ?? "").split(";").map(c => c.trim()).filter(Boolean);

// The value of the cookie `name` (everything after the first "="), or undefined.
const cookieValue = (cookies: string[], name: string): string | undefined =>
    cookies.find(c => c.startsWith(`${name}=`))?.substring(name.length + 1);

const encoder = new TextEncoder();

/**
 * HMAC-SHA256 of `message`, keyed with `secret`, as its first 32 lower-case hex characters: the value CloudFront gets
 * from createHmac("sha256", secret).update(message).digest("hex").slice(0, 32). The key is imported for each call and
 * not kept: nothing but the pause counter lives in module state.
 */
async function hmacHex32(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
    return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Compares two signatures in constant time for equal lengths: every character is compared, wherever they first differ. */
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

/**
 * Signs a challenge session: HMAC-SHA256 over the expiry, the rayId and the client binding ({@link sessionBindingKey}),
 * keyed with `secret`, as 32 hex characters. Without the key nobody can produce a valid `_cq_se` cookie (the old unkeyed
 * SHA-256 could be computed by anyone), and a copied cookie fails from a client with another User-Agent or IP.
 * The binding is only in the HMAC input, never in the cookie: validation recomputes it from the request.
 * Deliberately NOT bound to the visitor's `_cq_duid` (tried and reverted): on a first visit the challenge is solved
 * before the CHEQ tag has set that cookie, so a bound session broke as soon as it appeared and the visitor had to solve
 * the CAPTCHA twice. The IP and User-Agent are there from the first request.
 */
async function signSession(secret: string, expiresAt: number, rayId: string, bindingKey: string): Promise<string> {
    return hmacHex32(secret, JSON.stringify(["se", expiresAt, rayId, bindingKey]));
}

/** Checks a session signature in constant time. The secret is never a placeholder: createTurnstileChallenge refuses one. */
async function isValidSessionSignature(secret: string, expiresAt: number, rayId: string, bindingKey: string, signature: string): Promise<boolean> {
    return sameSignature(await signSession(secret, expiresAt, rayId, bindingKey), signature);
}

/** The client's address as Cloudflare reports it, or null (e.g. in a local run). */
const clientIp = (request: Request): string | null => request.headers.get("cf-connecting-ip");

/**
 * What a session is bound to: the client's IP ({@link clientIp}, per `sessionBinding.ip`) and User-Agent
 * (`sessionBinding.userAgent`; several User-Agent headers arrive joined with ", "), as one unambiguous string for the HMAC
 * input (`JSON.stringify([ip, userAgent])`, "" for a part that is not bound). Without CF-Connecting-IP (a local run) the
 * IP part is null, so it never matches an IP or an unbound one. Recomputed from each request, never stored: the cookie
 * carries neither the IP nor the User-Agent.
 */
export function sessionBindingKey(settings: { sessionBinding: SessionBinding }, request: Request): string {
    const { ip, userAgent } = settings.sessionBinding;
    return JSON.stringify([sessionBindingIp(ip, clientIp(request)), userAgent ? request.headers.get("user-agent") ?? "" : ""]);
}

/**
 * The client IP as bound into the session. An IPv6 address in the URL parser's spelling (`2001:0DB8:0:0:0:0:0:1` →
 * `2001:db8::1`), so every spelling of an address is the same client; anything else as given. Three spellings differ
 * from CloudFront's. An IPv4-mapped or IPv4-compatible address is written in hex (`::ffff:102:304`, `::102:304`), and a
 * zone id is not removed (Cloudflare never sends one).
 */
function sessionBindingIp(mode: SessionBinding["ip"], ip: string | null): string | null {
    if (mode === "none") {
        return "";
    }
    // Only hex digits, ":" and "." can spell an IPv6 address. Nothing else is put into the URL that is parsed.
    if (ip && ip.includes(":") && /^[0-9a-f:.]+$/i.test(ip)) {
        try {
            return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
        } catch {
            // not an IPv6 address: bound as given
        }
    }
    return ip;
}

/**
 * Builds the example Turnstile callbacks from the settings in config.ts.
 * A factory, not an `import { config }`: config.ts imports this file, so that would be circular.
 *
 * Returns `{}` (and warns) while `siteKey`, `secretKey` or `sessionSigningSecret` is unset or `REPLACE_ME`:
 * the CAPTCHA is then disabled and challenged traffic is forwarded with `x-cheq-rti-result`, instead of
 * showing a broken widget or issuing sessions anyone could forge. Settings that cannot be read disable it too.
 * Never throws.
 */
export function createTurnstileChallenge(settings: TurnstileSettings): Pick<CloudflareConfig, "challenge" | "validateChallenge" | "isChallengeResponse" | "originalReferer"> {
    try {
        return buildTurnstileChallenge(settings);
    } catch (e) {
        // config.ts calls this while the module loads, where an exception would stop the Worker for every request.
        console.warn(`[turnstile] CAPTCHA disabled, the settings could not be read: ${statelessUtils.errorMessage(e)}`);
        return {};
    }
}

// The body of createTurnstileChallenge, which turns anything thrown here into a disabled CAPTCHA.
function buildTurnstileChallenge(settings: TurnstileSettings): Pick<CloudflareConfig, "challenge" | "validateChallenge" | "isChallengeResponse" | "originalReferer"> {
    const missing = (["siteKey", "secretKey", "sessionSigningSecret"] as const).filter(k => isPlaceholder(settings[k]));
    if (missing.length > 0) {
        console.warn(`[turnstile] CAPTCHA disabled, not configured: ${missing.join(", ")} (set them in config.ts)`);
        return {};
    }
    // A TTL of 0, a negative or fractional number, NaN or a string would issue sessions that are already expired
    // (every visitor challenged again and again) or a broken Max-Age, and one above MAX_SESSION_TTL_SECONDS sessions
    // that are never accepted. Fall back to the default instead.
    const ttlValid = Number.isInteger(settings.sessionTtlSeconds)
        && settings.sessionTtlSeconds > 0
        && settings.sessionTtlSeconds <= MAX_SESSION_TTL_SECONDS;
    if (!ttlValid) {
        console.warn(`[turnstile] invalid sessionTtlSeconds ${JSON.stringify(settings.sessionTtlSeconds)}, using ${DEFAULT_SESSION_TTL_SECONDS} (set a positive whole number of seconds, at most ${MAX_SESSION_TTL_SECONDS} (400 days), in config.ts)`);
    }
    // A sessionBinding with an unknown ip mode or a non-boolean userAgent would bind to something nobody chose.
    const bindingValid = settings.sessionBinding === undefined || isSessionBinding(settings.sessionBinding);
    if (!bindingValid) {
        console.warn(`[turnstile] invalid sessionBinding ${JSON.stringify(settings.sessionBinding)}, using ${JSON.stringify(DEFAULT_SESSION_BINDING)} (ip: "exact" or "none"; userAgent: true or false, in config.ts)`);
    }
    const binding = bindingValid && settings.sessionBinding ? settings.sessionBinding : DEFAULT_SESSION_BINDING;
    // A list with an entry that is not a string, or is empty once a scheme, port and path are removed (such as "" or
    // "https://"), is ignored as a whole: a partly used list would accept fewer hosts than the operator meant (a
    // CAPTCHA loop), and guessing could accept more. The request's own host is checked instead.
    const listed: unknown = settings.allowedHostnames;
    const allowedHostnames = Array.isArray(listed) ? listed.map(h => typeof h === "string" ? RTIStatelessUtils.normalizeHost(h) : "") : [];
    const hostnamesValid = listed === undefined || (Array.isArray(listed) && allowedHostnames.every(h => h !== ""));
    if (!hostnamesValid) {
        console.warn(`[turnstile] invalid allowedHostnames ${JSON.stringify(settings.allowedHostnames)}, checking against the request's Host instead (set a list of host names, e.g. ["www.example.com"], in config.ts)`);
    }
    const refererModeValid = settings.originalRefererVia === undefined || ORIGINAL_REFERER_MODES.includes(settings.originalRefererVia);
    if (!refererModeValid) {
        console.warn(`[turnstile] invalid originalRefererVia ${JSON.stringify(settings.originalRefererVia)}, using "header" ("header" or "cookie", in config.ts)`);
    }
    const resolved: ResolvedTurnstileSettings = {
        ...settings,
        sessionTtlSeconds: ttlValid ? settings.sessionTtlSeconds : DEFAULT_SESSION_TTL_SECONDS,
        sessionBinding: { ip: binding.ip, userAgent: binding.userAgent },
        siteverifyErrorsToPause: integerSetting("siteverifyErrorsToPause", settings.siteverifyErrorsToPause, 0, DEFAULT_SITEVERIFY_ERRORS_TO_PAUSE),
        siteverifyPauseSeconds: integerSetting("siteverifyPauseSeconds", settings.siteverifyPauseSeconds, 1, DEFAULT_SITEVERIFY_PAUSE_SECONDS),
        allowedHostnames: hostnamesValid ? allowedHostnames : [],
        originalRefererVia: refererModeValid && settings.originalRefererVia ? settings.originalRefererVia : "header",
    };
    // The only state kept from one request to the next: the error count and pause of this isolate.
    const pause = new SiteverifyPause(resolved.siteverifyErrorsToPause, resolved.siteverifyPauseSeconds);

    return {
        challenge: (request, response, addRtiResultHeader) => turnstileChallengeExample(resolved, pause, request, response, addRtiResultHeader),
        validateChallenge: async (request, isDebug) => {
            // siteverify is down: waive the CAPTCHA, the request goes on with its verdict header.
            if (pause.isPaused()) {
                if (isDebug) {
                    console.log("[validateChallenge] siteverify paused, waiving CAPTCHA");
                }
                return true;
            }
            return turnstileValidateChallengeExample(resolved, request, isDebug);
        },
        isChallengeResponse: turnstileIsChallengeResponseExample,
        originalReferer: resolved.originalRefererVia === "header" ? (request) => refererFromSignedCookie(resolved, request) : undefined,
    };
}

/**
 * True when the request is the reply to the challenge page: the solved form came back with a Turnstile token.
 * Only the field name is checked (`cf-turnstile-response`, added by the Turnstile widget to its form), so a
 * site's own GET form with a Turnstile widget looks like a reply too.
 */
const turnstileIsChallengeResponseExample = (request: Request): boolean =>
    !!new URL(request.url).searchParams.get(TURNSTILE_RESPONSE_QUERY_PARAM);

const turnstileChallengeExample = async (settings: ResolvedTurnstileSettings, pause: SiteverifyPause, request: Request, response: RTIResponse, addRtiResultHeader?: (headers: Headers) => void): Promise<Response> => {
    const url = new URL(request.url);
    // TURNSTILE_RESPONSE_QUERY_PARAM is not set by this code: once the visitor solves the challenge, the Turnstile
    // widget (api.js) injects a hidden input with this name into the enclosing <form>. The form submits via GET,
    // so the token arrives here as a query string parameter. It must still be verified server-side (siteverify below).
    const token = url.searchParams.get(TURNSTILE_RESPONSE_QUERY_PARAM);

    if (!token) {
        // A visitor on plain http gets the CAPTCHA page here too, and then solves it twice: the session cookie is
        // Secure, so the browser drops it from the http answer, and the https page they are sent to (see returnUrl)
        // asks once more. A later request over http is asked again, and the original Referer is lost on the way.
        // Left this way on purpose, to keep this code small: a site should answer on https only. The README ("A
        // visitor on plain http") says how to send http to https at Cloudflare, and has optional lines that make
        // it one solve. They go here, in place of this comment.

        // Not solved yet. The return URL keeps the query string (gclid, utm_*, ...): url.pathname is only the path.
        const originalUrl = url.pathname + url.search;
        // Where the visitor came from, carried by the form: after the CAPTCHA the browser only knows this page.
        // On plain http this value is lost. The cookie that carries it after the solve (_cq_rf or _cq_ref) is Secure,
        // so the browser drops it with the session cookie. On the second CAPTCHA page, on https, the browser reports
        // the site's own http address as the Referer, and that is what this line then takes. The origin and RTI end
        // up with `http://<host>/` as x-cheq-original-referer, not the page the visitor came from (README, "A
        // visitor on plain http").
        const originalReferer = statelessUtils.originalReferer(request.headers.get("referer"), url.host);
        return challengePage(settings, response, originalUrl, undefined, originalReferer);
    }
    // else : user already solved the challenge and submitted the form with the token. Verify it with Cloudflare's siteverify.

    // A reply is never answered by throwing: the handler in index.ts would forward it to the origin as it is (fail open),
    // with the token and the form fields in place of the visitor's own query string (gclid, utm_*, ...). An error
    // answering it (a bug or an unexpected input, e.g. while signing the session) is handled like a siteverify outage
    // instead, and counts toward the pause: an error on every reply then can't keep visitors on the CAPTCHA (unless
    // siteverifyErrorsToPause is 0).
    try {
        return await answerReply(settings, pause, request, response, url, token, addRtiResultHeader);
    } catch (e) {
        console.error(`[turnstile] error answering the challenge reply: ${statelessUtils.errorMessage(e)}`);
        return unavailableAnswer(settings, pause, response, url);
    }
};

/** Answers the reply to the challenge page: `token` is the solved CAPTCHA, sent to Cloudflare's siteverify. */
async function answerReply(settings: ResolvedTurnstileSettings, pause: SiteverifyPause, request: Request, response: RTIResponse, url: URL, token: string, addRtiResultHeader?: (headers: Headers) => void): Promise<Response> {
    // Too long to be a real token: show the widget again, without calling Cloudflare and without counting toward the pause.
    if (token.length > MAX_TOKEN_LENGTH) {
        return challengeRetryPage(settings, response, url, VERIFICATION_FAILED_MESSAGE);
    }

    // The CAPTCHA is paused (siteverify is down): back to the page, where it is waived.
    if (pause.isPaused()) {
        return challengeUnavailableFailOpen(url, url.searchParams);
    }

    let verified: boolean;
    try {
        verified = await verifyTurnstileToken(settings, token, request, url);
    } catch (e) {
        // A 4xx doesn't count toward the pause: a flood of junk tokens could get us rate limited (429), and that
        // must not let anyone switch the CAPTCHA off. It's a failed check: show the widget again.
        if (e instanceof SiteverifyRefusedError) {
            console.warn(`[turnstile] ${e.message}`);
            return challengeRetryPage(settings, response, url, VERIFICATION_FAILED_MESSAGE);
        }
        // Timeout, network error, 5xx or a bad answer: not the visitor's fault. Never forward the token to the origin.
        console.error(`[turnstile] siteverify error: ${statelessUtils.errorMessage(e)}`);
        return unavailableAnswer(settings, pause, response, url);
    }

    // Verified: back to the page with a session. Wrong, reused or expired token: the widget again instead of a dead end.
    // challengePassed is awaited: signing the session is a promise, and one that rejects must reach the catch of
    // turnstileChallengeExample as an error before the success below is recorded.
    const answer = verified
        ? await challengePassed(settings, request, response, url, addRtiResultHeader)
        : challengeRetryPage(settings, response, url, VERIFICATION_FAILED_MESSAGE);
    // Reset only once the answer is built: an error building it (e.g. signing the session) counts toward the pause in
    // turnstileChallengeExample's catch. Reset before, it would be undone by every such reply, and a step that always
    // fails would show the CAPTCHA again forever instead of pausing it.
    pause.recordSuccess();
    return answer;
}

/**
 * Counts a reply that could not be checked (siteverify down, or an error answering it) as one error toward the
 * pause, then answers it. Not the visitor's fault, and never the token to the origin:
 * - not paused (below the limit, or fail closed with 0): the widget again, with "We couldn't verify you right now",
 *   and `original_url` kept for the next try
 * - this error started the pause, or it already runs (fail open): a 302 to `original_url`, without a session, where
 *   the CAPTCHA is waived while the pause lasts
 * If even the retry page throws, the 302 is sent anyway: that request has no token, and RTI checks it as usual.
 */
function unavailableAnswer(settings: ResolvedTurnstileSettings, pause: SiteverifyPause, response: RTIResponse, url: URL): Response {
    pause.recordError();

    if (!pause.isPaused()) {
        try {
            return challengeRetryPage(settings, response, url, VERIFICATION_UNAVAILABLE_MESSAGE);
        } catch (e) {
            console.error(`[turnstile] error building the retry page, redirecting to original_url instead: ${statelessUtils.errorMessage(e)}`);
        }
    }

    return challengeUnavailableFailOpen(url, url.searchParams);
}

/**
 * The challenge page again, with `errorMessage`, after a token that did not pass, or a siteverify error or an error
 * answering the reply that did not pause the CAPTCHA. Solving it returns to the same page.
 */
function challengeRetryPage(settings: ResolvedTurnstileSettings, response: RTIResponse, url: URL, errorMessage: string): Response {
    return challengePage(settings, response, returnPath(url, url.searchParams), errorMessage, carriedReferer(url, url.searchParams));
}

/**
 * The original_referer the challenge page carried, checked again: the client controls the query string. This site's
 * host comes from the request's URL, as when the challenge page took the Referer (see turnstileChallengeExample).
 */
function carriedReferer(url: URL, queryStringData: URLSearchParams): string | undefined {
    return statelessUtils.originalReferer(queryStringData.get("original_referer"), url.host);
}

/**
 * The 403 page with the Turnstile widget. `originalUrl` is where the visitor goes once solved. `originalReferer` is where
 * they came from (see RTIStatelessUtils.originalReferer); it goes back in the _cq_rf or _cq_ref cookie once the CAPTCHA
 * is solved (see challengePassed).
 */
function challengePage(settings: ResolvedTurnstileSettings, response: RTIResponse, originalUrl: string, errorMessage?: string, originalReferer?: string): Response {
    const html = `<!DOCTYPE html>
                    <html lang="en">
                    <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Security Verification | CHEQ</title>
                    <link rel="preconnect" href="https://challenges.cloudflare.com">
                    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
                    <style>
                        * { margin: 0; padding: 0; box-sizing: border-box; }
                        
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                            background: #070F18;
                            min-height: 100vh;
                            display: flex;
                            flex-direction: column;
                            align-items: center;
                            justify-content: center;
                            color: #E2E8F0;
                            padding: 20px;
                        }
                        
                        .bg-pattern {
                            position: fixed;
                            top: 0;
                            left: 0;
                            right: 0;
                            bottom: 0;
                            background-image: 
                            radial-gradient(circle at 20% 50%, rgba(0, 212, 170, 0.08) 0%, transparent 50%),
                            radial-gradient(circle at 80% 20%, rgba(124, 58, 237, 0.08) 0%, transparent 50%),
                            radial-gradient(circle at 40% 80%, rgba(0, 212, 170, 0.05) 0%, transparent 40%);
                            pointer-events: none;
                            z-index: 0;
                        }
                        
                        .container {
                            position: relative;
                            z-index: 1;
                            text-align: center;
                            max-width: 480px;
                            width: 100%;
                        }
                        
                        .card {
                            background: linear-gradient(135deg, #0D1B2A 0%, rgba(13, 27, 42, 0.9) 100%);
                            border: 1px solid rgba(0, 212, 170, 0.2);
                            border-radius: 16px;
                            padding: 48px 40px;
                            box-shadow: 
                            0 4px 6px rgba(0, 0, 0, 0.3),
                            0 10px 40px rgba(0, 0, 0, 0.4),
                            inset 0 1px 0 rgba(255, 255, 255, 0.05);
                        }
                        
                        .logo {
                            margin-bottom: 32px;
                        }
                        
                        .icon {
                            margin-bottom: 24px;
                        }
                        
                        h1 {
                            font-size: 1.75rem;
                            font-weight: 700;
                            margin-bottom: 12px;
                            background: linear-gradient(135deg, #E2E8F0 0%, #94A3B8 100%);
                            -webkit-background-clip: text;
                            -webkit-text-fill-color: transparent;
                            background-clip: text;
                        }
                        
                        .subtitle {
                            color: #94A3B8;
                            font-size: 1rem;
                            line-height: 1.6;
                            margin-bottom: 32px;
                        }
                        
                        .ref-box {
                            background: rgba(0, 0, 0, 0.3);
                            border: 1px solid rgba(255, 255, 255, 0.1);
                            border-radius: 8px;
                            padding: 12px 16px;
                            margin-top: 24px;
                        }
                        
                        .ref-label {
                            font-size: 0.75rem;
                            color: #94A3B8;
                            text-transform: uppercase;
                            letter-spacing: 0.05em;
                            margin-bottom: 4px;
                        }
                        
                        .ref-id {
                            font-family: 'SF Mono', Monaco, 'Courier New', monospace;
                            font-size: 0.8rem;
                            color: #00D4AA;
                            word-break: break-all;
                        }
                        
                        .footer {
                            margin-top: 24px;
                            font-size: 0.75rem;
                            color: #94A3B8;
                        }
                        
                        .footer a {
                            color: #00D4AA;
                            text-decoration: none;
                        }
                        
                        .footer a:hover {
                            text-decoration: underline;
                        }
                        
                        .status-badge {
                            display: inline-flex;
                            align-items: center;
                            gap: 6px;
                            background: rgba(239, 68, 68, 0.15);
                            border: 1px solid rgba(239, 68, 68, 0.3);
                            color: #FCA5A5;
                            padding: 6px 12px;
                            border-radius: 20px;
                            font-size: 0.8rem;
                            font-weight: 500;
                            margin-bottom: 20px;
                        }
                        
                        .status-dot {
                            width: 8px;
                            height: 8px;
                            background: #EF4444;
                            border-radius: 50%;
                            animation: pulse 2s infinite;
                        }
                        
                        @keyframes pulse {
                            0%, 100% { opacity: 1; }
                            50% { opacity: 0.5; }
                        }
                        
                        .captcha-box {
                        background: rgba(0, 0, 0, 0.2);
                        border-radius: 12px;
                        padding: 24px;
                        margin-bottom: 24px;
                        }
                        
                        .cf-turnstile {
                        display: flex;
                        justify-content: center;
                        }
                        
                        .btn {
                        width: 100%;
                        padding: 14px 24px;
                        font-size: 1rem;
                        font-weight: 600;
                        color: #0D1B2A;
                        background: linear-gradient(135deg, #00D4AA 0%, #00B894 100%);
                        border: none;
                        border-radius: 8px;
                        cursor: pointer;
                        transition: all 0.2s;
                        box-shadow: 0 4px 12px rgba(0, 212, 170, 0.3);
                        }
                        
                        .btn:hover:not(:disabled) {
                        transform: translateY(-2px);
                        box-shadow: 0 6px 20px rgba(0, 212, 170, 0.4);
                        }
                        
                        .btn:disabled {
                        opacity: 0.5;
                        cursor: not-allowed;
                        transform: none;
                        }
                        
                        .loading {
                        display: none;
                        margin-top: 16px;
                        color: #94A3B8;
                        font-size: 0.9rem;
                        }
                        
                        .loading.show {
                        display: block;
                        }

                        .error-box {
                        background: rgba(239, 68, 68, 0.15);
                        border: 1px solid rgba(239, 68, 68, 0.3);
                        color: #FCA5A5;
                        border-radius: 8px;
                        padding: 10px 14px;
                        margin-bottom: 20px;
                        font-size: 0.9rem;
                        }
                    </style>
                    </head>
                    <body>
                    <div class="bg-pattern"></div>
                    
                    <div class="container">
                        <div class="card">
                        <div class="logo"><svg width="120" height="40" viewBox="0 0 120 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M20 8C12.268 8 6 14.268 6 22s6.268 14 14 14 14-6.268 14-14S27.732 8 20 8zm0 24c-5.523 0-10-4.477-10-10s4.477-10 10-10 10 4.477 10 10-4.477 10-10 10z" fill="#00D4AA"/>
                        <path d="M20 14c-4.418 0-8 3.582-8 8s3.582 8 8 8 8-3.582 8-8-3.582-8-8-8zm3.707 6.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-2-2a1 1 0 111.414-1.414L19 23.586l3.293-3.293a1 1 0 011.414 0z" fill="#00D4AA"/>
                        <text x="42" y="28" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700" fill="#00D4AA">CHEQ</text>
                        </svg></div>
                        <div class="icon"><svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M40 6L12 18v18c0 16.6 11.94 32.12 28 36 16.06-3.88 28-19.4 28-36V18L40 6z" fill="url(#shield-gradient)" opacity="0.2"/>
                        <path d="M40 10L16 20v14c0 14.14 10.18 27.38 24 30.72 13.82-3.34 24-16.58 24-30.72V20L40 10z" stroke="url(#shield-gradient)" stroke-width="3" fill="none"/>
                        <path d="M36 40l-6-6 3-3 3 3 9-9 3 3-12 12z" fill="#00D4AA"/>
                        <defs>
                            <linearGradient id="shield-gradient" x1="40" y1="6" x2="40" y2="72" gradientUnits="userSpaceOnUse">
                            <stop stop-color="#00D4AA"/>
                            <stop offset="1" stop-color="#7C3AED"/>
                            </linearGradient>
                        </defs>
                        </svg></div>
                        <h1>Security Verification</h1>
                        <p class="subtitle">
                            Please complete the verification below to confirm you're human and continue to the website.
                        </p>
                        ${errorMessage ? `<div class="error-box" role="alert">${escapeHtml(errorMessage)}</div>` : ""}
                        <form id="captcha-form" method="GET">${/* No action: the form goes back to this page's own URL, exactly as the browser requested it. An action built from the request path would send a path like "//evil.com/" (with the token) to another site. */ ""}
                            <input type="hidden" name="original_url" value="${escapeHtml(originalUrl)}">
                            <input type="hidden" name="request_id" value="${escapeHtml(response.ids.rayId)}">
                            ${originalReferer ? `<input type="hidden" name="original_referer" value="${escapeHtml(originalReferer)}">` : ""}
                            
                            <div class="captcha-box">
                            <div class="cf-turnstile" 
                                data-sitekey="${escapeHtml(settings.siteKey)}"
                                data-action="${CHALLENGE_ACTION}"${/* REQUIRED: verifyTurnstileToken rejects tokens without this action. Removing it locks every visitor in a CAPTCHA loop. */ ""}
                                data-callback="onTurnstileSuccess"
                                data-error-callback="onTurnstileReset"
                                data-expired-callback="onTurnstileReset"
                                data-timeout-callback="onTurnstileReset"
                                data-retry-interval="2000"
                                data-theme="dark">
                            </div>
                            </div>
                            
                            <button type="submit" id="submit-btn" class="btn" disabled>
                            Continue to Website
                            </button>
                            
                            <div id="loading" class="loading">
                            Verifying...
                            </div>
                        </form>
                        
                        <div class="ref-box">
                            <div class="ref-label">Session ID</div>
                            <div class="ref-id">${escapeHtml(response.ids.rayId)}</div>
                        </div>
                        </div>
                        
                        <div class="footer">
                        Protected by <a href="https://cheq.ai" target="_blank" rel="noopener">CHEQ</a> Security
                        </div>
                    </div>

                    <script>
                        function onTurnstileSuccess(token) {
                        document.getElementById('submit-btn').disabled = false;
                        document.getElementById('loading').classList.remove('show');
                        }

                        // Widget failed, expired or timed out: no valid token, so no submit and no spinner.
                        function onTurnstileReset() {
                        document.getElementById('submit-btn').disabled = true;
                        document.getElementById('loading').classList.remove('show');
                        }
                        
                        document.getElementById('captcha-form').addEventListener('submit', function() {
                        // The #fragment never reaches the server, so only the browser can add it to the return URL.
                        var originalUrl = this.elements['original_url'];
                        if (location.hash && originalUrl.value.indexOf('#') === -1) originalUrl.value += location.hash;
                        document.getElementById('submit-btn').disabled = true;
                        document.getElementById('loading').classList.add('show');
                        });

                        // Back/forward restores the page as it was left, spinner included: reset it and get a new token.
                        window.addEventListener('pageshow', function(event) {
                        if (!event.persisted) return;
                        onTurnstileReset();
                        if (window.turnstile) window.turnstile.reset();
                        });
                    </script>
                    </body>
                    </html>`;

    return new Response(html, { status: 403, headers: responseHeaders.html() });
}

/**
 * Fail open: the CAPTCHA is paused (see SiteverifyPause: siteverify is down, or answering replies keeps failing), so the
 * token can't be checked; or the retry page itself could not be built (see unavailableAnswer).
 * 302 back to the page without the token and without a session. There RTI is called as usual and validateChallenge
 * waives the CAPTCHA while the pause lasts, so the request goes on with x-cheq-rti-result.
 */
function challengeUnavailableFailOpen(url: URL, queryStringData: URLSearchParams): Response {
    return new Response(null, { status: 302, headers: { Location: returnUrl(url, queryStringData).href, ...responseHeaders.noStore() } });
}

/**
 * True when `hostname` is one of `allowed` or a subdomain of one. The match is on a dot boundary: `example.com` covers
 * `www.example.com`, but not `evilexample.com` or `example.com.evil.net`. Both sides are already normalized.
 */
function isAllowedHostname(hostname: string, allowed: string[]): boolean {
    return hostname !== "" && allowed.some(host => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * Verifies a Turnstile token with Cloudflare's siteverify endpoint. A token is single-use and expires after 300 seconds.
 *
 * `success` alone only says the token is genuine for this site key. It is accepted only when it was also solved on
 * THIS host and on the CHEQ challenge widget ({@link CHALLENGE_ACTION}): otherwise a token from another site sharing
 * the site key, or from another Turnstile widget on this site (a login or newsletter form), would buy a CHEQ session.
 * An empty or missing action is rejected too, never accepted "to be safe": the site's other widgets usually have none,
 * so allowing it would let exactly those tokens through. With `allowedHostnames` set, the token's host must be one of
 * them or a subdomain of one; without it, exactly the request's host (a request host that normalizes to nothing cannot
 * be checked, so the token is rejected).
 * Hosts go through RTIStatelessUtils.normalizeHost first, so case, a `:port` or a stray scheme do not cause a mismatch.
 */
async function verifyTurnstileToken(settings: ResolvedTurnstileSettings, token: string, request: Request, url: URL): Promise<boolean> {
    // Throws SiteverifyRefusedError on a 4xx. Throws on a timeout, a network error, any other status outside 200-299 or a
    // body that is not JSON: siteverify itself failed.
    const verifyResponse = await fetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // JSON leaves out an undefined remoteip: without CF-Connecting-IP (a local run) siteverify gets none.
        body: JSON.stringify({ secret: settings.secretKey, response: token, remoteip: clientIp(request) ?? undefined }),
        signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    // Read the body first, whatever the status: an unread body keeps the connection busy.
    const body = await verifyResponse.text();
    if (verifyResponse.status >= 400 && verifyResponse.status < 500) {
        throw new SiteverifyRefusedError(`siteverify refused the call: HTTP ${verifyResponse.status}`);
    }
    if (verifyResponse.status < 200 || verifyResponse.status >= 300) {
        throw new Error(`siteverify answered HTTP ${verifyResponse.status}`);
    }

    const result = JSON.parse(body) as { success?: boolean; hostname?: string; action?: string };
    if (result.success !== true) {
        return false;
    }

    // The token is genuine from here on, so a mismatch is worth a warning: it points at a setup problem (a missing
    // data-action, a site on several host names, test keys) as often as at a reused token. Never log the token.
    const requestHost = RTIStatelessUtils.normalizeHost(url.host);
    const hostname = RTIStatelessUtils.normalizeHost(result.hostname);
    const action = result.action ?? "";
    let accepted = true;

    if (settings.allowedHostnames.length > 0) {
        // The operator's list wins over the request's host.
        if (!isAllowedHostname(hostname, settings.allowedHostnames)) {
            console.warn(`[turnstile] token valid but hostname '${hostname}' is not in allowedHostnames or a subdomain of one (${settings.allowedHostnames.join(", ")})`);
            accepted = false;
        }
    } else if (!requestHost) {
        console.warn(`[turnstile] token valid but the request host '${url.host}' cannot be compared with hostname '${hostname}' (set allowedHostnames)`);
        accepted = false;
    } else if (hostname !== requestHost) {
        console.warn(`[turnstile] token valid but hostname '${hostname}' ≠ request host '${requestHost}' (if the site answers on several host names, set allowedHostnames)`);
        accepted = false;
    }

    if (action !== CHALLENGE_ACTION) {
        // An empty action is what a challenge page without data-action produces; another action is another widget.
        const hint = action ? "" : " (is data-action missing from the challenge page?)";
        console.warn(`[turnstile] token valid but action '${action}' ≠ '${CHALLENGE_ACTION}'${hint}`);
        accepted = false;
    }

    return accepted;
}

/** The hosts of a local run (`wrangler dev`): the only place where a visitor stays on plain http. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Where the visitor goes after the challenge, on THIS site: the host comes from the request, never from the query
 * string, and original_url must be a path (see RTIStatelessUtils.safeReturnPath). The path starts with "/" and
 * follows the host, so it cannot change the host. The URL parser writes the result as a value a header can always
 * hold. Its pathname is the path the landing request will have (see signedRefererCookie).
 *
 * The scheme is https. The session cookie is Secure, and a browser drops a Secure cookie that a plain-http answer
 * sets: a visitor sent back to http would get the CAPTCHA again after every solve. So a request that came over http
 * is sent to https on the default port (Cloudflare's http ports do not speak TLS). Only a local run keeps http and
 * its port: Chrome keeps a Secure cookie from localhost over http (Safari does not, see the README). A visitor who
 * solved the CAPTCHA on http has no session on https, so they are asked once more there (see the comment in
 * turnstileChallengeExample).
 */
function returnUrl(url: URL, queryStringData: URLSearchParams): URL {
    const origin = url.protocol === "https:" || LOOPBACK_HOSTS.includes(url.hostname) ? url.origin : `https://${url.hostname}`;
    return new URL(origin + returnPath(url, queryStringData));
}

/** The checked original_url (path, query, fragment), or the request's own path. */
function returnPath(url: URL, queryStringData: URLSearchParams): string {
    const originalUrl = queryStringData.get("original_url");
    return RTIStatelessUtils.safeReturnPath(originalUrl) ?? ownUriReturnPath(url, originalUrl) ?? url.pathname;
}

/**
 * original_url when it is the request's own path plus a query and/or fragment, so those are kept for a path that
 * safeReturnPath rejects: "//page?x=1" is what the challenge page sends for https://site//page?x=1. safeReturnPath
 * guards a RELATIVE Location, where "//page" would be another host. Behind the request's host, the host
 * comes first and the path cannot change it (a "\" reads as "/", still path), and the path is the one this request
 * already has. Control characters are still refused, as safeReturnPath refuses them: the URL parser would drop a tab,
 * LF or CR, and the visitor would land on another URL.
 */
function ownUriReturnPath(url: URL, originalUrl: string | null): string | undefined {
    if (!originalUrl?.startsWith(url.pathname) || /[\x00-\x1F\x7F]/.test(originalUrl)) {
        return undefined;
    }
    const rest = originalUrl.slice(url.pathname.length);
    return rest.startsWith("?") || rest.startsWith("#") ? originalUrl : undefined;
}

/**
 * The challenge was solved and verified: 302 back to where the visitor was, with a new `_cq_se` session bound to this client (IP and User-Agent of the
 * reply, see sessionBindingKey). Only sent once the token is verified.
 */
async function challengePassed(settings: ResolvedTurnstileSettings, request: Request, response: RTIResponse, url: URL, addRtiResultHeader?: (headers: Headers) => void): Promise<Response> {
    const ttl = settings.sessionTtlSeconds;
    const expiresAt = Date.now() + (ttl * 1000);
    const signature = await signSession(settings.sessionSigningSecret, expiresAt, response.ids.rayId, sessionBindingKey(settings, request));

    const sessionToken = `${expiresAt}.${signature}`;

    // Built once: it is the Location, and its pathname is the landing path that _cq_rf is signed for and set on (see
    // signedRefererCookie).
    const location = returnUrl(url, url.searchParams);
    // Never stored, like every redirect of ours (see challengeUnavailableFailOpen): set before addRtiResultHeader runs.
    const headers = new Headers({ Location: location.href, ...responseHeaders.noStore() });
    // SameSite=Lax, NOT Strict. A visitor who reaches the site from another site
    // (link click, ad, redirect) makes a cross-site top-level navigation. With Strict
    // the browser does not send _cq_se on that request, so the session is never seen
    // and the visitor is challenged again on every arrival from outside. Lax sends the
    // cookie on top-level GET navigations but still withholds it from cross-site
    // subrequests (iframes, images, fetch) and cross-site POSTs. Do not change to Strict.
    headers.append("Set-Cookie", `_cq_se=${sessionToken}|${response.ids.rayId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`);
    // Where the visitor came from before the CAPTCHA, for one of two readers (only one cookie is set):
    // "header": _cq_rf, signed and HttpOnly, for the Worker: on the landing request it becomes x-cheq-original-referer.
    // "cookie": _cq_ref, readable, for the site's own scripts.
    const refererCookieToSet = settings.originalRefererVia === "header"
        ? await signedRefererCookie(settings, request, url, url.searchParams, location.pathname)
        : readableRefererCookie(url, url.searchParams);
    if (refererCookieToSet) {
        headers.append("Set-Cookie", refererCookieToSet);
    }
    // Adds x-cheq-rti-result (the verdict of this request), provided by the handler. This 302 goes to the BROWSER
    // (not the origin), so the client sees verdict, threat-type-code and ids. The redirected request is checked by
    // RTI again and gets its own header on the way to the origin. Called before the Response is created, so what it
    // sets is sent with the 302.
    addRtiResultHeader?.(headers);
    return new Response(null, { status: 302, headers });
}

/**
 * The _cq_ref cookie: where the visitor came from before the CAPTCHA, for the site's own scripts (document.referrer
 * now shows the CAPTCHA page). Not HttpOnly, so scripts can read it. Only set on the 302 after a verified solve.
 * The same format as on CloudFront: `{return URL}|{Referer}`, both URL-encoded, Path=/, 60 seconds.
 * This code never reads it back, so a planted or edited value never becomes x-cheq-original-referer (only a valid
 * _cq_rf can), and RTI never gets it (the handler sends RTI the three CHEQ cookies of the tag, not the Cookie header).
 * The origin gets it inside the Cookie header, as the browser sent it, like any other cookie.
 * It is Secure: a browser drops it from an answer sent over plain http, so a visitor on plain http loses the original
 * Referer (README, "A visitor on plain http").
 */
function readableRefererCookie(url: URL, queryStringData: URLSearchParams): string | undefined {
    const referer = carriedReferer(url, queryStringData);
    if (!referer) {
        return undefined;
    }
    return `_cq_ref=${statelessUtils.originalRefererCookieValue(returnPath(url, queryStringData), referer)}; Path=/; Secure; SameSite=Lax; Max-Age=${ORIGINAL_REFERER_COOKIE_MAX_AGE_SECONDS}`;
}

const SIGNED_REFERER_COOKIE = "_cq_rf";

/**
 * The _cq_rf cookie (originalRefererVia "header"): the original Referer for the landing request, where
 * refererFromSignedCookie turns it into the x-cheq-original-referer header. Signed like _cq_se, and also bound to the
 * landing page, so it can't be made up, edited, or used from another client or page. HttpOnly: scripts can't see it.
 * Format: `{expiresAt}.{signature}|{Referer, URL-encoded}`. It is not deleted after use: originalReferer, which reads
 * it, sees only the request, and the origin's response goes back to the visitor unchanged, so nothing sets a cookie on
 * it. It simply expires after 60 seconds. It is Secure: a browser drops it from an answer sent over plain http, so a
 * visitor on plain http loses the original Referer (README, "A visitor on plain http").
 *
 * `landingPath` is the pathname of the URL that challengePassed puts in the 302's Location, built once there: the
 * cookie's path and the redirect's path are the same by construction, not a string cut out of original_url. The
 * landing request's path went through the same URL parser, so the two match also when the parser rewrites the path
 * (`/a/../shop/item` is `/shop/item`).
 */
async function signedRefererCookie(settings: ResolvedTurnstileSettings, request: Request, url: URL, queryStringData: URLSearchParams, landingPath: string): Promise<string | undefined> {
    const referer = carriedReferer(url, queryStringData);
    if (!referer) {
        return undefined;
    }
    const expiresAt = Date.now() + ORIGINAL_REFERER_COOKIE_MAX_AGE_SECONDS * 1000;
    const signature = await signReferer(settings.sessionSigningSecret, expiresAt, referer, landingPath, sessionBindingKey(settings, request));
    return `${SIGNED_REFERER_COOKIE}=${expiresAt}.${signature}|${encodeURIComponent(referer)}; Path=${statelessUtils.cookiePath(landingPath)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${ORIGINAL_REFERER_COOKIE_MAX_AGE_SECONDS}`;
}

/**
 * The original Referer from a valid _cq_rf cookie, or undefined: no cookie, a format other than the one issued,
 * expired, or a signature that doesn't match (edited, made up, another client or another page).
 * A promise, because signing is one: the handler awaits it.
 */
async function refererFromSignedCookie(settings: ResolvedTurnstileSettings, request: Request): Promise<string | undefined> {
    const raw = cookieValue(requestCookies(request), SIGNED_REFERER_COOKIE);
    const separator = raw?.indexOf("|") ?? -1;
    if (!raw || separator < 0) {
        return undefined;
    }
    const parts = raw.slice(0, separator).split(".");
    const expiresAt = statelessUtils.parseExpiresAt(parts[0]);
    if (parts.length !== 2 || expiresAt === undefined || Date.now() > expiresAt) {
        return undefined;
    }
    let referer: string;
    try {
        referer = decodeURIComponent(raw.slice(separator + 1));
    } catch {
        return undefined;
    }
    const expected = await signReferer(settings.sessionSigningSecret, expiresAt, referer, new URL(request.url).pathname, sessionBindingKey(settings, request));
    return sameSignature(expected, parts[1]) ? referer : undefined;
}

// Like signSession, with its own label ("rf") so a session signature can never pass as a Referer one.
async function signReferer(secret: string, expiresAt: number, referer: string, path: string, bindingKey: string): Promise<string> {
    return hmacHex32(secret, JSON.stringify(["rf", expiresAt, referer, path, bindingKey]));
}

const turnstileValidateChallengeExample = async (settings: ResolvedTurnstileSettings, request: Request, isDebug: boolean | undefined = false): Promise<boolean> => {
    // Validate session token (if the validation already happened in a previous request and the client has a valid session cookie or header, allow the request to proceed without triggering another challenge)
    const cookies = requestCookies(request);
    const [cookieToken, cookieRayId] = cookieValue(cookies, "_cq_se")?.split("|") ?? [];
    const rayId = request.headers.get("x-cheq-ray-id") || cookieRayId;
    const sessionToken = request.headers.get("x-cheq-challenge") || cookieToken;

    const shouldValidateChallenge = sessionToken && rayId;
    if (isDebug) {
        // Cookie names only, and only where the session token came from: values (the site's own login cookies, our
        // session token) must never reach the log.
        const tokenSource = request.headers.get("x-cheq-challenge") ? "x-cheq-challenge header" : "cookie";
        console.log(`[validateChallenge] cookies: ${cookies.length > 0 ? statelessUtils.cookieNames(cookies) : "NOT PRESENT"}`);
        console.log(`[validateChallenge] sessionToken: ${sessionToken ? `present (${tokenSource})` : "NOT FOUND"}, rayId: ${rayId ?? "NOT FOUND"}, shouldValidateChallenge: ${shouldValidateChallenge ?? "NOTHING_TO_VALIDATE_CALL_RTI"}`);
    }

    if (shouldValidateChallenge) {
        try {
            // Exactly "{expiresAt}.{signature}": a third part ("{expiresAt}.{signature}.junk") is not a cookie we issued.
            const parts = sessionToken.split(".");
            const [expiresAtStr, signature] = parts;

            if (parts.length !== 2 || !expiresAtStr || !signature) {
                if (isDebug) {
                    console.log("[validateChallenge] invalid sessionToken format, returning 'false'");
                }

                return false;
            }

            // Only the exact spelling challengePassed issues (see RTIStatelessUtils.parseExpiresAt).
            const expiresAt = statelessUtils.parseExpiresAt(expiresAtStr);
            if (expiresAt === undefined) {
                if (isDebug) {
                    console.log("[validateChallenge] invalid expiresAt format, returning 'false'");
                }

                return false;
            }

            if (Date.now() > expiresAt) {
                if (isDebug) {
                    console.log(`[validateChallenge] session token expired at ${expiresAt}, current time is ${Date.now()}, returning 'false'`);
                }

                return false;
            }

            // Verify signature (keyed HMAC, constant-time compare), with the binding of THIS request: a session (cookie or
            // x-cheq-challenge header) from another client fails like a forged one.
            const match = await isValidSessionSignature(settings.sessionSigningSecret, expiresAt, rayId, sessionBindingKey(settings, request), signature);

            if (isDebug) {
                // Never the IP or User-Agent. A mismatch cannot tell a changed client from a forged or tampered
                // signature (the cookie carries no binding to compare), so it names all three.
                console.log(match
                    ? "[validateChallenge] signature match: true"
                    : "[validateChallenge] signature match: false (session binding mismatch (ip or user-agent), or a forged or tampered session)");
            }

            return match;
        } catch (e) {
            // errorMessage, not e.message: a rejection can be anything, even undefined, and this catch must not throw.
            console.error(`[validateChallenge] error validating challenge (continue running returning 'false'): ${statelessUtils.errorMessage(e)}`);
            return false;
        }
    }

    return false;
}
