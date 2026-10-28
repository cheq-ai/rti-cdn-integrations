// cspell:ignore cheq
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createTurnstileChallenge, TurnstileSettings } from './turnstile-challenge-example';
import type { CloudFrontRequest } from 'aws-lambda/common/cloudfront';
import type { RTIResponse } from '../../core/models/rti-response.model';

// Pass-through spy on timingSafeEqual, so a test can check the signature compare is constant-time.
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const testSettings: TurnstileSettings = {
    siteKey: 'test-site-key',
    secretKey: 'test-turnstile-secret',
    sessionSigningSecret: 'test-session-signing-secret',
    sessionTtlSeconds: 300,
};

type Callbacks = Required<ReturnType<typeof createTurnstileChallenge>>;
const build = (settings: TurnstileSettings) => createTurnstileChallenge(settings) as Callbacks;
const { challenge, validateChallenge, isChallengeResponse } = build(testSettings);

function buildRequest(cookieValue?: string, rayIdHeader?: string, challengeHeader?: string): CloudFrontRequest {
    const headers: Record<string, { key: string; value: string }[]> = {};
    if (cookieValue !== undefined) {
        headers['cookie'] = [{ key: 'Cookie', value: cookieValue }];
    }
    if (rayIdHeader !== undefined) {
        headers['x-cheq-ray-id'] = [{ key: 'x-cheq-ray-id', value: rayIdHeader }];
    }
    if (challengeHeader !== undefined) {
        headers['x-cheq-challenge'] = [{ key: 'x-cheq-challenge', value: challengeHeader }];
    }
    return {
        clientIp: '1.2.3.4',
        method: 'GET',
        uri: '/page',
        querystring: '',
        headers,
    } as unknown as CloudFrontRequest;
}

function buildTurnstileRequest(querystring = '', hostHeader?: string, cookie?: string): CloudFrontRequest {
    const headers: Record<string, { key: string; value: string }[]> = {};
    if (hostHeader) {
        headers['host'] = [{ key: 'Host', value: hostHeader }];
    }
    if (cookie) {
        headers['cookie'] = [{ key: 'Cookie', value: cookie }];
    }
    return {
        clientIp: '1.2.3.4',
        method: 'GET',
        uri: '/page',
        querystring,
        headers,
    } as unknown as CloudFrontRequest;
}

function buildRTIResponse(rayId = 'ray-123'): RTIResponse {
    return {
        ids: { rayId, pageViewId: null, duid: null, uniqueVisitId: null },
        decision: { verdict: 'suspicious' },
        classification: { code: 0 },
        cheqDetection: { reasons: [] },
        metadata: { version: '1.0' },
    } as unknown as RTIResponse;
}

const solvedQuery = new URLSearchParams({ 'cf-turnstile-response': 'valid-token' }).toString();

const stubSiteverify = (success: boolean) => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ success }) });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
};

/**
 * Solves the challenge (siteverify stubbed to succeed) and returns the session cookie it issues, so the
 * validate tests use a real signature without reaching into the signing code.
 * @param now Date.now() while the cookie is issued (e.g. in the past to get an expired session)
 */
async function issueSession(rayId: string, settings = testSettings, now?: number, requestCookie?: string): Promise<{ cookie: string; token: string; expiresAt: number; signature: string }> {
    stubSiteverify(true);
    const nowSpy = now !== undefined ? vi.spyOn(Date, 'now').mockReturnValue(now) : undefined;
    const result = await build(settings).challenge(buildTurnstileRequest(solvedQuery, undefined, requestCookie), buildRTIResponse(rayId)) as any;
    nowSpy?.mockRestore();
    vi.unstubAllGlobals();
    const cookie: string = result.headers['set-cookie'][0].value.split(';')[0]; // `_cq_se=<token>|<rayId>`
    const token = cookie.slice('_cq_se='.length).split('|')[0];
    const [expiresAt, signature] = token.split('.');
    return { cookie, token, expiresAt: Number(expiresAt), signature };
}

