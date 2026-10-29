// cspell:ignore cheq
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createTurnstileChallenge, sessionBindingKey, SessionBinding, TurnstileSettings } from './turnstile-challenge-example';
import { isIPv4, isIPv6 } from 'node:net';
import type { CloudFrontRequest } from 'aws-lambda/common/cloudfront';
import { RTIStatelessUtils } from '../../core/services/rti-stateless-utils';
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

// The Host matches what stubSiteverify(true) answers, so a solved token is accepted. Pass null for no Host header.
function buildTurnstileRequest(querystring = '', hostHeader: string | null = 'example.com', cookie?: string): CloudFrontRequest {
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

/** The session binding key of buildRequest and buildTurnstileRequest (clientIp 1.2.3.4, no User-Agent), default binding. */
const BUILD_REQUEST_BINDING = '["1.2.3.4",""]';

/** Stubs siteverify with this exact result (it is what `verifyResponse.json()` resolves to). */
const stubSiteverifyResult = (result: Record<string, unknown>) => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => result });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
};

/** true: a token solved on the CHEQ widget of buildTurnstileRequest's default host. false: a token Turnstile rejects. */
const stubSiteverify = (success: boolean) =>
    stubSiteverifyResult(success ? { success, hostname: 'example.com', action: 'cheq-challenge' } : { success });

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

    // Above 400 days (the most browsers keep a cookie) the TTL is refused: 1e13 s pushed the expiry past
    // Number.MAX_SAFE_INTEGER, so validateChallenge rejected every session and visitors looped on the CAPTCHA.
    const MAX_TTL = 400 * 24 * 60 * 60;

    it.each([MAX_TTL + 1, 10 * MAX_TTL, 1e13, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE])(
        'warns and uses the default 300 s when sessionTtlSeconds is %j, above the 400-day maximum', async (ttl) => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const callbacks = createTurnstileChallenge({ ...testSettings, sessionTtlSeconds: ttl });
            expect(warn).toHaveBeenCalledOnce();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('at most 34560000 (400 days)'));

            stubSiteverify(true);
            const result = await callbacks.challenge!(buildTurnstileRequest(solvedQuery), buildRTIResponse()) as any;
            expect(result.headers['set-cookie'][0].value).toContain('Max-Age=300');
        });

    it.each([1, 60, MAX_TTL])('issues a session with sessionTtlSeconds %j that validateChallenge then accepts', async (ttl) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const callbacks = build({ ...testSettings, sessionTtlSeconds: ttl });
        expect(warn).not.toHaveBeenCalled();

        stubSiteverify(true);
        const result = await callbacks.challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse('ray-ttl')) as any;
        const cookie = result.headers['set-cookie'][0].value.split(';')[0];
        expect(result.headers['set-cookie'][0].value).toContain(`Max-Age=${ttl}`);
        expect(await callbacks.validateChallenge(buildRequest(cookie), false)).toBe(true);
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

    it('logs debug info when isDebug=true and expiresAt is not a number', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await validateChallenge(buildRequest('_cq_se=notanumber.abcdef|ray-abc'), true);
        expect(consoleSpy).toHaveBeenCalledWith("[validateChallenge] invalid expiresAt format, returning 'false'");
        expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('notanumber');
    });

    // --- Debug logs: cookie names only, never values (the site's own cookies, our session token) ---

    describe('debug logs never contain cookie values or the session token', () => {
        const loggedDuring = async (request: CloudFrontRequest) => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await validateChallenge(request, true);
            const logged = consoleSpy.mock.calls.flat().join('\n');
            consoleSpy.mockRestore();
            return logged;
        };

        it('logs the cookie names, not their values, with the token in the _cq_se cookie', async () => {
            const { cookie, token } = await issueSession('ray-names');
            const logged = await loggedDuring(buildRequest(`a=secret1; ${cookie}`));

            expect(logged).toContain('[validateChallenge] cookies: a, _cq_se');
            expect(logged).toContain('sessionToken: present (cookie)');
            expect(logged).not.toContain('secret1');
            expect(logged).not.toContain(token);
            expect(logged).not.toContain(token.split('.')[1]); // the signature on its own
        });

        it('logs only where the token came from when it arrives in the x-cheq-challenge header', async () => {
            const { token } = await issueSession('ray-header');
            const logged = await loggedDuring(buildRequest('a=secret1; _ga=GA1.2.3', 'ray-header', token));

            expect(logged).toContain('[validateChallenge] cookies: a, _ga');
            expect(logged).toContain('sessionToken: present (x-cheq-challenge header)');
            expect(logged).toContain('rayId: ray-header');
            expect(logged).not.toContain('secret1');
            expect(logged).not.toContain('GA1.2.3');
            expect(logged).not.toContain(token);
            expect(logged).not.toContain(token.split('.')[1]);
        });

        it('takes names from several Cookie headers', async () => {
            const request = buildRequest('a=secret1');
            request.headers['cookie'].push({ key: 'Cookie', value: 'b=secret2; c=secret3' });
            const logged = await loggedDuring(request);

            expect(logged).toContain('[validateChallenge] cookies: a, b, c');
            expect(logged).not.toMatch(/secret[123]/);
        });

        it('shows a cookie without "=" (all value, no name) as [REDACTED]', async () => {
            const logged = await loggedDuring(buildRequest('a=1; justavalue'));
            expect(logged).toContain('[validateChallenge] cookies: a, [REDACTED]');
            expect(logged).not.toContain('justavalue');
        });

        it('says NOT PRESENT and NOT FOUND when there are no cookies and no token', async () => {
            const logged = await loggedDuring(buildRequest());
            expect(logged).toContain('[validateChallenge] cookies: NOT PRESENT');
            expect(logged).toContain('sessionToken: NOT FOUND');
        });

        it('never logs a cookie value on any path (valid, expired, bad format, bad signature)', async () => {
            const { cookie: valid } = await issueSession('ray-paths');
            const { cookie: expired } = await issueSession('ray-paths', testSettings, Date.now() - 301_000);
            for (const sessionCookie of [valid, expired, '_cq_se=123abc.deadbeef|ray-paths', '_cq_se=nodot|ray-paths', '_cq_se=9999999999999.0000|ray-paths']) {
                const logged = await loggedDuring(buildRequest(`login=topsecret; ${sessionCookie}`));
                const sessionValue = sessionCookie.slice('_cq_se='.length).split('|')[0];
                expect(logged).not.toContain('topsecret');
                expect(logged).not.toContain(sessionValue);
            }
        });
    });

    // --- Session format: exactly "{expiresAt}.{signature}", and only the expiry spelling sessionRedirect issues ---

    describe('strict session format', () => {
        // A correct signature for any expiry, so a rejection can only come from the format checks.
        const sign = (expiresAt: number, rayId = 'ray-exp') =>
            createHmac('sha256', testSettings.sessionSigningSecret).update(JSON.stringify(['se', expiresAt, rayId, BUILD_REQUEST_BINDING])).digest('hex').slice(0, 32);
        const validateToken = (token: string, isDebug = false) =>
            validateChallenge(buildRequest(`_cq_se=${token}|ray-exp`), isDebug);
        const logsDuring = async (token: string) => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            const accepted = await validateToken(token, true);
            const lines = consoleSpy.mock.calls.map(call => String(call[0]));
            consoleSpy.mockRestore();
            return { accepted, lines };
        };
        const FORMAT = "[validateChallenge] invalid sessionToken format, returning 'false'";
        const EXPIRY_FORMAT = "[validateChallenge] invalid expiresAt format, returning 'false'";

        describe('the token: exactly two parts', () => {
            it.each([
                ['a third part', (e: number, s: string) => `${e}.${s}.junk`],
                ['a trailing dot', (e: number, s: string) => `${e}.${s}.`],
                ['a decimal expiry (splits into three parts)', (e: number, s: string) => `${e}.5.${s}`],
                ['no dot', (e: number, s: string) => `${e}${s}`],
                ['an empty expiry', (_: number, s: string) => `.${s}`],
                ['an empty signature', (e: number) => `${e}.`],
                ['only a dot', () => '.'],
            ])('rejects a genuinely signed session with %s', async (_, spell) => {
                // Arrange
                const expiresAt = Date.now() + 60_000;
                expect(await validateToken(`${expiresAt}.${sign(expiresAt)}`)).toBe(true);

                // Act
                const { accepted, lines } = await logsDuring(spell(expiresAt, sign(expiresAt)));

                // Assert
                expect(accepted).toBe(false);
                expect(lines).toContain(FORMAT);
            });
        });

        describe('the expiry: only `${expiresAt}` of a safe integer', () => {
            it.each([
                ['letters after the digits (parseInt reads 123)', '123abc'],
                ['leading zeros', '0123'],
                ['a single leading zero', '01730000000000'],
                ['a leading space', ' 123'],
                ['a trailing space', '123 '],
                ['a leading tab', '\t123'],
                ['a plus sign', '+1730000000000'],
                ['negative zero', '-0'],
                ['an exponent', '1e13'],
                ['an upper-case exponent', '1E13'],
                ['hex', '0x1F'],
                ['octal', '0o17'],
                ['binary', '0b101'],
                ['digit separators', '1_730_000_000_000'],
                ['Infinity', 'Infinity'],
                ['NaN', 'NaN'],
                ['a non-ASCII digit', '١٢٣'],
                ['a full-width digit', '１２３'],
                ['one above the largest safe integer', '9007199254740992'],
                ['two above it (Number() rounds it)', '9007199254740993'],
                ['20 digits', '99999999999999999999'],
            ])('rejects %s (%j) with an "invalid expiresAt format" debug line', async (_, expiresAtStr) => {
                // Act
                const { accepted, lines } = await logsDuring(`${expiresAtStr}.${'a'.repeat(32)}`);

                // Assert
                expect(accepted).toBe(false);
                expect(lines).toContain(EXPIRY_FORMAT);
                expect(lines.join('\n')).not.toContain(expiresAtStr.trim() || '\u0000'); // the value is never logged
            });

            it.each([
                ['minus one', '-1'],
                ['zero', '0'],
                ['an old timestamp', '1000000000000'],
            ])('accepts the format of %s (%j), a real number as issued, and rejects it as expired', async (_, expiresAtStr) => {
                // Act
                const { accepted, lines } = await logsDuring(`${expiresAtStr}.${sign(Number(expiresAtStr))}`);

                // Assert
                expect(accepted).toBe(false);
                expect(lines).not.toContain(EXPIRY_FORMAT);
                expect(lines.some(line => line.includes('expired'))).toBe(true);
            });

            it('accepts a valid 13-digit expiry with a good signature', async () => {
                // Arrange
                const expiresAt = Date.now() + 60_000;

                // Act & Assert
                expect(String(expiresAt)).toMatch(/^\d{13}$/);
                expect(await validateToken(`${expiresAt}.${sign(expiresAt)}`)).toBe(true);
            });

            it('accepts the largest safe integer, and rejects the next one even with a good signature', async () => {
                // Arrange
                const max = Number.MAX_SAFE_INTEGER;

                // Act & Assert
                expect(await validateToken(`${max}.${sign(max)}`)).toBe(true);
                expect(await validateToken(`${max + 1}.${sign(max + 1)}`)).toBe(false);
            });

            it('accepts every issued spelling and rejects every other spelling of the same number, signatures all genuine', async () => {
                // Arrange: future expiries of every length from 13 to 16 digits, round and not
                const now = Date.now();
                const expiries = [now + 1, now + 300_000, now + 86_400_000, 9_999_999_999_999, 10_000_000_000_000,
                    123_456_789_012_345, 1_000_000_000_000_000, 8_000_000_000_000_001, Number.MAX_SAFE_INTEGER];
                const respell = (s: string) => [
                    `0${s}`, `00${s}`, `+${s}`, ` ${s}`, `${s} `, `\t${s}`, `${s}\n`, `${s}abc`, `${s}0x`, `${s}e0`, `${s}n`,
                    `${Number(s).toExponential()}`, `0x${Number(s).toString(16)}`, s.replace(/^(\d)/, '$1_'),
                ].filter(variant => variant !== s);
                const wrong: string[] = [];

                // Act
                for (const expiresAt of expiries) {
                    const issued = String(expiresAt);
                    if (!(await validateToken(`${issued}.${sign(expiresAt)}`))) {
                        wrong.push(`issued ${JSON.stringify(issued)} rejected`);
                    }
                    for (const variant of respell(issued)) {
                        if (await validateToken(`${variant}.${sign(expiresAt)}`)) {
                            wrong.push(`${JSON.stringify(variant)} accepted for ${issued}`);
                        }
                    }
                }

                // Assert
                expect(wrong).toEqual([]);
            });
        });

        it('accepts what sessionRedirect actually issues', async () => {
            // Arrange
            const { cookie, expiresAt } = await issueSession('ray-issued');

            // Act & Assert
            expect(cookie).toMatch(new RegExp(`^_cq_se=${expiresAt}\\.[0-9a-f]{32}\\|ray-issued$`));
            expect(await validateChallenge(buildRequest(cookie), false)).toBe(true);
        });
    });

    // --- Signature format and comparison ---

    it.each([
        ['without a _cq_duid cookie', undefined],
        ['with a _cq_duid cookie', '_cq_duid=dev-A'],
    ])('signs %s as HMAC-SHA256(secret, JSON ["se", expiresAt, rayId, bindingKey]), first 32 hex (known answer)', async (_label, cookie) => {
        const now = 1_700_000_000_000;
        const { signature, expiresAt } = await issueSession('ray-1', testSettings, now, cookie);
        // The binding key of the issuing request (clientIp 1.2.3.4, no User-Agent) with the default binding
        const signed = JSON.stringify(['se', now + 300_000, 'ray-1', '["1.2.3.4",""]']);
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
        expect(result.body).toContain('value="ray-abc-123"');
    });

    it('puts the request query string into original_url, and gives the form no action', async () => {
        const result = await challenge(buildTurnstileRequest('gclid=abc&utm_source=x'), buildRTIResponse()) as any;
        expect(result.body).toContain('name="original_url" value="/page?gclid=abc&amp;utm_source=x"');
        // No action: the browser submits to the page's own URL. One built from the request URI would send a path like
        // "//evil.com/" (a protocol-relative URL) and the token to another site.
        expect(result.body).toMatch(/<form id="captcha-form" method="GET">/);
        expect(result.body).not.toMatch(/<form[^>]*\saction=/);
    });

    it.each(['//evil.com/', '/\\evil.com', '//evil.com/path?x=1'])(
        'never puts the request URI %j where the browser would read it as a link to another site', async (uri) => {
            const request = buildTurnstileRequest();
            (request as any).uri = uri;
            const result = await challenge(request, buildRTIResponse()) as any;
            expect(result.body).not.toMatch(/\saction=/i);
            expect(result.body).not.toMatch(/\shref="\/[\/\\]/);
        });

    it('repeats the request URI only inside the escaped original_url field', async () => {
        const request = buildTurnstileRequest('x=1');
        (request as any).uri = '//evil.com/';
        const result = await challenge(request, buildRTIResponse()) as any;
        expect(result.body.split('//evil.com/')).toHaveLength(2); // exactly one occurrence
        expect(result.body).toContain('name="original_url" value="//evil.com/?x=1"');
    });

    // The whole trip, as a browser makes it: the challenge page for the original URL, then the form submitted to the
    // page's own URL (no action) with its fields URL-encoded in place of the query. The visitor must come back to
    // exactly the original URL.
    describe('returns the visitor to exactly the original URL', () => {
        const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
        const fieldOf = (body: string): string => body.match(/name="original_url" value="([^"]*)"/)![1]
            .replace(/&(amp|lt|gt|quot|#39);/g, (_: string, e: string) => entities[e]);

        it.each([
            ['plain parameters', '/page', 'gclid=abc&utm_source=x'],
            ['+, %2B, %20 and %25 (never re-encoded)', '/page', 'q=a+b&tag=c%2Bd&s=%20&p=%25'],
            ['repeated, valueless and empty parameters', '/page', 'a&a&b=1&b=2&e=&=x&&'],
            ['the form field names in the visitor\'s own query', '/page', 'original_url=/x&request_id=1&cf-turnstile-response='],
            ['non-ASCII, encoded and raw', '/page', 'u=%E2%9C%93&raw=✓'],
            ['invalid UTF-8 escapes', '/page', 'q=%FF%FE'],
            ['quotes and angle brackets', '/page', `q='"<>`],
            ['an encoded newline', '/page', 'q=a%0Ab'],
            ['a long query', '/page', `q=${'a'.repeat(3000)}`],
            ['an encoded path with a semicolon', '/caf%C3%A9/a;b', 'x=1'],
            ['a path starting with //', '//page', 'x=1'],
            ['a path starting with /\\', '/\\page', 'x=1'],
            ['no query', '/page', ''],
        ])('%s', async (_, uri, querystring) => {
            const original = buildTurnstileRequest(querystring);
            (original as any).uri = uri;
            const page = await challenge(original, buildRTIResponse()) as any;
            const submitted = new URLSearchParams({ original_url: fieldOf(page.body), request_id: 'ray-123', 'cf-turnstile-response': 'tok' }).toString();
            const reply = buildTurnstileRequest(submitted);
            (reply as any).uri = uri; // the page's own path: the form has no action

            stubSiteverify(true);
            const verified = await challenge(reply, buildRTIResponse()) as any;
            expect(verified.headers.location[0].value).toBe(`https://example.com${querystring ? `${uri}?${querystring}` : uri}`);
        });

        // The fragment never reaches the server: the page's submit handler adds location.hash to original_url. Run it
        // against a minimal fake DOM (no DOM library in this project).
        const submitWith = (pageScript: string, originalUrl: string, hash: string): string => {
            let onSubmit: (this: unknown) => void = () => {};
            const field = { value: originalUrl };
            const form = { elements: { original_url: field }, addEventListener: (_: string, fn: () => void) => { onSubmit = fn; } };
            const elements: Record<string, unknown> = { 'captcha-form': form, 'submit-btn': { disabled: false }, loading: { classList: { add: () => {} } } };
            new Function('document', 'location', pageScript)({ getElementById: (id: string) => elements[id] }, { hash });
            onSubmit.call(form);
            return field.value;
        };

        it('adds the #fragment in the browser, and the redirect keeps it', async () => {
            const page = await challenge(buildTurnstileRequest('x=1'), buildRTIResponse()) as any;
            const pageScript: string = page.body.match(/<script>([\s\S]*?)<\/script>/)[1];

            expect(submitWith(pageScript, '/page?x=1', '#reviews')).toBe('/page?x=1#reviews');
            expect(submitWith(pageScript, '/page?x=1', '')).toBe('/page?x=1');
            expect(submitWith(pageScript, '/page?x=1#reviews', '#reviews')).toBe('/page?x=1#reviews'); // a second submit adds nothing

            stubSiteverify(true);
            const qs = new URLSearchParams({ original_url: '/page?x=1#reviews', 'cf-turnstile-response': 'tok' }).toString();
            const verified = await challenge(buildTurnstileRequest(qs), buildRTIResponse()) as any;
            expect(verified.headers.location[0].value).toBe('https://example.com/page?x=1#reviews');
        });

        it.each([
            ['a normal path', '/page', 'x=1'],
            ['a path starting with //', '//page', 'x=1'],
            ['no query', '/page', ''],
        ])('keeps the #fragment through the whole trip, for %s', async (_, uri, querystring) => {
            // Page → its script on submit (location.hash) → the reply → the redirect
            const original = buildTurnstileRequest(querystring);
            (original as any).uri = uri;
            const page = await challenge(original, buildRTIResponse()) as any;
            const pageScript: string = page.body.match(/<script>([\s\S]*?)<\/script>/)[1];
            const field = submitWith(pageScript, fieldOf(page.body), '#reviews');
            const reply = buildTurnstileRequest(new URLSearchParams({ original_url: field, request_id: 'ray-123', 'cf-turnstile-response': 'tok' }).toString());
            (reply as any).uri = uri;

            stubSiteverify(true);
            const verified = await challenge(reply, buildRTIResponse()) as any;
            expect(verified.headers.location[0].value).toBe(`https://example.com${uri}${querystring ? `?${querystring}` : ''}#reviews`);
        });
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

    // Browsers delete tab, LF and CR from a URL before parsing it, so "/\t/evil.com" passed the leading-slash checks
    // yet resolved to "//evil.com" - an open redirect through a relative Location (no Host header). No Host is now
    // rejected before any redirect (see the token checks below), but the path must still never reach Location:
    // CR/LF would split the header, and the relative branch of returnLocation stays as a fallback.
    it.each(['/\t/evil.com', '/\n/evil.com', '/\r/evil.com', '/\t\\evil.com', '/page\r\nSet-Cookie: a=1'])(
        'rejects original_url %j and redirects to the request URI instead', async (originalUrl) => {
            stubSiteverify(true);
            const qs = new URLSearchParams({ 'cf-turnstile-response': 'valid-token', 'original_url': originalUrl }).toString();
            const result = await challenge(buildTurnstileRequest(qs), buildRTIResponse()) as any;
            expect(result.headers.location[0].value).toBe('https://example.com/page');
        });

    // A request path that safeReturnPath rejects ("//page", "/\page") still gets its own query and fragment back:
    // original_url is that same path plus "?..." or "#...", and behind https://{host} the host cannot change.
    describe('an original_url on the request\'s own path that safeReturnPath rejects', () => {
        const verifiedOn = (uri: string, originalUrl: string) => {
            stubSiteverify(true);
            const request = buildTurnstileRequest(new URLSearchParams({ 'cf-turnstile-response': 'tok', original_url: originalUrl }).toString());
            (request as any).uri = uri;
            return challenge(request, buildRTIResponse()) as Promise<any>;
        };

        it.each([
            ['a query', '//page', '//page?x=1&y=%2B'],
            ['a fragment', '//page', '//page#reviews'],
            ['a query and a fragment', '//page', '//page?x=1#reviews'],
            ['an empty query', '//page', '//page?'],
            ['a backslash path', '/\\page', '/\\page?x=1'],
            ['a path that looks like another host', '//evil.com/x', '//evil.com/x?y=1'],
        ])('keeps %s', async (_, uri, originalUrl) => {
            const location: string = (await verifiedOn(uri, originalUrl)).headers.location[0].value;
            expect(location).toBe(`https://example.com${originalUrl}`);
            expect(new URL(location).host).toBe('example.com'); // the path never changes the host
        });

        it.each([
            ['another path', '//page', '//other?x=1'],
            ['a longer path with the same start', '//page', '//pagex?x=1'],
            ['a sub-path', '//page', '//page/x?y=1'],
            ['CR/LF (would split the Location header)', '//page', '//page?x=1\r\nSet-Cookie: a=1'],
            ['a tab', '//page', '//page?x=\t1'],
            ['DEL', '//page', '//page?x=\x7F'],
            ['a control character in the path part', '//pa\tge', '//pa\tge?x=1'],
            ['exactly the path, nothing after it', '//page', '//page'],
            ['nothing at all', '//page', ''],
        ])('falls back to the bare request path for %s', async (_, uri, originalUrl) => {
            expect((await verifiedOn(uri, originalUrl)).headers.location[0].value).toBe(`https://example.com${uri}`);
        });
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

// siteverify's `success` only says the token is genuine for the site key. It must also have been solved on this host
// and on the CHEQ widget (data-action="cheq-challenge"): otherwise a token from another site sharing the key, or from
// another Turnstile widget on this site (a login or newsletter form), would buy a CHEQ session.
describe('challenge token checks (hostname and action)', () => {
    const solvedOn = (host: string | null) => challenge(buildTurnstileRequest(solvedQuery, host), buildRTIResponse('ray-checks')) as Promise<any>;

    const expectSession = (result: any) => {
        expect(result.status).toBe('302');
        expect(result.headers['set-cookie'][0].value).toMatch(/^_cq_se=\d+\.[0-9a-f]{32}\|ray-checks;/);
    };

    const expectRejected = (result: any) => {
        expect(result.status).toBe('403');
        expect(result.body).toContain('Verification failed');
        expect(result.headers?.['set-cookie']).toBeUndefined();
    };

    it('puts data-action="cheq-challenge" on the widget, and the source comment next to it is not sent', async () => {
        const page = await challenge(buildTurnstileRequest(), buildRTIResponse()) as any;
        expect(page.body).toMatch(/<div class="cf-turnstile"[^>]*\sdata-action="cheq-challenge"/);
        expect(page.body).not.toContain('REQUIRED');
        expect(page.body).not.toContain('CAPTCHA loop');
        expect(page.body).not.toContain('/*');
    });

    it('issues a session when the token was solved on this host and on the CHEQ widget', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubSiteverifyResult({ success: true, hostname: 'shop.com', action: 'cheq-challenge' });
        expectSession(await solvedOn('shop.com'));
        expect(warn).not.toHaveBeenCalled();
    });

    it.each([
        ['another hostname', { hostname: 'evil.com', action: 'cheq-challenge' }, "hostname 'evil.com' ≠ request host 'shop.com'"],
        ['a subdomain of this host', { hostname: 'login.shop.com', action: 'cheq-challenge' }, "hostname 'login.shop.com' ≠ request host 'shop.com'"],
        ['no hostname', { action: 'cheq-challenge' }, "hostname '' ≠ request host 'shop.com'"],
        ['another action (the site\'s own login widget)', { hostname: 'shop.com', action: 'login' }, "action 'login' ≠ 'cheq-challenge'"],
        ['an action in another case', { hostname: 'shop.com', action: 'CHEQ-CHALLENGE' }, "action 'CHEQ-CHALLENGE' ≠ 'cheq-challenge'"],
        ['an empty action (a widget without data-action)', { hostname: 'shop.com', action: '' }, "action '' ≠ 'cheq-challenge' (is data-action missing from the challenge page?)"],
        ['no action at all', { hostname: 'shop.com' }, "action '' ≠ 'cheq-challenge' (is data-action missing from the challenge page?)"],
    ])('rejects a valid token with %s, and warns why', async (_, fields, reason) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubSiteverifyResult({ success: true, ...fields });

        expectRejected(await solvedOn('shop.com'));
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(`[turnstile] token valid but ${reason}`);
    });

    it('warns about both when hostname and action are wrong', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubSiteverifyResult({ success: true, hostname: 'evil.com', action: 'login' });

        expectRejected(await solvedOn('shop.com'));
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("hostname 'evil.com'"));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("action 'login'"));
    });

    it.each(['shop.com:443', 'shop.com:8443', 'Shop.COM', 'SHOP.com:443'])(
        'matches request host %j to hostname shop.com (case and :port ignored)', async (host) => {
            stubSiteverifyResult({ success: true, hostname: 'shop.com', action: 'cheq-challenge' });
            expectSession(await solvedOn(host));
        });

    it('matches a hostname in another case', async () => {
        stubSiteverifyResult({ success: true, hostname: 'Shop.COM', action: 'cheq-challenge' });
        expectSession(await solvedOn('shop.com'));
    });

    // Neither side should carry more than host[:port], but both are normalized the same way, just in case.
    it.each([
        ['a scheme', 'https://shop.com'],
        ['an http scheme', 'http://shop.com'],
        ['a scheme, port and path', 'https://shop.com:443/page?q=1#top'],
        ['a trailing slash', 'shop.com/'],
        ['a path', 'shop.com/login'],
        ['a query', 'shop.com?x=1'],
        ['a fragment', 'shop.com#x'],
        ['userinfo', 'user@shop.com'],
        ['userinfo with a password and a port', 'https://user:pass@shop.com:8443'],
        ['a trailing dot (DNS root)', 'shop.com.'],
        ['a trailing dot and a port', 'shop.com.:443'],
        ['an empty port', 'shop.com:'],
        ['surrounding spaces', '  shop.com  '],
        ['all of it, in upper case', '  HTTPS://User@Shop.COM.:443/Path  '],
    ])('matches shop.com when the hostname has %s (%j)', async (_, hostname) => {
        stubSiteverifyResult({ success: true, hostname, action: 'cheq-challenge' });
        expectSession(await solvedOn('shop.com'));
    });

    it.each([
        ['a scheme', 'https://shop.com'],
        ['a trailing dot (DNS root)', 'shop.com.'],
        ['a path', 'shop.com/page'],
        ['userinfo', 'user@shop.com'],
        ['surrounding spaces', ' shop.com '],
    ])('matches hostname shop.com when the request Host has %s (%j)', async (_, host) => {
        stubSiteverifyResult({ success: true, hostname: 'shop.com', action: 'cheq-challenge' });
        expectSession(await solvedOn(host));
    });

    it.each([
        ['an IPv6 literal with a port', '[2001:db8::1]:8443', '[2001:db8::1]'],
        ['an IPv6 literal without a port', '[2001:db8::1]', '[2001:db8::1]'],
        ['an IPv4 address with a port', '203.0.113.7:443', '203.0.113.7'],
    ])('keeps %s intact apart from the port (%j)', async (_, host, hostname) => {
        stubSiteverifyResult({ success: true, hostname, action: 'cheq-challenge' });
        expectSession(await solvedOn(host));
    });

    it.each([
        ['a lookalike that only shares a prefix', 'shop.com.evil.com'],
        ['a lookalike that only shares a suffix', 'evilshop.com'],
        ['the real host hidden in userinfo', 'shop.com@evil.com'],
        ['the real host hidden in the path', 'evil.com/shop.com'],
        ['the real host hidden in the query', 'evil.com?shop.com'],
        ['another IPv6 literal', '[2001:db8::2]'],
    ])('still rejects %s (%j) after normalizing', async (_, hostname) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubSiteverifyResult({ success: true, hostname, action: 'cheq-challenge' });
        expectRejected(await solvedOn('shop.com'));
    });

    it.each(['https://', 'http://:443', ':443', '/', ' ', '.', 'user@'])(
        'rejects a hostname that normalizes to nothing (%j), even against a request Host that does too', async (value) => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            stubSiteverifyResult({ success: true, hostname: value, action: 'cheq-challenge' });
            const request = buildTurnstileRequest(solvedQuery, null);
            request.headers['host'] = [{ key: 'Host', value }];
            expectRejected(await challenge(request, buildRTIResponse('ray-checks')));
        });

    it('rejects when the request has no Host header, and warns why', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubSiteverifyResult({ success: true, hostname: 'shop.com', action: 'cheq-challenge' });

        expectRejected(await solvedOn(null));
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no Host header'));
    });

    it('rejects an empty Host header, or one that is only a port', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubSiteverifyResult({ success: true, hostname: '', action: 'cheq-challenge' });

        for (const host of ['', ':443']) {
            const request = buildTurnstileRequest(solvedQuery, null);
            request.headers['host'] = [{ key: 'Host', value: host }];
            expectRejected(await challenge(request, buildRTIResponse('ray-checks')));
        }
    });

    it('does not warn when Turnstile itself rejects the token (nothing to compare)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubSiteverifyResult({ success: false, hostname: 'evil.com', 'error-codes': ['invalid-input-response'] });

        expectRejected(await solvedOn('shop.com'));
        expect(warn).not.toHaveBeenCalled();
    });

    it('rejects a result without success, even when hostname and action match', async () => {
        stubSiteverifyResult({ hostname: 'shop.com', action: 'cheq-challenge' });
        expectRejected(await solvedOn('shop.com'));
    });

    it('never logs the token', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        stubSiteverifyResult({ success: true, hostname: 'evil.com', action: '' });

        await solvedOn('shop.com');
        const logged = [...warn.mock.calls, ...log.mock.calls].flat().join('\n');
        expect(warn).toHaveBeenCalled();
        expect(logged).not.toContain('valid-token');
    });

    it('sends request.clientIp as remoteip', async () => {
        const fetchMock = stubSiteverifyResult({ success: true, hostname: 'shop.com', action: 'cheq-challenge' });
        const request = buildTurnstileRequest(solvedQuery, 'shop.com');
        (request as any).clientIp = '203.0.113.7';

        await challenge(request, buildRTIResponse('ray-checks'));
        expect(new URLSearchParams(fetchMock.mock.calls[0][1].body).get('remoteip')).toBe('203.0.113.7');
    });

    it('applies the same checks to a reply to the challenge page (the request isChallengeResponse recognizes)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const reply = buildTurnstileRequest(
            new URLSearchParams({ original_url: '/landing?gclid=abc', request_id: 'ray-page', 'cf-turnstile-response': 'tok' }).toString(),
            'shop.com',
        );
        expect(isChallengeResponse(reply)).toBe(true);

        stubSiteverifyResult({ success: true, hostname: 'shop.com' });
        expectRejected(await challenge(reply, buildRTIResponse('ray-checks')));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("action ''"));

        stubSiteverifyResult({ success: true, hostname: 'shop.com', action: 'cheq-challenge' });
        const accepted = await challenge(reply, buildRTIResponse('ray-checks')) as any;
        expectSession(accepted);
        expect(accepted.headers.location[0].value).toBe('https://shop.com/landing?gclid=abc');
    });
});

