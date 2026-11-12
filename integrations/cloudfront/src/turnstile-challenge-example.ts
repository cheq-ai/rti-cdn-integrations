// cspell:ignore cheq siteverify duid unkeyed gclid
import { CloudFrontHeaders, CloudFrontRequest, CloudFrontRequestResult, CloudFrontResponseResult, CloudFrontResultResponse } from "aws-lambda";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIPv6, SocketAddress } from "node:net";
import { RTIResponse } from "../../core/models/rti-response.model";
import { RTIStatelessUtils } from "../../core/services/rti-stateless-utils";
import { HttpsClient } from "../../core/services/https-client";
import type { CloudfrontConfig } from "./config";
import { ResponseHeaders } from "./response-headers";

// Defined in core, so the debug logs mask the same parameter.
const TURNSTILE_RESPONSE_QUERY_PARAM = RTIStatelessUtils.TURNSTILE_RESPONSE_QUERY_PARAM;

// The challenge page and our redirects are never cached.
const responseHeaders = new ResponseHeaders();

// For the instance helpers (e.g. cookieNames for the debug log). The class holds no state, so one instance serves all.
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
     * Counted per Lambda instance, not for the whole site (see SiteverifyPause).
     * 0 turns the pause off: during a Cloudflare outage visitors get the CAPTCHA again, but it is never skipped.
     */
    siteverifyErrorsToPause?: number;
    /** How long the CAPTCHA is paused, in seconds. During the pause challenged traffic is forwarded with x-cheq-rti-result. Default 60. */
    siteverifyPauseSeconds?: number;
    /**
     * The site's hostnames, e.g. `["example.com"]`. A solved token is accepted only if Cloudflare says it was solved on
     * one of them or on a subdomain of one (`example.com` also covers `www.example.com` and `shop.eu.example.com`, not
     * `evilexample.com`). Optional: without it, the token must have been solved on the request's own Host.
     * Set it on origin-request when the viewer's Host is not forwarded (the Lambda then sees the origin's hostname,
     * and every solve would be rejected), or when the site has several domains. Case and a `:port` are ignored.
     */
    allowedHostnames?: string[];
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
    /** Normalized (lower case, no port). Empty: check against the request's Host. */
    allowedHostnames: string[];
};

const DEFAULT_SESSION_BINDING: SessionBinding = { ip: "exact", userAgent: true };

const SESSION_BINDING_IP_MODES: readonly string[] = ["exact", "none"];

const isSessionBinding = (value: unknown): value is SessionBinding =>
    typeof value === "object" && value !== null
    && SESSION_BINDING_IP_MODES.includes((value as SessionBinding).ip)
    && typeof (value as SessionBinding).userAgent === "boolean";

/** On origin-request, CloudFront sends this User-Agent unless the origin request policy forwards the viewer's. */
const CLOUDFRONT_USER_AGENT = "Amazon CloudFront";

const isPlaceholder = (value: string | undefined): boolean => !value || value.trim() === "" || value.trim() === "REPLACE_ME";

const DEFAULT_SESSION_TTL_SECONDS = 300;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// RTI already used part of the viewer-request 5 s budget.
const SITEVERIFY_TIMEOUT_MS = 1500;
// How long an unused connection to Cloudflare is kept for the next siteverify call.
// Kept well under Cloudflare's 400 s idle limit, so Cloudflare never closes it first.
const SITEVERIFY_IDLE_SOCKET_TIMEOUT_MS = 50000;
const DEFAULT_SITEVERIFY_ERRORS_TO_PAUSE = 3;
const DEFAULT_SITEVERIFY_PAUSE_SECONDS = 60;

// Same client as the RTI call: no fetch cold-start cost, a real timeout, and a stale pooled connection is retried once.
let siteverifyClient: HttpsClient | undefined;
const getSiteverifyClient = (): HttpsClient => (siteverifyClient ??= new HttpsClient(SITEVERIFY_URL, SITEVERIFY_IDLE_SOCKET_TIMEOUT_MS));

