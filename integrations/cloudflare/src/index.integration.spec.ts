// cspell:ignore duid pvid
import { vi, beforeEach } from 'vitest';
import { Mode } from '../../core/models/mode.model';

const { mockCallRTI, integrationConfig } = vi.hoisted(() => {
    const mockCallRTI = vi.fn();
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
    return { mockCallRTI, integrationConfig };
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
        return { info: vi.fn().mockResolvedValue(undefined), error: vi.fn().mockResolvedValue(undefined) };
    }),
}));

vi.mock('../../core/helpers/block-page-helpers', () => ({
    generateDefaultBlockPage: vi.fn().mockReturnValue('<html>blocked</html>'),
}));

import worker from './index';
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
        const response = await worker.fetch(request, {}, buildContext());
        vi.unstubAllGlobals();

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
        blockTTCodes: undefined,
        redirectTTCodes: undefined,
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