// --- Session binding: the session works only from the client that solved the challenge (IP + User-Agent) ---

describe('sessionBindingKey', () => {
    const key = (clientIp: string, binding: SessionBinding, userAgents?: string[]) => {
        const request = buildRequest();
        (request as any).clientIp = clientIp;
        if (userAgents) {
            request.headers['user-agent'] = userAgents.map(value => ({ key: 'User-Agent', value }));
        }
        return sessionBindingKey({ sessionBinding: binding }, request);
    };
    const ipPart = (clientIp: string, ip: SessionBinding['ip']) => JSON.parse(key(clientIp, { ip, userAgent: false }))[0];

    it.each([
        // [client IP, as bound with "exact"]
        // IPv4: as given
        ['1.2.3.4', '1.2.3.4'],
        ['255.255.255.255', '255.255.255.255'],
        ['0.0.0.0', '0.0.0.0'],
        // IPv6: Node's standard spelling (lowercase, no leading zeros, the longest run of zero groups as ::)
        ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3:8d3:1319:8a2e:370:7348'],
        ['2001:DB8:85A3:8D3:1319:8A2E:370:7348', '2001:db8:85a3:8d3:1319:8a2e:370:7348'],
        ['2001:DB8::1', '2001:db8::1'],
        ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
        ['2001:db8:1:2::', '2001:db8:1:2::'],
        ['0:0:0:0:0:0:0:0', '::'],
        ['::1', '::1'],
        ['1::', '1::'],
        ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
        // an IPv4-mapped IPv6 in any spelling is one client, but not that IPv4
        ['::ffff:1.2.3.4', '::ffff:1.2.3.4'],
        ['::FFFF:1.2.3.4', '::ffff:1.2.3.4'],
        ['::ffff:102:304', '::ffff:1.2.3.4'],
        // other dotted tails are written in hex
        ['64:ff9b::1.2.3.4', '64:ff9b::102:304'],
        // a zone id is dropped: it names a network interface of the server, not the client
        ['fe80::1%eth0', 'fe80::1'],
        // anything that is not an IP is bound exactly as given
        ['01.2.3.4', '01.2.3.4'],
        ['1.2.3', '1.2.3'],
        ['not-an-ip', 'not-an-ip'],
        ['', ''],
    ])('binds %j as %j with "exact", and as "" with "none"', (clientIp, exact) => {
        expect(ipPart(clientIp, 'exact')).toBe(exact);
        expect(ipPart(clientIp, 'none')).toBe('');
    });

    it('is JSON [ip, userAgent], with "" for a part that is not bound', () => {
        expect(key('1.2.3.4', { ip: 'exact', userAgent: true }, ['UA 1'])).toBe('["1.2.3.4","UA 1"]');
        expect(key('1.2.3.4', { ip: 'none', userAgent: true }, ['UA 1'])).toBe('["","UA 1"]');
        expect(key('1.2.3.4', { ip: 'exact', userAgent: false }, ['UA 1'])).toBe('["1.2.3.4",""]');
        expect(key('1.2.3.4', { ip: 'none', userAgent: false }, ['UA 1'])).toBe('["",""]');
    });

    it('takes the User-Agent exactly, all entries joined, and "" without one', () => {
        expect(key('1.2.3.4', { ip: 'none', userAgent: true }, ['Mozilla/5.0  (X)'])).toBe('["","Mozilla/5.0  (X)"]');
        expect(key('1.2.3.4', { ip: 'none', userAgent: true }, ['a', 'b'])).toBe('["","a, b"]');
        expect(key('1.2.3.4', { ip: 'none', userAgent: true })).toBe('["",""]');
    });

    it('cannot be made ambiguous by quotes or commas in the User-Agent', () => {
        const a = key('1.2.3.4', { ip: 'exact', userAgent: true }, ['x","y']);
        const b = key('1.2.3.4', { ip: 'exact', userAgent: true }, ['x', 'y']);
        expect(a).not.toBe(b);
        expect(JSON.parse(a)).toEqual(['1.2.3.4', 'x","y']);
    });
});