describe('createTurnstileChallenge', () => {
    it('returns exactly challenge, validateChallenge and isChallengeResponse when all settings are set, without warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = createTurnstileChallenge(testSettings);
        expect(Object.keys(result).sort()).toEqual(['challenge', 'isChallengeResponse', 'validateChallenge']);
        expect(result.challenge).toBeTypeOf('function');
        expect(result.validateChallenge).toBeTypeOf('function');
        expect(result.isChallengeResponse).toBeTypeOf('function');
        expect(warn).not.toHaveBeenCalled();
    });

    it.each([
        ['siteKey', 'REPLACE_ME'],
        ['secretKey', 'REPLACE_ME'],
        ['sessionSigningSecret', 'REPLACE_ME'],
        ['sessionSigningSecret', ' REPLACE_ME '],
        ['sessionSigningSecret', ''],
        ['secretKey', '   '],
    ])('returns {} and warns once when %s is %j', (field, value) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = createTurnstileChallenge({ ...testSettings, [field]: value });
        expect(result).toEqual({});
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(field));
    });
});

describe('createTurnstileChallenge sessionTtlSeconds', () => {
    it.each([0, -5, 1.5, NaN, Infinity, '300' as unknown as number, undefined as unknown as number])(
        'warns and uses the default 300 s when sessionTtlSeconds is %j', async (ttl) => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const callbacks = createTurnstileChallenge({ ...testSettings, sessionTtlSeconds: ttl });
            expect(warn).toHaveBeenCalledOnce();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('sessionTtlSeconds'));

            stubSiteverify(true);
            const result = await callbacks.challenge!(buildTurnstileRequest(solvedQuery), buildRTIResponse()) as any;
            expect(result.headers['set-cookie'][0].value).toContain('Max-Age=300');
        });

    it('keeps a valid sessionTtlSeconds without warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const callbacks = createTurnstileChallenge({ ...testSettings, sessionTtlSeconds: 60 });
        expect(warn).not.toHaveBeenCalled();

        stubSiteverify(true);
        const result = await callbacks.challenge!(buildTurnstileRequest(solvedQuery), buildRTIResponse()) as any;
        expect(result.headers['set-cookie'][0].value).toContain('Max-Age=60');
    });

    it('still disables the CAPTCHA (one warning) when a secret is missing, whatever the TTL', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(createTurnstileChallenge({ ...testSettings, secretKey: 'REPLACE_ME', sessionTtlSeconds: 0 })).toEqual({});
        expect(warn).toHaveBeenCalledOnce();
    });
});

