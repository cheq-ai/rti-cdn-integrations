// Tests the REAL shipped config.ts (the request-helper specs mock it). Each test loads a fresh copy with
// vi.resetModules(), because config.ts calls createTurnstileChallenge (and may warn) while it loads.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Mode } from '../../core/models/mode.model';

// vi.importActual, not import(): the package compiles with module es2015, which has no dynamic import.
// Its dependencies still go through vi.doMock.
const loadConfig = async () => (await vi.importActual<typeof import('./config')>('./config')).config;

afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('./turnstile-challenge-example');
    vi.resetModules();
});

describe('shipped config.ts', () => {
    it('leaves challenge, validateChallenge and isChallengeResponse undefined while the Turnstile secrets are REPLACE_ME, and warns once', async () => {
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

    it('passes the turnstile settings to createTurnstileChallenge and wires the three callbacks it returns', async () => {
        vi.resetModules();
        const challenge = vi.fn();
        const validateChallenge = vi.fn();
        const isChallengeResponse = vi.fn();
        const createTurnstileChallenge = vi.fn(() => ({ challenge, validateChallenge, isChallengeResponse }));
        vi.doMock('./turnstile-challenge-example', () => ({ createTurnstileChallenge }));

        const config = await loadConfig();

        expect(createTurnstileChallenge).toHaveBeenCalledOnce();
        expect(createTurnstileChallenge).toHaveBeenCalledWith({
            siteKey: 'REPLACE_ME',
            secretKey: 'REPLACE_ME',
            sessionSigningSecret: 'REPLACE_ME',
            sessionTtlSeconds: 300,
            sessionBinding: { ip: 'exact', userAgent: true },
        });
        expect(config.challenge).toBe(challenge);
        expect(config.validateChallenge).toBe(validateChallenge);
        expect(config.isChallengeResponse).toBe(isChallengeResponse);
        expect('handleChallengeReply' in config).toBe(false);
    });

    it('ships safe defaults', async () => {
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
