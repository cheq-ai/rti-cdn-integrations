// cspell:ignore duid pvid
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { Mode } from '../../core/models/mode.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
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

// Mock only the network boundary — RTIHttpsService.callRTI.
// RTIHelperService is NOT mocked, so real decision logic runs.
vi.mock('../../core/services/rti-https.service', () => ({
    RTIHttpsService: vi.fn().mockImplementation(function () { return { callRTI: mockCallRTI }; }),
}));

vi.mock('../../core/services/rti-https-logger.service', () => ({
    RTIHttpsLoggerService: vi.fn().mockImplementation(function () {
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
import { createTurnstileChallenge } from './turnstile-challenge-example';

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
        isChallengeResponse: undefined,
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

beforeEach(() => {
    vi.clearAllMocks();
    mockCallRTI.mockResolvedValue(buildRTIResponse());
});

registerSharedIntegrationTests(cloudfrontIntegrationAdapter, setConfig);

// --- Challenge reply with the real decision logic (verdict → action → strategy → isChallengeReplyAllowed) ---

describe('[integration] cloudfront challenge reply', () => {
    const replyQuery = new URLSearchParams({ original_url: '/landing?gclid=abc', request_id: 'ray-page', 'cf-turnstile-response': 'tok' }).toString();
    const replyEvent = () => buildEvent('/landing', { querystring: replyQuery });
    const challengeResult = { status: '302', headers: { location: [{ key: 'Location', value: 'https://example.com/landing?gclid=abc' }] } };

    // The shipped Turnstile reply detector
    const { isChallengeResponse } = createTurnstileChallenge({
        siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'signing-secret', sessionTtlSeconds: 300,
    });

    let challenge: ReturnType<typeof vi.fn>;
    let validateChallenge: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        challenge = vi.fn().mockResolvedValue(challengeResult);
        validateChallenge = vi.fn().mockResolvedValue(true); // a valid session must not waive a reply
        setConfig({ challenge, validateChallenge, isChallengeResponse });
    });

    afterEach(() => {
        vi.restoreAllMocks();
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
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(challengeResult);
        expect(challenge).toHaveBeenCalledOnce();
        const [request, response, addRtiResultHeader] = challenge.mock.calls[0];
        expect(request).toBe(event.Records[0].cf.request);
        expect(response.decision.verdict).toBe(verdict);
        const headers: Record<string, any> = {};
        addRtiResultHeader(headers);
        expect(headers['x-cheq-rti-result'][0].value).toContain(`verdict=${verdict}`);
        expect(validateChallenge).not.toHaveBeenCalled();
    });

    it.each([
        ['malicious, default blockingStrategy (ACCESS_DENIED)', '403', 'malicious', {}],
        ['malicious, blockingStrategy NOT_FOUND', '404', 'malicious', { blockingStrategy: ActionStrategy.NOT_FOUND }],
        ['malicious, blockingStrategy REDIRECT', '302', 'malicious', { blockingStrategy: ActionStrategy.REDIRECT }],
        ['suspicious, challengingStrategy ACCESS_DENIED', '403', 'suspicious', { challengingStrategy: ActionStrategy.ACCESS_DENIED }],
        ['suspicious, challengingStrategy NOT_FOUND', '404', 'suspicious', { challengingStrategy: ActionStrategy.NOT_FOUND }],
        ['benign with a redirectTTCodes match', '302', 'benign', { redirectTTCodes: [42] }],
        ['benign with a blockTTCodes match', '403', 'benign', { blockTTCodes: [42] }],
    ] as const)('still enforces a reply that is %s (returns %s)', async (_, status, verdict, overrides) => {
        // Arrange
        setConfig({ challenge, validateChallenge, isChallengeResponse, ...overrides });
        mockCallRTI.mockResolvedValue(buildRTIResponse({ verdict, code: 42 }));

        // Act
        const result = await handle(replyEvent(), RequestType.ORIGIN_REQUEST) as any;

        // Assert
        expect(result.status).toBe(status);
        if (status === '302') {
            expect(result.headers.location[0].value).toBe('https://www.cheq.ai/'); // config.redirectLocation, not original_url
        }
        expect(challenge).not.toHaveBeenCalled();
    });

    it('forwards a malicious reply unchanged in MONITORING mode', async () => {
        // Arrange
        setConfig({ challenge, validateChallenge, isChallengeResponse, mode: Mode.MONITORING });
        mockCallRTI.mockResolvedValue(buildRTIResponse({ verdict: 'malicious' }));
        const event = replyEvent();

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.querystring).toBe(replyQuery);
        expect(challenge).not.toHaveBeenCalled();
    });

    it('passes a reply to config.challenge when RTI fails, with a stand-in response', async () => {
        // Arrange
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mockCallRTI.mockRejectedValue(new Error('RTI timeout'));

        // Act
        const result = await handle(replyEvent(), RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(challengeResult);
        const [, response, addRtiResultHeader] = challenge.mock.calls[0];
        // Not an RTI answer: only the CloudFront request id, as rayId (it signs the example's session) and as customParam2
        // (as customId2 in the normal RTI payload). No verdict, classification or other ids.
        expect(response).toEqual({
            ids: {
                rayId: 'req-123', customParam2: 'req-123',
                pageViewId: null, duid: null, uniqueVisitId: null, customParam1: null, customParam3: null, customParam4: null,
            },
        });
        expect(addRtiResultHeader).toBeUndefined();
    });

    it('forwards a request that is not a reply when RTI allows it', async () => {
        // Arrange
        const event = buildEvent('/landing', { querystring: 'gclid=abc' });

        // Act
        const result = await handle(event, RequestType.ORIGIN_REQUEST);

        // Assert
        expect(result).toBe(event.Records[0].cf.request);
        expect(event.Records[0].cf.request.headers['x-cheq-rti-result']?.[0].value).toContain('verdict=benign');
        expect(challenge).not.toHaveBeenCalled();
    });
});
