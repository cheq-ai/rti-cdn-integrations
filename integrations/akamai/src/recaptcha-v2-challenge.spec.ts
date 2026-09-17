import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    httpRequest: vi.fn(),
}));

vi.mock('http-request', () => ({
    httpRequest: mocks.httpRequest,
}));

import {
    createRecaptchaChallenge,
    createRecaptchaSessionValidator,
    RECAPTCHA_V2_TEST_SITE_KEY,
} from './recaptcha-v2-challenge';
import { RTIResponse } from '../../core/models/rti-response.model';

const AKAMAI_RESPOND_WITH_LIMIT = 2048;

// A real Google reCAPTCHA site key is 40 characters. A short placeholder would let the
// byte-limit tests pass on a page that overflows in production - the v3 page embeds the
// site key TWICE (api.js?render= and grecaptcha.execute), so each character costs 2 bytes.
const REALISTIC_SITE_KEY = '6LdyC2cUAAAAACS1_bECdcYvZ2n1nGYDfOtcSRk9';

// RTI rayIds are UUID-length; the pages embed one and the limit must hold for it.
const REALISTIC_RAY_ID = 'f'.repeat(36);

// A long-but-ordinary e-commerce URL. The page embeds the full URL twice (form action and
// the url-encoded round-trip field), so URL length is the main thing that pushes it over.
const LONG_URL = {
    host: 'very-long-store-hostname.example.co.uk',
    path: '/en-gb/collections/seasonal/products/category/item-1234-extra',
    url: '/en-gb/collections/seasonal/products/category/item-1234-extra?utm_source=newsletter&utm_campaign=spring_sale&utm_content=variant_b',
};

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

// `secret` is Google's siteverify key; `sessionSecret` signs the _cq_se cookie. Both are
// supplied by config.ts in production - see resolveChallengeCallbacks.
const v2 = createRecaptchaChallenge({
    version: 'v2',
    siteKey: RECAPTCHA_V2_TEST_SITE_KEY,
    secret: 'test-secret',
    sessionSecret: 'test-signing-secret',
    verifyHost: 'akamai.cheqsandbox.com',
});

const validateRecaptchaSession = createRecaptchaSessionValidator('test-signing-secret');

const v3 = createRecaptchaChallenge({
    version: 'v3',
    siteKey: REALISTIC_SITE_KEY,
    secret: 'v3-secret',
    sessionSecret: 'test-signing-secret',
    verifyHost: 'akamai.cheqsandbox.com',
    scoreThreshold: 0.5,
});

