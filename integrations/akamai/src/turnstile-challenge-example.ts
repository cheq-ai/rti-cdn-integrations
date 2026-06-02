import { httpRequest } from 'http-request';
import { RTIResponse } from '../../core/models/rti-response.model';

// The Turnstile verify API hostname must be proxied through Akamai.
// Configure an Akamai property that forwards this host to challenges.cloudflare.com.
const TURNSTILE_VERIFY_HOST = 'REPLACE_ME'; // e.g. "turnstile-proxy.your-domain.com"

const TURNSTILE_SITE_KEY = 'REPLACE_ME';
const TURNSTILE_SECRET = 'REPLACE_ME';
const SESSION_TTL_SECONDS = 300; // 5 minutes

function buildChallengeHtml(requestUrl: string, rayId: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Security Verification | CHEQ</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: #070F18;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: #E2E8F0;
        padding: 20px;
    }
    .bg-pattern {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background-image:
            radial-gradient(circle at 20% 50%, rgba(0, 212, 170, 0.08) 0%, transparent 50%),
            radial-gradient(circle at 80% 20%, rgba(124, 58, 237, 0.08) 0%, transparent 50%),
            radial-gradient(circle at 40% 80%, rgba(0, 212, 170, 0.05) 0%, transparent 40%);
        pointer-events: none; z-index: 0;
    }
    .container { position: relative; z-index: 1; text-align: center; max-width: 480px; width: 100%; }
    .card {
        background: linear-gradient(135deg, #0D1B2A 0%, rgba(13, 27, 42, 0.9) 100%);
        border: 1px solid rgba(0, 212, 170, 0.2);
        border-radius: 16px; padding: 48px 40px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.3), 0 10px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05);
    }
    .logo { margin-bottom: 32px; }
    .icon { margin-bottom: 24px; }
    h1 {
        font-size: 1.75rem; font-weight: 700; margin-bottom: 12px;
        background: linear-gradient(135deg, #E2E8F0 0%, #94A3B8 100%);
        -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    }
    .subtitle { color: #94A3B8; font-size: 1rem; line-height: 1.6; margin-bottom: 32px; }
    .ref-box {
        background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px; padding: 12px 16px; margin-top: 24px;
    }
    .ref-label { font-size: 0.75rem; color: #94A3B8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
    .ref-id { font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 0.8rem; color: #00D4AA; word-break: break-all; }
    .footer { margin-top: 24px; font-size: 0.75rem; color: #94A3B8; }
    .footer a { color: #00D4AA; text-decoration: none; }
    .captcha-box { background: rgba(0,0,0,0.2); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
    .cf-turnstile { display: flex; justify-content: center; }
    .btn {
        width: 100%; padding: 14px 24px; font-size: 1rem; font-weight: 600; color: #0D1B2A;
        background: linear-gradient(135deg, #00D4AA 0%, #00B894 100%);
        border: none; border-radius: 8px; cursor: pointer; transition: all 0.2s;
        box-shadow: 0 4px 12px rgba(0,212,170,0.3);
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .loading { display: none; margin-top: 16px; color: #94A3B8; font-size: 0.9rem; }
    .loading.show { display: block; }
</style>
</head>
<body>
<div class="bg-pattern"></div>
<div class="container">
    <div class="card">
    <div class="logo"><svg width="120" height="40" viewBox="0 0 120 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M20 8C12.268 8 6 14.268 6 22s6.268 14 14 14 14-6.268 14-14S27.732 8 20 8zm0 24c-5.523 0-10-4.477-10-10s4.477-10 10-10 10 4.477 10 10-4.477 10-10 10z" fill="#00D4AA"/>
    <path d="M20 14c-4.418 0-8 3.582-8 8s3.582 8 8 8 8-3.582 8-8-3.582-8-8-8zm3.707 6.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-2-2a1 1 0 111.414-1.414L19 23.586l3.293-3.293a1 1 0 011.414 0z" fill="#00D4AA"/>
    <text x="42" y="28" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700" fill="#00D4AA">CHEQ</text>
    </svg></div>
    <div class="icon"><svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M40 6L12 18v18c0 16.6 11.94 32.12 28 36 16.06-3.88 28-19.4 28-36V18L40 6z" fill="url(#sg)" opacity="0.2"/>
    <path d="M40 10L16 20v14c0 14.14 10.18 27.38 24 30.72 13.82-3.34 24-16.58 24-30.72V20L40 10z" stroke="url(#sg)" stroke-width="3" fill="none"/>
    <path d="M36 40l-6-6 3-3 3 3 9-9 3 3-12 12z" fill="#00D4AA"/>
    <defs><linearGradient id="sg" x1="40" y1="6" x2="40" y2="72" gradientUnits="userSpaceOnUse">
    <stop stop-color="#00D4AA"/><stop offset="1" stop-color="#7C3AED"/>
    </linearGradient></defs>
    </svg></div>
    <h1>Security Verification</h1>
    <p class="subtitle">Please complete the verification below to confirm you're human and continue to the website.</p>
    <form id="captcha-form" action="${requestUrl}" method="GET">
        <input type="hidden" name="original_url" value="${encodeURIComponent(requestUrl)}">
        <input type="hidden" name="request_id" value="${rayId}">
        <div class="captcha-box">
        <div class="cf-turnstile"
            data-sitekey="${TURNSTILE_SITE_KEY}"
            data-callback="onTurnstileSuccess"
            data-theme="dark">
        </div>
        </div>
        <button type="submit" id="submit-btn" class="btn" disabled>Continue to Website</button>
        <div id="loading" class="loading">Verifying...</div>
    </form>
    <div class="ref-box">
        <div class="ref-label">Session ID</div>
        <div class="ref-id">${rayId}</div>
    </div>
    </div>
    <div class="footer">Protected by <a href="https://cheq.ai" target="_blank" rel="noopener">CHEQ</a> Security</div>
</div>
<script>
function onTurnstileSuccess(token) { document.getElementById('submit-btn').disabled = false; }
document.getElementById('captcha-form').addEventListener('submit', function() {
    document.getElementById('submit-btn').disabled = true;
    document.getElementById('loading').classList.add('show');
});
</script>
</body>
</html>`;
}

/**
 * Serves the Turnstile challenge page, or verifies the token and sets a session cookie.
 *
 * Flow:
 *  1. No token in query string → serve Turnstile HTML page (form submits as GET with ?cf-turnstile-response=...)
 *  2. Token present → verify with Turnstile API via httpRequest → on success, set _cq_se cookie + redirect to original URL
 */
export const turnstileChallengeExample = async (
    request: EWRequest,
    rtiResponse: RTIResponse,
): Promise<{ html: string; headers: Record<string, string> }> => {
    const queryString = request.url.includes('?') ? request.url.split('?')[1] : '';
    const params = new URLSearchParams(queryString);
    const token = params.get('cf-turnstile-response');

    if (!token) {
        const requestUrl = `${request.scheme}://${request.host}${request.url}`;
        return {
            html: buildChallengeHtml(requestUrl, rtiResponse.ids.rayId),
            headers: {
                'Content-Type': 'text/html;charset=UTF-8',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
            },
        };
    }

    // Verify token with Turnstile API (host must be Akamai-proxied)
    const verifyBody = new URLSearchParams({
        secret: TURNSTILE_SECRET,
        response: token,
        remoteip: request.clientIp,
    }).toString();

    const verifyResponse = await httpRequest('/turnstile/v0/siteverify', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Host': TURNSTILE_VERIFY_HOST,
            'Content-Length': verifyBody.length.toString(),
        },
        body: verifyBody,
        timeout: 3000,
    });

    const result = await verifyResponse.json() as { success: boolean };
    if (result.success) {
        const expiresAt = Date.now() + (SESSION_TTL_SECONDS * 1000);
        const data = `${expiresAt}:${rtiResponse.ids.rayId}`;
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const signature = hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
        const sessionToken = `${expiresAt}.${signature}`;

        const originalUrl = params.get('original_url');
        const redirectTo = originalUrl ? decodeURIComponent(originalUrl) : `${request.scheme}://${request.host}${request.path}`;

        return {
            html: '',
            headers: {
                'Location': redirectTo,
                'Set-Cookie': `_cq_se=${sessionToken}|${rtiResponse.ids.rayId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`,
            },
        };
    }

    return {
        html: 'Verification failed. Please try again.',
        headers: { 'Content-Type': 'text/plain' },
    };
};

/**
 * Validates the _cq_se session cookie set after a successful Turnstile challenge.
 * Returns true if valid and unexpired — RTI check is skipped for this request.
 */
export const turnstileValidateChallengeExample = async (request: EWRequest): Promise<boolean> => {
    const cookieHeader = request.getHeader('Cookie');
    const cookieStr = cookieHeader && cookieHeader.length > 0 ? cookieHeader[0] : '';
    const cookies = cookieStr.split(';').map(c => c.trim());

    const seValue = cookies.find(c => c.startsWith('_cq_se='))?.substring('_cq_se='.length);
    if (!seValue) return false;

    const parts = seValue.split('|');
    const cookieToken = parts[0];
    const cookieRayId = parts[1];
    if (!cookieToken || !cookieRayId) return false;

    try {
        const [expiresAtStr, signature] = cookieToken.split('.');
        if (!expiresAtStr || !signature) return false;

        const expiresAt = parseInt(expiresAtStr, 10);
        if (isNaN(expiresAt) || Date.now() > expiresAt) return false;

        const data = `${expiresAt}:${cookieRayId}`;
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const expectedSignature = hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');

        return signature === expectedSignature;
    } catch {
        return false;
    }
};
