/**
 * Generates an HTML block page to return to the client when a request is denied.
 *
 * @param status - HTTP status code to display (e.g. "403", "404"). Must be non-empty.
 * @param title - Human-readable status title (e.g. "Access Denied"). Must be non-empty.
 * @param rtiId - RTI reference ID (ray ID) used for tracking and support. Must be non-empty.
 * @param additionalCdnId - Optional CDN-specific request ID (e.g. CloudFront x-amz-cf-id).
 *                          When provided, rendered as a secondary reference box on the page.
 * @returns Full HTML page as a string.
 * @throws {Error} If any of the mandatory params (status, title, rtiId) are empty.
 */
export function generateDefaultBlockPage(status: string, title: string, rtiId: string, additionalCdnId?: string | null): string {
    if (!status || !title || !rtiId) {
        throw new Error(`generateDefaultBlockPage: missing required params (status=${status}, title=${title}, rtiId=${rtiId})`);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${status} ${title}</title>
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
        <div class="status">${status}</div>
        <h1>${title}</h1>
        <p>Access to this resource has been denied by security policy.</p>
        <div class="ref-box">
            <div class="ref-label">Reference ID</div>
            <div class="ref-id">${rtiId}</div>
        </div>
        ${additionalCdnId ? `<div class="ref-box">  <!-- The specific CDN unique request Id (may not be present for some CDNs) -->
            <div class="ref-label">Additional Platform ID</div> 
            <div class="ref-id">${additionalCdnId}</div>
        </div>` : ''}
    </div>
</body>
</html>`;
}
