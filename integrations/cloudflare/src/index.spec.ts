// cspell:ignore cheq duid pvid unstub requset bodyless gclid siteverify
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    callRTI: vi.fn(),
    shouldIgnore: vi.fn(),
    getAction: vi.fn(),
    getActionStrategy: vi.fn(),
    getEventType: vi.fn().mockReturnValue('pageview'),
    validateConfig: vi.fn().mockReturnValue([]),
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
            // validateActionOnSuspicious, getActionOnSuspicious, findActionOnSuspiciousRule, isBodylessMethod,
            // isPageLoad, isPrefetch, sameSiteReferer, parseCookies, stringifyRedactedPayload, buildRtiResultHeader,
            // isChallengeReplyAllowed and errorMessage are pure functions with no side effects — use the real
            // implementation so tests verify actual output rather than a duplicated mock formula.
            const realInstance = new real.RTIHelperService(config);
            const service: any = {
                shouldIgnore: mocks.shouldIgnore,
                getAction: mocks.getAction,
                getActionStrategy: mocks.getActionStrategy,
                getEventType: mocks.getEventType,
                validateConfig: mocks.validateConfig,
                validateActionOnSuspicious: realInstance.validateActionOnSuspicious.bind(realInstance),
                getActionOnSuspicious: realInstance.getActionOnSuspicious.bind(realInstance),
                // Private in core: bracket access compiles, dot access does not.
                findActionOnSuspiciousRule: realInstance['findActionOnSuspiciousRule'].bind(realInstance),
                isBodylessMethod: realInstance.isBodylessMethod.bind(realInstance),
                isPageLoad: realInstance.isPageLoad.bind(realInstance),
                isPrefetch: realInstance.isPrefetch.bind(realInstance),
                sameSiteReferer: realInstance.sameSiteReferer.bind(realInstance),
                parseCookies: realInstance.parseCookies.bind(realInstance),
                stringifyRedactedPayload: realInstance.stringifyRedactedPayload.bind(realInstance),
                buildRtiResultHeader: realInstance.buildRtiResultHeader.bind(realInstance),
                isChallengeReplyAllowed: realInstance.isChallengeReplyAllowed.bind(realInstance),
                errorMessage: realInstance.errorMessage.bind(realInstance),
            };
            // The real getStrategyForRequest, run on this mock: it uses the mocked getActionStrategy for RTI's action,
            // and the real isBodylessMethod, findActionOnSuspiciousRule and getActionOnSuspicious above.
            service.getStrategyForRequest = real.RTIHelperService.prototype.getStrategyForRequest.bind(service);
            return service;
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
import { Mode } from '../../core/models/mode.model';
import { config } from './config';
import type { CloudflareConfig } from './config';
import type { TestAdapter, NormalizedResult, InvokeOptions, ConfigOverrides } from '../../core/testing/test-adapter.interface';
import { registerSharedBehaviorTests } from '../../core/testing/shared-unit-tests';
import { buildRTIResponse } from '../../core/testing/rti-response.fixture';

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

const CF_RAY = 'ray-abc-123';

// Sends a request through the Worker. `forwarded` is the request the origin received, if any.
async function run(request: Request, origin: () => Promise<Response> = async () => new Response('origin')) {
    const originFetch = vi.fn<(request: Request) => Promise<Response>>(origin);
    vi.stubGlobal('fetch', originFetch);
    const ctx = buildContext();
    const response = await worker.fetch(request, {}, ctx);
    return { response, ctx, originFetch, forwarded: originFetch.mock.calls[0]?.[0] as Request | undefined };
}

// --- Cloudflare adapter ---

// Stores console.log calls captured during the last invoke() call.
let _lastConsoleLogs: string[] = [];

const cloudflareAdapter: TestAdapter = {
    name: 'cloudflare worker',
    // RTI always runs; a valid session only waives the CAPTCHA (tested in 'cloudflare worker').
    validChallengeSkipsRti: false,

    async invoke(options: InvokeOptions = {}): Promise<NormalizedResult> {
        _lastConsoleLogs = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            _lastConsoleLogs.push(String(args[0]));
        });
        // The shared fail-open tests make the Worker log an error on purpose: keep it out of the test output.
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
        let response: Response;
        try {
            response = await worker.fetch(request, {}, ctx);
        } finally {
            // Also when the Worker rejects: console.error must not stay silenced for later tests.
            consoleSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        }
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
        (config as any).logErrors = undefined;
        (config as any).challenge = undefined;
        (config as any).validateChallenge = undefined;
        (config as any).isChallengeResponse = undefined;
        (config as any).mode = undefined;
        (config as any).originalReferer = undefined;
        (config as any).redirectLocation = 'https://www.cheq.ai/';
        delete (config as any).actionOnSuspicious;
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

registerSharedBehaviorTests(cloudflareAdapter, mocks);

// --- Cloudflare-specific tests ---

