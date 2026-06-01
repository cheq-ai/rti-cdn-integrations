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

vi.mock('../../core/services/rti.service', () => ({
    RTIService: vi.fn().mockImplementation(function () { return { callRTI: mocks.callRTI }; }),
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

vi.mock('../../core/services/rti-logger.service', () => ({
    RTILoggerService: vi.fn().mockImplementation(function () {
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

    it('fails open to cfRequest when host header is absent (invalid URL)', async () => {
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

    // --- Pass-through: validateChallenge ---

    it('calls RTI when validateChallenge is not configured', async () => {
        // Arrange
        (config as any).validateChallenge = undefined;
        const event = buildEvent();

        // Act
        await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(mocks.callRTI).toHaveBeenCalled();
    });

    it('passes through without calling RTI when challenge is already valid (viewer request)', async () => {
        // Arrange
        mocks.validateChallenge.mockResolvedValue(true);
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.VIEWER_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.callRTI).not.toHaveBeenCalled();
    });

    it('calls validateChallenge with the cfRequest containing the _cq_se cookie', async () => {
        // Arrange
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

    // --- Error handling ---

    it('passes through, logs to console.error and logger when validateChallenge throws', async () => {
        // Arrange
        expectError = true;
        (config as any).validateChallenge = vi.fn().mockRejectedValue(new Error('validate crash'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const event = buildEvent();

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
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

    it('joins multiple Cookie header entries with ", " before parsing', async () => {
        // Arrange
        const event = buildEvent();
        // CloudFront can send multiple Cookie header entries; the handler joins them with ", ".
        // Cheq cookies followed by a semicolon-separated sibling are extracted correctly after joining.
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
});
