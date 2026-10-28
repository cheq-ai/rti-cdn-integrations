// cspell:ignore cheq
// The redaction rules (cookieNames, redactHeaderValue, the RTI payload) are tested in core's rti-stateless-utils.spec.ts.
// This covers only what is CloudFront's: the event's `name → [{ key, value }]` header shape.
import { describe, it, expect } from 'vitest';
import type { CloudFrontRequestEvent } from 'aws-lambda';
import { stringifyRedactedEvent } from './log-redaction';
import { RTIStatelessUtils } from '../../core/services/rti-stateless-utils';

const utils = new RTIStatelessUtils();

const buildEvent = (headers: Record<string, unknown>) => ({
    Records: [{ cf: { config: { requestId: 'req-1' }, request: { clientIp: '1.2.3.4', method: 'GET', uri: '/', querystring: '', headers } } }],
}) as unknown as CloudFrontRequestEvent;

describe('stringifyRedactedEvent', () => {
    it('redacts the request headers: cookie names per header line, the session token and credentials', () => {
        // Arrange
        const event = buildEvent({
            cookie: [{ key: 'Cookie', value: 'a=secret1; b=secret2' }, { key: 'Cookie', value: 'c=secret3' }],
            'x-cheq-challenge': [{ key: 'X-Cheq-Challenge', value: 'tok' }],
            authorization: [{ key: 'Authorization', value: 'Bearer sk' }],
            'proxy-authorization': [{ key: 'Proxy-Authorization', value: 'Basic pk' }],
            'user-agent': [{ key: 'User-Agent', value: 'UA' }],
        });

        // Act
        const logged = JSON.parse(stringifyRedactedEvent(event, utils));

        // Assert
        expect(logged.Records[0].cf.request.headers).toEqual({
            cookie: [{ key: 'Cookie', value: 'a, b' }, { key: 'Cookie', value: 'c' }],
            'x-cheq-challenge': [{ key: 'X-Cheq-Challenge', value: '[REDACTED]' }],
            authorization: [{ key: 'Authorization', value: '[REDACTED]' }],
            'proxy-authorization': [{ key: 'Proxy-Authorization', value: '[REDACTED]' }],
            'user-agent': [{ key: 'User-Agent', value: 'UA' }],
        });
    });

    it('keeps everything outside the headers as it is', () => {
        // Arrange
        const event = buildEvent({ cookie: [{ key: 'Cookie', value: 'a=1' }] });

        // Act
        const logged = JSON.parse(stringifyRedactedEvent(event, utils));

        // Assert
        expect(logged.Records[0].cf.config).toEqual({ requestId: 'req-1' });
        expect(logged.Records[0].cf.request).toMatchObject({ clientIp: '1.2.3.4', method: 'GET', uri: '/', querystring: '' });
    });

    it('changes nothing but the logged string (the event is neither changed nor copied into it)', () => {
        // Arrange
        const headers = { cookie: [{ key: 'Cookie', value: 'a=secret' }] };
        const event = buildEvent(headers);
        const before = JSON.stringify(event);

        // Act
        stringifyRedactedEvent(event, utils);

        // Assert
        expect(JSON.stringify(event)).toBe(before);
        expect(event.Records[0].cf.request.headers).toBe(headers);
        expect(headers.cookie[0].value).toBe('a=secret');
    });

    it('equals JSON.stringify when there is nothing to redact', () => {
        // Arrange
        const event = buildEvent({ host: [{ key: 'Host', value: 'shop.com' }] });

        // Act & Assert
        expect(stringifyRedactedEvent(event, utils)).toBe(JSON.stringify(event));
    });

    it('keeps entries of unexpected shapes as they are', () => {
        // Arrange
        const event = buildEvent({ cookie: [null, 'raw', { key: 'Cookie' }, { key: 'Cookie', value: 42 }], count: 3, flags: null });

        // Act & Assert
        expect(stringifyRedactedEvent(event, utils)).toBe(JSON.stringify(event));
    });

    it.each(['custom', 's3'])('redacts every origin custom header value (origin.%s.customHeaders), keeping the names', (originType) => {
        // Arrange: an origin-request event; the operator's headers for the origin often hold a shared secret
        const event = buildEvent({ host: [{ key: 'Host', value: 'origin.example.com' }] });
        (event.Records[0].cf.request as any).origin = {
            [originType]: {
                domainName: 'origin.example.com',
                customHeaders: {
                    'x-origin-verify': [{ key: 'X-Origin-Verify', value: 'shared-secret-1' }],
                    'x-api-key': [{ key: 'X-Api-Key', value: 'shared-secret-2' }, { key: 'X-Api-Key', value: 'shared-secret-3' }],
                    'x-plain': [{ key: 'X-Plain', value: 'not-secret-but-redacted-too' }],
                },
            },
        };

        // Act
        const logged = stringifyRedactedEvent(event, utils);

        // Assert
        expect(logged).not.toMatch(/shared-secret|not-secret/);
        expect(JSON.parse(logged).Records[0].cf.request.origin[originType]).toEqual({
            domainName: 'origin.example.com',
            customHeaders: {
                'x-origin-verify': [{ key: 'X-Origin-Verify', value: '[REDACTED]' }],
                'x-api-key': [{ key: 'X-Api-Key', value: '[REDACTED]' }, { key: 'X-Api-Key', value: '[REDACTED]' }],
                'x-plain': [{ key: 'X-Plain', value: '[REDACTED]' }],
            },
        });
        // the request headers keep their own rules
        expect(JSON.parse(logged).Records[0].cf.request.headers.host).toEqual([{ key: 'Host', value: 'origin.example.com' }]);
    });

    it('keeps an empty customHeaders map and origin fields as they are', () => {
        // Arrange
        const event = buildEvent({});
        (event.Records[0].cf.request as any).origin = { custom: { domainName: 'o.example.com', port: 443, protocol: 'https', customHeaders: {} } };

        // Act & Assert
        expect(stringifyRedactedEvent(event, utils)).toBe(JSON.stringify(event));
    });

    it('does not change the event when redacting customHeaders', () => {
        // Arrange
        const customHeaders = { 'x-origin-verify': [{ key: 'X-Origin-Verify', value: 'shared-secret' }] };
        const event = buildEvent({});
        (event.Records[0].cf.request as any).origin = { custom: { customHeaders } };

        // Act
        stringifyRedactedEvent(event, utils);

        // Assert
        expect(customHeaders['x-origin-verify'][0].value).toBe('shared-secret');
    });

    it('leaves a "headers" key that is not a map alone', () => {
        // Arrange
        const event = { a: { headers: ['cookie=a=1'] }, b: { headers: 'cookie: a=1' } } as unknown as CloudFrontRequestEvent;

        // Act & Assert
        expect(stringifyRedactedEvent(event, utils)).toBe(JSON.stringify(event));
    });
});
