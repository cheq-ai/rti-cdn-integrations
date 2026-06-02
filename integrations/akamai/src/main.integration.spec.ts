// cspell:ignore PMUSER CHEQ duid pvid
/// <reference path="./types.d.ts" />
import { vi, beforeEach } from 'vitest';
import { Mode } from '../../core/models/mode.model';

const { mockCallRTI, integrationConfig } = vi.hoisted(() => {
    const mockCallRTI = vi.fn();
    // Mode.BLOCKING = 1. Using the raw value here since imports are not available in vi.hoisted.
    const integrationConfig: Record<string, any> = {
        mode: 1,
        apiKey: 'test-api-key',
        tagHash: 'test-tag-hash',
        rtiHost: 'rti.example.com',
        debug: false,
        telemetry: false,
        redirectLocation: 'https://www.cheq.ai/',
        ignorePaths: [],
        timeout: 300,
        rtiLoggerHost: undefined,
        challenge: undefined,
        validateChallenge: undefined,
        blockTTCodes: undefined,
        redirectTTCodes: undefined,
        blockingStrategy: undefined,
        challengingStrategy: undefined,
    };
    return { mockCallRTI, integrationConfig };
});

vi.mock('log', () => ({ log: { log: vi.fn() } }));

vi.mock('./config', () => ({
    config: integrationConfig,
    // buildDynamicConfig is never called in integration tests — we don't inject PMUSER_CHEQ_USE_DYNAMIC_CONFIG.
    buildDynamicConfig: vi.fn().mockReturnValue(integrationConfig),
}));

// Mock only the network boundary — callRTI.
// RTIHelperService is NOT mocked, so real decision logic runs.
vi.mock('./rti-service', () => ({ callRTI: mockCallRTI }));

vi.mock('./rti-logger', () => ({ logToRTI: vi.fn() }));

vi.mock('../../core/helpers/block-page-helpers', () => ({
    generateDefaultBlockPage: vi.fn().mockReturnValue('<html>blocked</html>'),
}));

import { onClientRequest } from './main';
import type { IntegrationTestAdapter, IntegrationNormalizedResult, IntegrationInvokeOptions } from '../../core/testing/integration-test-adapter.interface';
import { registerSharedIntegrationTests } from '../../core/testing/shared-integration-tests';
import { buildRTIResponse } from '../../core/testing/rti-response.fixture';

function buildRequest(path = '/page', opts: {
    cookies?: string;
    querystring?: string;
    clientIp?: string;
    method?: string;
    headers?: Record<string, string>;
} = {}): EWRequest {
    const url = `${path}${opts.querystring ? '?' + opts.querystring : ''}`;
    return {
        host: 'example.com',
        path,
        url,
        method: opts.method ?? 'GET',
        scheme: 'https',
        clientIp: opts.clientIp ?? '1.2.3.4',
        userLocation: undefined,
        getHeader: vi.fn((name: string) => {
            if (name === 'Cookie' && opts.cookies) return [opts.cookies];
            if (name === 'host') return ['example.com'];
            if (name === 'user-agent') return ['Mozilla/5.0'];
            if (opts.headers?.[name]) return [opts.headers[name]];
            return [];
        }),
        getHeaders: vi.fn(() => ({})),
        setHeader: vi.fn(),
        addHeader: vi.fn(),
        removeHeader: vi.fn(),
        getVariable: vi.fn(() => undefined),
        setVariable: vi.fn(),
        respondWith: vi.fn(),
    } as unknown as EWRequest;
}

const akamaiIntegrationAdapter: IntegrationTestAdapter = {
    name: 'akamai',

    async invoke(options: IntegrationInvokeOptions = {}): Promise<IntegrationNormalizedResult> {
        const req = buildRequest(options.path ?? '/page', {
            cookies: options.cookies,
            querystring: options.querystring,
            clientIp: options.ip,
            method: options.method,
            headers: options.headers,
        });

        const callsBefore = mockCallRTI.mock.calls.length;
        await onClientRequest(req);

        const respondWithCalls = vi.mocked(req.respondWith).mock.calls;
        if (respondWithCalls.length > 0) {
            const [status, rawHeaders, body] = respondWithCalls[respondWithCalls.length - 1];
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
                headers[k.toLowerCase()] = v;
            }
            if ((rawHeaders as any)['Location']) headers['location'] = (rawHeaders as any)['Location'];
            const rtiPayload = mockCallRTI.mock.calls.length > callsBefore
                ? mockCallRTI.mock.calls[mockCallRTI.mock.calls.length - 1]?.[0]
                : undefined;
            return { status: status as number, headers, body: body as string, passedThrough: false, rtiPayload };
        }

        // Pass-through: respondWith was not called
        const setHeaderCalls = vi.mocked(req.setHeader).mock.calls;
        const rtiHeader = setHeaderCalls.find(([name]) => name === 'x-cheq-rti-result')?.[1] as string | undefined;
        const rtiPayload = mockCallRTI.mock.calls.length > callsBefore
            ? mockCallRTI.mock.calls[mockCallRTI.mock.calls.length - 1]?.[0]
            : undefined;
        return {
            status: 200,
            headers: rtiHeader ? { 'x-cheq-rti-result': rtiHeader } : {},
            body: '',
            passedThrough: true,
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
    const defaults: Record<string, any> = {
        mode: Mode.BLOCKING,
        apiKey: 'test-api-key',
        tagHash: 'test-tag-hash',
        rtiHost: 'rti.example.com',
        debug: false,
        telemetry: false,
        redirectLocation: 'https://www.cheq.ai/',
        ignorePaths: [],
        timeout: 300,
        rtiLoggerHost: undefined,
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

beforeEach(() => {
    vi.clearAllMocks();
    mockCallRTI.mockResolvedValue(buildRTIResponse());
});

registerSharedIntegrationTests(akamaiIntegrationAdapter, setConfig);
