// cspell:ignore cheq duid pvid unstub requset
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    callRTI: vi.fn(),
    shouldIgnore: vi.fn(),
    getAction: vi.fn(),
    getActionStrategy: vi.fn(),
    getEventType: vi.fn().mockReturnValue('pageview'),
    validateConfig: vi.fn().mockReturnValue([]),
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
        redirectLocation: 'https://www.cheq.ai/',
        challenge: undefined as any,
        validateChallenge: undefined as any,
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
                validateConfig: mocks.validateConfig,
                parseCookies: realInstance.parseCookies.bind(realInstance),
                buildRtiResultHeader: realInstance.buildRtiResultHeader.bind(realInstance),
            };
        }),
    };
});

vi.mock('../../core/services/rti-logger.service', () => ({
    RTILoggerService: vi.fn().mockImplementation(function () {
        return { info: mocks.loggerInfo, error: mocks.loggerError };
    }),
}));

vi.mock('../../core/helpers/block-page-helpers', () => ({
    generateDefaultBlockPage: mocks.generateDefaultBlockPage,
}));

import worker from './index';
import { Action } from '../../core/models/action.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { config } from './config';
import type { TestAdapter, NormalizedResult, InvokeOptions, ConfigOverrides } from '../../core/testing/test-adapter.interface';
import { registerSharedBehaviorTests } from '../../core/testing/shared-unit-tests';

const BASE_URL = 'https://example.com';

function buildWorkerRequest(path = '/page', opts: {
    cookies?: string;
    cfRay?: string;
    xRealIp?: string;
    querystring?: string;
    method?: string;
    extraHeaders?: Record<string, string>;
} = {}): Request {
    const url = `${BASE_URL}${path}${opts.querystring ? '?' + opts.querystring : ''}`;
    const headers = new Headers();
    headers.set('host', 'example.com');
    headers.set('user-agent', 'Mozilla/5.0');
    if (opts.cookies) headers.set('cookie', opts.cookies);
    if (opts.cfRay) headers.set('cf-ray', opts.cfRay);
    if (opts.xRealIp) headers.set('x-real-ip', opts.xRealIp);
    if (opts.extraHeaders) {
        for (const [k, v] of Object.entries(opts.extraHeaders)) headers.set(k, v);
    }
    return new Request(url, { method: opts.method ?? 'GET', headers });
}

function buildContext(): ExecutionContext {
    return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

// --- Cloudflare adapter ---

// Stores console.log calls captured during the last invoke() call.
let _lastConsoleLogs: string[] = [];

const cloudflareAdapter: TestAdapter = {
    name: 'cloudflare worker',

    async invoke(options: InvokeOptions = {}): Promise<NormalizedResult> {
        _lastConsoleLogs = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            _lastConsoleLogs.push(String(args[0]));
        });

        let capturedRequest: Request | undefined;
        let fetchCalled = false;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((req: Request) => {
            capturedRequest = req;
            fetchCalled = true;
            return Promise.resolve(new Response('origin'));
        }));
        const ctx = buildContext();
        const request = buildWorkerRequest(options.path ?? '/page', {
            cookies: options.cookies,
            querystring: options.querystring,
            method: options.method,
            xRealIp: options.ip,
            extraHeaders: options.headers,
        });
        const response = await worker.fetch(request, {}, ctx);
        consoleSpy.mockRestore();
        const body = await response.clone().text();
        const headers: Record<string, string> = {};
        // Include x-cheq-rti-result from origin-bound request when passed through
        response.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        if (capturedRequest) {
            const rtiHeader = capturedRequest.headers.get('x-cheq-rti-result');
            if (rtiHeader) headers['x-cheq-rti-result'] = rtiHeader;
        }
        return {
            status: response.status,
            headers,
            body,
            passedThrough: fetchCalled && response.status < 400,
        };
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
                (config as any).challenge = vi.fn().mockResolvedValue(new Response('<html>captcha</html>', { status: 403 }));
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
        (config as any).validateChallenge = undefined;
        (config as any).redirectLocation = 'https://www.cheq.ai/';
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

registerSharedBehaviorTests(cloudflareAdapter, mocks);

// --- Cloudflare-specific tests ---

