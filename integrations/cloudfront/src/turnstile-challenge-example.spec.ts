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
            createHmac('sha256', testSettings.sessionSigningSecret).update(JSON.stringify(['se', expiresAt, rayId])).digest('hex').slice(0, 32);
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
