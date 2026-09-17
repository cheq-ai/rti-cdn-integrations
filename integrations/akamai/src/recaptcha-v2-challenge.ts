import { TextEncoder } from 'encoding';
import URLSearchParams from 'url-search-params';
import { httpRequest } from 'http-request';
import { RTIResponse } from '../../core/models/rti-response.model';
import { sign, issueGrant, hasValidGrant } from './challenge-signing';

/**
 * Google reCAPTCHA for Akamai EdgeWorkers — v2 checkbox AND v3 invisible/score.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * v2 ("I'm not a robot") — interactive checkbox. User must click.
 * v3 (invisible)         — no puzzle. Google returns a score 0.0–1.0; we pass
 *                          if score >= threshold (default 0.5).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Both verify via POST /recaptcha/api/siteverify (self-proxied to www.google.com).
 * Property Manager: path `/recaptcha/*` → Origin `www.google.com` (same as /defend/*).
 *
 * Keys: create at https://www.google.com/recaptcha/admin
 *   - v2 → choose "reCAPTCHA v2" → "I'm not a robot" Checkbox
 *   - v3 → choose "reCAPTCHA v3"
 * Keys are NOT interchangeable between v2 and v3.
 *
 * Google's official always-pass *test* keys work for v2 only (defaults below).
 * v3 always needs real keys from the admin console.
 */

export type RecaptchaVersion = 'v2' | 'v3';

export interface RecaptchaConfig {
    version: RecaptchaVersion;
    siteKey: string;
    /** Google's server-side key for the siteverify call (PMUSER_CHEQ_RECAPTCHA_SECRET). */
    secret: string;
    /**
     * Key used to sign the `_cq_se` session cookie (PMUSER_CHEQ_CHALLENGE_SECRET).
     * Distinct from `secret` above, which is Google's. Supplied by the caller so that one
     * place decides whether a challenge can be served at all.
     */
    sessionSecret: string;
    /** Hostname on the verify sub-request Host header (self-proxy hostname). */
    verifyHost: string;
    sessionTtlSeconds?: number;
    /**
     * v3 only — minimum Google score to pass (0.0 = bot … 1.0 = human).
     * Default 0.5. Raise (e.g. 0.7) for stricter; lower (e.g. 0.3) for more lenient.
     */
    scoreThreshold?: number;
    /** v3 only — action name sent to grecaptcha.execute (appears in Google admin). */
    action?: string;
}

// Google's documented always-pass test keys — **v2 only**
// https://developers.google.com/recaptcha/docs/faq
export const RECAPTCHA_V2_TEST_SITE_KEY = '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI';
export const RECAPTCHA_V2_TEST_SECRET = '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe';

/** Akamai caps a respondWith() body at 2048 bytes; a larger body makes it throw. */
const AKAMAI_RESPOND_WITH_LIMIT = 2048;

/** UTF-8 byte length - EdgeWorkers has no Buffer. */
function byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
}

const DEFAULT_SESSION_TTL = 900;
const DEFAULT_SCORE_THRESHOLD = 0.5;
const DEFAULT_V3_ACTION = 'cheq_challenge';

/**
 * Accepts `original_url` only when it is a same-origin absolute path.
 *
 * It arrives as a query parameter, so any link can carry any value. Reflected into `Location`
 * verbatim it turns a PASSED CAPTCHA into an open redirect - a strong phishing primitive,
 * because the victim really did just prove they are human on the genuine site. Returning null
 * makes the caller fall back to the current path.
 *
 * `//host` and `/\host` are rejected too: browsers read both as protocol-relative and would
 * leave the site despite the leading slash.
 */
function safeReturnPath(raw: string | null): string | null {
    if (!raw) return null;

    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return null; // malformed percent-encoding
    }

    if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.startsWith('/\\')) {
        return null;
    }

    return decoded;
}