describe('session binding (validateChallenge)', () => {
    const UA_A = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130';
    const UA_B = 'Mozilla/5.0 (Macintosh) Safari/17';
    const settingsWith = (sessionBinding?: SessionBinding): TurnstileSettings => ({ ...testSettings, sessionBinding });

    const fromClient = (request: CloudFrontRequest, ip: string, ua?: string) => {
        (request as any).clientIp = ip;
        if (ua !== undefined) {
            request.headers['user-agent'] = [{ key: 'User-Agent', value: ua }];
        }
        return request;
    };

    /** Solves the challenge as the client (ip, ua) and returns the `_cq_se=...` cookie and the full Set-Cookie value. */
    const solveAs = async (ip: string, ua: string | undefined, settings: TurnstileSettings = testSettings) => {
        stubSiteverify(true);
        const result = await build(settings).challenge(fromClient(buildTurnstileRequest(solvedQuery), ip, ua), buildRTIResponse('ray-bind')) as any;
        vi.unstubAllGlobals();
        const setCookie: string = result.headers['set-cookie'][0].value;
        return { cookie: setCookie.split(';')[0], setCookie };
    };

    const validFrom = (cookie: string, ip: string, ua: string | undefined, settings: TurnstileSettings = testSettings, isDebug = false) =>
        build(settings).validateChallenge(fromClient(buildRequest(cookie), ip, ua), isDebug);

    it('accepts the same IP and User-Agent', async () => {
        const { cookie } = await solveAs('203.0.113.7', UA_A);
        expect(await validFrom(cookie, '203.0.113.7', UA_A)).toBe(true);
    });

    it.each([
        ['another User-Agent', UA_B],
        ['no User-Agent', undefined],
        ['the same User-Agent with different spacing', UA_A.replace(' ', '  ')],
        ['the same User-Agent in another case', UA_A.toLowerCase()],
    ])('rejects %s from the same IP', async (_, ua) => {
        const { cookie } = await solveAs('203.0.113.7', UA_A);
        expect(await validFrom(cookie, '203.0.113.7', ua)).toBe(false);
    });

    it('rejects a User-Agent where the session was issued without one', async () => {
        const { cookie } = await solveAs('203.0.113.7', undefined);
        expect(await validFrom(cookie, '203.0.113.7', undefined)).toBe(true);
        expect(await validFrom(cookie, '203.0.113.7', UA_A)).toBe(false);
    });

    it.each([
        // [issued from, validated from, valid with "exact"]
        ['the same IPv4', '203.0.113.7', '203.0.113.7', true],
        ['another IPv4 in the same /24', '203.0.113.7', '203.0.113.250', false],
        ['the same IPv6, spelled differently', '2001:db8:1:2::7', '2001:0DB8:1:2:0:0:0:7', true],
        ['another IPv6 in the same /64 (privacy address rotation)', '2001:db8:1:2::7', '2001:db8:1:2:aaaa:bbbb:cccc:dddd', false],
        ['an IPv4-mapped IPv6 of the same IPv4 (another family)', '203.0.113.7', '::ffff:203.0.113.7', false],
        ['an IPv6 after IPv4 (dual-stack switch)', '203.0.113.7', '2001:db8:1:2::7', false],
    ])('%s: valid with "exact" = %s', async (_, issuedIp, validatedIp, expected) => {
        const settings = settingsWith({ ip: 'exact', userAgent: true });
        const { cookie } = await solveAs(issuedIp, UA_A, settings);
        expect(await validFrom(cookie, validatedIp, UA_A, settings)).toBe(expected);
    });

    it('ip "none" accepts any IP (dual-stack included) but still binds the User-Agent', async () => {
        const settings = settingsWith({ ip: 'none', userAgent: true });
        const { cookie } = await solveAs('203.0.113.7', UA_A, settings);
        expect(await validFrom(cookie, '198.51.100.1', UA_A, settings)).toBe(true);
        expect(await validFrom(cookie, '2001:db8::1', UA_A, settings)).toBe(true);
        expect(await validFrom(cookie, '203.0.113.7', UA_B, settings)).toBe(false);
    });

    it('userAgent false accepts any User-Agent but still binds the IP', async () => {
        const settings = settingsWith({ ip: 'exact', userAgent: false });
        const { cookie } = await solveAs('203.0.113.7', UA_A, settings);
        expect(await validFrom(cookie, '203.0.113.7', UA_B, settings)).toBe(true);
        expect(await validFrom(cookie, '203.0.113.7', undefined, settings)).toBe(true);
        expect(await validFrom(cookie, '198.51.100.1', UA_A, settings)).toBe(false);
    });

    it('ip "none" and userAgent false: the session works from any client (as before binding)', async () => {
        const settings = settingsWith({ ip: 'none', userAgent: false });
        const { cookie } = await solveAs('203.0.113.7', UA_A, settings);
        expect(await validFrom(cookie, '198.51.100.1', UA_B, settings)).toBe(true);
    });

    it('binds the session in headers (x-cheq-challenge + x-cheq-ray-id) the same way', async () => {
        const { cookie } = await solveAs('203.0.113.7', UA_A);
        const [token, rayId] = cookie.slice('_cq_se='.length).split('|');
        const headerSession = (ip: string, ua: string) =>
            validateChallenge(fromClient(buildRequest(undefined, rayId, token), ip, ua), false);
        expect(await headerSession('203.0.113.7', UA_A)).toBe(true);
        expect(await headerSession('203.0.113.7', UA_B)).toBe(false);
        expect(await headerSession('198.51.100.1', UA_A)).toBe(false);
    });

    it('rejects a session signed the pre-binding way (HMAC over ["se", expiresAt, rayId], no binding key)', async () => {
        const expiresAt = Date.now() + 60_000;
        const legacy = createHmac('sha256', testSettings.sessionSigningSecret).update(JSON.stringify(['se', expiresAt, 'ray-old'])).digest('hex').slice(0, 32);
        expect(await validFrom(`_cq_se=${expiresAt}.${legacy}|ray-old`, '1.2.3.4', undefined)).toBe(false);
        // the same expiry and rayId signed with the binding key are accepted: only the missing key is rejected
        const bound = createHmac('sha256', testSettings.sessionSigningSecret).update(JSON.stringify(['se', expiresAt, 'ray-old', BUILD_REQUEST_BINDING])).digest('hex').slice(0, 32);
        expect(await validFrom(`_cq_se=${expiresAt}.${bound}|ray-old`, '1.2.3.4', undefined)).toBe(true);
    });

    it('ends open sessions when sessionBinding changes (the binding key changes)', async () => {
        const { cookie } = await solveAs('203.0.113.7', UA_A, settingsWith({ ip: 'exact', userAgent: true }));
        expect(await validFrom(cookie, '203.0.113.7', UA_A, settingsWith({ ip: 'none', userAgent: true }))).toBe(false);
        expect(await validFrom(cookie, '203.0.113.7', UA_A, settingsWith({ ip: 'exact', userAgent: false }))).toBe(false);
    });

    it('still rejects a tampered expiry or rayId from the right client', async () => {
        const { cookie } = await solveAs('203.0.113.7', UA_A);
        const [, expiresAt, signature, rayId] = cookie.match(/^_cq_se=(\d+)\.([0-9a-f]+)\|(.+)$/)!;
        expect(await validFrom(cookie, '203.0.113.7', UA_A)).toBe(true);
        expect(await validFrom(`_cq_se=${Number(expiresAt) + 1}.${signature}|${rayId}`, '203.0.113.7', UA_A)).toBe(false);
        expect(await validFrom(`_cq_se=${expiresAt}.${signature}|${rayId}x`, '203.0.113.7', UA_A)).toBe(false);
    });

    it('never puts the IP or the User-Agent in the cookie', async () => {
        const ua = 'Mozilla/5.0 (UniqueBrowser/42)';
        for (const ip of ['203.0.113.7', '2001:db8:1:2::7']) {
            const { setCookie } = await solveAs(ip, ua, settingsWith({ ip: 'exact', userAgent: true }));
            expect(setCookie).toMatch(/^_cq_se=\d+\.[0-9a-f]{32}\|ray-bind; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=300$/);
            expect(setCookie).not.toContain(ip);
            expect(setCookie).not.toContain('UniqueBrowser');
        }
    });

    it('logs a mismatch in debug without the IP or the User-Agent', async () => {
        const ua = 'Mozilla/5.0 (UniqueBrowser/42)';
        const { cookie } = await solveAs('203.0.113.7', ua);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(await validFrom(cookie, '198.51.100.99', 'Mozilla/5.0 (OtherBrowser/1)', testSettings, true)).toBe(false);

        const lines = [...log.mock.calls, ...warn.mock.calls].map(call => call.map(String).join(' '));
        expect(lines).toContain('[validateChallenge] signature match: false (session binding mismatch (ip or user-agent), or a forged or tampered session)');
        for (const secret of ['203.0.113', '198.51.100', 'UniqueBrowser', 'OtherBrowser']) {
            expect(lines.join('\n')).not.toContain(secret);
        }
    });

    describe('the User-Agent "Amazon CloudFront" (origin-request without the viewer\'s User-Agent forwarded)', () => {
        it('warns once per instance (cold start), and the session still validates', async () => {
            const settings = settingsWith({ ip: 'exact', userAgent: true });
            const { cookie } = await solveAs('203.0.113.7', 'Amazon CloudFront', settings);
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const callbacks = build(settings);
            const validate = () => callbacks.validateChallenge(fromClient(buildRequest(cookie), '203.0.113.7', 'Amazon CloudFront'), false);

            expect(await validate()).toBe(true);
            expect(await validate()).toBe(true);
            expect(await callbacks.validateChallenge(fromClient(buildRequest(), '203.0.113.7', 'Amazon CloudFront'), false)).toBe(false);

            expect(warn).toHaveBeenCalledOnce();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("User-Agent is 'Amazon CloudFront'"));
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("forward the viewer's User-Agent"));
        });

        it.each([
            ['userAgent binding is off', { ip: 'exact', userAgent: false } as SessionBinding, 'Amazon CloudFront'],
            ['the User-Agent is only similar', { ip: 'exact', userAgent: true } as SessionBinding, 'Amazon CloudFront/1.0'],
            ['the User-Agent is a browser', { ip: 'exact', userAgent: true } as SessionBinding, UA_A],
        ])('does not warn when %s', async (_, sessionBinding, ua) => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            await build(settingsWith(sessionBinding)).validateChallenge(fromClient(buildRequest(), '203.0.113.7', ua), false);
            expect(warn).not.toHaveBeenCalled();
        });
    });
});

