import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCheqChallenge } from './cheq-challenge';
import { RTIResponse } from '../../core/models/rti-response.model';

const AKAMAI_RESPOND_WITH_LIMIT = 2048;

// The providers are bound to a signing secret by config.ts, so bind one here too. Whether a
// challenge is served at all is config's decision and is tested in config.spec.ts.
const { challenge: cheqChallenge, validateChallenge: validateCheqChallenge } = createCheqChallenge('test-signing-secret');

// `secret: null` simulates PMUSER_CHEQ_CHALLENGE_SECRET being unset, which must disable
// challenges entirely rather than sign with an empty key.
function buildRequest(overrides: Partial<{
    url: string; scheme: string; host: string; path: string; clientIp: string; cookie: string;
    secret: string | null;
}> = {}): EWRequest {
    const cookie = overrides.cookie;
    const secret = overrides.secret === undefined ? 'test-signing-secret' : overrides.secret;
    return {
        url: overrides.url ?? '/page',
        scheme: overrides.scheme ?? 'https',
        host: overrides.host ?? 'akamai.cheqsandbox.com',
        path: overrides.path ?? '/page',
        clientIp: overrides.clientIp ?? '1.2.3.4',
        method: 'GET',
        getHeader: (name: string) => (name === 'Cookie' && cookie ? [cookie] : undefined),
        setHeader: () => undefined,
        removeHeader: () => undefined,
        getVariable: (name: string) => (name === 'PMUSER_CHEQ_CHALLENGE_SECRET' ? (secret ?? undefined) : undefined),
        setVariable: () => undefined,
        respondWith: () => undefined,
    } as unknown as EWRequest;
}

function buildRTIResponse(rayId = 'test-ray-id'): RTIResponse {
    return { ids: { rayId } } as RTIResponse;
}