describe('reCAPTCHA v2 (checkbox)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('serves the checkbox page when no token is present', async () => {
        const result = await v2(buildRequest(), buildRTIResponse('ray-abc'));

        expect(result.headers['Content-Type']).toContain('text/html');
        expect(result.html).toContain('g-recaptcha');
        expect(result.html).toContain(RECAPTCHA_V2_TEST_SITE_KEY);
        expect(result.html).toContain('reCAPTCHA v2');
        expect(result.html).not.toContain('grecaptcha.execute');
    });

    it('v2 page stays under the 2048-byte Akamai respondWith limit', async () => {
        const result = await v2(
            buildRequest({
                host: 'www.customer-store.com',
                url: '/en-gb/products/category/item-1234?utm_source=newsletter&utm_campaign=spring_sale',
                path: '/en-gb/products/category/item-1234',
            }),
            buildRTIResponse(REALISTIC_RAY_ID),
        );
        expect(Buffer.byteLength(result.html, 'utf8')).toBeLessThanOrEqual(AKAMAI_RESPOND_WITH_LIMIT);
    });

    it('v2 page stays under the limit for a long store URL', async () => {
        const result = await v2(buildRequest(LONG_URL), buildRTIResponse(REALISTIC_RAY_ID));
        expect(Buffer.byteLength(result.html, 'utf8')).toBeLessThanOrEqual(AKAMAI_RESPOND_WITH_LIMIT);
    });

    // Query-string padding is an attacker-controlled way to overflow the 2048-byte body on a
    // REAL page url. respondWith would throw, main.ts's CAPTCHA case catches it and falls
    // through to ALLOW - so an oversized page is a silent bypass of the challenge.
    it('v2 page stays under the limit when the query string is enormous', async () => {
        const result = await v2(
            buildRequest({ path: '/checkout', url: '/checkout?pad=' + 'a'.repeat(3000) }),
            buildRTIResponse(REALISTIC_RAY_ID),
        );
        expect(Buffer.byteLength(result.html, 'utf8')).toBeLessThanOrEqual(AKAMAI_RESPOND_WITH_LIMIT);
    });

    // Last degradation step. A path this long cannot address a real resource, so the page is
    // allowed to exceed the limit here - what matters is that the round-trip field is dropped
    // rather than the URL being embedded twice at full length.
    it('drops the round-trip URL entirely when even the path alone would overflow', async () => {
        const longPath = '/' + 'p'.repeat(700);
        const result = await v2(
            buildRequest({ path: longPath, url: longPath + '?pad=' + 'a'.repeat(3000) }),
            buildRTIResponse(REALISTIC_RAY_ID),
        );
        expect(result.html).toContain('name="original_url" value=""');
    });

    it('verifies token and sets session cookie on success', async () => {
        mocks.httpRequest.mockResolvedValue({
            json: async () => ({ success: true }),
        });

        const result = await v2(
            buildRequest({
                url: '/page?g-recaptcha-response=tok&original_url=' + encodeURIComponent('https://akamai.cheqsandbox.com/page'),
            }),
            buildRTIResponse('ray-ok'),
        );

        expect(mocks.httpRequest).toHaveBeenCalledWith(
            '/recaptcha/api/siteverify',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Host: 'akamai.cheqsandbox.com' }),
            }),
        );

        // The verify sub-request has to match what the platform actually accepts. The working
        // /defend/ call sets neither an object-built body nor Content-Length; this one did both,
        // and on the live edge challenge() threw before ever reaching httpRequest - which
        // main.ts's CAPTCHA catch turns into ALLOW. Appending ?g-recaptcha-response=anything
        // then bypassed the challenge outright.
        const [, opts] = mocks.httpRequest.mock.calls[0];
        expect(opts.body).toBe('secret=test-secret&response=tok&remoteip=1.2.3.4');
        expect(Object.keys(opts.headers)).not.toContain('Content-Length');
        expect(result.headers['Location']).toContain('https://akamai.cheqsandbox.com/page');
        expect(result.headers['Set-Cookie']).toContain('_cq_se=');
    });

    it('returns failure text when Google rejects the token', async () => {
        mocks.httpRequest.mockResolvedValue({
            json: async () => ({ success: false }),
        });

        const result = await v2(
            buildRequest({ url: '/page?g-recaptcha-response=bad' }),
            buildRTIResponse(),
        );

        expect(result.headers['Location']).toBeUndefined();
        expect(result.html).toContain('Verification failed');
    });
});