describe('createTurnstileChallenge sessionBinding', () => {
    // The default binds the exact IP and the User-Agent: what every check below expects of a fallback.
    const behavesAsDefault = async (callbacks: Callbacks) => {
        stubSiteverify(true);
        const request = buildTurnstileRequest(solvedQuery);
        request.headers['user-agent'] = [{ key: 'User-Agent', value: 'UA' }];
        const result = await callbacks.challenge(request, buildRTIResponse('ray-default')) as any;
        vi.unstubAllGlobals();
        const cookie: string = result.headers['set-cookie'][0].value.split(';')[0];
        const from = (ip: string, ua: string) => {
            const next = buildRequest(cookie);
            (next as any).clientIp = ip;
            next.headers['user-agent'] = [{ key: 'User-Agent', value: ua }];
            return callbacks.validateChallenge(next, false);
        };
        return {
            sameClient: await from('1.2.3.4', 'UA'),
            otherIp: await from('1.2.3.5', 'UA'),
            otherUserAgent: await from('1.2.3.4', 'UA2'),
        };
    };
    const DEFAULT_BEHAVIOR = { sameClient: true, otherIp: false, otherUserAgent: false };

    it('uses the default { ip: "exact", userAgent: true } without warning when sessionBinding is not set', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await behavesAsDefault(build({ ...testSettings, sessionBinding: undefined }))).toEqual(DEFAULT_BEHAVIOR);
        expect(warn).not.toHaveBeenCalled();
    });

    it.each([
        ['null', null],
        ['a string', 'exact'],
        ['an array', ['exact', true]],
        ['an unknown ip mode', { ip: 'subnet', userAgent: true }],
        ['an ip mode in another case', { ip: 'EXACT', userAgent: true }],
        ['no ip', { userAgent: true }],
        ['no userAgent', { ip: 'exact' }],
        ['a userAgent that is not a boolean', { ip: 'none', userAgent: 'yes' }],
        ['an empty object', {}],
    ])('warns once and uses the default for %s', async (_, sessionBinding) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const callbacks = build({ ...testSettings, sessionBinding: sessionBinding as unknown as SessionBinding });
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('[turnstile] invalid sessionBinding'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('using {"ip":"exact","userAgent":true}'));
        expect(await behavesAsDefault(callbacks)).toEqual(DEFAULT_BEHAVIOR);
    });

    it.each([
        [{ ip: 'exact', userAgent: true }, { sameClient: true, otherIp: false, otherUserAgent: false }],
        [{ ip: 'exact', userAgent: false }, { sameClient: true, otherIp: false, otherUserAgent: true }],
        [{ ip: 'none', userAgent: true }, { sameClient: true, otherIp: true, otherUserAgent: false }],
        [{ ip: 'none', userAgent: false }, { sameClient: true, otherIp: true, otherUserAgent: true }],
    ] as [SessionBinding, object][])('keeps a valid %j without warning', async (sessionBinding, expected) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await behavesAsDefault(build({ ...testSettings, sessionBinding }))).toEqual(expected);
        expect(warn).not.toHaveBeenCalled();
    });

    it('is not affected by a later change to the settings object', async () => {
        const sessionBinding: SessionBinding = { ip: 'exact', userAgent: true };
        const callbacks = build({ ...testSettings, sessionBinding });
        sessionBinding.ip = 'none';
        expect(await behavesAsDefault(callbacks)).toEqual(DEFAULT_BEHAVIOR);
    });
});