/**
 * Drops our own challenge parameters so a redirect or re-challenge starts from a clean URL.
 *
 * `cq_ok` has to go with them. A visitor who lands on `/?cq_ok=X` and is re-challenged after the
 * grant lapses would otherwise carry the dead grant into `original_url` and get it back in the
 * redirect ALONGSIDE the fresh one - and `hasValidGrant` reads the first `cq_ok`, which is the
 * dead one. That is an infinite reload on v3, which submits its own form. Matches the equivalent
 * filter in cheq-challenge.ts, which has always stripped it.
 */
function stripCaptchaParams(url: string): string {
    const [path, query] = url.split('?');
    if (!query) return url;
    const kept = query.split('&').filter(p =>
        !p.startsWith('g-recaptcha-response=') &&
        !p.startsWith('original_url=') &&
        !p.startsWith('request_id=') &&
        !p.startsWith('cq_ok='),
    );
    return kept.length > 0 ? `${path}?${kept.join('&')}` : path;
}

/** v2 — checkbox widget + Continue button. Must stay ≤2048 bytes. */
function buildV2Html(opts: {
    siteKey: string;
    actionUrl: string;
    returnPath: string;
    rayId: string;
}): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Security Verification</title><script src="https://www.google.com/recaptcha/api.js" async defer></script><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#070F18;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#E2E8F0;padding:20px}.c{background:#0D1B2A;border:1px solid #00D4AA33;border-radius:16px;padding:40px 32px;max-width:420px;width:100%;text-align:center}h1{font-size:1.4rem;margin:0 0 8px}p{color:#94A3B8;font-size:.9rem;margin:0 0 20px}.w{display:flex;justify-content:center;margin:0 0 16px;min-height:78px}.b{width:100%;padding:12px;font-size:1rem;font-weight:600;color:#0D1B2A;background:#00D4AA;border:0;border-radius:8px;cursor:pointer}.f{margin-top:14px;font-size:.7rem;color:#94A3B8;word-break:break-all}.f a{color:#00D4AA}</style></head><body><div class="c"><h1>Security Verification</h1><p>Confirm you are human to continue.</p><form action="${opts.actionUrl}" method="GET"><input type="hidden" name="original_url" value="${encodeURIComponent(opts.returnPath)}"><input type="hidden" name="request_id" value="${opts.rayId}"><div class="w"><div class="g-recaptcha" data-sitekey="${opts.siteKey}"></div></div><button type="submit" class="b">Continue</button></form><div class="f">Protected by <a href="https://cheq.ai">CHEQ</a> · reCAPTCHA v2<br>${opts.rayId}</div></div></body></html>`;
}

/**
 * v3 — invisible score check. User sees a spinner; JS auto-runs grecaptcha.execute
 * and submits the token. No checkbox. Must stay ≤2048 bytes.
 */
function buildV3Html(opts: {
    siteKey: string;
    actionUrl: string;
    returnPath: string;
    rayId: string;
    action: string;
}): string {
    const siteKeyJson = JSON.stringify(opts.siteKey);
    const actionJson = JSON.stringify(opts.action);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checking your browser</title><script src="https://www.google.com/recaptcha/api.js?render=${opts.siteKey}"></script><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#070F18;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#E2E8F0;padding:20px}.c{background:#0D1B2A;border:1px solid #00D4AA33;border-radius:16px;padding:40px 32px;max-width:420px;width:100%;text-align:center}.sp{width:40px;height:40px;margin:0 auto 16px;border:3px solid #00D4AA33;border-top-color:#00D4AA;border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}h1{font-size:1.3rem;margin:0 0 8px}p{color:#94A3B8;font-size:.9rem;margin:0 0 20px}.f{margin-top:14px;font-size:.7rem;color:#94A3B8;word-break:break-all}.f a{color:#00D4AA}</style></head><body><div class="c"><div class="sp"></div><h1>Checking your browser</h1><p>This will only take a moment.</p><form id="f" action="${opts.actionUrl}" method="GET"><input type="hidden" name="original_url" value="${encodeURIComponent(opts.returnPath)}"><input type="hidden" name="request_id" value="${opts.rayId}"><input type="hidden" name="g-recaptcha-response" id="t"></form><div class="f">Protected by <a href="https://cheq.ai">CHEQ</a> · reCAPTCHA v3<br>${opts.rayId}</div></div><script>grecaptcha.ready(function(){grecaptcha.execute(${siteKeyJson},{action:${actionJson}}).then(function(tok){document.getElementById('t').value=tok;document.getElementById('f').submit()})});</script></body></html>`;
}

