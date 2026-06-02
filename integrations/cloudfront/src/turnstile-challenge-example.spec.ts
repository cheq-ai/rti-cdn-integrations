import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
// @ts-ignore — node:crypto is not in the tsconfig types but is available at runtime in Node 20
import { webcrypto } from 'node:crypto';
import { turnstileValidateChallengeExample, turnstileChallengeExample } from './turnstile-challenge-example';
import type { CloudFrontRequest } from 'aws-lambda/common/cloudfront';
import type { RTIResponse } from '../../core/models/rti-response.model';

// crypto.subtle is available in the Lambda runtime but not in Node's test environment by default.
beforeAll(() => {
    if (!globalThis.crypto) {
        Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false });
    }
});

afterEach(() => {
    vi.restoreAllMocks();
});

// Compute a valid _cq_se session token the same way turnstile-challenge-example.ts does.
async function buildValidToken(rayId: string, ttlMs = 60_000): Promise<{ token: string; expiresAt: number }> {
    const expiresAt = Date.now() + ttlMs;
    const data = `${expiresAt}:${rayId}`;
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const signature = hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
    return { token: `${expiresAt}.${signature}`, expiresAt };
}

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

describe('turnstileValidateChallengeExample', () => {

    // --- No session present ---

    it('returns false when no cookie header is present', async () => {
        const result = await turnstileValidateChallengeExample(buildRequest());
        expect(result).toBe(false);
    });

    it('returns false when cookie header has no _cq_se cookie', async () => {
        const result = await turnstileValidateChallengeExample(buildRequest('_cq_duid=device-abc; _cq_pvid=pv-xyz'));
        expect(result).toBe(false);
    });

    // --- Valid session ---

    it('returns true for a valid unexpired token with correct signature', async () => {
        const rayId = 'ray-abc123';
        const { token } = await buildValidToken(rayId);
        const result = await turnstileValidateChallengeExample(buildRequest(`_cq_se=${token}|${rayId}`));
        expect(result).toBe(true);
    });

    it('returns true when _cq_se is alongside other cookies', async () => {
        const rayId = 'ray-abc123';
        const { token } = await buildValidToken(rayId);
        const result = await turnstileValidateChallengeExample(
            buildRequest(`_cq_duid=device-abc; _cq_se=${token}|${rayId}; _cq_pvid=pv-xyz`)
        );
        expect(result).toBe(true);
    });

    // --- Expired session ---

    it('returns false when token is expired', async () => {
        const rayId = 'ray-abc123';
        const { token } = await buildValidToken(rayId, -1000); // expired 1 second ago
        const result = await turnstileValidateChallengeExample(buildRequest(`_cq_se=${token}|${rayId}`));
        expect(result).toBe(false);
    });

    // --- Malformed token ---

    it('returns false when token has no "." separator (missing signature)', async () => {
        const result = await turnstileValidateChallengeExample(buildRequest('_cq_se=1234567890|ray-abc'));
        expect(result).toBe(false);
    });

    it('returns false when expiresAt part is not a number (NaN)', async () => {
        const result = await turnstileValidateChallengeExample(buildRequest('_cq_se=notanumber.abcdef|ray-abc'));
        expect(result).toBe(false);
    });

    it('returns false when signature does not match', async () => {
        const expiresAt = Date.now() + 60_000;
        const result = await turnstileValidateChallengeExample(
            buildRequest(`_cq_se=${expiresAt}.wrongsignature1234|ray-abc`)
        );
        expect(result).toBe(false);
    });

    // --- Header fallbacks ---

    it('returns true when rayId comes from x-cheq-ray-id header alongside _cq_se cookie token', async () => {
        const rayId = 'ray-from-header';
        const { token } = await buildValidToken(rayId);
        // cookie contains only the token portion; rayId comes from the header
        const result = await turnstileValidateChallengeExample(
            buildRequest(`_cq_se=${token}|`, rayId)
        );
        expect(result).toBe(true);
    });

    it('returns true when sessionToken comes from x-cheq-challenge header instead of cookie', async () => {
        const rayId = 'ray-abc123';
        const { token } = await buildValidToken(rayId);
        // cookie has only the rayId portion, token supplied via header
        const result = await turnstileValidateChallengeExample(
            buildRequest(`_cq_se=|${rayId}`, undefined, token)
        );
        expect(result).toBe(true);
    });

    it('returns true when both token and rayId come from headers (no _cq_se cookie)', async () => {
        const rayId = 'ray-abc123';
        const { token } = await buildValidToken(rayId);
        const result = await turnstileValidateChallengeExample(
            buildRequest(undefined, rayId, token)
        );
        expect(result).toBe(true);
    });

    // --- Debug logging branches ---

    it('logs debug info when isDebug=true and no session present', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await turnstileValidateChallengeExample(buildRequest(), true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[validateChallenge]'));
    });

    it('logs token/rayId info when isDebug=true with a valid token', async () => {
        const rayId = 'ray-debug';
        const { token } = await buildValidToken(rayId);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await turnstileValidateChallengeExample(buildRequest(`_cq_se=${token}|${rayId}`), true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('signature match'));
    });

    it('logs debug info when isDebug=true and token is expired', async () => {
        const rayId = 'ray-debug';
        const { token } = await buildValidToken(rayId, -1000);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await turnstileValidateChallengeExample(buildRequest(`_cq_se=${token}|${rayId}`), true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('expired'));
    });

    it('logs debug info when isDebug=true and token has no separator', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await turnstileValidateChallengeExample(buildRequest('_cq_se=1234567890|ray-abc'), true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('invalid sessionToken format'));
    });

    it('logs debug info when isDebug=true and expiresAt is NaN', async () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await turnstileValidateChallengeExample(buildRequest('_cq_se=notanumber.abcdef|ray-abc'), true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NaN'));
    });

    // --- Catch block ---

    it('returns false and logs error when crypto.subtle.digest throws', async () => {
        const rayId = 'ray-abc123';
        const { token } = await buildValidToken(rayId);
        const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest failed'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = await turnstileValidateChallengeExample(buildRequest(`_cq_se=${token}|${rayId}`));
        expect(result).toBe(false);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('digest failed'));
        digestSpy.mockRestore();
    });
});