// --- Every sessionBinding setting × every kind of client change ---

describe('session binding: every setting', () => {
    const UA_A = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130';
    const UA_B = 'Mozilla/5.0 (Macintosh) Safari/17';

    const ALL_BINDINGS: SessionBinding[] = [
        { ip: 'exact', userAgent: true },
        { ip: 'exact', userAgent: false },
        { ip: 'none', userAgent: true },
        { ip: 'none', userAgent: false },
    ];

    const fromClient = (request: CloudFrontRequest, ip: string, ua: string | undefined) => {
        (request as any).clientIp = ip;
        if (ua !== undefined) {
            request.headers['user-agent'] = [{ key: 'User-Agent', value: ua }];
        }
        return request;
    };
    const solveAs = async (ip: string, ua: string | undefined, sessionBinding: SessionBinding) => {
        stubSiteverify(true);
        const result = await build({ ...testSettings, sessionBinding }).challenge(fromClient(buildTurnstileRequest(solvedQuery), ip, ua), buildRTIResponse('ray-all')) as any;
        vi.unstubAllGlobals();
        return result.headers['set-cookie'][0].value.split(';')[0] as string;
    };
    const validFrom = (cookie: string, ip: string, ua: string | undefined, sessionBinding: SessionBinding) =>
        build({ ...testSettings, sessionBinding }).validateChallenge(fromClient(buildRequest(cookie), ip, ua), false);

    // Each change of client, from the client that solved the challenge (always UA_A). Whether the IP change is accepted
    // depends on the ip mode only ("none" accepts every IP); a User-Agent change is accepted only with userAgent: false.
    const CHANGES: { name: string; issuedIp: string; ip: string; ua: string | undefined; exact: boolean }[] = [
        { name: 'nothing (the same client)', issuedIp: '203.0.113.7', ip: '203.0.113.7', ua: UA_A, exact: true },
        { name: 'another IPv4 in the same /24', issuedIp: '203.0.113.7', ip: '203.0.113.250', ua: UA_A, exact: false },
        { name: 'the same IPv4 as IPv4-mapped IPv6', issuedIp: '203.0.113.7', ip: '::ffff:203.0.113.7', ua: UA_A, exact: false },
        { name: 'IPv4 → IPv6 (dual-stack)', issuedIp: '203.0.113.7', ip: '2001:db8:1:2::7', ua: UA_A, exact: false },
        { name: 'the same IPv6, spelled differently', issuedIp: '2001:db8:1:2::7', ip: '2001:0DB8:0001:0002:0:0:0:7', ua: UA_A, exact: true },
        { name: 'another IPv6 in the same /64', issuedIp: '2001:db8:1:2::7', ip: '2001:db8:1:2:ffff:1:2:3', ua: UA_A, exact: false },
        { name: 'another User-Agent', issuedIp: '203.0.113.7', ip: '203.0.113.7', ua: UA_B, exact: true },
        { name: 'no User-Agent', issuedIp: '203.0.113.7', ip: '203.0.113.7', ua: undefined, exact: true },
        { name: 'another User-Agent and another IP', issuedIp: '203.0.113.7', ip: '198.51.100.7', ua: UA_B, exact: false },
    ];

    describe.each(ALL_BINDINGS)('with %j', (sessionBinding) => {
        it.each(CHANGES)('a session from the same client after $name', async (change) => {
            const ipAccepted = sessionBinding.ip === 'none' || change.exact;
            const uaAccepted = !sessionBinding.userAgent || change.ua === UA_A;
            const cookie = await solveAs(change.issuedIp, UA_A, sessionBinding);
            expect(await validFrom(cookie, change.ip, change.ua, sessionBinding)).toBe(ipAccepted && uaAccepted);
        });

        it('binds the header session (x-cheq-challenge + x-cheq-ray-id) exactly like the cookie', async () => {
            const cookie = await solveAs('203.0.113.7', UA_A, sessionBinding);
            const [token, rayId] = cookie.slice('_cq_se='.length).split('|');
            const callbacks = build({ ...testSettings, sessionBinding });
            for (const change of CHANGES.filter(c => c.issuedIp === '203.0.113.7')) {
                const viaCookie = await callbacks.validateChallenge(fromClient(buildRequest(cookie), change.ip, change.ua), false);
                const viaHeaders = await callbacks.validateChallenge(fromClient(buildRequest(undefined, rayId, token), change.ip, change.ua), false);
                expect(viaHeaders).toBe(viaCookie);
            }
        });

        it('rejects a session issued before session binding existed (one more CAPTCHA after the deploy)', async () => {
            const expiresAt = Date.now() + 60_000;
            const legacy = createHmac('sha256', testSettings.sessionSigningSecret).update(JSON.stringify(['se', expiresAt, 'ray-old'])).digest('hex').slice(0, 32);
            expect(await validFrom(`_cq_se=${expiresAt}.${legacy}|ray-old`, '203.0.113.7', UA_A, sessionBinding)).toBe(false);
            expect(await validFrom(`_cq_se=${expiresAt}.${legacy}|ray-old`, '203.0.113.7', undefined, sessionBinding)).toBe(false);
        });

        it('still rejects a tampered expiry, rayId or signature from the same client', async () => {
            const cookie = await solveAs('203.0.113.7', UA_A, sessionBinding);
            const [, expiresAt, signature, rayId] = cookie.match(/^_cq_se=(\d+)\.([0-9a-f]{32})\|(.+)$/)!;
            const flipped = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
            expect(await validFrom(cookie, '203.0.113.7', UA_A, sessionBinding)).toBe(true);
            expect(await validFrom(`_cq_se=${Number(expiresAt) + 1}.${signature}|${rayId}`, '203.0.113.7', UA_A, sessionBinding)).toBe(false);
            expect(await validFrom(`_cq_se=${expiresAt}.${signature}|other-ray`, '203.0.113.7', UA_A, sessionBinding)).toBe(false);
            expect(await validFrom(`_cq_se=${expiresAt}.${flipped}|${rayId}`, '203.0.113.7', UA_A, sessionBinding)).toBe(false);
        });

        it('rejects an expired session from the same client', async () => {
            const cookie = await solveAs('203.0.113.7', UA_A, sessionBinding);
            const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000);
            expect(await validFrom(cookie, '203.0.113.7', UA_A, sessionBinding)).toBe(false);
            later.mockRestore();
        });

        it('keeps the cookie format and puts neither the IP nor the User-Agent in it', async () => {
            stubSiteverify(true);
            const ua = 'Mozilla/5.0 (UniqueBrowser/42)';
            const result = await build({ ...testSettings, sessionBinding }).challenge(fromClient(buildTurnstileRequest(solvedQuery), '203.0.113.7', ua), buildRTIResponse('ray-all')) as any;
            const setCookie: string = result.headers['set-cookie'][0].value;
            expect(setCookie).toMatch(/^_cq_se=\d+\.[0-9a-f]{32}\|ray-all; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=300$/);
            expect(setCookie).not.toContain('203.0.113');
            expect(setCookie).not.toContain('UniqueBrowser');
        });

        it(`${sessionBinding.userAgent ? 'warns once' : 'does not warn'} about the User-Agent "Amazon CloudFront"`, async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const callbacks = build({ ...testSettings, sessionBinding });
            for (let i = 0; i < 3; i++) {
                await callbacks.validateChallenge(fromClient(buildRequest(), '203.0.113.7', 'Amazon CloudFront'), false);
            }
            expect(warn).toHaveBeenCalledTimes(sessionBinding.userAgent ? 1 : 0);
        });
    });

    // A session is bound under the setting it was issued with: any other setting computes another key, so changing
    // sessionBinding (on, off, or between modes) ends open sessions: a new CAPTCHA once.
    describe.each(ALL_BINDINGS)('issued with %j', (issuedWith) => {
        it.each(ALL_BINDINGS)('is valid with %j only when it is the same setting', async (validatedWith) => {
            const cookie = await solveAs('203.0.113.7', UA_A, issuedWith);
            const same = issuedWith.ip === validatedWith.ip && issuedWith.userAgent === validatedWith.userAgent;
            expect(await validFrom(cookie, '203.0.113.7', UA_A, validatedWith)).toBe(same);
        });
    });

    it('{ ip: "none", userAgent: false } turns binding off: any client, any IP version, with or without a User-Agent', async () => {
        const off: SessionBinding = { ip: 'none', userAgent: false };
        const cookie = await solveAs('203.0.113.7', UA_A, off);
        for (const [ip, ua] of [['198.51.100.7', UA_B], ['2001:db8::1', undefined], ['not-an-ip', 'curl/8.0'], ['', '']] as const) {
            expect(await validFrom(cookie, ip, ua, off)).toBe(true);
        }
    });
});

