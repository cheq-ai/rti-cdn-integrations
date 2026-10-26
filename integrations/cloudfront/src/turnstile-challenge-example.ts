// cspell:ignore cheq siteverify duid unkeyed
import { CloudFrontHeaders, CloudFrontRequest, CloudFrontRequestResult, CloudFrontResponseResult } from "aws-lambda";
import { createHmac, timingSafeEqual } from "node:crypto";
import { RTIResponse } from "../../core/models/rti-response.model";
import type { CloudfrontConfig } from "./config";

/** Settings for the example Turnstile challenge, set in config.ts. */
export interface TurnstileSettings {
    /** Site key from the Cloudflare Turnstile dashboard. */
    siteKey: string;
    /** Secret key from the Turnstile dashboard, sent to Cloudflare's siteverify endpoint. */
    secretKey: string;
    /**
     * Signs the `_cq_se` session cookie so it cannot be forged. NOT the Turnstile secret: any long random
     * string, e.g. `openssl rand -hex 32`. Changing it invalidates every session (visitors are challenged again).
     */
    sessionSigningSecret: string;
    /** How long a solved challenge is remembered, in seconds. */
    sessionTtlSeconds: number;
}

const isPlaceholder = (value: string | undefined): boolean => !value || value.trim() === "" || value.trim() === "REPLACE_ME";

/**
 * Accepts `original_url` only when it is a same-site absolute path (as Akamai's reCAPTCHA challenge does).
 * It arrives as a query parameter, so any link can carry any value. Reflected into `Location` it would turn a
 * PASSED challenge into an open redirect: a strong phishing tool, since the victim really did just prove they
 * are human on the genuine site. `//host` and `/\host` are rejected too: browsers read both as protocol-relative.
 * Returns undefined so the caller falls back to the request URI.
 */
function safeReturnPath(raw: string | null | undefined): string | undefined {
    if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
        return undefined;
    }
    return raw;
}

const DEFAULT_SESSION_TTL_SECONDS = 300;

// Escapes a value for an HTML text node or a quoted attribute. Every value put into the challenge page goes
// through it: the URI comes from the client, and a raw `"` there would otherwise close the attribute and
// let the rest of the URI inject markup or a script on the customer's site.
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// All cookies of the request. A client (e.g. over HTTP/2) can split them over several Cookie headers.
const requestCookies = (request: CloudFrontRequest): string[] =>
    (request.headers["cookie"] ?? []).map(h => h.value).join(";").split(";").map(c => c.trim()).filter(Boolean);

// The value of the cookie `name` (everything after the first "="), or undefined.
const cookieValue = (cookies: string[], name: string): string | undefined =>
    cookies.find(c => c.startsWith(`${name}=`))?.substring(name.length + 1);

/**
 * Signs a challenge session: HMAC-SHA256 over the expiry and rayId, keyed with `secret`, as 32 hex characters.
 * Without the key nobody can produce a valid `_cq_se` cookie (the old unkeyed SHA-256 could be computed by anyone).
 * Deliberately NOT bound to the visitor's `_cq_duid`: on a first visit the challenge is solved before the CHEQ tag
 * has set that cookie, so a bound session broke as soon as it appeared and the visitor had to solve the CAPTCHA twice.
 */
function signSession(secret: string, expiresAt: number, rayId: string): string {
    return createHmac("sha256", secret).update(JSON.stringify(["se", expiresAt, rayId])).digest("hex").slice(0, 32);
}

