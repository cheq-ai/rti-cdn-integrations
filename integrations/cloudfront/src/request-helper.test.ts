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

vi.mock('../../core/services/rti-helper.service', () => ({
    RTIHelperService: vi.fn().mockImplementation(function () {
        return {
            shouldIgnore: mocks.shouldIgnore,
            getAction: mocks.getAction,
            getActionStrategy: mocks.getActionStrategy,
            getEventType: mocks.getEventType,
            validateConfig: vi.fn().mockReturnValue([]),
        };
    }),
}));

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

function buildEvent(uri = '/page', host = 'example.com', clientIp = '1.2.3.4', querystring = '', cookies = ''): CloudFrontRequestEvent {
    const headers: Record<string, any> = {
        host: [{ key: 'Host', value: host }],
        'user-agent': [{ key: 'User-Agent', value: 'Mozilla/5.0' }],
    };
    if (cookies) {
        headers['cookie'] = [{ key: 'Cookie', value: cookies }];
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
                    method: 'GET',
                    uri,
                    querystring,
                    headers,
                },
            },
        }],
    } as CloudFrontRequestEvent;
}

function buildRTIResponse() {
    return {
        metadata: { version: '1.0' },
        decision: { verdict: 'valid' },
        classification: { code: 0 },
        ids: { rayId: 'ray-123' },
        cheqDetection: { reasons: ['reason1'] },
    };
}

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
    });

    afterEach(() => {
        if (!expectError) {
            expect(consoleErrorSpy).not.toHaveBeenCalled();
            expect(mocks.loggerError).not.toHaveBeenCalled();
        }
        consoleErrorSpy.mockRestore();
    });

    // --- Pass-through: ignored path ---

    it('passes through without calling RTI when path is ignored', async () => {
        mocks.shouldIgnore.mockReturnValue(true);
        const event = buildEvent('/favicon.ico');
        const result = await handle(event, RequestType.ORIGIN_REQUEST);
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.callRTI).not.toHaveBeenCalled();
    });

    // --- Pass-through: valid challenge ---

    it('passes through without calling RTI when challenge is already valid', async () => {
        mocks.validateChallenge.mockResolvedValue(true);
        const event = buildEvent();
        const result = await handle(event, RequestType.VIEWER_REQUEST);
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.callRTI).not.toHaveBeenCalled();
    });

    it('calls RTI when validateChallenge is not configured', async () => {
        (config as any).validateChallenge = undefined;
        const event = buildEvent();
        await handle(event, RequestType.ORIGIN_REQUEST);
        expect(mocks.callRTI).toHaveBeenCalled();
    });

    // --- RTI ALLOW ---

    it('returns cfRequest when RTI returns ALLOW', async () => {
        const event = buildEvent();
        const result = await handle(event, RequestType.ORIGIN_REQUEST);
        expect(result).toBe(event.Records[0].cf.request);
    });

    // --- x-cheq-rti-result header ---

    it('sets x-cheq-rti-result on the request forwarded to origin on ALLOW', async () => {
        const event = buildEvent();
        await handle(event, RequestType.ORIGIN_REQUEST);
        const header = event.Records[0].cf.request.headers['x-cheq-rti-result'];
        expect(header).toBeDefined();
        expect(header[0].key).toBe('x-cheq-rti-result');
        expect(header[0].value).toContain('version=1.0');
    });

    it('x-cheq-rti-result contains version, verdict, threat-type-code, and ids', async () => {
        const event = buildEvent();
        await handle(event, RequestType.ORIGIN_REQUEST);
        const value = event.Records[0].cf.request.headers['x-cheq-rti-result'][0].value;
        expect(value).toContain('version=1.0');
        expect(value).toContain('verdict=valid');
        expect(value).toContain('threat-type-code=0');
        expect(value).toContain('ids=');
        expect(value).not.toContain('reasons=');
    });

    it('x-cheq-rti-result ids field includes rayId', async () => {
        const event = buildEvent();
        await handle(event, RequestType.ORIGIN_REQUEST);
        const value = event.Records[0].cf.request.headers['x-cheq-rti-result'][0].value;
        expect(value).toContain('ray-123');
    });

    // --- Header collection ---

    // ja3/ja4 fingerprint keys are always set on the headers object (undefined when not in request),
    // so filter to defined values when asserting size.
    const definedHeaders = (headers: Record<string, any>) =>
        Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));

    it('collects all headers when keepHeadersNames is empty', async () => {
        const event = buildEvent();
        await handle(event, RequestType.ORIGIN_REQUEST);
        const headers = definedHeaders(mocks.callRTI.mock.calls[0][0].endUserParams.headers);
        expect(Object.keys(headers)).toHaveLength(2);
        expect(headers).toHaveProperty('host', 'example.com');
        expect(headers).toHaveProperty('user-agent', 'Mozilla/5.0');
    });

    it('collects all headers when keepHeadersNames is undefined', async () => {
        (config as any).keepHeadersNames = undefined;
        const event = buildEvent();
        await handle(event, RequestType.ORIGIN_REQUEST);
        const headers = definedHeaders(mocks.callRTI.mock.calls[0][0].endUserParams.headers);
        expect(Object.keys(headers)).toHaveLength(2);
        expect(headers).toHaveProperty('host');
        expect(headers).toHaveProperty('user-agent');
    });

    it('filters to keepHeadersNames when non-empty', async () => {
        (config as any).keepHeadersNames = ['host'];
        const event = buildEvent();
        await handle(event, RequestType.ORIGIN_REQUEST);
        const headers = definedHeaders(mocks.callRTI.mock.calls[0][0].endUserParams.headers);
        expect(Object.keys(headers)).toHaveLength(1);
        expect(headers).toHaveProperty('host', 'example.com');
        expect(headers).not.toHaveProperty('user-agent');
    });

    it('omits header from payload when keepHeadersNames lists a header not present in the request', async () => {
        (config as any).keepHeadersNames = ['host', 'x-not-present'];
        const event = buildEvent();
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.headers).not.toHaveProperty('x-not-present');
        expect(payload.endUserParams.headers).toHaveProperty('host');
    });

    it('includes cheq_ja3 and cheq_ja4 fingerprints when cloudfront viewer fingerprint headers are present', async () => {
        const event = buildEvent();
        event.Records[0].cf.request.headers['cloudfront-viewer-ja3-fingerprint'] = [{ key: 'cloudfront-viewer-ja3-fingerprint', value: 'abc123ja3' }];
        event.Records[0].cf.request.headers['cloudfront-viewer-ja4-fingerprint'] = [{ key: 'cloudfront-viewer-ja4-fingerprint', value: 'def456ja4' }];
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.headers.cheq_ja3).toBe('abc123ja3');
        expect(payload.endUserParams.headers.cheq_ja4).toBe('def456ja4');
    });

    // --- URL construction (getRequestUrl via payload) ---

    it('builds request URL from host header and uri', async () => {
        const event = buildEvent('/my-page', 'example.com');
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.requestUrl).toBe('https://example.com/my-page');
    });

    it('fails open to cfRequest when host header is absent (invalid URL)', async () => {
        expectError = true;
        const event = buildEvent('/my-page', 'example.com');
        delete event.Records[0].cf.request.headers['host'];
        const result = await handle(event, RequestType.ORIGIN_REQUEST);
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).toHaveBeenCalled();
    });

    it('appends querystring to URL when present', async () => {
        const event = buildEvent('/page', 'example.com', '1.2.3.4', 'foo=bar&baz=1');
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.requestUrl).toBe('https://example.com/page?foo=bar&baz=1');
    });

    it('does not append "?" when querystring is empty', async () => {
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '');
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.requestUrl).toBe('https://example.com/page');
        expect(payload.endUserParams.requestUrl).not.toContain('?');
    });

    // --- Telemetry ---

    it('logs RTI duration when telemetry is enabled', async () => {
        (config as any).telemetry = true;
        const event = buildEvent();
        await handle(event, RequestType.ORIGIN_REQUEST);
        expect(mocks.loggerInfo).toHaveBeenCalledWith(expect.stringContaining('rti_duration'));
    });

    // --- Block strategies ---

    it('returns 403 when action strategy is ACCESS_DENIED', async () => {
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);
        const event = buildEvent();
        const result = await handle(event, RequestType.ORIGIN_REQUEST) as any;
        expect(result.status).toBe('403');
    });

    it('returns 404 when action strategy is NOT_FOUND', async () => {
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.NOT_FOUND);
        const event = buildEvent();
        const result = await handle(event, RequestType.ORIGIN_REQUEST) as any;
        expect(result.status).toBe('404');
    });

    it('returns 302 with redirect location when action strategy is REDIRECT', async () => {
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        const event = buildEvent();
        const result = await handle(event, RequestType.ORIGIN_REQUEST) as any;
        expect(result.status).toBe('302');
        expect(result.headers.location[0].value).toBe('https://www.cheq.ai/');
    });

    it('defaults redirect location to cheq.ai when redirectLocation is not configured', async () => {
        (config as any).redirectLocation = undefined;
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        const event = buildEvent();
        const result = await handle(event, RequestType.ORIGIN_REQUEST) as any;
        expect(result.status).toBe('302');
        expect(result.headers.location[0].value).toBe('https://www.cheq.ai/');
    });

    it('includes x-cheq-id and x-cheq-cf-request-id headers on REDIRECT', async () => {
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        const event = buildEvent();
        const result = await handle(event, RequestType.ORIGIN_REQUEST) as any;
        expect(result.headers['x-cheq-id'][0].value).toBe('ray-123');
        expect(result.headers['x-cheq-cf-request-id'][0].value).toBe('req-123');
    });

    it('includes x-cheq-page-view-id with pageViewId value when present on REDIRECT', async () => {
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        mocks.callRTI.mockResolvedValue({ ...buildRTIResponse(), ids: { rayId: 'ray-123', pageViewId: 'pv-xyz' } });
        const event = buildEvent();
        const result = await handle(event, RequestType.ORIGIN_REQUEST) as any;
        expect(result.headers['x-cheq-page-view-id'][0].value).toBe('pv-xyz');
    });

    it('includes x-cheq-page-view-id with empty string when pageViewId is absent on REDIRECT', async () => {
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        mocks.callRTI.mockResolvedValue({ ...buildRTIResponse(), ids: { rayId: 'ray-123', pageViewId: null } });
        const event = buildEvent();
        const result = await handle(event, RequestType.ORIGIN_REQUEST) as any;
        expect(result.headers['x-cheq-page-view-id'][0].value).toBe('');
    });

    // --- CAPTCHA ---

    it('calls challenge and returns its result when CAPTCHA and challenge is configured', async () => {
        const challengeResponse = { status: '403', body: '<html>captcha</html>' };
        (config as any).challenge = vi.fn().mockResolvedValue(challengeResponse);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const event = buildEvent();
        const result = await handle(event, RequestType.VIEWER_REQUEST);
        expect(result).toBe(challengeResponse);
    });

    it('passes through and logs error when challenge throws', async () => {
        expectError = true;
        (config as any).challenge = vi.fn().mockRejectedValue(new Error('challenge failed'));
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const event = buildEvent();
        const result = await handle(event, RequestType.VIEWER_REQUEST);
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).toHaveBeenCalled();
    });

    it('passes through when CAPTCHA action but no challenge configured', async () => {
        (config as any).challenge = undefined;
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const event = buildEvent();
        const result = await handle(event, RequestType.VIEWER_REQUEST);
        expect(result).toBe(event.Records[0].cf.request);
    });

    // --- Default strategy ---

    it('passes through when action strategy is unrecognized (default case)', async () => {
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(null);
        const event = buildEvent();
        const result = await handle(event, RequestType.ORIGIN_REQUEST);
        expect(result).toBe(event.Records[0].cf.request);
    });

    // --- Cookie extraction (_cq_duid, _cq_pvid) ---

    it('extracts _cq_duid and _cq_pvid from cookie header', async () => {
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_duid=device-abc; _cq_pvid=pageview-xyz');
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBe('device-abc');
        expect(payload.pvidCookie).toBe('pageview-xyz');
    });

    it('extracts _cq_duid without _cq_pvid', async () => {
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_duid=device-abc');
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBe('device-abc');
        expect(payload.pvidCookie).toBeUndefined();
    });

    it('leaves duidCookie and pvidCookie undefined when no cookie header present', async () => {
        const event = buildEvent();
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBeUndefined();
        expect(payload.pvidCookie).toBeUndefined();
    });

    it('does not extract _cq_se as duid or pvid', async () => {
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=token|ray; _cq_duid=device-abc');
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBe('device-abc');
        expect(payload.pvidCookie).toBeUndefined();
    });

    // --- sCookie extraction (_cq_s) ---

    it('extracts sCookie from _cq_s cookie', async () => {
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_s=scookie-value');
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.sCookie).toBe('scookie-value');
    });

    it('extracts all three cookies together: _cq_duid, _cq_pvid, _cq_s', async () => {
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_duid=device-abc; _cq_pvid=pv-xyz; _cq_s=scookie-value');
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBe('device-abc');
        expect(payload.pvidCookie).toBe('pv-xyz');
        expect(payload.sCookie).toBe('scookie-value');
    });

    it('leaves sCookie undefined when _cq_s is not present', async () => {
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_duid=device-abc');
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.sCookie).toBeUndefined();
    });

    it('does not confuse _cq_se with _cq_s', async () => {
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=token|ray; _cq_s=scookie-value');
        await handle(event, RequestType.ORIGIN_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.sCookie).toBe('scookie-value');
    });

    it('skips RTI when validateChallenge returns true (_cq_se session is valid)', async () => {
        mocks.validateChallenge.mockResolvedValue(true);
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=sometoken|someray');
        const result = await handle(event, RequestType.VIEWER_REQUEST);
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.callRTI).not.toHaveBeenCalled();
    });

    it('calls RTI when validateChallenge returns false (_cq_se session is absent or expired)', async () => {
        mocks.validateChallenge.mockResolvedValue(false);
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_duid=device-abc');
        await handle(event, RequestType.VIEWER_REQUEST);
        expect(mocks.callRTI).toHaveBeenCalled();
    });

    it('calls validateChallenge with the cfRequest containing the _cq_se cookie', async () => {
        mocks.validateChallenge.mockResolvedValue(false);
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=sometoken|someray');
        await handle(event, RequestType.VIEWER_REQUEST);
        expect(mocks.validateChallenge).toHaveBeenCalledWith(
            event.Records[0].cf.request,
            false // isDebug
        );
    });

    it('calls validateChallenge with isDebug=true when debug is enabled', async () => {
        (config as any).debug = true;
        mocks.validateChallenge.mockResolvedValue(false);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=sometoken|someray');
        await handle(event, RequestType.VIEWER_REQUEST);
        expect(mocks.validateChallenge).toHaveBeenCalledWith(
            event.Records[0].cf.request,
            true // isDebug
        );
        consoleSpy.mockRestore();
    });

    it('_cq_se cookie does not interfere with _cq_duid extraction when challenge fails', async () => {
        mocks.validateChallenge.mockResolvedValue(false);
        const event = buildEvent('/page', 'example.com', '1.2.3.4', '', '_cq_se=tok|ray; _cq_duid=device-abc; _cq_pvid=pv-xyz');
        await handle(event, RequestType.VIEWER_REQUEST);
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBe('device-abc');
        expect(payload.pvidCookie).toBe('pv-xyz');
    });

    // --- Error handling ---

    it('passes through and logs error when RTI call throws', async () => {
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = buildEvent();
        const result = await handle(event, RequestType.ORIGIN_REQUEST);
        expect(result).toBe(event.Records[0].cf.request);
        expect(mocks.loggerError).toHaveBeenCalled();
    });

    it('uses "unknown_request_id" in error log when requestId is absent', async () => {
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const event = buildEvent();
        (event.Records[0].cf.config as any).requestId = undefined;
        await handle(event, RequestType.ORIGIN_REQUEST);
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('unknown_request_id'));
    });

    it('returns "on_error_request_id" fallback when getCfRequestId throws accessing cf.config', async () => {
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('RTI failure'));
        const event = buildEvent();
        Object.defineProperty(event.Records[0].cf, 'config', { get() { throw new Error('config access error'); } });
        await handle(event, RequestType.ORIGIN_REQUEST);
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('on_error_request_id'));
    });


    // --- Debug logging ---

    it('logs "Origin" event type when debug enabled for ORIGIN_REQUEST', async () => {
        (config as any).debug = true;
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handle(buildEvent(), RequestType.ORIGIN_REQUEST);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Origin'));
        consoleSpy.mockRestore();
    });

    it('logs "Viewer" event type when debug enabled for VIEWER_REQUEST', async () => {
        (config as any).debug = true;
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handle(buildEvent(), RequestType.VIEWER_REQUEST);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Viewer'));
        consoleSpy.mockRestore();
    });

    it('logs "Unknown" event type when debug enabled for unrecognized RequestType', async () => {
        (config as any).debug = true;
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handle(buildEvent(), 99 as RequestType);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown'));
        consoleSpy.mockRestore();
    });

    it('logs RTI payload, response and action details when debug enabled', async () => {
        (config as any).debug = true;
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handle(buildEvent(), RequestType.ORIGIN_REQUEST);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('RTI Request payload'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('RTI Response'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('action upon response'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('action strategy'));
        consoleSpy.mockRestore();
    });

    it('logs "none (should not happen)" when debug enabled and action strategy is unrecognized', async () => {
        (config as any).debug = true;
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(null);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handle(buildEvent(), RequestType.ORIGIN_REQUEST);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('none (should not happen)'));
        consoleSpy.mockRestore();
    });

    it('logs raw action value when debug enabled and action has no named enum entry', async () => {
        (config as any).debug = true;
        const unknownAction = 999 as Action;
        mocks.getAction.mockReturnValue(unknownAction);
        mocks.getActionStrategy.mockReturnValue(null);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await handle(buildEvent(), RequestType.ORIGIN_REQUEST);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('999'));
        consoleSpy.mockRestore();
    });
});