export function createRecaptchaChallenge(cfg: RecaptchaConfig) {
    const sessionTtl = cfg.sessionTtlSeconds ?? DEFAULT_SESSION_TTL;
    const scoreThreshold = cfg.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
    const v3Action = cfg.action ?? DEFAULT_V3_ACTION;

    const challenge = async (
        request: EWRequest,
        rtiResponse: RTIResponse,
    ): Promise<{ html: string; headers: Record<string, string> }> => {
        const queryString = request.url.includes('?') ? request.url.split('?')[1] : '';
        const params = new URLSearchParams(queryString);
        const token = params.get('g-recaptcha-response');

        // Presence is read off the raw query string, not from params.get(): an absent parameter
        // and a present-but-empty one both come back falsy, and Akamai's URLSearchParams is a
        // polyfill whose null/undefined behaviour is not documented. This distinction is load
        // bearing, so it does not rest on an assumption about the polyfill.
        const tokenParamPresent = /(^|&)g-recaptcha-response=/.test(queryString);

        if (!tokenParamPresent) {
            const cleanPath = stripCaptchaParams(request.url);
            const actionUrl = `${request.scheme}://${request.host}${request.path}`;
            const origin = `${request.scheme}://${request.host}`;
            const rayId = rtiResponse.ids.rayId;

            const render = (returnPath: string) => cfg.version === 'v3'
                ? buildV3Html({ siteKey: cfg.siteKey, actionUrl, returnPath, rayId, action: v3Action })
                : buildV2Html({ siteKey: cfg.siteKey, actionUrl, returnPath, rayId });

            // The round-trip URL is the only caller-controlled input to this page, and the body
            // is capped at 2048 bytes. Overflowing makes respondWith throw; main.ts's CAPTCHA
            // case catches that and falls through to ALLOW, so a padded query string on a real
            // page URL would silently bypass the challenge. Degrade the return URL instead -
            // full URL, then path only, then none. Losing the query string on the
            // post-challenge redirect beats losing the challenge. A path long enough to
            // overflow the last step cannot address a real resource, so it has nothing to bypass.
            let html = render(cleanPath);
            if (byteLength(html) > AKAMAI_RESPOND_WITH_LIMIT) {
                html = render(request.path);
            }
            if (byteLength(html) > AKAMAI_RESPOND_WITH_LIMIT) {
                html = render('');
            }
            return {
                html,
                headers: {
                    'Content-Type': 'text/html;charset=UTF-8',
                    'Cache-Control': 'no-store, no-cache, must-revalidate',
                },
            };
        }

        // Built by hand rather than with URLSearchParams: Akamai's url-search-params module is a
        // polyfill whose documented constructor takes a query STRING, and the object form is not
        // documented as supported. Three fields of known shape do not justify the risk - a throw
        // here is caught by main.ts's CAPTCHA case, which falls through to ALLOW, so the visitor
        // is let past the challenge with nothing logged.
        // The parameter is here but empty, so grecaptcha resolved without a token - rate
        // limiting, or a transient failure reaching Google. Serving another challenge would be
        // wrong: the v3 page submits ITSELF, so the visitor spins in an infinite reload. Report
        // the failure instead; reloading starts a clean attempt with no parameter at all.
        if (!token) {
            return {
                html: 'Verification failed. Please go back and try again.',
                headers: { 'Content-Type': 'text/plain' },
            };
        }

        const verifyBody = `secret=${encodeURIComponent(cfg.secret)}`
            + `&response=${encodeURIComponent(token)}`
            + `&remoteip=${encodeURIComponent(request.clientIp)}`;

        // No Content-Length: Akamai sets it, and its docs warn that supplying it on a sub-request
        // can break the request. The working /defend/ call does not set one either.
        const verifyResponse = await httpRequest('/recaptcha/api/siteverify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Host': cfg.verifyHost,
            },
            body: verifyBody,
            timeout: 3000,
        });

        const result = await verifyResponse.json() as {
            success: boolean;
            score?: number;
            action?: string;
            'error-codes'?: string[];
        };

        let passed = result.success === true;
        if (passed && cfg.version === 'v3') {
            const score = typeof result.score === 'number' ? result.score : 0;
            // Reject if score too low, or if Google returned a different action than we sent
            passed = score >= scoreThreshold && (!result.action || result.action === v3Action);
        }

        if (passed) {
            const expiresAt = Date.now() + (sessionTtl * 1000);
            const rayId = rtiResponse.ids.rayId;
            const signature = await sign(cfg.sessionSecret, `se:${expiresAt}:${rayId}`);
            // Never trust original_url as a whole URL - see safeReturnPath. Strip on BOTH
            // branches: original_url arrives from the page we served, so a challenge page built
            // before this fix - or one replayed from cache, history or a shared link - can still
            // carry a stale cq_ok that must not be reflected into Location.
            const returnPath = stripCaptchaParams(
                safeReturnPath(params.get('original_url')) ?? request.url,
            );
            const redirectTo = `${request.scheme}://${request.host}${returnPath}`;

            const grantSeparator = redirectTo.includes('?') ? '&' : '?';

            return {
                html: '',
                headers: {
                    'Location': `${redirectTo}${grantSeparator}cq_ok=${await issueGrant(cfg.sessionSecret, rayId)}`,
                    'Set-Cookie': `_cq_se=${expiresAt}.${signature}|${rayId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionTtl}`,
                },
            };
        }

        return {
            html: 'Verification failed. Please go back and try again.',
            headers: { 'Content-Type': 'text/plain' },
        };
    };

    return challenge;
}

