// What index logs when it loads (once per cold start). Each test loads a fresh copy against its own config.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { Mode } from '../../core/models/mode.model';
import { Action } from '../../core/models/action.model';
import { CONSOLE_LINE, CONSOLE_TAG_HASH } from '../../core/testing/interstitial.fixture';

const CHALLENGE_WARNING = '[challenge] config.isChallengeResponse is not set: replies to the challenge page are not recognized (see "Challenge callbacks" in the README)';
const TAG_NOT_SET_WARNING = '[interstitial] interstitial.tag is not set, the interstitial is off: paste the tag line from the CHEQ console (see "Interstitial" in the README)';

const loadWorker = async (config: Record<string, unknown>) => {
    vi.resetModules();
    vi.doMock('./config', () => ({ config: { apiKey: 'k', tagHash: 't', ...config } }));
    await import('./index');
};

// The first load of the module graph is slow (seconds on a busy machine): it happens here, with a long timeout, not in
// the 5 s of a test, so each test only loads index again. The module registry and the mocks are left clean for the tests.
beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadWorker({});
    vi.restoreAllMocks();
    vi.doUnmock('./config');
    vi.resetModules();
}, 60_000);

afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./config');
    vi.resetModules();
});

describe('index at load', () => {
    it.each([Mode.BLOCKING, Mode.MONITORING])('warns once when challenge is set without isChallengeResponse (mode %s)', async (mode) => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadWorker({ mode, challenge: vi.fn() });

        // Assert
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(CHALLENGE_WARNING);
    });

    it.each([
        ['challenge and isChallengeResponse are both set', { challenge: vi.fn(), isChallengeResponse: vi.fn() }],
        ['no challenge is set', {}],
        ['only isChallengeResponse is set', { isChallengeResponse: vi.fn() }],
    ])('does not warn when %s', async (_, config) => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadWorker({ mode: Mode.BLOCKING, ...config });

        // Assert
        expect(warn).not.toHaveBeenCalled();
    });

    it('warns once per actionOnSuspicious problem, pointing to the README for each', async () => {
        // Arrange: a method that is not one of the seven, a value that is not an Action, and a rule with a bad regex
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadWorker({
            mode: Mode.BLOCKING,
            actionOnSuspicious: { methods: { FETCH: Action.BLOCK, POST: 9 }, rules: [{ path: '[', action: Action.ALLOW }] },
        });

        // Assert
        expect(warn.mock.calls).toEqual([
            ["[config] actionOnSuspicious.methods: 'FETCH' is not one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS (see \"actionOnSuspicious\" in the README)"],
            ['[config] actionOnSuspicious.methods.POST: 9 is not an Action (see "actionOnSuspicious" in the README)'],
            ["[config] actionOnSuspicious.rules[0].path: '[' is not a valid regex (see \"actionOnSuspicious\" in the README)"],
        ]);
    });

    it('does not warn about a valid actionOnSuspicious', async () => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadWorker({
            mode: Mode.BLOCKING,
            actionOnSuspicious: { methods: { POST: Action.CHALLENGE }, rules: [{ path: '^/api/', action: Action.BLOCK }] },
        });

        // Assert
        expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn about GET and HEAD in methods or GET in a rule', async () => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadWorker({
            mode: Mode.BLOCKING,
            actionOnSuspicious: {
                methods: { GET: Action.ALLOW, HEAD: Action.ALLOW },
                rules: [{ path: '^/api/', methods: ['GET'], action: Action.ALLOW }],
            },
        });

        // Assert
        expect(warn).not.toHaveBeenCalled();
    });

    it('still loads when the config check itself throws, and says so once', async () => {
        // Arrange: a getter that throws keeps the test independent of which shapes core accepts
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = { mode: Mode.BLOCKING };
        Object.defineProperty(config, 'actionOnSuspicious', { get() { throw new Error('boom'); }, enumerable: true });
        vi.resetModules();
        vi.doMock('./config', () => ({ config }));

        // Act and Assert: a throw while the module loads would break every request of the Worker
        await expect(import('./index')).resolves.toBeDefined();
        expect(warn.mock.calls).toEqual([['[config] the config check failed, continuing: boom']]);
    });

    it('still warns about challenge without isChallengeResponse when the actionOnSuspicious check throws', async () => {
        // Arrange: validateActionOnSuspicious throws on the getter, and challenge is set without isChallengeResponse
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = { mode: Mode.BLOCKING, challenge: vi.fn() };
        Object.defineProperty(config, 'actionOnSuspicious', { get() { throw new Error('boom'); }, enumerable: true });
        vi.resetModules();
        vi.doMock('./config', () => ({ config }));

        // Act
        await import('./index');

        // Assert: the [challenge] check runs first, so the throw cannot hide its warning
        expect(warn.mock.calls).toEqual([
            [CHALLENGE_WARNING],
            ['[config] the config check failed, continuing: boom'],
        ]);
    });

    it('warns once that the interstitial is off while interstitial.tag is REPLACE_ME', async () => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadWorker({ mode: Mode.BLOCKING, interstitial: { enabled: true, tag: 'REPLACE_ME' } });

        // Assert
        expect(warn.mock.calls).toEqual([[TAG_NOT_SET_WARNING]]);
    });

    it('warns about a wrong maxWaitMs beside a valid tag line, and names the value used instead', async () => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadWorker({ mode: Mode.BLOCKING, tagHash: CONSOLE_TAG_HASH, interstitial: { enabled: true, tag: CONSOLE_LINE, maxWaitMs: 10 } });

        // Assert
        expect(warn.mock.calls).toEqual([
            ['[interstitial] interstitial.maxWaitMs: 10 is not a whole number from 1000 to 30000, using 5000 (see "Interstitial" in the README)'],
        ]);
    });

    it('still loads when reading config.interstitial throws, and says once that the interstitial is off', async () => {
        // Arrange: a getter that throws
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = { apiKey: 'k', tagHash: 't', mode: Mode.BLOCKING };
        Object.defineProperty(config, 'interstitial', { get() { throw new Error('boom'); }, enumerable: true });
        vi.resetModules();
        vi.doMock('./config', () => ({ config }));

        // Act and Assert: a throw while the module loads would break every request of the Worker
        await expect(import('./index')).resolves.toBeDefined();
        expect(warn.mock.calls).toEqual([
            ['[interstitial] interstitial settings could not be read (boom), the interstitial is off (see "Interstitial" in the README)'],
        ]);
    });

    it('does not warn about a valid interstitial block whose tag line matches tagHash', async () => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Act
        await loadWorker({ mode: Mode.BLOCKING, tagHash: CONSOLE_TAG_HASH, interstitial: { enabled: true, tag: CONSOLE_LINE } });

        // Assert
        expect(warn).not.toHaveBeenCalled();
    });

    it('warns about challenge, then about the interstitial, then that an actionOnSuspicious check that throws failed', async () => {
        // Arrange: challenge without isChallengeResponse, a tag line that is not set, and an actionOnSuspicious getter
        // that throws
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = { mode: Mode.BLOCKING, challenge: vi.fn(), interstitial: { enabled: true, tag: 'REPLACE_ME' } };
        Object.defineProperty(config, 'actionOnSuspicious', { get() { throw new Error('boom'); }, enumerable: true });
        vi.resetModules();
        vi.doMock('./config', () => ({ config }));

        // Act
        await import('./index');

        // Assert: the [challenge] and [interstitial] checks run first, so the throw cannot hide their warnings
        expect(warn.mock.calls).toEqual([
            [CHALLENGE_WARNING],
            [TAG_NOT_SET_WARNING],
            ['[config] the config check failed, continuing: boom'],
        ]);
    });
});
