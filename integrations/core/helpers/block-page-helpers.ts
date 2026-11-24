// cspell:ignore CHEQ
import { Ids } from "../models/rti-response.model";
import { BlockPageSettings } from "../models/block-page.model";
import { CHEQ_LOGO, PAGE_FOOTER, PAGE_STYLE } from "./page-look";

/**
 * Escapes a value for safe interpolation into HTML text content.
 *
 * Block pages interpolate RTI-supplied ids and caller-supplied status/title strings. Those are
 * trusted today, but a block page is exactly the wrong place to rely on that: any path that ever
 * feeds attacker-influenced data in (e.g. a request id read back from a cookie) would otherwise
 * turn this into an XSS sink. Escaping unconditionally keeps that impossible.
 *
 * `&` must be replaced first, otherwise it would double-escape the entities added after it.
 */
export function escapeHtml(value: string): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 403 page - dark scanline background, animated radar sweep with pulsing core, and an
 * INCIDENT_ID panel with labelled REQUEST / SESSION ids. Minified to fit the byte budget;
 * keep the CSS minified if you edit it.
 */
function cyberHudPage(status: string, title: string, ref: string): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(status)} ${escapeHtml(title)}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0811 repeating-linear-gradient(0deg,#ffffff05 0 1px,#0000 1px 4px);color:#e8e8ee;font-family:monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.c{width:100%;max-width:430px;background:#12101af2;border:1px solid #f0448030;border-radius:12px;padding:42px 34px 34px;text-align:center}.r{width:96px;height:96px;margin:0 auto 26px;position:relative}.r u{position:absolute;inset:0;border:1px solid #f0448038;border-radius:50%}.r u:before{content:"";position:absolute;inset:16px;border:1px dashed #f0448026;border-radius:50%}.r b{position:absolute;inset:3px;border-radius:50%;background:conic-gradient(#0000 76%,#f04480b3);animation:s 2.2s linear infinite}@keyframes s{to{transform:rotate(360deg)}}.r s{position:absolute;top:50%;left:50%;width:7px;height:7px;margin:-3.5px;background:#f04480;border-radius:50%;animation:p 2.2s infinite}@keyframes p{50%{box-shadow:0 0 0 10px #f0448026}}h1{font-size:1.8rem;font-weight:800;color:#fff;margin-bottom:13px}p{font-size:.82rem;line-height:1.7;color:#9a9aab;margin-bottom:26px}.f{border-top:1px solid #f0448022;padding-top:15px;text-align:left}.l{display:block;font-size:.58rem;letter-spacing:3px;color:#f04480}.i{font-size:.78rem;color:#fff;word-break:break-all}.i em{font-style:normal;display:block;font-size:.55rem;letter-spacing:2px;color:#f0448099;margin-top:7px}</style></head><body><div class="c"><div class="r"><u></u><b></b><s></s></div><h1>${escapeHtml(title)}</h1><p>Automated security analysis flagged this request. If you believe this is an error, contact the site owner with the IDs below.</p><div class="f"><span class="l">INCIDENT_ID</span><div class="i">${ref}</div></div></div></body></html>`;
}

/**
 * 404 page - a plain, unbranded "Page Not Found" that gives a bot no hint it was detected.
 *
 * Deliberately takes no arguments: the caller's `title` is NOT interpolated here. Stealth must
 * not depend on the caller passing innocuous text - a caller passing e.g. "Blocked by security"
 * would otherwise defeat the whole point of this page.
 */
function stealth404Page(): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 - Page Not Found</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center}.c{text-align:center;padding:40px 20px}.e{font-size:120px;font-weight:700;color:#e5e5e5;line-height:1;margin-bottom:16px}h1{font-size:24px;color:#333;margin-bottom:8px;font-weight:600}p{color:#666;margin-bottom:24px}a{display:inline-block;color:#0066cc;text-decoration:none;padding:12px 24px;border:1px solid #0066cc;border-radius:6px}a:hover{background:#0066cc;color:#fff}</style></head><body><div class="c"><div class="e">404</div><h1>Page Not Found</h1><p>The page you're looking for doesn't exist or has been moved.</p><a href="/">Return Home</a></div></body></html>`;
}

/** The sentence under the heading of the block page, when the settings give no message. */
const BLOCK_MESSAGE = 'Access to this resource has been denied by security policy.';

/**
 * The block page's own CSS, minified, after PAGE_STYLE: the gray status number above the heading, the sentence, and
 * the light gray boxes of the ids. The heading and the sentence may break a long word of the settings, such as an
 * address (`overflow-wrap:anywhere`), as the ids may (`word-break:break-all`). Without it, a heading of one word of 60
 * characters made the page scroll sideways in a frame 360px wide (headless Chrome, 2026-11-24).
 */
const BLOCK_STYLE = '.status{margin-top:24px;font-size:48px;font-weight:800;line-height:1;color:#7b8794}'
    + 'h1{margin-top:8px;overflow-wrap:anywhere}p{margin:0 0 24px;color:#52606d;overflow-wrap:anywhere}'
    + '.ref-box{margin-bottom:12px;padding:12px 16px;border:1px solid #e4e7eb;'
    + 'border-radius:8px;background:#f5f7fa;text-align:left}.ref-label{margin-bottom:4px;font-size:12px;'
    + 'letter-spacing:.05em;color:#616e7c}.ref-id{font:13px/1.5 "SF Mono",Monaco,"Courier New",monospace;'
    + 'word-break:break-all}';

