# CHEQ RTI – Fastly VCL Integration

This integration intercepts every request at the Fastly edge, sends it to the **CHEQ Real-Time Intelligence (RTI)** service for bot and malicious traffic detection, and takes the appropriate action before the request ever reaches your origin server.

---

## Deployment options

There are two ways to deploy this integration. Choose based on how your Fastly service is managed.

### Option A – VCL Snippets ✅ recommended

**Use when:** You want to add CHEQ RTI to an existing Fastly service without touching your current VCL, or you don't manage a full custom VCL at all.

Snippets inject VCL into specific lifecycle hooks automatically. No `include` statements or `#FASTLY` macros needed. Works alongside any existing VCL.

Files: `snippets/` — see [snippets/README.md](snippets/README.md) for upload instructions.

### Option B – Full Custom VCL

**Use when:** You manage a full custom VCL service and want to `include` the CHEQ RTI subroutines directly alongside your own VCL logic.

Files:
- `cheq_rti.vcl` — all CHEQ RTI subroutine definitions
- `example_main.vcl` — complete wiring example: backend declarations, `vcl_recv`, `vcl_pass`, `vcl_fetch`, `vcl_deliver`, `vcl_error` calling the CHEQ subroutines in the correct order, with `#FASTLY` macro markers

Upload `cheq_rti.vcl` as a non-main include file and `example_main.vcl` (customised with your backends) as the main VCL. See [Setup – Custom VCL](#setup--custom-vcl) below.

---

## How it works

### The big picture

```
Client request
      │
      ▼
 Fastly edge  ──── POST ────▶  CHEQ RTI service
                                     │
                    verdict: allow / block / challenge / redirect
                                     │
     ┌───────────────────────────────┼──────────────────────────────┐
   allow                         challenge                    block / redirect
     │                               │                              │
     ▼                               ▼                              ▼
Customer origin            CAPTCHA challenge page         Synthetic response
(site content)             (reCAPTCHA v2 widget)          (403 / 404 / 302)
     │                               │                    (origin never called)
     │                    User solves CAPTCHA
     │                               │
     │              POST /?captcha=<hmac-nonce>
     │                               │
     │                    Compute@Edge verifies
     │                    token with Google
     │                               │
     │                    Set-Cookie: cq_session_token
     │                    (HMAC-signed, IP-bound)
     │                               │
     ▼                               ▼
Response to client         Redirect back to original URL
(with x-cheq-rti-result)   (session cookie bypasses future checks)
```

The origin is **only called when RTI says allow**. Blocked, redirected, or challenged requests receive a synthetic response directly from the Fastly edge — the customer's origin server is never touched for those requests.

---

### Why the standard VCL lifecycle diagram can be misleading

A typical Fastly VCL service has a single backend call:

```
Client → vcl_recv → [backend] → vcl_backend_response → vcl_deliver → Client
```

It looks like there is one "backend" — your origin. But in this integration, **"backend" means something different depending on the restart count**:

- On **restart 0**, the backend is the **CHEQ RTI service** — the original request is converted to a POST with `X-Cheq-Param-*` request headers carrying all RTI parameters.
- On **restart 1**, the backend is your **customer origin** — but only if RTI said allow. If RTI said block, redirect, or challenge, the origin is never called; Fastly serves a synthetic response directly.

This means the VCL lifecycle runs **twice per client request**, each time against a different backend. The `return(restart)` at the end of restart 0's `vcl_backend_response` is what triggers the second pass.

---

### Under the hood – the restart pattern

Because Fastly VCL cannot branch mid-request (make an external call, read the result, then decide what to do), this integration uses a **two-restart pattern** to work around that limitation:

```
── RESTART 0: RTI check ──────────────────────────────────────────────────────

Client request
  → vcl_recv (restart 0)
      Stash original request (method, URL, host)
      Build X-Cheq-Param-* request headers from client data
      (_cq_duid → X-Cheq-Param-Duid-Cookie, _cq_pvid → X-Cheq-Param-Pvid-Cookie,
       _cq_s → X-Cheq-Param-S-Cookie [v4.1+])
      Switch backend to CHEQ RTI, convert request to POST

  → vcl_pass (restart 0)
      X-Cheq-Param-* headers forwarded directly to RTI endpoint
      (no JSON body — RTI reads the parameters from X-Cheq-Param-* request headers)

  ← vcl_fetch (restart 0)           ← RTI responded with HTTP (normal path)
      Read verdict from RTI X-Cheq-Res-* response headers:
        malicious                  → action = "block"
        suspicious                 → action = "challenge"
        TT-code / Reasons override → action = "block" | "challenge" | "redirect"
        RTI HTTP error (>= 400,    → action = "allow"  (fail-open, logged as error)
          incl. 504 from backend)
        everything else            → action = "allow"
      Monitoring mode always sets action = "allow"
      Fire telemetry log (if enabled)
      → return(restart)

  ← vcl_error (503, restart 0)      ← RTI connection failed / Fastly-level timeout
      Backend unreachable — vcl_fetch was never called
      Fail-open: restart without setting X-Cheq-Action
      → return(restart)             (restart 1 treats unset action as "allow")
      NOTE: Fastly-generated 504 is NOT handled here — only 503 is caught

── RESTART 1: act on verdict ─────────────────────────────────────────────────

  → vcl_recv (restart 1)
      Read X-Cheq-Action
      │
      ├─ "block"     → error 403 / 404
      │                   → vcl_error: serve synthetic response to client
      │                                fire telemetry log (if enabled)
      │                                ← origin never called
      │
      ├─ "redirect"  → error 302
      │                   → vcl_error: serve redirect to client
      │                                fire telemetry log (if enabled)
      │                                ← origin never called
      │
      ├─ "challenge" → error 601
      │                   → vcl_error: serve reCAPTCHA v2 challenge page
      │                                (origin never called)
      │
      └─ "allow"     → restore original request (method, URL, host)
                          → return(pass)
                               │
                               ▼
  → vcl_pass (restart 1)
      Strip all internal X-Cheq-* headers so they never reach origin
      Forward request to customer origin

  ← vcl_fetch (restart 1)
      Origin response received

  ← vcl_deliver
      Attach x-cheq-rti-result header to the origin response
      Fire telemetry log (if enabled)
      Strip all remaining internal CHEQ headers
      Deliver response to client
```

**Fail-open:** If the RTI backend returns an HTTP error (>= 400) or times out, the integration logs the error and passes the request through to origin. HTTP errors set action to `allow` explicitly; timeouts skip `vcl_fetch` entirely (via `vcl_error` 503) and restart with no action set, which also routes to origin. Errors never block legitimate traffic.

---

### CAPTCHA challenge flow

When the challenge strategy is `"captcha"`, the integration serves a Google reCAPTCHA v2 challenge page and verifies the token via a separate **Compute@Edge** service (`handler.js`).

#### reCAPTCHA keys

Google reCAPTCHA v2 issues two keys per site. Get them at [g.co/recaptcha/admin](https://www.google.com/recaptcha/admin) → **+ Create** → type **I'm not a robot (v2 Checkbox)**:

| Key | Public / Private | Where it goes | Purpose |
|---|---|---|---|
| **Site key** | Public — safe to expose in HTML | `captcha_site_key` in `general_config` Edge Dictionary | Renders the reCAPTCHA widget in the browser |
| **Secret key** | Private — never expose | `recaptcha_secret_key` in the Compute@Edge **Config Store** (`cheq_rti_config`) | Verifies the token server-side with Google's `siteverify` API |

When creating the site key, add your Fastly service domain(s) under **Domains** (e.g. `yoursite.edgecompute.app`). reCAPTCHA will reject tokens from unlisted domains.

#### Session cookie — `cq_session_token`

After a successful CAPTCHA solve, the integration sets a session cookie so the user is not re-challenged on subsequent requests:

| Property | Value |
|---|---|
| Name | `cq_session_token` |
| Value | `HMAC-SHA256(api_key, "<client_ip>:<unix_timestamp_seconds>")` |
| TTL | `captcha_session_ttl` seconds (default `900` = 15 min) from the `general_config` dictionary |
| Scope | IP-bound and time-bound. Cannot be reused from a different IP address. |

`vcl_recv` revalidates the HMAC and timestamp on every request. A valid cookie bypasses RTI entirely.

#### Full challenge flow

```
1. vcl_error (status 601)
     Serve HTML page with reCAPTCHA v2 widget
     Embed HMAC nonce in form: data-captcha-nonce=HMAC(api_key, client_ip)

2. User solves CAPTCHA → browser POSTs to /?captcha=<nonce>

3. vcl_recv
     Verify nonce = HMAC(api_key, client_ip)  ← IP-bound, unforgeable
     Valid  → forward POST to Compute@Edge captcha backend
     Invalid → re-serve challenge (fabricated requests silently dropped)

4. Compute@Edge (handler.js)
     POST /validate/<site_key>
     Verify token with Google reCAPTCHA siteverify API
     Success → 302 redirect to original URL
     Failure → captchaFail: 1 header

5. vcl_fetch
     Success path:
       Replace unsigned captchaAuth cookie with HMAC-signed cq_session_token
       Cookie: HMAC(api_key, client_ip:timestamp_s), TTL = captcha_session_ttl
     Failure path:
       Set X-Cheq-Captcha-Fail, restart → re-serve challenge

6. Subsequent requests: vcl_recv checks cq_session_token cookie
     Valid HMAC + not expired → bypass RTI entirely, go straight to origin
```

---

## Files

```
fastly/
├── vcl/
│   ├── cheq_rti.vcl        ← RTI subroutines – include in your VCL service
│   └── example_main.vcl    ← Full wiring example showing how to call the subroutines
└── compute/
    └── src/
        └── handler.js      ← Compute@Edge service: reCAPTCHA v2 token verification
```

---

## Configuration

All configuration is read at runtime from **Fastly Edge Dictionaries** — no VCL redeployment is needed to change values. Create the dictionaries in the Fastly UI under **Data → Dictionaries** before activating the service.

### `general_config` dictionary

The primary runtime configuration dictionary. All keys are strings.

#### Required keys

| Key | Description |
|---|---|
| `api_key` | Your CHEQ API key (from the Paradome platform) |
| `tag_hash` | Your CHEQ tag hash (from the Paradome platform) |

#### Host header override (optional)

| Key | Default | Description |
|---|---|---|
| `origin_host` | *(empty — disabled)* | When set, overrides the `Host` header sent to the origin on restart 1 and session-bypass requests. Required when your origin expects a specific hostname different from your Fastly domain. |

#### RTI endpoint

| Key | Default | Description |
|---|---|---|
| `api_hostname` | `rti-global.cheqzone.com` | RTI endpoint hostname. **Must match `.host` in `cheq_rti_backend`**. Change to `obs.dev.cheqzone.com` for dev/testing only. |

#### Action mode

| Key | Default | Values | Description |
|---|---|---|---|
| `mode` | `blocking` | `monitoring` | Call RTI and log, but **never block**. Safe for initial rollout. |
| | | `blocking` | Enforce actions — block, redirect, challenge, or allow based on the RTI verdict. |

#### Blocking and challenge behaviour

Only relevant when `mode = blocking`.

| Key | Default | Values | Description |
|---|---|---|---|
| `block_strategy` | `access_denied` | `access_denied` | Return HTTP 403 for blocked traffic |
| | | `not_found` | Return HTTP 404 for blocked traffic |
| | | `redirect` | Redirect to `redirect_loc` |
| | | `captcha` | Serve reCAPTCHA v2 challenge |
| `challenge_strategy` | `captcha` | same as above | Action for `suspicious` traffic |
| `redirect_loc` | `https://www.cheq.ai/` | URL | Redirect destination when strategy is `redirect` |

#### CAPTCHA keys

Required only when `block_strategy` or `challenge_strategy` is `captcha`.

| Key | Description |
|---|---|
| `captcha_site_key` | Google reCAPTCHA v2 **site key** (public — embedded in the challenge page) |
| `captcha_host` | Hostname of your Compute@Edge captcha verification service. **Must match `.host` in `cheq_captcha_backend`** |
| `captcha_session_ttl` | Session cookie TTL in seconds after a successful CAPTCHA solve. Default: `900` (15 min) |

#### Telemetry and debug

| Key | Default | Values | Description |
|---|---|---|---|
| `logging` | `false` | `true` / `false` | Send RTI timing and verdict to the CHEQ logger after each request |
| `debug` | `false` | `true` / `false` | Write debug messages to the Fastly real-time log stream |

---

### `ignored_paths_config` dictionary

Paths that bypass RTI entirely and go straight to origin. Runtime alternative to the hardcoded regex in `cheq_rti_recv` — no redeployment needed.

| Key | Value | Description |
|---|---|---|
| `/api/health` | `1` | Exact `req.url.path` to skip. Add one entry per path. |

A hardcoded regex also runs before the dictionary check:
```
(?i)^/(favicon\.ico|robots\.txt|health|ping)
```
This regex is defined in the `cheq_rti_recv` subroutine, marked with the comment `# (CONFIGURE THIS REGEX - URL PATHS TO IGNORE)`. To add or remove paths, extend the alternation group — for example, to also skip `sitemap.xml`:
```
(?i)^/(favicon\.ico|robots\.txt|health|ping|sitemap\.xml)
```
To disable the hardcoded regex entirely so all paths are evaluated by RTI, comment out the `if` block marked `# (CONFIGURE THIS REGEX - URL PATHS TO IGNORE)` in the VCL source. Then redeploy the changed file:
- **Snippet deployment**: edit `snippets/init.vcl`, then upload and activate the snippet.
- **Standalone VCL**: edit `cheq_rti.vcl`, then redeploy.

---

### `block_tt_codes` / `challenge_tt_codes` / `redirect_tt_codes` dictionaries

Override the action for specific RTI Classification-Code values, regardless of the verdict string.

| Key | Value | Description |
|---|---|---|
| `7` | `1` | Force block / challenge / redirect for this Classification-Code |

Add integer code strings as keys (value always `1`). Changes take effect immediately — no redeployment needed. Fastly VCL regex must be compile-time literals, so exact-match table lookup is used instead of regex for these integer values.

#### Reasons override (regex)

To trigger an action based on the RTI **Reasons** field (a comma-separated list of integer reason codes, e.g. `5,10,15`) rather than Classification-Code, edit the literal regex patterns marked `# (CONFIGURE THIS REGEX - BLOCKING/CHALLENGE/REDIRECT REASONS)` in the `cheq_rti_backend_response` subroutine. There is one pattern per action (block, challenge, redirect). Example pattern to match any of reason codes 5, 10, or 15:
```
(^|,)(5|10|15)(,|$)
```
The boundary anchors (`^`, `$`, `,`) ensure `5` does not match `15` or `25`. To disable the Reasons override and revert to Classification-Code only, restore the default no-match pattern (this is a control that should never appear in the data):
```
^\x01$
```
This matches the SOH control character (`\x01`), which never appears in a real Reasons value, so the condition is effectively disabled. Because Fastly VCL regex must be compile-time literals, these patterns cannot be moved to a dictionary and must be edited in the VCL source then redeployed:
- **Snippet deployment**: edit `snippets/init.vcl`, then upload and activate the snippet.
- **Standalone VCL**: edit `cheq_rti.vcl`, then redeploy.

---

## Telemetry logging
NOTE: THIS IS CURRENTLY IMPLEMENTED BUT WAS NEVER INTEGRATED VIA ONE OF THE VCL LOGGING OPTIONS SO IT CONSIDERED AS NOT WORKING!

When `logging = true` in `general_config`, the integration sends RTI timing and verdict data to the CHEQ RTI Logger service after every request — mirroring `context.waitUntil(log(duration))` in the Cloudflare integration. This includes both normal requests and RTI errors.

| Event | Log level | Message |
|---|---|---|
| Normal request | `info` | `rti_duration: <milliseconds>` |
| RTI backend error (HTTP >= 400) | `error` | `rti_error: <status code>` |

Logging fires in three places so no request is missed:
- **`vcl_deliver`** — for requests that reach the origin (allow path)
- **`vcl_error`** — for blocked/redirected/challenged requests (Fastly skips `vcl_deliver` for synthetic responses)
- **`vcl_fetch`** — immediately on RTI error, before restarting

Because Fastly VCL cannot make arbitrary HTTP calls inline, logging is delivered via a **Fastly HTTPS Logging endpoint**. You must create this in your Fastly service before telemetry will work:

| Field | Value |
|---|---|
| Name | `cheq-rti-logger` *(must match exactly)* |
| URL | `https://rtilogger.production.cheq-platform.com` |
| Method | `POST` |
| Content-Type | `application/json` |
| Format | `%{req.http.X-Cheq-Log-Payload}V` |

Logging is fire-and-forget and does not add latency to the request.

---

## Debug logging

When `debug = true` in `general_config`, the integration writes messages to Fastly's real-time log stream at the same three points as the `console.log` calls in the Cloudflare integration:

| Point | Message |
|---|---|
| After building the RTI request | `CHEQ-DEBUG :: request clientIp=<ip> url=<url> duid=<duid> pvid=<pvid> scookie=<scookie>` |
| After receiving the RTI response | `CHEQ-DEBUG :: rti response status=<n> X-Cheq-Res-Verdict=<v> X-Cheq-Res-Classification-Code=<c>` |
| After determining the action | `CHEQ-DEBUG :: action=<allow\|block\|challenge\|redirect>` |

Stream the logs live with the Fastly CLI:
```bash
fastly log-tail --service-id=<SERVICE_ID>
```

> **Do not leave `debug = true` in production.** The debug payload contains request headers and cookie values.

---

## RTI response header requirement

Fastly VCL cannot inspect a backend **response body** — only response **headers**. The RTI service must therefore return the verdict as HTTP response headers:

| Header | Values | Description |
|---|---|---|
| `X-Cheq-Res-Verdict` | `benign` / `suspicious` / `malicious` | The traffic classification |
| `X-Cheq-Res-Classification-Code` | integer | Threat-type code; used for TT-code override dictionaries |
| `X-Cheq-Res-Version` | string | Schema version |
| `X-Cheq-Res-Reasons` | comma-separated integers | Detection reason codes; used in Reasons override regex rules |
| `X-Cheq-Res-Rti-Result` | string | Pre-built result string attached to the origin response as `x-cheq-rti-result` |

---

## Setup

### Step 1 – Create a Fastly Compute@Edge service for CAPTCHA verification

> Skip this step if you are not using `captcha` as a block or challenge strategy.

The CAPTCHA verification service runs `compute/src/handler.js` as a Fastly Compute@Edge service. It receives the reCAPTCHA token POST from the browser, verifies it with Google, and returns the result to the VCL service.

1. Install the [Fastly CLI](https://developer.fastly.com/reference/cli/) and authenticate
2. From `integrations/fastly/compute/`:
   ```bash
   npm install
   fastly compute publish
   ```
3. Note the deployed service hostname (e.g. `entirely-wanted-colt.edgecompute.app`)
4. In the Compute@Edge service, create a **Config Store** named `cheq_rti_config` with these keys:

   | Key | Value |
   |---|---|
   | `recaptcha_secret_key` | Your Google reCAPTCHA v2 **secret key** |
   | `debugging_enabled` | `true` or `false` (default false) |

---

### Step 2 – Create the Edge Dictionaries

Before uploading VCL, create the following dictionaries in your Fastly VCL service under **Data → Dictionaries**:

| Dictionary name | Purpose |
|---|---|
| `general_config` | Primary runtime config (api_key, tag_hash, mode, strategies, etc.) |
| `ignored_paths_config` | Paths that bypass RTI; key = exact path, value = `1` |
| `block_tt_codes` | Classification-Code values that force action = block; key = integer string, value = `1` |
| `challenge_tt_codes` | Classification-Code values that force action = challenge; key = integer string, value = `1` |
| `redirect_tt_codes` | Classification-Code values that force action = redirect; key = integer string, value = `1` |

At minimum, populate `general_config` with `api_key` and `tag_hash` and `origin_host`

---

### Step 3 – Edit `example_main.vcl`

Update the three backend declarations with your real hostnames:

```vcl
# Your origin server
backend origin_backend {
    .host = "your-origin.example.com";
    .port = "443";
    .ssl  = true;
    .ssl_sni_hostname  = "your-origin.example.com";
    .ssl_cert_hostname = "your-origin.example.com";
}

# CHEQ RTI service — .host must match api_hostname in general_config
backend cheq_rti_backend {
    .host = "rti-global.cheqzone.com";  # production
    .port = "443";
    .ssl  = true;
    .ssl_sni_hostname  = "rti-global.cheqzone.com";
    .ssl_cert_hostname = "rti-global.cheqzone.com";
    .connect_timeout       = 300ms;
    .first_byte_timeout    = 300ms;
    .between_bytes_timeout = 300ms;
}

# CAPTCHA verification (Compute@Edge) — required only when using captcha strategy
# .host must match captcha_host in general_config
backend cheq_captcha_backend {
    .host = "your-service.edgecompute.app";  # from Step 1
    .port = "443";
    .ssl  = true;
    .ssl_sni_hostname  = "your-service.edgecompute.app";
    .ssl_cert_hostname = "your-service.edgecompute.app";
    .connect_timeout       = 5s;
    .first_byte_timeout    = 10s;
    .between_bytes_timeout = 10s;
}
```

> **HTTP origin (e.g. S3 static website):** use `.port = "80"`, `.ssl = false`, and remove the `.ssl_sni_hostname` / `.ssl_cert_hostname` lines.

---

### Step 4 – Create a Fastly VCL service

1. Sign in at **manage.fastly.com**
2. Click **Create Service** → select **VCL**
3. Enter a service name and your domain → click **Create**
4. You will land on the service configuration screen. Click **Edit Configuration** → **Clone version to edit** to begin

---

### Step 5 – Add a placeholder origin

Fastly requires at least one origin to save the service configuration. Your backends are declared in the custom VCL (step 7), so add a placeholder here — it will not be used at runtime.

1. Left sidebar → **Origins** → **Create a host**
2. Enter any hostname (e.g. `placeholder.example.com`)
3. Click **Add**

---

### Step 6 – Enable Custom VCL

Custom VCL must be enabled on your Fastly account before you can upload VCL files. If the Custom VCL option is not visible in the sidebar, contact Fastly support to have it enabled.

---

### Step 7 – Upload the VCL files

Upload both files in order:

**1. Upload `cheq_rti.vcl` as an included file:**
1. Left sidebar → **Custom VCL** → **Create custom VCL**
2. Name: `cheq_rti`
3. Content: paste the contents of `vcl/cheq_rti.vcl`
4. Leave **Main** toggle **off** (this is an included file, not the main)
5. Click **Create**

**2. Upload `example_main.vcl` as the main file:**
1. Click **Create custom VCL** again
2. Name: `main` (or any name)
3. Content: paste the contents of `vcl/example_main.vcl` (with your backend hostnames already updated from Step 3)
4. Toggle **Main** to **on**
5. Click **Create**

> The main VCL file must contain the `#FASTLY recv` / `#FASTLY deliver` etc. macro comments — `example_main.vcl` already has these. Fastly injects its own boilerplate at those markers.

---

### Step 8 – Configure the logging endpoint (if using telemetry)

Skip this step if `logging = false` in `general_config`.

1. Left sidebar → **Logging** → **HTTPS** → **Create endpoint**
2. Fill in:

| Field | Value |
|---|---|
| Name | `cheq-rti-logger` *(must match exactly)* |
| URL | `https://rtilogger.production.cheq-platform.com` |
| Method | `POST` |
| Content-Type | `application/json` |
| Format | `%{req.http.X-Cheq-Log-Payload}V` |

3. Click **Create**

---

### Step 9 – Activate

1. Click **Activate** (top right of the service configuration screen)
2. Fastly will validate and deploy the VCL. Any VCL syntax errors will be shown here before activation.

---

### Step 10 – Verify

```bash
curl -sI https://your-fastly-domain.com | grep x-cheq-rti-result
```

A successful response includes:
```
x-cheq-rti-result: version=4.1;verdict=benign;threat-type-code=0
```

To stream debug logs live (requires `debug = true` in `general_config`):
```bash
fastly log-tail --service-id=<SERVICE_ID>
```


---

## Setup – Custom VCL (`cheq_rti.vcl` + `example_main.vcl`)

Use this path only if you are managing a **full custom VCL service**. If you are using VCL Snippets, see [snippets/README.md](snippets/README.md) instead.

### Step 1 – Deploy the Compute@Edge CAPTCHA service

> Skip if not using `captcha` strategy.

```bash
cd integrations/fastly/compute
npm install
fastly compute publish
```

Note the deployed hostname (e.g. `entirely-wanted-colt.edgecompute.app`). Create a **Config Store** named `cheq_rti_config` in the Compute@Edge service:

| Key | Value |
|---|---|
| `recaptcha_secret_key` | Your Google reCAPTCHA v2 secret key |
| `debugging_enabled` | `true` or `false` |

### Step 2 – Create the Edge Dictionaries

In **Data → Dictionaries**, create all 5 dictionaries before uploading VCL:

| Dictionary name | Purpose |
|---|---|
| `general_config` | Primary config (`api_key`, `tag_hash`, `mode`, strategies, etc.) |
| `ignored_paths_config` | Paths that bypass RTI; key = exact path, value = `1` |
| `block_tt_codes` | Classification-Code values → force block; key = integer string, value = `1` |
| `challenge_tt_codes` | Classification-Code values → force challenge |
| `redirect_tt_codes` | Classification-Code values → force redirect |

Populate `general_config` with at minimum `api_key` and `tag_hash`.

### Step 3 – Update `example_main.vcl`

Replace the three backend declarations with your real hostnames:

```vcl
backend origin_backend {
    .host = "your-origin.example.com";
    .port = "443";
    .ssl  = true;
    .ssl_sni_hostname  = "your-origin.example.com";
    .ssl_cert_hostname = "your-origin.example.com";
}

backend cheq_rti_backend {
    .host = "rti-global.cheqzone.com";
    .port = "443";
    .ssl  = true;
    .ssl_sni_hostname  = "rti-global.cheqzone.com";
    .ssl_cert_hostname = "rti-global.cheqzone.com";
    .connect_timeout       = 300ms;
    .first_byte_timeout    = 300ms;
    .between_bytes_timeout = 300ms;
}

# Required only when using captcha strategy
backend cheq_captcha_backend {
    .host = "your-service.edgecompute.app";
    .port = "443";
    .ssl  = true;
    .ssl_sni_hostname  = "your-service.edgecompute.app";
    .ssl_cert_hostname = "your-service.edgecompute.app";
}
```

Also update `vcl_pass` to set `bereq.http.Host` to your origin hostname for restart >= 1.

### Step 4 – Create a Fastly VCL service

1. **manage.fastly.com → Create Service → VCL**
2. Enter a service name and your domain → Create
3. Edit Configuration → Clone version to edit

### Step 5 – Add a placeholder origin

Fastly requires at least one origin before saving. Add a placeholder (e.g. `placeholder.example.com`) under **Origins → Create a host** — it will not be used at runtime.

### Step 6 – Enable Custom VCL

Custom VCL must be enabled on your account. If **Custom VCL** is not visible in the sidebar, contact Fastly support.

### Step 7 – Upload the VCL files

**Upload `cheq_rti.vcl` as a non-main include:**
1. Left sidebar → **Custom VCL → Create custom VCL**
2. Name: `cheq_rti`, content: paste `vcl/cheq_rti.vcl`, **Main = off**

**Upload `example_main.vcl` as the main file:**
1. Click **Create custom VCL** again
2. Name: `main`, content: paste your updated `vcl/example_main.vcl`, **Main = on**

> `example_main.vcl` contains the `#FASTLY recv` / `#FASTLY deliver` / `#FASTLY pass` / `#FASTLY fetch` / `#FASTLY error` macro comments that Fastly requires in the main VCL. Do not remove them.

### Step 8 – Configure the HTTPS logging endpoint

> Skip if `logging = false` in `general_config`.

**Logging → HTTPS → Create endpoint:**

| Field | Value |
|---|---|
| Name | `cheq-rti-logger` *(must match exactly)* |
| URL | `https://rtilogger.production.cheq-platform.com` |
| Method | `POST` |
| Content-Type | `application/json` |
| Format | `%{req.http.X-Cheq-Log-Payload}V` |

### Step 9 – Activate

Click **Activate** (top right). Fastly validates and deploys. VCL syntax errors appear here before activation.

### Step 10 – Verify

```bash
curl -sI https://your-fastly-domain.com | grep x-cheq-rti-result
```

Expected:
```
x-cheq-rti-result: version=4.1;verdict=benign;threat-type-code=0
```

Stream debug logs live (requires `debug = true` in `general_config`):
```bash
fastly log-tail --service-id=<SERVICE_ID>
```

