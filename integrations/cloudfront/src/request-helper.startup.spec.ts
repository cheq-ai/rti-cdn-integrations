// What request-helper logs when it loads (once per cold start). Each test loads a fresh copy against its own config.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { Mode } from '../../core/models/mode.model';
import { Action } from '../../core/models/action.model';

// vi.importActual, not import(): the package compiles with module es2015, which has no dynamic import.
const loadRequestHelper = async (config: Record<string, unknown>) => {
    vi.resetModules();
    vi.doMock('./config', () => ({ config: { apiKey: 'k', tagHash: 't', keepHeadersNames: [], ...config } }));
    await vi.importActual<typeof import('./request-helper')>('./request-helper');
};

// The first load of the module graph is slow. Done here, outside the tests' 5 s timeout: on a busy machine it timed
// out inside the first test, and its warning then landed in the next test's spy.
beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadRequestHelper({});
    vi.restoreAllMocks();
    vi.doUnmock('./config');
    vi.resetModules();
}, 60_000);

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

    it('warns once per actionOnSuspicious problem, pointing to "actionOnSuspicious" in the README', async () => {
        // Arrange: a method that is not a body method, a value that is not an Action, and a rule whose path is not a regex
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadRequestHelper({
            mode: Mode.BLOCKING,
            actionOnSuspicious: { methods: { GET: Action.BLOCK, POST: 9 }, rules: [{ path: '[', action: Action.ALLOW }] },
        });

        // Assert
        expect(warn.mock.calls).toEqual([
            [`[config] actionOnSuspicious.methods: 'GET' is not one of POST, PUT, PATCH, DELETE, OPTIONS (see "actionOnSuspicious" in the README)`],
            ['[config] actionOnSuspicious.methods.POST: 9 is not an Action (see "actionOnSuspicious" in the README)'],
            [`[config] actionOnSuspicious.rules[0].path: '[' is not a valid regex (see "actionOnSuspicious" in the README)`],
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
