// Tests the REAL shipped config.ts (the index specs mock it). Each test loads a fresh copy with
// vi.resetModules(), because config.ts calls createTurnstileChallenge (and may warn) while it loads.
import { RTIHelperService } from '../../core/services/rti-helper.service';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import type { TestContext } from 'vitest';
import { Mode } from '../../core/models/mode.model';
import { Action } from '../../core/models/action.model';
import type { TurnstileSettings } from './turnstile-challenge-example';

const loadConfig = async () => (await import('./config')).config;

// The five secrets of config.ts that no longer hold the placeholder the repository ships. Read once, in beforeAll.
let filledIn: string[] = [];

// The first load of the module graph is slow (seconds on a busy machine): it happens here, with a long timeout, not in
// the 5 s of a test. It also reads the five secrets: the Turnstile settings are not exported, so the real
// createTurnstileChallenge is wrapped to see them. The module registry and the mocks are left clean for the tests.
beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let turnstile: TurnstileSettings | undefined;
    vi.doMock('./turnstile-challenge-example', async (importOriginal) => {
        const real = await importOriginal<typeof import('./turnstile-challenge-example')>();
        return {
            ...real,
            createTurnstileChallenge: (settings: TurnstileSettings) => {
                turnstile = settings;
                return real.createTurnstileChallenge(settings);
            },
        };
    });
    const config = await loadConfig();
    const secrets = {
        apiKey: config.apiKey, tagHash: config.tagHash,
        siteKey: turnstile?.siteKey, secretKey: turnstile?.secretKey, sessionSigningSecret: turnstile?.sessionSigningSecret,
    };
    filledIn = Object.entries(secrets).filter(([, value]) => value !== 'REPLACE_ME').map(([name]) => name);
    vi.doUnmock('./turnstile-challenge-example');
    vi.restoreAllMocks();
    vi.resetModules();
}, 60_000);

afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./turnstile-challenge-example');
    vi.resetModules();
});

describe('Validate config', function () {
    it('verifies config is valid', async () => {
        // Arrange
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const rtiHelper = new RTIHelperService(await loadConfig());

        // Act
        const errors = rtiHelper.validateConfig();

        // Assert
        if (errors.length !== 0) {
            throw new Error(`invalid config: ${JSON.stringify(errors)}`);
        }
    });
});

describe('shipped config.ts', () => {
    // These tests guard config.ts as this repository ships it. A filled-in config.ts is not wrong, and `npm run deploy`
    // runs the tests first: as soon as one of the five secrets is set, they are skipped, so they do not stop a deploy.
    const skipIfFilledIn = (context: TestContext) =>
        context.skip(filledIn.length > 0, `config.ts is filled in (${filledIn.join(', ')} no longer REPLACE_ME)`);

    it('leaves challenge, validateChallenge, isChallengeResponse and originalReferer undefined while the Turnstile secrets are REPLACE_ME, and warns once', async (context) => {
        skipIfFilledIn(context);
        vi.resetModules();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const config = await loadConfig();

        expect(config.challenge).toBeUndefined();
        expect(config.validateChallenge).toBeUndefined();
        expect(config.isChallengeResponse).toBeUndefined();
        expect(config.originalReferer).toBeUndefined();
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('siteKey, secretKey, sessionSigningSecret'));
    });

    it('passes the turnstile settings to createTurnstileChallenge and wires the four callbacks it returns', async (context) => {
        skipIfFilledIn(context);
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
    });

    it('ships actionOnSuspicious with ALLOW for every body method and no rules: nothing changes until set', async (context) => {
        skipIfFilledIn(context);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = await loadConfig();
        expect(config.actionOnSuspicious).toEqual({
            methods: { POST: Action.ALLOW, PUT: Action.ALLOW, PATCH: Action.ALLOW, DELETE: Action.ALLOW, OPTIONS: Action.ALLOW },
            rules: [],
        });
    });

    it('ships safe defaults', async (context) => {
        skipIfFilledIn(context);
        vi.resetModules();
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const config = await loadConfig();

        expect(config).toMatchObject({
            mode: Mode.MONITORING,
            apiKey: 'REPLACE_ME',
            tagHash: 'REPLACE_ME',
            timeout: 500,
            debug: false,
            telemetry: false,
            logErrors: true,
        });
    });
});
