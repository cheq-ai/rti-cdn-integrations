// cspell:ignore PMUSER CHEQ cheq healthcheck
/// <reference path="./types.d.ts" />
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    logLog: vi.fn(),
    parseNumberList: vi.fn(),
    parseStringList: vi.fn(),
    cheqChallenge: vi.fn(),
    validateCheqChallenge: vi.fn(),
    createCheqChallenge: vi.fn(),
    createRecaptchaChallenge: vi.fn(() => vi.fn()),
    createRecaptchaSessionValidator: vi.fn(),
}));

vi.mock('log', () => ({
    logger: { log: mocks.logLog },
}));

vi.mock('../../core/services/rti-helper.service', () => ({
    RTIHelperService: {
        parseNumberList: mocks.parseNumberList,
        parseStringList: mocks.parseStringList,
    },
}));

vi.mock('./cheq-challenge', () => ({
    createCheqChallenge: mocks.createCheqChallenge,
}));

// Mocked so this spec never loads the real module, which imports Akamai's built-in
// 'http-request' - not resolvable under vitest.
vi.mock('./recaptcha-v2-challenge', () => ({
    createRecaptchaChallenge: mocks.createRecaptchaChallenge,
    createRecaptchaSessionValidator: mocks.createRecaptchaSessionValidator,
    RECAPTCHA_V2_TEST_SITE_KEY: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
    RECAPTCHA_V2_TEST_SECRET: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe',
}));

import { config, buildDynamicConfig } from './config';
import { Mode } from '../../core/models/mode.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';

function buildRequest(pmuser: Record<string, string | undefined> = {}): EWRequest {
    return {
        host: 'example.com',
        path: '/page',
        url: '/page',
        method: 'GET',
        scheme: 'https',
        clientIp: '1.2.3.4',
        getHeader: vi.fn(() => []),
        getHeaders: vi.fn(() => ({})),
        setHeader: vi.fn(),
        addHeader: vi.fn(),
        removeHeader: vi.fn(),
        getVariable: vi.fn((name: string) => pmuser[name]),
        setVariable: vi.fn(),
        respondWith: vi.fn(),
    } as unknown as EWRequest;
}

describe('static config', () => {
    it('has correct default values for all fields', () => {
        // Assert
        expect(config.apiKey).toBe('REPLACE_ME');
        expect(config.tagHash).toBe('REPLACE_ME');
        expect(config.rtiHost).toBe('REPLACE_ME');
        expect(config.mode).toBe(Mode.MONITORING);
        expect(config.debug).toBe(false);
        expect(config.telemetry).toBe(false);
        expect(config.timeout).toBe(300);
        expect(config.blockingStrategy).toBeUndefined();
        expect(config.challengingStrategy).toBeUndefined();
        expect(config.redirectLocation).toBeUndefined();
        expect(config.challenge).toBeUndefined();
        expect(config.validateChallenge).toBeUndefined();
        expect(config.ignorePaths).toEqual([
            '\\.css$', '\\.js$', '\\.mjs$', '\\.map$',
            '\\.png$', '\\.jpg$', '\\.jpeg$', '\\.gif$', '\\.webp$', '\\.svg$', '\\.ico$',
            '\\.woff$', '\\.woff2$', '\\.ttf$', '\\.eot$',
            '\\.mp4$', '\\.webm$', '\\.mp3$',
            '\\.pdf$', '\\.zip$',
            '^/favicon\\.ico$',
            '^/robots\\.txt$',
            '^/sitemap.*\\.xml$',
            '^/ads\\.txt$',
            '^/health$',
            '^/healthcheck$',
            '^/ping$',
            '^/status$',
            '^/static/',
            '^/assets/',
            '^/defend/',
            '^/recaptcha/',
            '^/akamai/',
            '^/_next/',
            '^/__webpack',
        ]);
    });
});

