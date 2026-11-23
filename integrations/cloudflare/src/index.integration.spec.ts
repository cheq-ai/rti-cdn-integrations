// cspell:ignore duid pvid gclid siteverify
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import type { Mock } from 'vitest';
import { Mode } from '../../core/models/mode.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { Action } from '../../core/models/action.model';
import type { CloudflareConfig } from './config';

const { mockCallRTI, mockLoggerError, integrationConfig } = vi.hoisted(() => {
    const mockCallRTI = vi.fn();
    // The RTI logger's error, so a test can check that nothing was logged as an error.
    const mockLoggerError = vi.fn().mockResolvedValue(undefined);
    // Mutable config object — integration tests call setConfig() to change properties between tests.
    // The real RTIHelperService reads from this object via reference, so mutations take effect immediately.
    // Mode.BLOCKING = 1 (numeric enum) — using the raw value here since imports are not available in vi.hoisted.
    const integrationConfig: Record<string, any> = {
        mode: 1, // Mode.BLOCKING
        apiKey: 'test-api-key',
        tagHash: 'test-tag-hash',
        debug: false,
        telemetry: false,
        redirectLocation: 'https://www.cheq.ai/',
        ignorePaths: [],
        challenge: undefined,
        validateChallenge: undefined,
        blockTTCodes: undefined,
        redirectTTCodes: undefined,
        blockingStrategy: undefined,
        challengingStrategy: undefined,
    };
    return { mockCallRTI, mockLoggerError, integrationConfig };
});

vi.mock('../package.json', () => ({ name: 'test', version: '1.0.0' }));

vi.mock('./config', () => ({ config: integrationConfig }));

// Mock only the network boundary — RTIService.callRTI.
// RTIHelperService is NOT mocked, so real decision logic runs.
vi.mock('../../core/services/rti.service', () => ({
    RTIService: vi.fn().mockImplementation(function () { return { callRTI: mockCallRTI }; }),
}));

vi.mock('../../core/services/rti-logger.service', () => ({
    RTILoggerService: vi.fn().mockImplementation(function () {
        return { info: vi.fn().mockResolvedValue(undefined), error: mockLoggerError };
    }),
}));

vi.mock('../../core/helpers/block-page-helpers', () => ({
    generateDefaultBlockPage: vi.fn().mockReturnValue('<html>blocked</html>'),
}));

import worker from './index';
import { createTurnstileChallenge } from './turnstile-challenge-example';
import type { IntegrationTestAdapter, IntegrationNormalizedResult, IntegrationInvokeOptions } from '../../core/testing/integration-test-adapter.interface';
import { registerSharedIntegrationTests } from '../../core/testing/shared-integration-tests';
import { buildRTIResponse } from '../../core/testing/rti-response.fixture';

const BASE_URL = 'https://example.com';

function buildWorkerRequest(path = '/page', opts: {
    cookies?: string;
    querystring?: string;
    method?: string;
    ip?: string;
    extraHeaders?: Record<string, string>;
} = {}): Request {
    const url = `${BASE_URL}${path}${opts.querystring ? '?' + opts.querystring : ''}`;
    const headers = new Headers();
    headers.set('host', 'example.com');
    headers.set('user-agent', 'Mozilla/5.0');
    if (opts.cookies) headers.set('cookie', opts.cookies);
    if (opts.ip) headers.set('x-real-ip', opts.ip);
    if (opts.extraHeaders) {
        for (const [k, v] of Object.entries(opts.extraHeaders)) headers.set(k, v);
    }
    return new Request(url, { method: opts.method ?? 'GET', headers });
}

