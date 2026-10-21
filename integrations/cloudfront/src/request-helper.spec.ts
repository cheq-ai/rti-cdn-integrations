// cspell:ignore duid pvid
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CloudFrontRequestEvent } from 'aws-lambda';

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
            // buildRtiResultHeader and parseCookies are pure functions with no side effects — use the
            // real implementation so tests verify actual output rather than a duplicated mock formula.
            const realInstance = new real.RTIHelperService(config);
            return {
                shouldIgnore: mocks.shouldIgnore,
                getAction: mocks.getAction,
                getActionStrategy: mocks.getActionStrategy,
                getEventType: mocks.getEventType,
                validateConfig: vi.fn().mockReturnValue([]),
                parseCookies: realInstance.parseCookies.bind(realInstance),
                buildRtiResultHeader: realInstance.buildRtiResultHeader.bind(realInstance),
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
import { config } from './config';
import type { TestAdapter, NormalizedResult, InvokeOptions, ConfigOverrides } from '../../core/testing/test-adapter.interface';
import { registerSharedBehaviorTests } from '../../core/testing/shared-unit-tests';
import { buildRTIResponse } from '../../core/testing/rti-response.fixture';
import { RTIHttpsService } from '../../core/services/rti-https.service';
import { RTIHttpsLoggerService } from '../../core/services/rti-https-logger.service';
import { createTurnstileChallenge } from './turnstile-challenge-example';

// request-helper creates its services once, at import. Copied now: vi.clearAllMocks() in beforeEach wipes mock.calls.
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
        const siteverify = vi.fn().mockResolvedValue({ json: async () => ({ success: true }) });
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
});
