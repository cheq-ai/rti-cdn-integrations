// cspell:ignore duid pvid
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CloudFrontRequest, CloudFrontRequestEvent } from 'aws-lambda';

const mocks = vi.hoisted(() => ({
    callRTI: vi.fn(),
    shouldIgnore: vi.fn(),
    getAction: vi.fn(),
    getActionStrategy: vi.fn(),
    getEventType: vi.fn().mockReturnValue('pageview'),
    validateChallenge: vi.fn(),
    loggerInfo: vi.fn().mockResolvedValue(undefined),
    loggerError: vi.fn().mockResolvedValue(undefined),
    generateDefaultBlockPage: vi.fn().mockReturnValue('<html>blocked</html>'),
}));

vi.mock('../package.json', () => ({ name: 'test', version: '1.0.0' }));

vi.mock('./config', () => ({
    config: {
        tagHash: 'tag-hash',
        apiKey: 'api-key',
        debug: false,
        telemetry: false,
        keepHeadersNames: [] as string[],
        validateChallenge: mocks.validateChallenge,
        challenge: undefined as any,
        redirectLocation: 'https://www.cheq.ai/',
    },
}));

vi.mock('../../core/services/rti-https.service', () => ({
    RTIHttpsService: vi.fn().mockImplementation(function () { return { callRTI: mocks.callRTI }; }),
}));

vi.mock('../../core/services/rti-helper.service', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../core/services/rti-helper.service')>();
    return {
        RTIHelperService: vi.fn().mockImplementation(function (config: any) {
            // buildRtiResultHeader, parseCookies, isChallengeReplyAllowed and errorMessage are pure functions with no side
            // effects — use the real implementation so tests verify actual output rather than a duplicated mock formula.
            const realInstance = new real.RTIHelperService(config);
            return {
                shouldIgnore: mocks.shouldIgnore,
                getAction: mocks.getAction,
                getActionStrategy: mocks.getActionStrategy,
                getEventType: mocks.getEventType,
                validateConfig: vi.fn().mockReturnValue([]),
                parseCookies: realInstance.parseCookies.bind(realInstance),
                stringifyRedactedPayload: realInstance.stringifyRedactedPayload.bind(realInstance),
                cookieNames: realInstance.cookieNames.bind(realInstance),
                redactHeaderValue: realInstance.redactHeaderValue.bind(realInstance),
                buildRtiResultHeader: realInstance.buildRtiResultHeader.bind(realInstance),
                isChallengeReplyAllowed: realInstance.isChallengeReplyAllowed.bind(realInstance),
                errorMessage: realInstance.errorMessage.bind(realInstance),
            };
        }),
    };
});

vi.mock('../../core/services/rti-https-logger.service', () => ({
    RTIHttpsLoggerService: vi.fn().mockImplementation(function () {
        return {
            info: mocks.loggerInfo,
            error: mocks.loggerError,
        };
    }),
}));

vi.mock('../../core/helpers/block-page-helpers', () => ({
    generateDefaultBlockPage: mocks.generateDefaultBlockPage,
}));

import { handle, RequestType } from './request-helper';
import { Action } from '../../core/models/action.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { Mode } from '../../core/models/mode.model';
import { config } from './config';
import type { TestAdapter, NormalizedResult, InvokeOptions, ConfigOverrides } from '../../core/testing/test-adapter.interface';
import { registerSharedBehaviorTests } from '../../core/testing/shared-unit-tests';
import { buildRTIResponse } from '../../core/testing/rti-response.fixture';
import { RTIHttpsService } from '../../core/services/rti-https.service';
import { RTIHttpsLoggerService } from '../../core/services/rti-https-logger.service';
import { createTurnstileChallenge } from './turnstile-challenge-example';

// request-helper creates its services once, at import. Copied now: vi.clearAllMocks() in beforeEach wipes mock.calls.
// The shipped Turnstile reply detector, set as config.isChallengeResponse in 'request-helper handle'.
const turnstileIsChallengeResponse = createTurnstileChallenge({
    siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'signing-secret', sessionTtlSeconds: 300,
}).isChallengeResponse;

const rtiServiceCtorCalls = [...vi.mocked(RTIHttpsService).mock.calls];
const loggerCtorCalls = [...vi.mocked(RTIHttpsLoggerService).mock.calls];

function buildEvent(uri = '/page', host = 'example.com', clientIp = '1.2.3.4', querystring = '', cookies = '', opts: {
    method?: string;
    extraHeaders?: Record<string, string>;
} = {}): CloudFrontRequestEvent {
    const headers: Record<string, any> = {
        host: [{ key: 'Host', value: host }],
        'user-agent': [{ key: 'User-Agent', value: 'Mozilla/5.0' }],
    };
    if (cookies) {
        headers['cookie'] = [{ key: 'Cookie', value: cookies }];
    }
    if (opts.extraHeaders) {
        for (const [k, v] of Object.entries(opts.extraHeaders)) {
            headers[k.toLowerCase()] = [{ key: k, value: v }];
        }
    }
    return {
        Records: [{
            cf: {
                config: {
                    distributionDomainName: 'xxx.cloudfront.net',
                    distributionId: 'DIST123',
                    eventType: 'origin-request',
                    requestId: 'req-123',
                },
                request: {
                    clientIp,
                    method: opts.method ?? 'GET',
                    uri,
                    querystring,
                    headers,
                },
            },
        }],
    } as CloudFrontRequestEvent;
}

// Normalize CloudFront's { status: '302', headers: {...} } to NormalizedResult
function normalizeCloudFrontResult(cfResult: any, originalRequest: any): NormalizedResult {
    if (!cfResult || cfResult === originalRequest) {
        // Pass-through: original request object returned
        return { status: 200, headers: {}, body: '', passedThrough: true };
    }
    const status = parseInt(cfResult.status ?? '200', 10);
    const headers: Record<string, string> = {};
    if (cfResult.headers) {
        for (const [key, values] of Object.entries(cfResult.headers as Record<string, any[]>)) {
            headers[key.toLowerCase()] = values.map((v: any) => v.value).join(', ');
        }
    }
    // Also include x-cheq-rti-result set on the request when it's still the cfRequest (ALLOW path)
    const cfReqHeader = originalRequest?.headers?.['x-cheq-rti-result'];
    if (cfReqHeader) {
        headers['x-cheq-rti-result'] = cfReqHeader.map((v: any) => v.value).join(', ');
    }
    return {
        status,
        headers,
        body: cfResult.body ?? '',
        passedThrough: false,
    };
}

// Stores console.log calls captured during the last invoke() call.
let _lastConsoleLogs: string[] = [];

// --- CloudFront adapter ---

const cloudfrontAdapter: TestAdapter = {
    name: 'cloudfront',
    // RTI always runs; a valid session only waives the CAPTCHA (tested in 'request-helper handle').
    validChallengeSkipsRti: false,

    async invoke(options: InvokeOptions = {}): Promise<NormalizedResult> {
        _lastConsoleLogs = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            _lastConsoleLogs.push(String(args[0]));
        });

        const event = buildEvent(options.path ?? '/page', 'example.com', options.ip ?? '1.2.3.4', options.querystring ?? '', options.cookies ?? '', {
            method: options.method,
            extraHeaders: options.headers,
        });
        const cfRequest = event.Records[0].cf.request;
        const result = await handle(event, RequestType.ORIGIN_REQUEST);
        consoleSpy.mockRestore();

        const normalized = normalizeCloudFrontResult(result, cfRequest);

        // ALLOW path: request object is returned with x-cheq-rti-result header set on it
        if (result === cfRequest) {
            const rtiHeader = cfRequest.headers?.['x-cheq-rti-result'];
            if (rtiHeader) {
                normalized.headers['x-cheq-rti-result'] = rtiHeader.map((v: any) => v.value).join(', ');
            }
            return { ...normalized, passedThrough: true };
        }

        return normalized;
    },

    getLastRTIPayload() {
        return mocks.callRTI.mock.calls[0]?.[0];
    },

    setConfig(overrides: ConfigOverrides) {
        if ('debug' in overrides) (config as any).debug = overrides.debug;
        if ('telemetry' in overrides) (config as any).telemetry = overrides.telemetry;
        if ('redirectLocation' in overrides) (config as any).redirectLocation = overrides.redirectLocation;
        if ('validateChallenge' in overrides) (config as any).validateChallenge = overrides.validateChallenge;
        if ('challenge' in overrides) {
            if (overrides.challenge === 'working') {
                (config as any).challenge = vi.fn().mockResolvedValue({ status: '403', body: '<html>captcha</html>' });
            } else if (overrides.challenge === 'throwing') {
                (config as any).challenge = vi.fn().mockRejectedValue(new Error('challenge failed'));
            } else {
                (config as any).challenge = overrides.challenge;
            }
        }
    },

    resetConfig() {
        (config as any).debug = false;
        (config as any).telemetry = false;
        (config as any).logErrors = undefined;
        (config as any).challenge = undefined;
        (config as any).validateChallenge = mocks.validateChallenge;
        (config as any).isChallengeResponse = undefined;
        (config as any).mode = undefined;
        (config as any).redirectLocation = 'https://www.cheq.ai/';
        (config as any).keepHeadersNames = [];
    },

    assertDebugLogged(substring: string) {
        const logged = _lastConsoleLogs.some(msg => msg.includes(substring));
        expect(logged, `expected debug log containing "${substring}"`).toBe(true);
    },

    assertNotDebugLogged() {
        expect(_lastConsoleLogs).toHaveLength(0);
    },

    assertNotInDebugLogs(substring: string) {
        const leaked = _lastConsoleLogs.filter(msg => msg.includes(substring));
        expect(leaked, `expected no debug log containing "${substring}"`).toEqual([]);
    },

    assertErrorLogged(substring: string) {
        const logged = mocks.loggerError.mock.calls.some(args => String(args[0]).includes(substring));
        expect(logged, `expected error log containing "${substring}"`).toBe(true);
    },

    wasTelemetryLogged() {
        return mocks.loggerInfo.mock.calls.some(args => String(args[0]).includes('rti_duration'));
    },
};