describe('validateChallenge', () => {

    // --- No session present ---

    it('returns false when no cookie header is present', async () => {
        expect(await validateChallenge(buildRequest(), false)).toBe(false);
    });

    it('returns false when cookie header has no _cq_se cookie', async () => {
        expect(await validateChallenge(buildRequest('_cq_duid=device-abc; _cq_pvid=pv-xyz'), false)).toBe(false);
    });

    it('validates without logging when isDebug is omitted (defaults to false)', async () => {
        const { cookie } = await issueSession('ray-abc123');
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        expect(await (validateChallenge as (request: CloudFrontRequest) => Promise<boolean>)(buildRequest(cookie))).toBe(true);
        expect(log).not.toHaveBeenCalled();
    });

    // --- Valid session ---

    it('accepts the session cookie issued by challenge', async () => {
        const { cookie } = await issueSession('ray-roundtrip');
        expect(cookie).toMatch(/^_cq_se=\d+\.[0-9a-f]{32}\|ray-roundtrip$/); // format unchanged: 32 hex signature
        expect(await validateChallenge(buildRequest(cookie), false)).toBe(true);
    });

    it('returns true when _cq_se is alongside other cookies', async () => {
        const { cookie } = await issueSession('ray-abc123', testSettings, undefined, '_cq_duid=device-abc');
        expect(await validateChallenge(buildRequest(`_cq_duid=device-abc; ${cookie}; _cq_pvid=pv-xyz`), false)).toBe(true);
    });

    // --- Forged or tampered sessions ---

    it('rejects a token signed the old unkeyed way, SHA-256(expiresAt:rayId) (forgery regression)', async () => {
        const rayId = 'ray-abc123';
        const expiresAt = Date.now() + 60_000;
        const unkeyed = createHash('sha256').update(`${expiresAt}:${rayId}`).digest('hex').slice(0, 32);
        expect(await validateChallenge(buildRequest(`_cq_se=${expiresAt}.${unkeyed}|${rayId}`), false)).toBe(false);
    });

    it('rejects a session issued with a different signing secret', async () => {
        const { cookie } = await issueSession('ray-abc123', { ...testSettings, sessionSigningSecret: 'another-secret' });
        expect(await validateChallenge(buildRequest(cookie), false)).toBe(false);
    });

    it('rejects a valid token presented with another rayId', async () => {
        const { token } = await issueSession('ray-abc123');
        expect(await validateChallenge(buildRequest(`_cq_se=${token}|ray-other`), false)).toBe(false);
    });

    it('rejects a token whose expiry was extended', async () => {
        const { expiresAt, signature } = await issueSession('ray-abc123');
        expect(await validateChallenge(buildRequest(`_cq_se=${expiresAt + 3_600_000}.${signature}|ray-abc123`), false)).toBe(false);
    });

    it.each([
        ['one character short', (sig: string) => sig.slice(0, 31)],
        ['one character long', (sig: string) => sig + '0'],
        ['a different value', (sig: string) => sig.replace(/^./, c => (c === '0' ? '1' : '0'))],
    ])('rejects a signature that is %s, without throwing', async (_label, tamper) => {
        const { expiresAt, signature } = await issueSession('ray-abc123');
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await validateChallenge(buildRequest(`_cq_se=${expiresAt}.${tamper(signature)}|ray-abc123`), false)).toBe(false);
        expect(errorSpy).not.toHaveBeenCalled(); // rejected by the length check, not by timingSafeEqual throwing
    });

    // --- Expired session ---

    it('returns false when the session is expired', async () => {
        const { cookie } = await issueSession('ray-abc123', testSettings, Date.now() - 301_000); // issued 301 s ago, TTL 300 s
        expect(await validateChallenge(buildRequest(cookie), false)).toBe(false);
    });

    // --- Malformed token ---

    it('returns false when token has no "." separator (missing signature)', async () => {
        expect(await validateChallenge(buildRequest('_cq_se=1234567890|ray-abc'), false)).toBe(false);
    });

    it('returns false when expiresAt part is not a number (NaN)', async () => {
        expect(await validateChallenge(buildRequest('_cq_se=notanumber.abcdef|ray-abc'), false)).toBe(false);
    });

    // --- Header fallbacks ---

    it('returns true when rayId comes from x-cheq-ray-id header alongside _cq_se cookie token', async () => {
        const { token } = await issueSession('ray-from-header');
        // cookie contains only the token portion; rayId comes from the header
        expect(await validateChallenge(buildRequest(`_cq_se=${token}|`, 'ray-from-header'), false)).toBe(true);
    });

    it('returns true when sessionToken comes from x-cheq-challenge header instead of cookie', async () => {
        const { token } = await issueSession('ray-abc123');
        // cookie has only the rayId portion, token supplied via header
        expect(await validateChallenge(buildRequest('_cq_se=|ray-abc123', undefined, token), false)).toBe(true);
    });

    it('returns true when both token and rayId come from headers (no _cq_se cookie)', async () => {
        const { token } = await issueSession('ray-abc123');
        expect(await validateChallenge(buildRequest(undefined, 'ray-abc123', token), false)).toBe(true);
    });

    // --- Debug logging branches ---

    it('logs debug info when isDebug=true and no session present', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await validateChallenge(buildRequest(), true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[validateChallenge]'));
    });

    it('logs token/rayId info when isDebug=true with a valid token', async () => {
        const { cookie } = await issueSession('ray-debug');
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await validateChallenge(buildRequest(cookie), true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('signature match'));
    });

    it('logs debug info when isDebug=true and token is expired', async () => {
        const { cookie } = await issueSession('ray-debug', testSettings, Date.now() - 301_000);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await validateChallenge(buildRequest(cookie), true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('expired'));
    });

    it('logs debug info when isDebug=true and token has no separator', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await validateChallenge(buildRequest('_cq_se=1234567890|ray-abc'), true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('invalid sessionToken format'));
    });

    it('logs debug info when isDebug=true and expiresAt is NaN', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await validateChallenge(buildRequest('_cq_se=notanumber.abcdef|ray-abc'), true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NaN'));
    });

    // --- Signature format and comparison ---

    it.each([
        ['without a _cq_duid cookie', undefined],
        ['with a _cq_duid cookie', '_cq_duid=dev-A'],
    ])('signs %s as HMAC-SHA256(secret, JSON ["se", expiresAt, rayId]), first 32 hex (known answer)', async (_label, cookie) => {
        const now = 1_700_000_000_000;
        const { signature, expiresAt } = await issueSession('ray-1', testSettings, now, cookie);
        const signed = JSON.stringify(['se', now + 300_000, 'ray-1']);
        const expected = createHmac('sha256', testSettings.sessionSigningSecret).update(signed).digest('hex').slice(0, 32);
        expect(expiresAt).toBe(now + 300_000);
        expect(signature).toBe(expected);
    });

    // --- Not bound to the visitor's _cq_duid ---

    it('accepts a session issued before the CHEQ tag set _cq_duid once the cookie appears (no second CAPTCHA)', async () => {
        // First visit: the challenge is solved before any page with the CHEQ tag has loaded, so there is no _cq_duid yet.
        const { cookie } = await issueSession('ray-abc123');
        expect(await validateChallenge(buildRequest(`${cookie}; _cq_duid=dev-A`), false)).toBe(true);
    });

    it.each([
        ['the same _cq_duid', '; _cq_duid=dev-A'],
        ['a different _cq_duid', '; _cq_duid=dev-B'],
        ['no _cq_duid', ''],
    ])('accepts a session issued with _cq_duid when the request has %s', async (_label, duidCookie) => {
        const { cookie } = await issueSession('ray-abc123', testSettings, undefined, '_cq_duid=dev-A');
        expect(await validateChallenge(buildRequest(`${cookie}${duidCookie}`), false)).toBe(true);
    });

    // --- Several Cookie header entries (HTTP/2 clients can split cookies) ---

    it('finds _cq_se in a later Cookie header entry', async () => {
        const { cookie } = await issueSession('ray-abc123');
        const request = buildRequest();
        request.headers['cookie'] = [
            { key: 'Cookie', value: 'theme=dark' },
            { key: 'Cookie', value: cookie },
            { key: 'Cookie', value: '_cq_duid=dev-A' },
        ];
        expect(await validateChallenge(request, false)).toBe(true);
    });

    it('compares signatures with timingSafeEqual (constant time)', async () => {
        const { cookie } = await issueSession('ray-abc123');
        vi.mocked(timingSafeEqual).mockClear();
        expect(await validateChallenge(buildRequest(cookie), false)).toBe(true);
        expect(timingSafeEqual).toHaveBeenCalledOnce();
    });

    it('accepts a session up to and including its expiry time, and rejects it 1 ms later', async () => {
        const { cookie, expiresAt } = await issueSession('ray-abc123');
        vi.spyOn(Date, 'now').mockReturnValue(expiresAt);
        expect(await validateChallenge(buildRequest(cookie), false)).toBe(true);
        vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
        expect(await validateChallenge(buildRequest(cookie), false)).toBe(false);
    });

    // --- Header precedence over the cookie ---

    it('x-cheq-challenge wins over the token in the cookie', async () => {
        const { token } = await issueSession('ray-abc123');
        expect(await validateChallenge(buildRequest('_cq_se=1.bogus|ray-abc123', undefined, token), false)).toBe(true);
    });

    it('x-cheq-ray-id wins over the rayId in the cookie', async () => {
        const { token } = await issueSession('ray-from-header');
        expect(await validateChallenge(buildRequest(`_cq_se=${token}|ray-in-cookie`, 'ray-from-header'), false)).toBe(true);
    });

    // --- Catch block ---

    it('returns false and logs error when validation throws', async () => {
        const { cookie } = await issueSession('ray-abc123');
        vi.spyOn(Date, 'now').mockImplementationOnce(() => { throw new Error('clock failed'); });
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await validateChallenge(buildRequest(cookie), false)).toBe(false);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('clock failed'));
    });
});