describe('reCAPTCHA v3 (invisible score)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('serves an auto-execute page with no checkbox', async () => {
        const result = await v3(buildRequest(), buildRTIResponse('ray-v3'));

        expect(result.html).toContain('grecaptcha.execute');
        expect(result.html).toContain(REALISTIC_SITE_KEY);
        expect(result.html).toContain('reCAPTCHA v3');
        expect(result.html).not.toContain('class="g-recaptcha"');
        expect(result.html).toContain('Checking your browser');
    });

    it('v3 page stays under the 2048-byte Akamai respondWith limit', async () => {
        const result = await v3(
            buildRequest({
                host: 'www.customer-store.com',
                url: '/en-gb/products/category/item-1234?utm_source=newsletter&utm_campaign=spring_sale',
                path: '/en-gb/products/category/item-1234',
            }),
            buildRTIResponse(REALISTIC_RAY_ID),
        );
        expect(Buffer.byteLength(result.html, 'utf8')).toBeLessThanOrEqual(AKAMAI_RESPOND_WITH_LIMIT);
    });

    it('v3 page stays under the limit for a long store URL', async () => {
        const result = await v3(buildRequest(LONG_URL), buildRTIResponse(REALISTIC_RAY_ID));
        expect(Buffer.byteLength(result.html, 'utf8')).toBeLessThanOrEqual(AKAMAI_RESPOND_WITH_LIMIT);
    });

    it('v3 page stays under the limit when the query string is enormous', async () => {
        const result = await v3(
            buildRequest({ path: '/checkout', url: '/checkout?pad=' + 'a'.repeat(3000) }),
            buildRTIResponse(REALISTIC_RAY_ID),
        );
        expect(Buffer.byteLength(result.html, 'utf8')).toBeLessThanOrEqual(AKAMAI_RESPOND_WITH_LIMIT);
    });

    it('passes when score meets threshold', async () => {
        mocks.httpRequest.mockResolvedValue({
            json: async () => ({ success: true, score: 0.9, action: 'cheq_challenge' }),
        });

        const result = await v3(
            buildRequest({
                url: '/page?g-recaptcha-response=tok&original_url=' + encodeURIComponent('https://akamai.cheqsandbox.com/page'),
            }),
            buildRTIResponse('ray-ok'),
        );

        expect(result.headers['Location']).toContain('https://akamai.cheqsandbox.com/page');
        expect(result.headers['Set-Cookie']).toContain('_cq_se=');
    });

    // Google documents `score` as always present on a v3 success, but a missing or non-numeric
    // one must read as 0.0 (bot), never as "no score so let them through". Treating absent as
    // passing would turn any malformed Google reply into a full CAPTCHA bypass.
    it('treats a v3 success with no score as 0 and fails it', async () => {
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true }) });

        const result = await v3(
            buildRequest({ url: '/page?g-recaptcha-response=tok' }),
            buildRTIResponse(),
        );

        expect(result.headers['Location']).toBeUndefined();
        expect(result.html).toContain('Verification failed');
    });

    it('fails when score is below threshold', async () => {
        mocks.httpRequest.mockResolvedValue({
            json: async () => ({ success: true, score: 0.1, action: 'cheq_challenge' }),
        });

        const result = await v3(
            buildRequest({ url: '/page?g-recaptcha-response=tok' }),
            buildRTIResponse(),
        );

        expect(result.headers['Location']).toBeUndefined();
        expect(result.html).toContain('Verification failed');
    });
});

// Same failure as the browser provider: Akamai strips Set-Cookie from respondWith() unless the
// property carries the <edgeservices:cookie.pass-set-cookie-policy> tag, so the visitor lands
// back on a page that is still suspicious and is asked to tick the box again, forever. The
// redirect carries a short signed grant so that degrades to one extra challenge, not a dead end.
// `original_url` is a query parameter, so any link can carry any value. Reflected into Location
// verbatim it makes a passed CAPTCHA an open redirect - a strong phishing primitive, because the
// victim genuinely did just prove they are human on the real site.
// grecaptcha can resolve with an EMPTY token - rate limiting, a transient failure reaching
// Google. The page still submits, so the request arrives with `g-recaptcha-response=`. Treating
// that as "no token yet" serves a fresh challenge, and the v3 page submits ITSELF, so the visitor
// is stuck in an infinite reload. v2 cannot loop this way because a human has to click.
describe('empty token does not restart the challenge', () => {
    async function submitEmpty(challenge: ReturnType<typeof createRecaptchaChallenge>) {
        return challenge(
            buildRequest({ url: '/page?g-recaptcha-response=&original_url=%2Fpage' }),
            buildRTIResponse('ray-empty'),
        );
    }

    it('v3 reports failure instead of serving another self-submitting page', async () => {
        const result = await submitEmpty(v3);

        expect(result.html).not.toContain('grecaptcha.execute');
        expect(result.html).toContain('Verification failed');
        expect(result.headers['Location']).toBeUndefined();
    });

    it('v2 reports failure instead of serving another checkbox', async () => {
        const result = await submitEmpty(v2);

        expect(result.html).not.toContain('g-recaptcha');
        expect(result.html).toContain('Verification failed');
    });

    it('does not call Google for an empty token', async () => {
        mocks.httpRequest.mockClear();
        await submitEmpty(v3);

        expect(mocks.httpRequest).not.toHaveBeenCalled();
    });

    it('a genuinely absent parameter still serves the challenge', async () => {
        // The first visit has no parameter at all - that must still get a challenge page.
        const result = await v3(buildRequest({ url: '/page' }), buildRTIResponse('ray-first'));

        expect(result.html).toContain('grecaptcha.execute');
    });
});