/**
 * Pauses the CAPTCHA when siteverify keeps failing, so visitors don't loop on a check that can't pass. Any other error
 * while answering a solved CAPTCHA counts too (see turnstileChallengeExample): it can't pass either.
 * After the pause it needs the same number of errors to pause again.
 *
 * The count lives in memory, so it is per Lambda instance: CloudFront runs many instances (several per edge region),
 * and each pauses on its own errors. A warm instance keeps its count and pause between requests (also while frozen).
 * A cold start is a new instance: it starts at 0 errors, not paused. When AWS recycles an instance, its count and
 * pause are gone with it. In a real outage every busy instance reaches the limit within seconds, but until
 * then a visitor may get the CAPTCHA from one instance and pass through another. That is the usual trade-off for an
 * in-memory breaker; sharing the count would need a store (e.g. DynamoDB) on every challenged request.
 * If all of Cloudflare is down, the widget itself does not load, no token arrives and siteverify is never called,
 * so this pause never starts: visitors stay on a CAPTCHA they can't solve, as with any CAPTCHA vendor outage.
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
        this.pausedUntilTimestamp = 0; // reset the pause on success only for human clarity
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
// through it: the URI comes from the client, and a raw `"` there would otherwise close the attribute and
// let the rest of the URI inject markup or a script on the customer's site.
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// All cookies of the request. A client (e.g. over HTTP/2) can split them over several Cookie headers.
const requestCookies = (request: CloudFrontRequest): string[] =>
    (request.headers["cookie"] ?? []).map(h => h.value).join(";").split(";").map(c => c.trim()).filter(Boolean);

// The value of the cookie `name` (everything after the first "="), or undefined.
const cookieValue = (cookies: string[], name: string): string | undefined =>
    cookies.find(c => c.startsWith(`${name}=`))?.substring(name.length + 1);

/**
 * Signs a challenge session: HMAC-SHA256 over the expiry, the rayId and the client binding ({@link sessionBindingKey}),
 * keyed with `secret`, as 32 hex characters. Without the key nobody can produce a valid `_cq_se` cookie (the old unkeyed
 * SHA-256 could be computed by anyone), and a copied cookie fails from a client with another User-Agent or IP.
 * The binding is only in the HMAC input, never in the cookie: validation recomputes it from the request.
 * Deliberately NOT bound to the visitor's `_cq_duid` (tried and reverted): on a first visit the challenge is solved
 * before the CHEQ tag has set that cookie, so a bound session broke as soon as it appeared and the visitor had to solve
 * the CAPTCHA twice. The IP and User-Agent are there from the first request.
 */
function signSession(secret: string, expiresAt: number, rayId: string, bindingKey: string): string {
    return createHmac("sha256", secret).update(JSON.stringify(["se", expiresAt, rayId, bindingKey])).digest("hex").slice(0, 32);
}

