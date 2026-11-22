import { ActionStrategy } from '../../core/models/action-strategy.model';
import { Action } from '../../core/models/action.model';
import { Config } from '../../core/models/config.interface';
import { Mode } from '../../core/models/mode.model';
import { RTIResponse } from '../../core/models/rti-response.model';
import { createTurnstileChallenge, TurnstileSettings } from './turnstile-challenge-example';
/**
 * See {@link https://cheq-ai.github.io/rti-cdn-integrations/interfaces/Config.html | Config}
 */
export interface CloudflareConfig extends Config {
    /**
     * Called when the action strategy is `CAPTCHA` (by default for CHALLENGE actions, see `challengingStrategy`)
     * and the visitor has no valid session (see `validateChallenge`).
     * In BLOCKING mode it is also called for every reply to the challenge page (see `isChallengeResponse`) when RTI
     * allows it (no strategy) or the strategy is CAPTCHA (`isChallengeReplyAllowed`), with or without a valid session.
     * Any other strategy (ACCESS_DENIED, NOT_FOUND, REDIRECT) is enforced as usual.
     * When a recognized reply cannot be evaluated (RTI error or timeout, a malformed RTI response, or any other error
     * before the decision), it is still called, without `addRtiResultHeader` and with a stand-in
     * `response` that is NOT an RTI answer: only `ids` exists (no `decision`, `classification`, ...). `ids.rayId` and
     * `ids.customParam2` are the `cf-ray` value, so `ids.rayId` is not an RTI ray id there; every other id is null.
     * If that id is not a plain, unique id, `ids.rayId` is a random `cf-fallback-<uuid>` instead (logged).
     * The example only signs the session with `ids.rayId`. Do not report it as an RTI ray id, and do not read other fields
     * without checking them: a throw here is caught and the request is forwarded. For a reply that means the origin gets
     * the token and the form fields in place of the visitor's query string, so answer your own errors on a reply (the
     * example handles them like a siteverify outage and never throws).
     * Returning a `Request` forwards that request. A challenge that reads the body should read it from
     * `request.clone()`, because a consumed body cannot be forwarded if the challenge then fails.
     * @param request
     * @param response
     * @param addRtiResultHeader sets `x-cheq-rti-result` (the verdict of this request: the one that triggered the
     *   challenge, or the reply's own) on the headers you pass it. Not passed when RTI failed. Optional to use: call it on the responses that should carry the verdict.
     *   The example calls it only on the 302 after a solved challenge.
     */
    challenge?: (
        request: Request,
        response: RTIResponse,
        addRtiResultHeader?: (headers: Headers) => void,
    ) => Promise<Response | Request>;

    /**
     * Checks whether the visitor already solved the challenge (a valid session). Called only when the RTI
     * action is CAPTCHA and `challenge` is set: a valid session waives the challenge, and the request is
     * forwarded with `x-cheq-rti-result`. It does not skip RTI. ACCESS_DENIED, NOT_FOUND and REDIRECT are never
     * waived; with `blockingStrategy: CAPTCHA`, blocked traffic is waived too. Never called for a reply that
     * `isChallengeResponse` recognizes: in BLOCKING mode that goes to `challenge` first. An unrecognized reply goes
     * through the usual flow, including this check.
     * It gets the request that is sent on to the origin, body included. It must read only the URL and the headers (read
     * the body from `request.clone()` if needed): a callback that reads the body itself leaves nothing to forward.
     * @param request
     * @param isDebug
     */
    validateChallenge?: (request: Request, isDebug: boolean | undefined) => Promise<boolean>;

    /**
     * Recognizes the reply to the challenge page (e.g. the Turnstile example looks for `cf-turnstile-response` in the
     * query). In BLOCKING mode such a reply always goes to `challenge`, so it is verified and redirected instead of
     * reaching the origin with the form fields. Only a synchronous `true` counts: any other value (a Promise too) means
     * no reply. If it throws, the request is handled as no reply and the error is logged.
     * It gets the request that is sent on to the origin, body included. It must read only the URL and the headers (read
     * the body from `request.clone()` if needed): a callback that reads the body itself leaves nothing to forward.
     * Not set while `challenge` is: replies are not recognized, and a warning is logged once per cold start.
     * @param request
     */
    isChallengeResponse?: (request: Request) => boolean;