/** Checks a session signature in constant time. The secret is never a placeholder: createTurnstileChallenge refuses one. */
function isValidSessionSignature(secret: string, expiresAt: number, rayId: string, signature: string): boolean {
    const expected = Buffer.from(signSession(secret, expiresAt, rayId));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Builds the example `challenge` and `validateChallenge` callbacks from the settings in config.ts.
 * A factory, not an `import { config }`: config.ts imports this file, so that would be circular.
 *
 * Returns `{}` (and warns) while `siteKey`, `secretKey` or `sessionSigningSecret` is unset or `REPLACE_ME`:
 * the CAPTCHA is then disabled and challenged traffic is forwarded with `x-cheq-rti-result`, instead of
 * showing a broken widget or issuing sessions anyone could forge.
 */
export function createTurnstileChallenge(settings: TurnstileSettings): Pick<CloudfrontConfig, "challenge" | "validateChallenge"> {
    const missing = (["siteKey", "secretKey", "sessionSigningSecret"] as const).filter(k => isPlaceholder(settings[k]));
    if (missing.length > 0) {
        console.warn(`[turnstile] CAPTCHA disabled, not configured: ${missing.join(", ")} (set them in config.ts)`);
        return {};
    }
    // A TTL of 0, a negative or fractional number, NaN or a string would issue sessions that are already expired
    // (every visitor challenged again and again) or a broken Max-Age. Fall back to the default instead.
    const ttlValid = Number.isInteger(settings.sessionTtlSeconds) && settings.sessionTtlSeconds > 0;
    if (!ttlValid) {
        console.warn(`[turnstile] invalid sessionTtlSeconds ${JSON.stringify(settings.sessionTtlSeconds)}, using ${DEFAULT_SESSION_TTL_SECONDS} (set a positive whole number of seconds in config.ts)`);
    }
    const resolved: TurnstileSettings = ttlValid ? settings : { ...settings, sessionTtlSeconds: DEFAULT_SESSION_TTL_SECONDS };
    return {
        challenge: (request, response, addRtiResultHeader) => turnstileChallengeExample(resolved, request, response, addRtiResultHeader),
        validateChallenge: (request, isDebug) => turnstileValidateChallengeExample(resolved, request, isDebug),
    };
}

const turnstileChallengeExample = async (settings: TurnstileSettings, request: CloudFrontRequest, response: RTIResponse, addRtiResultHeader?: (headers: CloudFrontHeaders) => void): Promise<CloudFrontRequestResult | CloudFrontResponseResult> => {
    const ttl = settings.sessionTtlSeconds;
    let queryStringData = new URLSearchParams(request.querystring);
    // "cf-turnstile-response" is not set by this code: once the visitor solves the challenge, the Turnstile
    // widget (api.js) injects a hidden input with this name into the enclosing <form>. The form submits via GET,
    // so the token arrives here as a query string parameter. It must still be verified server-side (siteverify below).
    // @ts-ignore
    const token = queryStringData?.get("cf-turnstile-response");

    if (!token) {
        // No token means the visitor has not solved the challenge yet. Return a 403 with the Turnstile widget.
        const html = `<!DOCTYPE html>
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
                            position: fixed;
                            top: 0;
                            left: 0;
                            right: 0;
                            bottom: 0;
                            background-image: 
                            radial-gradient(circle at 20% 50%, rgba(0, 212, 170, 0.08) 0%, transparent 50%),
                            radial-gradient(circle at 80% 20%, rgba(124, 58, 237, 0.08) 0%, transparent 50%),
                            radial-gradient(circle at 40% 80%, rgba(0, 212, 170, 0.05) 0%, transparent 40%);
                            pointer-events: none;
                            z-index: 0;
                        }
                        
                        .container {
                            position: relative;
                            z-index: 1;
                            text-align: center;
                            max-width: 480px;
                            width: 100%;
                        }
                        
                        .card {
                            background: linear-gradient(135deg, #0D1B2A 0%, rgba(13, 27, 42, 0.9) 100%);
                            border: 1px solid rgba(0, 212, 170, 0.2);
                            border-radius: 16px;
                            padding: 48px 40px;
                            box-shadow: 
                            0 4px 6px rgba(0, 0, 0, 0.3),
                            0 10px 40px rgba(0, 0, 0, 0.4),
                            inset 0 1px 0 rgba(255, 255, 255, 0.05);
                        }
                        
                        .logo {
                            margin-bottom: 32px;
                        }
                        
                        .icon {
                            margin-bottom: 24px;
                        }
                        
                        h1 {
                            font-size: 1.75rem;
                            font-weight: 700;
                            margin-bottom: 12px;
                            background: linear-gradient(135deg, #E2E8F0 0%, #94A3B8 100%);
                            -webkit-background-clip: text;
                            -webkit-text-fill-color: transparent;
                            background-clip: text;
                        }
                        
                        .subtitle {
                            color: #94A3B8;
                            font-size: 1rem;
                            line-height: 1.6;
                            margin-bottom: 32px;
                        }
                        
                        .ref-box {
                            background: rgba(0, 0, 0, 0.3);
                            border: 1px solid rgba(255, 255, 255, 0.1);
                            border-radius: 8px;
                            padding: 12px 16px;
                            margin-top: 24px;
                        }
                        
                        .ref-label {
                            font-size: 0.75rem;
                            color: #94A3B8;
                            text-transform: uppercase;
                            letter-spacing: 0.05em;
                            margin-bottom: 4px;
                        }
                        
                        .ref-id {
                            font-family: 'SF Mono', Monaco, 'Courier New', monospace;
                            font-size: 0.8rem;
                            color: #00D4AA;
                            word-break: break-all;
                        }
                        
                        .footer {
                            margin-top: 24px;
                            font-size: 0.75rem;
                            color: #94A3B8;
                        }
                        
                        .footer a {
                            color: #00D4AA;
                            text-decoration: none;
                        }
                        
                        .footer a:hover {
                            text-decoration: underline;
                        }
                        
                        .status-badge {
                            display: inline-flex;
                            align-items: center;
                            gap: 6px;
                            background: rgba(239, 68, 68, 0.15);
                            border: 1px solid rgba(239, 68, 68, 0.3);
                            color: #FCA5A5;
                            padding: 6px 12px;
                            border-radius: 20px;
                            font-size: 0.8rem;
                            font-weight: 500;
                            margin-bottom: 20px;
                        }
                        
                        .status-dot {
                            width: 8px;
                            height: 8px;
                            background: #EF4444;
                            border-radius: 50%;
                            animation: pulse 2s infinite;
                        }
                        
                        @keyframes pulse {
                            0%, 100% { opacity: 1; }
                            50% { opacity: 0.5; }
                        }
                        
                        .captcha-box {
                        background: rgba(0, 0, 0, 0.2);
                        border-radius: 12px;
                        padding: 24px;
                        margin-bottom: 24px;
                        }
                        
                        .cf-turnstile {
                        display: flex;
                        justify-content: center;
                        }
                        
                        .btn {
                        width: 100%;
                        padding: 14px 24px;
                        font-size: 1rem;
                        font-weight: 600;
                        color: #0D1B2A;
                        background: linear-gradient(135deg, #00D4AA 0%, #00B894 100%);
                        border: none;
                        border-radius: 8px;
                        cursor: pointer;
                        transition: all 0.2s;
                        box-shadow: 0 4px 12px rgba(0, 212, 170, 0.3);
                        }
                        
                        .btn:hover:not(:disabled) {
                        transform: translateY(-2px);
                        box-shadow: 0 6px 20px rgba(0, 212, 170, 0.4);
                        }
                        
                        .btn:disabled {
                        opacity: 0.5;
                        cursor: not-allowed;
                        transform: none;
                        }
                        
                        .loading {
                        display: none;
                        margin-top: 16px;
                        color: #94A3B8;
                        font-size: 0.9rem;
                        }
                        
                        .loading.show {
                        display: block;
                        }
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
                        <path d="M40 6L12 18v18c0 16.6 11.94 32.12 28 36 16.06-3.88 28-19.4 28-36V18L40 6z" fill="url(#shield-gradient)" opacity="0.2"/>
                        <path d="M40 10L16 20v14c0 14.14 10.18 27.38 24 30.72 13.82-3.34 24-16.58 24-30.72V20L40 10z" stroke="url(#shield-gradient)" stroke-width="3" fill="none"/>
                        <path d="M36 40l-6-6 3-3 3 3 9-9 3 3-12 12z" fill="#00D4AA"/>
                        <defs>
                            <linearGradient id="shield-gradient" x1="40" y1="6" x2="40" y2="72" gradientUnits="userSpaceOnUse">
                            <stop stop-color="#00D4AA"/>
                            <stop offset="1" stop-color="#7C3AED"/>
                            </linearGradient>
                        </defs>
                        </svg></div>
                        <h1>Security Verification</h1>
                        <p class="subtitle">
                            Please complete the verification below to confirm you're human and continue to the website.
                        </p>
                        <form id="captcha-form" action="${escapeHtml(request.uri)}" method="GET">
                            <input type="hidden" name="original_url" value="${escapeHtml(request.uri)}">
                            <input type="hidden" name="request_id" value="${escapeHtml(response.ids.rayId)}">
                            
                            <div class="captcha-box">
                            <div class="cf-turnstile" 
                                data-sitekey="${escapeHtml(settings.siteKey)}"
                                data-callback="onTurnstileSuccess"
                                data-theme="dark">
                            </div>
                            </div>
                            
                            <button type="submit" id="submit-btn" class="btn" disabled>
                            Continue to Website
                            </button>
                            
                            <div id="loading" class="loading">
                            Verifying...
                            </div>
                        </form>
                        
                        <div class="ref-box">
                            <div class="ref-label">Session ID</div>
                            <div class="ref-id">${escapeHtml(response.ids.rayId)}</div>
                        </div>
                        </div>
                        
                        <div class="footer">
                        Protected by <a href="https://cheq.ai" target="_blank" rel="noopener">CHEQ</a> Security
                        </div>
                    </div>

                    <script>
                        function onTurnstileSuccess(token) {
                        document.getElementById('submit-btn').disabled = false;
                        }
                        
                        document.getElementById('captcha-form').addEventListener('submit', function() {
                        document.getElementById('submit-btn').disabled = true;
                        document.getElementById('loading').classList.add('show');
                        });
                    </script>
                    </body>
                    </html>`;
        
        return {
            status: '403',
            headers: {
                'content-type': [{ key: 'Content-Type', value: 'text/html;charset=UTF-8' }],
                'cache-control': [{ key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' }],
            },
            body: html,
        };
    } else {
        // Verify the Turnstile token with Cloudflare's siteverify endpoint
        const verifyResponse = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                secret: settings.secretKey,
                response: token,
                remoteip: request.clientIp,
            }).toString(),
        });

        const result = await verifyResponse.json() as { success: boolean };
        if (result.success) {
            const expiresAt = Date.now() + (ttl * 1000);
            const signature = signSession(settings.sessionSigningSecret, expiresAt, response.ids.rayId);

            const sessionToken = `${expiresAt}.${signature}`;

            // Redirect back to where the visitor was, on THIS site. The host comes from the request (CloudFront only
            // routes hosts of this distribution), never from the query string, and original_url must be a path
            // (see safeReturnPath). Without a Host header the Location stays relative, which the browser resolves
            // against the current site.
            const host = request.headers["host"]?.[0]?.value;
            const returnPath = safeReturnPath(queryStringData?.get("original_url")) ?? request.uri;
            const headers = {};
            // @ts-ignore
            headers.location = [{ key: 'Location', value: host ? `https://${host}${returnPath}` : returnPath }];
            // SameSite=Lax, NOT Strict. A visitor who reaches the site from another site
            // (link click, ad, redirect) makes a cross-site top-level navigation. With Strict
            // the browser does not send _cq_se on that request, so the session is never seen
            // and the visitor is challenged again on every arrival from outside. Lax sends the
            // cookie on top-level GET navigations but still withholds it from cross-site
            // subrequests (iframes, images, fetch) and cross-site POSTs. Do not change to Strict.
            // @ts-ignore
            headers["set-cookie"] = [{ key: 'Set-Cookie', value: `_cq_se=${sessionToken}|${response.ids.rayId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}` }];
            // Adds x-cheq-rti-result (the verdict that triggered the challenge), provided by the handler. This 302 goes
            // to the BROWSER (not the origin), so the client sees verdict, threat-type-code and ids. The redirected
            // request is checked by RTI again and gets its own header on the way to the origin.
            addRtiResultHeader?.(headers);

            return {
                status: '302',
                headers,
            };
        } else {
            return {
                status: '403',
                body: "Verification failed. Please try again.",
            };
        }
    }
};

