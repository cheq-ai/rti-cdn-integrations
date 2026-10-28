// What request-helper logs when it loads (once per cold start). Each test loads a fresh copy against its own config.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Mode } from '../../core/models/mode.model';

// vi.importActual, not import(): the package compiles with module es2015, which has no dynamic import.
const loadRequestHelper = async (config: Record<string, unknown>) => {
    vi.resetModules();
    vi.doMock('./config', () => ({ config: { apiKey: 'k', tagHash: 't', keepHeadersNames: [], ...config } }));
    await vi.importActual<typeof import('./request-helper')>('./request-helper');
};

afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./config');
    vi.resetModules();
});

describe('request-helper at load', () => {
    it.each([Mode.BLOCKING, Mode.MONITORING])('warns once when challenge is set without isChallengeResponse (mode %s)', async (mode) => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadRequestHelper({ mode, challenge: vi.fn() });

        // Assert
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('isChallengeResponse'));
    });

    it.each([
        ['challenge and isChallengeResponse are both set', { challenge: vi.fn(), isChallengeResponse: vi.fn() }],
        ['no challenge is set', {}],
        ['only isChallengeResponse is set', { isChallengeResponse: vi.fn() }],
    ])('does not warn when %s', async (_, config) => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadRequestHelper({ mode: Mode.BLOCKING, ...config });

        // Assert
        expect(warn).not.toHaveBeenCalled();
    });
});
