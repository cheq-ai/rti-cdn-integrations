// What request-helper logs when it loads (once per cold start). Each test loads a fresh copy against its own config.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Mode } from '../../core/models/mode.model';
import { Action } from '../../core/models/action.model';

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

    it('warns once per actionOnSuspicious problem, saying it counts as ALLOW', async () => {
        // Arrange: a method that is not a body method, and a value that is not an Action
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadRequestHelper({ mode: Mode.BLOCKING, actionOnSuspicious: { methods: { GET: Action.BLOCK, POST: 9 } } });

        // Assert
        expect(warn.mock.calls).toEqual([
            ["[config] actionOnSuspicious.methods: 'GET' is not one of POST, PUT, PATCH, DELETE, OPTIONS (counts as ALLOW)"],
            ['[config] actionOnSuspicious.methods.POST: 9 is not an Action (counts as ALLOW)'],
        ]);
    });

    it('does not warn about a valid actionOnSuspicious', async () => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadRequestHelper({
            mode: Mode.BLOCKING,
            actionOnSuspicious: { methods: { POST: Action.CHALLENGE }, rules: [{ path: '^/api/', action: Action.BLOCK }] },
        });

        // Assert
        expect(warn).not.toHaveBeenCalled();
    });
});
