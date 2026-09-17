<!-- cspell:ignore PMUSER CHEQ duid pvid cheq cheqzone rtilogger healthcheck Paradome hostnames -->
# CHEQ RTI — Akamai EdgeWorker Integration

This EdgeWorker integrates [CHEQ Real-Time Interception (RTI)](https://cheq.ai) into Akamai's edge network to protect your website from bot traffic, credential stuffing, ad fraud, and other automated threats.

---

## How It Works

1. **Every request** passes through `onClientRequest` before reaching your origin
2. The EdgeWorker calls the RTI API to classify the traffic
3. Based on the verdict, the request is **allowed**, **blocked** (403/404), **redirected** (302), or **challenged** (reCAPTCHA v2/v3, or a self-contained browser check)
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
       │        ├─ mode != BLOCKING → ALLOW
       │        └─ mode == BLOCKING → ALLOW / BLOCK / CHALLENGE / REDIRECT according to verdict, classification code and reasons list
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
                         ├─ success        → respondWith(302/403, challenge page)
                         ├─ not configured → fall through to ALLOW (logged when debug is on)
                         └─ error          → fall through to ALLOW (pass to origin with x-cheq-rti-result)


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
- An **Akamai property configured to proxy `rti-global.cheqzone.com`** — EdgeWorker sub-requests must go through Akamai's network. You need a property that forwards `/defend/4.1/traffic` to the RTI backend. Set this property's hostname as `rtiHost` in your config. Also, `'^/defend/'` should be part of the `ignorePaths`
- *(Optional, for CAPTCHA)* An Akamai property proxying `www.google.com` under `/recaptcha/*`, for reCAPTCHA token verification.  Not needed for the `browser` challenge provider, which calls no third party. 
Also, `'^/recaptcha/'` should be part of the `ignorePaths`
- *(Optional, for CAPTCHA)* A signing secret in `PMUSER_CHEQ_CHALLENGE_SECRET`. Without it no challenge is served at all - see [CAPTCHA Challenge](#captcha-challenge).
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
│   ├── challenge-signing.ts                # Reads PMUSER_CHEQ_CHALLENGE_SECRET; signs challenge tokens and the _cq_se cookie
│   ├── cheq-challenge.ts                   # `browser` provider - self-contained JS interstitial, no third party
│   ├── recaptcha-v2-challenge.ts           # `recaptcha-v2` / `recaptcha-v3` providers (Google)
│   ├── types.d.ts                          # Ambient TypeScript types for Akamai EdgeWorker APIs (EWRequest, etc.)
│   ├── config.spec.ts                      # Unit tests for config building (static + dynamic PMUSER)
│   ├── main.spec.ts                        # Unit tests for the full request flow
│   ├── main.integration.spec.ts            # Integration tests
│   ├── rti-logger.spec.ts                  # Unit tests for the RTI logger
│   ├── rti-service.spec.ts                 # Unit tests for the RTI service
│   ├── cheq-challenge.spec.ts              # Unit tests for the browser provider
│   └── recaptcha-v2-challenge.spec.ts      # Unit tests for the reCAPTCHA providers
├── bundle.json                             # EdgeWorker bundle manifest (entry point + version)
├── rollup.config.mjs                       # Rollup config (TypeScript → dist/main.js)
├── tsconfig.json                           # TypeScript config
└── package.json                            # npm scripts and dependencies

integrations/core/                          # Shared library (bundled at build time)
├── models/                                 # Config interface, Action, Mode, RTI request/response types
├── services/                               # RTIHelperService (action/strategy logic), RTIService, RTILoggerService
└── helpers/                                # generateCompactBlockPage() - 403/404 pages that fit
                                            #   Akamai's 2048-byte respondWith limit (Akamai uses
                                            #   this one); generateDefaultBlockPage() for other CDNs
```

---

## Build & Package

### Node version — do this first

**Node >= 20 is required.** vitest 4 will not start on anything older, and the error it gives is
misleading (`ERR_REQUIRE_ESM` pointing at `vitest.config.ts`, which looks like a config problem
rather than a version problem).

If you use nvm-windows:

```powershell
nvm list              # shows installed versions; the * marks the active one
nvm use 22.21.1       # any 20+ works
node --version        # confirm: v22.21.1
```

`nvm use` is global and persists for new terminals, so you only need it when the active version is
below 20. Note `npm` changes with it — Node 16 ships npm 8, Node 22 ships npm 10.

### Commands

```powershell
npm install --legacy-peer-deps   # once. --legacy-peer-deps avoids an npm bug; see Troubleshooting
npm test                         # tsc + vitest — the real gate. Needs Node >= 20
npm run coverage                 # tests + Istanbul report, per-file thresholds enforced
npm run build                    # rollup -> dist/main.js only
npm run package                  # build + the uploadable dist/cheq-rti-edgeworker.tgz
```

All of these work in PowerShell, cmd and Git Bash. `npm run package` works on Node 16 too — only
the test commands need 20+.

### Producing the upload bundle

EdgeWorkers cannot install npm packages at runtime, so everything — `src/` plus the shared
`../core/` code — is bundled into a single self-contained `main.js`. One command does it:

```bash
cd integrations/akamai
npm run package
```

which is `rollup -c` → `dist/main.js`, then `bundle.json` copied into `dist/`, then both tarred:

```
dist/
├── main.js                    # the bundle (~59 KB), exports onClientRequest + onClientResponse
├── bundle.json                # the manifest, copied from ../bundle.json
└── cheq-rti-edgeworker.tgz    # ~17 KB — upload THIS
```

Upload `cheq-rti-edgeworker.tgz` in the Akamai Control Center under
**EdgeWorkers → your EdgeWorker ID → Create version**, then activate it on staging or production.
Property Manager wiring (the EdgeWorkers behavior on the Default Rule, the `/defend/*` self-proxy
rule, and the `PMUSER_*` variables) is covered in [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md).

**Bump `edgeworker-version` before every upload.** Akamai rejects a version string it has already
seen for that EdgeWorker ID, so edit [bundle.json](bundle.json) each time:

```json
{ "edgeworker-version": "4.1.12", "description": "CHEQ RTI Bot Protection EdgeWorker" }
```

Keep `APPLICATION` in [src/main.ts](src/main.ts) in step with it — that string tags every line this
worker sends to the RTI logger, so a stale value makes telemetry misreport which build is live.

**`npm run package` does not run the tests.** It is `build && cp && tar` only. Use
`npm test && npm run package` if you want the gate (Cloudflare's `deploy` script chains them;
Akamai's `package` deliberately does not, so you can rebuild without a full test run).

The copy step uses `node -e "...copyFileSync..."` rather than `cp` on purpose: npm runs scripts
through `cmd.exe` on Windows regardless of which shell you typed in, and `cmd.exe` has no `cp`.
With `cp` the `&&` chain broke after `rollup`, leaving `dist/main.js` with no `bundle.json` and
no `.tgz`. (`tar` is fine — Windows ships it at `C:\Windows\System32	ar.exe`.)

Worth checking the archive before uploading — it should contain exactly two files:

```bash
tar -tzf dist/cheq-rti-edgeworker.tgz     # expect: bundle.json, main.js
```

> **Building on macOS?** Prefix with `COPYFILE_DISABLE=1` (`COPYFILE_DISABLE=1 npm run package`).
> Without it, BSD `tar` adds AppleDouble `._main.js` / `._bundle.json` entries to the archive.

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
| `PMUSER_CHEQ_RTI_DEBUG_DATA` | Append `reasons` and `rule-name` to `x-cheq-rti-result` | `true` |
| `PMUSER_CHEQ_TELEMETRY` | Enable RTI duration telemetry logging (requires `PMUSER_CHEQ_RTI_LOGGER_HOST`) | `true` |
| `PMUSER_CHEQ_BLOCK_STRATEGY` | `ACCESS_DENIED`, `NOT_FOUND`, `REDIRECT`, or `CAPTCHA` | `ACCESS_DENIED` |
| `PMUSER_CHEQ_CHALLENGE_STRATEGY` | `ACCESS_DENIED`, `NOT_FOUND`, `REDIRECT`, or `CAPTCHA` | `CAPTCHA` |
| `PMUSER_CHEQ_CHALLENGE_SECRET` | **Required for any CAPTCHA.** Signs challenge tokens and the `_cq_se` cookie. Without it no challenge is wired and suspicious traffic passes to origin. Rotate by changing this value - no rebuild needed. | `a-long-random-string` |
| `PMUSER_CHEQ_CHALLENGE_PROVIDER` | `recaptcha-v2` (default), `recaptcha-v3`, or `browser` | `browser` |
| `PMUSER_CHEQ_CHALLENGE_TTL` | Seconds a passed challenge stays valid before re-challenge (reCAPTCHA providers; default 900) | `600` |
| `PMUSER_CHEQ_RECAPTCHA_SITE_KEY` | Google reCAPTCHA site key | `6Lc...` |
| `PMUSER_CHEQ_RECAPTCHA_SECRET` | Google reCAPTCHA server-side key for `siteverify`. **Not** the same as `PMUSER_CHEQ_CHALLENGE_SECRET`. | `6Lc...` |
| `PMUSER_CHEQ_RECAPTCHA_HOST` | Akamai-proxied hostname carrying the `/recaptcha/*` rule. Falls back to `PMUSER_CHEQ_RTI_HOST`. | `rti-proxy.your-domain.com` |
| `PMUSER_CHEQ_RECAPTCHA_TEST_KEYS` | `true` to use Google's published always-pass v2 test keys. Demos only - they pass every request by design. | `true` |
| `PMUSER_CHEQ_RECAPTCHA_MIN_SCORE` | v3 only - minimum Google score to pass, 0.0-1.0 (default 0.5) | `0.7` |
| `PMUSER_CHEQ_BLOCK_TT_CODES` | Comma-separated threat type codes to block | `4,5,6` |
| `PMUSER_CHEQ_BLOCK_REASONS` | Comma-separated reason codes to block | `1,2` |
| `PMUSER_CHEQ_CHALLENGE_TT_CODES` | Comma-separated threat type codes to challenge | `2,3` |
| `PMUSER_CHEQ_CHALLENGE_REASONS` | Comma-separated reason codes to challenge | `3` |
| `PMUSER_CHEQ_REDIRECT_TT_CODES` | Comma-separated threat type codes to redirect | `7` |
| `PMUSER_CHEQ_REDIRECT_REASONS` | Comma-separated reason codes to redirect | `4` |
| `PMUSER_CHEQ_REDIRECT_LOCATION` | Redirect destination URL | `https://www.cheq.ai/` |
| `PMUSER_CHEQ_IGNORE_PATHS` | Comma-separated regex patterns for paths to skip RTI. Unset falls back to `DEFAULT_IGNORE_PATHS` in `config.ts`, shared with the static config; setting it replaces that list rather than extending it | `^/health$,\\.css$` |
| `PMUSER_CHEQ_RTI_LOGGER_HOST` | Akamai-proxied hostname for the RTI logger | `rti-logger-proxy.your-domain.com` |
| `PMUSER_CHEQ_JA3` | JA3 TLS fingerprint. **No Akamai built-in supplies this** — see [Limitations](#limitations). Omitted from the payload when unset. | `abc123...` |
| `PMUSER_CHEQ_JA4` | JA4 TLS fingerprint. Same constraint as `PMUSER_CHEQ_JA3`. | `def456...` |
| `PMUSER_CHEQ_TLS_CIPHER` | TLS cipher name. Populate from the built-in `AK_TLS_CIPHER_NAME` with a Set Variable behavior (step 2e of [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md)). Yields the literal `NO-CIPHER` on plain HTTP. | `ECDHE-RSA-AES128-GCM-SHA256` |
| `PMUSER_CHEQ_TLS_VERSION` | TLS protocol version. Populate from the built-in `AK_TLS_VERSION` (same step 2e). | `TLSv1.3` |

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
| `challenge` | `(request: EWRequest, response: RTIResponse) => Promise<{ html: string; headers: Record<string, string> }>` | Called when action strategy is `CAPTCHA`. Must return `{ html, headers }` for `respondWith()`. Not set directly - resolved from `challengeProvider` + keys + signing secret. See [`src/cheq-challenge.ts`](src/cheq-challenge.ts) and [`src/recaptcha-v2-challenge.ts`](src/recaptcha-v2-challenge.ts). |
| `validateChallenge` | `(request: EWRequest) => Promise<boolean>` | Called before RTI on every request. Return `true` to skip RTI (e.g. user has a valid `_cq_se` session cookie). Resolved alongside `challenge`. |
| `challengeProvider` | `'recaptcha-v2' \| 'recaptcha-v3' \| 'browser'` | Which challenge UI to serve. Default `recaptcha-v2`. `browser` needs no third-party keys. |
| `googleRecaptchaConfigured` | `boolean` | Diagnostic: true when usable Google keys **and** a verify host are present. Says nothing about whether a challenge is available - for that use `challenge !== undefined`. |
| `recaptchaScoreThreshold` | `number` | v3 only - minimum Google score to pass. Default 0.5. |

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
| `NOT_FOUND` | 404 + stealth block page (no IDs in the body; `x-cheq-cdn-request-id`, `x-cheq-id`, `x-cheq-page-view-id` headers **only when `debug` is on**) | Hide the resource's existence |
| `REDIRECT` | 302 to `redirectLocation` + `x-cheq-cdn-request-id`, `x-cheq-id`, `x-cheq-page-view-id` tracking headers | Send bots to a decoy/honeypot |
| `CAPTCHA` | 403 + challenge page (reCAPTCHA or browser check); **passes to origin if no challenge is configured** | Suspicious traffic that may be human |

---

## Modes

- **`MONITORING`** (default): RTI is called and results are logged, but no traffic is blocked. Use this initially to understand your traffic before enabling blocking.
- **`BLOCKING`**: RTI verdicts are enforced — malicious traffic is blocked/challenged/redirected.

---

## CAPTCHA Challenge

Three providers are available, selected with `PMUSER_CHEQ_CHALLENGE_PROVIDER`:

| Provider | What the visitor sees | Needs |
|----------|----------------------|-------|
| `recaptcha-v2` (default) | Google "I'm not a robot" checkbox | Google site + secret keys, and an Akamai property proxying `www.google.com` under `/recaptcha/*` |
| `recaptcha-v3` | nothing - invisible, score-based | as above, plus optionally `PMUSER_CHEQ_RECAPTCHA_MIN_SCORE` |
| `browser` | "Verifying your browser" interstitial | nothing beyond the signing secret - calls no third party |

All flows use query parameters rather than a POST body, because `onClientRequest` cannot read the
request body.

1. Suspicious request arrives → EdgeWorker serves the challenge page
2. Visitor passes it → the page re-requests the URL with the token appended as a query parameter
3. EdgeWorker verifies it (Google via the Akamai-proxied host; the `browser` provider verifies its
   own signed token, no external call)
4. On success: sets a signed `_cq_se` session cookie and redirects to the original URL
5. Subsequent requests with a valid `_cq_se` cookie skip the RTI check entirely

> `_cq_se` is `HttpOnly; Secure`, and its TTL is 900s for the reCAPTCHA providers
> (`PMUSER_CHEQ_CHALLENGE_TTL`) or a fixed 300s for `browser`. After expiry the next request goes
> through RTI again.

### Enabling it

**Set `PMUSER_CHEQ_CHALLENGE_SECRET`.** This signs the challenge token and the `_cq_se` cookie.
Without it **no challenge is wired at all** and suspicious traffic passes to origin - a challenge
signed with a guessable key would let anyone forge the cookie that skips RTI, so no challenge is
the safer failure. Rotate it by changing the variable; no rebuild needed.

>Akamai denies `Set-Cookie` on `request.respondWith()` by default and drops the header so in order it to work, we need to set in akamai the `<edgeservices:cookie.pass-set-cookie-policy>` Advanced behavior, so the `_cq_se` cookie reaches the browser and sessions work. Since that requires advanced permissions the workaround is a signed `cq_ok` URL parameter that clears one landing request, so a missing tag degrades instead of looping

Then either:

- `PMUSER_CHEQ_CHALLENGE_PROVIDER=browser` - nothing further to configure, or
- keep a reCAPTCHA provider and set `PMUSER_CHEQ_RECAPTCHA_SITE_KEY`, `PMUSER_CHEQ_RECAPTCHA_SECRET`
  and `PMUSER_CHEQ_RECAPTCHA_HOST` (which falls back to `PMUSER_CHEQ_RTI_HOST`).

`challengingStrategy` already defaults to `CAPTCHA`, so no strategy change is needed.

> **If you do not want CAPTCHA at all**, set `PMUSER_CHEQ_CHALLENGE_STRATEGY=ACCESS_DENIED` (or
> `NOT_FOUND` / `REDIRECT`). Suspicious traffic is then handled with no challenge, no keys and no
> signing secret. This is the simplest correct configuration.

> **The static config in `src/config.ts` cannot serve a challenge.** The signing secret is a
> per-request PMUSER variable and that object is built once at module load, so `challenge` is
> `undefined` there by design. Use `PMUSER_CHEQ_USE_DYNAMIC_CONFIG=true` if you want CAPTCHA.

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
  - On `NOT_FOUND` (stealth 404) responses only — `x-cheq-cdn-request-id`, `x-cheq-id`, `x-cheq-page-view-id`. The 404 page body deliberately carries no IDs, so these headers are the only way to trace a stealth 404 back to an RTI decision. They are absent with debug off, by design.

`PMUSER_CHEQ_RTI_DEBUG_DATA=true` is a separate switch that widens the header itself
with the detection reason codes and the matched rule name. It is independent of
`PMUSER_CHEQ_DEBUG`: on its own it enriches the header sent to origin, and combined with
`PMUSER_CHEQ_DEBUG=true` that enriched header also reaches the browser.

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

Requests matching `ignorePaths` patterns skip the RTI call entirely and pass to origin. The list
lives once, as `DEFAULT_IGNORE_PATHS` in [src/config.ts](src/config.ts), and is used by both the
static config and `buildDynamicConfig` when `PMUSER_CHEQ_IGNORE_PATHS` is unset - `shouldIgnore()`
reads an undefined list as "ignore nothing", so without that fallback a dynamic config would
classify every asset and stop excluding the worker's own self-proxy paths so we must make sure at least the proxy passes are set (RTI\reCaptcha\RtiLogger).

The defaults cover:

- **Static asset extensions** — `.css`, `.js`, `.mjs`, `.map`, images (`.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.ico`), fonts (`.woff` `.woff2` `.ttf` `.eot`), media (`.mp4` `.webm` `.mp3`), `.pdf`, `.zip`
- **Well-known files** — `/favicon.ico`, `/robots.txt`, `/sitemap*.xml`, `/ads.txt`
- **Health check paths** — `/health`, `/healthcheck`, `/ping`, `/status`
- **Infrastructure prefixes** — `/static/`, `/assets/`

---

## `x-cheq-rti-result` Header

For all **allowed** requests, this header is injected into the outbound request before it reaches your origin:

```
x-cheq-rti-result: version={v};verdict={v};threat-type-code={n};ids={json}
```

Example:
```
x-cheq-rti-result: version=4.1;verdict=benign;threat-type-code=0;ids={"rayId":"abc123",...}
```

Your origin server can read this header for logging, analytics, or additional business logic.

### Extended detection data (opt-in)

Set `PMUSER_CHEQ_RTI_DEBUG_DATA=true` to append two more fields:

```
x-cheq-rti-result: version=4.1;verdict=suspicious;threat-type-code=14;ids={...};reasons=4,9;rule-name=Datacenter IP
```

| Field | Source | Notes |
|-------|--------|-------|
| `reasons` | `cheqDetection.reasons` | Comma-separated reason codes. Empty (`reasons=`) when none fired. |
| `rule-name` | `decision.ruleName` | Empty (`rule-name=`) when no rule matched. Sanitized before it is emitted: non-printable and non-ASCII characters are dropped (CR/LF would otherwise be a header-injection vector), literal `;` becomes `,` so it cannot split the field, and the value is capped at 128 characters. |

This flag is Akamai-only and is read straight from the property variable, so it applies on
both the static and the dynamic config paths. Cloudflare, CloudFront and Fastly emit the
base four fields only.

When `debug: true`, the `onClientResponse` handler echoes this header onto the response, making it visible in browser DevTools. Without debug mode the header is only visible in origin server logs.

---

## Troubleshooting

### `npm install` fails with `Cannot read properties of null (reading 'edgesOut')`

An npm 10.x bug, triggered by `@vitest/coverage-istanbul` declaring an exact peer on `vitest`
together with the optional `@vitest/coverage-v8` peer cycle. Use `npm install --legacy-peer-deps`.
Both packages are pinned to the same exact version on purpose — the coverage plugin peer-pins
vitest, so a floating range lets the two drift apart between packages and breaks type-checking
of the shared test harness in `../core/testing/`.

### RTI call fails — `httpRequest()` not reaching the RTI endpoint

`httpRequest()` in Akamai EdgeWorkers can only reach hostnames served by Akamai's network. You must set up a forwarding property that routes your `rtiHost` to `rti-global.cheqzone.com`. Verify the property is active and the hostname matches `config.rtiHost` exactly.

### EdgeWorker is not intercepting requests

Ensure the EdgeWorker behavior is enabled in your Akamai property and the match criteria covers the paths you expect. Check the EdgeWorker activation status in Akamai Control Center — a version must be **active** on the staging or production network.

### JA3/JA4 fingerprints are empty in the RTI payload

Expected on a stock property. There is no Akamai built-in to map, so `PMUSER_CHEQ_JA3` and
`PMUSER_CHEQ_JA4` stay unset and `cheq_ja3` / `cheq_ja4` are omitted — see
[Limitations](#limitations) for what it takes to populate them. The integration works normally
without them.

If you *have* wired up a fingerprinting EdgeWorker or advanced behavior, check that the PMUSER
variable is **declared in the property**: `request.getVariable()` returns `undefined` for an
undeclared variable with no error of any kind, which looks identical to "not configured".

### `cheq_tls_cipher` / `cheq_tls_version` are empty

Unlike JA3/JA4 these need no special entitlement — they map straight from the built-ins
`AK_TLS_CIPHER_NAME` and `AK_TLS_VERSION`. Empty means either the PMUSER variable was never
declared in the property, or no **Set Variable** behavior populates it, or that behavior runs
after the EdgeWorker. Step 2e of [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md) has the setup;
`PMUSER_CHEQ_DEBUG=true` plus `Pragma: akamai-x-ew-debug` shows the payload the worker actually
built.

### PMUSER variables not taking effect

Verify `PMUSER_CHEQ_USE_DYNAMIC_CONFIG` is set to `true` in Property Manager, otherwise the static `config` object in `src/config.ts` is used and PMUSER variables are ignored.

### No challenge is served — suspicious traffic reaches origin

Most often `PMUSER_CHEQ_CHALLENGE_SECRET` is unset, so no challenge is wired. Set
`PMUSER_CHEQ_DEBUG=true` and look for `[cheq] CAPTCHA action but no challenge configured`. Also
check that a reCAPTCHA provider has its site key, secret **and** verify host - missing any one
wires nothing. `browser` needs only the signing secret.

### Challenge loops infinitely

The `_cq_se` session cookie is not being set or sent on subsequent requests. Verify:
- The reCAPTCHA verify host (`PMUSER_CHEQ_RECAPTCHA_HOST`, or `PMUSER_CHEQ_RTI_HOST`) is an Akamai-proxied hostname carrying the `/recaptcha/*` rule (EdgeWorkers cannot reach external hosts directly)
- `PMUSER_CHEQ_CHALLENGE_SECRET` has not changed between issuing and validating - rotating it invalidates every live session cookie
- `Path=/` is correct for your URL structure
- `SameSite` may block the cookie on cross-site navigation

### Fail-open behavior

If the RTI API is unreachable, times out, or throws any error, the EdgeWorker always passes the request through to origin unchanged. Errors are logged via `log.log()` and, if `rtiLoggerHost` is configured, also sent to the RTI logger endpoint.

---

## Limitations

- **RTI sub-requests require Akamai proxying**: `httpRequest()` can only reach Akamai-served hostnames. You must set up a forwarding property for `rti-global.cheqzone.com`.
- **`respondWith()` bodies are capped at 2048 bytes** in `onClientRequest`. Exceeding it makes
  `respondWith()` throw; the throw is swallowed by the outer catch and the request fails open,
  so the symptom is "blocking silently does nothing" rather than an error. This is why Akamai
  uses `generateCompactBlockPage()` and not the full-size page the other CDNs use, and why the
  challenge pages are minified. `core/helpers/block-page-helpers.spec.ts` enforces the budget.
- **`request.getHeader(name)` returns `undefined`, not `[]`, when the header is absent**
  ([Akamai docs](https://techdocs.akamai.com/edgeworkers/docs/request-object)). Indexing `[0]`
  unguarded throws, which again fails open silently. Use the `getHeaderValue()` helper in
  `main.ts`, or `request.getHeader(name)?.[0]`. `types.d.ts` declares the return as
  `string[] | undefined` so the compiler rejects unguarded indexing.
- **`onClientRequest` allows only TWO sub-requests.** `callRTI` spends one, so exactly one is
  left. A CAPTCHA needs it for Google's `siteverify`, which is why telemetry is skipped whenever
  a CAPTCHA verify is about to run. Going over the limit throws
  `"exceeded the limit of 2 subrequests per onClientRequest call"`; the CAPTCHA case catches it
  and falls through to ALLOW, so the visible symptom is that appending
  `?g-recaptcha-response=anything` walks straight past the challenge. Adding a third sub-request
  anywhere in this handler will silently disable CAPTCHA.
- **Browser globals do NOT exist — `crypto`, `TextEncoder` and `URLSearchParams` are modules.**
  EdgeWorkers is not a browser. Each must be imported:
  `import { crypto } from 'crypto'`, `import { TextEncoder } from 'encoding'`,
  `import URLSearchParams from 'url-search-params'` (default export).
  Used bare they still **type-check**, because `tsconfig.json` pulls in the `dom` lib, and they
  still **pass every unit test**, because vitest runs on Node where all three are globals — then
  they throw `ReferenceError` on the edge. In the challenge path that throw is swallowed by
  `main.ts`'s CAPTCHA catch, so the symptom is every challenge silently falling through to ALLOW.
  `types.d.ts` declares the three modules; `src/challenge-signing.spec.ts` mocks them so a
  revert to globals fails the suite; `vitest.config.ts` aliases them to Node's real
  implementations. Note `encoding` — not `text-encode-transform`, which has only the *Stream*
  variants.
- **`Set-Cookie` is denied on `respondWith()` by default** — see the deployment guide. Without
  the `<edgeservices:cookie.pass-set-cookie-policy>` metadata tag the header is dropped silently,
  so no challenge session can ever be established. The challenge redirect therefore also carries
  a short signed `cq_ok` grant, which clears the landing request on its own so a missing tag
  degrades to "challenged again next navigation" instead of an infinite redirect loop.
- **The built-in `log` module exports `logger`, not `log`**: `import { logger as log } from 'log'`.
  Importing `log` passes type-checking against a wrong ambient declaration but fails Akamai's
  static validation at bundle upload time.
- **JA3/JA4 fingerprints are not available from a stock Akamai property.** EdgeWorkers does not
  expose a TLS fingerprint on `EWRequest`, and there is **no `AK_TLS_JA3` built-in** — Akamai's
  built-in system variables carry exactly five TLS entries (`AK_TLS_CIPHER_NAME`,
  `AK_TLS_ENCRYPTION_BITS`, `AK_TLS_PREFERRED_CIPHERS`, `AK_TLS_SNI_NAME`, `AK_TLS_VERSION`) and
  none of them is a fingerprint. Akamai does fingerprint internally — App Security has a JA4
  match condition — but that value is not surfaced to the property as a readable variable.

  The known route is to compute the fingerprint yourself at the edge from `AK_CLIENT_HELLO`, a
  base64 copy of the raw TLS ClientHello that an EdgeWorker parses into a JA3/JA4 string. Both
  halves need Akamai's involvement:

  1. `AK_CLIENT_HELLO` is not in the public built-in list and requires
     `<save-client-hello>on</save-client-hello>` in the ESSL metadata extensions of your CPS
     deployment settings.
  2. Copying it into a PMUSER variable needs an **Advanced Behavior**, which most accounts cannot
     add themselves.

  So this is an account-team request, not a configuration change. Worth asking them in the same
  breath whether your Bot Manager entitlement can surface a fingerprint directly — that would be
  cheaper than computing it, but it varies by contract and is not publicly documented.
  Reference implementation: <https://github.com/nmckay77/ja4-edgeworker>.

  > **Confidence.** The absence of a JA3/JA4 built-in is confirmed against Akamai's official
  > built-in system variables reference. The `AK_CLIENT_HELLO` / `save-client-hello` route is
  > corroborated only by the community EdgeWorker linked above, not by Akamai's own docs — treat
  > it as a strong lead to confirm with your account team rather than as documented behavior.

  Until this is wired up, leave `PMUSER_CHEQ_JA3` / `PMUSER_CHEQ_JA4` undeclared. `main.ts` drops
  both fields via `|| undefined` and the integration runs normally without them.
