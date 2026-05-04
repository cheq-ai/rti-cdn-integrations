import { describe, it, expect } from 'vitest';
import { generateDefaultBlockPage } from './block-page-helpers';

describe('generateDefaultBlockPage', () => {

    // --- Required params validation ---

    it('throws when status is empty', () => {
        expect(() => generateDefaultBlockPage('', 'Access Denied', 'ray-123'))
            .toThrow('generateDefaultBlockPage: missing required params');
    });

    it('throws when title is empty', () => {
        expect(() => generateDefaultBlockPage('403', '', 'ray-123'))
            .toThrow('generateDefaultBlockPage: missing required params');
    });

    it('throws when rtiId is empty', () => {
        expect(() => generateDefaultBlockPage('403', 'Access Denied', ''))
            .toThrow('generateDefaultBlockPage: missing required params');
    });

    // --- HTML content ---

    it('includes status in <title> and .status div', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', 'ray-123');
        expect(html).toContain('<title>403 Access Denied</title>');
        expect(html).toContain('<div class="status">403</div>');
    });

    it('includes title in <h1>', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', 'ray-123');
        expect(html).toContain('<h1>Access Denied</h1>');
    });

    it('includes rtiId in reference box', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', 'ray-abc-456');
        expect(html).toContain('ray-abc-456');
    });

    it('returns valid HTML document', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', 'ray-123');
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('</html>');
    });

    // --- additionalCdnId ---

    it('includes additional CDN ID box when provided', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', 'ray-123', 'cdn-req-456');
        expect(html).toContain('cdn-req-456');
        expect(html).toContain('Additional Platform ID');
    });

    it('omits additional CDN ID box when not provided', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', 'ray-123');
        expect(html).not.toContain('Additional Platform ID');
    });

    it('omits additional CDN ID box when null', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', 'ray-123', null);
        expect(html).not.toContain('Additional Platform ID');
    });

    // --- Values are correctly interpolated (not mixed up) ---

    it('does not mix up status, title and rtiId values', () => {
        const html = generateDefaultBlockPage('404', 'Not Found', 'unique-ray-id');
        expect(html).toContain('<div class="status">404</div>');
        expect(html).toContain('<h1>Not Found</h1>');
        expect(html).toContain('unique-ray-id');
        expect(html).not.toContain('<h1>404</h1>');
        expect(html).not.toContain('<div class="status">Not Found</div>');
    });
});