describe('buildDynamicConfig', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.parseNumberList.mockReturnValue(undefined);
        mocks.parseStringList.mockReturnValue([]);
    });

    it('reads apiKey, tagHash, rtiHost from PMUSER variables', () => {
        // Arrange
        const req = buildRequest({
            'PMUSER_CHEQ_API_KEY': 'my-api-key',
            'PMUSER_CHEQ_TAG_HASH': 'my-tag-hash',
            'PMUSER_CHEQ_RTI_HOST': 'rti.example.com',
        });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.apiKey).toBe('my-api-key');
        expect(result.tagHash).toBe('my-tag-hash');
        expect(result.rtiHost).toBe('rti.example.com');

        // Assert — rest
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('defaults to empty strings when PMUSER variables are absent', () => {
        // Arrange
        const req = buildRequest();

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');

        // Assert — rest
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('parses BLOCKING mode', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_MODE': 'BLOCKING' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.mode).toBe(Mode.BLOCKING);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('defaults to MONITORING for invalid mode string', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_MODE': 'INVALID' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.mode).toBe(Mode.MONITORING);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('defaults to MONITORING when mode variable is absent', () => {
        // Arrange
        const req = buildRequest();

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.mode).toBe(Mode.MONITORING);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('parses valid timeout', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_TIMEOUT': '500' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.timeout).toBe(500);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('defaults timeout to 300 when variable is absent', () => {
        // Arrange
        const req = buildRequest();

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.timeout).toBe(300);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('defaults timeout to 300 when value is "0"', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_TIMEOUT': '0' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.timeout).toBe(300);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('defaults timeout to 300 when value is negative', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_TIMEOUT': '-5' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.timeout).toBe(300);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('defaults timeout to 300 when value is non-numeric', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_TIMEOUT': 'abc' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.timeout).toBe(300);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('sets debug true when PMUSER_CHEQ_DEBUG is "true"', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_DEBUG': 'true' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.debug).toBe(true);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('sets debug false when PMUSER_CHEQ_DEBUG is absent', () => {
        // Arrange
        const req = buildRequest();

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.debug).toBe(false);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('sets telemetry true when PMUSER_CHEQ_TELEMETRY is "true"', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_TELEMETRY': 'true' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.telemetry).toBe(true);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('resolves blockingStrategy from PMUSER_CHEQ_BLOCK_STRATEGY', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_BLOCK_STRATEGY': 'NOT_FOUND' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.blockingStrategy).toBe(ActionStrategy.NOT_FOUND);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('leaves blockingStrategy undefined when variable is absent', () => {
        // Arrange
        const req = buildRequest();

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.blockingStrategy).toBeUndefined();

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('resolves challengingStrategy from PMUSER_CHEQ_CHALLENGE_STRATEGY', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_CHALLENGE_STRATEGY': 'REDIRECT' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.challengingStrategy).toBe(ActionStrategy.REDIRECT);

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('calls parseNumberList for all TT code and reason PMUSER variables', () => {
        // Arrange
        const req = buildRequest({
            'PMUSER_CHEQ_BLOCK_TT_CODES': '4,5',
            'PMUSER_CHEQ_BLOCK_REASONS': '1,2',
            'PMUSER_CHEQ_CHALLENGE_TT_CODES': '3',
            'PMUSER_CHEQ_CHALLENGE_REASONS': '6',
            'PMUSER_CHEQ_REDIRECT_TT_CODES': '7',
            'PMUSER_CHEQ_REDIRECT_REASONS': '8',
        });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(mocks.parseNumberList).toHaveBeenCalledWith('4,5');
        expect(mocks.parseNumberList).toHaveBeenCalledWith('1,2');
        expect(mocks.parseNumberList).toHaveBeenCalledWith('3');
        expect(mocks.parseNumberList).toHaveBeenCalledWith('6');
        expect(mocks.parseNumberList).toHaveBeenCalledWith('7');
        expect(mocks.parseNumberList).toHaveBeenCalledWith('8');

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('calls parseStringList for ignorePaths', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_IGNORE_PATHS': '^/health$,\\.css$' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(mocks.parseStringList).toHaveBeenCalledWith('^/health$,\\.css$');

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('sets redirectLocation from PMUSER variable', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_REDIRECT_LOCATION': 'https://blocked.example.com/' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.redirectLocation).toBe('https://blocked.example.com/');

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('leaves redirectLocation undefined when variable is absent', () => {
        // Arrange
        const req = buildRequest();

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.redirectLocation).toBeUndefined();

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });


    // --- challenge provider resolution (10b) ---

    const SECRET = { 'PMUSER_CHEQ_CHALLENGE_SECRET': 'a-real-signing-secret' };
    const GOOGLE = {
        'PMUSER_CHEQ_RECAPTCHA_SITE_KEY': 'site-key',
        'PMUSER_CHEQ_RECAPTCHA_SECRET': 'google-secret',
        'PMUSER_CHEQ_RECAPTCHA_HOST': 'verify.example.com',
    };

    it.each([
        ['browser', 'browser'],
        ['recaptcha-v3', 'recaptcha-v3'],
        ['v3', 'recaptcha-v3'],
        ['recaptcha-v2', 'recaptcha-v2'],
        ['recaptcha', 'recaptcha-v2'],
        ['nonsense', 'recaptcha-v2'],
        [undefined, 'recaptcha-v2'],
    ] as const)('normalizes provider %s to %s', (raw, expected) => {
        const req = buildRequest(raw === undefined ? {} : { 'PMUSER_CHEQ_CHALLENGE_PROVIDER': raw });
        expect(buildDynamicConfig(req).challengeProvider).toBe(expected);
    });

    it('wires the browser provider without Google keys, since it needs none', () => {
        mocks.createCheqChallenge.mockReturnValue({
            challenge: mocks.cheqChallenge,
            validateChallenge: mocks.validateCheqChallenge,
        });
        const req = buildRequest({ ...SECRET, 'PMUSER_CHEQ_CHALLENGE_PROVIDER': 'browser' });
        const result = buildDynamicConfig(req);
        // The signing secret is bound into the provider here, not looked up inside it.
        expect(mocks.createCheqChallenge).toHaveBeenCalledWith('a-real-signing-secret');
        expect(result.challenge).toBe(mocks.cheqChallenge);
        expect(result.validateChallenge).toBe(mocks.validateCheqChallenge);
        expect(result.googleRecaptchaConfigured).toBe(false); // not Google, but a challenge IS available
    });

    it('wires reCAPTCHA when Google keys, a verify host and a signing secret are all present', () => {
        const req = buildRequest({ ...SECRET, ...GOOGLE });
        const result = buildDynamicConfig(req);
        expect(mocks.createRecaptchaChallenge).toHaveBeenCalledWith(expect.objectContaining({
            version: 'v2', siteKey: 'site-key', secret: 'google-secret', verifyHost: 'verify.example.com',
            // Google's siteverify key and the _cq_se signing key are distinct values
            sessionSecret: 'a-real-signing-secret',
        }));
        expect(mocks.createRecaptchaSessionValidator).toHaveBeenCalledWith('a-real-signing-secret');
        expect(result.googleRecaptchaConfigured).toBe(true);
    });

    // v2 and v3 differ only by this one field at the wiring layer, and the keys are NOT
    // interchangeable - wiring a v3 site key as v2 fails every verification at runtime, with
    // nothing at config time to say why.
    it('wires reCAPTCHA v3 with version v3 and the configured score threshold', () => {
        const req = buildRequest({
            ...SECRET, ...GOOGLE,
            'PMUSER_CHEQ_CHALLENGE_PROVIDER': 'recaptcha-v3',
            'PMUSER_CHEQ_RECAPTCHA_MIN_SCORE': '0.7',
        });
        const result = buildDynamicConfig(req);
        expect(mocks.createRecaptchaChallenge).toHaveBeenCalledWith(expect.objectContaining({
            version: 'v3',
            siteKey: 'site-key',
            secret: 'google-secret',
            verifyHost: 'verify.example.com',
            scoreThreshold: 0.7,
            sessionSecret: 'a-real-signing-secret',
        }));
        expect(result.googleRecaptchaConfigured).toBe(true);
    });

    it('falls back to RTI_HOST for the reCAPTCHA verify host', () => {
        const req = buildRequest({
            ...SECRET,
            'PMUSER_CHEQ_RECAPTCHA_SITE_KEY': 'site-key',
            'PMUSER_CHEQ_RECAPTCHA_SECRET': 'google-secret',
            'PMUSER_CHEQ_RTI_HOST': 'rti.example.com',
        });
        buildDynamicConfig(req);
        expect(mocks.createRecaptchaChallenge).toHaveBeenCalledWith(
            expect.objectContaining({ verifyHost: 'rti.example.com' }));
    });

    it('does not wire reCAPTCHA when the verify host is missing', () => {
        const req = buildRequest({
            ...SECRET,
            'PMUSER_CHEQ_RECAPTCHA_SITE_KEY': 'site-key',
            'PMUSER_CHEQ_RECAPTCHA_SECRET': 'google-secret',
        });
        const result = buildDynamicConfig(req);
        expect(result.challenge).toBeUndefined();
        expect(result.googleRecaptchaConfigured).toBe(false);
    });

    it('treats REPLACE_ME Google keys as unconfigured', () => {
        const req = buildRequest({
            ...SECRET,
            'PMUSER_CHEQ_RECAPTCHA_SITE_KEY': 'REPLACE_ME',
            'PMUSER_CHEQ_RECAPTCHA_SECRET': 'REPLACE_ME',
            'PMUSER_CHEQ_RECAPTCHA_HOST': 'verify.example.com',
        });
        expect(buildDynamicConfig(req).googleRecaptchaConfigured).toBe(false);
    });

    // --- the signing-secret gate: no secret means no challenge, whatever else is configured ---

    it('drops the challenge callbacks when no signing secret is set, even with valid Google keys', () => {
        const result = buildDynamicConfig(buildRequest({ ...GOOGLE }));
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('drops the challenge callbacks when no signing secret is set, even for the browser provider', () => {
        const result = buildDynamicConfig(buildRequest({ 'PMUSER_CHEQ_CHALLENGE_PROVIDER': 'browser' }));
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('treats a REPLACE_ME signing secret as unset', () => {
        const req = buildRequest({ 'PMUSER_CHEQ_CHALLENGE_SECRET': 'REPLACE_ME', 'PMUSER_CHEQ_CHALLENGE_PROVIDER': 'browser' });
        expect(buildDynamicConfig(req).challenge).toBeUndefined();
    });

    // --- opt-in test keys and numeric options ---

    it('uses Google test keys only when explicitly opted in', () => {
        const req = buildRequest({
            ...SECRET,
            'PMUSER_CHEQ_RECAPTCHA_TEST_KEYS': 'true',
            'PMUSER_CHEQ_RECAPTCHA_HOST': 'verify.example.com',
        });
        expect(buildDynamicConfig(req).googleRecaptchaConfigured).toBe(true);
        expect(mocks.createRecaptchaChallenge).toHaveBeenCalledWith(
            expect.objectContaining({ siteKey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI' }));
    });

    it('does not use test keys without the opt-in', () => {
        const req = buildRequest({ ...SECRET, 'PMUSER_CHEQ_RECAPTCHA_HOST': 'verify.example.com' });
        expect(buildDynamicConfig(req).googleRecaptchaConfigured).toBe(false);
    });

    it('parses the v3 score threshold and leaves it undefined when absent or invalid', () => {
        expect(buildDynamicConfig(buildRequest({ 'PMUSER_CHEQ_RECAPTCHA_MIN_SCORE': '0.7' })).recaptchaScoreThreshold).toBe(0.7);
        expect(buildDynamicConfig(buildRequest({})).recaptchaScoreThreshold).toBeUndefined();
        expect(buildDynamicConfig(buildRequest({ 'PMUSER_CHEQ_RECAPTCHA_MIN_SCORE': 'abc' })).recaptchaScoreThreshold).toBeUndefined();
    });

    it('passes CHALLENGE_TTL through to the reCAPTCHA factory, ignoring non-positive values', () => {
        buildDynamicConfig(buildRequest({ ...SECRET, ...GOOGLE, 'PMUSER_CHEQ_CHALLENGE_TTL': '600' }));
        expect(mocks.createRecaptchaChallenge).toHaveBeenCalledWith(expect.objectContaining({ sessionTtlSeconds: 600 }));

        mocks.createRecaptchaChallenge.mockClear();
        buildDynamicConfig(buildRequest({ ...SECRET, ...GOOGLE, 'PMUSER_CHEQ_CHALLENGE_TTL': '0' }));
        expect(mocks.createRecaptchaChallenge).toHaveBeenCalledWith(expect.objectContaining({ sessionTtlSeconds: undefined }));
    });

    // parseStringList returns undefined for an unset variable, and shouldIgnore() treats
    // undefined as "ignore nothing". So a dynamic config without PMUSER_CHEQ_IGNORE_PATHS used to
    // classify EVERY request - every stylesheet, image and favicon burning an RTI call - and,
    // worse, stopped excluding the worker's own self-proxy paths, which must never be classified.
    // The static config's curated list is the fallback.
    it('falls back to the built-in ignore paths when PMUSER_CHEQ_IGNORE_PATHS is unset', () => {
        // Arrange
        mocks.parseStringList.mockReturnValue(undefined);
        const req = buildRequest({});

        // Act
        const result = buildDynamicConfig(req);

        // Assert
        expect(result.ignorePaths).toEqual(config.ignorePaths);
        expect(result.ignorePaths).toContain('^/defend/');
        expect(result.ignorePaths).toContain('^/recaptcha/');
        expect(result.ignorePaths?.length).toBeGreaterThan(20);
    });

    it('uses the operator-supplied list when PMUSER_CHEQ_IGNORE_PATHS is set', () => {
        // Arrange - an explicit value replaces the defaults rather than merging with them.
        mocks.parseStringList.mockReturnValue(['^/only-this$']);
        const req = buildRequest({ 'PMUSER_CHEQ_IGNORE_PATHS': '^/only-this$' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert
        expect(result.ignorePaths).toEqual(['^/only-this$']);
    });

    it('logs a warning for an unrecognised provider when debug is on, and falls back to recaptcha-v2', () => {
        // A typo like 'broswer' would otherwise silently become reCAPTCHA-without-keys, i.e. no
        // challenge at all, with nothing explaining why.
        const req = buildRequest({ 'PMUSER_CHEQ_CHALLENGE_PROVIDER': 'broswer', 'PMUSER_CHEQ_DEBUG': 'true' });

        const result = buildDynamicConfig(req);

        expect(result.challengeProvider).toBe('recaptcha-v2');
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('unrecognised PMUSER_CHEQ_CHALLENGE_PROVIDER'));
    });

    it('does not warn for the legacy `recaptcha` alias', () => {
        const req = buildRequest({ 'PMUSER_CHEQ_CHALLENGE_PROVIDER': 'recaptcha', 'PMUSER_CHEQ_DEBUG': 'true' });

        const result = buildDynamicConfig(req);

        expect(result.challengeProvider).toBe('recaptcha-v2');
        expect(mocks.logLog).not.toHaveBeenCalledWith(expect.stringContaining('unrecognised'));
    });

    it('wires no challenge callbacks when neither Google keys nor a signing secret are set', () => {
        // Arrange
        const req = buildRequest();

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant. Default provider is recaptcha-v2, which needs Google keys; and
        // without PMUSER_CHEQ_CHALLENGE_SECRET the callbacks are dropped regardless of provider.
        expect(result.challengeProvider).toBe('recaptcha-v2');
        expect(result.googleRecaptchaConfigured).toBe(false);
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
    });

    it('reads rtiLoggerHost from PMUSER_CHEQ_RTI_LOGGER_HOST', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_RTI_LOGGER_HOST': 'logger.example.com' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.rtiLoggerHost).toBe('logger.example.com');

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('leaves rtiLoggerHost undefined when PMUSER_CHEQ_RTI_LOGGER_HOST is absent', () => {
        // Arrange
        const req = buildRequest();

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.rtiLoggerHost).toBeUndefined();

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('logs sanitized config (no apiKey/tagHash) when debug is true', () => {
        // Arrange
        const req = buildRequest({ 'PMUSER_CHEQ_DEBUG': 'true', 'PMUSER_CHEQ_API_KEY': 'secret', 'PMUSER_CHEQ_TAG_HASH': 'secret-hash' });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(mocks.logLog).toHaveBeenCalled();
        const logArg = mocks.logLog.mock.calls[0][1] as string;
        expect(logArg).not.toContain('secret');
        expect(logArg).not.toContain('secret-hash');

        // Assert — rest
        expect(result.apiKey).toBe('secret');
        expect(result.tagHash).toBe('secret-hash');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(true);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('does not log when debug is false', () => {
        // Arrange
        const req = buildRequest();

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(mocks.logLog).not.toHaveBeenCalled();

        // Assert — rest
        expect(result.apiKey).toBe('');
        expect(result.tagHash).toBe('');
        expect(result.rtiHost).toBe('');
        expect(result.mode).toBe(Mode.MONITORING);
        expect(result.timeout).toBe(300);
        expect(result.debug).toBe(false);
        expect(result.telemetry).toBe(false);
        expect(result.blockingStrategy).toBeUndefined();
        expect(result.challengingStrategy).toBeUndefined();
        expect(result.blockTTCodes).toBeUndefined();
        expect(result.blockReasons).toBeUndefined();
        expect(result.challengeTTCodes).toBeUndefined();
        expect(result.challengeReasons).toBeUndefined();
        expect(result.redirectTTCodes).toBeUndefined();
        expect(result.redirectReasons).toBeUndefined();
        expect(result.redirectLocation).toBeUndefined();
        expect(result.ignorePaths).toEqual([]);
        expect(result.rtiLoggerHost).toBeUndefined();
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });

    it('maps all PMUSER variables to the corresponding config fields', () => {
        // Arrange
        mocks.parseNumberList
            .mockReturnValueOnce([4, 5])  // blockTTCodes
            .mockReturnValueOnce([1, 2])  // blockReasons
            .mockReturnValueOnce([3])     // challengeTTCodes
            .mockReturnValueOnce([6])     // challengeReasons
            .mockReturnValueOnce([7])     // redirectTTCodes
            .mockReturnValueOnce([8]);    // redirectReasons
        mocks.parseStringList.mockReturnValue(['^/health$', '\\.css$']);
        const req = buildRequest({
            'PMUSER_CHEQ_API_KEY':            'my-api-key',
            'PMUSER_CHEQ_TAG_HASH':           'my-tag-hash',
            'PMUSER_CHEQ_RTI_HOST':           'rti.example.com',
            'PMUSER_CHEQ_MODE':               'BLOCKING',
            'PMUSER_CHEQ_TIMEOUT':            '500',
            'PMUSER_CHEQ_DEBUG':              'true',
            'PMUSER_CHEQ_TELEMETRY':          'true',
            'PMUSER_CHEQ_BLOCK_STRATEGY':     'NOT_FOUND',
            'PMUSER_CHEQ_CHALLENGE_STRATEGY': 'REDIRECT',
            'PMUSER_CHEQ_BLOCK_TT_CODES':     '4,5',
            'PMUSER_CHEQ_BLOCK_REASONS':      '1,2',
            'PMUSER_CHEQ_CHALLENGE_TT_CODES': '3',
            'PMUSER_CHEQ_CHALLENGE_REASONS':  '6',
            'PMUSER_CHEQ_REDIRECT_TT_CODES':  '7',
            'PMUSER_CHEQ_REDIRECT_REASONS':   '8',
            'PMUSER_CHEQ_REDIRECT_LOCATION':  'https://blocked.example.com/',
            'PMUSER_CHEQ_IGNORE_PATHS':       '^/health$,\\.css$',
            'PMUSER_CHEQ_RTI_LOGGER_HOST':    'logger.example.com',
        });

        // Act
        const result = buildDynamicConfig(req);

        // Assert — all fields
        expect(result.apiKey).toBe('my-api-key');
        expect(result.tagHash).toBe('my-tag-hash');
        expect(result.rtiHost).toBe('rti.example.com');
        expect(result.mode).toBe(Mode.BLOCKING);
        expect(result.timeout).toBe(500);
        expect(result.debug).toBe(true);
        expect(result.telemetry).toBe(true);
        expect(result.blockingStrategy).toBe(ActionStrategy.NOT_FOUND);
        expect(result.challengingStrategy).toBe(ActionStrategy.REDIRECT);
        expect(result.blockTTCodes).toEqual([4, 5]);
        expect(result.blockReasons).toEqual([1, 2]);
        expect(result.challengeTTCodes).toEqual([3]);
        expect(result.challengeReasons).toEqual([6]);
        expect(result.redirectTTCodes).toEqual([7]);
        expect(result.redirectReasons).toEqual([8]);
        expect(result.redirectLocation).toBe('https://blocked.example.com/');
        expect(result.ignorePaths).toEqual(['^/health$', '\\.css$']);
        expect(result.rtiLoggerHost).toBe('logger.example.com');
        expect(result.challenge).toBeUndefined();
        expect(result.validateChallenge).toBeUndefined();
    });
});