describe('cloudflare worker', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let expectError = false;

    // Recognizes the reply to a Turnstile challenge page by its token. Set as config.isChallengeResponse in beforeEach.
    const isReply = (request: Request) => new URL(request.url).searchParams.has('cf-turnstile-response');

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
        (config as any).challenge = undefined;
        (config as any).validateChallenge = mocks.validateChallenge;
        (config as any).isChallengeResponse = isReply;
        (config as any).mode = undefined;
        (config as any).originalReferer = undefined;
        (config as any).redirectLocation = 'https://www.cheq.ai/';
        delete (config as any).actionOnSuspicious;
    });

    afterEach(() => {
        try {
            if (!expectError) {
                expect(consoleErrorSpy).not.toHaveBeenCalled();
                expect(mocks.loggerError).not.toHaveBeenCalled();
            }
        } finally {
            // Also when the guard fails: its spies and stubs must not leak into the next test.
            consoleErrorSpy.mockRestore();
            vi.restoreAllMocks(); // spies a failed test did not get to restore must not leak into the next one
            vi.unstubAllGlobals();
        }
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

    it('calls context.passThroughOnException before anything can throw (copying a request whose body was read throws)', async () => {
        // Arrange
        const request = new Request('https://example.com/form', { method: 'POST', body: 'a=1' });
        await request.text();
        const ctx = buildContext();

        // Act & Assert
        await expect(worker.fetch(request, {}, ctx)).rejects.toThrow(TypeError);
        expect(ctx.passThroughOnException).toHaveBeenCalledOnce();
        expect(mocks.callRTI).not.toHaveBeenCalled();
    });

    // --- Challenge session (validateChallenge) ---
    // RTI always runs. A valid session (validateChallenge → true) only waives the CAPTCHA: the request is
    // forwarded with the real verdict in x-cheq-rti-result. It never waives a block, 404 or redirect.

    const captchaVerdict = () => {
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious' }));
        const challenge = vi.fn<NonNullable<CloudflareConfig['challenge']>>(async () => new Response('<html>captcha</html>', { status: 403 }));
        (config as any).challenge = challenge;
        return challenge;
    };

    it('calls RTI and sets x-cheq-rti-result on ALLOW even with a valid session, without validating it', async () => {
        // Arrange
        mocks.validateChallenge.mockResolvedValue(true);
        const request = buildWorkerRequest('/page', { cookies: '_cq_se=tok|ray', cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { forwarded, originFetch } = await run(request);

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(mocks.callRTI).toHaveBeenCalledOnce();
        expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=benign');
        expect(mocks.validateChallenge).not.toHaveBeenCalled();
    });

    it('waives the CAPTCHA for a valid session: forwards with the real verdict, challenge not called', async () => {
        // Arrange
        const challenge = captchaVerdict();
        mocks.validateChallenge.mockResolvedValue(true);
        const request = buildWorkerRequest('/page', { cookies: '_cq_se=tok|ray', cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { forwarded, originFetch } = await run(request);

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(mocks.callRTI).toHaveBeenCalledOnce();
        expect(challenge).not.toHaveBeenCalled();
        expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
        expect(mocks.validateChallenge.mock.calls[0][0]).toBe(forwarded); // the request sent on, not the incoming one
    });

    it('calls challenge and returns its result when the session is not valid', async () => {
        // Arrange
        const challenge = captchaVerdict();
        mocks.validateChallenge.mockResolvedValue(false);
        const request = buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { response, originFetch } = await run(request);

        // Assert
        expect(challenge).toHaveBeenCalledWith(
            expect.any(Request),
            expect.objectContaining({ decision: expect.objectContaining({ verdict: 'suspicious' }) }),
            expect.any(Function), // addRtiResultHeader
        );
        const challengeRequest = challenge.mock.calls[0][0] as Request;
        expect(challengeRequest.url).toBe(request.url);
        expect(challengeRequest.method).toBe('GET');
        expect(challengeRequest).not.toBe(request); // the cleaned copy, not the incoming request
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('gives config.challenge the cleaned copy: nothing the client sent as verdict or original Referer', async () => {
        // Arrange
        const challenge = captchaVerdict();

        // Act
        await run(buildWorkerRequest('/page', { cfRay: CF_RAY, extraHeaders: {
            'x-cheq-rti-result': 'version=4.1;verdict=benign', 'x-cheq-original-referer': 'https://evil.example/',
        } }));

        // Assert
        const challenged = challenge.mock.calls[0][0];
        expect(challenged.headers.get('x-cheq-rti-result')).toBeNull();
        expect(challenged.headers.get('x-cheq-original-referer')).toBeNull();
    });

    it('gives challenge an addRtiResultHeader that sets x-cheq-rti-result with the real verdict', async () => {
        // Arrange
        const challenge = captchaVerdict();
        mocks.validateChallenge.mockResolvedValue(false);
        await run(buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4' }));
        const addRtiResultHeader = challenge.mock.calls[0][2]!;
        const headers = new Headers({ location: 'https://example.com/' });

        // Act
        addRtiResultHeader(headers);

        // Assert
        expect(headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
        expect(headers.get('location')).toBe('https://example.com/');
    });

    it('forwards the Request that config.challenge returns', async () => {
        // Arrange
        captchaVerdict().mockResolvedValue(new Request('https://example.com/other') as any);

        // Act
        const { forwarded, originFetch } = await run(buildWorkerRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(forwarded!.url).toBe('https://example.com/other');
    });

    it.each([
        [Action.BLOCK, ActionStrategy.ACCESS_DENIED, 403],
        [Action.BLOCK, ActionStrategy.NOT_FOUND, 404],
        [Action.REDIRECT, ActionStrategy.REDIRECT, 302],
    ])('a valid session does not waive action %s / strategy %s (returns %s)', async (action, strategy, status) => {
        // Arrange
        (config as any).challenge = vi.fn();
        mocks.validateChallenge.mockResolvedValue(true);
        mocks.getAction.mockReturnValue(action);
        mocks.getActionStrategy.mockReturnValue(strategy);
        const request = buildWorkerRequest('/page', { cookies: '_cq_se=tok|ray', cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { response, originFetch } = await run(request);

        // Assert
        expect(response.status).toBe(status);
        expect(mocks.validateChallenge).not.toHaveBeenCalled();
        expect(originFetch).not.toHaveBeenCalled();
        expect(response.headers.get('x-cheq-rti-result')).toBeNull();
    });

    it('forwards with x-cheq-rti-result on CAPTCHA when no challenge is configured, without validating', async () => {
        // Arrange
        captchaVerdict();
        (config as any).challenge = undefined;
        const request = buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { forwarded, originFetch } = await run(request);

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
        expect(mocks.validateChallenge).not.toHaveBeenCalled();
    });

    it('calls validateChallenge with the request (with its _cq_se cookie) and isDebug=false', async () => {
        // Arrange
        captchaVerdict();
        mocks.validateChallenge.mockResolvedValue(false);
        const request = buildWorkerRequest('/page', { cookies: '_cq_se=sometoken|someray', cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        await run(request);

        // Assert
        expect(mocks.validateChallenge).toHaveBeenCalledWith(
            expect.any(Request),
            false // isDebug
        );
        const sessionRequest = mocks.validateChallenge.mock.calls[0][0] as Request;
        expect(sessionRequest.url).toBe(request.url);
        expect(sessionRequest.method).toBe('GET');
        expect(sessionRequest.headers.get('cookie')).toBe('_cq_se=sometoken|someray');
    });

    it('calls validateChallenge with isDebug=true when debug is enabled', async () => {
        // Arrange
        captchaVerdict();
        (config as any).debug = true;
        mocks.validateChallenge.mockResolvedValue(false);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const request = buildWorkerRequest('/page', { cookies: '_cq_se=sometoken|someray', cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        await run(request);

        // Assert
        expect(mocks.validateChallenge).toHaveBeenCalledWith(
            expect.any(Request),
            true // isDebug
        );
        const sessionRequest = mocks.validateChallenge.mock.calls[0][0] as Request;
        expect(sessionRequest.url).toBe(request.url);
        expect(sessionRequest.method).toBe('GET');
        consoleSpy.mockRestore();
    });

    it('logs the waived CAPTCHA when debug is enabled', async () => {
        // Arrange
        captchaVerdict();
        (config as any).debug = true;
        mocks.validateChallenge.mockResolvedValue(true);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        await run(buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4' }));

        // Assert
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('valid challenge session, waiving CAPTCHA'));
        consoleSpy.mockRestore();
    });

    // --- Methods: with a CAPTCHA verdict and no actionOnSuspicious setting, only a page load gets the CAPTCHA page ---

    it.each(['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('forwards a %s with a CAPTCHA verdict and its x-cheq-rti-result, without challenging it', async (method) => {
        // Arrange
        const challenge = captchaVerdict();
        const request = buildWorkerRequest('/login', { method, cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { forwarded, originFetch } = await run(request);

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(challenge).not.toHaveBeenCalled();
        expect(mocks.validateChallenge).not.toHaveBeenCalled();
        expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
    });

    it('still challenges a GET with a CAPTCHA verdict (without Sec-Fetch-Dest and Accept it counts as a page load)', async () => {
        // Arrange
        const challenge = captchaVerdict();
        const request = buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { response, originFetch } = await run(request);

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
    });

    it.each([
        [Action.BLOCK, ActionStrategy.ACCESS_DENIED, 403],
        [Action.BLOCK, ActionStrategy.NOT_FOUND, 404],
        [Action.REDIRECT, ActionStrategy.REDIRECT, 302],
    ])('still enforces action %s / strategy %s on a POST (returns %s)', async (action, strategy, status) => {
        // Arrange
        mocks.getAction.mockReturnValue(action);
        mocks.getActionStrategy.mockReturnValue(strategy);
        const request = buildWorkerRequest('/login', { method: 'POST', cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { response } = await run(request);

        // Assert
        expect(response.status).toBe(status);
    });

    describe('actionOnSuspicious: what a request with a body gets on a CAPTCHA verdict', () => {
        // The real mapping: CHALLENGE to the CAPTCHA, BLOCK to a 403, REDIRECT to a redirect.
        const realStrategies = () => mocks.getActionStrategy.mockImplementation((a: Action) =>
            a === Action.CHALLENGE ? ActionStrategy.CAPTCHA : a === Action.BLOCK ? ActionStrategy.ACCESS_DENIED : a === Action.REDIRECT ? ActionStrategy.REDIRECT : null);
        const post = (path = '/login', extraHeaders: Record<string, string> = {}) =>
            buildWorkerRequest(path, { querystring: 'step=2', method: 'POST', extraHeaders, cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        afterEach(() => {
            delete (config as any).actionOnSuspicious;
        });

        it('with no setting, a POST is forwarded with x-cheq-rti-result', async () => {
            const challenge = captchaVerdict();
            realStrategies();
            const { forwarded, originFetch } = await run(post());
            expect(originFetch).toHaveBeenCalledOnce();
            expect(challenge).not.toHaveBeenCalled();
            expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
        });

        it('BLOCK for the method gives the block page', async () => {
            captchaVerdict();
            realStrategies();
            (config as any).actionOnSuspicious = { methods: { POST: Action.BLOCK } };
            const { response } = await run(post());
            expect(response.status).toBe(403);
            expect(await response.text()).toBe('<html>blocked</html>'); // the block page, not the challenge's 403
        });

        it('REDIRECT for the method gives a 302 to redirectLocation', async () => {
            captchaVerdict();
            realStrategies();
            (config as any).actionOnSuspicious = { methods: { POST: Action.REDIRECT } };
            const { response } = await run(post());
            expect(response.status).toBe(302);
            expect(response.headers.get('location')).toBe('https://www.cheq.ai/');
        });

        it('a path rule wins over the method default', async () => {
            captchaVerdict();
            realStrategies();
            (config as any).actionOnSuspicious = { methods: { POST: Action.ALLOW }, rules: [{ path: '^/login$', methods: ['POST'], action: Action.BLOCK }] };
            expect((await run(post('/login'))).response.status).toBe(403);
            const other = await run(post('/search'));
            expect(other.originFetch).toHaveBeenCalledOnce();
        });

        it('CHALLENGE builds the CAPTCHA page for the Referer page, as a GET without the body', async () => {
            const challenge = captchaVerdict();
            realStrategies();
            (config as any).actionOnSuspicious = { methods: { POST: Action.CHALLENGE } };
            const request = new Request(post('/api/login', {
                Referer: 'https://example.com/account/login?next=%2Fcart',
                'x-cheq-rti-result': 'version=4.1;verdict=benign', 'x-cheq-original-referer': 'https://evil.example/',
            }), { body: 'password=x' });
            // Read while the session is checked: once the Worker has answered, the body is read to the end and gone.
            let sessionBody: string | undefined;
            mocks.validateChallenge.mockImplementation(async (sessionRequest: Request) => {
                sessionBody = await sessionRequest.clone().text();
                return false;
            });

            const { response, originFetch } = await run(request);

            expect(response.status).toBe(403);
            expect(await response.text()).toBe('<html>captcha</html>');
            expect(originFetch).not.toHaveBeenCalled();
            const pageRequest = challenge.mock.calls[0][0];
            expect(pageRequest.method).toBe('GET');
            expect(pageRequest.url).toBe('https://example.com/account/login?next=%2Fcart');
            expect(pageRequest.body).toBeNull();
            expect(pageRequest.headers.get('referer')).toBe('https://example.com/account/login?next=%2Fcart');
            // Built from the cleaned copy: nothing the client sent as verdict or original Referer
            expect(pageRequest.headers.get('x-cheq-rti-result')).toBeNull();
            expect(pageRequest.headers.get('x-cheq-original-referer')).toBeNull();
            // The real request is not changed: it is still the one checked for a session, with its body
            const sessionRequest = mocks.validateChallenge.mock.calls[0][0] as Request;
            expect(sessionRequest.method).toBe('POST');
            expect(sessionRequest.url).toBe('https://example.com/api/login?step=2');
            expect(sessionBody).toBe('password=x');
        });

        it('CHALLENGE builds the page request with the redirect mode of the POST', async () => {
            const challenge = captchaVerdict();
            realStrategies();
            (config as any).actionOnSuspicious = { methods: { POST: Action.CHALLENGE } };
            await run(new Request(post(), { redirect: 'manual' }));
            expect(challenge.mock.calls[0][0].redirect).toBe('manual');
        });

        it.each([
            ['no Referer', {}],
            ['a Referer from another site', { Referer: 'https://evil.example/form' }],
            ['a Referer that is not a URL', { Referer: 'not a url' }],
        ])('CHALLENGE with %s builds the page for the site\'s home page', async (_label, headers) => {
            const challenge = captchaVerdict();
            realStrategies();
            (config as any).actionOnSuspicious = { methods: { POST: Action.CHALLENGE } };
            await run(post('/api/login', headers));
            const pageRequest = challenge.mock.calls[0][0];
            expect(pageRequest.method).toBe('GET');
            expect(pageRequest.url).toBe('https://example.com/');
        });

        it('CHALLENGE keeps the page on this site when the Referer path starts with //', async () => {
            const challenge = captchaVerdict();
            realStrategies();
            (config as any).actionOnSuspicious = { methods: { POST: Action.CHALLENGE } };
            await run(buildWorkerRequest('/api/login', {
                method: 'POST', cfRay: CF_RAY, extraHeaders: { referer: 'https://example.com//evil.example/form?x=1' },
            }));
            const page = new URL(challenge.mock.calls[0][0].url);
            expect(page.host).toBe('example.com');
            expect(page.pathname).toBe('//evil.example/form');
            expect(page.search).toBe('?x=1');
        });

        it.each([
            ['on the URL\'s host gives the Referer page', 'https://example.com/account/login?x=1', 'https://example.com/account/login?x=1'],
            ['on the Host header\'s host gives the home page', 'https://other.example/account/login?x=1', 'https://example.com/'],
        ])('CHALLENGE takes the site\'s host from the request URL, not from a Host header that names another host: a Referer %s', async (_label, referer, pageUrl) => {
            const challenge = captchaVerdict();
            realStrategies();
            (config as any).actionOnSuspicious = { methods: { POST: Action.CHALLENGE } };
            await run(post('/api/login', { host: 'other.example', Referer: referer }));
            expect(challenge.mock.calls[0][0].url).toBe(pageUrl);
        });

        it('CHALLENGE with a valid session gives no CAPTCHA and forwards the real POST', async () => {
            const challenge = captchaVerdict();
            realStrategies();
            mocks.validateChallenge.mockResolvedValue(true);
            (config as any).actionOnSuspicious = { methods: { POST: Action.CHALLENGE } };
            const request = post();
            const { forwarded, originFetch } = await run(request);
            expect(originFetch).toHaveBeenCalledOnce();
            expect(challenge).not.toHaveBeenCalled();
            expect(mocks.validateChallenge.mock.calls[0][0].method).toBe('POST');
            expect(forwarded!.method).toBe('POST');
            expect(forwarded!.url).toBe(request.url);
        });

        it.each([
            ['CHALLENGE (1)', Action.CHALLENGE, 'CAPTCHA (3)'],
            ['BLOCK (2)', Action.BLOCK, 'ACCESS_DENIED (0)'],
            ['REDIRECT (3)', Action.REDIRECT, 'REDIRECT (2)'],
            ['ALLOW (0)', Action.ALLOW, 'none (null)'],
        ])('debug logs the strategy, what actionOnSuspicious says, the method and whether it is a page load in one line: %s', async (logged, action, strategy) => {
            captchaVerdict();
            realStrategies();
            (config as any).debug = true;
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});
            (config as any).actionOnSuspicious = { methods: { POST: action } };
            await run(post());
            expect(log).toHaveBeenCalledWith(`action strategy: ${strategy}, actionOnSuspicious: ${logged}, method: POST, pageLoad: false`);
            expect(log.mock.calls.filter(([line]) => String(line).includes('action strategy:'))).toHaveLength(1);
            (config as any).debug = false;
        });

        it('debug logs the same line for a GET (without Sec-Fetch-Dest and Accept: a page load)', async () => {
            captchaVerdict();
            realStrategies();
            (config as any).debug = true;
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});
            await run(buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4' }));
            expect(log).toHaveBeenCalledWith('action strategy: CAPTCHA (3), actionOnSuspicious: none (undefined), method: GET, pageLoad: true');
            (config as any).debug = false;
        });

        it('debug logs no strategy line when RTI allows the request', async () => {
            realStrategies();
            mocks.getAction.mockReturnValue(Action.ALLOW);
            (config as any).debug = true;
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});
            await run(post());
            expect(log).not.toHaveBeenCalledWith(expect.stringContaining('action strategy:'));
            expect(log).not.toHaveBeenCalledWith(expect.stringContaining('actionOnSuspicious'));
            (config as any).debug = false;
        });

        it('GET still gets the CAPTCHA for its own URL', async () => {
            const challenge = captchaVerdict();
            realStrategies();
            (config as any).actionOnSuspicious = { methods: { POST: Action.ALLOW }, rules: [{ path: '.*', action: Action.ALLOW }] };
            const request = buildWorkerRequest('/page', { querystring: 'a=1', extraHeaders: { Referer: 'https://example.com/other' }, cfRay: CF_RAY, xRealIp: '1.2.3.4' });
            await run(request);
            expect(challenge.mock.calls[0][0].url).toBe('https://example.com/page?a=1');
        });
    });

    // --- Which request gets a page (README, "Which request gets a page"). On a CAPTCHA verdict: a rule of
    // actionOnSuspicious that covers the method decides first, then a page load gets the page, then the method's default ---

    describe('which request gets a page on a CAPTCHA verdict', () => {
        // getActionStrategy as core maps an Action with this blockingStrategy (challengingStrategy left at CAPTCHA).
        const strategies = (blockingStrategy = ActionStrategy.ACCESS_DENIED) => mocks.getActionStrategy.mockImplementation((a: Action) =>
            a === Action.CHALLENGE ? ActionStrategy.CAPTCHA : a === Action.BLOCK ? blockingStrategy : a === Action.REDIRECT ? ActionStrategy.REDIRECT : null);
        // Each request names another page of the site as its Referer: a page built for the Referer would show in the URL
        // that config.challenge gets.
        const request = (method: string, headers: Record<string, string>, path = '/page', cookies?: string) =>
            buildWorkerRequest(path, { method, cookies, extraHeaders: { referer: 'https://example.com/other', ...headers }, cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Forwarded: no page, and the origin gets the request with the verdict. The handler fails open: an exception (a
        // member missing from the mock, say) forwards the request too, but without the verdict and with an error logged.
        // So the verdict header and the empty error logs are checked as well.
        const expectForwarded = (result: Awaited<ReturnType<typeof run>>, challenge: ReturnType<typeof captchaVerdict>) => {
            expect(challenge).not.toHaveBeenCalled();
            expect(result.originFetch).toHaveBeenCalledOnce();
            expect(result.forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
            expect(consoleErrorSpy).not.toHaveBeenCalled();
            expect(mocks.loggerError).not.toHaveBeenCalled();
        };

        // The challenge page for this request itself: config.challenge gets the request sent on (its URL, method and
        // headers, not a GET for its Referer), and its answer goes to the visitor.
        const expectPageFor = async (result: Awaited<ReturnType<typeof run>>, challenge: ReturnType<typeof captchaVerdict>, sent: Request) => {
            expect(challenge).toHaveBeenCalledOnce();
            const challenged = challenge.mock.calls[0][0];
            expect(challenged.url).toBe(sent.url);
            expect(challenged.method).toBe(sent.method);
            expect(challenged.headers.get('sec-fetch-dest')).toBe(sent.headers.get('sec-fetch-dest'));
            expect(challenged.headers.get('accept')).toBe(sent.headers.get('accept'));
            expect(result.response.status).toBe(403);
            expect(await result.response.text()).toBe('<html>captcha</html>');
            expect(result.originFetch).not.toHaveBeenCalled();
        };

        it.each([
            ['1', 'Sec-Fetch-Dest: document', { 'sec-fetch-dest': 'document' }],
            ['4', 'no Sec-Fetch-Dest and Accept: text/html,*/*;q=0.8', { accept: 'text/html,*/*;q=0.8' }],
            ['5', 'neither Sec-Fetch-Dest nor Accept', {}],
        ])('row %s: a GET with %s is a page load: config.challenge gets this request, and its page is the answer', async (_row, _label, headers) => {
            // Arrange
            const challenge = captchaVerdict();
            const sent = request('GET', headers);

            // Act
            const result = await run(sent);

            // Assert
            await expectPageFor(result, challenge, sent);
        });

        it.each([
            ['2', 'GET', 'Sec-Fetch-Dest: empty and Accept: text/html', { 'sec-fetch-dest': 'empty', accept: 'text/html' }],
            ['3', 'GET', 'no Sec-Fetch-Dest and Accept: */*', { accept: '*/*' }],
            ['8', 'HEAD', 'Sec-Fetch-Dest: document', { 'sec-fetch-dest': 'document' }],
        ])('row %s: a %s with %s is not a page load: forwarded with the verdict, no page', async (_row, method, _label, headers) => {
            // Arrange
            const challenge = captchaVerdict();

            // Act
            const result = await run(request(method, headers));

            // Assert
            expectForwarded(result, challenge);
        });

        it('a GET with Sec-Fetch-Dest: document sent twice is not a page load: Headers.get joins the values, so it reads "document, document" and is forwarded with the verdict', async () => {
            // Arrange
            const challenge = captchaVerdict();
            const headers = new Headers({ host: 'example.com', 'user-agent': 'Mozilla/5.0', 'cf-ray': CF_RAY, 'x-real-ip': '1.2.3.4' });
            headers.append('sec-fetch-dest', 'document');
            headers.append('sec-fetch-dest', 'document');

            // Act
            const result = await run(new Request(`${BASE_URL}/page`, { headers }));

            // Assert
            expectForwarded(result, challenge);
            expect(result.forwarded!.headers.get('sec-fetch-dest')).toBe('document, document');
        });

        it.each([
            ['9', 'empty'],
            ['10', 'document'],
        ])('row %s: a rule that names GET is asked first: GET /api/x with Sec-Fetch-Dest: %s gets the 403 block page of the rule', async (_row, dest) => {
            // Arrange
            const challenge = captchaVerdict();
            strategies();
            (config as any).actionOnSuspicious = { rules: [{ path: '^/api/', methods: ['GET'], action: Action.BLOCK }] };

            // Act
            const { response, originFetch } = await run(request('GET', { 'sec-fetch-dest': dest }, '/api/x'));

            // Assert
            expect(response.status).toBe(403);
            expect(await response.text()).toBe('<html>blocked</html>'); // the block page, not the challenge's 403
            expect(challenge).not.toHaveBeenCalled();
            expect(originFetch).not.toHaveBeenCalled();
        });

        it.each([
            ['11', 'GET', { 'sec-fetch-dest': 'empty' }],
            ['12', 'HEAD', {}],
        ])('row %s: with methods { %s: Action.CHALLENGE } a request that is not a page load gets the challenge page for itself', async (_row, method, headers) => {
            // Arrange
            const challenge = captchaVerdict();
            strategies();
            (config as any).actionOnSuspicious = { methods: { [method]: Action.CHALLENGE } };
            const sent = request(method, headers);

            // Act
            const result = await run(sent);

            // Assert
            await expectPageFor(result, challenge, sent);
        });

        it('row 13: with methods { GET: Action.REDIRECT } a GET that is not a page load gets the 302 to redirectLocation', async () => {
            // Arrange
            const challenge = captchaVerdict();
            strategies();
            (config as any).redirectLocation = 'https://example.com/suspicious';
            (config as any).actionOnSuspicious = { methods: { GET: Action.REDIRECT } };

            // Act
            const { response, originFetch } = await run(request('GET', { 'sec-fetch-dest': 'empty' }));

            // Assert
            expect(response.status).toBe(302);
            expect(response.headers.get('location')).toBe('https://example.com/suspicious');
            expect(challenge).not.toHaveBeenCalled();
            expect(originFetch).not.toHaveBeenCalled();
        });

        it('row 14: a block verdict shown as a CAPTCHA (blockingStrategy: CAPTCHA) still gets the challenge page for a GET that is not a page load: methods { GET: Action.ALLOW } is not used', async () => {
            // Arrange
            const challenge = captchaVerdict();
            mocks.getAction.mockReturnValue(Action.BLOCK);
            strategies(ActionStrategy.CAPTCHA);
            (config as any).actionOnSuspicious = { methods: { GET: Action.ALLOW } };
            const sent = request('GET', { 'sec-fetch-dest': 'empty' });

            // Act
            const result = await run(sent);

            // Assert
            await expectPageFor(result, challenge, sent);
        });

        it('row 15: a GET that is not a page load is forwarded with the verdict, and a valid session is not checked', async () => {
            // Arrange
            const challenge = captchaVerdict();
            mocks.validateChallenge.mockResolvedValue(true);

            // Act
            const result = await run(request('GET', { 'sec-fetch-dest': 'empty' }, '/page', '_cq_se=tok|ray'));

            // Assert
            expectForwarded(result, challenge);
            expect(mocks.validateChallenge).not.toHaveBeenCalled();
        });

        it('row 16: a page load with a valid session is forwarded with the verdict: the session waives the CAPTCHA, as before', async () => {
            // Arrange
            const challenge = captchaVerdict();
            mocks.validateChallenge.mockResolvedValue(true);

            // Act
            const result = await run(request('GET', { 'sec-fetch-dest': 'document' }, '/page', '_cq_se=tok|ray'));

            // Assert
            expectForwarded(result, challenge);
            expect(mocks.validateChallenge).toHaveBeenCalledOnce();
            expect(mocks.validateChallenge.mock.calls[0][0]).toBe(result.forwarded); // the request sent on
        });

        it('row 17: a reply to the challenge page that is not a page load still goes to config.challenge, as before', async () => {
            // Arrange
            (config as any).mode = Mode.BLOCKING;
            const challenge = captchaVerdict();
            const reply = buildWorkerRequest('/landing', {
                querystring: 'cf-turnstile-response=tok', extraHeaders: { 'sec-fetch-dest': 'empty' }, cfRay: CF_RAY, xRealIp: '1.2.3.4',
            });

            // Act
            const { response, originFetch } = await run(reply);

            // Assert
            expect(challenge).toHaveBeenCalledOnce();
            expect(challenge.mock.calls[0][0].url).toBe(reply.url);
            expect(response.status).toBe(403);
            expect(await response.text()).toBe('<html>captcha</html>');
            expect(originFetch).not.toHaveBeenCalled();
            expect(mocks.validateChallenge).not.toHaveBeenCalled();
        });

        it.each([
            ['1', { 'sec-fetch-dest': 'document' }, 'action strategy: CAPTCHA (3), actionOnSuspicious: none (undefined), method: GET, pageLoad: true'],
            ['2', { 'sec-fetch-dest': 'empty', accept: 'text/html' }, 'action strategy: none (null), actionOnSuspicious: ALLOW (0), method: GET, pageLoad: false'],
        ])('row 18: with debug on, the strategy line of row %s ends with whether it is a page load', async (_row, headers, line) => {
            // Arrange
            captchaVerdict();
            (config as any).debug = true;
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Act
            await run(request('GET', headers));

            // Assert
            const strategyLines = log.mock.calls.map(([text]) => String(text)).filter((text) => text.startsWith('action strategy:'));
            expect(strategyLines).toEqual([line]);
        });

        // --- A prefetch (README, "Which request gets a page"; the owner's decision of 2026-11-23). Where a visit would get
        // the challenge page, a request whose Sec-Purpose or Purpose contains "prefetch" gets an empty 403 ---

        describe('a prefetch on a CAPTCHA verdict', () => {
            // An empty 403: status 403, no body, and the headers of our redirect without Location (the request ids and
            // no-store). config.challenge is not called, the origin is not called, and nothing is logged as an error.
            const expectEmpty403 = async (result: Awaited<ReturnType<typeof run>>, challenge: ReturnType<typeof captchaVerdict>) => {
                expect(result.response.status).toBe(403);
                expect(await result.response.text()).toBe('');
                expect(result.response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
                expect(result.response.headers.get('x-cheq-cdn-request-id')).toBe(CF_RAY);
                expect(result.response.headers.get('x-cheq-id')).toBe('ray-123');
                expect(result.response.headers.get('x-cheq-page-view-id')).toBe('');
                expect(result.response.headers.get('location')).toBeNull();
                expect(challenge).not.toHaveBeenCalled();
                expect(result.originFetch).not.toHaveBeenCalled();
                expect(consoleErrorSpy).not.toHaveBeenCalled();
                expect(mocks.loggerError).not.toHaveBeenCalled();
            };
            const prefetchOfAPage = { 'sec-fetch-dest': 'document', 'sec-purpose': 'prefetch' };

            it.each([
                ['P1', 'Sec-Fetch-Dest: document and Sec-Purpose: prefetch', prefetchOfAPage],
                ['P2', 'Sec-Fetch-Dest: document and Sec-Purpose: prefetch;prerender', { 'sec-fetch-dest': 'document', 'sec-purpose': 'prefetch;prerender' }],
                ['P3', 'no Sec-Fetch-Dest, Accept: text/html and Purpose: prefetch', { accept: 'text/html', purpose: 'prefetch' }],
            ])('%s: a GET with %s is a prefetch of a page: an empty 403 in place of the challenge page', async (_row, _label, headers) => {
                // Arrange: debug is off
                const challenge = captchaVerdict();
                const log = vi.spyOn(console, 'log').mockImplementation(() => {});

                // Act
                const result = await run(request('GET', headers));

                // Assert
                await expectEmpty403(result, challenge);
                expect(log).not.toHaveBeenCalledWith('prefetch: an empty 403 in place of the challenge page');
            });

            it('P4: a GET with Sec-Fetch-Dest: empty and Sec-Purpose: prefetch is not a page load: forwarded with the verdict (the GET default is ALLOW)', async () => {
                // Arrange
                const challenge = captchaVerdict();

                // Act
                const result = await run(request('GET', { 'sec-fetch-dest': 'empty', 'sec-purpose': 'prefetch' }));

                // Assert
                expectForwarded(result, challenge);
            });

            it('P5: with methods { GET: Action.CHALLENGE } the prefetch of P4 gets an empty 403', async () => {
                // Arrange
                const challenge = captchaVerdict();
                strategies();
                (config as any).actionOnSuspicious = { methods: { GET: Action.CHALLENGE } };

                // Act
                const result = await run(request('GET', { 'sec-fetch-dest': 'empty', 'sec-purpose': 'prefetch' }));

                // Assert
                await expectEmpty403(result, challenge);
            });

            it('P6: the prefetch of P1 from a visitor with a valid session is forwarded with the verdict: the session is checked first', async () => {
                // Arrange
                const challenge = captchaVerdict();
                mocks.validateChallenge.mockResolvedValue(true);

                // Act
                const result = await run(request('GET', prefetchOfAPage, '/page', '_cq_se=tok|ray'));

                // Assert
                expectForwarded(result, challenge);
                expect(mocks.validateChallenge).toHaveBeenCalledOnce();
            });

            it('P7: the prefetch of P1 without a config.challenge is forwarded with the verdict', async () => {
                // Arrange
                const challenge = captchaVerdict();
                (config as any).challenge = undefined;

                // Act
                const result = await run(request('GET', prefetchOfAPage));

                // Assert
                expectForwarded(result, challenge);
            });

            it('P8: the prefetch of P1 with a block verdict shown as a CAPTCHA (blockingStrategy: CAPTCHA) gets an empty 403', async () => {
                // Arrange
                const challenge = captchaVerdict();
                mocks.getAction.mockReturnValue(Action.BLOCK);
                strategies(ActionStrategy.CAPTCHA);

                // Act
                const result = await run(request('GET', prefetchOfAPage));

                // Assert
                await expectEmpty403(result, challenge);
            });

            it('P9: the prefetch of P1 on a path that a GET rule with Action.ALLOW covers is forwarded with the verdict (the rule is asked first)', async () => {
                // Arrange
                const challenge = captchaVerdict();
                strategies();
                (config as any).actionOnSuspicious = { rules: [{ path: '^/page$', methods: ['GET'], action: Action.ALLOW }] };

                // Act
                const result = await run(request('GET', prefetchOfAPage));

                // Assert
                expectForwarded(result, challenge);
            });

            it('P10: a GET with Sec-Fetch-Dest: document and no prefetch header still gets the challenge page', async () => {
                // Arrange
                const challenge = captchaVerdict();
                const sent = request('GET', { 'sec-fetch-dest': 'document' });

                // Act
                const result = await run(sent);

                // Assert
                await expectPageFor(result, challenge, sent);
            });

            it('P11: with debug on, the prefetch of P1 logs the empty 403, and its strategy line ends with pageLoad: true', async () => {
                // Arrange
                const challenge = captchaVerdict();
                (config as any).debug = true;
                const log = vi.spyOn(console, 'log').mockImplementation(() => {});

                // Act
                const result = await run(request('GET', prefetchOfAPage));

                // Assert
                await expectEmpty403(result, challenge);
                const lines = log.mock.calls.map(([text]) => String(text));
                expect(lines).toContain('prefetch: an empty 403 in place of the challenge page');
                expect(lines.filter((text) => text.startsWith('action strategy:'))).toEqual([
                    'action strategy: CAPTCHA (3), actionOnSuspicious: none (undefined), method: GET, pageLoad: true',
                ]);
            });

            it('a POST that a rule challenges and that carries Sec-Purpose: prefetch (a browser does not send such a request) gets the empty 403 too, by the same check, and its body is read in the background', async () => {
                // Arrange
                const challenge = captchaVerdict();
                strategies();
                (config as any).actionOnSuspicious = { rules: [{ path: '^/login$', methods: ['POST'], action: Action.CHALLENGE }] };
                const sent = new Request(request('POST', { 'sec-purpose': 'prefetch' }, '/login'), { body: 'user=a&pass=b' });

                // Act
                const result = await run(sent);

                // Assert: our own answer, so fetch reads the body that nobody sent on to the end, as for the other answers
                await expectEmpty403(result, challenge);
                expect(result.ctx.waitUntil).toHaveBeenCalledOnce();
                const [bodyRead] = vi.mocked(result.ctx.waitUntil).mock.calls[0];
                await expect(bodyRead).resolves.toBeUndefined();
            });
        });
    });

    // --- Error logging ---

    it('passes through without header, logs to console.error and logger when validateChallenge throws', async () => {
        // Arrange
        expectError = true;
        const challenge = captchaVerdict();
        (config as any).validateChallenge = vi.fn().mockRejectedValue(new Error('validate crash'));
        const request = buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { forwarded, originFetch, ctx } = await run(request);

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(challenge).not.toHaveBeenCalled();
        expect(forwarded!.headers.get('x-cheq-rti-result')).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(`Challenge error handling request '${CF_RAY}'`), expect.objectContaining({ message: 'validate crash' }));
        expect(ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('validate crash'));
    });

    it('logs to console.error and logger when challenge throws', async () => {
        // Arrange
        expectError = true;
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        (config as any).challenge = vi.fn().mockRejectedValue(new Error('challenge crash'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const ctx = buildContext();

        // Act
        const result = await worker.fetch(buildWorkerRequest('/page', { cfRay: CF_RAY }), {}, ctx);

        // Assert
        expect(result.status).toBe(200);
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(`Challenge error handling request '${CF_RAY}'`), expect.objectContaining({ message: 'challenge crash' }));
        expect(ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('challenge crash'));
    });

    it('passes through and logs error when RTI call throws', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        const { originFetch } = await run(buildWorkerRequest('/page', { cfRay: CF_RAY }));

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(mocks.loggerError).toHaveBeenCalled();
    });

    it('logs error to logger by default when logErrors is not set', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        await run(buildWorkerRequest('/page', { cfRay: CF_RAY }));

        // Assert
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('RTI timeout'));
    });

    it('does not log error to logger but still logs to console.error when logErrors is false', async () => {
        // Arrange
        expectError = true;
        (config as any).logErrors = false;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        const { originFetch } = await run(buildWorkerRequest('/page', { cfRay: CF_RAY }));

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(mocks.loggerError).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(CF_RAY), expect.objectContaining({ message: 'RTI timeout' }));
    });

    it('does not log challenge error to logger when logErrors is false', async () => {
        // Arrange
        expectError = true;
        (config as any).logErrors = false;
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        (config as any).challenge = vi.fn().mockRejectedValue(new Error('challenge crash'));

        // Act
        const { originFetch } = await run(buildWorkerRequest('/page', { cfRay: CF_RAY }));

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(mocks.loggerError).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(CF_RAY), expect.objectContaining({ message: 'challenge crash' }));
    });

    it('uses "unknown_request_id" in the error log when cf-ray is absent', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        await run(buildWorkerRequest());

        // Assert
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('unknown_request_id'));
    });

    it('hands the error log to waitUntil and does not wait for it', async () => {
        // Arrange
        expectError = true;
        const neverSettles = new Promise<void>(() => {});
        mocks.loggerError.mockReturnValueOnce(neverSettles);
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        const { ctx, originFetch } = await run(buildWorkerRequest());

        // Assert: toContain compares with ===, where toHaveBeenCalledWith would accept any promise (they are deeply equal)
        expect(vi.mocked(ctx.waitUntil).mock.calls.map(([promise]) => promise)).toContain(neverSettles);
        expect(originFetch).toHaveBeenCalledOnce();
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

    it.each(nonErrors)('forwards a CAPTCHA request when config.challenge rejects with %s', async (_, value, logged) => {
        // Arrange
        expectError = true;
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        (config as any).challenge = vi.fn().mockImplementation(() => Promise.reject(value()));

        // Act
        const { originFetch } = await run(buildWorkerRequest('/page', { cfRay: CF_RAY }));

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(mocks.loggerError).toHaveBeenCalledWith(`Challenge error handling request '${CF_RAY}': ${logged}`);
    });

    it.each(nonErrors)('forwards the request when RTI rejects with %s', async (_, value, logged) => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockImplementation(() => Promise.reject(value()));

        // Act
        const { originFetch } = await run(buildWorkerRequest('/page', { cfRay: CF_RAY }));

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(mocks.loggerError).toHaveBeenCalledWith(`Error handling request '${CF_RAY}': ${logged}`);
    });

    // --- Challenge reply: the solved form always goes to config.challenge (BLOCKING only), blocks still win ---

    const replyQuery = new URLSearchParams({ original_url: '/landing?gclid=abc', request_id: 'ray-page', 'cf-turnstile-response': 'tok' }).toString();
    const replyRequest = (cookies = '') => buildWorkerRequest('/landing', { querystring: replyQuery, cookies, cfRay: CF_RAY, xRealIp: '1.2.3.4' });
    const replyChallenge = () => {
        (config as any).mode = Mode.BLOCKING;
        const challenge = vi.fn<NonNullable<CloudflareConfig['challenge']>>(async () => new Response(null, { status: 302 }));
        (config as any).challenge = challenge;
        return challenge;
    };

    // What config.challenge gets for a reply when RTI fails. Not an RTI answer: only the cf-ray value, as rayId (it signs
    // the example's session) and as customParam2 (as customId2 in the normal RTI payload). No verdict, classification or other ids.
    const standIn = {
        ids: {
            rayId: CF_RAY, customParam2: CF_RAY,
            pageViewId: null, duid: null, uniqueVisitId: null, customParam1: null, customParam3: null, customParam4: null,
        },
    };

    // --- config.isChallengeResponse: recognizes a reply; customer code, so it may be missing, wrong or throw ---

    it('recognizes a reply with config.isChallengeResponse, called with the request', async () => {
        // Arrange: a CAPTCHA with its own token field
        const challenge = replyChallenge();
        const detector = vi.fn((request: Request) => new URL(request.url).searchParams.has('my-captcha-token'));
        (config as any).isChallengeResponse = detector;
        const request = buildWorkerRequest('/landing', { querystring: 'my-captcha-token=abc', cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { response, originFetch } = await run(request);

        // Assert
        expect(response.status).toBe(302);
        expect(originFetch).not.toHaveBeenCalled();
        expect(detector).toHaveBeenCalledOnce();
        const detected = detector.mock.calls[0][0];
        expect(detected.url).toBe(request.url);
        expect(detected.method).toBe('GET');
        expect(challenge).toHaveBeenCalledOnce();
        expect(challenge.mock.calls[0][0]).toBe(detected);
    });

    it('does not treat a Turnstile-shaped query as a reply when the configured detector says no', async () => {
        // Arrange
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = vi.fn().mockReturnValue(false);

        // Act
        const { originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(challenge).not.toHaveBeenCalled();
    });

    it('forwards a reply unchanged when config.isChallengeResponse is not set', async () => {
        // Arrange
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = undefined;

        // Act
        const { forwarded, originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(new URL(forwarded!.url).search).toBe('?' + replyQuery);
        expect(challenge).not.toHaveBeenCalled();
    });

    it.each<[string, () => unknown]>([
        ['false', () => false],
        ['undefined', () => undefined],
        ['a truthy string', () => 'yes'],
        ['1', () => 1],
        ['a Promise of true (an async detector)', () => Promise.resolve(true)],
    ])('treats a request as a reply only when config.isChallengeResponse returns true, not %s', async (_, value) => {
        // Arrange
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = vi.fn().mockImplementation(value);

        // Act
        const { forwarded, originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=benign');
        expect(challenge).not.toHaveBeenCalled();
    });

    it.each<[string, () => unknown, string]>([
        ['an Error', () => new Error('detector failed'), 'detector failed'],
        ['undefined', () => undefined, 'undefined'],
    ])('treats the request as no reply and logs it when config.isChallengeResponse throws %s', async (_, value, logged) => {
        // Arrange
        expectError = true;
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = vi.fn().mockImplementation(() => { throw value(); });

        // Act
        const { forwarded, originFetch } = await run(replyRequest());

        // Assert: forwarded as RTI decided (ALLOW, with the verdict header), challenge not called
        expect(originFetch).toHaveBeenCalledOnce();
        expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=benign');
        expect(challenge).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Challenge reply check error handling request 'ray-abc-123'"), value());
        expect(mocks.loggerError).toHaveBeenCalledWith(`Challenge reply check error handling request 'ray-abc-123': ${logged}`);
    });

    it('still challenges a CAPTCHA request when config.isChallengeResponse throws', async () => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        const challenge = captchaVerdict();
        (config as any).isChallengeResponse = vi.fn().mockImplementation(() => { throw new Error('detector failed'); });

        // Act
        const { response, originFetch } = await run(buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4' }));

        // Assert: the usual CAPTCHA path, as if it were no reply
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
        expect(challenge).toHaveBeenCalledOnce();
    });

    it('forwards a reply when RTI fails and config.isChallengeResponse throws too', async () => {
        // Arrange
        expectError = true;
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = vi.fn().mockImplementation(() => { throw undefined; });
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        const { originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(challenge).not.toHaveBeenCalled();
        expect(mocks.loggerError).toHaveBeenCalledWith("Challenge reply check error handling request 'ray-abc-123': undefined");
    });

    it('does not call config.isChallengeResponse for a request that is blocked anyway', async () => {
        // Arrange
        replyChallenge();
        const detector = vi.fn().mockReturnValue(true);
        (config as any).isChallengeResponse = detector;
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);

        // Act
        const { response } = await run(replyRequest());

        // Assert
        expect(response.status).toBe(403);
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
        await run(replyRequest());

        // Assert
        expect(detector).not.toHaveBeenCalled();
    });

    it('sends a reply that RTI allows to config.challenge instead of forwarding it', async () => {
        // Arrange
        const challenge = replyChallenge();
        const request = replyRequest();

        // Act
        const { response, originFetch } = await run(request);

        // Assert
        expect(response.status).toBe(302);
        expect(originFetch).not.toHaveBeenCalled();
        expect(challenge).toHaveBeenCalledWith(
            expect.any(Request),
            expect.objectContaining({ decision: expect.objectContaining({ verdict: 'benign' }) }),
            expect.any(Function), // addRtiResultHeader
        );
        const replied = challenge.mock.calls[0][0];
        expect(replied.url).toBe(request.url);
        expect(replied.method).toBe('GET');
        expect(replied.headers.get('x-cheq-rti-result')).toBeNull();
    });

    it('forwards the Request that config.challenge returns for a reply, as returned', async () => {
        // Arrange
        const returned = new Request('https://example.com/other');
        replyChallenge().mockResolvedValue(returned);

        // Act
        const { forwarded, originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(forwarded).toBe(returned);
    });

    it('passes an addRtiResultHeader that sets the verdict of the reply', async () => {
        // Arrange
        const challenge = replyChallenge();

        // Act
        await run(replyRequest());
        const headers = new Headers();
        challenge.mock.calls[0][2]!(headers);

        // Assert
        expect(headers.get('x-cheq-rti-result')).toContain('verdict=benign');
    });

    it('sends a CAPTCHA reply to config.challenge even with a valid session (checked before the session waiver)', async () => {
        // Arrange
        (config as any).mode = Mode.BLOCKING;
        const challenge = captchaVerdict();
        mocks.validateChallenge.mockResolvedValue(true);

        // Act
        const { response, originFetch } = await run(replyRequest('_cq_se=tok|ray'));

        // Assert
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
        expect(challenge).toHaveBeenCalledOnce();
        expect(mocks.validateChallenge).not.toHaveBeenCalled();
    });

    it.each([
        [Action.BLOCK, ActionStrategy.ACCESS_DENIED, 403],
        [Action.BLOCK, ActionStrategy.NOT_FOUND, 404],
        [Action.REDIRECT, ActionStrategy.REDIRECT, 302],
        [Action.CHALLENGE, ActionStrategy.ACCESS_DENIED, 403],
    ])('still blocks a reply for action %s / strategy %s (returns %s)', async (action, strategy, status) => {
        // Arrange
        const challenge = replyChallenge();
        mocks.getAction.mockReturnValue(action);
        mocks.getActionStrategy.mockReturnValue(strategy);

        // Act
        const { response, originFetch } = await run(replyRequest());

        // Assert
        expect(response.status).toBe(status);
        expect(originFetch).not.toHaveBeenCalled();
        expect(challenge).not.toHaveBeenCalled();
    });

    it('blocks a reply that RTI wants challenged on a path whose GET rule says BLOCK: the rule decides before the reply is answered', async () => {
        // Arrange: the reply is a GET to the page that showed the CAPTCHA (README, the rules of "actionOnSuspicious")
        const challenge = replyChallenge();
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockImplementation((a: Action) =>
            a === Action.CHALLENGE ? ActionStrategy.CAPTCHA : a === Action.BLOCK ? ActionStrategy.ACCESS_DENIED : null);
        (config as any).actionOnSuspicious = { rules: [{ path: '^/landing$', methods: ['GET'], action: Action.BLOCK }] };

        // Act
        const { response, originFetch } = await run(replyRequest());

        // Assert
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('<html>blocked</html>'); // the block page, not the challenge's answer
        expect(challenge).not.toHaveBeenCalled();
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('forwards a reply unchanged in MONITORING mode', async () => {
        // Arrange
        const challenge = replyChallenge();
        (config as any).mode = Mode.MONITORING;

        // Act
        const { forwarded, originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(new URL(forwarded!.url).search).toBe('?' + replyQuery);
        expect(challenge).not.toHaveBeenCalled();
    });

    it('forwards a request that is not a reply unchanged when RTI allows it', async () => {
        // Arrange
        const challenge = replyChallenge();
        const request = buildWorkerRequest('/landing', { querystring: 'gclid=abc', cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { forwarded, originFetch } = await run(request);

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(new URL(forwarded!.url).search).toBe('?gclid=abc');
        expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=benign');
        expect(challenge).not.toHaveBeenCalled();
    });

    it('forwards a reply when no challenge is configured', async () => {
        // Arrange
        (config as any).mode = Mode.BLOCKING;

        // Act
        const { originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
    });

    it('forwards a reply when RTI throws and no challenge is configured', async () => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        const { forwarded, originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(new URL(forwarded!.url).search).toBe('?' + replyQuery);
    });

    it('sends a reply to config.challenge with the stand-in response when the RTI response is malformed (any error before the decision)', async () => {
        // Arrange: RTI answers, but the answer cannot be evaluated
        expectError = true;
        const challenge = replyChallenge();
        mocks.getAction.mockImplementation(() => { throw new TypeError("Cannot read properties of undefined (reading 'verdict')"); });

        // Act
        const { response, originFetch } = await run(replyRequest());

        // Assert
        expect(response.status).toBe(302);
        expect(originFetch).not.toHaveBeenCalled();
        const [, rtiResponse, addRtiResultHeader] = challenge.mock.calls[0];
        expect(rtiResponse).toEqual(standIn);
        expect(addRtiResultHeader).toBeUndefined();
    });

    it('forwards a reply when RTI throws and config.isChallengeResponse is not set', async () => {
        // Arrange
        expectError = true;
        const challenge = replyChallenge();
        (config as any).isChallengeResponse = undefined;
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        const { originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(challenge).not.toHaveBeenCalled();
    });

    it('forwards a reply on an ignored path unchanged, without RTI or config.isChallengeResponse', async () => {
        // Arrange: a site excludes its own Turnstile forms this way
        const challenge = replyChallenge();
        const detector = vi.fn().mockReturnValue(true);
        (config as any).isChallengeResponse = detector;
        mocks.shouldIgnore.mockReturnValue(true);

        // Act
        const { forwarded, originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(new URL(forwarded!.url).search).toBe('?' + replyQuery);
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
        const { response, originFetch } = await run(replyRequest());

        // Assert
        expect(response.status).toBe(302);
        expect(originFetch).not.toHaveBeenCalled();
        expect(challenge).toHaveBeenCalledOnce();
    });

    it('logs a throwing config.isChallengeResponse only to the console when logErrors is false', async () => {
        // Arrange
        expectError = true;
        replyChallenge();
        (config as any).logErrors = false;
        (config as any).isChallengeResponse = vi.fn().mockImplementation(() => { throw new Error('detector failed'); });

        // Act
        const { originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Challenge reply check error handling request 'ray-abc-123'"), expect.objectContaining({ message: 'detector failed' }));
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('logs in debug mode that a reply goes to config.challenge', async () => {
        // Arrange
        replyChallenge();
        (config as any).debug = true;
        const logs: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(String(args[0])); });

        // Act
        await run(replyRequest());

        // Assert
        expect(logs).toContain('challenge reply, passing it to challenge');
    });

    it('forwards a reply when config.challenge throws synchronously (not a rejected promise)', async () => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        (config as any).challenge = vi.fn().mockImplementation(() => { throw new Error('sync throw'); });

        // Act
        const { originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(mocks.loggerError).toHaveBeenCalledWith(`Challenge error handling request '${CF_RAY}': sync throw`);
    });

    it.each(nonErrors)('forwards a reply when config.challenge rejects with %s, calling it once', async (_, value, logged) => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        const challenge = vi.fn().mockImplementation(() => Promise.reject(value()));
        (config as any).challenge = challenge;

        // Act
        const { originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(challenge).toHaveBeenCalledOnce();
        expect(mocks.loggerError).toHaveBeenCalledWith(`Challenge error handling request '${CF_RAY}': ${logged}`);
    });

    it('forwards a reply when RTI and config.challenge both reject with undefined', async () => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        const challenge = vi.fn().mockImplementation(() => Promise.reject(undefined));
        (config as any).challenge = challenge;
        mocks.callRTI.mockImplementation(() => Promise.reject(undefined));

        // Act
        const { originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(challenge).toHaveBeenCalledOnce();
    });

    it('forwards a reply and logs the error when config.challenge throws (fail open)', async () => {
        // Arrange
        expectError = true;
        (config as any).mode = Mode.BLOCKING;
        (config as any).challenge = vi.fn().mockRejectedValue(new Error('siteverify unreachable'));

        // Act
        const { originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(CF_RAY), expect.objectContaining({ message: 'siteverify unreachable' }));
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('siteverify unreachable'));
    });

    it('still sends a reply to config.challenge when RTI throws, with a stand-in response (cf-ray only) and no addRtiResultHeader', async () => {
        // Arrange
        expectError = true;
        const challenge = replyChallenge();
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const request = replyRequest();

        // Act
        const { response, originFetch } = await run(request);

        // Assert
        expect(response.status).toBe(302);
        expect(originFetch).not.toHaveBeenCalled();
        expect(challenge).toHaveBeenCalledOnce();
        const [replied, rtiResponse, addRtiResultHeader] = challenge.mock.calls[0];
        expect(replied.url).toBe(request.url);
        expect(replied.method).toBe('GET');
        expect(rtiResponse).toEqual(standIn);
        expect(addRtiResultHeader).toBeUndefined();
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('RTI timeout'));
    });

    // --- The stand-in rayId must be a plain, unique id (the example signs it and puts it in a cookie) ---

    // Sends a reply while RTI is down, with the given cf-ray header (none without cfRay or extraHeaders).
    const replyWithRtiDown = async (headers: { cfRay?: string; extraHeaders?: Record<string, string> }) => {
        expectError = true;
        const challenge = replyChallenge();
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { ctx } = await run(buildWorkerRequest('/landing', { querystring: replyQuery, xRealIp: '1.2.3.4', ...headers }));
        return { response: challenge.mock.calls[0][1], warn, ctx };
    };

    it('uses a plain cf-ray value as the stand-in rayId, without a warning', async () => {
        // Act
        const { response, warn } = await replyWithRtiDown({ cfRay: '8a1b2c3d4e5f6789-TLV' });

        // Assert
        expect(response.ids.rayId).toBe('8a1b2c3d4e5f6789-TLV');
        expect(response.ids.customParam2).toBe('8a1b2c3d4e5f6789-TLV');
        expect(warn).not.toHaveBeenCalled();
        expect(mocks.loggerError).not.toHaveBeenCalledWith(expect.stringContaining('not usable as the stand-in rayId'));
    });

    it.each<[string, { cfRay?: string; extraHeaders?: Record<string, string> }, string, string | null]>([
        ['a cf-ray with cookie separators', { cfRay: 'abc; Domain=evil|x' }, 'abc; Domain=evil|x', 'abc; Domain=evil|x'],
        ['a cf-ray with spaces and parentheses', { cfRay: 'bad id (boom)' }, 'bad id (boom)', 'bad id (boom)'],
        ['a cf-ray of more than 200 characters', { cfRay: 'a'.repeat(201) }, 'a'.repeat(201), 'a'.repeat(201)],
        ['a missing cf-ray header', {}, 'unknown_request_id', null],
        ['an empty cf-ray header', { extraHeaders: { 'cf-ray': '' } }, 'unknown_request_id', null],
    ])('replaces %s by a random stand-in rayId, logged to the console and the RTI logger', async (_, headers, loggedId, customParam2) => {
        // Act
        const { response, warn } = await replyWithRtiDown(headers);

        // Assert: a random plain id, while customParam2 keeps the real one for correlation
        expect(response.ids.rayId).toMatch(/^cf-fallback-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(response.ids.customParam2).toBe(customParam2);
        const message = `RTI failed and the Cloudflare request id ${JSON.stringify(loggedId)} is not usable as the stand-in rayId, using ${response.ids.rayId}`;
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(`[challenge] ${message}`);
        expect(mocks.loggerError).toHaveBeenCalledWith(message);
    });

    it('hands the log of a replaced stand-in rayId to waitUntil and does not wait for it', async () => {
        // Arrange: the RTI error is logged first, then the replaced id. Only the second log never settles.
        const neverSettles = new Promise<void>(() => {});
        mocks.loggerError.mockResolvedValueOnce(undefined).mockReturnValueOnce(neverSettles);

        // Act
        const { ctx } = await replyWithRtiDown({ cfRay: 'bad id' });

        // Assert
        expect(mocks.loggerError).toHaveBeenNthCalledWith(2, expect.stringContaining('not usable as the stand-in rayId'));
        // toContain compares with ===. toHaveBeenCalledWith would also accept the RTI error's promise: promises are deeply equal.
        expect(vi.mocked(ctx.waitUntil).mock.calls.map(([promise]) => promise)).toContain(neverSettles);
    });

    it('uses a new random stand-in rayId for every request', async () => {
        // Act
        const first = await replyWithRtiDown({ cfRay: 'bad id' });
        const second = await replyWithRtiDown({ cfRay: 'bad id' });

        // Assert
        expect(first.response.ids.rayId).not.toBe(second.response.ids.rayId);
    });

    it('logs a replaced stand-in rayId only to the console when logErrors is false', async () => {
        // Arrange
        (config as any).logErrors = false;

        // Act
        const { warn } = await replyWithRtiDown({ cfRay: 'bad id' });

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

        // Act
        const { originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
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
        const request = buildWorkerRequest('/landing', { querystring: token ? replyQuery : 'gclid=abc', cfRay: CF_RAY, xRealIp: '1.2.3.4' });

        // Act
        const { originFetch } = await run(request);

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(challenge).not.toHaveBeenCalled();
    });

    // --- A reply with a body: the handler forwards a copy of the request, and the body has moved to that copy ---

    const postReply = () => new Request(`https://example.com/landing?${replyQuery}`, {
        method: 'POST', body: 'answer=42', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-ray': CF_RAY },
    });

    it('gives config.challenge a POST reply whose body it can read', async () => {
        // Arrange
        replyChallenge().mockImplementation(async (request: Request) => new Response(await request.clone().text(), { status: 403 }));

        // Act
        const { response, originFetch } = await run(postReply());

        // Assert
        expect(await response.text()).toBe('answer=42');
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('still forwards a POST reply with its body when config.challenge fails after reading a copy of it', async () => {
        // Arrange
        expectError = true;
        const challenge = replyChallenge().mockImplementation(async (request: Request) => {
            await request.clone().text();
            throw new Error('challenge crash');
        });

        // Act
        const { forwarded } = await run(postReply());

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        expect(forwarded!.method).toBe('POST');
        expect(await forwarded!.text()).toBe('answer=42');
    });

    // --- Debug logging ---

    it('logs RTI payload, response and action details when debug enabled', async () => {
        // Arrange
        (config as any).debug = true;
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        await run(buildWorkerRequest('/page', { cfRay: CF_RAY }));

        // Assert
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('RTI Request payload'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('RTI Response'));
        expect(consoleSpy).toHaveBeenCalledWith('action upon response: BLOCK (2)');
        consoleSpy.mockRestore();
    });

    it('logs the RTI payload redacted: not the apiKey, the tagHash or the CAPTCHA token in the URL', async () => {
        // Arrange: a reply to the challenge page carries the token in its query
        replyChallenge();
        (config as any).debug = true;
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const token = 'TURNSTILE-TOKEN-0123456789-SECRET';
        const querystring = new URLSearchParams({ original_url: '/landing', 'cf-turnstile-response': token }).toString();
        const request = buildWorkerRequest('/landing', { querystring, cfRay: CF_RAY });

        // Act
        await run(request);

        // Assert
        const payloadLines = consoleSpy.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('RTI Request payload: '));
        expect(payloadLines).toHaveLength(1);
        expect(payloadLines[0]).not.toContain('api-key');
        expect(payloadLines[0]).not.toContain('tag-hash');
        expect(payloadLines[0]).not.toContain(token);
        expect(mocks.callRTI.mock.calls[0][0]).toMatchObject({ apiKey: 'api-key', tagHash: 'tag-hash' }); // RTI still gets them
    });

    it('logs raw action value when the action has no name', async () => {
        // Arrange
        (config as any).debug = true;
        const unknownAction = 999 as Action;
        mocks.getAction.mockReturnValue(unknownAction);
        mocks.getActionStrategy.mockReturnValue(null);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        await run(buildWorkerRequest('/page', { cfRay: CF_RAY }));

        // Assert
        expect(consoleSpy).toHaveBeenCalledWith('action upon response: 999');
        consoleSpy.mockRestore();
    });

    // --- getHeaders filtering ---

    it('only sends configured headerNames in RTI payload', async () => {
        // Arrange: headers that are not in the list, a client-sent x-cheq-rti-result among them
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const unlisted = ['cookie', 'authorization', 'x-custom', 'x-cheq-rti-result'];
        const request = buildWorkerRequest('/page', { xRealIp: '9.9.9.9', cookies: 'session=abc', extraHeaders: {
            authorization: 'Bearer xyz', 'x-custom': '1', 'x-cheq-rti-result': 'version=4.1;verdict=benign',
        } });

        // Act
        await worker.fetch(request, {}, buildContext());
        const { headers, headerNames } = mocks.callRTI.mock.calls[0][0].endUserParams;

        // Assert
        expect(headers).toMatchObject({ 'user-agent': 'Mozilla/5.0', host: 'example.com', 'x-real-ip': '9.9.9.9' });
        expect(Object.keys(headers).filter((name) => unlisted.includes(name))).toEqual([]);
        expect(headerNames.split(',').filter((name: string) => unlisted.includes(name))).toEqual([]);
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
        mocks.callRTI.mockResolvedValue(buildRTIResponse({
            rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
            pageViewId: '16183c3ded45c554f9b4bb71a42d8e71',
        }));
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

    // --- Our own answers are never cached ---

    it.each([
        [Action.BLOCK, ActionStrategy.ACCESS_DENIED, 403],
        [Action.BLOCK, ActionStrategy.NOT_FOUND, 404],
        [Action.REDIRECT, ActionStrategy.REDIRECT, 302],
    ])('never lets a cache keep our answer to action %s / strategy %s (returns %s): Cache-Control no-store', async (action, strategy, status) => {
        // Arrange
        mocks.getAction.mockReturnValue(action);
        mocks.getActionStrategy.mockReturnValue(strategy);

        // Act
        const { response } = await run(buildWorkerRequest());

        // Assert
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
    });

    // --- API key not leaked ---

    it('does not expose apiKey in x-cheq-rti-result response header', async () => {
        // Arrange: the client sees the header on what config.challenge answers a reply with (the 302 after a solve)
        replyChallenge().mockImplementation(async (_request, _response, addRtiResultHeader) => {
            const headers = new Headers({ location: 'https://example.com/landing' });
            addRtiResultHeader!(headers);
            return new Response(null, { status: 302, headers });
        });

        // Act
        const { response } = await run(replyRequest());

        // Assert
        const header = response.headers.get('x-cheq-rti-result');
        expect(header).toContain('verdict=benign');
        expect(header).not.toContain('api-key');
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

    it('telemetry reports the measured RTI duration', async () => {
        // Arrange
        (config as any).telemetry = true;
        vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1250);

        // Act
        await run(buildWorkerRequest('/page', { cfRay: CF_RAY }));

        // Assert
        expect(mocks.loggerInfo).toHaveBeenCalledWith('rti_duration: 250');
    });

    // --- Forwarding to the origin ---

    // A suspicious visitor without a pass must not get a page into the browser cache through a request that is passed on
    // (a script's fetch of a page, say): the browser could later show that copy for a click or Back without asking the
    // Worker, so the CAPTCHA would never come. Seen in Chromium and Firefox on the dev Worker (2026-11-23).
    describe('what the browser may keep of an answer passed on for a suspicious visitor', () => {
        // A script's fetch: Sec-Fetch-Dest empty, so not a page load, and passed on by actionOnSuspicious (GET: ALLOW).
        const suspiciousFetch = () => buildWorkerRequest('/page', { extraHeaders: { 'sec-fetch-dest': 'empty', accept: '*/*' }, cfRay: CF_RAY, xRealIp: '1.2.3.4' });
        // The site's answer, with its own caching headers.
        const origin = (headers: Record<string, string>, body: BodyInit | null = '<html>page</html>') =>
            async () => new Response(body, { status: 200, headers: { 'cache-control': 'max-age=600', etag: '"v1"', ...headers } });

        it.each([
            ['text/html'],
            ['text/html; charset=utf-8'],
            ['TEXT/HTML'],
            ['application/xhtml+xml'],
        ])('an HTML answer (Content-Type: %s) to a suspicious GET that is not a page load gets Cache-Control: no-store', async (contentType) => {
            // Arrange
            captchaVerdict();

            // Act
            const { response, originFetch } = await run(suspiciousFetch(), origin({ 'content-type': contentType }));

            // Assert
            expect(originFetch).toHaveBeenCalledOnce();
            expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
        });

        it('keeps the rest of a marked answer as the site sent it: status, body and the other headers', async () => {
            // Arrange
            captchaVerdict();
            const site = async () => new Response('<html>page</html>', { status: 201, headers: { 'content-type': 'text/html', 'cache-control': 'max-age=600', etag: '"v1"', 'x-site': 'kept' } });

            // Act
            const { response } = await run(suspiciousFetch(), site);

            // Assert
            expect(response.status).toBe(201);
            expect(await response.text()).toBe('<html>page</html>');
            expect(response.headers.get('content-type')).toBe('text/html');
            expect(response.headers.get('etag')).toBe('"v1"');
            expect(response.headers.get('x-site')).toBe('kept');
        });

        it.each([
            ['application/json', origin({ 'content-type': 'application/json' }, '{"a":1}')],
            ['text/plain', origin({ 'content-type': 'text/plain' }, 'text')],
            ['no Content-Type', origin({}, new Uint8Array([1, 2, 3]))],
        ])('an answer that is not HTML (%s) keeps the site\'s Cache-Control', async (_label, site) => {
            // Arrange
            captchaVerdict();

            // Act
            const { response } = await run(suspiciousFetch(), site);

            // Assert
            expect(response.headers.get('cache-control')).toBe('max-age=600');
        });

        it('an HTML answer on a benign verdict keeps the site\'s Cache-Control', async () => {
            // Arrange
            mocks.getAction.mockReturnValue(Action.ALLOW);
            mocks.getActionStrategy.mockReturnValue(null);
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'benign' }));

            // Act
            const { response, forwarded } = await run(suspiciousFetch(), origin({ 'content-type': 'text/html' }));

            // Assert
            expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=benign');
            expect(response.headers.get('cache-control')).toBe('max-age=600');
        });

        it('an HTML answer to a suspicious page load with a valid pass keeps the site\'s Cache-Control: the visitor passed the check', async () => {
            // Arrange
            captchaVerdict();
            mocks.validateChallenge.mockResolvedValue(true);
            const pageLoad = buildWorkerRequest('/page', { cookies: '_cq_se=tok|ray', extraHeaders: { 'sec-fetch-dest': 'document' }, cfRay: CF_RAY, xRealIp: '1.2.3.4' });

            // Act
            const { response, forwarded } = await run(pageLoad, origin({ 'content-type': 'text/html' }));

            // Assert
            expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
            expect(response.headers.get('cache-control')).toBe('max-age=600');
        });
    });

    describe('forwarding to the origin', () => {
        it('calls the origin once for an allowed request, with the request that carries the verdict', async () => {
            // Act
            const { response, forwarded, originFetch } = await run(buildWorkerRequest());

            // Assert
            expect(originFetch).toHaveBeenCalledOnce();
            expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=benign');
            expect(await response.text()).toBe('origin');
        });

        it('does not call the origin when it answers itself', async () => {
            // Arrange
            mocks.getAction.mockReturnValue(Action.BLOCK);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);

            // Act
            const { response, originFetch } = await run(buildWorkerRequest());

            // Assert
            expect(response.status).toBe(403);
            expect(originFetch).not.toHaveBeenCalled();
        });

        it.each([
            ['an ignored path', () => mocks.shouldIgnore.mockReturnValue(true)],
            ['an RTI failure', () => {
                expectError = true;
                mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
            }],
            ['a failing challenge', () => {
                expectError = true;
                mocks.getAction.mockReturnValue(Action.CHALLENGE);
                mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
                (config as any).challenge = vi.fn().mockRejectedValue(new Error('challenge crash'));
            }],
        ])('calls the origin exactly once on %s', async (_, arrange) => {
            // Arrange
            arrange();

            // Act
            const { originFetch } = await run(buildWorkerRequest());

            // Assert
            expect(originFetch).toHaveBeenCalledOnce();
        });

        it('does not catch a failing origin call: no error log, no second call by this Worker', async () => {
            // Arrange
            const originFetch = vi.fn().mockRejectedValue(new Error('origin down'));
            vi.stubGlobal('fetch', originFetch);

            // Act & Assert
            await expect(worker.fetch(buildWorkerRequest(), {}, buildContext())).rejects.toThrow('origin down');
            expect(originFetch).toHaveBeenCalledOnce();
            expect(consoleErrorSpy).not.toHaveBeenCalled();
            expect(mocks.loggerError).not.toHaveBeenCalled();
        });

        it('forwards a POST with its method and body', async () => {
            // Arrange
            const request = new Request('https://example.com/login', {
                method: 'POST', body: 'user=a&pass=b', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            });

            // Act
            const { forwarded } = await run(request);

            // Assert
            expect(forwarded!.method).toBe('POST');
            expect(await forwarded!.text()).toBe('user=a&pass=b');
        });

        it('forwards the URL as received and keeps redirect: manual', async () => {
            // Act
            const { forwarded } = await run(new Request('https://example.com/a/b?x=1&y=%2F', { redirect: 'manual' }));

            // Assert
            expect(forwarded!.url).toBe('https://example.com/a/b?x=1&y=%2F');
            expect(forwarded!.redirect).toBe('manual');
        });
    });

    // --- The body of a request that is not sent on: read to the end in the background ---

    describe('the body of a request the Worker does not send on', () => {
        // A POST whose body counts what it hands out. highWaterMark 0: nothing is read before a reader asks.
        // `fail`: after the chunks, the body fails instead of ending (the client went away).
        const streamedPost = (chunks = ['user=a', '&pass=b', '&x=1'], fail = false, extraHeaders: Record<string, string> = {}) => {
            const read = { chunks: 0, ended: false, failed: false };
            const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (read.chunks < chunks.length) {
                        controller.enqueue(new TextEncoder().encode(chunks[read.chunks++]));
                    } else if (fail) {
                        read.failed = true;
                        controller.error(new Error('client went away'));
                    } else {
                        read.ended = true;
                        controller.close();
                    }
                },
            }, { highWaterMark: 0 });
            const request = new Request('https://example.com/login', {
                method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-ray': CF_RAY, ...extraHeaders },
            } as RequestInit);
            return { request, read };
        };
        // Waits for every promise the Worker gave to waitUntil.
        const waitUntilSettled = (ctx: ExecutionContext) => Promise.allSettled(vi.mocked(ctx.waitUntil).mock.calls.map(([promise]) => promise));
        const block = () => {
            (config as any).mode = Mode.BLOCKING;
            mocks.getAction.mockReturnValue(Action.BLOCK);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);
        };

        it.each([
            ['blocked (the 403 page)', block, 403],
            ['redirected (the 302)', () => {
                mocks.getAction.mockReturnValue(Action.REDIRECT);
                mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
            }, 302],
            ['challenged (the CAPTCHA page, actionOnSuspicious CHALLENGE)', () => {
                captchaVerdict();
                (config as any).actionOnSuspicious = { methods: { POST: Action.CHALLENGE } };
            }, 403],
        ])('reads the body of a POST that is %s to the end, in the background', async (_, arrange, status) => {
            // Arrange
            arrange();
            const { request, read } = streamedPost();

            // Act
            const { response, ctx, originFetch } = await run(request);
            const settled = await waitUntilSettled(ctx);

            // Assert
            expect(response.status).toBe(status);
            expect(originFetch).not.toHaveBeenCalled();
            expect(read).toEqual({ chunks: 3, ended: true, failed: false });
            expect(settled).toEqual([{ status: 'fulfilled', value: undefined }]);
        });

        it('forwards the Request that config.challenge returns for a challenged POST as returned, and reads nothing in the background', async () => {
            // Arrange
            const challenge = captchaVerdict().mockImplementation(async (pageRequest) => pageRequest);
            (config as any).actionOnSuspicious = { methods: { POST: Action.CHALLENGE } };
            const { request } = streamedPost();

            // Act
            const { forwarded, originFetch, ctx } = await run(request);

            // Assert
            expect(originFetch).toHaveBeenCalledOnce();
            expect(forwarded).toBe(challenge.mock.calls[0][0]);
            expect(forwarded!.method).toBe('GET');
            expect(ctx.waitUntil).not.toHaveBeenCalled();
        });

        it('sends the whole body to the origin when config.challenge forwards a reply as new Request(url, request), which shares the body, and reads nothing in the background', async () => {
            // Arrange: a custom reply with a body, recognized by a header; config.challenge gets the copy itself
            (config as any).isChallengeResponse = (request: Request) => request.headers.get('x-my-reply') === '1';
            const challenge = replyChallenge().mockImplementation(async (reply: Request) => new Request('https://example.com/elsewhere', reply));
            const { request } = streamedPost(undefined, false, { 'x-my-reply': '1' });

            // Act
            const { forwarded, originFetch, ctx } = await run(request);

            // Assert
            expect(challenge).toHaveBeenCalledOnce();
            expect(originFetch).toHaveBeenCalledOnce();
            expect(forwarded!.url).toBe('https://example.com/elsewhere');
            expect(await forwarded!.text()).toBe('user=a&pass=b&x=1');
            expect(ctx.waitUntil).not.toHaveBeenCalled();
        });

        it('reads nothing in the background when config.challenge returns a request built from the copy: that request has the body', async () => {
            // Arrange: a reply goes to config.challenge as the copy itself
            const challenge = replyChallenge().mockImplementation(async (reply: Request) => new Request(reply, { headers: { 'x-built-by': 'challenge' } }));
            const request = new Request(`https://example.com/landing?${replyQuery}`, { method: 'POST', body: 'answer=42', headers: { 'cf-ray': CF_RAY } });

            // Act
            const { forwarded, ctx } = await run(request);

            // Assert
            expect(forwarded).not.toBe(challenge.mock.calls[0][0]);
            expect(forwarded!.headers.get('x-built-by')).toBe('challenge');
            expect(await forwarded!.text()).toBe('answer=42');
            expect(ctx.waitUntil).not.toHaveBeenCalled();
        });

        it('sends the whole body of an allowed POST to the origin, and reads nothing in the background', async () => {
            // Arrange
            const { request, read } = streamedPost();

            // Act
            const { forwarded, ctx } = await run(request);

            // Assert
            expect(await forwarded!.text()).toBe('user=a&pass=b&x=1');
            expect(read.ended).toBe(true);
            expect(ctx.waitUntil).not.toHaveBeenCalled();
        });

        it('reads nothing in the background for a blocked GET (it has no body)', async () => {
            // Arrange
            block();

            // Act
            const { response, ctx } = await run(buildWorkerRequest('/page', { cfRay: CF_RAY }));

            // Assert
            expect(response.status).toBe(403);
            expect(ctx.waitUntil).not.toHaveBeenCalled();
        });

        it('reads nothing in the background when config.challenge reads the body of a reply itself and answers', async () => {
            // Arrange: a reply goes to config.challenge as the copy itself; it reads the body, so the body is used
            const challenge = replyChallenge().mockImplementation(async (reply: Request) => new Response(await reply.text(), { status: 403 }));
            const request = new Request(`https://example.com/landing?${replyQuery}`, { method: 'POST', body: 'answer=42', headers: { 'cf-ray': CF_RAY } });

            // Act
            const { response, ctx, originFetch } = await run(request);

            // Assert
            expect(challenge).toHaveBeenCalledOnce();
            expect(response.status).toBe(403);
            expect(await response.text()).toBe('answer=42');
            expect(originFetch).not.toHaveBeenCalled();
            expect(ctx.waitUntil).not.toHaveBeenCalled();
        });

        it('still answers with the block page when the body fails while it is read in the background, and the reading ends without an error', async () => {
            // Arrange
            block();
            const { request, read } = streamedPost(['user=a'], true);

            // Act
            const { response, ctx } = await run(request);
            const settled = await waitUntilSettled(ctx);

            // Assert
            expect(response.status).toBe(403);
            expect(await response.text()).toBe('<html>blocked</html>');
            expect(read.failed).toBe(true);
            expect(settled).toEqual([{ status: 'fulfilled', value: undefined }]);
        });
    });

    // --- A client-sent x-cheq-rti-result never reaches the origin ---

    const spoofed = { 'x-cheq-rti-result': 'version=4.1;verdict=benign;threat-type-code=0;ids={}' };

    it('removes a client-sent x-cheq-rti-result on an ignored path', async () => {
        // Arrange
        mocks.shouldIgnore.mockReturnValue(true);
        const request = buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4', extraHeaders: spoofed });

        // Act
        const { forwarded } = await run(request);

        // Assert
        expect(forwarded!.headers.get('x-cheq-rti-result')).toBeNull();
    });

    it('removes a client-sent x-cheq-rti-result when RTI fails (fail open)', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('rti down'));
        const request = buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4', extraHeaders: spoofed });

        // Act
        const { forwarded, originFetch } = await run(request);

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(forwarded!.headers.get('x-cheq-rti-result')).toBeNull();
    });

    it('replaces a client-sent x-cheq-rti-result with the real verdict on ALLOW', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious' }));
        const request = buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4', extraHeaders: spoofed });

        // Act
        const { forwarded } = await run(request);

        // Assert
        const header = forwarded!.headers.get('x-cheq-rti-result');
        expect(header).toContain('verdict=suspicious');
        expect(header).not.toContain('verdict=benign');
    });

    // --- x-cheq-original-referer: set only from config.originalReferer, never by the client ---

    const refererRequest = (headers: Record<string, string> = {}) =>
        buildWorkerRequest('/page', { cfRay: CF_RAY, xRealIp: '1.2.3.4', extraHeaders: headers });

    it('x-cheq-original-referer: a copy sent by the client is always removed', async () => {
        mocks.shouldIgnore.mockReturnValue(true); // returns before RTI: still removed
        const { forwarded } = await run(refererRequest({ 'x-cheq-original-referer': 'https://evil.example' }));
        expect(forwarded!.headers.get('x-cheq-original-referer')).toBeNull();
    });

    it('x-cheq-original-referer: set from config.originalReferer, before RTI is called', async () => {
        (config as any).originalReferer = vi.fn().mockReturnValue('https://www.google.com');
        const { forwarded } = await run(refererRequest({ 'x-cheq-original-referer': 'https://evil.example' }));
        expect(forwarded!.headers.get('x-cheq-original-referer')).toBe('https://www.google.com');
        expect(mocks.callRTI.mock.calls[0][0].endUserParams.headers['x-cheq-original-referer']).toBe('https://www.google.com');
    });

    it('x-cheq-original-referer: no value, no header', async () => {
        (config as any).originalReferer = vi.fn().mockReturnValue(undefined);
        mocks.shouldIgnore.mockReturnValue(true);
        const { forwarded } = await run(refererRequest());
        expect(forwarded!.headers.get('x-cheq-original-referer')).toBeNull();
    });

    it('x-cheq-original-referer: if it throws, no header, logged, and the request goes on', async () => {
        expectError = true;
        (config as any).originalReferer = vi.fn(() => { throw new Error('boom'); });
        mocks.shouldIgnore.mockReturnValue(true);
        const { forwarded, originFetch } = await run(refererRequest());
        expect(originFetch).toHaveBeenCalledOnce();
        expect(forwarded!.headers.get('x-cheq-original-referer')).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[challenge] originalReferer failed'));
    });

    it('x-cheq-original-referer: a value a header cannot hold gives no header, is logged, and the request goes on', async () => {
        expectError = true;
        (config as any).originalReferer = vi.fn().mockReturnValue('https://a.example/\r\nx-injected: 1');
        const { forwarded, originFetch } = await run(buildWorkerRequest());
        expect(originFetch).toHaveBeenCalledOnce();
        expect(forwarded!.headers.get('x-cheq-original-referer')).toBeNull();
        expect(forwarded!.headers.get('x-injected')).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[challenge] originalReferer failed'));
        expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it('x-cheq-original-referer: set from a callback that returns a promise, before RTI is called', async () => {
        (config as any).originalReferer = vi.fn().mockResolvedValue('https://www.google.com/');
        const { forwarded } = await run(buildWorkerRequest());
        expect(forwarded!.headers.get('x-cheq-original-referer')).toBe('https://www.google.com/');
        expect(mocks.callRTI.mock.calls[0][0].endUserParams.headers['x-cheq-original-referer']).toBe('https://www.google.com/');
    });

    it('x-cheq-original-referer: a promise that rejects gives no header, is logged, and the request goes on', async () => {
        expectError = true;
        (config as any).originalReferer = vi.fn().mockRejectedValue(new Error('referer check failed'));
        const { forwarded, originFetch } = await run(buildWorkerRequest());
        expect(originFetch).toHaveBeenCalledOnce();
        expect(forwarded!.headers.get('x-cheq-original-referer')).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            '[challenge] originalReferer failed, forwarding without x-cheq-original-referer: referer check failed');
    });
});