describe('return-URL safety', () => {
    async function passWith(originalUrl: string) {
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true }) });
        return v2(
            buildRequest({ url: '/page?g-recaptcha-response=tok&original_url=' + encodeURIComponent(originalUrl) }),
            buildRTIResponse('ray-ok'),
        );
    }

    it.each([
        ['an absolute URL', 'https://evil.example.com/steal'],
        ['a protocol-relative URL', '//evil.example.com/steal'],
        ['a backslash-prefixed URL', String.raw`/\evil.example.com/steal`],
        ['a scheme-only payload', 'javascript:alert(1)'],
    ])('refuses %s and stays on this host', async (_label, hostile) => {
        const location = (await passWith(hostile)).headers['Location'];

        expect(location.startsWith('https://akamai.cheqsandbox.com/')).toBe(true);
        expect(location).not.toContain('evil.example.com');
        expect(location).not.toContain('javascript:');
    });

    // original_url is optional - the byte-cap ladder drops it entirely on a long URL (render('')),
    // so a passed challenge with no return path at all is a shape we actually emit, not a
    // hypothetical. It has to resolve to the current path rather than an empty Location.
    it.each([
        ['absent',  '/page?g-recaptcha-response=tok'],
        ['empty',   '/page?g-recaptcha-response=tok&original_url='],
    ])('falls back to the current path when original_url is %s', async (_label, url) => {
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true }) });

        const result = await v2(buildRequest({ url }), buildRTIResponse('ray-ok'));

        expect(result.headers['Location']).toContain('https://akamai.cheqsandbox.com/page?cq_ok=');
    });

    // decodeURIComponent throws a URIError on a stray percent sign, and original_url comes
    // straight off the query string, so any link can trigger it. Throwing here would be caught by
    // main.ts's CAPTCHA case, which falls through to ALLOW - a malformed return URL would let the
    // visitor past the challenge entirely. It has to degrade to the current path instead.
    it('falls back to the current path when original_url has malformed percent-encoding', async () => {
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true }) });

        const result = await v2(
            buildRequest({ url: '/page?g-recaptcha-response=tok&original_url=%ZZ' }),
            buildRTIResponse('ray-ok'),
        );

        expect(result.headers['Location']).toContain('https://akamai.cheqsandbox.com/page');
        expect(result.headers['Location']).not.toContain('%ZZ');
        expect(result.headers['Location']).toContain('cq_ok=');
    });

    it('keeps a same-origin path with its query string', async () => {
        const location = (await passWith('/checkout?step=2')).headers['Location'];

        expect(location).toContain('https://akamai.cheqsandbox.com/checkout?step=2');
    });
});

