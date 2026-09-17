import { describe, it, expect } from 'vitest';
import { generateDefaultBlockPage, generateCompactBlockPage } from './block-page-helpers';
import { Ids } from '../models/rti-response.model';

const rayOnlyIds: Ids = {
    rayId: 'ray-123',
    pageViewId: null,
    duid: null,
    uniqueVisitId: null,
    customParam1: null,
    customParam2: null,
    customParam3: null,
    customParam4: null,
};
const fullIds: Ids = {
    rayId: 'ray-abc',
    pageViewId: 'pv-456',
    duid: null,
    uniqueVisitId: null,
    customParam1: null,
    customParam2: null,
    customParam3: null,
    customParam4: null,
};

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
        const ids: Ids = {
            rayId: 'unique-ray-id',
            pageViewId: null,
            duid: null,
            uniqueVisitId: null,
            customParam1: null,
            customParam2: null,
            customParam3: null,
            customParam4: null,
        };
        const html = generateDefaultBlockPage('404', 'Not Found', ids);
        expect(html).toContain('<div class="status">404</div>');
        expect(html).toContain('<h1>Not Found</h1>');
        expect(html).toContain('unique-ray-id');
        expect(html).not.toContain('<h1>404</h1>');
        expect(html).not.toContain('<div class="status">Not Found</div>');
    });
});

// Akamai hard limit for request.respondWith() bodies in onClientRequest. Exceeding it makes
// respondWith() throw, so the EdgeWorker fails open and NO block happens.
const AKAMAI_RESPOND_WITH_LIMIT = 2048;

const worstCaseIds: Ids = {
    rayId: 'f'.repeat(32),
    pageViewId: 'e'.repeat(36),
    duid: null,
    uniqueVisitId: null,
    customParam1: null,
    customParam2: null,
    customParam3: null,
    customParam4: null,
};

describe('generateCompactBlockPage', () => {

    // --- Akamai respondWith byte budget (the whole reason this variant exists) ---

    it('403 page stays under the Akamai respondWith limit with worst-case ids', () => {
        const html = generateCompactBlockPage('403', 'Access Denied', worstCaseIds);
        expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(AKAMAI_RESPOND_WITH_LIMIT);
    });

    it('404 page stays under the Akamai respondWith limit', () => {
        const html = generateCompactBlockPage('404', 'Not Found', worstCaseIds);
        expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(AKAMAI_RESPOND_WITH_LIMIT);
    });

    // --- Incident reference ---

    it('403 page contains the incident reference ids', () => {
        const html = generateCompactBlockPage('403', 'Access Denied', worstCaseIds);
        expect(html).toContain(worstCaseIds.rayId);
        expect(html).toContain(worstCaseIds.pageViewId as string);
        expect(html).toContain('INCIDENT_ID');
    });

    it('403 page shows n/a when ids are missing', () => {
        const html = generateCompactBlockPage('403', 'Access Denied');
        expect(html).toContain('n/a');
    });

    it('403 page omits the SESSION label when pageViewId is absent', () => {
        const html = generateCompactBlockPage('403', 'Access Denied', { ...worstCaseIds, pageViewId: null });
        expect(html).toContain('REQUEST');
        expect(html).not.toContain('SESSION');
    });

    // --- title parameter is honoured on the non-404 page ---

    it('403 page renders the supplied title in <title> and <h1>', () => {
        const html = generateCompactBlockPage('403', 'Access Denied', worstCaseIds);
        expect(html).toContain('<title>403 Access Denied</title>');
        expect(html).toContain('<h1>Access Denied</h1>');
    });

    it('403 page reflects a different status and title', () => {
        const html = generateCompactBlockPage('401', 'Unauthorized', worstCaseIds);
        expect(html).toContain('<title>401 Unauthorized</title>');
        expect(html).toContain('<h1>Unauthorized</h1>');
    });

    it('falls back to 500 Internal Server Error when status or title is empty', () => {
        expect(generateCompactBlockPage('', 'Access Denied', worstCaseIds)).toContain('<h1>Internal Server Error</h1>');
        expect(generateCompactBlockPage('403', '', worstCaseIds)).toContain('<h1>Internal Server Error</h1>');
    });

    // --- 404 stealth must not depend on caller-supplied text ---

    it('404 page is stealth - no CHEQ or security branding', () => {
        const html = generateCompactBlockPage('404', 'Not Found', worstCaseIds);
        expect(html).not.toMatch(/cheq|security|blocked|incident/i);
        expect(html).toContain('Page Not Found');
    });

    it('404 page ignores the supplied title so stealth cannot be broken by the caller', () => {
        const html = generateCompactBlockPage('404', 'Blocked by security policy', worstCaseIds);
        expect(html).not.toContain('Blocked by security policy');
        expect(html).not.toMatch(/blocked|security/i);
        expect(html).toContain('Page Not Found');
    });

    it('404 page does not leak the incident ids', () => {
        const html = generateCompactBlockPage('404', 'Not Found', worstCaseIds);
        expect(html).not.toContain(worstCaseIds.rayId);
    });
});

describe('HTML escaping', () => {

    const xss = '<img src=x onerror=alert(1)>';

    it('escapes ids in the compact page', () => {
        const html = generateCompactBlockPage('403', 'Access Denied', { ...worstCaseIds, rayId: xss });
        expect(html).not.toContain(xss);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('escapes the title in the compact page', () => {
        const html = generateCompactBlockPage('403', xss, worstCaseIds);
        expect(html).not.toContain(xss);
        expect(html).toContain('&lt;img');
    });

    it('escapes ids in the default page', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', { ...worstCaseIds, rayId: xss });
        expect(html).not.toContain(xss);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('escapes additionalCdnId in the default page', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', worstCaseIds, xss);
        expect(html).not.toContain(xss);
        expect(html).toContain('&lt;img');
    });

    it('escapes & before the entities it introduces (no double-escaping)', () => {
        const html = generateCompactBlockPage('403', 'Access Denied', { ...worstCaseIds, rayId: 'a&b<c' });
        expect(html).toContain('a&amp;b&lt;c');
        expect(html).not.toContain('&amp;lt;');
    });

    // `Ids` types rayId as a required string, but it is parsed from an RTI JSON response - a
    // field the service omits arrives as undefined regardless of what the type says. Without the
    // `?? ''` guard, String(undefined) renders the literal word "undefined" to the visitor as
    // their incident reference. The cast is the point of the test: it reproduces a shape the
    // compiler believes cannot happen.
    it.each([
        ['undefined', undefined],
        ['null', null],
    ])('renders an empty reference, not the word "undefined", when rayId is %s', (_label, rayId) => {
        const ids = { ...worstCaseIds, rayId } as unknown as Ids;

        const compact = generateCompactBlockPage('403', 'Access Denied', ids);
        const full = generateDefaultBlockPage('403', 'Access Denied', ids);

        expect(compact).not.toContain('undefined');
        expect(compact).not.toContain('null');
        expect(full).not.toContain('undefined');
        expect(full).not.toContain('null');
    });
});