    /**
     * Called on every request. Returns where the visitor came from before a CAPTCHA they just solved, or `undefined`.
     * It may return a promise of either, which is awaited: the Turnstile example's does, because signing is
     * asynchronous in a Worker.
     * The value is added to the request as `x-cheq-original-referer`, so RTI and the origin get it. A copy sent by the
     * client is always removed first. If it throws or its promise rejects, the request goes on without the header and
     * the error is logged. A value a header cannot hold (a line break inside the value) counts as an error.
     * It gets the request that is sent on to the origin, body included. It must read only the URL and the headers (read
     * the body from `request.clone()` if needed): a callback that reads the body itself leaves nothing to forward.
     * The Turnstile example returns it only with `originalRefererVia: "header"` (the default).
     * @param request
     */
    originalReferer?: (request: Request) => string | undefined | Promise<string | undefined>;
}

// Cloudflare Turnstile + CHEQ challenge-session settings (used by the example challenge).
// Until all three secrets are replaced, the CAPTCHA is disabled: challenged traffic is forwarded with x-cheq-rti-result.
const turnstileConfig: TurnstileSettings = {
    siteKey: "REPLACE_ME", // Turnstile dashboard → site key
    secretKey: "REPLACE_ME", // Turnstile dashboard → secret key (sent to Cloudflare siteverify)

    sessionSigningSecret: "REPLACE_ME",    // NOT the Turnstile secret. A random string of at least 32 bytes: run `openssl rand -hex 32` (64 hex characters).
    // Example of the format (generate your own, never use this one): "4f8c2a9e61d07b35c9e2f4a18d6b03e7a5c1f9d2e8b47a06c3d5e1f9b2a84c7d"

    sessionTtlSeconds: 300, // how long a solved challenge is remembered (5 minutes)

    // The session only works from the client that solved the challenge: its User-Agent and IP. A mismatch shows the
    // CAPTCHA again (no block). ip: "exact" | "none".
    sessionBinding: { ip: "exact", userAgent: true },

    // Optional: the site's hostnames. A solved CAPTCHA is accepted only if it was solved on one of them or a subdomain
    // of one ("example.com" also covers "www.example.com"). Without it, it must have been solved on the request's own
    // host (the host of its URL). Set it for several domains.
    // allowedHostnames: ["example.com"],

    // If Cloudflare's siteverify fails this many times in a row (timeout, network, 5xx; a 4xx doesn't count), the CAPTCHA is paused for
    // siteverifyPauseSeconds and challenged traffic is forwarded with x-cheq-rti-result. Any other error while answering
    // a solved CAPTCHA (e.g. signing the session) counts too.
    // Counted per Worker isolate, not for the whole site: each isolate pauses after its own 3 errors, so for a while
    // (longer on an isolate with little traffic) some visitors may still get the CAPTCHA while others pass. See
    // "Siteverify pause" in the README.
    // 0 turns the pause off: during an outage visitors get the CAPTCHA again, but it is never skipped.
    // What to do when siteverify is down:
    //   fail open:   1 or more - the CAPTCHA is skipped after that many errors in a row (1 = right away,
    //                            3 = the default: visitors retry first)
    //   fail closed: 0         - never skipped; visitors keep getting the CAPTCHA until Cloudflare is back
    siteverifyErrorsToPause: 3,
    siteverifyPauseSeconds: 60,

    // After a CAPTCHA the browser's Referer is the CAPTCHA page. Where the visitor really came from reaches the site as:
    //   "header" (default): the x-cheq-original-referer request header, for the origin and RTI (page scripts can't see it)
    //   "cookie":           the _cq_ref cookie, for the site's own scripts (see "The original Referer" in the README)
    originalRefererVia: "header",
};

// The callbacks are undefined until the three secrets above are set.
const turnstileChallenge = createTurnstileChallenge(turnstileConfig);

