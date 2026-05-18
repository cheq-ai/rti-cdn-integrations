import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
// @ts-ignore
import { webcrypto } from 'node:crypto';
import { turnstileChallengeExample, trunstileValidateChallengeExample } from './turnstile-challenge-example';
import type { RTIResponse } from '../../core/models/rti-response.model';

beforeAll(() => {
    if (!(globalThis as any).crypto) {
        Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false });
    }
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function buildValidToken(rayId: string, ttlMs = 60_000): Promise<{ token: string }> {
    const expiresAt = Date.now() + ttlMs;
    const data = `${expiresAt}:${rayId}`;
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const signature = hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
    return { token: `${expiresAt}.${signature}` };
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

function buildRequest(opts: { cookies?: string; xRealIp?: string; xCheqRayId?: string; xCheqChallenge?: string } = {}): Request {
    const headers = new Headers();
    if (opts.cookies) headers.set('cookie', opts.cookies);
    if (opts.xRealIp) headers.set('x-real-ip', opts.xRealIp);
    if (opts.xCheqRayId) headers.set('x-cheq-ray-id', opts.xCheqRayId);
    if (opts.xCheqChallenge) headers.set('x-cheq-challenge', opts.xCheqChallenge);
    return new Request('https://example.com/page', { headers });
}

function buildFormRequest(formFields: Record<string, string> = {}, extraHeaders: Record<string, string> = {}): Request {
    const body = new URLSearchParams(formFields).toString();
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders });
    return new Request('https://example.com/page', { method: 'POST', headers, body });
}

// ─── turnstileChallengeExample ────────────────────────────────────────────────

describe('turnstileChallengeExample', () => {

    it('returns 403 with HTML challenge page when no form data / no token', async () => {
        const result = await turnstileChallengeExample(buildRequest(), buildRTIResponse());
        expect(result.status).toBe(403);
        const body = await result.text();
        expect(body).toContain('cf-turnstile');
        expect(result.headers.get('content-type')).toContain('text/html');
        expect(result.headers.get('cache-control')).toContain('no-store');
    });

    it('returns 403 with HTML challenge page when content-type is not form-urlencoded', async () => {
        const req = new Request('https://example.com/page', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ 'cf-turnstile-response': 'token' }),
        });
        const result = await turnstileChallengeExample(req, buildRTIResponse());
        expect(result.status).toBe(403);
    });

    it('returns 403 with HTML page when form is submitted but cf-turnstile-response is missing', async () => {
        const result = await turnstileChallengeExample(buildFormRequest({ other: 'value' }), buildRTIResponse());
        expect(result.status).toBe(403);
    });

    it('embeds rayId in challenge page HTML', async () => {
        const result = await turnstileChallengeExample(buildRequest(), buildRTIResponse('ray-embed-test'));
        const body = await result.text();
        expect(body).toContain('ray-embed-test');
    });

    it('returns 302 with session cookie when Turnstile verification succeeds', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } })
        ));
        const result = await turnstileChallengeExample(
            buildFormRequest({ 'cf-turnstile-response': 'valid-token', 'original_url': encodeURIComponent('/target') }, { 'x-real-ip': '1.2.3.4' }),
            buildRTIResponse()
        );
        expect(result.status).toBe(302);
        expect(result.headers.get('location')).toContain('/target');
        expect(result.headers.get('set-cookie')).toContain('_cq_se=');
    });

    it('returns 403 with error message when Turnstile verification fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ success: false }), { headers: { 'content-type': 'application/json' } })
        ));
        const result = await turnstileChallengeExample(
            buildFormRequest({ 'cf-turnstile-response': 'bad-token' }, { 'x-real-ip': '1.2.3.4' }),
            buildRTIResponse()
        );
        expect(result.status).toBe(403);
        expect(await result.text()).toContain('Verification failed');
    });
});

// ─── trunstileValidateChallengeExample ───────────────────────────────────────

describe('trunstileValidateChallengeExample', () => {

    it('returns false when no cookie header present', async () => {
        expect(await trunstileValidateChallengeExample(buildRequest())).toBe(false);
    });

    it('returns false when cookie has no _cq_se', async () => {
        expect(await trunstileValidateChallengeExample(buildRequest({ cookies: '_cq_duid=abc; _cq_pvid=xyz' }))).toBe(false);
    });

    it('returns true for a valid unexpired token with correct signature', async () => {
        const rayId = 'ray-abc';
        const { token } = await buildValidToken(rayId);
        expect(await trunstileValidateChallengeExample(buildRequest({ cookies: `_cq_se=${token}|${rayId}` }))).toBe(true);
    });

    it('returns false when token is expired', async () => {
        const rayId = 'ray-abc';
        const { token } = await buildValidToken(rayId, -1000);
        expect(await trunstileValidateChallengeExample(buildRequest({ cookies: `_cq_se=${token}|${rayId}` }))).toBe(false);
    });

    it('returns false when token has no "." separator (missing signature)', async () => {
        expect(await trunstileValidateChallengeExample(buildRequest({ cookies: '_cq_se=1234567890|ray-abc' }))).toBe(false);
    });

    it('returns false when expiresAt is NaN', async () => {
        expect(await trunstileValidateChallengeExample(buildRequest({ cookies: '_cq_se=notanumber.abcdef|ray-abc' }))).toBe(false);
    });

    it('returns false when signature does not match', async () => {
        const expiresAt = Date.now() + 60_000;
        expect(await trunstileValidateChallengeExample(buildRequest({ cookies: `_cq_se=${expiresAt}.wrongsig1234|ray-abc` }))).toBe(false);
    });

    it('returns true when both token and rayId come from headers (no cookie)', async () => {
        const rayId = 'ray-from-header';
        const { token } = await buildValidToken(rayId);
        expect(await trunstileValidateChallengeExample(buildRequest({ xCheqRayId: rayId, xCheqChallenge: token }))).toBe(true);
    });

    it('returns true when session token comes from x-cheq-challenge header alongside cookie rayId', async () => {
        const rayId = 'ray-abc';
        const { token } = await buildValidToken(rayId);
        // cookie has _cq_se with no token portion — rayId from cookie, token from header
        expect(await trunstileValidateChallengeExample(buildRequest({ cookies: `_cq_se=|${rayId}`, xCheqChallenge: token }))).toBe(true);
    });

    it('returns false and catches error when crypto.subtle.digest throws', async () => {
        const rayId = 'ray-abc';
        const { token } = await buildValidToken(rayId);
        vi.spyOn((globalThis as any).crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest error'));
        expect(await trunstileValidateChallengeExample(buildRequest({ cookies: `_cq_se=${token}|${rayId}` }))).toBe(false);
    });
});