// --- Register shared behavioral tests ---

registerSharedBehaviorTests(cloudfrontAdapter, mocks);

// --- CloudFront-specific tests ---

describe('request-helper handle', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let expectError = false;

    beforeEach(() => {
        vi.clearAllMocks();
        expectError = false;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.shouldIgnore.mockReturnValue(false);
        mocks.validateChallenge.mockResolvedValue(false);
        mocks.getAction.mockReturnValue(Action.ALLOW);
        mocks.callRTI.mockResolvedValue(buildRTIResponse());
        (config as any).debug = false;
        (config as any).telemetry = false;
        (config as any).logErrors = undefined;
        (config as any).keepHeadersNames = [];
        (config as any).challenge = undefined;
        (config as any).validateChallenge = mocks.validateChallenge;
        (config as any).isChallengeResponse = turnstileIsChallengeResponse;
        (config as any).mode = undefined;
        (config as any).redirectLocation = 'https://www.cheq.ai/';
    });

    afterEach(() => {
        if (!expectError) {
            expect(consoleErrorSpy).not.toHaveBeenCalled();
            expect(mocks.loggerError).not.toHaveBeenCalled();
        }
        consoleErrorSpy.mockRestore();
        vi.restoreAllMocks(); // spies a failed test did not get to restore must not leak into the next one
        vi.unstubAllGlobals();
    });

    // --- RTI ALLOW ---

    it('returns cfRequest when RTI returns ALLOW', async () => {
        // Arrange
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
    });

    // --- x-cheq-rti-result header detail ---

    it('sets x-cheq-rti-result on the request forwarded to origin on ALLOW', async () => {
        // Arrange
        const event = buildEvent();

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const header = event.Records[0].cf.request.headers['x-cheq-rti-result'];
        expect(header).toBeDefined();
        expect(header[0].key).toBe('x-cheq-rti-result');
        expect(header[0].value).toContain('version=4.1');
        expect(header[0].value).toContain('verdict=benign');
        expect(header[0].value).toContain('threat-type-code=0');
        expect(header[0].value).toContain('ids=');
    });

    it('x-cheq-rti-result matches real benign v4.1 response shape (sparse ids)', async () => {
        // Arrange
        const ids = { rayId: 'd07fd4d7105b1bf24912745b1fde2c55', pageViewId: null, duid: null, uniqueVisitId: null, customParam1: 'page_load', customParam2: 'a024abc8ff1b2674' };
        mocks.callRTI.mockResolvedValue({ metadata: { version: '4.1' }, decision: { verdict: 'benign' }, classification: { code: 0 }, ids, cheqDetection: { reasons: [] } });
        const event = buildEvent();

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const value = event.Records[0].cf.request.headers['x-cheq-rti-result'][0].value;
        expect(value).toBe('version=4.1;verdict=benign;threat-type-code=0;ids={"rayId":"d07fd4d7105b1bf24912745b1fde2c55","pageViewId":null,"duid":null,"uniqueVisitId":null,"customParam1":"page_load","customParam2":"a024abc8ff1b2674"}');
    });

    it('x-cheq-rti-result serializes all ids fields when fully populated', async () => {
        // Arrange
        const ids = { rayId: 'f3a1c2e4b5d6789012345678abcdef01', pageViewId: '9e8d7c6b5a4f3e2d', duid: '4.16a154e6ae45bc91bf9a49b365beb989', uniqueVisitId: 'uv-4f3e2d1c0b9a8765', customParam1: 'page_load', customParam2: 'cf-ray-abc123' };
        mocks.callRTI.mockResolvedValue({ metadata: { version: '4.1' }, decision: { verdict: 'benign' }, classification: { code: 0 }, ids, cheqDetection: { reasons: [] } });
        const event = buildEvent();

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const value = event.Records[0].cf.request.headers['x-cheq-rti-result'][0].value;
        expect(value).toBe(`version=4.1;verdict=benign;threat-type-code=0;ids=${JSON.stringify(ids)}`);
    });

    it('does not set x-cheq-rti-result on the request when action is BLOCK', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);
        const event = buildEvent();

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']).toBeUndefined();
    });

    // --- Header collection ---

    const definedHeaders = (headers: Record<string, any>) =>
        Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));

    it('collects all headers when keepHeadersNames is empty', async () => {
        // Arrange
        const event = buildEvent();

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const headers = definedHeaders(mocks.callRTI.mock.calls[0][0].endUserParams.headers);
        expect(Object.keys(headers)).toHaveLength(2);
        expect(headers).toHaveProperty('host', 'example.com');
        expect(headers).toHaveProperty('user-agent', 'Mozilla/5.0');
    });

    it('collects all headers when keepHeadersNames is undefined', async () => {
        // Arrange
        (config as any).keepHeadersNames = undefined;
        const event = buildEvent();

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const headers = definedHeaders(mocks.callRTI.mock.calls[0][0].endUserParams.headers);
        expect(Object.keys(headers)).toHaveLength(2);
        expect(headers).toHaveProperty('host');
        expect(headers).toHaveProperty('user-agent');
    });

    it('filters to keepHeadersNames when non-empty', async () => {
        // Arrange
        (config as any).keepHeadersNames = ['host'];
        const event = buildEvent();

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const headers = definedHeaders(mocks.callRTI.mock.calls[0][0].endUserParams.headers);
        expect(Object.keys(headers)).toHaveLength(1);
        expect(headers).toHaveProperty('host', 'example.com');
        expect(headers).not.toHaveProperty('user-agent');
    });

    it('omits header from payload when keepHeadersNames lists a header not present in the request', async () => {
        // Arrange
        (config as any).keepHeadersNames = ['host', 'x-not-present'];
        const event = buildEvent();

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.headers).not.toHaveProperty('x-not-present');
        expect(payload.endUserParams.headers).toHaveProperty('host');
    });

    it('includes cheq_ja3 and cheq_ja4 fingerprints when cloudfront viewer fingerprint headers are present', async () => {
        // Arrange
        const event = buildEvent();
        event.Records[0].cf.request.headers['cloudfront-viewer-ja3-fingerprint'] = [{ key: 'cloudfront-viewer-ja3-fingerprint', value: 'abc123ja3' }];
        event.Records[0].cf.request.headers['cloudfront-viewer-ja4-fingerprint'] = [{ key: 'cloudfront-viewer-ja4-fingerprint', value: 'def456ja4' }];

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.headers.cheq_ja3).toBe('abc123ja3');
        expect(payload.endUserParams.headers.cheq_ja4).toBe('def456ja4');
    });

    it('sets cheq_ja3 to undefined when cloudfront-viewer-ja3-fingerprint value is an empty string', async () => {
        // Arrange
        const event = buildEvent();
        event.Records[0].cf.request.headers['cloudfront-viewer-ja3-fingerprint'] = [{ key: 'cloudfront-viewer-ja3-fingerprint', value: '' }];

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.headers.cheq_ja3).toBeUndefined();
    });

    it('sets cheq_ja4 to undefined when cloudfront-viewer-ja4-fingerprint value is an empty string', async () => {
        // Arrange
        const event = buildEvent();
        event.Records[0].cf.request.headers['cloudfront-viewer-ja4-fingerprint'] = [{ key: 'cloudfront-viewer-ja4-fingerprint', value: '' }];

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.headers.cheq_ja4).toBeUndefined();
    });

    // --- URL construction ---

    it('builds request URL from host header and uri', async () => {
        // Arrange
        const event = buildEvent('/my-page', 'example.com');

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.requestUrl).toBe('https://example.com/my-page');
    });

    it('fails open to cfRequest when host header is absent', async () => {
        // Arrange
        expectError = true;
        const event = buildEvent('/my-page', 'example.com');
        delete event.Records[0].cf.request.headers['host'];

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).toHaveBeenCalled();
    });

    it('appends querystring to URL when present', async () => {
        // Arrange
        const event = buildEvent('/page', 'example.com', '1.2.3.4', 'foo=bar&baz=1');

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.requestUrl).toBe('https://example.com/page?foo=bar&baz=1');
    });

    it('does not append "?" when querystring is empty', async () => {
        // Arrange
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '');

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.requestUrl).toBe('https://example.com/page');
        expect(payload.endUserParams.requestUrl).not.toContain('?');
    });

    // --- x-cheq-cdn-request-id on REDIRECT ---

    it('includes x-cheq-id and x-cheq-cdn-request-id headers on REDIRECT', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST) as any;

        // Assert
        expect(result.headers['x-cheq-id'][0].value).toBe('ray-123');
        expect(result.headers['x-cheq-cdn-request-id'][0].value).toBe('req-123');
    });

    // --- Challenge session (validateChallenge) ---
    // RTI always runs. A valid session (validateChallenge → true) only waives the CAPTCHA: the request is
    // forwarded with the real verdict in x-cheq-rti-result. It never waives a block, 404 or redirect.

    const captchaVerdict = () => {
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious' }));
        const challenge = vi.fn().mockResolvedValue({ status: '403', body: '<html>captcha</html>' });
        (config as any).challenge = challenge;
        return challenge;
    };

    it('calls RTI when validateChallenge is not configured', async () => {
        // Arrange
        (config as any).validateChallenge = undefined;
        const event = buildEvent();

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(mocks.callRTI).toHaveBeenCalled();
    });

    it('calls RTI and sets x-cheq-rti-result on ALLOW even with a valid session, without validating it', async () => {
        // Arrange
        mocks.validateChallenge.mockResolvedValue(true);
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=tok|ray');

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.callRTI).toHaveBeenCalledOnce();
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']?.[0].value).toContain('verdict=benign');
        expect(mocks.validateChallenge).not.toHaveBeenCalled();
    });

    it('waives the CAPTCHA for a valid session: forwards with the real verdict, challenge not called', async () => {
        // Arrange
        const challenge = captchaVerdict();
        mocks.validateChallenge.mockResolvedValue(true);
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=tok|ray');

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.callRTI).toHaveBeenCalledOnce();
        expect(challenge).not.toHaveBeenCalled();
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']?.[0].value).toContain('verdict=suspicious');
    });

    it('calls challenge and returns its result when the session is not valid', async () => {
        // Arrange
        const challenge = captchaVerdict();
        mocks.validateChallenge.mockResolvedValue(false);
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(challenge).toHaveBeenCalledWith(
            event.Records[0].cf.request,
            expect.objectContaining({ decision: expect.objectContaining({ verdict: 'suspicious' }) }),
            expect.any(Function), // addRtiResultHeader
        );
        expect(result).toEqual({ status: '403', body: '<html>captcha</html>' });
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']).toBeUndefined();
    });

    it('gives challenge an addRtiResultHeader that sets x-cheq-rti-result with the real verdict', async () => {
        // Arrange
        const challenge = captchaVerdict();
        mocks.validateChallenge.mockResolvedValue(false);
        await handle(buildEvent(), RequestType.VIEWER_REQUEST);
        const addRtiResultHeader = challenge.mock.calls[0][2];
        const headers: Record<string, any> = { location: [{ key: 'Location', value: 'https://example.com/' }] };

        // Act
        addRtiResultHeader(headers);

        // Assert
        expect(headers['x-cheq-rti-result']).toEqual([{ key: 'x-cheq-rti-result', value: expect.stringContaining('verdict=suspicious') }]);
        expect(headers.location).toEqual([{ key: 'Location', value: 'https://example.com/' }]);
    });

    it.each([
        [Action.BLOCK, ActionStrategy.ACCESS_DENIED, '403'],
        [Action.BLOCK, ActionStrategy.NOT_FOUND, '404'],
        [Action.REDIRECT, ActionStrategy.REDIRECT, '302'],
    ])('a valid session does not waive action %s / strategy %s (returns %s)', async (action, strategy, status) => {
        // Arrange
        (config as any).challenge = vi.fn();
        mocks.validateChallenge.mockResolvedValue(true);
        mocks.getAction.mockReturnValue(action);
        mocks.getActionStrategy.mockReturnValue(strategy);
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=tok|ray');

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST) as any;

        // Assert
        expect(result.status).toBe(status);
        expect(mocks.validateChallenge).not.toHaveBeenCalled();
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']).toBeUndefined();
    });

    it('forwards with x-cheq-rti-result on CAPTCHA when no challenge is configured, without validating', async () => {
        // Arrange
        captchaVerdict();
        (config as any).challenge = undefined;
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']?.[0].value).toContain('verdict=suspicious');
        expect(mocks.validateChallenge).not.toHaveBeenCalled();
    });

    it('calls validateChallenge with the cfRequest containing the _cq_se cookie', async () => {
        // Arrange
        captchaVerdict();
        mocks.validateChallenge.mockResolvedValue(false);
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=sometoken|someray');

        // Act
        await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(mocks.validateChallenge).toHaveBeenCalledWith(
            event.Records[0].cf.request,
            false // isDebug
        );
    });

    it('calls validateChallenge with isDebug=true when debug is enabled', async () => {
        // Arrange
        captchaVerdict();
        (config as any).debug = true;
        mocks.validateChallenge.mockResolvedValue(false);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=sometoken|someray');

        // Act
        await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(mocks.validateChallenge).toHaveBeenCalledWith(
            event.Records[0].cf.request,
            true // isDebug
        );
        consoleSpy.mockRestore();
    });

    it('logs the waived CAPTCHA when debug is enabled', async () => {
        // Arrange
        captchaVerdict();
        (config as any).debug = true;
        mocks.validateChallenge.mockResolvedValue(true);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        await handle(buildEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('valid challenge session, waiving CAPTCHA'));
        consoleSpy.mockRestore();
    });

    // --- Error handling ---

    it('passes through without header, logs to console.error and logger when validateChallenge throws', async () => {
        // Arrange
        expectError = true;
        const challenge = captchaVerdict();
        (config as any).validateChallenge = vi.fn().mockRejectedValue(new Error('validate crash'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(challenge).not.toHaveBeenCalled();
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']).toBeUndefined();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('req-123'), expect.objectContaining({ message: 'validate crash' }));
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('validate crash'));
        consoleSpy.mockRestore();
    });

    it('passes through, logs to console.error and logger when challenge throws', async () => {
        // Arrange
        expectError = true;
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        (config as any).challenge = vi.fn().mockRejectedValue(new Error('challenge crash'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('req-123'), expect.objectContaining({ message: 'challenge crash' }));
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('challenge crash'));
        consoleSpy.mockRestore();
    });

    it('passes through and logs error when RTI call throws', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).toHaveBeenCalled();
    });

    it('logs error to logger by default when logErrors is not set', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        await handle(buildEvent(), RequestType.ORIGIN_REQUEST);

        // Assert
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('RTI timeout'));
    });

    it('does not log error to logger but still logs to console.error when logErrors is false', async () => {
        // Arrange
        expectError = true;
        (config as any).logErrors = false;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('req-123'), expect.objectContaining({ message: 'RTI timeout' }));
    });

    it('does not log challenge error to logger when logErrors is false', async () => {
        // Arrange
        expectError = true;
        (config as any).logErrors = false;
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        (config as any).challenge = vi.fn().mockRejectedValue(new Error('challenge crash'));
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('req-123'), expect.objectContaining({ message: 'challenge crash' }));
    });

    it('uses "unknown_request_id" in error log when requestId is absent', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = buildEvent();
        (event.Records[0].cf.config as any).requestId = undefined;

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('unknown_request_id'));
    });

    it('returns "on_error_request_id" fallback when getCfRequestId throws accessing cf.config', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('RTI failure'));
        const event = buildEvent();
        Object.defineProperty(event.Records[0].cf, 'config', { get() { throw new Error('config access error'); } });

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('on_error_request_id'));
    });

    // --- Debug logging (cloudfront-specific branches) ---

    it('logs "Origin" event type when debug enabled for ORIGIN_REQUEST', async () => {
        // Arrange
        (config as any).debug = true;
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        await handle(buildEvent(), RequestType.ORIGIN_REQUEST);

        // Assert
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Origin'));
        consoleSpy.mockRestore();
    });

    it('logs "Viewer" event type when debug enabled for VIEWER_REQUEST', async () => {
        // Arrange
        (config as any).debug = true;
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        await handle(buildEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Viewer'));
        consoleSpy.mockRestore();
    });

    it('logs "Unknown" event type when debug enabled for unrecognized RequestType', async () => {
        // Arrange
        (config as any).debug = true;
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        await handle(buildEvent(), 99 as RequestType);

        // Assert
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown'));
        consoleSpy.mockRestore();
    });

    it('logs RTI payload, response and action details when debug enabled', async () => {
        // Arrange
        (config as any).debug = true;
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        await handle(buildEvent(), RequestType.ORIGIN_REQUEST);

        // Assert
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('RTI Request payload'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('RTI Response'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('action upon response'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('action strategy'));
        consoleSpy.mockRestore();
    });

    // --- Debug logs: cookie values, the session token and credentials are redacted (only what is logged) ---

    describe('debug log redaction', () => {
        const COOKIE = 'a=secret1; _cq_se=1730000000000.sigabcdef0123|ray-se; _cq_duid=duid-123';
        const secretHeaders = { 'X-Cheq-Challenge': 'hdr-token-xyz', Authorization: 'Bearer sekret-auth' };
        const SECRETS = ['secret1', '1730000000000.sigabcdef0123', 'sigabcdef0123', 'ray-se', 'hdr-token-xyz', 'sekret-auth'];

        const debugLogs = async (event: CloudFrontRequestEvent) => {
            (config as any).debug = true;
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            const result = await handle(event, RequestType.VIEWER_REQUEST);
            const lines = consoleSpy.mock.calls.map(call => call.join(' '));
            consoleSpy.mockRestore();
            const line = (prefix: string) => {
                const found = lines.find(l => l.startsWith(prefix));
                expect(found, `expected a "${prefix}" log line`).toBeDefined();
                return found!;
            };
            return { result, lines, eventLog: line('Original CF Event'), payloadLog: line('RTI Request payload') };
        };

        it('logs the event and the RTI payload without cookie values, the session token or authorization', async () => {
            // Act
            const { lines, eventLog, payloadLog } = await debugLogs(buildEvent('/page', 'example.com', '1.2.3.4', '', COOKIE, { extraHeaders: secretHeaders }));

            // Assert: no secret anywhere in the debug output
            for (const secret of SECRETS) {
                expect(lines.join('\n')).not.toContain(secret);
            }
            // the cookie names and the redaction marker are there, in both logs
            expect(eventLog).toContain('"value":"a, _cq_se, _cq_duid"');
            expect(eventLog).toContain('"x-cheq-challenge":[{"key":"X-Cheq-Challenge","value":"[REDACTED]"}]');
            expect(eventLog).toContain('"authorization":[{"key":"Authorization","value":"[REDACTED]"}]');
            expect(payloadLog).toContain('"cookie":"a, _cq_se, _cq_duid"');
            expect(payloadLog).toContain('"x-cheq-challenge":"[REDACTED]"');
            expect(payloadLog).toContain('"authorization":"[REDACTED]"');
            // other headers are logged as they are
            expect(eventLog).toContain('"value":"Mozilla/5.0"');
            expect(payloadLog).toContain('"user-agent":"Mozilla/5.0"');
        });

        it("keeps CHEQ's own ids (duidCookie) in the payload log: they are needed to debug RTI", async () => {
            // Act
            const { payloadLog } = await debugLogs(buildEvent('/page', 'example.com', '1.2.3.4', '', COOKIE));

            // Assert
            expect(payloadLog).toContain('"duidCookie":"duid-123"');
        });

        it('takes the names from each of several Cookie headers', async () => {
            // Arrange
            const event = buildEvent('/page', 'example.com', '1.2.3.4', '', 'a=secret1');
            event.Records[0].cf.request.headers['cookie'].push({ key: 'Cookie', value: 'b=secret2; c=secret3' });

            // Act
            const { lines, eventLog, payloadLog } = await debugLogs(event);

            // Assert: the event keeps one entry per header, each with its names
            expect(lines.join('\n')).not.toMatch(/secret[123]/);
            expect(eventLog).toContain('[{"key":"Cookie","value":"a"},{"key":"Cookie","value":"b, c"}]');
            // getHeaders joins the two Cookie headers with "; ", so the payload's cookie is "a=secret1; b=secret2; c=secret3"
            expect(payloadLog).toContain('"cookie":"a, b, c"');
        });

        it('changes only the log: the origin and RTI still get the original headers', async () => {
            // Arrange
            const event = buildEvent('/page', 'example.com', '1.2.3.4', '', COOKIE, { extraHeaders: secretHeaders });
            const before = JSON.stringify(event);

            // Act
            const { result } = await debugLogs(event);

            // Assert: the forwarded request (RTI allows it) is untouched, apart from the x-cheq-rti-result header that
            // handle always adds for the origin
            expect(result).toBe(event.Records[0].cf.request);
            const after = JSON.parse(JSON.stringify(event));
            delete after.Records[0].cf.request.headers['x-cheq-rti-result'];
            expect(after).toEqual(JSON.parse(before));
            const forwarded = result as CloudFrontRequest;
            expect(forwarded.headers['cookie'][0].value).toBe(COOKIE);
            expect(forwarded.headers['x-cheq-challenge'][0].value).toBe('hdr-token-xyz');
            expect(forwarded.headers['authorization'][0].value).toBe('Bearer sekret-auth');
            // and RTI received the real values
            const payload = mocks.callRTI.mock.calls[0][0];
            expect(payload.endUserParams.headers.cookie).toBe(COOKIE);
            expect(payload.endUserParams.headers['x-cheq-challenge']).toBe('hdr-token-xyz');
            expect(payload.endUserParams.headers.authorization).toBe('Bearer sekret-auth');
            expect(payload.duidCookie).toBe('duid-123');
        });

        it('redacts the origin custom headers of an origin-request event, and still forwards them', async () => {
            // Arrange
            const event = buildEvent('/page', 'example.com', '1.2.3.4', '', COOKIE);
            const customHeaders = { 'x-origin-verify': [{ key: 'X-Origin-Verify', value: 'origin-shared-secret' }] };
            (event.Records[0].cf.request as any).origin = { custom: { domainName: 'origin.example.com', customHeaders } };

            // Act
            const { result, lines, eventLog } = await debugLogs(event);

            // Assert
            expect(lines.join('\n')).not.toContain('origin-shared-secret');
            expect(eventLog).toContain('"customHeaders":{"x-origin-verify":[{"key":"X-Origin-Verify","value":"[REDACTED]"}]}');
            expect((result as any).origin.custom.customHeaders['x-origin-verify'][0].value).toBe('origin-shared-secret');
        });

        it('logs nothing of this when debug is off', async () => {
            // Arrange
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Act
            await handle(buildEvent('/page', 'example.com', '1.2.3.4', '', COOKIE), RequestType.VIEWER_REQUEST);

            // Assert
            expect(consoleSpy).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    it('logs "none (should not happen)" when debug enabled and action strategy is unrecognized', async () => {
        // Arrange
        (config as any).debug = true;
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(null);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        await handle(buildEvent(), RequestType.ORIGIN_REQUEST);

        // Assert
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('none (should not happen)'));
        consoleSpy.mockRestore();
    });

    it('logs raw action value when debug enabled and action has no named enum entry', async () => {
        // Arrange
        (config as any).debug = true;
        const unknownAction = 999 as Action;
        mocks.getAction.mockReturnValue(unknownAction);
        mocks.getActionStrategy.mockReturnValue(null);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        await handle(buildEvent(), RequestType.ORIGIN_REQUEST);

        // Assert
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('999'));
        consoleSpy.mockRestore();
    });

    // --- Cookie: _cq_se does not interfere ---

    it('does not extract _cq_se as duid or pvid', async () => {
        // Arrange
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=token|ray; _cq_duid=device-abc');

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBe('device-abc');
        expect(payload.pvidCookie).toBeUndefined();
    });

    it('does not confuse _cq_se with _cq_s', async () => {
        // Arrange
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=token|ray; _cq_s=scookie-value');

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.sCookie).toBe('scookie-value');
    });

    it('_cq_se cookie does not interfere with _cq_duid extraction when challenge fails', async () => {
        // Arrange
        mocks.validateChallenge.mockResolvedValue(false);
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=tok|ray; _cq_duid=device-abc; _cq_pvid=pv-xyz');

        // Act
        await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBe('device-abc');
        expect(payload.pvidCookie).toBe('pv-xyz');
    });

    // --- Multi-value cookie header joining ---

    it('joins multiple Cookie header entries before parsing', async () => {
        // Arrange
        const event = buildEvent();
        // CloudFront can send multiple Cookie header entries; the handler joins them with "; ".
        event.Records[0].cf.request.headers['cookie'] = [
            { key: 'Cookie', value: '_cq_duid=d-abc; _cq_pvid=pv-xyz; session=abc' },
            { key: 'Cookie', value: 'theme=dark; other=value' },
        ];

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBe('d-abc');
        expect(payload.pvidCookie).toBe('pv-xyz');
    });

    it('reads CHEQ cookies from a later Cookie header entry (entries are joined with "; ", not ", ")', async () => {
        // Arrange
        const event = buildEvent();
        event.Records[0].cf.request.headers['cookie'] = [
            { key: 'Cookie', value: 'theme=dark' },
            { key: 'Cookie', value: '_cq_duid=d-abc; _cq_s=s-1' },
            { key: 'Cookie', value: '_cq_pvid=pv-xyz' },
        ];

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBe('d-abc');
        expect(payload.sCookie).toBe('s-1');
        expect(payload.pvidCookie).toBe('pv-xyz');
    });

    // --- A client-sent x-cheq-rti-result never reaches the origin ---

    const spoofed = { 'x-cheq-rti-result': 'version=4.1;verdict=benign;threat-type-code=0;ids={}' };

    it('removes a client-sent x-cheq-rti-result on an ignored path', async () => {
        // Arrange
        mocks.shouldIgnore.mockReturnValue(true);
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '', { extraHeaders: spoofed });

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST) as any;

        // Assert
        expect(result.headers['x-cheq-rti-result']).toBeUndefined();
    });

    it('removes a client-sent x-cheq-rti-result when RTI fails (fail open)', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('rti down'));
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '', { extraHeaders: spoofed });

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST) as any;

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(result.headers['x-cheq-rti-result']).toBeUndefined();
    });

    it('does not send a client-sent x-cheq-rti-result to RTI either', async () => {
        // Arrange
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '', { extraHeaders: spoofed });

        // Act
        await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(mocks.callRTI.mock.calls[0][0].endUserParams.headers).not.toHaveProperty('x-cheq-rti-result');
    });

    it('replaces a client-sent x-cheq-rti-result with the real verdict on ALLOW', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious' }));
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '', { extraHeaders: spoofed });

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST) as any;

        // Assert
        expect(result.headers['x-cheq-rti-result']).toHaveLength(1);
        expect(result.headers['x-cheq-rti-result'][0].value).toContain('verdict=suspicious');
    });

    // --- Service wiring (module load) ---

    it('creates RTIHttpsService once with the module config and no overrides', () => {
        expect(rtiServiceCtorCalls).toEqual([[config]]);
    });

    it('creates RTIHttpsLoggerService once as "<name>-<version>" with the module config and default timeouts', () => {
        expect(loggerCtorCalls).toEqual([['test-1.0.0', config]]);
    });

    // --- Logger calls are awaited (Lambda can freeze right after the handler returns) ---

    const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        return { promise, resolve };
    };
    const isSettled = async (p: Promise<unknown>) => {
        let settled = false;
        p.then(() => (settled = true), () => (settled = true));
        await new Promise((r) => setTimeout(r, 0));
        return settled;
    };

    it('waits for the telemetry log before returning', async () => {
        // Arrange
        (config as any).telemetry = true;
        const log = deferred();
        mocks.loggerInfo.mockReturnValueOnce(log.promise);

        // Act
        const result = handle(buildEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(await isSettled(result)).toBe(false);
        log.resolve();
        expect(await isSettled(result)).toBe(true);
    });

    it('waits for the error log before returning when RTI fails', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('rti down'));
        const log = deferred();
        mocks.loggerError.mockReturnValueOnce(log.promise);

        // Act
        const result = handle(buildEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(await isSettled(result)).toBe(false);
        log.resolve();
        expect(await isSettled(result)).toBe(true);
    });

    it('waits for the error log before returning when the challenge fails', async () => {
        // Arrange
        expectError = true;
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        (config as any).challenge = vi.fn().mockRejectedValue(new Error('challenge crash'));
        const log = deferred();
        mocks.loggerError.mockReturnValueOnce(log.promise);

        // Act
        const result = handle(buildEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(await isSettled(result)).toBe(false);
        log.resolve();
        expect(await isSettled(result)).toBe(true);
    });

    it('telemetry reports the measured RTI duration', async () => {
        // Arrange
        (config as any).telemetry = true;
        vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1250);

        // Act
        await handle(buildEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(mocks.loggerInfo).toHaveBeenCalledWith('rti_duration: 250');
    });

    // --- RTI payload details ---

    it('sends channel "cloudfront-cdn-integration" and the CloudFront request id as customId2', async () => {
        // Act
        await handle(buildEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.channel).toBe('cloudfront-cdn-integration');
        expect(payload.customId2).toBe('req-123');
    });

    it('asks getEventType with the pathname and method and sends the result as customId1', async () => {
        // Arrange
        mocks.getEventType.mockReturnValueOnce('purchase');

        // Act
        await handle(buildEvent('/checkout', 'example.com', '1.2.3.4', 'step=2', '', { method: 'POST' }), RequestType.VIEWER_REQUEST);

        // Assert
        expect(mocks.getEventType).toHaveBeenCalledWith('/checkout', 'POST');
        expect(mocks.callRTI.mock.calls[0][0].customId1).toBe('purchase');
    });

    it('lists the defined header names in headerNames', async () => {
        // Act
        await handle(buildEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(mocks.callRTI.mock.calls[0][0].endUserParams.headerNames).toBe('host,user-agent');
    });

    it('joins a multi-valued header with ", "', async () => {
        // Arrange
        const event = buildEvent();
        event.Records[0].cf.request.headers['accept-language'] = [
            { key: 'Accept-Language', value: 'en' },
            { key: 'Accept-Language', value: 'fr' },
        ];

        // Act
        await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(mocks.callRTI.mock.calls[0][0].endUserParams.headers['accept-language']).toBe('en, fr');
    });

    it('sends RTI several Cookie headers joined with "; ", so every cookie stays a cookie', async () => {
        // Arrange: cookies split over two Cookie headers (allowed over HTTP/2)
        const event = buildEvent();
        event.Records[0].cf.request.headers['cookie'] = [
            { key: 'Cookie', value: 'a=1; b=2' },
            { key: 'Cookie', value: 'c=3' },
        ];

        // Act
        await handle(event, RequestType.VIEWER_REQUEST);

        // Assert: not "a=1; b=2, c=3", where b's value would be "2, c=3" and cookie c would be gone
        const cookie = mocks.callRTI.mock.calls[0][0].endUserParams.headers.cookie;
        expect(cookie).toBe('a=1; b=2; c=3');
        expect(cookie.split('; ').map((c: string) => c.split('=')[0])).toEqual(['a', 'b', 'c']);
    });

    it('joins Cookie with "; " also when keepHeadersNames lists it, and leaves other repeated headers with ", "', async () => {
        // Arrange
        (config as any).keepHeadersNames = ['cookie', 'accept'];
        const event = buildEvent();
        event.Records[0].cf.request.headers['cookie'] = [{ key: 'Cookie', value: 'a=1' }, { key: 'Cookie', value: 'b=2' }];
        event.Records[0].cf.request.headers['accept'] = [{ key: 'Accept', value: 'text/html' }, { key: 'Accept', value: '*/*' }];

        // Act
        await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        const headers = mocks.callRTI.mock.calls[0][0].endUserParams.headers;
        expect(headers.cookie).toBe('a=1; b=2');
        expect(headers.accept).toBe('text/html, */*');
    });

    it('keeps a single Cookie header exactly as sent', async () => {
        // Arrange
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', 'a=1, x; b=2');

        // Act
        await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(mocks.callRTI.mock.calls[0][0].endUserParams.headers.cookie).toBe('a=1, x; b=2');
    });

    it('checks ignorePaths against the pathname, without the query string', async () => {
        // Arrange
        mocks.shouldIgnore.mockReturnValue(true);

        // Act
        await handle(buildEvent('/app.css', 'example.com', '1.2.3.4', 'v=1'), RequestType.VIEWER_REQUEST);

        // Assert
        expect(mocks.shouldIgnore).toHaveBeenCalledWith('/app.css');
        expect(mocks.callRTI).not.toHaveBeenCalled();
    });

    it.each([
        [ActionStrategy.ACCESS_DENIED, '403', 'Access Denied'],
        [ActionStrategy.NOT_FOUND, '404', 'Not Found'],
    ])('passes the CloudFront request id to the block page (strategy %s)', async (strategy, status, title) => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(strategy);

        // Act
        await handle(buildEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(mocks.generateDefaultBlockPage).toHaveBeenCalledWith(status, title, expect.objectContaining({ rayId: 'ray-123' }), 'req-123');
    });

    // --- Challenge reply: the solved form always goes to config.challenge (BLOCKING only), blocks still win ---

    const replyQuery = new URLSearchParams({ original_url: '/landing?gclid=abc', request_id: 'ray-page', 'cf-turnstile-response': 'tok' }).toString();
    const replyEvent = (cookies = '') => buildEvent('/landing', 'example.com', '1.2.3.4', replyQuery, cookies);
    const replyChallenge = () => {
        (config as any).mode = Mode.BLOCKING;
        const challenge = vi.fn().mockResolvedValue({ status: '302', headers: {} });
        (config as any).challenge = challenge;
        return challenge;
    };

    // --- config.isChallengeResponse: recognizes a reply; customer code, so it may be missing, wrong or throw ---

    it('recognizes a reply with config.isChallengeResponse, called with the request', async () => {
        // Arrange: a CAPTCHA with its own token field
        const challenge = replyChallenge();
        const detector = vi.fn((request: any) => new URLSearchParams(request.querystring).has('my-captcha-token'));
        (config as any).isChallengeResponse = detector;
        const event = buildEvent('/landing', 'example.com', '1.2.3.4', 'my-captcha-token=abc');

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toEqual({ status: '302', headers: {} });
        expect(detector).toHaveBeenCalledWith(event.Records[0].cf.request);
        expect(challenge).toHaveBeenCalledOnce();
    });

    it('does not treat a Turnstile-shaped query as a reply when the configured detector says no', async () => {
        // Arrange
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = vi.fn().mockReturnValue(false);
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(challenge).not.toHaveBeenCalled();
    });

    it('forwards a reply unchanged when config.isChallengeResponse is not set', async () => {
        // Arrange
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = undefined;
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.querystring).toBe(replyQuery);
        expect(challenge).not.toHaveBeenCalled();
    });

    it.each([
        ['false', () => false],
        ['undefined', () => undefined],
        ['a truthy string', () => 'yes'],
        ['1', () => 1],
        ['a Promise of true (an async detector)', () => Promise.resolve(true)],
    ])('treats a request as a reply only when config.isChallengeResponse returns true, not %s', async (_, value) => {
        // Arrange
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = vi.fn().mockImplementation(value);
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']?.[0].value).toContain('verdict=benign');
        expect(challenge).not.toHaveBeenCalled();
    });

    it.each([
        ['an Error', () => new Error('detector failed'), 'detector failed'],
        ['undefined', () => undefined, 'undefined'],
    ])('treats the request as no reply and logs it when config.isChallengeResponse throws %s', async (_, value, logged) => {
        // Arrange
        expectError = true;
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = vi.fn().mockImplementation(() => { throw value(); });
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert: forwarded as RTI decided (ALLOW, with the verdict header), challenge not called
        expect(result).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']?.[0].value).toContain('verdict=benign');
        expect(challenge).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Challenge reply check error handling request 'req-123'"), value());
        expect(mocks.loggerError).toHaveBeenCalledWith(`Challenge reply check error handling request 'req-123': ${logged}`);
    });

    it('still challenges a CAPTCHA request when config.isChallengeResponse throws', async () => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        const challenge = captchaVerdict();
        (config as any).isChallengeResponse = vi.fn().mockImplementation(() => { throw new Error('detector failed'); });

        // Act
        const result = await handle(buildEvent(), RequestType.VIEWER_REQUEST);

        // Assert: the usual CAPTCHA path, as if it were no reply
        expect(result).toEqual({ status: '403', body: '<html>captcha</html>' });
        expect(challenge).toHaveBeenCalledOnce();
    });

    it('forwards a reply when RTI fails and config.isChallengeResponse throws too', async () => {
        // Arrange
        expectError = true;
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = vi.fn().mockImplementation(() => { throw undefined; });
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(challenge).not.toHaveBeenCalled();
        expect(mocks.loggerError).toHaveBeenCalledWith("Challenge reply check error handling request 'req-123': undefined");
    });

    it('does not call config.isChallengeResponse for a request that is blocked anyway', async () => {
        // Arrange
        replyChallenge();
        const detector = vi.fn().mockReturnValue(true);
        (config as any).isChallengeResponse = detector;
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);

        // Act
        const result = await handle(replyEvent(), RequestType.VIEWER_REQUEST) as any;

        // Assert
        expect(result.status).toBe('403');
        expect(detector).not.toHaveBeenCalled();
    });

    it.each([
        ['in MONITORING mode', Mode.MONITORING, true],
        ['without config.challenge', Mode.BLOCKING, false],
    ])('does not call config.isChallengeResponse %s', async (_, mode, withChallenge) => {
        // Arrange
        (config as any).mode = mode;
        (config as any).challenge = withChallenge ? vi.fn() : undefined;
        const detector = vi.fn().mockReturnValue(true);
        (config as any).isChallengeResponse = detector;

        // Act
        await handle(replyEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(detector).not.toHaveBeenCalled();
    });

    it('sends a reply that RTI allows to config.challenge instead of forwarding it', async () => {
        // Arrange
        const challenge = replyChallenge();
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toEqual({ status: '302', headers: {} });
        expect(challenge).toHaveBeenCalledWith(
            event.Records[0].cf.request,
            expect.objectContaining({ decision: expect.objectContaining({ verdict: 'benign' }) }),
            expect.any(Function), // addRtiResultHeader
        );
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']).toBeUndefined();
    });

    it('passes an addRtiResultHeader that sets the verdict of the reply', async () => {
        // Arrange
        const challenge = replyChallenge();

        // Act
        await handle(replyEvent(), RequestType.VIEWER_REQUEST);
        const headers: Record<string, any> = {};
        challenge.mock.calls[0][2](headers);

        // Assert
        expect(headers['x-cheq-rti-result'][0].value).toContain('verdict=benign');
    });

    it('sends a CAPTCHA reply to config.challenge even with a valid session (checked before the session waiver)', async () => {
        // Arrange
        (config as any).mode = Mode.BLOCKING;
        const challenge = captchaVerdict();
        mocks.validateChallenge.mockResolvedValue(true);

        // Act
        const result = await handle(replyEvent('_cq_se=tok|ray'), RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toEqual({ status: '403', body: '<html>captcha</html>' });
        expect(challenge).toHaveBeenCalledOnce();
        expect(mocks.validateChallenge).not.toHaveBeenCalled();
    });

    it.each([
        [Action.BLOCK, ActionStrategy.ACCESS_DENIED, '403'],
        [Action.BLOCK, ActionStrategy.NOT_FOUND, '404'],
        [Action.REDIRECT, ActionStrategy.REDIRECT, '302'],
        [Action.CHALLENGE, ActionStrategy.ACCESS_DENIED, '403'],
    ])('still blocks a reply for action %s / strategy %s (returns %s)', async (action, strategy, status) => {
        // Arrange
        const challenge = replyChallenge();
        mocks.getAction.mockReturnValue(action);
        mocks.getActionStrategy.mockReturnValue(strategy);

        // Act
        const result = await handle(replyEvent(), RequestType.VIEWER_REQUEST) as any;

        // Assert
        expect(result.status).toBe(status);
        expect(challenge).not.toHaveBeenCalled();
    });

    it('forwards a reply unchanged in MONITORING mode', async () => {
        // Arrange
        const challenge = replyChallenge();
        (config as any).mode = Mode.MONITORING;
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.querystring).toBe(replyQuery);
        expect(challenge).not.toHaveBeenCalled();
    });

    it('forwards a request that is not a reply unchanged when RTI allows it', async () => {
        // Arrange
        const challenge = replyChallenge();
        const event = buildEvent('/landing', 'example.com', '1.2.3.4', 'gclid=abc');

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.querystring).toBe('gclid=abc');
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']?.[0].value).toContain('verdict=benign');
        expect(challenge).not.toHaveBeenCalled();
    });

    it('forwards a reply when no challenge is configured', async () => {
        // Arrange
        (config as any).mode = Mode.BLOCKING;
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
    });

    it('forwards a reply when RTI throws and no challenge is configured', async () => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.querystring).toBe(replyQuery);
    });

    it('sends a reply to config.challenge with the stand-in response when the RTI response is malformed (any error before the decision)', async () => {
        // Arrange: RTI answers, but the answer cannot be evaluated
        expectError = true;
        const challenge = replyChallenge();
        mocks.getAction.mockImplementation(() => { throw new TypeError("Cannot read properties of undefined (reading 'verdict')"); });

        // Act
        const result = await handle(replyEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toEqual({ status: '302', headers: {} });
        const [, response, addRtiResultHeader] = challenge.mock.calls[0];
        expect(response.ids.rayId).toBe('req-123');
        expect(response.decision).toBeUndefined();
        expect(addRtiResultHeader).toBeUndefined();
    });

    it('forwards a reply when RTI throws and config.isChallengeResponse is not set', async () => {
        // Arrange
        expectError = true;
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = undefined;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(challenge).not.toHaveBeenCalled();
    });

    it('forwards a reply on an ignored path unchanged, without RTI or config.isChallengeResponse', async () => {
        // Arrange: the README tells sites to exclude their own Turnstile forms this way
        const challenge = replyChallenge();
        const detector = vi.fn().mockReturnValue(true);
        (config as any).isChallengeResponse = detector;
        mocks.shouldIgnore.mockReturnValue(true);
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.querystring).toBe(replyQuery);
        expect(mocks.callRTI).not.toHaveBeenCalled();
        expect(detector).not.toHaveBeenCalled();
        expect(challenge).not.toHaveBeenCalled();
    });

    it('sends a reply to config.challenge when the action has no strategy ("should not happen"), like ALLOW', async () => {
        // Arrange: a non-ALLOW action that getActionStrategy does not map
        const challenge = replyChallenge();
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(null);

        // Act
        const result = await handle(replyEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toEqual({ status: '302', headers: {} });
        expect(challenge).toHaveBeenCalledOnce();
    });

    it('logs a throwing config.isChallengeResponse only to the console when logErrors is false', async () => {
        // Arrange
        expectError = true;
        replyChallenge();
        (config as any).logErrors = false;
        (config as any).isChallengeResponse = vi.fn().mockImplementation(() => { throw new Error('detector failed'); });
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Challenge reply check error'), expect.objectContaining({ message: 'detector failed' }));
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('logs in debug mode that a reply goes to config.challenge', async () => {
        // Arrange
        replyChallenge();
        (config as any).debug = true;
        const logs: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(String(args[0])); });

        // Act
        await handle(replyEvent(), RequestType.VIEWER_REQUEST);

        // Assert
        expect(logs).toContain('challenge reply, passing it to challenge');
    });

    // --- A thrown value that is not an Error must not break the fail-open (logging used to read .message on it) ---

    const nonErrors: [string, () => unknown, string][] = [
        ['undefined', () => undefined, 'undefined'],
        ['null', () => null, 'null'],
        ['a string', () => 'boom', 'boom'],
        ['a null-prototype object', () => Object.create(null), '[object Object]'],
        ['an object whose toString throws', () => ({ toString() { throw new Error('toString failed'); } }), '[object Object]'],
        ['an Error whose message is a Symbol', () => Object.assign(new Error(), { message: Symbol('s') }), 'Symbol(s)'],
    ];

    it('forwards a reply when config.challenge throws synchronously (not a rejected promise)', async () => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        (config as any).challenge = vi.fn().mockImplementation(() => { throw new Error('sync throw'); });
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).toHaveBeenCalledWith(`Challenge error handling request 'req-123': sync throw`);
    });

    it.each(nonErrors)('forwards a reply when config.challenge rejects with %s, calling it once', async (_, value, logged) => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        const challenge = vi.fn().mockImplementation(() => Promise.reject(value()));
        (config as any).challenge = challenge;
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(challenge).toHaveBeenCalledOnce();
        expect(mocks.loggerError).toHaveBeenCalledWith(`Challenge error handling request 'req-123': ${logged}`);
    });

    it.each(nonErrors)('forwards a CAPTCHA request when config.challenge rejects with %s', async (_, value, logged) => {
        // Arrange
        expectError = true;
        captchaVerdict().mockImplementation(() => Promise.reject(value()));
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).toHaveBeenCalledWith(`Challenge error handling request 'req-123': ${logged}`);
    });

    it.each(nonErrors)('forwards the request when RTI rejects with %s', async (_, value, logged) => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockImplementation(() => Promise.reject(value()));
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).toHaveBeenCalledWith(`Error handling request 'req-123': ${logged}`);
    });

    it('forwards a reply when RTI and config.challenge both reject with undefined', async () => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        const challenge = vi.fn().mockImplementation(() => Promise.reject(undefined));
        (config as any).challenge = challenge;
        mocks.callRTI.mockImplementation(() => Promise.reject(undefined));
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(challenge).toHaveBeenCalledOnce();
    });

    it('forwards a reply and logs the error when config.challenge throws (fail open)', async () => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        (config as any).challenge = vi.fn().mockRejectedValue(new Error('siteverify unreachable'));
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('req-123'), expect.objectContaining({ message: 'siteverify unreachable' }));
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('siteverify unreachable'));
    });

    it('still sends a reply to config.challenge when RTI throws, with a stand-in response (CloudFront request id only) and no addRtiResultHeader', async () => {
        // Arrange
        expectError = true;
        const challenge = replyChallenge();
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toEqual({ status: '302', headers: {} });
        expect(challenge).toHaveBeenCalledOnce();
        const [request, response, addRtiResultHeader] = challenge.mock.calls[0];
        expect(request).toBe(event.Records[0].cf.request);
        // Not an RTI answer: only the CloudFront request id, as rayId (it signs the example's session) and as customParam2
        // (as customId2 in the normal RTI payload). No verdict, classification or other ids.
        expect(response).toEqual({
            ids: {
                rayId: 'req-123', customParam2: 'req-123',
                pageViewId: null, duid: null, uniqueVisitId: null, customParam1: null, customParam3: null, customParam4: null,
            },
        });
        expect(addRtiResultHeader).toBeUndefined();
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('RTI timeout'));
    });

    // --- The stand-in rayId must be a plain, unique id (the example signs it and puts it in a cookie) ---

    // Sends a reply while RTI is down, with the given CloudFront request id (undefined: none in the event).
    const replyWithRtiDown = async (requestId: string | undefined) => {
        expectError = true;
        const challenge = replyChallenge();
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = replyEvent();
        if (requestId === undefined) {
            delete (event.Records[0].cf.config as any).requestId;
        } else {
            (event.Records[0].cf.config as any).requestId = requestId;
        }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await handle(event, RequestType.VIEWER_REQUEST);
        return { response: challenge.mock.calls[0][1], warn };
    };

    it('uses a plain CloudFront request id as the stand-in rayId, without a warning', async () => {
        // Act
        const { response, warn } = await replyWithRtiDown('4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==');

        // Assert
        expect(response.ids.rayId).toBe('4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==');
        expect(warn).not.toHaveBeenCalled();
        expect(mocks.loggerError).not.toHaveBeenCalledWith(expect.stringContaining('not usable as rayId'));
    });

    it.each([
        ['cookie separators', 'abc; Domain=evil|x', 'abc; Domain=evil|x'],
        ['spaces and parentheses (the on_error_request_id fallback)', 'on_error_request_id (boom)', 'on_error_request_id (boom)'],
        ['an empty id', '', ''],
        ['no id in the event (the constant unknown_request_id, not unique)', undefined, 'unknown_request_id'],
        ['more than 200 characters', 'a'.repeat(201), 'a'.repeat(201)],
    ])('replaces a CloudFront request id with %s by a random stand-in rayId, logged to the console and the RTI logger', async (_, requestId, cfRequestId) => {
        // Act
        const { response, warn } = await replyWithRtiDown(requestId);

        // Assert: a random plain id, while customParam2 keeps the real one for correlation
        expect(response.ids.rayId).toMatch(/^cf-fallback-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(response.ids.customParam2).toBe(cfRequestId);
        const message = `RTI failed and the CloudFront request id ${JSON.stringify(cfRequestId)} is not usable as the stand-in rayId, using ${response.ids.rayId}`;
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(`[challenge] ${message}`);
        expect(mocks.loggerError).toHaveBeenCalledWith(message);
    });

    it('uses a new random stand-in rayId for every request', async () => {
        // Act
        const first = await replyWithRtiDown('bad id');
        const second = await replyWithRtiDown('bad id');

        // Assert
        expect(first.response.ids.rayId).not.toBe(second.response.ids.rayId);
    });

    it('logs a replaced stand-in rayId only to the console when logErrors is false', async () => {
        // Arrange
        (config as any).logErrors = false;

        // Act
        const { warn } = await replyWithRtiDown('bad id');

        // Assert
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('not usable as the stand-in rayId'));
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('forwards a reply when RTI throws and config.challenge throws too', async () => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        (config as any).challenge = vi.fn().mockRejectedValue(new Error('siteverify unreachable'));
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('siteverify unreachable'));
    });

    it.each([
        ['MONITORING mode', Mode.MONITORING, 'tok'],
        ['a request that is not a reply', Mode.BLOCKING, ''],
    ])('does not call config.challenge when RTI throws for %s', async (_, mode, token) => {
        // Arrange
        expectError = true;
        const challenge = replyChallenge();
        (config as any).mode = mode;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = buildEvent('/landing', 'example.com', '1.2.3.4', token ? replyQuery : 'gclid=abc');

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(challenge).not.toHaveBeenCalled();
    });

    // --- End to end with the real Turnstile example (only RTI, logger and siteverify are stubbed) ---

    it('Turnstile end to end: challenge page, solved 302 with cookie and header, then the cookie waives the CAPTCHA', async () => {
        // Arrange
        const turnstile = createTurnstileChallenge({
            siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'e2e-signing-secret', sessionTtlSeconds: 300,
        });
        (config as any).challenge = turnstile.challenge;
        (config as any).validateChallenge = turnstile.validateChallenge;
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious', rayId: 'ray-e2e' }));
        const siteverify = vi.fn().mockResolvedValue({ json: async () => ({ success: true, hostname: 'example.com', action: 'cheq-challenge' }) });
        vi.stubGlobal('fetch', siteverify);

        // Act 1: no token yet → challenge page
        const page = await handle(buildEvent(), RequestType.VIEWER_REQUEST) as any;

        // Assert 1
        expect(page.status).toBe('403');
        expect(page.body).toContain('data-sitekey="site-key"');
        expect(siteverify).not.toHaveBeenCalled();

        // Act 2: the form comes back with the Turnstile token → 302 with session cookie and verdict header
        const solved = await handle(buildEvent('/page', 'example.com', '1.2.3.4', 'cf-turnstile-response=tok'), RequestType.VIEWER_REQUEST) as any;

        // Assert 2
        expect(solved.status).toBe('302');
        expect(siteverify).toHaveBeenCalledOnce();
        expect(solved.headers['x-cheq-rti-result'][0].value).toContain('verdict=suspicious');
        const cookie = solved.headers['set-cookie'][0].value.split(';')[0];
        expect(cookie).toMatch(/^_cq_se=\d+\.[0-9a-f]{32}\|ray-e2e$/);

        // Act 3: the next suspicious request carries the cookie → forwarded with the real verdict
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', cookie);
        const forwarded = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert 3
        expect(forwarded).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']?.[0].value).toContain('verdict=suspicious');
        expect(siteverify).toHaveBeenCalledOnce();
        expect(mocks.callRTI).toHaveBeenCalledTimes(3);
    });

    describe('Turnstile end to end: the session is bound to the client that solved the challenge', () => {
        const CLIENT_A = { ip: '1.2.3.4', ua: 'Mozilla/5.0 (client A)' };
        const requestFrom = (client: { ip: string; ua: string }, querystring = '', cookie = '') =>
            buildEvent('/page', 'example.com', client.ip, querystring, cookie, { extraHeaders: { 'User-Agent': client.ua } });

        const solveAsClientA = async () => {
            const turnstile = createTurnstileChallenge({
                siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'e2e-signing-secret', sessionTtlSeconds: 300,
            });
            (config as any).challenge = turnstile.challenge;
            (config as any).validateChallenge = turnstile.validateChallenge;
            mocks.getAction.mockReturnValue(Action.CHALLENGE);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious', rayId: 'ray-bind' }));
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ success: true, hostname: 'example.com', action: 'cheq-challenge' }) }));
            const solved = await handle(requestFrom(CLIENT_A, 'cf-turnstile-response=tok'), RequestType.VIEWER_REQUEST) as any;
            expect(solved.status).toBe('302');
            return solved.headers['set-cookie'][0].value.split(';')[0] as string;
        };

        it('waives the CAPTCHA for client A itself', async () => {
            const cookie = await solveAsClientA();
            const event = requestFrom(CLIENT_A, '', cookie);
            expect(await handle(event, RequestType.VIEWER_REQUEST)).toBe(event.Records[0].cf.request);
        });

        it('binds a session issued while RTI is down (stand-in rayId) the same way', async () => {
            // Arrange: the reply is solved while RTI fails, from 1.2.3.4 with buildEvent's User-Agent
            expectError = true;
            realTurnstile({ json: async () => ({ success: true, hostname: 'example.com', action: 'cheq-challenge' }) });
            mocks.callRTI.mockRejectedValueOnce(new Error('RTI timeout'));
            const solved = await handle(replyEvent(), RequestType.VIEWER_REQUEST) as any;
            expect(solved.headers['set-cookie'][0].value).toMatch(/^_cq_se=\d+\.[0-9a-f]{32}\|req-123;/);
            const cookie: string = solved.headers['set-cookie'][0].value.split(';')[0];

            // RTI is back and asks for a CAPTCHA
            mocks.getAction.mockReturnValue(Action.CHALLENGE);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious', rayId: 'ray-next' }));

            // Act & Assert: the same client is waived, another network gets the CAPTCHA
            const same = buildEvent('/landing', 'example.com', '1.2.3.4', '', cookie);
            expect(await handle(same, RequestType.VIEWER_REQUEST)).toBe(same.Records[0].cf.request);
            const other = await handle(buildEvent('/landing', 'example.com', '5.6.7.8', '', cookie), RequestType.VIEWER_REQUEST) as any;
            expect(other.status).toBe('403');
        });

        it('on origin-request without the viewer\'s User-Agent: still bound by IP, and warns once', async () => {
            // Arrange: CloudFront sent its own User-Agent on both requests
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const viaOrigin = (ip: string, querystring = '', cookie = '') =>
                buildEvent('/page', 'example.com', ip, querystring, cookie, { extraHeaders: { 'User-Agent': 'Amazon CloudFront' } });
            const turnstile = createTurnstileChallenge({
                siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'e2e-signing-secret', sessionTtlSeconds: 300,
            });
            (config as any).challenge = turnstile.challenge;
            (config as any).validateChallenge = turnstile.validateChallenge;
            mocks.getAction.mockReturnValue(Action.CHALLENGE);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious', rayId: 'ray-origin' }));
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ success: true, hostname: 'example.com', action: 'cheq-challenge' }) }));
            const solved = await handle(viaOrigin('1.2.3.4', 'cf-turnstile-response=tok'), RequestType.ORIGIN_REQUEST) as any;
            const cookie: string = solved.headers['set-cookie'][0].value.split(';')[0];

            // Act
            const same = viaOrigin('1.2.3.4', '', cookie);
            const sameResult = await handle(same, RequestType.ORIGIN_REQUEST);
            const otherResult = await handle(viaOrigin('5.6.7.8', '', cookie), RequestType.ORIGIN_REQUEST) as any;

            // Assert
            expect(sameResult).toBe(same.Records[0].cf.request);
            expect(otherResult.status).toBe('403');
            const userAgentWarnings = warn.mock.calls.filter(call => String(call[0]).includes("User-Agent is 'Amazon CloudFront'"));
            expect(userAgentWarnings).toHaveLength(1);
        });

        it.each([
            ['another browser on the same address', { ip: '1.2.3.4', ua: 'Mozilla/5.0 (client B)' }],
            ['the same browser string from another network', { ip: '5.6.7.8', ua: CLIENT_A.ua }],
            ['another client altogether', { ip: '5.6.7.8', ua: 'curl/8.0' }],
        ])('shows the CAPTCHA again to %s with client A\'s cookie', async (_, client) => {
            const cookie = await solveAsClientA();
            const result = await handle(requestFrom(client, '', cookie), RequestType.VIEWER_REQUEST) as any;
            expect(result.status).toBe('403');
            expect(result.body).toContain('data-sitekey="site-key"');
        });
    });

    describe.each([
        { ip: 'exact', userAgent: true },
        { ip: 'exact', userAgent: false },
        { ip: 'none', userAgent: true },
        { ip: 'none', userAgent: false },
    ] as const)('Turnstile end to end with sessionBinding %j', (sessionBinding) => {
        const CLIENT_A = { ip: '1.2.3.4', ua: 'Mozilla/5.0 (client A)' };
        const requestFrom = (client: { ip: string; ua: string }, querystring = '', cookie = '') =>
            buildEvent('/page', 'example.com', client.ip, querystring, cookie, { extraHeaders: { 'User-Agent': client.ua } });

        it.each([
            ['client A itself', CLIENT_A, true],
            ['client A, another network', { ip: '5.6.7.8', ua: CLIENT_A.ua }, sessionBinding.ip === 'none'],
            ['client A, now over IPv6', { ip: '2001:db8::4', ua: CLIENT_A.ua }, sessionBinding.ip === 'none'],
            ['another browser, same address', { ip: '1.2.3.4', ua: 'Mozilla/5.0 (client B)' }, !sessionBinding.userAgent],
            ['another client altogether', { ip: '5.6.7.8', ua: 'curl/8.0' }, sessionBinding.ip === 'none' && !sessionBinding.userAgent],
        ])('client A solves the challenge; %s with its cookie is %s', async (_, client, waived) => {
            // Arrange: client A solves the challenge
            const turnstile = createTurnstileChallenge({
                siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'e2e-signing-secret', sessionTtlSeconds: 300,
                sessionBinding: { ...sessionBinding },
            });
            (config as any).challenge = turnstile.challenge;
            (config as any).validateChallenge = turnstile.validateChallenge;
            mocks.getAction.mockReturnValue(Action.CHALLENGE);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious', rayId: 'ray-bind' }));
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ success: true, hostname: 'example.com', action: 'cheq-challenge' }) }));
            const solved = await handle(requestFrom(CLIENT_A, 'cf-turnstile-response=tok'), RequestType.VIEWER_REQUEST) as any;
            const cookie: string = solved.headers['set-cookie'][0].value.split(';')[0];

            // Act: the next challenged request carries client A's cookie
            const event = requestFrom(client, '', cookie);
            const result = await handle(event, RequestType.VIEWER_REQUEST) as any;

            // Assert: forwarded (CAPTCHA waived) or the challenge page again, never a block
            if (waived) {
                expect(result).toBe(event.Records[0].cf.request);
                expect(event.Records[0].cf.request.headers['x-cheq-rti-result']?.[0].value).toContain('verdict=suspicious');
            } else {
                expect(result.status).toBe('403');
                expect(result.body).toContain('data-sitekey="site-key"');
            }
        });
    });

    it('Turnstile end to end: RTI allows the reply, which still gets the session and goes back to the original query string', async () => {
        // Arrange
        const turnstile = createTurnstileChallenge({
            siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'e2e-signing-secret', sessionTtlSeconds: 300,
        });
        (config as any).challenge = turnstile.challenge;
        (config as any).validateChallenge = turnstile.validateChallenge;
        (config as any).mode = Mode.BLOCKING;
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious', rayId: 'ray-page' }));
        const siteverify = vi.fn().mockResolvedValue({ json: async () => ({ success: true, hostname: 'example.com', action: 'cheq-challenge' }) });
        vi.stubGlobal('fetch', siteverify);

        // Act 1: challenge page for a URL with a query string
        const page = await handle(buildEvent('/landing', 'example.com', '1.2.3.4', 'gclid=abc'), RequestType.VIEWER_REQUEST) as any;
        const originalUrl = page.body.match(/name="original_url" value="([^"]*)"/)[1].replace(/&amp;/g, '&');

        // Act 2: the solved form comes back, but RTI now allows it
        mocks.getAction.mockReturnValue(Action.ALLOW);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'benign', rayId: 'ray-reply' }));
        const replyQuery = new URLSearchParams({ original_url: originalUrl, request_id: 'ray-page', 'cf-turnstile-response': 'tok' }).toString();
        const solved = await handle(buildEvent('/landing', 'example.com', '1.2.3.4', replyQuery), RequestType.VIEWER_REQUEST) as any;

        // Assert 2: verified, same 302 and session as a challenged reply, not forwarded to the origin
        expect(solved.status).toBe('302');
        expect(solved.headers.location[0].value).toBe('https://example.com/landing?gclid=abc');
        expect(siteverify).toHaveBeenCalledOnce();
        const cookie = solved.headers['set-cookie'][0].value.split(';')[0];
        expect(cookie).toMatch(/^_cq_se=\d+\.[0-9a-f]{32}\|ray-reply$/);
        expect(solved.headers['set-cookie'][0].value).toContain('Max-Age=300');

        // Act 3: the redirected request is challenged again → the cookie waives the CAPTCHA, the URL is forwarded as is
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious', rayId: 'ray-next' }));
        const event = buildEvent('/landing', 'example.com', '1.2.3.4', 'gclid=abc', cookie);
        const forwarded = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert 3
        expect(forwarded).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.querystring).toBe('gclid=abc');
        expect(siteverify).toHaveBeenCalledOnce();
    });

    it('Turnstile end to end: a challenged link to https://example.com//evil.com/ is solved on this site and comes back to it', async () => {
        // Arrange: an attacker's link whose path reads as another host in a relative URL
        const turnstile = createTurnstileChallenge({
            siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'e2e-signing-secret', sessionTtlSeconds: 300,
        });
        (config as any).challenge = turnstile.challenge;
        (config as any).validateChallenge = turnstile.validateChallenge;
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious', rayId: 'ray-page' }));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ success: true, hostname: 'example.com', action: 'cheq-challenge' }) }));
        const pageUrl = 'https://example.com//evil.com/?x=1';

        // Act 1: the challenge page
        const page = await handle(buildEvent('//evil.com/', 'example.com', '1.2.3.4', 'x=1'), RequestType.VIEWER_REQUEST) as any;

        // Assert 1: the form has no action, so the browser submits it to the page's own URL, on this host. The old
        // action (the request URI) would have resolved to evil.com and taken the token there.
        expect(page.status).toBe('403');
        expect(page.body).not.toMatch(/\saction=/);
        expect(new URL(pageUrl).host).toBe('example.com');
        expect(new URL('//evil.com/', pageUrl).host).toBe('evil.com');
        const originalUrl = page.body.match(/name="original_url" value="([^"]*)"/)[1].replace(/&amp;/g, '&');
        expect(originalUrl).toBe('//evil.com/?x=1');

        // Act 2: the solved form comes back to the same path
        const replyQuery = new URLSearchParams({ original_url: originalUrl, request_id: 'ray-page', 'cf-turnstile-response': 'tok' }).toString();
        const solved = await handle(buildEvent('//evil.com/', 'example.com', '1.2.3.4', replyQuery), RequestType.VIEWER_REQUEST) as any;

        // Assert 2: a session, and back to exactly the original URL, on this host
        expect(solved.status).toBe('302');
        expect(solved.headers.location[0].value).toBe(pageUrl);
        expect(new URL(solved.headers.location[0].value).host).toBe('example.com');
        expect(solved.headers['set-cookie'][0].value).toMatch(/^_cq_se=/);
    });

    const realTurnstile =(siteverifyResult: unknown) => {
        const turnstile = createTurnstileChallenge({
            siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'e2e-signing-secret', sessionTtlSeconds: 300,
        });
        (config as any).challenge = turnstile.challenge;
        (config as any).validateChallenge = turnstile.validateChallenge;
        (config as any).mode = Mode.BLOCKING;
        const siteverify = siteverifyResult instanceof Error
            ? vi.fn().mockRejectedValue(siteverifyResult)
            : vi.fn().mockResolvedValue(siteverifyResult);
        vi.stubGlobal('fetch', siteverify);
        return siteverify;
    };

    it('Turnstile end to end: a refresh of a used reply URL that RTI allows reaches challenge and gets its failure response', async () => {
        // Arrange: RTI allows the refresh, the token was already used
        const siteverify = realTurnstile({ json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }) });
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST) as any;

        // Assert: not forwarded with the form fields, no session
        expect(siteverify).toHaveBeenCalledOnce();
        expect(result).not.toBe(event.Records[0].cf.request);
        expect(result.status).toBe('403');
        expect(result.headers?.['set-cookie']).toBeUndefined();
    });

    it.each([
        ['solved on another site', { hostname: 'evil.com', action: 'cheq-challenge' }],
        ['solved on another widget of this site (no action)', { hostname: 'example.com' }],
    ])('Turnstile end to end: a reply with a valid token %s gets no session', async (_, fields) => {
        // Arrange
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const siteverify = realTurnstile({ json: async () => ({ success: true, ...fields }) });
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST) as any;

        // Assert: the reply path runs the same token checks as a challenged request
        expect(siteverify).toHaveBeenCalledOnce();
        expect(result).not.toBe(event.Records[0].cf.request);
        expect(result.status).toBe('403');
        expect(result.headers?.['set-cookie']).toBeUndefined();
    });

    it('Turnstile end to end: RTI is down, the solved reply still gets the session and goes back to the original URL', async () => {
        // Arrange
        expectError = true;
        realTurnstile({ json: async () => ({ success: true, hostname: 'example.com', action: 'cheq-challenge' }) });
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        const result = await handle(replyEvent(), RequestType.VIEWER_REQUEST) as any;

        // Assert
        expect(result.status).toBe('302');
        expect(result.headers.location[0].value).toBe('https://example.com/landing?gclid=abc');
        expect(result.headers['set-cookie'][0].value).toMatch(/^_cq_se=\d+\.[0-9a-f]{32}\|req-123;/);
        expect(result.headers['x-cheq-rti-result']).toBeUndefined();
    });

    it('Turnstile end to end: RTI is down and the CloudFront request id is unusable, the session still works', async () => {
        // Arrange
        expectError = true;
        realTurnstile({ json: async () => ({ success: true, hostname: 'example.com', action: 'cheq-challenge' }) });
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const event = replyEvent();
        (event.Records[0].cf.config as any).requestId = 'abc; Domain=evil|x'; // read-only in the types

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST) as any;

        // Assert: one well-formed cookie, with the random rayId, that validateChallenge accepts
        const setCookie: string = result.headers['set-cookie'][0].value;
        expect(setCookie).toMatch(/^_cq_se=\d+\.[0-9a-f]{32}\|cf-fallback-[0-9a-f-]{36}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=300$/);
        const cookie = setCookie.split(';')[0];
        const next = buildEvent('/landing', 'example.com', '1.2.3.4', 'gclid=abc', cookie).Records[0].cf.request;
        expect(await (config as any).validateChallenge(next, false)).toBe(true);
    });

    it('Turnstile end to end: the siteverify call fails → the reply is forwarded (fail open)', async () => {
        // Arrange
        expectError = true;
        realTurnstile(new Error('siteverify unreachable'));
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('Challenge error'));
    });
});
