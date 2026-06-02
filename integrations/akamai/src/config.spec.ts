// cspell:ignore PMUSER CHEQ cheq healthcheck
/// <reference path="./types.d.ts" />
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    logLog: vi.fn(),
    parseNumberList: vi.fn(),
    parseStringList: vi.fn(),
    turnstileChallengeExample: vi.fn(),
    turnstileValidateChallengeExample: vi.fn(),
}));

vi.mock('log', () => ({
    log: { log: mocks.logLog },
}));

vi.mock('../../core/services/rti-helper.service', () => ({
    RTIHelperService: {
        parseNumberList: mocks.parseNumberList,
        parseStringList: mocks.parseStringList,
    },
}));

vi.mock('./turnstile-challenge-example', () => ({
    turnstileChallengeExample: mocks.turnstileChallengeExample,
    turnstileValidateChallengeExample: mocks.turnstileValidateChallengeExample,
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
        expect(config.challenge).toBe(mocks.turnstileChallengeExample);
        expect(config.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
    });

    it('wires in turnstile callbacks', () => {
        // Arrange
        const req = buildRequest();

        // Act
        const result = buildDynamicConfig(req);

        // Assert — relevant
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);

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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
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
        expect(result.challenge).toBe(mocks.turnstileChallengeExample);
        expect(result.validateChallenge).toBe(mocks.turnstileValidateChallengeExample);
    });
});