// Example for maintaining developer debug configuration can be found in cheq repo under: cheq-testing-website/src/frontend/pages/cdn/cloudflare/README.md
export const config: CloudflareConfig = {
    mode: Mode.MONITORING, // Start with MONITORING to observe before enforcing with BLOCKING

    apiKey: "REPLACE_ME", // Replace with your actual API key
    tagHash: "REPLACE_ME", // Replace with your actual Tag Hash
    
    // By default we use ActionStrategy.ACCESS_DENIED but you can set it to REDIRECT or CAPTCHA as well, but make sure to implement the relevant functions and configurations for each strategy
    //blockingStrategy: ActionStrategy.ACCESS_DENIED, 
    
    // By default we use ActionStrategy.CAPTCHA but you can set it to REDIRECT or ACCESS_DENIED as well, but make sure to implement the relevant functions and configurations for each strategy
    //challengingStrategy: ActionStrategy.CAPTCHA

    // The redirect url when decision was made to redirect the traffic
    //redirectLocation: 'https://www.cheq.ai/',

    challenge: turnstileChallenge.challenge,
    validateChallenge: turnstileChallenge.validateChallenge,
    isChallengeResponse: turnstileChallenge.isChallengeResponse,
    originalReferer: turnstileChallenge.originalReferer,

    // Example for ignored paths
    ignorePaths: [
        // Static assets — no user interaction, no value in RTI evaluation
        '\\.css$', '\\.js$', '\\.mjs$', '\\.map$',
        '\\.png$', '\\.jpg$', '\\.jpeg$', '\\.gif$', '\\.webp$', '\\.svg$', '\\.ico$',
        '\\.woff$', '\\.woff2$', '\\.ttf$', '\\.eot$',
        '\\.mp4$', '\\.webm$', '\\.mp3$',
        '\\.pdf$', '\\.zip$',

        // Well-known browser/crawl requests
        '^/favicon\\.ico$',
        '^/robots\\.txt$',
        '^/sitemap.*\\.xml$',
        '^/ads\\.txt$',

        // Health checks and monitoring (AWS ALB, Route53, uptime services)
        '^/health$',
        '^/healthcheck$',
        '^/ping$',
        '^/status$',

        // Internal / infrastructure paths
        '^/_next/',        // Next.js static files and HMR
        '^/__webpack',     // Webpack HMR
        '^/static/',       // Generic static directory
        '^/assets/',       // Generic assets directory
    ],

    // What to do with a request with a body when the strategy is CAPTCHA: RTI says CHALLENGE (challengingStrategy is
    // CAPTCHA by default), or BLOCK with blockingStrategy: CAPTCHA. A CAPTCHA page can't carry the body through, so
    // these requests are never challenged in place. GET and HEAD get the CAPTCHA page in place.
    //   Action.ALLOW:     forwarded with x-cheq-rti-result, so the origin decides (the default for every method).
    //                     With blockingStrategy: CAPTCHA that includes requests RTI wants blocked (set BLOCK or
    //                     CHALLENGE to stop them)
    //   Action.CHALLENGE: the CAPTCHA, for the page the visitor came from (Referer); after solving they send the form again
    //   Action.BLOCK:     the blockingStrategy answer (403 by default; the CAPTCHA with blockingStrategy: CAPTCHA)
    //   Action.REDIRECT:  a 302 to redirectLocation
    actionOnSuspicious: {
        methods: {
            POST: Action.ALLOW,    // forms, logins, checkout, API calls
            PUT: Action.ALLOW,     // API calls
            PATCH: Action.ALLOW,   // API calls
            DELETE: Action.ALLOW,  // API calls
            OPTIONS: Action.ALLOW, // CORS preflight: blocking it breaks the site's own cross-site API calls
        },
        // Per path (regex, like ignorePaths) and method. The first matching rule wins over the defaults above.
        // Every rule needs a path, written as a string ('^/login$', not /^\/login$/): a rule without one matches EVERY
        // path. Keep this exact shape (see "actionOnSuspicious" in the README).
        rules: [
            // { path: '^/login$', methods: ['POST'], action: Action.CHALLENGE },
        ],
    },

    timeout: 500,
    debug: false, // Set to true to enable debug logging, false for production
    telemetry: false,
    logErrors: true, // Set to false to stop sending caught errors to the RTI Logger service (console.error is unaffected)
};