// --- Session binding: edge cases ---

describe('session binding: edge cases', () => {
    const DEFAULT: SessionBinding = { ip: 'exact', userAgent: true };
    const requestWith = (clientIp: unknown, userAgents?: string[], cookie?: string) => {
        const request = buildRequest(cookie);
        (request as any).clientIp = clientIp;
        if (userAgents) {
            request.headers['user-agent'] = userAgents.map(value => ({ key: 'User-Agent', value }));
        }
        return request;
    };
    const keyOf = (clientIp: unknown, userAgents?: string[], binding: SessionBinding = DEFAULT) =>
        sessionBindingKey({ sessionBinding: binding }, requestWith(clientIp, userAgents));
    const sameKey = (a: [unknown, string[]?], b: [unknown, string[]?], binding: SessionBinding = DEFAULT) =>
        keyOf(a[0], a[1], binding) === keyOf(b[0], b[1], binding);

    /** Solves as (clientIp, userAgents) and validates the cookie from (clientIp2, userAgents2), each with a fresh instance. */
    const roundTrip = async (issued: [unknown, string[]?], validated: [unknown, string[]?], binding: SessionBinding = DEFAULT) => {
        stubSiteverify(true);
        const reply = buildTurnstileRequest(solvedQuery);
        (reply as any).clientIp = issued[0];
        if (issued[1]) {
            reply.headers['user-agent'] = issued[1].map(value => ({ key: 'User-Agent', value }));
        }
        const result = await build({ ...testSettings, sessionBinding: binding }).challenge(reply, buildRTIResponse('ray-edge')) as any;
        vi.unstubAllGlobals();
        const cookie: string = result.headers['set-cookie'][0].value.split(';')[0];
        return build({ ...testSettings, sessionBinding: binding }).validateChallenge(requestWith(validated[0], validated[1], cookie), false);
    };

    describe('neighbouring addresses are other clients', () => {
        it.each([
            ['the next IPv4 address', '203.0.113.7', '203.0.113.8'],
            ['the next IPv6 address', '2001:db8:1:2::7', '2001:db8:1:2::8'],
            ['two IPv6 that differ only in the last bit', '2001:db8:1:2:3:4:5:6', '2001:db8:1:2:3:4:5:7'],
            ['two IPv6 that differ only in the first bit', '2001:db8:1:2:3:4:5:6', 'a001:db8:1:2:3:4:5:6'],
            ['IPv4 and an IPv6 whose groups spell the same digits', '1.2.3.4', '1:2:3:4::'],
            ['IPv4 and an IPv6 that ends in the same digits', '1.2.3.4', '::102:304'],
        ])('%s', async (_, a, b) => {
            expect(sameKey([a], [b])).toBe(false);
            expect(await roundTrip([a, ['UA']], [b, ['UA']])).toBe(false);
            expect(await roundTrip([a, ['UA']], [a, ['UA']])).toBe(true);
        });
    });

    describe('IPv6 spellings', () => {
        it.each([
            ['upper and lower case', '2001:DB8::ABCD', '2001:db8::abcd'],
            ['leading zeros', '2001:0db8::0001', '2001:db8::1'],
            ['a mapped IPv4 in hex, compressed and written out', '::FFFF:CB00:7107', '0000:0000:0000:0000:0000:ffff:cb00:7107'],
            ['a mapped IPv4 with a dotted tail and in hex', '::ffff:203.0.113.7', '::ffff:cb00:7107'],
            ['with and without a zone id', 'fe80::1%eth0', 'fe80::1'],
            ['zero groups written out vs compressed', '2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
            ['the compression in another place', '2001:db8:0:0:1::1', '2001:db8::1:0:0:1'],
        ])('%s is the same client (exact)', (_, a, b) => {
            expect(sameKey([a], [b], { ip: 'exact', userAgent: false })).toBe(true);
        });

        it.each([
            ['an IPv4-mapped IPv6 in hex is not that IPv4', '::ffff:cb00:7107', '203.0.113.7'],
            ['an IPv4-mapped IPv6 with a dotted tail is not that IPv4', '::ffff:203.0.113.7', '203.0.113.7'],
            ['IPv4-translated (::ffff:0:a.b.c.d) is not IPv4-mapped', '::ffff:0:203.0.113.7', '203.0.113.7'],
            ['IPv4-compatible (::a.b.c.d) is not IPv4-mapped', '::203.0.113.7', '203.0.113.7'],
            ['NAT64 (64:ff9b::a.b.c.d) is not IPv4-mapped', '64:ff9b::203.0.113.7', '203.0.113.7'],
        ])('%s', (_, a, b) => {
            expect(sameKey([a], [b], { ip: 'exact', userAgent: false })).toBe(false);
        });
    });

    describe('IPs that do not parse are bound exactly as given', () => {
        it.each([
            ['with a port', '203.0.113.7:443'],
            ['in brackets', '[2001:db8::1]'],
            ['with spaces', ' 203.0.113.7 '],
            ['an octet above 255', '203.0.113.256'],
            ['JSON-like', '"],["x'],
        ])('%s (%j): only the identical string matches, and it does not throw', async (_, ip) => {
            expect(JSON.parse(keyOf(ip, undefined, { ip: 'exact', userAgent: false }))).toEqual([ip, '']);
            expect(await roundTrip([ip, ['UA']], [ip, ['UA']])).toBe(true);
            expect(await roundTrip([ip, ['UA']], ['203.0.113.7', ['UA']])).toBe(false);
        });

        it('a missing clientIp binds consistently and is not the same as an IP of "" or ip "none"', async () => {
            expect(await roundTrip([undefined, ['UA']], [undefined, ['UA']])).toBe(true);
            expect(await roundTrip([undefined, ['UA']], ['203.0.113.7', ['UA']])).toBe(false);
            expect(keyOf(undefined, ['UA'])).not.toBe(keyOf('', ['UA']));
            expect(keyOf(undefined, ['UA'])).not.toBe(keyOf('203.0.113.7', ['UA'], { ip: 'none', userAgent: true }));
        });
    });

    describe('User-Agent', () => {
        it('keeps the order of several User-Agent headers', () => {
            expect(sameKey(['1.2.3.4', ['a', 'b']], ['1.2.3.4', ['b', 'a']])).toBe(false);
        });

        it('treats two headers like one header with ", " (how HTTP combines repeated headers)', () => {
            expect(sameKey(['1.2.3.4', ['a', 'b']], ['1.2.3.4', ['a, b']])).toBe(true);
        });

        it('treats an empty User-Agent like a missing one', async () => {
            expect(sameKey(['1.2.3.4', ['']], ['1.2.3.4'])).toBe(true);
            expect(await roundTrip(['1.2.3.4'], ['1.2.3.4', ['']])).toBe(true);
        });

        it('compares exactly: trailing space, case and Unicode count', () => {
            expect(sameKey(['1.2.3.4', ['UA']], ['1.2.3.4', ['UA ']])).toBe(false);
            expect(sameKey(['1.2.3.4', ['UA']], ['1.2.3.4', ['ua']])).toBe(false);
            expect(sameKey(['1.2.3.4', ['Café']], ['1.2.3.4', ['Café']])).toBe(false); // é vs e + combining accent
        });

        it.each([
            ['a long User-Agent (8 KB)', 'Mozilla/5.0 '.repeat(700)],
            ['Unicode', 'Mozilla/5.0 (ünïcödé; 测试) 🚀'],
            ['quotes, backslashes and brackets', 'a"b\\c]["d'],
            ['CloudFront\'s own User-Agent', 'Amazon CloudFront'],
        ])('works with %s', async (_, ua) => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            expect(await roundTrip(['1.2.3.4', [ua]], ['1.2.3.4', [ua]])).toBe(true);
            expect(await roundTrip(['1.2.3.4', [ua]], ['1.2.3.4', [`${ua}x`]])).toBe(false);
        });
    });

    describe('settings', () => {
        it('ignores extra properties of sessionBinding, without a warning', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const binding = { ip: 'none', userAgent: false, extra: 1 } as SessionBinding;
            expect(await roundTrip(['1.2.3.4', ['A']], ['5.6.7.8', ['B']], binding)).toBe(true);
            expect(warn).not.toHaveBeenCalled();
        });

        it('accepts a sessionBinding without a prototype', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const binding = Object.assign(Object.create(null), { ip: 'exact', userAgent: true }) as SessionBinding;
            expect(await roundTrip(['1.2.3.4', ['A']], ['1.2.3.5', ['A']], binding)).toBe(false);
            expect(await roundTrip(['1.2.3.4', ['A']], ['1.2.3.4', ['A']], binding)).toBe(true);
            expect(warn).not.toHaveBeenCalled();
        });

        it('a session issued by one Lambda container validates in another with the same settings', async () => {
            // roundTrip already signs and validates with two separate instances; make it explicit with the default too
            expect(await roundTrip(['203.0.113.7', ['UA']], ['203.0.113.7', ['UA']])).toBe(true);
            expect(await roundTrip(['2001:db8:1:2::7', ['UA']], ['2001:DB8:1:2:0:0:0:7', ['UA']])).toBe(true);
        });

        it('a different sessionSigningSecret rejects the session even from the same client', async () => {
            stubSiteverify(true);
            const result = await build(testSettings).challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse('ray-edge')) as any;
            const cookie: string = result.headers['set-cookie'][0].value.split(';')[0];
            expect(await build(testSettings).validateChallenge(buildRequest(cookie), false)).toBe(true);
            expect(await build({ ...testSettings, sessionSigningSecret: 'another-secret' }).validateChallenge(buildRequest(cookie), false)).toBe(false);
        });
    });

    describe('validation', () => {
        it('never throws on a binding mismatch, with or without debug', async () => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            for (const isDebug of [false, true]) {
                await expect(roundTrip(['1.2.3.4', ['A']], ['9.9.9.9', ['B']])).resolves.toBe(false);
                await expect(build(testSettings).validateChallenge(requestWith('9.9.9.9', ['B'], '_cq_se=1.2|r'), isDebug)).resolves.toBe(false);
            }
        });

        it('checks the expiry before the binding: an expired session is logged as expired, not as a mismatch', async () => {
            stubSiteverify(true);
            const result = await build(testSettings).challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse('ray-edge')) as any;
            const cookie: string = result.headers['set-cookie'][0].value.split(';')[0];
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});
            vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000);

            expect(await build(testSettings).validateChallenge(requestWith('9.9.9.9', ['B'], cookie), true)).toBe(false);

            const lines = log.mock.calls.map(call => String(call[0]));
            expect(lines.some(line => line.includes('session token expired'))).toBe(true);
            expect(lines.some(line => line.includes('session binding mismatch'))).toBe(false);
        });

        it('logs "signature match: true" without the IP or User-Agent for a valid session', async () => {
            const ua = 'Mozilla/5.0 (UniqueBrowser/42)';
            stubSiteverify(true);
            const reply = buildTurnstileRequest(solvedQuery);
            reply.headers['user-agent'] = [{ key: 'User-Agent', value: ua }];
            (reply as any).clientIp = '203.0.113.7';
            const result = await build(testSettings).challenge(reply, buildRTIResponse('ray-edge')) as any;
            const cookie: string = result.headers['set-cookie'][0].value.split(';')[0];
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});

            expect(await build(testSettings).validateChallenge(requestWith('203.0.113.7', [ua], cookie), true)).toBe(true);

            const text = log.mock.calls.map(call => call.map(String).join(' ')).join('\n');
            expect(text).toContain('[validateChallenge] signature match: true');
            expect(text).not.toContain('203.0.113');
            expect(text).not.toContain('UniqueBrowser');
        });

        it('compares the signature in constant time with the bound key (timingSafeEqual)', async () => {
            stubSiteverify(true);
            const result = await build(testSettings).challenge(buildTurnstileRequest(solvedQuery), buildRTIResponse('ray-edge')) as any;
            const cookie: string = result.headers['set-cookie'][0].value.split(';')[0];
            vi.mocked(timingSafeEqual).mockClear();
            expect(await build(testSettings).validateChallenge(requestWith('9.9.9.9', ['B'], cookie), false)).toBe(false);
            expect(timingSafeEqual).toHaveBeenCalledOnce();
        });
    });
});

