// cspell:ignore cheqzone
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    httpRequest: vi.fn(),
}));

vi.mock('http-request', () => ({
    httpRequest: mocks.httpRequest,
}));

import { callRTI } from './rti-service';
import { RTIRequest } from '../../core/models/rti-request.model';

function buildPayload(overrides: Partial<RTIRequest> = {}): RTIRequest {
    return {
        tagHash: 'tag-hash',
        apiKey: 'api-key',
        channel: 'akamai-cdn-integration',
        endUserParams: {
            clientIp: '1.2.3.4',
            requestUrl: 'https://example.com/page',
            headerNames: 'user-agent',
            method: 'GET',
            headers: { 'user-agent': 'Mozilla/5.0' },
        },
        ...overrides,
    };
}

function buildHttpResponse(status: number, body: unknown) {
    return {
        status,
        json: vi.fn().mockResolvedValue(body),
        text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    };
}

describe('callRTI', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sends a POST to /defend/4.1/traffic', async () => {
        // Arrange
        mocks.httpRequest.mockResolvedValue(buildHttpResponse(200, {}));

        // Act
        await callRTI(buildPayload(), 'rti-proxy.example.com', 300);

        // Assert
        expect(mocks.httpRequest).toHaveBeenCalledWith('/defend/4.1/traffic', expect.objectContaining({
            method: 'POST',
        }));
    });

    it('sets Host and Content-Type headers', async () => {
        // Arrange
        mocks.httpRequest.mockResolvedValue(buildHttpResponse(200, {}));

        // Act
        await callRTI(buildPayload(), 'rti-proxy.example.com', 300);

        // Assert
        expect(mocks.httpRequest).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            headers: expect.objectContaining({
                'Host': 'rti-proxy.example.com',
                'Content-Type': 'application/json',
            }),
        }));
    });

    it('sends the payload as JSON body', async () => {
        // Arrange
        mocks.httpRequest.mockResolvedValue(buildHttpResponse(200, {}));
        const payload = buildPayload();

        // Act
        await callRTI(payload, 'rti-proxy.example.com', 300);

        // Assert
        const options = mocks.httpRequest.mock.calls[0][1];
        expect(options.body).toBe(JSON.stringify(payload));
    });

    it('passes the timeout option', async () => {
        // Arrange
        mocks.httpRequest.mockResolvedValue(buildHttpResponse(200, {}));

        // Act
        await callRTI(buildPayload(), 'rti-proxy.example.com', 500);

        // Assert
        expect(mocks.httpRequest).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            timeout: 500,
        }));
    });

    it('returns parsed JSON on 2xx response', async () => {
        // Arrange
        const rtiResponse = { decision: { verdict: 'benign' }, classification: { code: 0 } };
        mocks.httpRequest.mockResolvedValue(buildHttpResponse(200, rtiResponse));

        // Act
        const result = await callRTI(buildPayload(), 'rti-proxy.example.com', 300);

        // Assert
        expect(result).toEqual(rtiResponse);
    });

    it('throws with status and body on 4xx response', async () => {
        // Arrange
        mocks.httpRequest.mockResolvedValue(buildHttpResponse(400, 'bad request'));

        // Act & Assert
        await expect(callRTI(buildPayload(), 'rti-proxy.example.com', 300))
            .rejects.toThrow('400');
    });

    it('throws with status and body on 5xx response', async () => {
        // Arrange
        mocks.httpRequest.mockResolvedValue(buildHttpResponse(503, 'service unavailable'));

        // Act & Assert
        await expect(callRTI(buildPayload(), 'rti-proxy.example.com', 300))
            .rejects.toThrow('503');
    });
});