function buildContext(): ExecutionContext {
    return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

const cloudflareIntegrationAdapter: IntegrationTestAdapter = {
    name: 'cloudflare',

    async invoke(options: IntegrationInvokeOptions = {}): Promise<IntegrationNormalizedResult> {
        let capturedRequest: Request | undefined;
        let fetchCalled = false;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((req: Request) => {
            capturedRequest = req;
            fetchCalled = true;
            return Promise.resolve(new Response('origin'));
        }));

        const request = buildWorkerRequest(options.path ?? '/page', {
            cookies: options.cookies,
            querystring: options.querystring,
            method: options.method,
            ip: options.ip,
            extraHeaders: options.headers,
        });

        // Track call count before invoke to detect whether RTI was called during this specific invocation.
        const callsBefore = mockCallRTI.mock.calls.length;
        // The shared fail-open tests make the Worker log an error on purpose: keep it out of the test output.
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        let response: Response;
        try {
            response = await worker.fetch(request, {}, buildContext());
        } finally {
            // Also when the Worker rejects: console.error must not stay silenced for later tests.
            consoleErrorSpy.mockRestore();
            vi.unstubAllGlobals();
        }

        const body = await response.clone().text();
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        if (capturedRequest) {
            const rtiHeader = capturedRequest.headers.get('x-cheq-rti-result');
            if (rtiHeader) headers['x-cheq-rti-result'] = rtiHeader;
        }

        const rtiPayload = mockCallRTI.mock.calls.length > callsBefore
            ? mockCallRTI.mock.calls[mockCallRTI.mock.calls.length - 1]?.[0]
            : undefined;
        return {
            status: response.status,
            headers,
            body,
            passedThrough: fetchCalled && response.status < 400,
            rtiPayload,
        };
    },

    setRtiResponse(rtiResponse) {
        mockCallRTI.mockResolvedValue(rtiResponse);
    },

    setRtiError(error) {
        mockCallRTI.mockRejectedValue(error);
    },
};

function setConfig(overrides: any) {
    // Reset to clean defaults first, then apply overrides
    const defaults: Record<string, any> = {
        mode: Mode.BLOCKING,
        apiKey: 'test-api-key',
        tagHash: 'test-tag-hash',
        debug: false,
        telemetry: false,
        redirectLocation: 'https://www.cheq.ai/',
        ignorePaths: [],
        challenge: undefined,
        validateChallenge: undefined,
        isChallengeResponse: undefined,
        originalReferer: undefined,
        actionOnSuspicious: undefined,
        logErrors: undefined,
        // Every rule list, or one set by an earlier test leaks into the next (only keys listed here are reset).
        blockTTCodes: undefined,
        challengeTTCodes: undefined,
        redirectTTCodes: undefined,
        blockReasons: undefined,
        challengeReasons: undefined,
        redirectReasons: undefined,
        blockingStrategy: undefined,
        challengingStrategy: undefined,
    };
    for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
        integrationConfig[k] = v;
    }
}

// Reset mocks before each integration test
beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockCallRTI.mockResolvedValue(buildRTIResponse());
});

registerSharedIntegrationTests(cloudflareIntegrationAdapter, setConfig);

// --- ignorePaths with the real helper: the patterns are matched against the path ---

describe('[integration] cloudflare ignorePaths', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('matches an anchored pattern against the path, not the whole URL: ^/health$ skips RTI for /health?probe=1', async () => {
        // Arrange
        setConfig({ ignorePaths: ['^/health$'] });
        const originFetch = vi.fn(async () => new Response('origin'));
        vi.stubGlobal('fetch', originFetch);

        // Act
        const response = await worker.fetch(buildWorkerRequest('/health', { querystring: 'probe=1' }), {}, buildContext());

        // Assert
        expect(mockCallRTI).not.toHaveBeenCalled();
        expect(originFetch).toHaveBeenCalledOnce();
        expect(response.status).toBe(200);
    });
});

// --- Challenge reply with the real decision logic (verdict → action → strategy → isChallengeReplyAllowed) ---

