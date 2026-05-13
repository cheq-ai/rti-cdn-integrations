import { describe, it, expect } from 'vitest';
import { generateDefaultBlockPage } from './block-page-helpers';
import { Ids } from '../models/rti-response.model';

const rayOnlyIds: Ids = { rayId: 'ray-123', pageViewId: null, duid: null, uniqueVisitId: null };
const fullIds: Ids = { rayId: 'ray-abc', pageViewId: 'pv-456', duid: null, uniqueVisitId: null };

describe('generateDefaultBlockPage', () => {

    // --- Missing status/title fallback ---

    it('falls back to 500 Internal Server Error when status is empty', () => {
        const html = generateDefaultBlockPage('', 'Access Denied', rayOnlyIds);
        expect(html).toContain('<title>500 Internal Server Error</title>');
        expect(html).toContain('<div class="status">500</div>');
    });

    it('falls back to 500 Internal Server Error when title is empty', () => {
        const html = generateDefaultBlockPage('403', '', rayOnlyIds);
        expect(html).toContain('<title>500 Internal Server Error</title>');
    });

    // --- Missing rtiIds ---

    it('shows "no ids available" when rtiIds is null', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', null as unknown as Ids);
        expect(html).toContain('no ids available');
    });

    // --- HTML content ---

    it('includes status in <title> and .status div', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', rayOnlyIds);
        expect(html).toContain('<title>403 Access Denied</title>');
        expect(html).toContain('<div class="status">403</div>');
    });

    it('includes title in <h1>', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', rayOnlyIds);
        expect(html).toContain('<h1>Access Denied</h1>');
    });

    it('returns valid HTML document', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', rayOnlyIds);
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('</html>');
    });

    // --- Reference ID display ---

    it('shows only rayId when pageViewId is absent', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', rayOnlyIds);
        expect(html).toContain('ray-123');
        expect(html).not.toContain('pageViewId');
        expect(html).toContain('Reference ID');
        expect(html).not.toContain('Reference IDs');
    });

    it('shows rayId and pageViewId when pageViewId is present', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', fullIds);
        expect(html).toContain('ray-abc');
        expect(html).toContain('pv-456');
        expect(html).toContain('Reference IDs');
    });

    // --- additionalCdnId ---

    it('includes additional CDN ID box when provided', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', rayOnlyIds, 'cdn-req-456');
        expect(html).toContain('cdn-req-456');
        expect(html).toContain('Additional Platform ID');
    });

    it('omits additional CDN ID box when not provided', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', rayOnlyIds);
        expect(html).not.toContain('Additional Platform ID');
    });

    it('omits additional CDN ID box when null', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', rayOnlyIds, null);
        expect(html).not.toContain('Additional Platform ID');
    });

    // --- Values are correctly interpolated (not mixed up) ---

    it('does not mix up status, title and rtiId values', () => {
        const ids: Ids = { rayId: 'unique-ray-id', pageViewId: null, duid: null, uniqueVisitId: null };
        const html = generateDefaultBlockPage('404', 'Not Found', ids);
        expect(html).toContain('<div class="status">404</div>');
        expect(html).toContain('<h1>Not Found</h1>');
        expect(html).toContain('unique-ray-id');
        expect(html).not.toContain('<h1>404</h1>');
        expect(html).not.toContain('<div class="status">Not Found</div>');
    });
});