/** Checks a session signature in constant time. The secret is never a placeholder: createTurnstileChallenge refuses one. */
function isValidSessionSignature(secret: string, expiresAt: number, rayId: string, bindingKey: string, signature: string): boolean {
    const expected = Buffer.from(signSession(secret, expiresAt, rayId, bindingKey));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * What a session is bound to: the client's IP (per `sessionBinding.ip`) and User-Agent (`sessionBinding.userAgent`), as
 * one unambiguous string for the HMAC input (`JSON.stringify([ip, userAgent])`, "" for a part that is not bound).
 * Recomputed from each request, never stored: the cookie carries neither the IP nor the User-Agent.
 */
export function sessionBindingKey(settings: { sessionBinding: SessionBinding }, request: CloudFrontRequest): string {
    const { ip, userAgent } = settings.sessionBinding;
    return JSON.stringify([sessionBindingIp(ip, request.clientIp), userAgent ? requestUserAgent(request) : ""]);
}

// All User-Agent headers, joined; "" without one.
const requestUserAgent = (request: CloudFrontRequest): string =>
    (request.headers["user-agent"] ?? []).map(h => h.value).join(", ");

/**
 * The client IP as bound into the session. An IPv6 in Node's standard spelling (`2001:0DB8:0:0:0:0:0:1` → `2001:db8::1`),
 * so every spelling of an address is the same client; anything else as given.
 */
function sessionBindingIp(mode: SessionBinding["ip"], clientIp: string): string {
    if (mode === "none") {
        return "";
    }
    return isIPv6(clientIp) ? new SocketAddress({ address: clientIp, family: "ipv6" }).address : clientIp;
}

/**
 * Builds the example `challenge`, `validateChallenge` and `isChallengeResponse` callbacks from the settings in config.ts.
 * A factory, not an `import { config }`: config.ts imports this file, so that would be circular.
 *
 * Returns `{}` (and warns) while `siteKey`, `secretKey` or `sessionSigningSecret` is unset or `REPLACE_ME`:
 * the CAPTCHA is then disabled and challenged traffic is forwarded with `x-cheq-rti-result`, instead of
 * showing a broken widget or issuing sessions anyone could forge.
 */
export function createTurnstileChallenge(settings: TurnstileSettings): Pick<CloudfrontConfig, "challenge" | "validateChallenge" | "isChallengeResponse"> {
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
    // A list with anything but host names in it is ignored as a whole: a partly used list would accept fewer hosts than
    // the operator meant (a CAPTCHA loop), and guessing could accept more. The Host check is used instead.
    const listed: unknown = settings.allowedHostnames;
    const allowedHostnames = Array.isArray(listed) ? listed.map(h => typeof h === "string" ? RTIStatelessUtils.normalizeHost(h) : "") : [];
    const hostnamesValid = listed === undefined || (Array.isArray(listed) && allowedHostnames.every(h => h !== ""));
    if (!hostnamesValid) {
        console.warn(`[turnstile] invalid allowedHostnames ${JSON.stringify(settings.allowedHostnames)}, checking against the request's Host instead (set a list of host names, e.g. ["www.example.com"], in config.ts)`);
    }
    const resolved: ResolvedTurnstileSettings = {
        ...settings,
        sessionTtlSeconds: ttlValid ? settings.sessionTtlSeconds : DEFAULT_SESSION_TTL_SECONDS,
        sessionBinding: { ip: binding.ip, userAgent: binding.userAgent },
        siteverifyErrorsToPause: integerSetting("siteverifyErrorsToPause", settings.siteverifyErrorsToPause, 0, DEFAULT_SITEVERIFY_ERRORS_TO_PAUSE),
        siteverifyPauseSeconds: integerSetting("siteverifyPauseSeconds", settings.siteverifyPauseSeconds, 1, DEFAULT_SITEVERIFY_PAUSE_SECONDS),
        allowedHostnames: hostnamesValid ? allowedHostnames : [],
    };
    const pause = new SiteverifyPause(resolved.siteverifyErrorsToPause, resolved.siteverifyPauseSeconds);

    // Once per cold start (config.ts calls this factory once): on origin-request without the viewer's User-Agent
    // forwarded, every client has CloudFront's, so the User-Agent binding means nothing.
    let cloudFrontUserAgentWarned = false;
    const warnCloudFrontUserAgent = () => {
        if (!cloudFrontUserAgentWarned) {
            cloudFrontUserAgentWarned = true;
            console.warn(`[turnstile] User-Agent is '${CLOUDFRONT_USER_AGENT}': the session is not bound to the browser's User-Agent (on origin-request, forward the viewer's User-Agent in the origin request policy)`);
        }
    };

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
            return turnstileValidateChallengeExample(resolved, request, isDebug, warnCloudFrontUserAgent);
        },
        isChallengeResponse: turnstileIsChallengeResponseExample,
    };
}