describe('[integration] cloudflare challenge reply', () => {
    const replyQuery = new URLSearchParams({ original_url: '/landing?gclid=abc', request_id: 'ray-page', 'cf-turnstile-response': 'tok' }).toString();
    const replyRequest = (extraHeaders?: Record<string, string>) => buildWorkerRequest('/landing', { querystring: replyQuery, extraHeaders });

    // The shipped Turnstile reply detector
    const { isChallengeResponse } = createTurnstileChallenge({
        siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'signing-secret', sessionTtlSeconds: 300,
    });

    let challengeResult: Response;
    let challenge: Mock<NonNullable<CloudflareConfig['challenge']>>;
    let validateChallenge: Mock<NonNullable<CloudflareConfig['validateChallenge']>>;

    // Sends a request through the Worker. `forwarded` is the request the origin received, if any.
    async function run(request: Request) {
        const originFetch = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('origin'));
        vi.stubGlobal('fetch', originFetch);
        const response = await worker.fetch(request, {}, buildContext());
        return { response, originFetch, forwarded: originFetch.mock.calls[0]?.[0] };
    }

    beforeEach(() => {
        challengeResult = new Response(null, { status: 302, headers: { location: 'https://example.com/landing?gclid=abc' } });
        challenge = vi.fn<NonNullable<CloudflareConfig['challenge']>>().mockResolvedValue(challengeResult);
        validateChallenge = vi.fn<NonNullable<CloudflareConfig['validateChallenge']>>().mockResolvedValue(true); // a valid session must not waive a reply
        setConfig({ challenge, validateChallenge, isChallengeResponse });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each([
        ['benign (ALLOW)', 'benign', {}],
        ['suspicious (CHALLENGE → CAPTCHA by default)', 'suspicious', {}],
        ['malicious with blockingStrategy CAPTCHA (a solved token answers a block that is configured as a CAPTCHA)', 'malicious', { blockingStrategy: ActionStrategy.CAPTCHA }],
        ['benign with a challengeTTCodes match', 'benign', { challengeTTCodes: [42] }],
    ] as const)('passes a %s reply to config.challenge, with its verdict for addRtiResultHeader', async (_, verdict, overrides) => {
        // Arrange
        setConfig({ challenge, validateChallenge, isChallengeResponse, ...overrides });
        mockCallRTI.mockResolvedValue(buildRTIResponse({ verdict, code: 42 }));
        const request = replyRequest();

        // Act
        const { response, originFetch } = await run(request);

        // Assert
        expect(response).toBe(challengeResult);
        expect(originFetch).not.toHaveBeenCalled();
        expect(challenge).toHaveBeenCalledOnce();
        const [replied, rtiResponse, addRtiResultHeader] = challenge.mock.calls[0];
        expect(replied.url).toBe(request.url);
        expect(replied.method).toBe('GET');
        expect(rtiResponse.decision.verdict).toBe(verdict);
        const headers = new Headers();
        addRtiResultHeader!(headers);
        expect(headers.get('x-cheq-rti-result')).toContain(`verdict=${verdict}`);
        expect(validateChallenge).not.toHaveBeenCalled();
    });

    it.each([
        ['malicious, default blockingStrategy (ACCESS_DENIED)', 403, 'malicious', {}],
        ['malicious, blockingStrategy NOT_FOUND', 404, 'malicious', { blockingStrategy: ActionStrategy.NOT_FOUND }],
        ['malicious, blockingStrategy REDIRECT', 302, 'malicious', { blockingStrategy: ActionStrategy.REDIRECT }],
        ['suspicious, challengingStrategy ACCESS_DENIED', 403, 'suspicious', { challengingStrategy: ActionStrategy.ACCESS_DENIED }],
        ['suspicious, challengingStrategy NOT_FOUND', 404, 'suspicious', { challengingStrategy: ActionStrategy.NOT_FOUND }],
        ['benign with a redirectTTCodes match', 302, 'benign', { redirectTTCodes: [42] }],
        ['benign with a blockTTCodes match', 403, 'benign', { blockTTCodes: [42] }],
    ] as const)('still enforces a reply that is %s (returns %s)', async (_, status, verdict, overrides) => {
        // Arrange
        setConfig({ challenge, validateChallenge, isChallengeResponse, ...overrides });
        mockCallRTI.mockResolvedValue(buildRTIResponse({ verdict, code: 42 }));

        // Act
        const { response, originFetch } = await run(replyRequest());

        // Assert
        expect(response.status).toBe(status);
        if (status === 302) {
            expect(response.headers.get('location')).toBe('https://www.cheq.ai/'); // config.redirectLocation, not original_url
        }
        expect(originFetch).not.toHaveBeenCalled();
        expect(challenge).not.toHaveBeenCalled();
    });

    it('forwards a malicious reply unchanged in MONITORING mode', async () => {
        // Arrange
        setConfig({ challenge, validateChallenge, isChallengeResponse, mode: Mode.MONITORING });
        mockCallRTI.mockResolvedValue(buildRTIResponse({ verdict: 'malicious' }));

        // Act
        const { forwarded, originFetch } = await run(replyRequest());

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(new URL(forwarded!.url).search).toBe('?' + replyQuery);
        expect(challenge).not.toHaveBeenCalled();
    });

    it('passes a reply to config.challenge when RTI fails, with a stand-in response', async () => {
        // Arrange
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mockCallRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        const { response, originFetch } = await run(replyRequest({ 'cf-ray': 'ray-abc-123' }));

        // Assert
        expect(response).toBe(challengeResult);
        expect(originFetch).not.toHaveBeenCalled();
        const [, rtiResponse, addRtiResultHeader] = challenge.mock.calls[0];
        // Not an RTI answer: only the cf-ray value, as rayId (it signs the example's session) and as customParam2
        // (as customId2 in the normal RTI payload). No verdict, classification or other ids.
        expect(rtiResponse).toEqual({
            ids: {
                rayId: 'ray-abc-123', customParam2: 'ray-abc-123',
                pageViewId: null, duid: null, uniqueVisitId: null, customParam1: null, customParam3: null, customParam4: null,
            },
        });
        expect(addRtiResultHeader).toBeUndefined();
    });

    it('forwards a request that is not a reply when RTI allows it', async () => {
        // Arrange
        const request = buildWorkerRequest('/landing', { querystring: 'gclid=abc' });

        // Act
        const { forwarded, originFetch } = await run(request);

        // Assert
        expect(originFetch).toHaveBeenCalledOnce();
        expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=benign');
        expect(challenge).not.toHaveBeenCalled();
    });
});

// --- Which request gets a page, with the real decision logic (README, "Which request gets a page") ---

describe('[integration] cloudflare: which request gets a page on a CAPTCHA verdict', () => {
    let challenge: Mock<NonNullable<CloudflareConfig['challenge']>>;
    let consoleError: ReturnType<typeof vi.spyOn>;

    // Sends a request through the Worker. `forwarded` is the request the origin received, if any.
    async function run(request: Request) {
        const originFetch = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('origin'));
        vi.stubGlobal('fetch', originFetch);
        const response = await worker.fetch(request, {}, buildContext());
        return { response, originFetch, forwarded: originFetch.mock.calls[0]?.[0] };
    }

    beforeEach(() => {
        challenge = vi.fn<NonNullable<CloudflareConfig['challenge']>>().mockResolvedValue(new Response('<html>captcha</html>', { status: 403 }));
        setConfig({ challenge, validateChallenge: vi.fn().mockResolvedValue(false) });
        mockCallRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious' }));
        consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('row 1: a GET with Sec-Fetch-Dest: document is a page load: config.challenge gets this request, and its page is the answer', async () => {
        // Arrange
        const request = buildWorkerRequest('/sofas', { extraHeaders: { 'sec-fetch-dest': 'document' } });

        // Act
        const { response, originFetch } = await run(request);

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        const challenged = challenge.mock.calls[0][0];
        expect(challenged.url).toBe(request.url);
        expect(challenged.method).toBe('GET');
        expect(challenged.headers.get('sec-fetch-dest')).toBe('document');
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('row 2: a GET with Sec-Fetch-Dest: empty and Accept: text/html is not a page load: forwarded with the verdict, no page', async () => {
        // Arrange
        const request = buildWorkerRequest('/sofas', { extraHeaders: { 'sec-fetch-dest': 'empty', accept: 'text/html' } });

        // Act
        const { originFetch, forwarded } = await run(request);

        // Assert: the handler fails open, so the verdict header and the empty error logs show the request was decided,
        // not forwarded after an error
        expect(challenge).not.toHaveBeenCalled();
        expect(originFetch).toHaveBeenCalledOnce();
        expect(forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
        expect(consoleError).not.toHaveBeenCalled();
        expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it('row 14: a malicious verdict with blockingStrategy: CAPTCHA still gets the challenge page for a GET that is not a page load: methods { GET: Action.ALLOW } is not used', async () => {
        // Arrange: the real getAction makes "malicious" a BLOCK, and the real getActionStrategy makes that a CAPTCHA
        setConfig({
            challenge, validateChallenge: vi.fn().mockResolvedValue(false),
            blockingStrategy: ActionStrategy.CAPTCHA, actionOnSuspicious: { methods: { GET: Action.ALLOW } },
        });
        mockCallRTI.mockResolvedValue(buildRTIResponse({ verdict: 'malicious' }));
        const request = buildWorkerRequest('/sofas', { extraHeaders: { 'sec-fetch-dest': 'empty' } });

        // Act
        const { response, originFetch } = await run(request);

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        const [challenged, rtiResponse] = challenge.mock.calls[0];
        expect(challenged.url).toBe(request.url);
        expect(challenged.method).toBe('GET');
        expect(rtiResponse.decision.verdict).toBe('malicious');
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('P1: a GET with Sec-Fetch-Dest: document and Sec-Purpose: prefetch is a prefetch of a page: an empty 403 in place of the challenge page', async () => {
        // Arrange
        const request = buildWorkerRequest('/sofas', { extraHeaders: { 'sec-fetch-dest': 'document', 'sec-purpose': 'prefetch' } });

        // Act
        const { response, originFetch } = await run(request);

        // Assert
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('');
        expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
        expect(challenge).not.toHaveBeenCalled();
        expect(originFetch).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
        expect(mockLoggerError).not.toHaveBeenCalled();
    });
});

describe('[integration] cloudflare Turnstile, end to end', () => {
    const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

    // Sends a request through the Worker. siteverify accepts every token; every other fetch is the origin.
    async function send(request: Request) {
        let forwarded: Request | undefined;
        let originCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: Request | string) => {
            if (input === SITEVERIFY_URL) {
                return new Response(JSON.stringify({ success: true, hostname: 'example.com', action: 'cheq-challenge' }));
            }
            originCalls++;
            forwarded = input as Request;
            return new Response('origin');
        }));
        const response = await worker.fetch(request, {}, buildContext());
        return { response, forwarded, originCalls };
    }

    afterEach(() => {
        vi.restoreAllMocks(); // a test's console spy, also when the test failed
        vi.unstubAllGlobals();
    });

    it('page, solved reply, session, and the original Referer on the landing request', async () => {
        // Arrange
        setConfig({ mode: Mode.BLOCKING, ...createTurnstileChallenge({
            siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'signing-secret', sessionTtlSeconds: 300,
        }) });
        const client = { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'e2e-browser' };

        // Act 1: a suspicious page load gets the challenge page, which carries the query and where the visitor came from
        mockCallRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious' }));
        const page = await send(buildWorkerRequest('/landing', { querystring: 'gclid=abc', extraHeaders: { ...client, referer: 'https://www.google.com/search?q=x' } }));

        // Assert 1
        expect(page.response.status).toBe(403);
        const html = await page.response.text();
        expect(html).toContain('name="original_url" value="/landing?gclid=abc"');
        expect(html).toContain('name="original_referer" value="https://www.google.com/"');
        expect(page.originCalls).toBe(0);

        // Act 2: the solved form comes back as a GET. RTI now says benign: it is still verified and never sent to the origin
        mockCallRTI.mockResolvedValue(buildRTIResponse());
        const query = new URLSearchParams({
            original_url: '/landing?gclid=abc#top', request_id: 'ray-123', original_referer: 'https://www.google.com/', 'cf-turnstile-response': 'tok',
        }).toString();
        const reply = await send(buildWorkerRequest('/landing', { querystring: query, extraHeaders: client }));

        // Assert 2
        expect(reply.response.status).toBe(302);
        expect(reply.response.headers.get('location')).toBe('https://example.com/landing?gclid=abc#top');
        expect(reply.response.headers.get('x-cheq-rti-result')).toContain('verdict=benign');
        expect(reply.originCalls).toBe(0);
        const cookies = reply.response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
        expect(cookies).toMatch(/^_cq_se=[^;]+; _cq_rf=[^;]+$/);

        // Act 3: the landing request: suspicious again, but no CAPTCHA. The origin gets the real verdict and the original Referer
        mockCallRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious' }));
        const landing = await send(buildWorkerRequest('/landing', { querystring: 'gclid=abc', cookies, extraHeaders: client }));

        // Assert 3
        expect(landing.originCalls).toBe(1);
        expect(landing.forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
        expect(landing.forwarded!.headers.get('x-cheq-original-referer')).toBe('https://www.google.com/');
        const rtiPayload = mockCallRTI.mock.calls[mockCallRTI.mock.calls.length - 1][0];
        expect(rtiPayload.endUserParams.headers['x-cheq-original-referer']).toBe('https://www.google.com/');

        // Act 4: the same cookies from another address: the CAPTCHA again, and nothing reaches the origin
        const other = await send(buildWorkerRequest('/landing', { querystring: 'gclid=abc', cookies, extraHeaders: { ...client, 'cf-connecting-ip': '203.0.113.8' } }));

        // Assert 4: the challenge page, not a block page, and the _cq_rf of another client adds no original Referer
        expect(other.response.status).toBe(403);
        expect(await other.response.text()).toContain('name="original_url" value="/landing?gclid=abc"');
        expect(other.originCalls).toBe(0);
        expect(mockCallRTI.mock.calls[mockCallRTI.mock.calls.length - 1][0].endUserParams.headers['x-cheq-original-referer']).toBeUndefined();
    });

    it('RTI fails on the reply: a 302 without x-cheq-rti-result, and its session waives the next CAPTCHA', async () => {
        // Arrange
        vi.spyOn(console, 'error').mockImplementation(() => {}); // the RTI error is logged on purpose
        setConfig({ mode: Mode.BLOCKING, ...createTurnstileChallenge({
            siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'signing-secret', sessionTtlSeconds: 300,
        }) });
        const client = { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'e2e-browser' };
        const query = new URLSearchParams({ original_url: '/landing?gclid=abc', request_id: 'ray-page', 'cf-turnstile-response': 'tok' }).toString();

        // Act 1: the solved form comes back while RTI is down; the request has a valid cf-ray
        mockCallRTI.mockRejectedValue(new Error('RTI timeout'));
        const reply = await send(buildWorkerRequest('/landing', { querystring: query, extraHeaders: { ...client, 'cf-ray': 'ray-abc-123' } }));

        // Assert 1: verified and redirected with a session signed with the stand-in id (the cf-ray value), no verdict
        expect(reply.response.status).toBe(302);
        expect(reply.response.headers.get('location')).toBe('https://example.com/landing?gclid=abc');
        expect(reply.response.headers.get('x-cheq-rti-result')).toBeNull();
        expect(reply.originCalls).toBe(0);
        const setCookies = reply.response.headers.getSetCookie();
        expect(setCookies).toHaveLength(1);
        expect(setCookies[0]).toMatch(/^_cq_se=[^;]+\|ray-abc-123;/);

        // Act 2: RTI is back and says suspicious for the next request of the same client, with the session
        mockCallRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious' }));
        const next = await send(buildWorkerRequest('/landing', { querystring: 'gclid=abc', cookies: setCookies[0].split(';')[0], extraHeaders: client }));

        // Assert 2: no CAPTCHA, the origin gets the request with the real verdict
        expect(next.response.status).toBe(200);
        expect(next.originCalls).toBe(1);
        expect(next.forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
    });

    it('a challenged POST without a Host header: the page for the Referer page, the solved reply, and the POST sent again', async () => {
        // Arrange: the CAPTCHA for a POST (actionOnSuspicious CHALLENGE). None of these requests has a Host header,
        // as a request built by other code may not: the same-site check of the Referer uses the host of the URL
        setConfig({ mode: Mode.BLOCKING, actionOnSuspicious: { methods: { POST: Action.CHALLENGE } }, ...createTurnstileChallenge({
            siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'signing-secret', sessionTtlSeconds: 300,
        }) });
        const client = { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'e2e-browser' };
        const formPage = 'https://example.com/account/login?next=%2Fcart';
        const post = (cookie?: string) => new Request('https://example.com/api/login', {
            method: 'POST', body: 'user=a&pass=b',
            headers: { ...client, 'content-type': 'application/x-www-form-urlencoded', referer: formPage, ...(cookie ? { cookie } : {}) },
        });
        const field = (html: string, name: string) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];
        mockCallRTI.mockResolvedValue(buildRTIResponse({ verdict: 'suspicious' }));

        // Act 1: the suspicious POST gets the challenge page, built for the page the form was on (its Referer)
        const first = post();
        const page = await send(first);

        // Assert 1
        expect(first.headers.get('host')).toBeNull();
        expect(page.response.status).toBe(403);
        const html = await page.response.text();
        expect(field(html, 'original_url')).toBe('/account/login?next=%2Fcart');
        expect(page.originCalls).toBe(0);

        // Act 2: the solved form comes back as a GET (the form has no action, so it goes to the URL the page was
        // shown at, the POST's), with the page's fields and the token
        const query = new URLSearchParams({
            original_url: field(html, 'original_url')!, request_id: field(html, 'request_id')!,
            original_referer: field(html, 'original_referer')!, 'cf-turnstile-response': 'tok',
        }).toString();
        const reply = await send(new Request(`https://example.com/api/login?${query}`, { headers: client }));

        // Assert 2: verified, and sent back to the form page with the session and the original Referer
        expect(reply.response.status).toBe(302);
        expect(reply.response.headers.get('location')).toBe(formPage);
        expect(reply.originCalls).toBe(0);
        const setCookies = reply.response.headers.getSetCookie();
        expect(setCookies.map((cookie) => cookie.split('=')[0])).toEqual(['_cq_se', '_cq_rf']);
        expect(setCookies[1]).toContain('; Path=/account/login;');

        // Act 3: the same POST again, with the cookies of the 302
        const cookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
        const again = await send(post(cookies));

        // Assert 3: the session waives the CAPTCHA, and the origin gets the POST with its body and the verdict
        expect(again.originCalls).toBe(1);
        expect(again.forwarded!.method).toBe('POST');
        expect(await again.forwarded!.text()).toBe('user=a&pass=b');
        expect(again.forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
    });
});
