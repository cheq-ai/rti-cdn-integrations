import { describe, it, expect, beforeAll } from 'vitest';
// @ts-ignore — node:crypto is not in the tsconfig types but is available at runtime in Node 20
import { webcrypto } from 'node:crypto';
import { trunstileValidateChallengeExample } from './turnstile-challenge-example';
import type { CloudFrontRequest } from 'aws-lambda/common/cloudfront';

// crypto.subtle is available in the Lambda runtime but not in Node's test environment by default.
beforeAll(() => {
    if (!globalThis.crypto) {
        Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false });
    }
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

describe('trunstileValidateChallengeExample', () => {

    // --- No session present ---

    it('returns false when no cookie header is present', async () => {
        const result = await trunstileValidateChallengeExample(buildRequest());
        expect(result).toBe(false);
    });

    it('returns false when cookie header has no _cq_se cookie', async () => {
        const result = await trunstileValidateChallengeExample(buildRequest('_cq_duid=device-abc; _cq_pvid=pv-xyz'));
        expect(result).toBe(false);
    });

    // --- Valid session ---

    it('returns true for a valid unexpired token with correct signature', async () => {
        const rayId = 'ray-abc123';
        const { token } = await buildValidToken(rayId);
        const result = await trunstileValidateChallengeExample(buildRequest(`_cq_se=${token}|${rayId}`));
        expect(result).toBe(true);
    });

    it('returns true when _cq_se is alongside other cookies', async () => {
        const rayId = 'ray-abc123';
        const { token } = await buildValidToken(rayId);
        const result = await trunstileValidateChallengeExample(
            buildRequest(`_cq_duid=device-abc; _cq_se=${token}|${rayId}; _cq_pvid=pv-xyz`)
        );
        expect(result).toBe(true);
    });

    // --- Expired session ---

    it('returns false when token is expired', async () => {
        const rayId = 'ray-abc123';
        const { token } = await buildValidToken(rayId, -1000); // expired 1 second ago
        const result = await trunstileValidateChallengeExample(buildRequest(`_cq_se=${token}|${rayId}`));
        expect(result).toBe(false);
    });

    // --- Malformed token ---

    it('returns false when token has no "." separator (missing signature)', async () => {
        const result = await trunstileValidateChallengeExample(buildRequest('_cq_se=1234567890|ray-abc'));
        expect(result).toBe(false);
    });

    it('returns false when expiresAt part is not a number (NaN)', async () => {
        const result = await trunstileValidateChallengeExample(buildRequest('_cq_se=notanumber.abcdef|ray-abc'));
        expect(result).toBe(false);
    });

    it('returns false when signature does not match', async () => {
        const expiresAt = Date.now() + 60_000;
        const result = await trunstileValidateChallengeExample(
            buildRequest(`_cq_se=${expiresAt}.wrongsignature1234|ray-abc`)
        );
        expect(result).toBe(false);
    });

    // --- Header fallbacks ---

    it('returns true when rayId comes from x-cheq-ray-id header alongside _cq_se cookie token', async () => {
        const rayId = 'ray-from-header';
        const { token } = await buildValidToken(rayId);
        // cookie contains only the token portion; rayId comes from the header
        const result = await trunstileValidateChallengeExample(
            buildRequest(`_cq_se=${token}|`, rayId)
        );
        expect(result).toBe(true);
    });

    it('returns true when sessionToken comes from x-cheq-challenge header instead of cookie', async () => {
        const rayId = 'ray-abc123';
        const { token } = await buildValidToken(rayId);
        // cookie has only the rayId portion, token supplied via header
        const result = await trunstileValidateChallengeExample(
            buildRequest(`_cq_se=|${rayId}`, undefined, token)
        );
        expect(result).toBe(true);
    });

    it('returns true when both token and rayId come from headers (no _cq_se cookie)', async () => {
        const rayId = 'ray-abc123';
        const { token } = await buildValidToken(rayId);
        const result = await trunstileValidateChallengeExample(
            buildRequest(undefined, rayId, token)
        );
        expect(result).toBe(true);
    });
});
