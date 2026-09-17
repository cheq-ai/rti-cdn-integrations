import URLSearchParams from 'url-search-params';
import { RTIResponse } from '../../core/models/rti-response.model';
import { sign, issueGrant, hasValidGrant } from './challenge-signing';

/**
 * Self-contained CHEQ browser challenge — no third-party CAPTCHA service.
 *
 * Same concept as Akamai's native AKAMAI_WEB_CRYPTO challenge action (which
 * cannot be triggered by AAP custom rules, only by Bot Manager detections):
 * an interstitial that forces real JavaScript execution before the visitor
 * can proceed.
 *
 * Flow:
 *  1. Suspicious verdict → serve a "Verifying your browser" interstitial that
 *     embeds a short-lived signed token. The page's JS re-requests the original
 *     URL with ?cq_ct=<token> appended (curl/no-JS clients never follow).
 *  2. The re-request is classified suspicious again → challenge() sees the
 *     token, verifies signature + expiry, sets a signed _cq_se session cookie
 *     (HttpOnly) and 302-redirects to the clean original URL.
 *  3. validateCheqChallenge() honors the cookie for SESSION_TTL_SECONDS, so
 *     the visitor browses unchallenged (RTI is skipped) until it expires.
 *
 * Tokens and cookies are signed with SHA-256 over a bundle-embedded secret,
 * so they cannot be forged without the secret. The interstitial page must stay
 * under Akamai's 2048-byte respondWith() body limit (spec-enforced).
 */

const TOKEN_TTL_SECONDS = 120;   // challenge token validity
const SESSION_TTL_SECONDS = 300; // _cq_se cookie validity (5 minutes)

/** Strips our own challenge parameters so a redirect or re-challenge starts from a clean URL. */
function stripChallengeParams(url: string): string {
    const [path, query] = url.split('?');
    if (!query) return url;
    const kept = query.split('&').filter(p => !p.startsWith('cq_ct=') && !p.startsWith('cq_ok='));
    return kept.length > 0 ? `${path}?${kept.join('&')}` : path;
}

function buildChallengeHtml(tokenUrl: string, rayId: string): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checking your browser</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#070F18;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#E2E8F0;padding:20px}.c{background:#0D1B2A;border:1px solid #00D4AA33;border-radius:16px;padding:44px 36px;max-width:440px;width:100%;text-align:center}.sp{width:44px;height:44px;margin:0 auto 20px;border:3px solid #00D4AA33;border-top-color:#00D4AA;border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}h1{font-size:1.4rem;margin-bottom:10px}p{color:#94A3B8;font-size:.95rem;margin-bottom:24px}.r{background:#0003;border:1px solid #fff2;border-radius:8px;padding:10px;text-align:left}.rl{font-size:.7rem;color:#94A3B8;text-transform:uppercase}.ri{font-family:monospace;font-size:.8rem;color:#00D4AA;word-break:break-all}.f{margin-top:18px;font-size:.75rem;color:#94A3B8}.f a{color:#00D4AA}</style></head><body><div class="c"><div class="sp"></div><h1>Checking your browser</h1><p>This will only take a moment. You will be redirected automatically.</p><div class="r"><div class="rl">Session ID</div><div class="ri">${rayId}</div></div><div class="f">Protected by <a href="https://cheq.ai">CHEQ</a> Security</div></div><script>setTimeout(function(){location.replace(${JSON.stringify(tokenUrl)})},700)</script><noscript><p style="color:#FCA5A5;text-align:center;margin-top:16px">JavaScript is required to continue.</p></noscript></body></html>`;
}

/**
 * Challenge handler wired into config.challenge — serves the interstitial, or
 * verifies its token and grants a session cookie.
 */
const buildChallenge = (sessionSecret: string) => async (
    request: EWRequest,
    rtiResponse: RTIResponse,
): Promise<{ html: string; headers: Record<string, string> }> => {
    const queryString = request.url.includes('?') ? request.url.split('?')[1] : '';
    const params = new URLSearchParams(queryString);
    const token = params.get('cq_ct');

    if (token) {
        // Token format: <expiresAt>.<rayId>.<signature>
        const [expiresAtStr, tokenRayId, signature] = token.split('.');
        // No `?? ''` guard: `if (token)` above means token is a non-empty string, and split
        // always yields a string at index 0, so the fallback was unreachable - and an
        // unreachable branch is one no test can ever close.
        const expiresAt = parseInt(expiresAtStr, 10);

        if (
            expiresAtStr && tokenRayId && signature &&
            !isNaN(expiresAt) && Date.now() <= expiresAt &&
            signature === await sign(sessionSecret, `ct:${expiresAt}:${tokenRayId}`)
        ) {
            const sessionExpiresAt = Date.now() + (SESSION_TTL_SECONDS * 1000);
            const cookieSignature = await sign(sessionSecret, `se:${sessionExpiresAt}:${tokenRayId}`);

            // Akamai denies Set-Cookie on respondWith() unless the property carries the
            // <edgeservices:cookie.pass-set-cookie-policy> metadata tag - and drops it silently
            // when it does not. The visitor then lands on a page that is still suspicious, gets a
            // fresh interstitial, and spins forever. This grant lets that one landing request
            // through on its own, so a stripped cookie degrades to 'challenged again on the next
            // navigation' rather than an infinite redirect loop.
            const cleanUrl = stripChallengeParams(request.url);
            const grantSeparator = cleanUrl.includes('?') ? '&' : '?';
            const redirectTo = `${request.scheme}://${request.host}${cleanUrl}${grantSeparator}`
                + `cq_ok=${await issueGrant(sessionSecret, tokenRayId)}`;

            return {
                html: '',
                headers: {
                    'Location': redirectTo,
                    'Set-Cookie': `_cq_se=${sessionExpiresAt}.${cookieSignature}|${tokenRayId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
                },
            };
        }
        // Invalid/expired token → fall through and serve a fresh challenge
    }

    const expiresAt = Date.now() + (TOKEN_TTL_SECONDS * 1000);
    const rayId = rtiResponse.ids.rayId;
    const newToken = `${expiresAt}.${rayId}.${await sign(sessionSecret, `ct:${expiresAt}:${rayId}`)}`;
    const separator = stripChallengeParams(request.url).includes('?') ? '&' : '?';
    const tokenUrl = `${request.scheme}://${request.host}${stripChallengeParams(request.url)}${separator}cq_ct=${newToken}`;

    return {
        html: buildChallengeHtml(tokenUrl, rayId),
        headers: {
            'Content-Type': 'text/html;charset=UTF-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
    };
};

/**
 * Session validator wired into config.validateChallenge — returns true when the
 * request carries a valid, unexpired _cq_se cookie (RTI is then skipped).
 */
const buildValidate = (sessionSecret: string) => async (request: EWRequest): Promise<boolean> => {
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
};

/**
 * Builds the browser-interstitial challenge pair, bound to a signing secret.
 *
 * The secret is supplied by the caller (config.ts, from PMUSER_CHEQ_CHALLENGE_SECRET) rather
 * than read here, so exactly one place decides whether a challenge can be served at all.
 */
export function createCheqChallenge(sessionSecret: string) {
    return {
        challenge: buildChallenge(sessionSecret),
        validateChallenge: buildValidate(sessionSecret),
    };
}