/**
 * Generates an HTML block page to return to the client when a request is denied: a white page in the look of the
 * interstitial page (page-look.ts). It shows, in this order, the logo, the status number, the heading, the sentence,
 * the box of the RTI ids, the box of the CDN's id when there is one, and the footer "Protected by Cheq.ai".
 * A missing status or title gives "500 Internal Server Error". The headline setting does not replace these words: only
 * the other settings apply then.
 *
 * @param status - HTTP status code to display (e.g. "403", "404"). Must be non-empty.
 * @param title - Human-readable status title (e.g. "Access Denied"). Must be non-empty.
 * @param rtiIds - RTI Ids object used for tracking and support.
 * @param additionalCdnId - Optional CDN-specific request ID (e.g. CloudFront x-amz-cf-id).
 *                          When provided, rendered as a secondary reference box on the page.
 * @param settings - Optional: the settings of `config.blockPage`, as readBlockPageSettings gives them. A setting that
 *                   is given and not empty replaces its default: logoUrl CHEQ's logo, headline the title (in `<title>`
 *                   too), message the sentence, lang "en". Left out: the page without settings. Each one is
 *                   HTML-escaped, also one that was not checked.
 * @returns Full HTML page as a string.
 */
export function generateDefaultBlockPage(status: string, title: string, rtiIds: Ids, additionalCdnId?: string | null,
    settings?: BlockPageSettings): string {
    // The headline setting replaces the title, but not the "Internal Server Error" of a missing status or title.
    const headlineSetting = status && title ? settings?.headline : undefined;
    if (!status || !title) {
        status = '500';
        title = 'Internal Server Error';
    }

    let rtiIdsDisplay: string;
    let rtiIdsDisplayHeader: string = 'Reference ID';

    if (!rtiIds) {
        rtiIdsDisplay = `no ids available`;
    } else {
        if (rtiIds.pageViewId) {
            rtiIdsDisplayHeader = rtiIdsDisplayHeader + 's';
            rtiIdsDisplay = `rayId: ${escapeHtml(rtiIds.rayId)}<br>pageViewId: ${escapeHtml(rtiIds.pageViewId)}`;
        }
        else {
            rtiIdsDisplay = escapeHtml(rtiIds.rayId);
        }
    }

    const headline = escapeHtml(headlineSetting || title);
    const logo = settings?.logoUrl ? `<img src="${escapeHtml(settings.logoUrl)}" alt="">` : CHEQ_LOGO;
    // The specific CDN unique request id (may not be present for some CDNs).
    const cdnIdBox = additionalCdnId
        ? '<div class="ref-box"><div class="ref-label">Additional Platform ID</div>'
            + `<div class="ref-id">${escapeHtml(additionalCdnId)}</div></div>`
        : '';

    return `<!DOCTYPE html><html lang="${escapeHtml(settings?.lang || 'en')}"><head><meta charset="UTF-8">`
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + `<title>${escapeHtml(status)} ${headline}</title><style>${PAGE_STYLE}${BLOCK_STYLE}</style></head><body><main>`
        + `${logo}<div class="status">${escapeHtml(status)}</div><h1>${headline}</h1>`
        + `<p>${escapeHtml(settings?.message || BLOCK_MESSAGE)}</p>`
        + `<div class="ref-box"><div class="ref-label">${rtiIdsDisplayHeader}</div><div class="ref-id">${rtiIdsDisplay}</div></div>`
        + `${cdnIdBox}${PAGE_FOOTER}</main></body></html>`;
}

/**
 * Compact block page for runtimes with a response-body size cap - currently Akamai EdgeWorkers,
 * whose `request.respondWith()` bodies are capped at 2048 bytes in `onClientRequest`. Exceeding
 * that makes respondWith() throw, the worker fails open, and NO block happens - which is what
 * the full-size {@link generateDefaultBlockPage} did in every scenario. Keep these pages under
 * the cap; block-page-helpers.spec.ts enforces it.
 *
 * @param status - HTTP status code. "404" selects the stealth page; anything else gets the 403-style page.
 * @param title - Human-readable title, rendered on the non-404 page. Ignored for 404 (see {@link stealth404Page}).
 * @param rtiIds - RTI Ids for the incident reference. When absent the reference reads "n/a".
 */
export function generateCompactBlockPage(status: string, title: string, rtiIds?: Ids): string {
    if (!status || !title) {
        status = '500';
        title = 'Internal Server Error';
    }

    if (status === '404') {
        return stealth404Page();
    }

    // REQUEST = per-request detection id (rayId, always present);
    // SESSION = page-view/session id (pageViewId, only when the visitor had CHEQ session cookies)
    const ref = rtiIds
        ? `<em>REQUEST</em>${escapeHtml(rtiIds.rayId)}` +
          (rtiIds.pageViewId ? `<em>SESSION</em>${escapeHtml(rtiIds.pageViewId)}` : '')
        : 'n/a';

    return cyberHudPage(status, title, ref);
}
