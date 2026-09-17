import { Ids } from "../models/rti-response.model";

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
function escapeHtml(value: string): string {
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

/**
 * Generates an HTML block page to return to the client when a request is denied.
 *
 * @param status - HTTP status code to display (e.g. "403", "404"). Must be non-empty.
 * @param title - Human-readable status title (e.g. "Access Denied"). Must be non-empty.
 * @param rtiIds - RTI Ids object used for tracking and support.
 * @param additionalCdnId - Optional CDN-specific request ID (e.g. CloudFront x-amz-cf-id).
 *                          When provided, rendered as a secondary reference box on the page.
 * @returns Full HTML page as a string.
 */
export function generateDefaultBlockPage(status: string, title: string, rtiIds: Ids, additionalCdnId?: string | null): string {
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(status)} ${escapeHtml(title)}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #070F18;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #E2E8F0;
            padding: 20px;
        }
        .card {
            background: linear-gradient(135deg, #0D1B2A 0%, rgba(13, 27, 42, 0.9) 100%);
            border: 1px solid rgba(239, 68, 68, 0.3);
            border-radius: 16px;
            padding: 48px 40px;
            max-width: 480px;
            width: 100%;
            text-align: center;
        }
        h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 8px; color: #FCA5A5; }
        .status { font-size: 4rem; font-weight: 800; color: rgba(239, 68, 68, 0.4); margin-bottom: 16px; }
        p { color: #94A3B8; font-size: 1rem; line-height: 1.6; margin-bottom: 32px; }
        .ref-box {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            padding: 12px 16px;
            margin-bottom: 12px;
            text-align: left;
        }
        .ref-label { font-size: 0.75rem; color: #94A3B8; letter-spacing: 0.05em; margin-bottom: 4px; }
        .ref-id { font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 0.8rem; color: #00D4AA; word-break: break-all; }
        .footer { margin-top: 24px; font-size: 0.75rem; color: #94A3B8; }
        .footer a { color: #00D4AA; text-decoration: none; }
    </style>
</head>
<body>
    <div class="card">
        <div class="status">${escapeHtml(status)}</div>
        <h1>${escapeHtml(title)}</h1>
        <p>Access to this resource has been denied by security policy.</p>
        <div class="ref-box">
            <div class="ref-label">${rtiIdsDisplayHeader}</div>
            <div class="ref-id">${rtiIdsDisplay}</div>
        </div>
        ${additionalCdnId ? `<div class="ref-box">  <!-- The specific CDN unique request Id (may not be present for some CDNs) -->
            <div class="ref-label">Additional Platform ID</div>
            <div class="ref-id">${escapeHtml(additionalCdnId)}</div>
        </div>` : ''}
    </div>
</body>
</html>`;
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