/** Validates the `_cq_se` session cookie set after a successful reCAPTCHA challenge. */
const buildRecaptchaValidator = (sessionSecret: string) => async (request: EWRequest): Promise<boolean> => {
    try {
        if (await hasValidGrant(sessionSecret, request)) {
            return true;
        }
    } catch { /* a malformed grant must not stop the cookie from being checked */ }

    const cookieHeader = request.getHeader('Cookie');
    const cookieStr = cookieHeader && cookieHeader.length > 0 ? cookieHeader[0] : '';
    const cookies = cookieStr.split(';').map(c => c.trim());

    const seValue = cookies.find(c => c.startsWith('_cq_se='))?.substring('_cq_se='.length);
    if (!seValue) return false;

    const [cookieToken, cookieRayId] = seValue.split('|');
    if (!cookieToken || !cookieRayId) return false;

    try {
        const [expiresAtStr, signature] = cookieToken.split('.');
        if (!expiresAtStr || !signature) return false;

        const expiresAt = parseInt(expiresAtStr, 10);
        if (isNaN(expiresAt) || Date.now() > expiresAt) return false;

        return signature === await sign(sessionSecret, `se:${expiresAt}:${cookieRayId}`);
    } catch {
        return false;
    }
}

/**
 * Builds the `_cq_se` session validator, bound to the same signing secret used to issue it.
 */
export function createRecaptchaSessionValidator(sessionSecret: string) {
    return buildRecaptchaValidator(sessionSecret);
}