function extractToken(html: string): string {
    const match = html.match(/cq_ct=([^"&\\]+)/);
    if (!match) throw new Error('no cq_ct token in challenge page');
    return match[1];
}

function extractGrant(location: string): string {
    const match = location.match(/cq_ok=([^&]+)/);
    if (!match) throw new Error('no cq_ok grant in redirect Location');
    return match[1];
}

describe('cheqChallenge', () => {
    it('serves the interstitial with rayId when no token present', async () => {
        const result = await cheqChallenge(buildRequest(), buildRTIResponse('ray-abc'));

        expect(result.headers['Content-Type']).toContain('text/html');
        expect(result.headers['Cache-Control']).toContain('no-store');
        expect(result.html).toContain('ray-abc');
        expect(result.html).toContain('Checking your browser');
        expect(result.html).toContain('cq_ct=');
    });

    it('interstitial stays under the 2048-byte Akamai respondWith limit', async () => {
        const longUrl = '/products/category/item?utm_source=newsletter&utm_medium=email&utm_campaign=spring_sale_2026&ref=abcdef';
        const result = await cheqChallenge(
            buildRequest({ url: longUrl, path: '/products/category/item' }),
            buildRTIResponse('f'.repeat(32)),
        );

        expect(Buffer.byteLength(result.html, 'utf8')).toBeLessThanOrEqual(AKAMAI_RESPOND_WITH_LIMIT);
    });

    it('valid token round-trip grants session cookie and redirects to clean URL', async () => {
        const rti = buildRTIResponse('ray-roundtrip');
        const serve = await cheqChallenge(buildRequest({ url: '/page?a=1' }), rti);
        const token = extractToken(serve.html);

        const verify = await cheqChallenge(buildRequest({ url: `/page?a=1&cq_ct=${token}` }), rti);

        expect(verify.headers['Location']).toContain('https://akamai.cheqsandbox.com/page?a=1');
        expect(verify.headers['Set-Cookie']).toContain('_cq_se=');
        expect(verify.headers['Set-Cookie']).toContain('HttpOnly');
        expect(verify.html).toBe('');
    });

    it('rejects a tampered token and serves a fresh challenge', async () => {
        const rti = buildRTIResponse();
        const serve = await cheqChallenge(buildRequest(), rti);
        const token = extractToken(serve.html);
        const tampered = token.replace(/.$/, c => (c === '0' ? '1' : '0'));

        const result = await cheqChallenge(buildRequest({ url: `/page?cq_ct=${tampered}` }), rti);

        expect(result.headers['Location']).toBeUndefined();
        expect(result.html).toContain('Checking your browser');
    });

    it('rejects an expired token and serves a fresh challenge', async () => {
        const rti = buildRTIResponse('ray-exp');
        // Forge structure with past expiry — signature check is irrelevant since expiry fails first
        const expired = `${Date.now() - 1000}.ray-exp.deadbeefdeadbeefdeadbeefdeadbeef`;

        const result = await cheqChallenge(buildRequest({ url: `/page?cq_ct=${expired}` }), rti);

        expect(result.headers['Location']).toBeUndefined();
        expect(result.html).toContain('Checking your browser');
    });
});

// Akamai strips Set-Cookie from respondWith() unless the property carries the
// <edgeservices:cookie.pass-set-cookie-policy> metadata tag. Without it the visitor lands back
// on a page that is still suspicious and the challenge repeats forever - an infinite spinner.
// The redirect therefore also carries a short signed grant, good for the landing request only,
// so that case degrades to 'challenged again next navigation' instead of a hang.
describe('one-hop grant (survives Set-Cookie being stripped)', () => {
    async function completeChallenge(url = '/page') {
        const rti = buildRTIResponse('ray-grant');
        const serve = await cheqChallenge(buildRequest({ url }), rti);
        const token = extractToken(serve.html);
        return cheqChallenge(buildRequest({ url: `${url}?cq_ct=${token}` }), rti);
    }

    it('redirects with a signed grant alongside the session cookie', async () => {
        const verify = await completeChallenge();

        expect(verify.headers['Location']).toContain('cq_ok=');
        expect(verify.headers['Set-Cookie']).toContain('_cq_se=');
    });

    it('lets the landing request through when no cookie came back', async () => {
        const verify = await completeChallenge();
        const grant = extractGrant(verify.headers['Location']);

        // No cookie at all - exactly what the browser sends when Akamai stripped Set-Cookie.
        expect(await validateCheqChallenge(buildRequest({ url: `/page?cq_ok=${grant}` }))).toBe(true);
    });

    it('rejects a tampered grant', async () => {
        const verify = await completeChallenge();
        const grant = extractGrant(verify.headers['Location']);
        const tampered = grant.replace('ray-grant', 'other-ray');

        expect(await validateCheqChallenge(buildRequest({ url: `/page?cq_ok=${tampered}` }))).toBe(false);
    });

    it('rejects an expired grant', async () => {
        const expired = `${Date.now() - 1000}.ray-grant.deadbeefdeadbeefdeadbeefdeadbeef`;

        expect(await validateCheqChallenge(buildRequest({ url: `/page?cq_ok=${expired}` }))).toBe(false);
    });

    it('does not accept a session cookie value replayed as a grant', async () => {
        // Cookie and grant are signed over different prefixes (se: vs og:), so one cannot
        // stand in for the other even though both are minted from the same secret and rayId.
        const rti = buildRTIResponse('ray-grant');
        const serve = await cheqChallenge(buildRequest(), rti);
        const token = extractToken(serve.html);
        const verify = await cheqChallenge(buildRequest({ url: `/page?cq_ct=${token}` }), rti);
        const cookieValue = verify.headers['Set-Cookie'].split(';')[0].substring('_cq_se='.length);
        const [tokenPart, rayId] = cookieValue.split('|');
        const [expiresAt, signature] = tokenPart.split('.');

        const replayed = `${expiresAt}.${rayId}.${signature}`;
        expect(await validateCheqChallenge(buildRequest({ url: `/page?cq_ok=${replayed}` }))).toBe(false);
    });
});

describe('validateCheqChallenge', () => {
    async function obtainSessionCookie(): Promise<string> {
        const rti = buildRTIResponse('ray-session');
        const serve = await cheqChallenge(buildRequest(), rti);
        const token = extractToken(serve.html);
        const verify = await cheqChallenge(buildRequest({ url: `/page?cq_ct=${token}` }), rti);
        const setCookie = verify.headers['Set-Cookie'];
        return setCookie.split(';')[0]; // "_cq_se=<value>"
    }

    it('accepts a freshly issued session cookie', async () => {
        const cookie = await obtainSessionCookie();
        expect(await validateCheqChallenge(buildRequest({ cookie }))).toBe(true);
    });

    it('rejects when cookie is absent', async () => {
        expect(await validateCheqChallenge(buildRequest())).toBe(false);
    });

    it('rejects a tampered session cookie', async () => {
        const cookie = await obtainSessionCookie();
        const tampered = cookie.replace('|ray-session', '|other-ray');
        expect(await validateCheqChallenge(buildRequest({ cookie: tampered }))).toBe(false);
    });

    it('rejects an expired session cookie', async () => {
        const expired = `_cq_se=${Date.now() - 1000}.deadbeefdeadbeefdeadbeefdeadbeef|ray-x`;
        expect(await validateCheqChallenge(buildRequest({ cookie: expired }))).toBe(false);
    });

    // The cookie is `<expiresAt>.<signature>|<rayId>`. rayId hangs off a `|` rather than a third
    // dot precisely so a rayId containing dots cannot shift where the signature sits - but that
    // only holds if a cookie missing either separator is refused outright rather than destructured
    // into undefined holes and carried into the signature check.
    it.each([
        ['no | separator',            '_cq_se=1700000000.abcdef'],
        ['an empty rayId after |',    '_cq_se=1700000000.abcdef|'],
        ['an empty token before |',   '_cq_se=|ray-x'],
        ['a token that has no dot',   '_cq_se=notadottedtoken|ray-x'],
        ['an empty signature',        '_cq_se=1700000000.|ray-x'],
        ['an empty expiresAt',        '_cq_se=.abcdef|ray-x'],
    ])('rejects a session cookie with %s', async (_label, cookie) => {
        expect(await validateCheqChallenge(buildRequest({ cookie }))).toBe(false);
    });

    it('rejects a non-numeric expiresAt rather than treating NaN as still valid', async () => {
        const cookie = '_cq_se=notanumber.abcdef0123456789abcdef0123456789|ray-x';
        expect(await validateCheqChallenge(buildRequest({ cookie }))).toBe(false);
    });
});

describe('challenge signing is keyed', () => {
    // Whether a challenge is served at all is decided once in config.ts (tested there). What
    // matters here is that the signature genuinely depends on the secret: a cookie minted under
    // one secret must not validate under another, or the _cq_se cookie - which authorises
    // skipping RTI entirely - would be forgeable.
    async function mintCookie(secret: string, rayId: string): Promise<string> {
        const { challenge } = createCheqChallenge(secret);
        const issued = await challenge(buildRequest(), buildRTIResponse(rayId));
        const token = extractToken(issued.html);
        const granted = await challenge(buildRequest({ url: `/page?cq_ct=${token}` }), buildRTIResponse(rayId));
        return granted.headers['Set-Cookie'].split(';')[0];
    }

    it('accepts a cookie under the secret it was minted with', async () => {
        const cookie = await mintCookie('secret-A', 'ray-1');
        const { validateChallenge } = createCheqChallenge('secret-A');
        expect(await validateChallenge(buildRequest({ cookie }))).toBe(true);
    });

    it('rejects a cookie minted under a different secret', async () => {
        const cookie = await mintCookie('secret-A', 'ray-2');
        const { validateChallenge } = createCheqChallenge('secret-B');
        expect(await validateChallenge(buildRequest({ cookie }))).toBe(false);
    });

    it('rejects a challenge token minted under a different secret', async () => {
        const { challenge: challengeA } = createCheqChallenge('secret-A');
        const issued = await challengeA(buildRequest(), buildRTIResponse('ray-3'));
        const token = extractToken(issued.html);

        // Same token replayed against a property using a different secret: no session granted,
        // so a fresh interstitial is served instead of a redirect.
        const { challenge: challengeB } = createCheqChallenge('secret-B');
        const replay = await challengeB(buildRequest({ url: `/page?cq_ct=${token}` }), buildRTIResponse('ray-3'));
        expect(replay.headers['Set-Cookie']).toBeUndefined();
        expect(replay.html).toContain('Checking your browser');
    });
});

describe('validateCheqChallenge defensive catch', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    // The cookie parsing above this already rejects malformed input explicitly, so the catch is
    // only reachable if the crypto call itself throws. Assert it degrades to false rather than
    // propagating - an exception here would bubble into onClientRequest's outer catch and be
    // indistinguishable from an RTI failure.
    it('returns false instead of throwing when crypto.subtle.digest fails', async () => {
        vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('crypto unavailable') as never);
        const { validateChallenge } = createCheqChallenge('secret-A');
        const future = Date.now() + 60_000;

        await expect(validateChallenge(buildRequest({ cookie: `_cq_se=${future}.abcdef|ray-1` }))).resolves.toBe(false);
    });
});
