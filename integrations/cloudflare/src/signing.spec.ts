import { describe, it, expect } from 'vitest';
import { clientIp, hmacHex32, sessionBindingKey, SessionBinding } from './signing';
import { sessionBindingKey as exampleSessionBindingKey } from './turnstile-challenge-example';

describe('hmacHex32', () => {
    it('gives the first 32 hex characters of HMAC-SHA256 (the value checked with Node\'s createHmac)', async () => {
        // Act
        const signature = await hmacHex32('key', 'The quick brown fox jumps over the lazy dog');

        // Assert
        expect(signature).toBe('f7bc83f430538424b13298e6aa6fb143');
    });
});

describe('clientIp', () => {
    it('reads CF-Connecting-IP', () => {
        // Arrange
        const request = new Request('https://example.com/page', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });

        // Act & Assert
        expect(clientIp(request)).toBe('1.2.3.4');
    });

    it('gives null without CF-Connecting-IP', () => {
        // Arrange
        const request = new Request('https://example.com/page', { headers: { 'X-Real-IP': '1.2.3.4' } });

        // Act & Assert
        expect(clientIp(request)).toBeNull();
    });
});

describe('sessionBindingKey', () => {
    it('gives the same key from ./signing and from ./turnstile-challenge-example, which exports it too', () => {
        // Arrange
        const settings: { sessionBinding: SessionBinding } = { sessionBinding: { ip: 'exact', userAgent: true } };
        const request = new Request('https://example.com/page', { headers: { 'CF-Connecting-IP': '1.2.3.4', 'User-Agent': 'Mozilla/5.0' } });

        // Act
        const fromSigning = sessionBindingKey(settings, request);
        const fromExample = exampleSessionBindingKey(settings, request);

        // Assert
        expect(fromSigning).toBe('["1.2.3.4","Mozilla/5.0"]');
        expect(fromExample).toBe(fromSigning);
    });
});