/**
 * True when the request is the reply to the challenge page: the solved form came back with a Turnstile token.
 * Only the field name is checked (`cf-turnstile-response`, added by the Turnstile widget to its form), so a
 * site's own GET form with a Turnstile widget looks like a reply too.
 */
const turnstileIsChallengeResponseExample = (request: CloudFrontRequest): boolean =>
    !!new URLSearchParams(request.querystring).get(TURNSTILE_RESPONSE_QUERY_PARAM);

const turnstileChallengeExample = async (settings: ResolvedTurnstileSettings, pause: SiteverifyPause, request: CloudFrontRequest, response: RTIResponse, addRtiResultHeader?: (headers: CloudFrontHeaders) => void): Promise<CloudFrontRequestResult | CloudFrontResponseResult> => {
    const queryStringData = new URLSearchParams(request.querystring);
    // TURNSTILE_RESPONSE_QUERY_PARAM is not set by this code: once the visitor solves the challenge, the Turnstile
    // widget (api.js) injects a hidden input with this name into the enclosing <form>. The form submits via GET,
    // so the token arrives here as a query string parameter. It must still be verified server-side (siteverify below).
    const token = queryStringData.get(TURNSTILE_RESPONSE_QUERY_PARAM);

    if (!token) {
        // Not solved yet. The return URL keeps the query string (gclid, utm_*, ...): request.uri is only the path.
        const originalUrl = request.querystring ? `${request.uri}?${request.querystring}` : request.uri;
        return challengePage(settings, response, originalUrl);
    }
    // else : user already solved the challenge and submitted the form with the token. Verify it with Cloudflare's siteverify.

    // A reply is never answered by throwing: request-helper would forward it to the origin as it is (fail open), with the
    // token and the form fields in place of the visitor's own query string (gclid, utm_*, ...). An error answering it (a
    // bug or an unexpected input, e.g. while signing the session) is handled like a siteverify outage instead, and counts
    // toward the pause: an error on every reply then can't keep visitors on the CAPTCHA (unless siteverifyErrorsToPause is 0).
    try {
        return await answerReply(settings, pause, request, response, queryStringData, token, addRtiResultHeader);
    } catch (e) {
        console.error(`[turnstile] error answering the challenge reply: ${statelessUtils.errorMessage(e)}`);
        return unavailableAnswer(settings, pause, request, response, queryStringData);
    }
};

