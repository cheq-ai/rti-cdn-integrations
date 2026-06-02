// cspell:ignore duid pvid
import { vi, beforeEach } from 'vitest';
import { Mode } from '../../core/models/mode.model';
import type { CloudFrontRequestEvent } from 'aws-lambda';

const { mockCallRTI, integrationConfig } = vi.hoisted(() => {
    const mockCallRTI = vi.fn();
    // Mode.BLOCKING = 1. Using the raw value here since imports are not available in vi.hoisted.
    const integrationConfig: Record<string, any> = {
        mode: 1,
        apiKey: 'test-api-key',
        tagHash: 'test-tag-hash',
        debug: false,
        telemetry: false,
        redirectLocation: 'https://www.cheq.ai/',
        ignorePaths: [],
        keepHeadersNames: [],
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

import { handle, RequestType } from './request-helper';
import type { IntegrationTestAdapter, IntegrationNormalizedResult, IntegrationInvokeOptions } from '../../core/testing/integration-test-adapter.interface';
import { registerSharedIntegrationTests } from '../../core/testing/shared-integration-tests';
import { buildRTIResponse } from '../../core/testing/rti-response.fixture';

function buildEvent(uri = '/page', opts: {
    cookies?: string;
    querystring?: string;
    clientIp?: string;
    method?: string;
    extraHeaders?: Record<string, string>;
} = {}): CloudFrontRequestEvent {
    const headers: Record<string, any> = {
        host: [{ key: 'Host', value: 'example.com' }],
        'user-agent': [{ key: 'User-Agent', value: 'Mozilla/5.0' }],
    };
    if (opts.cookies) headers['cookie'] = [{ key: 'Cookie', value: opts.cookies }];
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
                    clientIp: opts.clientIp ?? '1.2.3.4',
                    method: opts.method ?? 'GET',
                    uri,
                    querystring: opts.querystring ?? '',
                    headers,
                },
            },
        }],
    } as CloudFrontRequestEvent;
}

const cloudfrontIntegrationAdapter: IntegrationTestAdapter = {
    name: 'cloudfront',

    async invoke(options: IntegrationInvokeOptions = {}): Promise<IntegrationNormalizedResult> {
        const event = buildEvent(options.path ?? '/page', {
            cookies: options.cookies,
            querystring: options.querystring,
            clientIp: options.ip,
            method: options.method,
            extraHeaders: options.headers,
        });
        const cfRequest = event.Records[0].cf.request;

        const callsBefore = mockCallRTI.mock.calls.length;
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Pass-through: the original cfRequest object was returned
        if (result === cfRequest) {
            const rtiHeader = (cfRequest.headers?.['x-cheq-rti-result'] as any)?.[0]?.value;
            return {
                status: 200,
                headers: rtiHeader ? { 'x-cheq-rti-result': rtiHeader } : {},
                body: '',
                passedThrough: true,
                rtiPayload: mockCallRTI.mock.calls.length > callsBefore
                    ? mockCallRTI.mock.calls[mockCallRTI.mock.calls.length - 1]?.[0]
                    : undefined,
            };
        }

        // Block/redirect: a response object was returned
        const cfResult = result as any;
        const status = parseInt(cfResult.status ?? '200', 10);
        const headers: Record<string, string> = {};
        if (cfResult.headers) {
            for (const [key, values] of Object.entries(cfResult.headers as Record<string, any[]>)) {
                headers[key.toLowerCase()] = values.map((v: any) => v.value).join(', ');
            }
        }
        const rtiPayload = mockCallRTI.mock.calls.length > callsBefore
            ? mockCallRTI.mock.calls[mockCallRTI.mock.calls.length - 1]?.[0]
            : undefined;
        return {
            status,
            headers,
            body: cfResult.body ?? '',
            passedThrough: false,
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
        debug: false,
        telemetry: false,
        redirectLocation: 'https://www.cheq.ai/',
        ignorePaths: [],
        keepHeadersNames: [],
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

registerSharedIntegrationTests(cloudfrontIntegrationAdapter, setConfig);
