<!-- cspell:ignore PMUSER CHEQ duid pvid cheq cheqzone rtilogger healthcheck Paradome hostnames -->
# CHEQ RTI — Akamai EdgeWorker Integration

This EdgeWorker integrates [CHEQ Real-Time Intelligence (RTI)](https://cheq.ai) into Akamai's edge network to protect your website from bot traffic, credential stuffing, ad fraud, and other automated threats.

---

## How It Works

1. **Every request** passes through `onClientRequest` before reaching your origin
2. The EdgeWorker calls the RTI API to classify the traffic
3. Based on the verdict, the request is **allowed**, **blocked** (403/404), **redirected** (302), or **challenged** (Turnstile CAPTCHA)
4. **On allow**: the request continues to origin with an `x-cheq-rti-result` header containing classification metadata
5. **On error**: the EdgeWorker fails open — the request continues to origin as normal

### Request Lifecycle

```
Incoming request
       │
       ▼
onClientRequest(request)
       │
       ├─ PMUSER_CHEQ_USE_DYNAMIC_CONFIG == 'true'?
       │        ├─ yes → buildDynamicConfig(request)   reads PMUSER_* variables
       │        └─ no  → staticConfig                  from src/config.ts
       │
       ├─ RTIHelperService.shouldIgnore(request.path)
       │        └─ match? → return (pass to origin)
       │
       ├─ config.validateChallenge(request)             optional, e.g. _cq_se cookie check
       │        └─ valid? → return (pass to origin)
       │
       ├─ rtiHelper.parseCookies(cookieHeader)          extracts _cq_duid, _cq_pvid, _cq_s
       │
       ├─ PMUSER_CHEQ_JA3/JA4/TLS_CIPHER/TLS_VERSION   optional fingerprint/TLS data
       ├─ request.userLocation?.region                  geo-location from Akamai edge
       │
       ├─ callRTI(payload)                              HTTP sub-request via httpRequest()
       │        └─ error → fail open (return, pass to origin)
       │
       ├─ rtiHelper.getAction(rtiResponse)
       │        └─ mode != BLOCKING → ALLOW
       │
       ├─ action == ALLOW?
       │        └─ yes → rtiHelper.buildRtiResultHeader(rtiResponse)
       │                 request.setHeader('x-cheq-rti-result', ...)
       │                 return (pass to origin)
       │
       └─ rtiHelper.getActionStrategy(action)
                ├─ ACCESS_DENIED → respondWith(403, html block page)
                ├─ NOT_FOUND     → respondWith(404, html block page)
                ├─ REDIRECT      → respondWith(302, Location header)
                └─ CAPTCHA       → config.challenge(request, rtiResponse)
                         ├─ success → respondWith(302/403, challenge page)
                         └─ error   → fall through to ALLOW (pass to origin with x-cheq-rti-result)


After request reaches origin:

onClientResponse(request, response)
       │
       ├─ PMUSER_CHEQ_DEBUG != 'true'? → return (no-op)
       │
       └─ PMUSER_CHEQ_RTI_FLOW set?
                └─ yes → response.addHeader('x-cheq-rti-result', rtiResult)
```

---

## Prerequisites

- Akamai Property Manager access with EdgeWorkers enabled on your contract
- An **Akamai property configured to proxy `rti-global.cheqzone.com`** — EdgeWorker sub-requests must go through Akamai's network. You need a property that forwards `/defend/4.1/traffic` to the RTI backend. Set this property's hostname as `rtiHost` in your config.
- *(Optional, for CAPTCHA)* An Akamai property proxying `challenges.cloudflare.com` for Turnstile token verification
- *(Optional, for telemetry logging)* An Akamai property proxying `rtilogger.production.cheq-platform.com`

---

## Project Structure

```
integrations/akamai/
├── src/
│   ├── config.ts                           # All runtime configuration — edit before deploying
│   ├── main.ts                             # EdgeWorker entry points: onClientRequest + onClientResponse
│   ├── rti-service.ts                      # Akamai httpRequest()-based RTI API client
│   ├── rti-logger.ts                       # Akamai httpRequest()-based telemetry/error logger
│   ├── turnstile-challenge-example.ts      # Reference CAPTCHA challenge (Cloudflare Turnstile)
│   ├── types.d.ts                          # Ambient TypeScript types for Akamai EdgeWorker APIs (EWRequest, etc.)
│   ├── config.spec.ts                      # Unit tests for config building (static + dynamic PMUSER)
│   ├── main.spec.ts                        # Unit tests for the full request flow
│   ├── main.integration.spec.ts            # Integration tests
│   ├── rti-logger.spec.ts                  # Unit tests for the RTI logger
│   ├── rti-service.spec.ts                 # Unit tests for the RTI service
│   └── turnstile-challenge-example.spec.ts # Unit tests for the challenge flow
├── bundle.json                             # EdgeWorker bundle manifest (entry point + version)
├── rollup.config.mjs                       # Rollup config (TypeScript → dist/main.js)
├── tsconfig.json                           # TypeScript config
└── package.json                            # npm scripts and dependencies

integrations/core/                          # Shared library (bundled at build time)
├── models/                                 # Config interface, Action, Mode, RTI request/response types
├── services/                               # RTIHelperService (action/strategy logic), RTIService, RTILoggerService
└── helpers/                                # generateDefaultBlockPage() (HTML for 403/404 responses)
```

---

## Build & Package

```bash
npm install
npm run build     # Compiles TypeScript and bundles to dist/main.js
npm run package   # Produces dist/cheq-rti-edgeworker.tgz
npm test          # Runs the test suite
npm run coverage  # Runs tests with Istanbul coverage report
```

The `.tgz` file contains `bundle.json` + `main.js` and is ready to upload to Akamai.

---

## Configuration

### Option 1 — Edit `src/config.ts` (recommended for most deployments)

Set your values directly in `config` in [src/config.ts](src/config.ts):

```typescript
export const config: AkamaiConfig = {
    mode: Mode.MONITORING,           // Start with MONITORING to observe before enforcing with BLOCKING
    apiKey: 'your-api-key',
    tagHash: 'your-tag-hash',
    rtiHost: 'rti-proxy.your-domain.com',  // Akamai-proxied RTI hostname
    timeout: 300,
    debug: false,
    telemetry: false,
    // blockingStrategy: ActionStrategy.ACCESS_DENIED,   // ACCESS_DENIED | NOT_FOUND | REDIRECT | CAPTCHA
    // challengingStrategy: ActionStrategy.CAPTCHA,      // ACCESS_DENIED | NOT_FOUND | REDIRECT | CAPTCHA
    // redirectLocation: 'https://www.cheq.ai/',
    // ...
};
```

Then rebuild and redeploy.

### Option 2 — Akamai Property Manager variables (runtime override)

Set `PMUSER_CHEQ_USE_DYNAMIC_CONFIG=true` in Property Manager to activate runtime PMUSER overrides — the EdgeWorker will read all config from PMUSER variables at request time, without requiring a redeployment.

Define user-defined variables (PMUSER_*) in your Akamai property:

| Variable | Description | Example |
|----------|-------------|---------|
| `PMUSER_CHEQ_USE_DYNAMIC_CONFIG` | Set to `true` to read all config from PMUSER variables at runtime | `true` |
| `PMUSER_CHEQ_API_KEY` | Your CHEQ API key | `abc123...` |
| `PMUSER_CHEQ_TAG_HASH` | Your tag hash | `xyz789...` |
| `PMUSER_CHEQ_RTI_HOST` | Akamai-proxied RTI hostname | `rti-proxy.your-domain.com` |
| `PMUSER_CHEQ_MODE` | `MONITORING` or `BLOCKING` | `BLOCKING` |
| `PMUSER_CHEQ_TIMEOUT` | RTI timeout in ms | `300` |
| `PMUSER_CHEQ_DEBUG` | Enable debug headers | `true` |
| `PMUSER_CHEQ_TELEMETRY` | Enable RTI duration telemetry logging (requires `PMUSER_CHEQ_RTI_LOGGER_HOST`) | `true` |
| `PMUSER_CHEQ_BLOCK_STRATEGY` | `ACCESS_DENIED`, `NOT_FOUND`, `REDIRECT`, or `CAPTCHA` | `ACCESS_DENIED` |
| `PMUSER_CHEQ_CHALLENGE_STRATEGY` | `ACCESS_DENIED`, `NOT_FOUND`, `REDIRECT`, or `CAPTCHA` | `CAPTCHA` |
| `PMUSER_CHEQ_BLOCK_TT_CODES` | Comma-separated threat type codes to block | `4,5,6` |
| `PMUSER_CHEQ_BLOCK_REASONS` | Comma-separated reason codes to block | `1,2` |
| `PMUSER_CHEQ_CHALLENGE_TT_CODES` | Comma-separated threat type codes to challenge | `2,3` |
| `PMUSER_CHEQ_CHALLENGE_REASONS` | Comma-separated reason codes to challenge | `3` |
| `PMUSER_CHEQ_REDIRECT_TT_CODES` | Comma-separated threat type codes to redirect | `7` |
| `PMUSER_CHEQ_REDIRECT_REASONS` | Comma-separated reason codes to redirect | `4` |
| `PMUSER_CHEQ_REDIRECT_LOCATION` | Redirect destination URL | `https://www.cheq.ai/` |
| `PMUSER_CHEQ_IGNORE_PATHS` | Comma-separated regex patterns for paths to skip RTI | `^/health$,\\.css$` |
| `PMUSER_CHEQ_RTI_LOGGER_HOST` | Akamai-proxied hostname for the RTI logger | `rti-logger-proxy.your-domain.com` |
| `PMUSER_CHEQ_JA3` | JA3 TLS fingerprint (map from Bot Manager or `AK_TLS_JA3` if available) | `abc123...` |
| `PMUSER_CHEQ_JA4` | JA4 TLS fingerprint | `def456...` |
| `PMUSER_CHEQ_TLS_CIPHER` | TLS cipher name (map from built-in `AK_TLS_CIPHER_NAME`) | `ECDHE-RSA-AES128-GCM-SHA256` |
| `PMUSER_CHEQ_TLS_VERSION` | TLS protocol version (map from built-in `AK_TLS_VERSION`) | `TLSv1.3` |

PMUSER values override `config` at request time. Values not set fall back to `config`.

> **Note — fingerprint fields and geo are RTI payload fields, not HTTP headers.**
> `PMUSER_CHEQ_JA3`, `PMUSER_CHEQ_JA4`, `PMUSER_CHEQ_TLS_CIPHER`, and `PMUSER_CHEQ_TLS_VERSION` are injected as `cheq_ja3`, `cheq_ja4`, `cheq_tls_cipher`, and `cheq_tls_version` fields inside `endUserParams.headers` of the RTI API request body.
> `cheq_geo_region` is always populated automatically from `request.userLocation?.region` (Akamai EdgeWorker native geo) — no PMUSER variable is needed.

---

## Configuration Reference

All configuration lives in [`src/config.ts`](src/config.ts) as a single exported `config` object.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | `string` | Your CHEQ API key |
| `tagHash` | `string` | Your tag hash |
| `rtiHost` | `string` | Akamai-proxied RTI hostname (e.g. `rti-proxy.your-domain.com`). Must forward to `rti-global.cheqzone.com`. |
| `mode` | `Mode` | `Mode.MONITORING` = observe only (no blocking). `Mode.BLOCKING` = enforce actions. Start with MONITORING. |

### Action Routing

These fields override the default verdict-based routing. All accept arrays of numeric codes from the RTI response. The preferred way to configure routing is via **Defend → Policy Management** in the Paradome platform, which avoids redeployment.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `blockTTCodes` | `number[]` | `undefined` | Threat-type codes that trigger BLOCK |
| `blockReasons` | `number[]` | `undefined` | Reason codes that trigger BLOCK |
| `challengeTTCodes` | `number[]` | `undefined` | Threat-type codes that trigger CHALLENGE |
| `challengeReasons` | `number[]` | `undefined` | Reason codes that trigger CHALLENGE |
| `redirectTTCodes` | `number[]` | `undefined` | Threat-type codes that trigger REDIRECT |
| `redirectReasons` | `number[]` | `undefined` | Reason codes that trigger REDIRECT |
| `redirectLocation` | `string` | `'https://www.cheq.ai/'` | Redirect destination URL |

### Action Strategies

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `blockingStrategy` | `ActionStrategy` | `ACCESS_DENIED` | How to respond to BLOCK: `ACCESS_DENIED` (403), `NOT_FOUND` (404), `REDIRECT` (302), or `CAPTCHA` |
| `challengingStrategy` | `ActionStrategy` | `CAPTCHA` | How to respond to CHALLENGE: same options as above |

### Challenge Functions

| Field | Type | Description |
|-------|------|-------------|
| `challenge` | `(request: EWRequest, response: RTIResponse) => Promise<{ html: string; headers: Record<string, string> }>` | Called when action strategy is `CAPTCHA`. Must return `{ html, headers }` for `respondWith()`. See [`src/turnstile-challenge-example.ts`](src/turnstile-challenge-example.ts). |
| `validateChallenge` | `(request: EWRequest) => Promise<boolean>` | Called before RTI on every request. Return `true` to skip RTI (e.g. user has a valid `_cq_se` session cookie). |

### Path Filtering

| Field | Type | Description |
|-------|------|-------------|
| `ignorePaths` | `string[]` | Regex pattern strings. Paths matching any pattern bypass RTI entirely. Do not wrap in `/` delimiters. |

### Network & Observability

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout` | `number` | `300` | RTI API request timeout in milliseconds |
| `rtiLoggerHost` | `string` | `undefined` | Akamai-proxied logger hostname. When set, enables error logging unconditionally and telemetry logging when `telemetry: true`. |
| `debug` | `boolean` | `false` | Log payload and verdict to `log.log()`, and echo `x-cheq-rti-result` on the response via `onClientResponse`. **Disable in production.** |
| `telemetry` | `boolean` | `false` | Send RTI duration (`rti_duration: {ms}`) to `rtiLoggerHost` after each call. Requires `rtiLoggerHost` to be set. |

---

## Action Decision Logic

Evaluated **only in `Mode.BLOCKING`**. In `Mode.MONITORING`, always returns ALLOW.

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 (highest) | `verdict === 'malicious'` OR code in `blockTTCodes` OR reason in `blockReasons` | BLOCK |
| 2 | `verdict === 'suspicious'` OR code in `challengeTTCodes` OR reason in `challengeReasons` | CHALLENGE |
| 3 | code in `redirectTTCodes` OR reason in `redirectReasons` | REDIRECT |
| 4 (lowest) | none of the above | ALLOW |

The first matching tier wins — BLOCK always takes precedence over CHALLENGE, which always takes precedence over REDIRECT.

## Action Strategies

| Strategy | HTTP Response | When to use |
|----------|---------------|-------------|
| `ACCESS_DENIED` | 403 + HTML block page | Default for malicious traffic |
| `NOT_FOUND` | 404 + HTML block page | Hide the resource's existence |
| `REDIRECT` | 302 to `redirectLocation` + `x-cheq-cdn-request-id`, `x-cheq-id`, `x-cheq-page-view-id` tracking headers | Send bots to a decoy/honeypot |
| `CAPTCHA` | 403 + Turnstile challenge page | Suspicious traffic that may be human |

---

## Modes

- **`MONITORING`** (default): RTI is called and results are logged, but no traffic is blocked. Use this initially to understand your traffic before enabling blocking.
- **`BLOCKING`**: RTI verdicts are enforced — malicious traffic is blocked/challenged/redirected.

---

## CAPTCHA Challenge (Turnstile)

The Turnstile challenge flow for Akamai uses query parameters (not POST body, since `onClientRequest` cannot read the request body):

1. Suspicious request arrives → EdgeWorker serves a Turnstile HTML challenge page
2. User solves the widget → form submits as `GET ?cf-turnstile-response=TOKEN&original_url=...`
3. EdgeWorker verifies the token with Cloudflare's API (via Akamai-proxied hostname)
4. On success: sets `_cq_se` session cookie + redirects to the original URL
5. Subsequent requests with a valid `_cq_se` cookie skip the RTI check entirely

> The `_cq_se` cookie has a 5-minute TTL (`Max-Age=300`) and is set `HttpOnly; Secure; SameSite=Strict`. After expiry the next request goes through RTI again.

To enable CAPTCHA:

1. Replace `REPLACE_ME` values in [src/turnstile-challenge-example.ts](src/turnstile-challenge-example.ts):
   - `TURNSTILE_SITE_KEY` — your Cloudflare Turnstile site key
   - `TURNSTILE_SECRET` — your Cloudflare Turnstile secret key
   - `TURNSTILE_VERIFY_HOST` — Akamai-proxied hostname for `challenges.cloudflare.com`
2. Set `challengingStrategy: ActionStrategy.CAPTCHA` in `config` (or via `PMUSER_CHEQ_CHALLENGE_STRATEGY`)

---

## Telemetry Logging

When `rtiLoggerHost` is configured, the EdgeWorker sends telemetry to the CHEQ RTI logger:

- **On every request** (requires `telemetry: true`): logs `rti_duration` (RTI call time in milliseconds)
- **On errors** (requires only `rtiLoggerHost`, regardless of `telemetry`): logs error details for RTI failures and challenge errors

To enable:

1. Set up an Akamai property that proxies `rtilogger.production.cheq-platform.com`
2. Set `rtiLoggerHost` in `config` to that property's hostname (or `PMUSER_CHEQ_RTI_LOGGER_HOST`)
3. Set `telemetry: true` in `config` (or `PMUSER_CHEQ_TELEMETRY=true`)

---

## Debugging

Enable debug mode to expose classification metadata in response headers:

- Set `debug: true` in `config`, or `PMUSER_CHEQ_DEBUG=true` in Property Manager
- The EdgeWorker exports `onClientResponse` which, when debug is enabled, echoes `x-cheq-rti-result` onto the response so the header is visible in browser DevTools. Without this, the header is only set on the outbound request (visible in origin server logs, not in the browser).
- Response headers added:
  - `x-cheq-rti-result` — full RTI classification (`version=X;verdict=Y;threat-type-code=Z;ids={...}`)

**Disable debug in production.**

---

## Deployment

1. Build: `npm run package` → `dist/cheq-rti-edgeworker.tgz`
2. Upload via Akamai Control Center: **EdgeWorkers** → **Create EdgeWorker** → upload bundle
3. Or via CLI: `akamai edgeworkers upload --edgeworker-id <id> --bundle dist/cheq-rti-edgeworker.tgz`
4. Activate the EdgeWorker version
5. In your site's Akamai property, add the **EdgeWorker** behavior targeting the desired match criteria (e.g., all requests, or specific paths)

---

## Ignored Paths

Requests matching `ignorePaths` patterns skip the RTI call entirely and pass to origin. Customize in `config.ignorePaths` or via `PMUSER_CHEQ_IGNORE_PATHS`.

The defaults cover:

- **Static asset extensions** — `.css`, `.js`, `.mjs`, `.map`, images (`.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.ico`), fonts (`.woff` `.woff2` `.ttf` `.eot`), media (`.mp4` `.webm` `.mp3`), `.pdf`, `.zip`
- **Well-known files** — `/favicon.ico`, `/robots.txt`, `/sitemap*.xml`, `/ads.txt`
- **Health check paths** — `/health`, `/healthcheck`, `/ping`, `/status`
- **Infrastructure prefixes** — `/static/`, `/assets/`

---

## `x-cheq-rti-result` Header

For all **allowed** requests, this header is injected into the outbound request before it reaches your origin:

```
x-cheq-rti-result: version={v};verdict={v};threat-type-code={n};ids={json};reasons={n,n,...}
```

Example:
```
x-cheq-rti-result: version=4.1;verdict=benign;threat-type-code=0;ids={"rayId":"abc123",...};reasons=
```

Your origin server can read this header for logging, analytics, or additional business logic.

When `debug: true`, the `onClientResponse` handler echoes this header onto the response, making it visible in browser DevTools. Without debug mode the header is only visible in origin server logs.

---

## Troubleshooting

### RTI call fails — `httpRequest()` not reaching the RTI endpoint

`httpRequest()` in Akamai EdgeWorkers can only reach hostnames served by Akamai's network. You must set up a forwarding property that routes your `rtiHost` to `rti-global.cheqzone.com`. Verify the property is active and the hostname matches `config.rtiHost` exactly.

### EdgeWorker is not intercepting requests

Ensure the EdgeWorker behavior is enabled in your Akamai property and the match criteria covers the paths you expect. Check the EdgeWorker activation status in Akamai Control Center — a version must be **active** on the staging or production network.

### JA3/JA4 fingerprints are empty in the RTI payload

These fields come from `PMUSER_CHEQ_JA3` / `PMUSER_CHEQ_JA4`. You must map the relevant Akamai built-in variable (e.g. from Bot Manager, or `AK_TLS_JA3` if available on your contract) to these PMUSER variables in Property Manager. If not configured, the fields are omitted — the integration still works normally.

### PMUSER variables not taking effect

Verify `PMUSER_CHEQ_USE_DYNAMIC_CONFIG` is set to `true` in Property Manager, otherwise the static `config` object in `src/config.ts` is used and PMUSER variables are ignored.

### Turnstile challenge loops infinitely

The `_cq_se` session cookie is not being set or sent on subsequent requests. Verify:
- The Turnstile verify host in `turnstile-challenge-example.ts` is an Akamai-proxied hostname for `challenges.cloudflare.com` (EdgeWorkers cannot reach external hosts directly)
- `Path=/` is correct for your URL structure
- `SameSite=Strict` may block the cookie on cross-site navigation — change to `SameSite=Lax` if needed

### Fail-open behavior

If the RTI API is unreachable, times out, or throws any error, the EdgeWorker always passes the request through to origin unchanged. Errors are logged via `log.log()` and, if `rtiLoggerHost` is configured, also sent to the RTI logger endpoint.

---

## Limitations

- **RTI sub-requests require Akamai proxying**: `httpRequest()` can only reach Akamai-served hostnames. You must set up a forwarding property for `rti-global.cheqzone.com`.
- **JA3/JA4 fingerprints require manual PMUSER mapping**: Akamai does not expose TLS fingerprints directly on `EWRequest`. To send them, map the relevant Akamai built-in variable (e.g. from Bot Manager) to `PMUSER_CHEQ_JA3` / `PMUSER_CHEQ_JA4` in Property Manager. If not configured, these fields are omitted from the RTI payload.
