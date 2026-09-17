import { crypto } from 'crypto';
import URLSearchParams from 'url-search-params';
import { TextEncoder } from 'encoding';

// cspell:ignore PMUSER CHEQ
/**
 * Shared signing for challenge tokens and the `_cq_se` session cookie.
 *
 * The secret is read per request from the PMUSER_CHEQ_CHALLENGE_SECRET property variable, set
 * per property in the Akamai Control Center - deliberately NOT baked into the bundle. A bundled
 * literal is identical on every deployment and readable by anyone with the repo or the .tgz,
 * and this signature is what authorises skipping RTI entirely: forge it and you bypass bot
 * detection. Rotate by changing the property variable; no rebuild needed.
 *
 * Not to be confused with PMUSER_CHEQ_RECAPTCHA_SECRET, which is Google's server-side key for
 * the siteverify call.
 */

/**
 * Returns the configured challenge signing secret, or undefined when it is absent or still a
 * placeholder. Callers MUST treat undefined as "do not issue or accept challenges" - signing
 * with a known or empty key is worse than not challenging at all.
 */
export function readChallengeSecret(request: EWRequest): string | undefined {
    const secret = request.getVariable('PMUSER_CHEQ_CHALLENGE_SECRET');
    if (!secret) {
        return undefined;
    }
    const trimmed = secret.trim();
    return trimmed && trimmed !== 'REPLACE_ME' ? trimmed : undefined;
}

/**
 * Keyed SHA-256 over `${secret}:${data}`, truncated to the first 16 bytes (32 hex chars,
 * 128 bits). Enough to make forgery infeasible for a short-lived session token while keeping
 * the cookie compact.
 */
export async function sign(secret: string, data: string): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${secret}:${data}`));
    return Array.from(new Uint8Array(hashBuffer))
        .slice(0, 16)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Lifetime of the one-hop `cq_ok` grant. It only has to survive the redirect that carries it, and
 * it rides in the URL - where it leaks through Referer, logs and shared links - so it is
 * deliberately far shorter-lived than the session cookie it backs up.
 */
const GRANT_TTL_SECONDS = 10;

/**
 * Mints the grant a completed challenge appends to its redirect.
 *
 * Akamai denies `Set-Cookie` on `respondWith()` unless the property carries the
 * `<edgeservices:cookie.pass-set-cookie-policy>` metadata tag, and drops it SILENTLY when it does
 * not. The visitor then lands on a page that is still suspicious, is challenged again, and loops
 * forever. This grant clears that one landing request, so a missing tag degrades to "challenged
 * again on the next navigation" rather than a trapped browser.
 */
export async function issueGrant(secret: string, rayId: string): Promise<string> {
    const expiresAt = Date.now() + (GRANT_TTL_SECONDS * 1000);
    return `${expiresAt}.${rayId}.${await sign(secret, `og:${expiresAt}:${rayId}`)}`;
}

/**
 * Verifies a `cq_ok` grant taken from the request URL. Signed under `og:` and never the cookie's
 * `se:`, so neither can be replayed as the other even though both come from the same secret.
 */
export async function hasValidGrant(secret: string, request: EWRequest): Promise<boolean> {
    const queryString = request.url.includes('?') ? request.url.split('?')[1] : '';
    const grant = new URLSearchParams(queryString).get('cq_ok');
    if (!grant) return false;

    const [expiresAtStr, rayId, signature] = grant.split('.');
    if (!expiresAtStr || !rayId || !signature) return false;

    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt) || Date.now() > expiresAt) return false;

    return signature === await sign(secret, `og:${expiresAt}:${rayId}`);
}