describe('isChallengeResponse', () => {
    it.each([
        ['the challenge page reply', new URLSearchParams({ original_url: '/landing?gclid=abc', request_id: 'ray', 'cf-turnstile-response': 'tok' }).toString()],
        ["a site's own form with a Turnstile widget (only the field name is checked)", 'q=shoes&cf-turnstile-response=tok'],
        ['an encoded token value', `cf-turnstile-response=${encodeURIComponent('a+b/c=')}`],
    ])('returns true for %s', (_, querystring) => {
        expect(isChallengeResponse(buildTurnstileRequest(querystring))).toBe(true);
    });

    it.each([
        ['no query string', ''],
        ['an unrelated query', 'gclid=abc'],
        ['an empty token', 'cf-turnstile-response='],
        ['the field name only as a value', 'x=cf-turnstile-response'],
        ['a similar field name', 'cf-turnstile-response-x=tok'],
        ['the field name with another case', 'CF-Turnstile-Response=tok'],
    ])('returns false for %s', (_, querystring) => {
        expect(isChallengeResponse(buildTurnstileRequest(querystring))).toBe(false);
    });

    it('returns false when the request has no query string at all', () => {
        const request = buildTurnstileRequest();
        delete (request as any).querystring;
        expect(isChallengeResponse(request)).toBe(false);
    });
});

