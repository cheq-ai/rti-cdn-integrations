// cspell:ignore CHEQ siteverify
/// <reference path="./types.d.ts" />
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
// @ts-ignore
import { webcrypto } from 'node:crypto';
import type { RTIResponse } from '../../core/models/rti-response.model';

const mocks = vi.hoisted(() => ({
    httpRequest: vi.fn(),
}));

vi.mock('http-request', () => ({
    httpRequest: mocks.httpRequest,
}));

import { turnstileChallengeExample, turnstileValidateChallengeExample } from './turnstile-challenge-example';

beforeAll(() => {
    if (!(globalThis as any).crypto) {
        Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false });
    }
});

afterEach(() => {
    vi.restoreAllMocks();
});

// Helper to build a valid signed session token matching the implementation's formula
async function buildValidToken(rayId: string, ttlMs = 60_000): Promise<string> {
    const expiresAt = Date.now() + ttlMs;
    const data = `${expiresAt}:${rayId}`;
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const signature = hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${expiresAt}.${signature}`;
}

function buildRTIResponse(rayId = 'ray-123'): RTIResponse {
    return {
        ids: { rayId, pageViewId: null, duid: null, uniqueVisitId: null, customParam1: null, customParam2: null, customParam3: null, customParam4: null },
        decision: { verdict: 'suspicious' },
        classification: { code: 0 },
        cheqDetection: { reasons: [] },
        metadata: { version: '4.1' },
    } as unknown as RTIResponse;
}

function buildRequest(opts: {
    url?: string;
    scheme?: string;
    host?: string;
    path?: string;
    clientIp?: string;
    cookies?: string;
} = {}): EWRequest {
    const url = opts.url ?? '/page';
    const cookies = opts.cookies;
    return {
        url,
        scheme: opts.scheme ?? 'https',
        host: opts.host ?? 'example.com',
        path: opts.path ?? '/page',
        clientIp: opts.clientIp ?? '1.2.3.4',
        method: 'GET',
        userLocation: undefined,
        getHeader: vi.fn((name: string) => {
            if (name === 'Cookie' && cookies) return [cookies];
            return [];
        }),
        getHeaders: vi.fn(() => ({})),
        setHeader: vi.fn(),
        addHeader: vi.fn(),
        removeHeader: vi.fn(),
        getVariable: vi.fn(),
        setVariable: vi.fn(),
        respondWith: vi.fn(),
    } as unknown as EWRequest;
}

// ─── turnstileChallengeExample ────────────────────────────────────────────────

describe('turnstileChallengeExample', () => {

    it('returns HTML challenge page when no token in query string', async () => {
        // Arrange
        const req = buildRequest({ url: '/page' });

        // Act
        const result = await turnstileChallengeExample(req, buildRTIResponse());

        // Assert
        expect(result.headers['Content-Type']).toContain('text/html');
        expect(result.headers['Cache-Control']).toContain('no-store');
        expect(result.html).toContain('cf-turnstile');
    });

    it('embeds rayId in challenge page HTML', async () => {
        // Arrange
        const req = buildRequest({ url: '/page' });

        // Act
        const result = await turnstileChallengeExample(req, buildRTIResponse('ray-embed-test'));

        // Assert
        expect(result.html).toContain('ray-embed-test');
    });

    it('returns Location and Set-Cookie when Turnstile verification succeeds', async () => {
        // Arrange
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true }) });
        const req = buildRequest({ url: '/page?cf-turnstile-response=valid-token&original_url=' + encodeURIComponent('/target') });

        // Act
        const result = await turnstileChallengeExample(req, buildRTIResponse());

        // Assert
        expect(result.headers['Location']).toContain('/target');
        expect(result.headers['Set-Cookie']).toContain('_cq_se=');
    });

    it('Set-Cookie token contains expiresAt.signature|rayId format', async () => {
        // Arrange
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true }) });
        const req = buildRequest({ url: '/page?cf-turnstile-response=token' });

        // Act
        const result = await turnstileChallengeExample(req, buildRTIResponse('ray-abc'));

        // Assert
        const setCookie = result.headers['Set-Cookie'];
        // _cq_se=<timestamp>.<hex>|<rayId>; ...
        expect(setCookie).toMatch(/_cq_se=\d+\.[0-9a-f]+\|ray-abc/);
    });

    it('falls back redirect to scheme://host/path when original_url is absent', async () => {
        // Arrange
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: true }) });
        const req = buildRequest({ url: '/page?cf-turnstile-response=token', scheme: 'https', host: 'example.com', path: '/page' });

        // Act
        const result = await turnstileChallengeExample(req, buildRTIResponse());

        // Assert
        expect(result.headers['Location']).toBe('https://example.com/page');
    });

    it('returns Verification failed with text/plain when Turnstile verification fails', async () => {
        // Arrange
        mocks.httpRequest.mockResolvedValue({ json: async () => ({ success: false }) });
        const req = buildRequest({ url: '/page?cf-turnstile-response=bad-token' });

        // Act
        const result = await turnstileChallengeExample(req, buildRTIResponse());

        // Assert
        expect(result.html).toContain('Verification failed');
        expect(result.headers['Content-Type']).toContain('text/plain');
    });

    it('propagates error when httpRequest throws', async () => {
        // Arrange
        mocks.httpRequest.mockRejectedValue(new Error('network error'));
        const req = buildRequest({ url: '/page?cf-turnstile-response=token' });

        // Act & Assert
        await expect(turnstileChallengeExample(req, buildRTIResponse())).rejects.toThrow('network error');
    });
});

// ─── turnstileValidateChallengeExample ───────────────────────────────────────

describe('turnstileValidateChallengeExample', () => {

    it('returns false when Cookie header is absent', async () => {
        // Act & Assert
        expect(await turnstileValidateChallengeExample(buildRequest())).toBe(false);
    });

    it('returns false when cookie has no _cq_se', async () => {
        // Act & Assert
        expect(await turnstileValidateChallengeExample(buildRequest({ cookies: '_cq_duid=abc; _cq_pvid=xyz' }))).toBe(false);
    });

    it('returns true for a valid unexpired token with correct signature', async () => {
        // Arrange
        const rayId = 'ray-abc';
        const token = await buildValidToken(rayId);

        // Act & Assert
        expect(await turnstileValidateChallengeExample(buildRequest({ cookies: `_cq_se=${token}|${rayId}` }))).toBe(true);
    });

    it('returns false when token is expired', async () => {
        // Arrange
        const rayId = 'ray-abc';
        const token = await buildValidToken(rayId, -1000);

        // Act & Assert
        expect(await turnstileValidateChallengeExample(buildRequest({ cookies: `_cq_se=${token}|${rayId}` }))).toBe(false);
    });

    it('returns false when token has no "." separator (missing signature)', async () => {
        // Act & Assert
        expect(await turnstileValidateChallengeExample(buildRequest({ cookies: '_cq_se=1234567890|ray-abc' }))).toBe(false);
    });

    it('returns false when expiresAt is NaN', async () => {
        // Act & Assert
        expect(await turnstileValidateChallengeExample(buildRequest({ cookies: '_cq_se=notanumber.abcdef|ray-abc' }))).toBe(false);
    });

    it('returns false when signature does not match', async () => {
        // Arrange
        const expiresAt = Date.now() + 60_000;

        // Act & Assert
        expect(await turnstileValidateChallengeExample(buildRequest({ cookies: `_cq_se=${expiresAt}.wrongsig1234|ray-abc` }))).toBe(false);
    });

    it('returns false when cookie value has no "|" separator (missing rayId)', async () => {
        // Arrange
        const expiresAt = Date.now() + 60_000;

        // Act & Assert
        expect(await turnstileValidateChallengeExample(buildRequest({ cookies: `_cq_se=${expiresAt}.abcdef` }))).toBe(false);
    });

    it('returns false and catches error when crypto.subtle.digest throws', async () => {
        // Arrange
        const rayId = 'ray-abc';
        const token = await buildValidToken(rayId);
        vi.spyOn((globalThis as any).crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest error'));

        // Act & Assert
        expect(await turnstileValidateChallengeExample(buildRequest({ cookies: `_cq_se=${token}|${rayId}` }))).toBe(false);
    });
});