/** Answers the reply to the challenge page: `token` is the solved CAPTCHA, sent to Cloudflare's siteverify. */
async function answerReply(settings: ResolvedTurnstileSettings, pause: SiteverifyPause, request: CloudFrontRequest, response: RTIResponse, queryStringData: URLSearchParams, token: string, addRtiResultHeader?: (headers: CloudFrontHeaders) => void): Promise<CloudFrontResultResponse> {
    // Too long to be a real token: show the widget again, without calling Cloudflare and without counting toward the pause.
    if (token.length > MAX_TOKEN_LENGTH) {
        return challengeRetryPage(settings, request, response, queryStringData, VERIFICATION_FAILED_MESSAGE);
    }

    // The CAPTCHA is paused (siteverify is down): back to the page, where it is waived.
    if (pause.isPaused()) {
        return challengeUnavailableFailOpen(request, queryStringData);
    }

    let verified: boolean;
    try {
        verified = await verifyTurnstileToken(settings, token, request);
    } catch (e) {
        // A 4xx doesn't count toward the pause: a flood of junk tokens could get us rate limited (429), and that
        // must not let anyone switch the CAPTCHA off. It's a failed check: show the widget again.
        if (e instanceof SiteverifyRefusedError) {
            console.warn(`[turnstile] ${e.message}`);
            return challengeRetryPage(settings, request, response, queryStringData, VERIFICATION_FAILED_MESSAGE);
        }
        // Timeout, network error, 5xx or a bad answer: not the visitor's fault. Never forward the token to the origin.
        console.error(`[turnstile] siteverify error: ${statelessUtils.errorMessage(e)}`);
        return unavailableAnswer(settings, pause, request, response, queryStringData);
    }

    // Verified: back to the page with a session. Wrong, reused or expired token: the widget again instead of a dead end.
    const answer = verified
        ? challengePassed(settings, request, response, queryStringData, addRtiResultHeader)
        : challengeRetryPage(settings, request, response, queryStringData, VERIFICATION_FAILED_MESSAGE);
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
function unavailableAnswer(settings: ResolvedTurnstileSettings, pause: SiteverifyPause, request: CloudFrontRequest, response: RTIResponse, queryStringData: URLSearchParams): CloudFrontResultResponse {
    pause.recordError();

    if (!pause.isPaused()) {
        try {
            return challengeRetryPage(settings, request, response, queryStringData, VERIFICATION_UNAVAILABLE_MESSAGE);
        } catch (e) {
            console.error(`[turnstile] error building the retry page, redirecting to original_url instead: ${statelessUtils.errorMessage(e)}`);
        }
    }

    return challengeUnavailableFailOpen(request, queryStringData);
}

/**
 * The challenge page again, with `errorMessage`, after a token that did not pass, or a siteverify error or an error
 * answering the reply that did not pause the CAPTCHA. Solving it returns to the same page.
 */
function challengeRetryPage(settings: ResolvedTurnstileSettings, request: CloudFrontRequest, response: RTIResponse, queryStringData: URLSearchParams, errorMessage: string): CloudFrontResultResponse {
    return challengePage(settings, response, returnPath(request, queryStringData), errorMessage);
}

/** The 403 page with the Turnstile widget. `originalUrl` is where the visitor goes once solved. */
function challengePage(settings: ResolvedTurnstileSettings, response: RTIResponse, originalUrl: string, errorMessage?: string): CloudFrontResultResponse {
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
                        <form id="captcha-form" method="GET">${/* No action: the form goes back to this page's own URL, exactly as the browser requested it. An action built from request.uri would send a path like "//evil.com/" (with the token) to another site. */ ""}
                            <input type="hidden" name="original_url" value="${escapeHtml(originalUrl)}">
                            <input type="hidden" name="request_id" value="${escapeHtml(response.ids.rayId)}">
                            
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

    return {
        status: '403',
        headers: responseHeaders.html(),
        body: html,
    };
}

/**
 * Fail open: the CAPTCHA is paused (see SiteverifyPause: siteverify is down, or answering replies keeps failing), so the
 * token can't be checked; or the retry page itself could not be built (see unavailableAnswer).
 * 302 back to the page without the token and without a session. There RTI is called as usual and validateChallenge
 * waives the CAPTCHA while the pause lasts, so the request goes on with x-cheq-rti-result.
 */
function challengeUnavailableFailOpen(request: CloudFrontRequest, queryStringData: URLSearchParams): CloudFrontResultResponse {
    return {
        status: '302',
        headers: {
            location: [{ key: 'Location', value: returnLocation(request, queryStringData) }],
            ...responseHeaders.noStore(),
        },
    };
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
 * them or a subdomain of one; without it, exactly the request's Host (no Host header means it cannot be checked: rejected).
 * Hosts go through RTIStatelessUtils.normalizeHost first, so case, a `:port` or a stray scheme do not cause a mismatch.
 */
async function verifyTurnstileToken(settings: ResolvedTurnstileSettings, token: string, request: CloudFrontRequest): Promise<boolean> {
    // Throws SiteverifyRefusedError on a 4xx. Throws on a timeout, a network error, a 5xx or a body that is not JSON: siteverify itself failed.
    const verifyResponse = await getSiteverifyClient().post(
        JSON.stringify({ secret: settings.secretKey, response: token, remoteip: request.clientIp }),
        SITEVERIFY_TIMEOUT_MS,
    );
    if (verifyResponse.status >= 400 && verifyResponse.status < 500) {
        throw new SiteverifyRefusedError(`siteverify refused the call: HTTP ${verifyResponse.status}`);
    }
    if (verifyResponse.status < 200 || verifyResponse.status >= 300) {
        throw new Error(`siteverify answered HTTP ${verifyResponse.status}`);
    }

    const result = JSON.parse(verifyResponse.body) as { success?: boolean; hostname?: string; action?: string };
    if (result.success !== true) {
        return false;
    }

    // The token is genuine from here on, so a mismatch is worth a warning: it points at a setup problem (a missing
    // data-action, Host not forwarded to origin-request, test keys) as often as at a reused token. Never log the token.
    const requestHost = RTIStatelessUtils.normalizeHost(request.headers["host"]?.[0]?.value);
    const hostname = RTIStatelessUtils.normalizeHost(result.hostname);
    const action = result.action ?? "";
    let accepted = true;

    if (settings.allowedHostnames.length > 0) {
        // The operator's list wins over the Host header (which on origin-request may be the origin's own hostname).
        if (!isAllowedHostname(hostname, settings.allowedHostnames)) {
            console.warn(`[turnstile] token valid but hostname '${hostname}' is not in allowedHostnames or a subdomain of one (${settings.allowedHostnames.join(", ")})`);
            accepted = false;
        }
    } else if (!requestHost) {
        console.warn(`[turnstile] token valid but the request has no Host header to check hostname '${hostname}' against (on origin-request, forward the viewer's Host or set allowedHostnames)`);
        accepted = false;
    } else if (hostname !== requestHost) {
        console.warn(`[turnstile] token valid but hostname '${hostname}' ≠ request host '${requestHost}' (if this is the origin's hostname, forward the viewer's Host or set allowedHostnames)`);
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

/**
 * Where the visitor goes after the challenge, on THIS site. The host comes from the request (CloudFront only routes
 * hosts of this distribution), never from the query string, and original_url must be a path (see
 * RTIStatelessUtils.safeReturnPath, shared with Akamai's reCAPTCHA challenge). Without a Host header the Location
 * would stay relative, resolved by the browser against the current site; verifyTurnstileToken already rejects such a
 * request (no host to check the token against), so that branch is only a fallback.
 */
function returnLocation(request: CloudFrontRequest, queryStringData: URLSearchParams): string {
    const host = request.headers["host"]?.[0]?.value;
    const path = returnPath(request, queryStringData);
    return host ? `https://${host}${path}` : path;
}

/** The checked original_url (path, query, fragment), or the request's own path. */
function returnPath(request: CloudFrontRequest, queryStringData: URLSearchParams): string {
    const originalUrl = queryStringData.get("original_url");
    return RTIStatelessUtils.safeReturnPath(originalUrl) ?? ownUriReturnPath(request, originalUrl) ?? request.uri;
}

/**
 * original_url when it is the request's own URI plus a query and/or fragment, so those are kept for a path that
 * safeReturnPath rejects: "//page?x=1" is what the challenge page sends for https://site//page?x=1. safeReturnPath
 * guards a RELATIVE Location, where "//page" would be another host. Behind https://{host} the host comes first and the
 * path cannot change it (a "\" reads as "/", still path), and the path is the one this request already has. Control
 * characters are still refused: CR/LF would split the Location header.
 */
function ownUriReturnPath(request: CloudFrontRequest, originalUrl: string | null): string | undefined {
    if (!originalUrl?.startsWith(request.uri) || /[\x00-\x1F\x7F]/.test(originalUrl)) {
        return undefined;
    }
    const rest = originalUrl.slice(request.uri.length);
    return rest.startsWith("?") || rest.startsWith("#") ? originalUrl : undefined;
}

/**
 * The challenge was solved and verified: 302 back to where the visitor was, with a new `_cq_se` session bound to this client (IP and User-Agent of the
 * reply, see sessionBindingKey). Only sent once the token is verified.
 */
function challengePassed(settings: ResolvedTurnstileSettings, request: CloudFrontRequest, response: RTIResponse, queryStringData: URLSearchParams, addRtiResultHeader?: (headers: CloudFrontHeaders) => void): CloudFrontResultResponse {
    const ttl = settings.sessionTtlSeconds;
    const expiresAt = Date.now() + (ttl * 1000);
    const signature = signSession(settings.sessionSigningSecret, expiresAt, response.ids.rayId, sessionBindingKey(settings, request));

    const sessionToken = `${expiresAt}.${signature}`;

    const headers: CloudFrontHeaders = {
        location: [{ key: 'Location', value: returnLocation(request, queryStringData) }],
        // SameSite=Lax, NOT Strict. A visitor who reaches the site from another site
        // (link click, ad, redirect) makes a cross-site top-level navigation. With Strict
        // the browser does not send _cq_se on that request, so the session is never seen
        // and the visitor is challenged again on every arrival from outside. Lax sends the
        // cookie on top-level GET navigations but still withholds it from cross-site
        // subrequests (iframes, images, fetch) and cross-site POSTs. Do not change to Strict.
        "set-cookie": [{ key: 'Set-Cookie', value: `_cq_se=${sessionToken}|${response.ids.rayId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}` }],
    };
    // Adds x-cheq-rti-result (the verdict of this request), provided by the handler. This 302 goes to the BROWSER
    // (not the origin), so the client sees verdict, threat-type-code and ids. The redirected request is checked by
    // RTI again and gets its own header on the way to the origin.
    addRtiResultHeader?.(headers);

    return {
        status: '302',
        headers,
    };
}

const turnstileValidateChallengeExample = async (settings: ResolvedTurnstileSettings, request: CloudFrontRequest, isDebug: boolean | undefined = false, warnCloudFrontUserAgent?: () => void): Promise<boolean> => {
    // Validate session token (if the validation already happened in a previous request and the client has a valid session cookie or header, allow the request to proceed without triggering another challenge)
    if (settings.sessionBinding.userAgent && requestUserAgent(request) === CLOUDFRONT_USER_AGENT) {
        warnCloudFrontUserAgent?.();
    }
    const cookies = requestCookies(request);
    const [cookieToken, cookieRayId] = cookieValue(cookies, "_cq_se")?.split("|") ?? [];
    const rayId = request.headers["x-cheq-ray-id"]?.[0]?.value || cookieRayId;
    const sessionToken = request.headers["x-cheq-challenge"]?.[0]?.value || cookieToken;

    const shouldValidateChallenge = sessionToken && rayId;
    if (isDebug) {
        // Cookie names only, and only where the session token came from: values (the site's own login cookies, our
        // session token) must never reach the log.
        const tokenSource = request.headers["x-cheq-challenge"]?.[0]?.value ? "x-cheq-challenge header" : "cookie";
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

            // The only accepted spelling is the one challengePassed issues: `${expiresAt}` of a safe integer. Anything
            // else reads as a number but is not what we wrote ("123abc" for parseInt, "0123", " 123", "+123", "1e13",
            // "12.0" for Number), so the round trip rejects it; isSafeInteger rules out a value Number() rounded.
            const expiresAt = Number(expiresAtStr);
            if (!Number.isSafeInteger(expiresAt) || String(expiresAt) !== expiresAtStr) {
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
            const match = isValidSessionSignature(settings.sessionSigningSecret, expiresAt, rayId, sessionBindingKey(settings, request), signature);

            if (isDebug) {
                // Never the IP or User-Agent. A mismatch cannot tell a changed client from a forged or tampered
                // signature (the cookie carries no binding to compare), so it names all three.
                console.log(match
                    ? "[validateChallenge] signature match: true"
                    : "[validateChallenge] signature match: false (session binding mismatch (ip or user-agent), or a forged or tampered session)");
            }

            return match;
        } catch (e) {
            const err: Error = e as Error;
            console.error(`[validateChallenge] error validating challenge (continue running returning 'false'): ${err.message}`);
            return false;
        }
    }

    return false;
}