// --- The relative Location fallback of returnLocation (no Host header) ---

// Unreachable through the public flow today: without a Host header verifyTurnstileToken always rejects the token, so no
// redirect is built. The branch stays as a fallback (8b's retry redirect reaches it), so test it by letting the host
// check pass without a Host header.
describe('returnLocation without a Host header (fallback)', () => {
    const verifiedWithoutHost = async (querystring: string, uri = '/page') => {
        vi.spyOn(RTIStatelessUtils, 'normalizeHost').mockReturnValue('example.com');
        stubSiteverify(true);
        const request = buildTurnstileRequest(querystring, null);
        (request as any).uri = uri;
        return await challenge(request, buildRTIResponse()) as any;
    };

    it.each([
        ['original_url, path and query', { original_url: '/landing?x=1' }, '/page', '/landing?x=1'],
        ['original_url with a fragment', { original_url: '/landing#top' }, '/page', '/landing#top'],
        ['the request URI when there is no original_url', {}, '/page', '/page'],
        ['the request URI for a hostile original_url', { original_url: '//evil.com/x' }, '/page', '/page'],
        ['the request URI for an original_url with CR/LF', { original_url: '/a\r\nSet-Cookie: x=1' }, '/page', '/page'],
    ])('uses a relative Location: %s', async (_, fields, uri, location) => {
        const qs = new URLSearchParams({ 'cf-turnstile-response': 'tok', ...fields }).toString();
        const result = await verifiedWithoutHost(qs, uri);
        expect(result.status).toBe('302');
        expect(result.headers.location[0].value).toBe(location);
        expect(result.headers['set-cookie'][0].value).toMatch(/^_cq_se=/);
    });
});

