import { describe, it, expect } from 'vitest';
import { generateDefaultBlockPage, generateCompactBlockPage } from './block-page-helpers';
import { PAGE_FOOTER } from './page-look';
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

describe('generateDefaultBlockPage, the white look and the settings', () => {

    // --- The look, with no settings ---

    it('is white, with the logo, the sentence and the footer, and no image', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', fullIds, 'cdn-1');
        for (const part of ['<html lang="en">', 'background:#fff', 'fill="#FE0072"', PAGE_FOOTER,
            'Access to this resource has been denied by security policy.']) {
            expect(html).toContain(part);
        }
        expect(html).toContain('rayId: ray-abc<br>pageViewId: pv-456');
        expect(html.toLowerCase()).not.toContain('#070f18');
        expect(html).not.toContain('<img');
    });

    it('lets the heading and the sentence break a long word (overflow-wrap:anywhere)', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', rayOnlyIds);
        const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
        // A rule for h1 or p that starts after the end of the rule before it, and holds the value.
        expect(style).toMatch(/}h1\{[^}]*overflow-wrap:anywhere/);
        expect(style).toMatch(/}p\{[^}]*overflow-wrap:anywhere/);
    });

    it('gives the same page for no settings, an empty block and a block of undefined values', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', fullIds, 'cdn-1');
        expect(generateDefaultBlockPage('403', 'Access Denied', fullIds, 'cdn-1', {})).toBe(html);
        expect(generateDefaultBlockPage('403', 'Access Denied', fullIds, 'cdn-1',
            { logoUrl: undefined, headline: undefined, message: undefined, lang: undefined })).toBe(html);
    });

    // --- The settings ---

    it('shows the image of logoUrl, the headline, the message and the language in place of the defaults', () => {
        const html = generateDefaultBlockPage('403', 'Access Denied', rayOnlyIds, null,
            { logoUrl: 'https://cdn.example/l.svg?a=1&b=2', headline: 'Stop', message: 'Not for you.', lang: 'de' });
        for (const part of ['<html lang="de">', '<title>403 Stop</title>', '<h1>Stop</h1>', 'Not for you.',
            '<img src="https://cdn.example/l.svg?a=1&amp;b=2" alt="">', '<div class="status">403</div>']) {
            expect(html).toContain(part);
        }
        expect(html).not.toContain('<svg');
        expect(html).not.toContain('Access Denied');
        expect(html).not.toContain('denied by security policy');
    });

    it('escapes each setting, also one that was not checked', () => {
        const text = `<script>alert(1)</script>"'&`;
        const html = generateDefaultBlockPage('403', 'Access Denied', rayOnlyIds, null,
            { logoUrl: text, headline: text, message: text, lang: text });
        // lang, the image, <title>, <h1> and the message
        expect(html.split('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;').length - 1).toBe(5);
        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('<script');
    });

    it('shows the headline and the status 404 on the 404 page', () => {
        const html = generateDefaultBlockPage('404', 'Not Found', rayOnlyIds, null, { headline: 'Gone' });
        expect(html).toContain('<div class="status">404</div>');
        expect(html).toContain('<h1>Gone</h1>');
        expect(html).toContain('<title>404 Gone</title>');
        expect(html).not.toContain('Not Found');
    });

    it.each([
        ['status', '', 'Access Denied'],
        ['title', '403', ''],
    ])('keeps "500 Internal Server Error", not the headline, when the %s is empty', (_label, status, title) => {
        const html = generateDefaultBlockPage(status, title, rayOnlyIds, null,
            { logoUrl: 'https://cdn.example/l.svg', headline: 'Stop', message: 'Not for you.', lang: 'de' });
        for (const part of ['<title>500 Internal Server Error</title>', '<div class="status">500</div>',
            '<h1>Internal Server Error</h1>', '<html lang="de">', '<img src="https://cdn.example/l.svg" alt="">',
            'Not for you.']) {
            expect(html).toContain(part);
        }
        expect(html).not.toContain('Stop');
    });

    // --- The size ---

    const idsOf64: Ids = { ...fullIds, rayId: 'f'.repeat(64), pageViewId: 'e'.repeat(64) };
    const logoUrlOf200 = 'https://cdn.example/l.svg?' + '&'.repeat(200 - 'https://cdn.example/l.svg?'.length);
    const longestSettings = {
        logoUrl: logoUrlOf200, headline: '"'.repeat(60), message: '"'.repeat(160), lang: 'en-abcdefgh-abcdefgh-abcdefgh-abcde',
    };

    // A logoUrl makes the page smaller: its <img> takes the place of the inline logo. So the third row is the largest.
    it.each([
        ['the longest settings', longestSettings],
        ['no settings', undefined],
        ['the longest settings but no logoUrl, so the inline logo', { ...longestSettings, logoUrl: undefined }],
    ])('stays below 12288 bytes with ids and a CDN id of 64 characters and %s', (_label, settings) => {
        const html = generateDefaultBlockPage('403', 'Access Denied', idsOf64, 'c'.repeat(64), settings);
        expect(Object.values(longestSettings).map(value => value.length)).toEqual([200, 60, 160, 35]);
        expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(12288);
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