function buildTurnstileRequest(querystring = '', hostHeader?: string): CloudFrontRequest {
    const headers: Record<string, { key: string; value: string }[]> = {};
    if (hostHeader) {
        headers['host'] = [{ key: 'Host', value: hostHeader }];
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

describe('turnstileChallengeExample', () => {

    // --- No token: serve challenge page ---

    it('returns 403 with HTML challenge page when no cf-turnstile-response token present', async () => {
        const result = await turnstileChallengeExample(buildTurnstileRequest(), buildRTIResponse()) as any;
        expect(result.status).toBe('403');
        expect(result.body).toContain('cf-turnstile');
        expect(result.headers['content-type'][0].value).toContain('text/html');
        expect(result.headers['cache-control'][0].value).toContain('no-store');
    });

    it('embeds rayId in challenge page HTML', async () => {
        const result = await turnstileChallengeExample(buildTurnstileRequest(), buildRTIResponse('ray-embed-test')) as any;
        expect(result.body).toContain('ray-embed-test');
    });

    // --- Token present: verify with Turnstile ---

    it('returns 302 with session cookie when Turnstile verification succeeds', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            json: async () => ({ success: true }),
        }));
        const qs = new URLSearchParams({ 'cf-turnstile-response': 'valid-token', 'viewer_host': 'example.com', 'original_url': '/target' }).toString();
        const result = await turnstileChallengeExample(buildTurnstileRequest(qs), buildRTIResponse()) as any;
        expect(result.status).toBe('302');
        expect((result.headers as any).location[0].value).toContain('https://example.com/target');
        expect((result.headers as any)['set-cookie'][0].value).toContain('_cq_se=');
        vi.unstubAllGlobals();
    });

    it('falls back to host header when viewer_host query param is absent', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            json: async () => ({ success: true }),
        }));
        const qs = new URLSearchParams({ 'cf-turnstile-response': 'valid-token' }).toString();
        const result = await turnstileChallengeExample(buildTurnstileRequest(qs, 'fallback.com'), buildRTIResponse()) as any;
        expect((result.headers as any).location[0].value).toContain('fallback.com');
        vi.unstubAllGlobals();
    });

    it('uses empty host when neither viewer_host param nor host header is present', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            json: async () => ({ success: true }),
        }));
        const qs = new URLSearchParams({ 'cf-turnstile-response': 'valid-token' }).toString();
        const result = await turnstileChallengeExample(buildTurnstileRequest(qs), buildRTIResponse()) as any;
        expect((result.headers as any).location[0].value).toMatch(/^https:\/\//);
        vi.unstubAllGlobals();
    });

    it('returns 403 with error message when Turnstile verification fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            json: async () => ({ success: false }),
        }));
        const qs = new URLSearchParams({ 'cf-turnstile-response': 'bad-token' }).toString();
        const result = await turnstileChallengeExample(buildTurnstileRequest(qs), buildRTIResponse()) as any;
        expect(result.status).toBe('403');
        expect(result.body).toContain('Verification failed');
        vi.unstubAllGlobals();
    });
});
