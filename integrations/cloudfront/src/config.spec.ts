// Tests the REAL shipped config.ts (the request-helper specs mock it). Each test loads a fresh copy with
// vi.resetModules(), because config.ts calls createTurnstileChallenge (and may warn) while it loads.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { Mode } from '../../core/models/mode.model';
import { Action } from '../../core/models/action.model';

// vi.importActual, not import(): the package compiles with module es2015, which has no dynamic import.
// Its dependencies still go through vi.doMock.
const loadConfig = async () => (await vi.importActual<typeof import('./config')>('./config')).config;

afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./turnstile-challenge-example');
    vi.resetModules();
});

describe('shipped config.ts', () => {
    // These tests check config.ts as this repository ships it. A filled-in config.ts is not wrong, and "Verify config"
    // (npm test) must pass for it: once apiKey, tagHash or a Turnstile secret is set, they are skipped.
    let filledIn = false;
    const FILLED_IN = 'config.ts is filled in';

    // One load of the real config.ts, to read its five secrets. It also takes the slow first load of the module graph out
    // of the tests' 5 s timeout: on a busy machine that load timed out, and its warning then landed in the next test.
    beforeAll(async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // The real createTurnstileChallenge, watched: the Turnstile settings are not exported.
            const turnstileExample = await vi.importActual<typeof import('./turnstile-challenge-example')>('./turnstile-challenge-example');
            const createTurnstileChallenge = vi.fn(turnstileExample.createTurnstileChallenge);
            vi.doMock('./turnstile-challenge-example', () => ({ ...turnstileExample, createTurnstileChallenge }));
            const config = await loadConfig();
            const turnstile = createTurnstileChallenge.mock.calls[0]?.[0];
            filledIn = [config.apiKey, config.tagHash, turnstile?.siteKey, turnstile?.secretKey, turnstile?.sessionSigningSecret]
                .some(secret => secret !== 'REPLACE_ME');
        } finally {
            vi.restoreAllMocks();
            vi.doUnmock('./turnstile-challenge-example');
            vi.resetModules();
        }
    }, 60_000);

    it('leaves challenge, validateChallenge and isChallengeResponse undefined while the Turnstile secrets are REPLACE_ME, and warns once', async ({ skip }) => {
        skip(filledIn, FILLED_IN);
        vi.resetModules();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const config = await loadConfig();

        expect(config.challenge).toBeUndefined();
        expect(config.validateChallenge).toBeUndefined();
        expect(config.isChallengeResponse).toBeUndefined();
        expect('handleChallengeReply' in config).toBe(false);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('siteKey, secretKey, sessionSigningSecret'));
    });

    it('passes the turnstile settings to createTurnstileChallenge and wires the four callbacks it returns', async ({ skip }) => {
        skip(filledIn, FILLED_IN);
        vi.resetModules();
        const challenge = vi.fn();
        const validateChallenge = vi.fn();
        const isChallengeResponse = vi.fn();
        const originalReferer = vi.fn();
        const createTurnstileChallenge = vi.fn(() => ({ challenge, validateChallenge, isChallengeResponse, originalReferer }));
        vi.doMock('./turnstile-challenge-example', () => ({ createTurnstileChallenge }));

        const config = await loadConfig();

        expect(createTurnstileChallenge).toHaveBeenCalledOnce();
        expect(createTurnstileChallenge).toHaveBeenCalledWith({
            siteKey: 'REPLACE_ME',
            secretKey: 'REPLACE_ME',
            sessionSigningSecret: 'REPLACE_ME',
            sessionTtlSeconds: 300,
            sessionBinding: { ip: 'exact', userAgent: true },
            siteverifyErrorsToPause: 3,
            siteverifyPauseSeconds: 60,
            originalRefererVia: 'header',
        });
        expect(config.originalReferer).toBe(originalReferer);
        expect(config.challenge).toBe(challenge);
        expect(config.validateChallenge).toBe(validateChallenge);
        expect(config.isChallengeResponse).toBe(isChallengeResponse);
        expect('handleChallengeReply' in config).toBe(false);
    });

    it('ships actionOnSuspicious with ALLOW for every body method and no rules: nothing changes until set', async ({ skip }) => {
        skip(filledIn, FILLED_IN);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = await loadConfig();
        expect(config.actionOnSuspicious).toEqual({
            methods: { POST: Action.ALLOW, PUT: Action.ALLOW, PATCH: Action.ALLOW, DELETE: Action.ALLOW, OPTIONS: Action.ALLOW },
            rules: [],
        });
    });

    it('ships safe defaults', async ({ skip }) => {
        skip(filledIn, FILLED_IN);
        vi.resetModules();
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const config = await loadConfig();

        expect(config).toMatchObject({
            mode: Mode.MONITORING,
            apiKey: 'REPLACE_ME',
            tagHash: 'REPLACE_ME',
            timeout: 2000,
            debug: false,
            telemetry: false,
            logErrors: true,
            keepHeadersNames: [],
        });
    });
});
