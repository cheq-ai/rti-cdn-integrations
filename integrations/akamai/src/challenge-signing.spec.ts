import { describe, it, expect, vi } from 'vitest';

// EdgeWorkers provides NO global crypto, TextEncoder or URLSearchParams - each one comes from a
// built-in module (`crypto`, `encoding`, `url-search-params`). Node has all three as globals, so
// source that uses them bare passes every unit test here and throws ReferenceError on the edge -
// which is exactly what happened: the throw was swallowed by main.ts's CAPTCHA catch and every
// challenge silently fell through to ALLOW.
//
// These mocks stand in for the Akamai modules. If the source goes back to the globals, nothing
// reaches them and these tests fail, which is the whole point of mocking rather than asserting
// on output alone.
const mocks = vi.hoisted(() => ({
    digest: vi.fn(async () => new Uint8Array(32).fill(0xab).buffer),
    encode: vi.fn((value: string) => new Uint8Array(Buffer.from(value, 'utf8'))),
}));

vi.mock('crypto', () => ({
    crypto: { subtle: { digest: mocks.digest } },
}));

vi.mock('encoding', () => ({
    TextEncoder: class {
        encode(value: string) { return mocks.encode(value); }
    },
}));

import { sign, readChallengeSecret, hasValidGrant } from './challenge-signing';

function buildRequest(secret?: string): EWRequest {
    return {
        getVariable: (name: string) => (name === 'PMUSER_CHEQ_CHALLENGE_SECRET' ? secret : undefined),
    } as unknown as EWRequest;
}

function buildGrantRequest(url: string): EWRequest {
    return { url } as unknown as EWRequest;
}

describe('challenge signing', () => {
    it('takes crypto and TextEncoder from the EdgeWorkers modules, not browser globals', async () => {
        const result = await sign('s3cret', 'ct:1700000000:ray-1');

        // The exact string that gets hashed - secret and data joined by a colon.
        expect(mocks.encode).toHaveBeenCalledWith('s3cret:ct:1700000000:ray-1');
        expect(mocks.digest).toHaveBeenCalledWith('SHA-256', expect.anything());
        // 32 bytes of 0xab, truncated to the first 16 and hex-encoded.
        expect(result).toBe('ab'.repeat(16));
    });

    it('truncates the digest to 16 bytes / 32 hex chars', async () => {
        expect(await sign('a', 'b')).toHaveLength(32);
    });
});

describe('readChallengeSecret', () => {
    it('returns the trimmed secret', () => {
        expect(readChallengeSecret(buildRequest('  abc123  '))).toBe('abc123');
    });

    it.each([
        ['unset', undefined],
        ['empty', ''],
        ['whitespace only', '   '],
        ['the placeholder', 'REPLACE_ME'],
    ])('returns undefined when the variable is %s', (_label, value) => {
        expect(readChallengeSecret(buildRequest(value))).toBeUndefined();
    });
});

describe('hasValidGrant', () => {
    // A grant is `<expiresAt>.<rayId>.<signature>` and arrives in a URL, so any link can carry
    // any shape. Splitting a string with too few separators leaves `undefined` holes, and the
    // three-part check has to refuse those BEFORE the signature comparison - reaching the
    // comparison with undefined would mean signing undefined rather than returning false.
    // The digest is mocked to a constant here, so none of these can pass by accident.
    it.each([
        ['no separators at all', 'abc'],
        ['only two parts', '1700000000.ray'],
        ['an empty expiresAt', '.ray.abcdef0123456789abcdef0123456789'],
        ['an empty rayId', '1700000000..abcdef0123456789abcdef0123456789'],
        ['an empty signature', '1700000000.ray.'],
    ])('returns false for a grant with %s', async (_label, grant) => {
        expect(await hasValidGrant('test-signing-secret', buildGrantRequest(`/page?cq_ok=${grant}`)))
            .toBe(false);
    });

    it('returns false when cq_ok is present but empty', async () => {
        expect(await hasValidGrant('test-signing-secret', buildGrantRequest('/page?cq_ok=')))
            .toBe(false);
    });

    it('returns false when the URL carries no query string at all', async () => {
        expect(await hasValidGrant('test-signing-secret', buildGrantRequest('/page'))).toBe(false);
    });

    it('returns false when the query string holds other params but no grant', async () => {
        expect(await hasValidGrant('test-signing-secret', buildGrantRequest('/page?utm_source=x')))
            .toBe(false);
    });
});