describe('one-hop grant (survives Set-Cookie being stripped)', () => {
    async function passCaptcha() {
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true }) });
        return v2(
            buildRequest({ url: '/page?g-recaptcha-response=tok&original_url=' + encodeURIComponent('/page') }),
            buildRTIResponse('ray-ok'),
        );
    }

    function extractGrant(location: string): string {
        const match = location.match(/cq_ok=([^&]+)/);
        if (!match) throw new Error('no cq_ok grant in redirect Location');
        return match[1];
    }

    it('redirects with a signed grant alongside the session cookie', async () => {
        const result = await passCaptcha();

        expect(result.headers['Location']).toContain('cq_ok=');
        expect(result.headers['Set-Cookie']).toContain('_cq_se=');
    });

    it('lets the landing request through when no cookie came back', async () => {
        const grant = extractGrant((await passCaptcha()).headers['Location']);

        expect(await validateRecaptchaSession(buildRequest({ url: `/page?cq_ok=${grant}` }))).toBe(true);
    });

    it('rejects a tampered grant', async () => {
        const grant = extractGrant((await passCaptcha()).headers['Location']);
        const tampered = grant.replace('ray-ok', 'other-ray');

        expect(await validateRecaptchaSession(buildRequest({ url: `/page?cq_ok=${tampered}` }))).toBe(false);
    });

    it('rejects an expired grant', async () => {
        const expired = `${Date.now() - 1000}.ray-ok.deadbeefdeadbeefdeadbeefdeadbeef`;

        expect(await validateRecaptchaSession(buildRequest({ url: `/page?cq_ok=${expired}` }))).toBe(false);
    });
});

/**
 * Regression cover for the v3 reload loop captured on akamai.cheqsandbox.com.
 *
 * With `Set-Cookie` stripped by the property, the 10-second `cq_ok` grant is the only thing
 * carrying a passed challenge. Once it lapses the visitor is re-challenged on a URL that STILL
 * CARRIES that dead grant - and the dead grant was being copied into `original_url`, then
 * re-appended alongside a fresh one. `hasValidGrant` reads the first `cq_ok`, which is the dead
 * one, so the visitor was challenged again and the URL grew by one grant per pass. It only
 * stopped when the round-trip URL pushed the page past the 2048-byte cap and the degradation
 * ladder threw the query string away - an accidental circuit breaker, not a designed one.
 */
describe('a stale grant does not accumulate in the round-trip URL', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const STALE = `${Date.now() - 60000}.ray-old.deadbeefdeadbeefdeadbeefdeadbeef`;

    function countGrants(location: string): number {
        return (location.match(/[?&]cq_ok=/g) ?? []).length;
    }

    // Hop #101 of the capture: re-challenged on `/?cq_ok=<expired>`. Echoing that grant into the
    // form's round-trip field is what feeds the next redirect.
    it('the v3 challenge page does not echo an expired grant into its round-trip URL', async () => {
        const result = await v3(buildRequest({ url: `/?cq_ok=${STALE}`, path: '/' }), buildRTIResponse());

        expect(result.html).not.toContain('cq_ok');
    });

    it('the v2 challenge page does not echo an expired grant into its round-trip URL', async () => {
        const result = await v2(buildRequest({ url: `/?cq_ok=${STALE}`, path: '/' }), buildRTIResponse());

        expect(result.html).not.toContain('cq_ok');
    });

    // Hop #114: a PASSED challenge emitted `?cq_ok=<dead>&cq_ok=<fresh>`. Two grants is the loop.
    it('the v3 redirect carries exactly one grant when original_url holds a stale one', async () => {
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true, score: 0.9 }) });

        const result = await v3(
            buildRequest({
                url: `/?g-recaptcha-response=tok&original_url=${encodeURIComponent(`/?cq_ok=${STALE}`)}`,
                path: '/',
            }),
            buildRTIResponse('ray-new'),
        );

        expect(countGrants(result.headers['Location'])).toBe(1);
        expect(result.headers['Location']).not.toContain(STALE);
    });

    // Same module serves v2, so the defect is shared even though a human clicking Continue sees
    // it as "the checkbox keeps coming back" rather than a runaway reload.
    it('the v2 redirect carries exactly one grant when original_url holds a stale one', async () => {
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true }) });

        const result = await v2(
            buildRequest({
                url: `/?g-recaptcha-response=tok&original_url=${encodeURIComponent(`/?cq_ok=${STALE}`)}`,
                path: '/',
            }),
            buildRTIResponse('ray-new'),
        );

        expect(countGrants(result.headers['Location'])).toBe(1);
        expect(result.headers['Location']).not.toContain(STALE);
    });

    // Without this the loop would just move one hop later.
    it('the surviving grant validates on the landing request', async () => {
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true, score: 0.9 }) });

        const result = await v3(
            buildRequest({
                url: `/?g-recaptcha-response=tok&original_url=${encodeURIComponent(`/?cq_ok=${STALE}`)}`,
                path: '/',
            }),
            buildRTIResponse('ray-new'),
        );
        const landing = result.headers['Location'].replace('https://akamai.cheqsandbox.com', '');

        expect(await validateRecaptchaSession(buildRequest({ url: landing }))).toBe(true);
    });

    // Guards the signed-off v2 surface: stripping `cq_ok` must not disturb anything else in a
    // query string. A visitor's own parameters have to survive the challenge round trip.
    it('leaves a query string carrying no grant untouched', async () => {
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true }) });

        const result = await v2(
            buildRequest({
                url: `/page?g-recaptcha-response=tok&original_url=${encodeURIComponent('/page?utm_source=newsletter&ref=abc')}`,
            }),
            buildRTIResponse('ray-new'),
        );

        expect(result.headers['Location']).toContain('/page?utm_source=newsletter&ref=abc&cq_ok=');
        expect(countGrants(result.headers['Location'])).toBe(1);
    });
});