const turnstileValidateChallengeExample = async (settings: TurnstileSettings, request: CloudFrontRequest, isDebug: boolean | undefined = false): Promise<boolean> => {
    // Validate session token (if the validation already happened in a previous request and the client has a valid session cookie or header, allow the request to proceed without triggering another challenge)
    const cookies = requestCookies(request);
    const [cookieToken, cookieRayId] = cookieValue(cookies, "_cq_se")?.split("|") ?? [];
    const rayId = request.headers["x-cheq-ray-id"]?.[0]?.value || cookieRayId;
    const sessionToken = request.headers["x-cheq-challenge"]?.[0]?.value || cookieToken;

    const shouldValidateChallenge = sessionToken && rayId;
    if (isDebug) {
        console.log(`[validateChallenge] cookies: ${cookies.length > 0 ? cookies.join("; ") : "NOT PRESENT"}`);
        console.log(`[validateChallenge] sessionToken: ${sessionToken ?? "NOT FOUND"}, rayId: ${rayId ?? "NOT FOUND"}, shouldValidateChallenge: ${shouldValidateChallenge ?? "NOTHING_TO_VALIDATE_CALL_RTI"}`);
    }

    if (shouldValidateChallenge) {
        try {
            const [expiresAtStr, signature] = sessionToken.split(".");
            
            if (!expiresAtStr || !signature) { 
                if (isDebug) {
                    console.log("[validateChallenge] invalid sessionToken format, returning 'false'");
                }
                
                return false; 
            }

            const expiresAt = parseInt(expiresAtStr, 10);
            if (isNaN(expiresAt)) { 
                if (isDebug) {
                    console.log("[validateChallenge] expiresAt is NaN, returning 'false'");
                }

                return false; 
            }

            if (Date.now() > expiresAt) {
                if (isDebug) {
                    console.log(`[validateChallenge] session token expired at ${expiresAt}, current time is ${Date.now()}, returning 'false'`);
                }

                return false; 
            }
            
            // Verify signature (keyed HMAC, constant-time compare)
            const match = isValidSessionSignature(settings.sessionSigningSecret, expiresAt, rayId, signature);

            if (isDebug) {
                console.log(`[validateChallenge] signature match: ${match}`);
            }

            return match;
        } catch (e) {
            const err: Error = e as Error;
            console.error(`[validateChallenge] error validating challenge (continue running returning 'false'): ${err.message}`);
            return false;
        }
    }

    return false;
}
