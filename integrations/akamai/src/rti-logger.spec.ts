// cspell:ignore cheqzone rtilogger
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    httpRequest: vi.fn(),
    logLog: vi.fn(),
}));

vi.mock('http-request', () => ({
    httpRequest: mocks.httpRequest,
}));

vi.mock('log', () => ({
    log: { log: mocks.logLog },
}));

import { logToRTI } from './rti-logger';

describe('logToRTI', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.httpRequest.mockResolvedValue({ status: 200 });
    });

    it('sends a POST to /log with a JSON body', async () => {
        // Act
        await logToRTI('info', 'rti_duration: 42', 'my-app', 'api-key', 'tag-hash', 'logger.example.com');

        // Assert
        expect(mocks.httpRequest).toHaveBeenCalledWith('/log', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ level: 'info', message: 'rti_duration: 42', action: undefined, application: 'my-app', apiKey: 'api-key', tagHash: 'tag-hash' }),
        }));
    });

    it('includes action in the JSON body when provided', async () => {
        // Act
        await logToRTI('error', 'some error', 'my-app', 'api-key', 'tag-hash', 'logger.example.com', 'BLOCK');

        // Assert
        expect(mocks.httpRequest).toHaveBeenCalledWith('/log', expect.objectContaining({
            body: JSON.stringify({ level: 'error', message: 'some error', action: 'BLOCK', application: 'my-app', apiKey: 'api-key', tagHash: 'tag-hash' }),
        }));
    });

    it('sets Host header to rtiLoggerHost', async () => {
        // Act
        await logToRTI('error', 'some error', 'my-app', 'api-key', 'tag-hash', 'logger.example.com');

        // Assert
        expect(mocks.httpRequest).toHaveBeenCalledWith('/log', expect.objectContaining({
            headers: expect.objectContaining({ 'Host': 'logger.example.com' }),
        }));
    });

    it('sets timeout to 1000', async () => {
        // Act
        await logToRTI('info', 'msg', 'app', 'k', 'h', 'host.example.com');

        // Assert
        expect(mocks.httpRequest).toHaveBeenCalledWith('/log', expect.objectContaining({ timeout: 1000 }));
    });

    it('does not throw when httpRequest rejects', async () => {
        // Arrange
        mocks.httpRequest.mockRejectedValue(new Error('network failure'));

        // Act & Assert
        await expect(logToRTI('error', 'msg', 'app', 'k', 'h', 'host.example.com')).resolves.toBeUndefined();
    });

    it('does not throw when httpRequest throws synchronously', async () => {
        // Arrange
        mocks.httpRequest.mockImplementation(() => { throw new Error('sync failure'); });

        // Act & Assert
        await expect(logToRTI('error', 'msg', 'app', 'k', 'h', 'host.example.com')).resolves.toBeUndefined();
    });

    it('logs the error message via log.log when httpRequest rejects', async () => {
        // Arrange
        mocks.httpRequest.mockRejectedValue(new Error('network failure'));

        // Act
        await logToRTI('error', 'msg', 'app', 'k', 'h', 'host.example.com');

        // Assert
        expect(mocks.logLog).toHaveBeenCalledWith('[cheq] logToRTI error:', 'network failure');
    });

    it('logs the error message via log.log when httpRequest throws synchronously', async () => {
        // Arrange
        mocks.httpRequest.mockImplementation(() => { throw new Error('sync failure'); });

        // Act
        await logToRTI('error', 'msg', 'app', 'k', 'h', 'host.example.com');

        // Assert
        expect(mocks.logLog).toHaveBeenCalledWith('[cheq] logToRTI error:', 'sync failure');
    });

    it('logs String(e) when httpRequest rejects with a non-Error value', async () => {
        // Arrange
        mocks.httpRequest.mockRejectedValue('plain string thrown');

        // Act
        await logToRTI('error', 'msg', 'app', 'k', 'h', 'host.example.com');

        // Assert
        expect(mocks.logLog).toHaveBeenCalledWith('[cheq] logToRTI error:', 'plain string thrown');
    });
});