describe('validateRecaptchaSession', () => {
    it('accepts a cookie issued by a successful challenge', async () => {
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true }) });
        const verify = await v2(
            buildRequest({ url: '/page?g-recaptcha-response=tok&original_url=%2Fpage' }),
            buildRTIResponse('ray-session'),
        );
        const cookie = verify.headers['Set-Cookie'].split(';')[0];

        expect(await validateRecaptchaSession(buildRequest({ cookie }))).toBe(true);
    });

    // Same shape as the _cq_se cookie in cheq-challenge.ts, and the same reasoning: rayId hangs
    // off a `|` so dots in it cannot shift the signature's position, which only holds if a cookie
    // missing either separator is refused rather than destructured into undefined holes.
    it.each([
        ['no | separator',          '_cq_se=1700000000.abcdef'],
        ['an empty rayId after |',  '_cq_se=1700000000.abcdef|'],
        ['an empty token before |', '_cq_se=|ray-x'],
        ['a token that has no dot', '_cq_se=notadottedtoken|ray-x'],
        ['an empty signature',      '_cq_se=1700000000.|ray-x'],
        ['an empty expiresAt',      '_cq_se=.abcdef|ray-x'],
        ['a non-numeric expiresAt', '_cq_se=notanumber.abcdef|ray-x'],
    ])('rejects a session cookie with %s', async (_label, cookie) => {
        expect(await validateRecaptchaSession(buildRequest({ cookie }))).toBe(false);
    });

    it('rejects missing or tampered cookies', async () => {
        expect(await validateRecaptchaSession(buildRequest())).toBe(false);
        expect(await validateRecaptchaSession(buildRequest({ cookie: '_cq_se=1.abc|ray' }))).toBe(false);
    });
});

describe('validateRecaptchaSession defensive catch', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('returns false instead of throwing when crypto.subtle.digest fails', async () => {
        vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('crypto unavailable') as never);
        const future = Date.now() + 60_000;

        await expect(validateRecaptchaSession(buildRequest({ cookie: `_cq_se=${future}.abcdef|ray-1` }))).resolves.toBe(false);
    });
});

describe('session validation is keyed', () => {
    // Whether a challenge is served at all is config.ts's decision (tested there). Here: a
    // cookie is only honoured by a validator bound to the same secret.
    it('rejects a cookie validated under a different secret', async () => {
        const other = createRecaptchaSessionValidator('a-different-secret');
        const expiresAt = Date.now() + 60_000;
        // Signature is deliberately arbitrary - the point is that neither validator accepts it.
        const cookie = `_cq_se=${expiresAt}.deadbeefdeadbeefdeadbeefdeadbeef|ray-1`;
        expect(await validateRecaptchaSession(buildRequest({ cookie }))).toBe(false);
        expect(await other(buildRequest({ cookie }))).toBe(false);
    });
});