// --- Randomized (seeded, so every run is the same): every valid spelling of an address binds to the same client ---

describe('session binding: every spelling of an address (seeded random)', () => {
    // mulberry32: a tiny deterministic PRNG, so a failure always reproduces.
    const prng = (seed: number) => () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const ITERATIONS = 3000;

    const bind = (clientIp: string, ip: SessionBinding['ip']) => {
        const request = buildRequest();
        (request as any).clientIp = clientIp;
        return JSON.parse(sessionBindingKey({ sessionBinding: { ip, userAgent: false } }, request))[0] as string;
    };

    /** A random valid spelling of 8 groups: random case, leading zeros, :: over a random run of zero groups. */
    const spellIpv6 = (groups: number[], random: () => number): string => {
        const caseOf = (hex: string) => {
            const mode = Math.floor(random() * 3);
            return mode === 0 ? hex : mode === 1 ? hex.toUpperCase() : [...hex].map(c => (random() < 0.5 ? c.toUpperCase() : c)).join('');
        };
        const words = groups.map(g => caseOf(g.toString(16).padStart(1 + Math.floor(random() * 4), '0')));
        // the zero-group runs among the hex groups; maybe compress one (any sub-run of it)
        const runs: [number, number][] = [];
        for (let i = 0; i < words.length; i++) {
            if (groups[i] === 0) {
                let j = i;
                while (j + 1 < words.length && groups[j + 1] === 0) j++;
                runs.push([i, j]);
                i = j;
            }
        }
        if (runs.length > 0 && random() < 0.8) {
            const [start, end] = runs[Math.floor(random() * runs.length)];
            const from = start + Math.floor(random() * (end - start + 1));
            const to = from + Math.floor(random() * (end - from + 1));
            return `${words.slice(0, from).join(':')}::${words.slice(to + 1).join(':')}`;
        }
        return words.join(':');
    };
    // The fully written form: eight groups, no compression, every spelling must bind like it
    const fullForm = (groups: number[]) => groups.map(g => g.toString(16)).join(':');

    it(`IPv6: ${ITERATIONS} random addresses, each in 4 random spellings, all bind to the same client`, () => {
        const random = prng(0xC0FFEE);
        for (let n = 0; n < ITERATIONS; n++) {
            // groups with many zeros, so :: shows up in every form
            const groups = Array.from({ length: 8 }, () => (random() < 0.4 ? 0 : Math.floor(random() * 0x10000)));
            const exact = bind(fullForm(groups), 'exact');
            expect(isIPv6(exact), exact).toBe(true);
            for (let s = 0; s < 4; s++) {
                const spelled = spellIpv6(groups, random);
                expect(isIPv6(spelled), spelled).toBe(true);
                expect(bind(spelled, 'exact'), spelled).toBe(exact);
            }
        }
    });

    it(`IPv4: ${ITERATIONS} random addresses bind as given`, () => {
        const random = prng(0xFACE);
        for (let n = 0; n < ITERATIONS; n++) {
            const ip = Array.from({ length: 4 }, () => Math.floor(random() * 256)).join('.');
            expect(isIPv4(ip)).toBe(true);
            expect(bind(ip, 'exact')).toBe(ip);
        }
    });

    it(`never binds an IPv4 and an IPv6 to the same client, even ::a.b.c.d: ${ITERATIONS} random pairs`, () => {
        const random = prng(0xABBA);
        for (let n = 0; n < ITERATIONS; n++) {
            const o = Array.from({ length: 4 }, () => Math.floor(random() * 256));
            // half the IPv6 are ::a.b.c.d (the IPv4 inside an IPv6), half are random
            const groups = random() < 0.5
                ? [0, 0, 0, 0, 0, 0, (o[0] << 8) | o[1], (o[2] << 8) | o[3]]
                : Array.from({ length: 8 }, () => Math.floor(random() * 0x10000));
            expect(bind(o.join('.'), 'exact')).not.toBe(bind(spellIpv6(groups, random), 'exact'));
        }
    });

    it(`ip "none" binds every address to "": ${ITERATIONS} random IPv4 and IPv6`, () => {
        const random = prng(0x5EED);
        for (let n = 0; n < ITERATIONS; n++) {
            const v4 = Array.from({ length: 4 }, () => Math.floor(random() * 256)).join('.');
            const v6 = spellIpv6(Array.from({ length: 8 }, () => Math.floor(random() * 0x10000)), random);
            expect(bind(v4, 'none')).toBe('');
            expect(bind(v6, 'none')).toBe('');
        }
    });
});