describe('cloudflare worker', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.shouldIgnore.mockReturnValue(false);
        mocks.getAction.mockReturnValue(Action.ALLOW);
        mocks.callRTI.mockResolvedValue({
            metadata: { version: '4.1' },
            decision: { verdict: 'benign' },
            classification: { code: 0 },
            ids: { rayId: 'ray-123', pageViewId: null, duid: null, uniqueVisitId: null, customParam1: null, customParam2: null, customParam3: null, customParam4: null },
            cheqDetection: { reasons: ['reason1'] },
        });
        (config as any).debug = false;
        (config as any).telemetry = false;
        (config as any).challenge = undefined;
        (config as any).validateChallenge = undefined;
        (config as any).redirectLocation = 'https://www.cheq.ai/';
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        vi.unstubAllGlobals();
    });

    // --- customId2 (cf-ray) ---

    it('passes cf-ray as customId2 in RTI payload', async () => {
        // Arrange
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));

        // Act
        await worker.fetch(buildWorkerRequest('/page', { cfRay: 'cf-ray-12345' }), {}, buildContext());
        const payload = mocks.callRTI.mock.calls[0][0];

        // Assert
        expect(payload.customId2).toBe('cf-ray-12345');
    });

    it('sets customId2 to undefined when cf-ray header is absent', async () => {
        // Arrange
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));

        // Act
        await worker.fetch(buildWorkerRequest(), {}, buildContext());
        const payload = mocks.callRTI.mock.calls[0][0];

        // Assert
        expect(payload.customId2).toBeUndefined();
    });

    // --- passThroughOnException ---

    it('calls context.passThroughOnException on every request', async () => {
        // Arrange
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const ctx = buildContext();

        // Act
        await worker.fetch(buildWorkerRequest(), {}, ctx);

        // Assert
        expect(ctx.passThroughOnException).toHaveBeenCalledOnce();
    });

    // --- Error logging ---

    it('logs to console.error and logger when validateChallenge throws', async () => {
        // Arrange
        (config as any).validateChallenge = vi.fn().mockRejectedValue(new Error('validate crash'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const ctx = buildContext();

        // Act
        const result = await worker.fetch(buildWorkerRequest(), {}, ctx);

        // Assert
        expect(result.status).toBe(200);
        expect(consoleErrorSpy).toHaveBeenCalledWith('error', expect.objectContaining({ message: 'validate crash' }));
        expect(ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('validate crash'));
    });

    it('logs to console.error and logger when challenge throws', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        (config as any).challenge = vi.fn().mockRejectedValue(new Error('challenge crash'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const ctx = buildContext();

        // Act
        const result = await worker.fetch(buildWorkerRequest(), {}, ctx);

        // Assert
        expect(result.status).toBe(200);
        expect(consoleErrorSpy).toHaveBeenCalledWith('challenge error', expect.objectContaining({ message: 'challenge crash' }));
        expect(ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('challenge crash'));
    });

    // --- getHeaders filtering ---

    it('only sends configured headerNames in RTI payload', async () => {
        // Arrange
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));

        // Act
        await worker.fetch(buildWorkerRequest('/page', { xRealIp: '9.9.9.9' }), {}, buildContext());
        const headers = mocks.callRTI.mock.calls[0][0].endUserParams.headers;

        // Assert
        expect(Object.keys(headers)).toEqual(expect.arrayContaining(['user-agent', 'host', 'x-real-ip']));
        expect(Object.keys(headers)).not.toContain('x-unknown-custom-header');
    });

    // --- JA3 hash ---

    it('passes ja3Hash from cf.botManagement as cheq_ja3 in RTI payload headers', async () => {
        // Arrange
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const req = Object.assign(buildWorkerRequest(), { cf: { botManagement: { ja3Hash: 'abc123ja3' } } });

        // Act
        await worker.fetch(req as any, {}, buildContext());
        const payload = mocks.callRTI.mock.calls[0][0];

        // Assert
        expect(payload.endUserParams.headers.cheq_ja3).toBe('abc123ja3');
    });

    it('sets cheq_ja3 to undefined when cf.botManagement is absent', async () => {
        // Arrange
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));

        // Act
        await worker.fetch(buildWorkerRequest(), {}, buildContext());
        const payload = mocks.callRTI.mock.calls[0][0];

        // Assert
        expect(payload.endUserParams.headers.cheq_ja3).toBeUndefined();
    });

    it('sets cheq_ja3 to undefined when ja3Hash is an empty string', async () => {
        // Arrange
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const req = Object.assign(buildWorkerRequest(), { cf: { botManagement: { ja3Hash: '' } } });

        // Act
        await worker.fetch(req as any, {}, buildContext());
        const payload = mocks.callRTI.mock.calls[0][0];

        // Assert
        expect(payload.endUserParams.headers.cheq_ja3).toBeUndefined();
    });

    // --- clientIp from x-real-ip ---

    it('sets clientIp to null when x-real-ip header is absent', async () => {
        // Arrange
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));

        // Act
        await worker.fetch(buildWorkerRequest('/page', {}), {}, buildContext());
        const payload = mocks.callRTI.mock.calls[0][0];

        // Assert
        expect(payload.endUserParams.clientIp).toBeNull();
    });

    // --- passes cf-ray as additionalCdnId to block page ---

    it('passes cf-ray as additionalCdnId to generateDefaultBlockPage', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);

        // Act
        await worker.fetch(buildWorkerRequest('/page', { cfRay: 'ray-abc-123' }), {}, buildContext());

        // Assert
        expect(mocks.generateDefaultBlockPage).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.anything(), 'ray-abc-123');
    });

    // --- cf-ray on redirect response ---

    it('sets x-cheq-cdn-request-id to cf-ray value on REDIRECT', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue({
            metadata: { version: '4.1' },
            decision: { verdict: 'benign' },
            classification: { code: 0 },
            ids: {
                rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
                pageViewId: '16183c3ded45c554f9b4bb71a42d8e71',
                duid: null, uniqueVisitId: null,
                customParam1: null, customParam2: null, customParam3: null, customParam4: null,
            },
            cheqDetection: { reasons: [] },
        });
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);

        // Act
        const response = await worker.fetch(
            buildWorkerRequest('/page', { cfRay: 'ray-abc-123' }),
            {},
            buildContext(),
        );

        // Assert
        expect(response.status).toBe(302);
        expect(response.headers.get('x-cheq-cdn-request-id')).toBe('ray-abc-123');
        expect(response.headers.get('x-cheq-id')).toBe('b196ca1f77553f84b0a8e8e3c5f64c27');
        expect(response.headers.get('x-cheq-page-view-id')).toBe('16183c3ded45c554f9b4bb71a42d8e71');
        expect(response.headers.get('location')).toBe('https://www.cheq.ai/');
    });

    // --- Telemetry: waitUntil ---

    it('calls context.waitUntil with logger when telemetry is enabled', async () => {
        // Arrange
        (config as any).telemetry = true;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const ctx = buildContext();

        // Act
        await worker.fetch(buildWorkerRequest(), {}, ctx);

        // Assert
        expect(ctx.waitUntil).toHaveBeenCalled();
    });
});