describe('challenge', () => {

    // --- No token: serve challenge page ---

    it('returns 403 with HTML challenge page when no cf-turnstile-response token present', async () => {
        const result = await challenge(buildTurnstileRequest(), buildRTIResponse()) as any;
        expect(result.status).toBe('403');
        expect(result.body).toContain('cf-turnstile');
        expect(result.headers['content-type'][0].value).toContain('text/html');
        expect(result.headers['cache-control'][0].value).toContain('no-store');
    });

    it('embeds rayId and the configured site key in challenge page HTML', async () => {
        const result = await challenge(buildTurnstileRequest(), buildRTIResponse('ray-embed-test')) as any;
        expect(result.body).toContain('ray-embed-test');
        expect(result.body).toContain('data-sitekey="test-site-key"');
    });

    it('HTML-escapes the request URI in the challenge page', async () => {
        const request = buildTurnstileRequest();
        (request as any).uri = '/page"><script>alert(1)</script>';
        const result = await challenge(request, buildRTIResponse()) as any;
        expect(result.body).not.toContain('<script>alert(1)</script>');
        expect(result.body).toContain('action="/page&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
        expect(result.body).toContain('name="original_url" value="/page&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    });

    it("HTML-escapes the rayId and the site key (& < > \" ')", async () => {
        const result = await build({ ...testSettings, siteKey: `k"'<&>` }).challenge(buildTurnstileRequest(), buildRTIResponse(`r"'<&>`)) as any;
        expect(result.body).toContain('data-sitekey="k&quot;&#39;&lt;&amp;&gt;"');
        expect(result.body).toContain('name="request_id" value="r&quot;&#39;&lt;&amp;&gt;"');
        expect(result.body).toContain('<div class="ref-id">r&quot;&#39;&lt;&amp;&gt;</div>');
        expect(result.body).not.toContain(`r"'<&>`);
    });

    it('leaves a normal URI and rayId unchanged', async () => {
        const result = await challenge(buildTurnstileRequest(), buildRTIResponse('ray-abc-123')) as any;
        expect(result.body).toContain('action="/page"');
        expect(result.body).toContain('value="ray-abc-123"');
    });

    it('puts the request query string into original_url, not into the form action', async () => {
        const result = await challenge(buildTurnstileRequest('gclid=abc&utm_source=x'), buildRTIResponse()) as any;
        expect(result.body).toContain('name="original_url" value="/page?gclid=abc&amp;utm_source=x"');
        expect(result.body).toContain('action="/page"');
    });

    it('returns the visitor to the original query string after solving the challenge', async () => {
        const originalQuery = 'q=a%20b&tag=c%2Bd&gclid=abc';
        const page = await challenge(buildTurnstileRequest(originalQuery), buildRTIResponse()) as any;
        const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
        const fieldValue: string = page.body.match(/name="original_url" value="([^"]*)"/)[1]
            .replace(/&(amp|lt|gt|quot|#39);/g, (_: string, e: string) => entities[e]);
        // What the browser sends: the form fields, URL-encoded, replacing any query of the action.
        const submitted = new URLSearchParams({ original_url: fieldValue, request_id: 'ray-123', 'cf-turnstile-response': 'valid-token' }).toString();
        stubSiteverify(true);
        const result = await challenge(buildTurnstileRequest(submitted, 'example.com'), buildRTIResponse()) as any;
        expect(result.headers.location[0].value).toBe(`https://example.com/page?${originalQuery}`);
    });

    // --- Token present: verify with Turnstile ---

    it('sends the configured Turnstile secret to siteverify', async () => {
        const fetchMock = stubSiteverify(true);
        await challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse());
        const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
        expect(body.get('secret')).toBe('test-turnstile-secret');
        expect(body.get('response')).toBe('valid-token');
    });

    it('returns 302 with session cookie when Turnstile verification succeeds', async () => {
        stubSiteverify(true);
        const qs = new URLSearchParams({ 'cf-turnstile-response': 'valid-token', 'original_url': '/target' }).toString();
        const result = await challenge(buildTurnstileRequest(qs, 'example.com'), buildRTIResponse()) as any;
        expect(result.status).toBe('302');
        expect(result.headers.location[0].value).toBe('https://example.com/target');
        expect(result.headers['set-cookie'][0].value).toContain('_cq_se=');
        expect(result.headers['set-cookie'][0].value).toContain('Max-Age=300');
    });

    it('sets the session cookie with exactly Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=<ttl>', async () => {
        stubSiteverify(true);
        const result = await challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse('ray-123')) as any;
        expect(result.headers['set-cookie']).toHaveLength(1);
        expect(result.headers['set-cookie'][0].value).toMatch(/^_cq_se=\d+\.[0-9a-f]{32}\|ray-123; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=300$/);
    });

    it('verifies the token with a form POST to Cloudflare siteverify, including the client IP', async () => {
        const fetchMock = stubSiteverify(true);
        await challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse());
        const [target, opts] = fetchMock.mock.calls[0];
        expect(target).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
        expect(opts.method).toBe('POST');
        expect(opts.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
        expect(new URLSearchParams(opts.body).get('remoteip')).toBe('1.2.3.4');
    });

    it('rejects when the siteverify call fails (the handler then fails open)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('siteverify unreachable')));
        await expect(challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse())).rejects.toThrow('siteverify unreachable');
    });

    it('uses sessionTtlSeconds for the cookie expiry', async () => {
        const { cookie } = await issueSession('ray-ttl', { ...testSettings, sessionTtlSeconds: 60 }, 1_700_000_000_000);
        expect(cookie).toContain(`_cq_se=${1_700_000_000_000 + 60_000}.`);
    });

    it('sets Max-Age from sessionTtlSeconds', async () => {
        stubSiteverify(true);
        const result = await build({ ...testSettings, sessionTtlSeconds: 60 }).challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse()) as any;
        expect(result.headers['set-cookie'][0].value).toContain('Max-Age=60');
    });

    // --- x-cheq-rti-result: added only on the success 302, through the handler's addRtiResultHeader ---

    it('calls addRtiResultHeader with the success 302 headers', async () => {
        stubSiteverify(true);
        const addRtiResultHeader = vi.fn();
        const result = await challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse(), addRtiResultHeader) as any;
        expect(result.status).toBe('302');
        expect(addRtiResultHeader).toHaveBeenCalledOnce();
        expect(addRtiResultHeader).toHaveBeenCalledWith(result.headers);
    });

    it('does not set x-cheq-rti-result itself (works without addRtiResultHeader)', async () => {
        stubSiteverify(true);
        const result = await challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse()) as any;
        expect(result.status).toBe('302');
        expect(result.headers['x-cheq-rti-result']).toBeUndefined();
    });

    it('does not call addRtiResultHeader for the challenge page', async () => {
        const addRtiResultHeader = vi.fn();
        await challenge(buildTurnstileRequest(), buildRTIResponse(), addRtiResultHeader);
        expect(addRtiResultHeader).not.toHaveBeenCalled();
    });

    it('does not call addRtiResultHeader when verification fails', async () => {
        stubSiteverify(false);
        const addRtiResultHeader = vi.fn();
        await challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse(), addRtiResultHeader);
        expect(addRtiResultHeader).not.toHaveBeenCalled();
    });

    // --- Redirect target (as in Akamai's reCAPTCHA challenge: host from the request, path checked) ---

    it('redirects to the Host header and the request URI when no original_url is given', async () => {
        stubSiteverify(true);
        const result = await challenge(buildTurnstileRequest(solvedQuery, 'example.com'), buildRTIResponse()) as any;
        expect(result.headers.location[0].value).toBe('https://example.com/page');
    });

    it('ignores a viewer_host query parameter (it used to set the redirect host: an open redirect)', async () => {
        stubSiteverify(true);
        const qs = new URLSearchParams({ 'cf-turnstile-response': 'valid-token', 'viewer_host': 'evil.com', 'original_url': '/target' }).toString();
        const result = await challenge(buildTurnstileRequest(qs, 'example.com'), buildRTIResponse()) as any;
        expect(result.headers.location[0].value).toBe('https://example.com/target');
    });

    it('keeps the query string of an accepted original_url', async () => {
        stubSiteverify(true);
        const qs = new URLSearchParams({ 'cf-turnstile-response': 'valid-token', 'original_url': '/search?q=shoes&page=2' }).toString();
        const result = await challenge(buildTurnstileRequest(qs, 'example.com'), buildRTIResponse()) as any;
        expect(result.headers.location[0].value).toBe('https://example.com/search?q=shoes&page=2');
    });

    it.each(['//evil.com', '/\\evil.com', 'https://evil.com/x', '@evil.com', '.evil.com', 'evil.com', ''])(
        'rejects original_url %j and redirects to the request URI instead', async (originalUrl) => {
            stubSiteverify(true);
            const qs = new URLSearchParams({ 'cf-turnstile-response': 'valid-token', 'original_url': originalUrl }).toString();
            const result = await challenge(buildTurnstileRequest(qs, 'example.com'), buildRTIResponse()) as any;
            expect(result.headers.location[0].value).toBe('https://example.com/page');
        });

    it('uses a relative Location when the request has no Host header', async () => {
        stubSiteverify(true);
        const result = await challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse()) as any;
        expect(result.headers.location[0].value).toBe('/page');
    });

    it('does not put a viewer_host field in the challenge form', async () => {
        const result = await challenge(buildTurnstileRequest(), buildRTIResponse()) as any;
        expect(result.body).not.toContain('viewer_host');
    });

    it('returns 403 with error message when Turnstile verification fails', async () => {
        stubSiteverify(false);
        const qs = new URLSearchParams({ 'cf-turnstile-response': 'bad-token' }).toString();
        const result = await challenge(buildTurnstileRequest(qs), buildRTIResponse()) as any;
        expect(result.status).toBe('403');
        expect(result.body).toContain('Verification failed');
        expect(result.headers?.['set-cookie']).toBeUndefined();
    });
});
