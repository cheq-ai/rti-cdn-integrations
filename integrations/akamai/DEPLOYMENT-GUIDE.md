# CHEQ RTI — Akamai EdgeWorker: Complete Deployment & Configuration Guide

# Part 1 — Install & Configure

This guide walks your Akamai team through deploying the CHEQ RTI (Real-Time Interception)
bot-protection EdgeWorker on your Akamai property, using **EdgeWorkers Management** and
**Property Manager** in Akamai Control Center.

The guide has two parts:
- **Part 1 — Install & configure** (below): EdgeWorkers + Property Manager + go-live
- **Part 2 — Challenge (CAPTCHA) & action control**: Google reCAPTCHA v2/v3, browser challenge,
  and the full action / threat-code / reason matrix

### What CHEQ shares with you

| File | Role |
|---|---|
| `cheq-rti-edgeworker.tgz` (**Always use the latest version**) | EdgeWorker code bundle to upload |
| `DEPLOYMENT-GUIDE.md` (this file) | Complete guide: install, configure, CAPTCHA, action matrix |

---

## How it works (1 minute)

- On every incoming request, the EdgeWorker (`onClientRequest`) sends the request metadata to
  the CHEQ RTI API, which classifies it: `benign`, `suspicious`, or `malicious`.
- In **MONITORING** mode it only classifies — the verdict is attached to the origin-bound
  request as an `x-cheq-rti-result` header. Nothing is ever blocked.
- In **BLOCKING** mode, malicious traffic is blocked (403, stealth 404, or redirect) and
  suspicious traffic can be sent to a CAPTCHA — fully configurable per threat type.
- **Fail-open by design:** on any error (RTI unreachable, timeout, misconfiguration) the
  request passes through to your origin untouched. CHEQ protection can never take your site down.
- Static assets, health checks, `robots.txt`, etc. skip classification entirely (configurable
  ignore list).

## What you need before starting

| Item | Provided by |
|---|---|
| `cheq-rti-edgeworker.tgz` — the code bundle | CHEQ |
| CHEQ API key + tag hash | CHEQ |
| Akamai Control Center access with EdgeWorkers entitlement | Your team |
| An Akamai delivery property for your site (e.g. `www.example.com`) | Your team |
| (Optional, for Google CAPTCHA) reCAPTCHA site + secret keys from [Google reCAPTCHA admin](https://www.google.com/recaptcha/admin) | Your team |

### Property recommendations (so classification runs on every page)

These are Property Manager / delivery settings on **your** site property — not EdgeWorker code.
They match how CHEQ expects traffic to flow:

| Topic | Recommendation |
|---|---|
| **HTML / documents** | **Bypass cache** for HTML and document responses. Cached HTML never re-enters `onClientRequest`, so CHEQ would not re-classify the visitor. |
| **Static assets** | Caching CSS/JS/images is fine. The EdgeWorker also skips common static paths via its ignore list (no RTI call). |
| **EdgeWorkers behavior** | Keep it on the **Default Rule** (all requests). Do not scope it to a narrow path match — the worker's ignore list already skips static and infra paths. |
| **SureRoute / health probes** | Paths under `/akamai/` and common health checks are ignored by default so probe traffic is not classified. |

---

## Step 1 — EdgeWorkers Management: create the EdgeWorker and upload the bundle

In Akamai Control Center → **CDN** → **EdgeWorkers** (EdgeWorkers Management):

1. **Create EdgeWorker ID** (first time only):
   - Name: e.g. `CHEQ RTI`
   - Group: the access group that owns your site property
   - Resource Tier: **Dynamic Compute (200)** recommended; Basic Compute (100) also works
2. Open the new EdgeWorker → **Create version**:
   - Drag & drop `cheq-rti-edgeworker.tgz`, **or** use the CLI:

     ```bash
     akamai edgeworkers upload --edgeworker-id <EDGEWORKER_ID> --bundle cheq-rti-edgeworker.tgz
     ```

3. **Activate** the version on **Staging** first (Production comes after Step 4 testing).

> Note: every bundle upload must carry a unique `edgeworker-version` (CHEQ manages this —
> if you ever receive an updated bundle, it will already have a new version number).

## Step 2 — Property Manager: wire the EdgeWorker into your property

In Akamai Control Center → **Property Manager** → your site's property (Property Details) →
**Edit New Version**.

### 2a. Add the EdgeWorkers behavior (Default Rule)

In the **Default Rule**, add the behavior **EdgeWorkers**:

- EdgeWorker Identifier: the EdgeWorker created in Step 1
- **Continue on error: On** — set this. It tells Akamai to drop the EdgeWorker from a
  request and carry on to origin if the worker itself cannot run (a resource limit, a
  failed initialisation). Those failures are not catchable in JavaScript, so this switch
  is the only thing standing between them and an error page. Left **Off**, a CHEQ-side
  problem becomes an outage on your site — which contradicts the integration's fail-open
  design, where every error path deliberately lets the visitor through.

Keeping the behavior in the Default Rule means `onClientRequest` fires on **every** request —
required for site-wide protection. (The worker's own ignore list handles static assets, so
there is no need to scope the behavior to a sub-rule.)

### 2b. Add the "CHEQ RTI Forward" rule (self-proxy)

The EdgeWorker calls the RTI API as a sub-request to your **own** hostname on the path
`/defend/*`; a Property Manager rule routes that path to CHEQ's API origin. This avoids any
extra Akamai property, and there is no recursion — Akamai does not run EdgeWorkers on
sub-requests, and `/defend/` is in the worker's ignore list.

1. **Add a child rule** named `CHEQ RTI Forward` (`+Rules` → Blank Rule Template) and **drag it
   to the BOTTOM of the top-level rule list**.
   - *Why last:* Property Manager is last-match-wins — placing the override last guarantees no
     template rule (caching, offload, etc.) can override the origin for `/defend/*`.
2. Criteria: **Path** · matches one of · `/defend/*`
3. Behavior **Origin Server**:

   | Field | Value |
   |---|---|
   | Origin Type | Your Origin |
   | Origin Server Hostname | `rti-global.cheqzone.com` |
   | Forward Host Header | Origin Hostname (*CHEQ routes by Host header*) |
   | Cache Key Hostname | Origin Hostname |
   | Verification Settings | **Choose Your Own Settings** (*required — the SNI toggle below is a custom setting*) |
   | Match CN/SAN To | defaults: `{{Origin Hostname}}`, `{{Forward Host Header}}` |
   | Trust | Akamai-managed Certificate Authorities Sets (Akamai Certificate Store) |
   | Use SNI TLS Extension | **Yes** (*CHEQ's endpoint presents its TLS certificate based on SNI*) |
   | Ports | HTTP 80 / HTTPS 443 (defaults) |

4. Behavior **Caching** → Bypass cache (RTI calls are POST, which Akamai never caches by
   default — this makes the intent explicit).

### 2c. (Optional — only if using Google reCAPTCHA) add the verify rule

Same pattern as 2b:

- Rule name: `CHEQ reCAPTCHA Verify` — drag to bottom of the top-level list
- Criteria: Path matches `/recaptcha/*`
- Origin Server Hostname: `www.google.com`
- Forward Host Header / Cache Key Hostname: Origin Hostname
- Verification: Choose Your Own Settings; Use SNI: Yes
- Caching: Bypass cache

### 2d. Declare property variables

In the Property Variables section (above the rule tree, `+ Variables`), add:

| Variable | Initial value | Visibility |
|---|---|---|
| `PMUSER_CHEQ_DEBUG` | `true` during rollout, `false` in production | Visible |
| `PMUSER_CHEQ_RTI_FLOW` | (empty) | Visible |

*Why these exist:* the EdgeWorker runs as two isolated invocations — `onClientRequest`
(classifies, tags the origin-bound request) and `onClientResponse` (optionally echoes the
verdict header to the browser for debugging). They share no state; PMUSER variables are the
bridge, and EdgeWorkers may only read/write variables **declared in the property**. With debug
off, the verdict is visible only in origin logs — the production posture (don't advertise
classification results to bots).

If you want console-controlled configuration (recommended — no bundle uploads for config
changes), also declare the dynamic-config variables from the reference table below, starting
with:

| Variable | Value | Security Setting |
|---|---|---|
| `PMUSER_CHEQ_USE_DYNAMIC_CONFIG` | `true` | Visible |
| `PMUSER_CHEQ_API_KEY` | your CHEQ API key | **Hidden** (credential — keep out of debug headers; use Sensitive if your policy requires write-only secrets) |
| `PMUSER_CHEQ_TAG_HASH` | your CHEQ tag hash | **Hidden** |
| `PMUSER_CHEQ_RTI_HOST` | your property hostname, e.g. `www.example.com` | Visible |
| `PMUSER_CHEQ_MODE` | `MONITORING` (switch to `BLOCKING` after validation) | Visible |

> **Naming:** type the name WITHOUT the `PMUSER_` prefix - the UI adds it. The full name,
> prefix included, must be at most **32 characters** and contain only letters, digits and
> underscore, or Property Manager refuses it with *"Illegal name in Variable"*. An
> over-long name cannot be declared at all, so the EdgeWorker reads `undefined` forever and
> the setting silently does nothing.

> Security Setting controls UI display and whether the value can surface in Akamai debug
> headers — the EdgeWorker reads the variable either way. Rule of thumb: secrets
> (`API_KEY`, `TAG_HASH`, `RECAPTCHA_SECRET`) are **Hidden**; everything else Visible.

### 2e. Optional — send TLS and fingerprint data

The EdgeWorker can add four extra fields to the RTI payload: `cheq_tls_cipher`,
`cheq_tls_version`, `cheq_ja3` and `cheq_ja4`. All four are read from PMUSER variables, so
Property Manager has to populate them — none of it is automatic. Each field is simply omitted
from the payload when its variable is unset, so you can wire up some, all or none of them.

**TLS cipher and version — available on any property, no Akamai involvement.**

Declare two more variables in Property Variables (type the name without the `PMUSER_` prefix,
both Visible):

| Declare as | Full name |
|---|---|
| `CHEQ_TLS_CIPHER` | `PMUSER_CHEQ_TLS_CIPHER` |
| `CHEQ_TLS_VERSION` | `PMUSER_CHEQ_TLS_VERSION` |

Then add a **Set Variable** behavior to the Default Rule for each, taking the value from an
expression:

| Variable | Value expression | Example value |
|---|---|---|
| `PMUSER_CHEQ_TLS_CIPHER` | `{{builtin.AK_TLS_CIPHER_NAME}}` | `ECDHE-RSA-AES128-GCM-SHA256` |
| `PMUSER_CHEQ_TLS_VERSION` | `{{builtin.AK_TLS_VERSION}}` | `TLSv1.3` |

Both variables must be **declared** as above. A variable that Property Manager sets and the
EdgeWorker reads has to exist in the property; otherwise `request.getVariable()` returns
`undefined` forever and the field silently never appears — there is no error anywhere. Keep
the Set Variable behavior in the Default Rule so it is evaluated before the EdgeWorker runs
`onClientRequest`, and confirm that ordering with the debug trace below rather than assuming it.

> On a plain-HTTP request `AK_TLS_CIPHER_NAME` returns the literal string `NO-CIPHER`. That is a
> truthy value, so it is forwarded to CHEQ verbatim as `cheq_tls_cipher`. Harmless on an
> HTTPS-only property; ask CHEQ for a guarded bundle if you would rather the field were absent.

**JA3 / JA4 — not self-serve.** No Akamai built-in yields a TLS fingerprint. The known route
requires Akamai to enable `save-client-hello` on your certificate and to add an advanced
behavior, after which an EdgeWorker computes the fingerprint from the raw TLS ClientHello — an
account-team request rather than a configuration change. See **Limitations** in
[DEV-README.md](DEV-README.md) for the full picture. Until it is in place, leave
`PMUSER_CHEQ_JA3` and `PMUSER_CHEQ_JA4` undeclared; both fields drop out of the payload and
nothing else changes.

**Geo region needs no variable.** `cheq_geo_region` is populated automatically from the
EdgeWorkers-native `request.userLocation.region` (an ISO-3166 two-letter code for the state,
province or region of the request). There is no PMUSER variable for it and nothing to configure.

**Verifying.** With `PMUSER_CHEQ_DEBUG=true`, request a staging URL with
`Pragma: akamai-x-ew-debug` (Step 4 below) — the worker logs the entire outbound payload on a
`[cheq] payload:` line, so you can read off exactly which of these fields are populated.

### 2f. Save and activate

Save → **Activate on Staging** → validate (Step 4) → **Activate on Production**.
Staging is Akamai's test network: identical configuration, zero live-traffic impact.

---

## Step 3 — Verify the RTI forward rule

Once the property version is active, test the self-proxy from any machine:

```bash
curl -sS -X POST 'https://www.example.com/defend/4.1/traffic' \
  -H 'Content-Type: application/json' \
  --data '{"tagHash":"<YOUR_TAG_HASH>","apiKey":"<YOUR_API_KEY>","endUserParams":{"clientIp":"8.8.8.8","requestUrl":"https://www.example.com/","method":"GET","headers":{"user-agent":"test"}}}'
```

A JSON response containing `"verdict":...` confirms the forward rule works end-to-end.

## Step 4 — Test the EdgeWorker

**Staging** (staging hostnames are not in public DNS — resolve to the staging edge directly).
Your staging edge hostname is your property's edge hostname with `-staging` inserted:
`…edgekey.net` → `…edgekey-staging.net` (Enhanced TLS) or `…edgesuite.net` →
`…edgesuite-staging.net` (Standard TLS).

```bash
# Find the staging edge IP (Enhanced TLS example)
dig +short www.example.com.edgekey-staging.net

# Request with EdgeWorker debug output; look for x-cheq-rti-result and [cheq] log lines
curl -sI https://www.example.com/ \
  --resolve www.example.com:443:<STAGING_IP> \
  -H "Pragma: akamai-x-ew-debug, akamai-x-ew-debug-rp"
```

**Production** (after activating both the EdgeWorker version and the property version):

```bash
# Normal request — passes through; with debug on, shows the x-cheq-rti-result response header
curl -sI https://www.example.com/ | grep -i cheq

# Bot-like request — in MONITORING mode still passes, but the verdict changes
curl -sI -A "curl/8.0" https://www.example.com/ | grep -i cheq
```

### Where `x-cheq-rti-result` appears

| Place | When |
|---|---|
| **Origin-bound request header** | Always on ALLOW (request continues to your origin). This is what origin apps and Akamai security products see. |
| **Browser response header** | Only when `PMUSER_CHEQ_DEBUG=true` (echoed in `onClientResponse` for curl / DevTools). Turn **off** in production so bots do not see the verdict. |

Format when everything works:

```
x-cheq-rti-result: version=4.1;verdict=benign;threat-type-code=0;ids={...}
```

`ids={...}` includes a `rayId` you can join to CHEQ detection logs.

Validation scenarios in MONITORING mode (classification only, nothing blocked):

1. **Benign** — real browser visit → `verdict=benign` (false-positive check)
2. **Bot-like** — curl / headless browser → `verdict=malicious`
3. **Suspicious** — e.g. VPN/proxy exit → `verdict=suspicious`

Also check EdgeWorkers → your EdgeWorker → **Executions**: the failure count should be ~0.
If failures appear, enable enhanced debug headers (Code Bundle Editor) or send
`Pragma: akamai-x-ew-debug` on staging to see the worker's `[cheq]` log lines.

## Step 5 — Go live

1. Run in `MONITORING` mode until CHEQ confirms your traffic classification looks correct.
2. Switch to blocking: `PMUSER_CHEQ_MODE = BLOCKING` (property version activation, no upload).
3. Set `PMUSER_CHEQ_DEBUG = false`.
4. If using Google CAPTCHA: set real reCAPTCHA keys (see Part 2) — until keys are
   configured, suspicious traffic is allowed through as a safety default.

---

## Optional — App & API Protector (AAP) custom rules

CHEQ can enforce in the EdgeWorker (`BLOCKING`), or you can keep the worker in
`MONITORING` and alert / act in **App & API Protector** on the same signal.

On every ALLOW, the worker injects the origin request header `x-cheq-rti-result` with a
literal `verdict=...` token. Typical custom rules (Alert mode for rollout, then Deny if desired):

| Rule name (example) | Match |
|---|---|
| CHEQ-Malicious | Request header `x-cheq-rti-result` **contains** `verdict=malicious` |
| CHEQ-Suspicious | Request header `x-cheq-rti-result` **contains** `verdict=suspicious` |

Notes:

- Substring match on `verdict=malicious` / `verdict=suspicious` is enough — the header format is stable.
- Correlate AAP security events to CHEQ via `rayId` inside `ids={...}`.
- You can run **both**: EdgeWorker BLOCKING for hard bots + AAP Alert for visibility, or MONITORING + AAP only. Note that traffic the EdgeWorker blocks never reaches origin, so AAP rules only see the traffic that is allowed through — in full BLOCKING mode the CHEQ-Malicious rule stops firing because those requests are already stopped at the edge.

---

## Configuration reference (PMUSER variables)

All variables take effect via property version activation (~10–15 min, console only, no
bundle upload). `PMUSER_CHEQ_USE_DYNAMIC_CONFIG=true` is the master switch.

| Variable | Value | Required | Security Setting |
|---|---|---|---|
| `PMUSER_CHEQ_USE_DYNAMIC_CONFIG` | `true` — master switch for console-managed config | **Required** | Visible |
| `PMUSER_CHEQ_API_KEY` | CHEQ API key | **Required** | **Hidden** |
| `PMUSER_CHEQ_TAG_HASH` | CHEQ tag hash | **Required** | **Hidden** |
| `PMUSER_CHEQ_RTI_HOST` | your property hostname | **Required** | Visible |
| `PMUSER_CHEQ_MODE` | `MONITORING` or `BLOCKING` | Recommended (default `MONITORING`) | Visible |
| `PMUSER_CHEQ_REQUEST_ID` | A per-request id you populate with a **Set Variable** behavior rule in Akamai property manager, typically from `{{builtin.AK_REQUEST_ID}}`. Sent to CHEQ as `customParam2` and echoed on the `x-cheq-cdn-request-id` response header, so an Akamai log line can be tied to a CHEQ decision. Left empty if you do not create it — nothing breaks, you just lose that correlation. | Optional | Visible |
| `PMUSER_CHEQ_TIMEOUT` | RTI call timeout in ms (default `300`) | Optional | Visible |
| `PMUSER_CHEQ_DEBUG` | `true` / `false` — echoes the verdict header to browsers | Recommended (`true` rollout, `false` production) | Visible |
| `PMUSER_CHEQ_RTI_DEBUG_DATA` | `true` appends `reasons` and `rule-name` to `x-cheq-rti-result`. Independent of `PMUSER_CHEQ_DEBUG`: alone it enriches the header sent to origin; with debug on, the enriched header also reaches the browser. | Optional | Visible |
| `PMUSER_CHEQ_BLOCK_STRATEGY` | `ACCESS_DENIED` (default) / `NOT_FOUND` / `REDIRECT` / `CAPTCHA` | Optional | Visible |
| `PMUSER_CHEQ_CHALLENGE_STRATEGY` | same values as `PMUSER_CHEQ_BLOCK_STRATEGY` — response shape for CHALLENGE actions (default `CAPTCHA`) | Optional | Visible |
| `PMUSER_CHEQ_CHALLENGE_SECRET` | Signs challenge tokens and the `_cq_se` session cookie. **Without it no challenge is served at all** and suspicious traffic passes to origin. Any long random string; rotate by changing it (no rebuild). Not the same as `PMUSER_CHEQ_RECAPTCHA_SECRET`. | Required for any CAPTCHA | **Secret** |
| `PMUSER_CHEQ_CHALLENGE_PROVIDER` | `recaptcha-v2` (default) / `recaptcha-v3` / `browser` | Optional | Visible |
| `PMUSER_CHEQ_RECAPTCHA_SITE_KEY` | Google reCAPTCHA site key | Required for Google CAPTCHA | Visible (public key) |
| `PMUSER_CHEQ_RECAPTCHA_SECRET` | Google reCAPTCHA secret | Required for Google CAPTCHA | **Hidden** |
| `PMUSER_CHEQ_RECAPTCHA_HOST` | Host for the `/recaptcha/*` self-proxy — defaults to `RTI_HOST` | Optional | Visible |
| `PMUSER_CHEQ_RECAPTCHA_MIN_SCORE` | reCAPTCHA v3 only — minimum score to pass (default `0.5`) | Optional | Visible |
| `PMUSER_CHEQ_RECAPTCHA_TEST_KEYS` | `true` = Google v2 always-pass test keys (**demos only**, never production) | Optional | Visible |
| `PMUSER_CHEQ_CHALLENGE_TTL` | Seconds a passed CAPTCHA stays valid before re-challenge (default `900` = 15 min; reCAPTCHA v2/v3) | Optional | Visible |
| `PMUSER_CHEQ_BLOCK_TT_CODES` | comma-separated threat codes — see filter-mode note in the action matrix | Optional | Visible |
| `PMUSER_CHEQ_CHALLENGE_TT_CODES` | threat codes to challenge, e.g. `14,15` | Optional | Visible |
| `PMUSER_CHEQ_REDIRECT_TT_CODES` / `_REASONS` / `PMUSER_CHEQ_REDIRECT_LOCATION` | redirect matrix | Optional | Visible |
| `PMUSER_CHEQ_BLOCK_REASONS` / `PMUSER_CHEQ_CHALLENGE_REASONS` | reason-code lists | Optional | Visible |
| `PMUSER_CHEQ_IGNORE_PATHS` | comma-separated regexes to skip classification. **Leave it unset to use the bundle's built-in list** (static assets, health checks, and the worker's own `/defend/` and `/recaptcha/` self-proxy paths). Setting it **replaces** that list rather than extending it — see the warning below | Optional | Visible |
| `PMUSER_CHEQ_TELEMETRY` | `true` to send RTI call durations to the logger (needs `PMUSER_CHEQ_RTI_LOGGER_HOST`) | Optional | Visible |
| `PMUSER_CHEQ_RTI_LOGGER_HOST` | Akamai-proxied hostname for `rtilogger.production.cheq-platform.com`. When absent, telemetry **and** error logging are off. | Optional | Visible |
| `PMUSER_CHEQ_JA3` | JA3 TLS fingerprint. **No Akamai built-in provides this** — it needs an account-team request (see step 2e). Sent as `cheq_ja3` in the RTI payload, not as an HTTP header. | Optional | Visible |
| `PMUSER_CHEQ_JA4` | JA4 TLS fingerprint — same constraint and handling, sent as `cheq_ja4`. | Optional | Visible |
| `PMUSER_CHEQ_TLS_CIPHER` | TLS cipher name — populate from the built-in `AK_TLS_CIPHER_NAME` with a Set Variable behavior (step 2e). Sent as `cheq_tls_cipher`. | Optional | Visible |
| `PMUSER_CHEQ_TLS_VERSION` | TLS protocol version — populate from the built-in `AK_TLS_VERSION` with a Set Variable behavior (step 2e). Sent as `cheq_tls_version`. | Optional | Visible |

> **Security Setting** controls UI display and whether the value can surface in Akamai debug
> headers — the EdgeWorker reads the variable either way. Secrets are **Hidden** (or Sensitive
> if your policy requires write-only values); everything else Visible.

### Changing config without a new bundle

| Method | When to use |
|---|---|
| **Activate a different uploaded EdgeWorker version** | You keep e.g. one MONITORING and one BLOCKING build uploaded and flip activation in EdgeWorkers (~10–20 min). |
| **PMUSER variables** (recommended) | Set `PMUSER_CHEQ_USE_DYNAMIC_CONFIG=true` + the table above, then activate a new **property** version (~10–15 min). No `.tgz` upload. |
| **New bundle from CHEQ** | Only for code / UI changes (new block page, challenge logic, ignore-path defaults). |

## Timing & session TTLs

| What | How long | Controlled by |
|---|---|---|
| **RTI classification call** | 300 ms budget per request; on timeout the request is allowed (fail-open) | `PMUSER_CHEQ_TIMEOUT` |
| **Passed CAPTCHA session** (reCAPTCHA v2/v3) | **15 min** default — visitor browses unchallenged, then is re-evaluated on the next request | `PMUSER_CHEQ_CHALLENGE_TTL` (seconds) |
| **Browser (`browser` provider) challenge session** | 5 min, fixed | — |
| **Challenge token** (the one-time token embedded in a challenge page) | **2 min, fixed** — a challenge page left open longer than this is rejected and a fresh one is served | — |
| **`cq_ok` landing grant** | **10 s, fixed** — covers only the single request immediately after a passed challenge, so it cannot be shared or reused | — |
| **"How long is an IP blocked?"** | There is **no stateful IP ban at the edge** — every request is classified in real time. A visitor stays blocked exactly as long as CHEQ keeps classifying their traffic as malicious, and is unblocked the moment classification changes. Central IP policy lives in the CHEQ platform, not the EdgeWorker. | CHEQ platform policy |

**Defaults when nothing is configured:** a passed CAPTCHA stays valid **15 minutes**
(`PMUSER_CHEQ_CHALLENGE_TTL` unset = 900 s), the browser-provider session is fixed at
**5 minutes**, and there is **no time-based block** — a flagged visitor is re-evaluated on
every request and blocked only while CHEQ keeps classifying them malicious.

Note the CAPTCHA session is a signed, HttpOnly cookie scoped to the visitor's browser — it
cannot be replayed from another client, and expiring it simply causes a fresh classification
(and re-challenge if still suspicious).

---

## Allowlisting (never block / never challenge)

| What to allowlist | How | Notes |
|---|---|---|
| **Paths** (health checks, webhooks, internal endpoints) | `PMUSER_CHEQ_IGNORE_PATHS` (comma-separated regexes) | Skips classification entirely — no RTI call, no enforcement, no logging |

> ⚠️ **Setting `PMUSER_CHEQ_IGNORE_PATHS` replaces the built-in list, it does not add to it.**
> If you set it, you must keep `^/defend/` — and `^/recaptcha/` when using a Google CAPTCHA — or
> the EdgeWorker's own sub-requests get classified as visitor traffic. Dropping the static-asset
> patterns is merely wasteful (an RTI call per image); dropping the self-proxy patterns breaks
> the integration. The safest narrow list is the built-ins plus your own additions.
| **IPs / users — centrally (recommended)** | Allow rules in the **CHEQ platform** for your tag | One place, applies to all channels (CDN + tag); ask your CHEQ team |
| **IPs — Akamai-side emergency bypass** | Property Manager rule matching your IP list (e.g. a Client List) with the **EdgeWorkers behavior disabled** inside it | Native Akamai escape hatch: those IPs bypass CHEQ completely; use for VIP/emergency only |
| **Visitors who passed a CAPTCHA** | Automatic | The signed session cookie skips re-challenge until the TTL expires |
| **Threat-code scoping** | `PMUSER_CHEQ_BLOCK_TT_CODES` as a filter | Non-empty list = only those codes block; every other classification is allowed |

---

## Monitoring — where to see incidents & logs

| Where | What you see | How |
|---|---|---|
| **Akamai App & API Protector → Web Security Analytics** | Every CHEQ-flagged request that reached origin, as security events on your CHEQ-Malicious / CHEQ-Suspicious custom rules — filter, chart, alert with the rest of your WAF events | Set up the AAP custom rules (section above); events carry the full `x-cheq-rti-result` header including the rayId |
| **EdgeWorkers → your EdgeWorker → Reports** | Executions (success/failure counts), errors by type, execution time — the health of the integration itself | Built-in; check after every activation |
| **Enhanced debug headers** | Per-request EdgeWorker trace incl. the worker's `[cheq]` log lines | On staging: `Pragma: akamai-x-ew-debug`; or generate a debug token in the Code Bundle Editor |
| **Your origin logs** | The `x-cheq-rti-result` request header on every allowed request — verdict, threat-type code, rayId | Log the header origin-side |
| **CHEQ platform** | Full detection detail for any event — signals, reasons, session history | Give your CHEQ team a **rayId** (from the block page, the header, or an AAP event) — it joins everything |

The **rayId is the correlation key across all five**: block page → AAP event → origin log →
CHEQ detection log all reference the same ID per request.

---

## Action matrix & policy examples

See **Part 2** below — full priority matrix, threat-code list, and copy/paste policies.

---

## Block & challenge page design

Two response pages ship in the bundle, both size-tested against Akamai's 2048-byte
`respondWith()` body limit (over-limit pages would throw and fail open — no block):

| Page | Look | Used when |
|---|---|---|
| **403 Access Denied** | Cyber security card: dark scanline background, animated radar sweep with pulsing core, message copy, and an `INCIDENT_ID` panel with two labeled IDs — `REQUEST` (this request's detection ID, always shown) and `SESSION` (page-view/session ID, shown when the visitor carried CHEQ session cookies). Quote both in support tickets — they join the block to CHEQ detection logs at request and session level. | `BLOCK` action with `ACCESS_DENIED` strategy (default for malicious) |
| **404 Not Found** | Deliberately plain, unbranded "Page Not Found" — no IDs on the page at all. With `PMUSER_CHEQ_DEBUG=true` the detection IDs are attached as `x-cheq-cdn-request-id` / `x-cheq-id` / `x-cheq-page-view-id` response headers so a 404 can still be traced to an RTI decision; with debug off there are none, which is what keeps the response indistinguishable from a genuine 404. | `NOT_FOUND` strategy — stealth blocking that gives bots no hint they were detected |

### Changing the design

| Approach | How | When to use |
|---|---|---|
| **Your own page, no code (recommended)** | Set `PMUSER_CHEQ_BLOCK_STRATEGY=REDIRECT` + `PMUSER_CHEQ_REDIRECT_LOCATION=https://…` pointing at a fully branded page you host. Any size, any design — the 2048-byte limit does not apply to your hosted page. | You want full branding control today, without waiting on a bundle |
| **Custom bundle from CHEQ** | The built-in pages live in the shared core (`core/helpers/block-page-helpers.ts`). Ask your CHEQ team for a build with your colors / logo / copy — every change is automatically size-tested (`block-page-helpers.spec.ts`) against the 2048-byte limit before packaging. | You want the built-in 403/404 to carry your brand |

> Keep the incident IDs visible on any custom 403 — it is how your support team and CHEQ
> correlate a blocked request to the detection logs.

---

## Behavior summary

- Every request → `onClientRequest` → RTI classification → ALLOW / BLOCK (403/404) /
  REDIRECT (302) / CAPTCHA.
- On ALLOW, your origin receives the `x-cheq-rti-result` request header — usable in origin
  logic, logging, or App & API Protector custom rules (see above).
- On any error → **fail open**; the request reaches your origin.
- `MONITORING` mode never blocks or challenges — classify and report only.
- Challenge UI is **Google reCAPTCHA** (v2 / v3) or CHEQ `browser` — not third-party CDN CAPTCHAs.
- Akamai constraint honored by the bundle: `respondWith()` bodies are kept ≤ 2048 bytes
  (block and challenge pages are size-tested).

## Troubleshooting

| Symptom | Check |
|---|---|
| No `x-cheq-rti-result` in `curl -sI` | Response header needs `PMUSER_CHEQ_DEBUG=true`. Origin still receives the request header on ALLOW even when debug is off. Also confirm EdgeWorkers is on the Default Rule and the version is activated on this network. |
| EdgeWorker execution failures | EdgeWorkers → Executions; enable enhanced debug headers or `Pragma: akamai-x-ew-debug` on staging |
| `/defend/` curl test fails | Verify the `CHEQ RTI Forward` rule is **last** in the rule list, SNI enabled, Forward Host Header = Origin Hostname |
| CAPTCHA page not shown for suspicious | reCAPTCHA keys configured? `/recaptcha/*` rule active? Mode = `BLOCKING`? `PMUSER_CHEQ_CHALLENGE_SECRET` set **and declared**? See Part 2 |
| Challenge loops forever / spinner never ends | The `<edgeservices:cookie.pass-set-cookie-policy>` Advanced behavior is missing, so `Set-Cookie` is being stripped. See Part 2. A `?cq_ok=` left in the address bar is the giveaway. |
| CAPTCHA verify fails after checkbox | Is `PMUSER_CHEQ_RECAPTCHA_HOST` (or `RTI_HOST`) your property hostname? Is the `/recaptcha/*` rule last + SNI on? |
| Everything allowed in BLOCKING mode | Check RTI credentials (API key / tag hash) — on auth errors the worker fails open. Also confirm mode is really `BLOCKING` (dynamic config active?). |
| HTML never re-classifies | Confirm HTML/documents bypass cache (see property recommendations). |

---

# Part 2 — Challenge (CAPTCHA) & Action Control

## 1. Quick clarification: v2 vs v3

| | **reCAPTCHA v2** | **reCAPTCHA v3** |
|---|---|---|
| What the user sees | **"I'm not a robot" checkbox** + Continue | Spinner only — **no puzzle** |
| How it works | User clicks checkbox; Google may show an image challenge | Invisible JS; Google returns a **score** 0.0 (bot) → 1.0 (human) |
| Pass rule | `success: true` from Google | `success: true` **and** `score >= threshold` (default 0.5) |
| Keys | Create as **reCAPTCHA v2 → Checkbox** | Create as **reCAPTCHA v3** (separate keys — not interchangeable) |
| Test keys | Google provides always-pass test keys — opt-in via `PMUSER_CHEQ_RECAPTCHA_TEST_KEYS=true` (demos only) | **No test keys** — you need real keys from Google admin |
| Best for | Visible “prove you’re human” demos / compliance | Low-friction production UX |

Also available: **`browser`** provider — our own JS interstitial (no Google). Useful as a fallback.

**Default in the package:** `challengingStrategy = CAPTCHA`, so a `suspicious` verdict routes to a
challenge — but only once one is actually wired, which needs `PMUSER_CHEQ_CHALLENGE_SECRET` plus
either Google keys or the `browser` provider. Until then no challenge exists and suspicious traffic
**passes to origin**, so CAPTCHA is effectively **off** out of the box.

---

## Safety default (important)

A `suspicious` verdict always routes to CHALLENGE, and `challengingStrategy` defaults to `CAPTCHA`.
Whether a CAPTCHA is actually served depends on whether one is wired — and when it is not, the
request **passes to origin**. That is deliberate: a challenge signed with a guessable key would let
anyone forge the `_cq_se` cookie that skips RTI, so no challenge is the safer failure.

| Situation | Suspicious traffic |
|---|---|
| `PMUSER_CHEQ_CHALLENGE_SECRET` not set | **ALLOW** (even in BLOCKING mode, whatever else is set) |
| Provider = `recaptcha-v2` / `recaptcha-v3`, Google keys or verify host missing | **ALLOW** (even in BLOCKING mode) |
| CAPTCHA strategy hits but no challenge wired | **ALLOW** (fail open, logged when `PMUSER_CHEQ_DEBUG=true`) |
| Signing secret + Google keys + verify host set | CAPTCHA page |
| Signing secret set, `challengeProvider=browser` | Browser interstitial (no Google needed) |
| `challengingStrategy` = `ACCESS_DENIED` / `NOT_FOUND` / `REDIRECT` | Handled with **no challenge at all** — needs no keys and no secret |
| Malicious (default) | Still **BLOCK** (403) — unchanged |

Malicious blocking depends on none of this — not Google, not the signing secret. Only the CAPTCHA
path does.

If you want suspicious traffic stopped but do **not** want to run a CAPTCHA, this is the whole
configuration — no keys, no secret, no client-side anything:

```
PMUSER_CHEQ_MODE               = BLOCKING
PMUSER_CHEQ_CHALLENGE_STRATEGY = ACCESS_DENIED
```

To turn CAPTCHA on intentionally:

```
PMUSER_CHEQ_MODE                   = BLOCKING
PMUSER_CHEQ_CHALLENGE_SECRET       = <long random string>
PMUSER_CHEQ_RECAPTCHA_SITE_KEY     = <site key>
PMUSER_CHEQ_RECAPTCHA_SECRET       = <secret>
PMUSER_CHEQ_RECAPTCHA_HOST  = <this property's hostname>   # falls back to PMUSER_CHEQ_RTI_HOST
```

Demo-only (Google always-pass v2 test keys — they pass every request by design):

```
PMUSER_CHEQ_CHALLENGE_SECRET        = <long random string>
PMUSER_CHEQ_RECAPTCHA_TEST_KEYS = true
PMUSER_CHEQ_RECAPTCHA_HOST   = <this property's hostname>
```


## 2. End-to-end user flows

### Benign
Site loads. Nothing shown.

### Malicious (default)
403 Cyber-HUD **Access Denied** page (unless overridden by challenge/redirect lists).

### Suspicious (default = CAPTCHA)
1. Worker serves CHEQ-branded challenge page (v2 checkbox **or** v3 spinner).
2. User completes it (click checkbox, or auto for v3).
3. Edge calls Google `siteverify` via the `/recaptcha/*` self-proxy.
4. On pass → signed `_cq_se` cookie (15 min) + redirect to the clean URL.
5. While the cookie is valid, RTI is skipped (no re-challenge).

> **Important:** CAPTCHA only runs in **BLOCKING** mode.
> `MONITORING` classifies and sets `x-cheq-rti-result` but never challenges or blocks.

---

## 3. Required: allow the EdgeWorker to set cookies

**Every challenge provider needs this — `browser`, `recaptcha-v2` and `recaptcha-v3` alike.**

Akamai denies `Set-Cookie` on `request.respondWith()` by default and drops the header
**silently** — no error, no log. The visitor completes the challenge, gets redirected, arrives
without a session cookie, is classified suspicious again and is challenged again. Forever.

| | |
|---|---|
| **Proper fix** | the `<edgeservices:cookie.pass-set-cookie-policy>` Advanced behavior, so the `_cq_se` cookie reaches the browser and sessions work |
| **Workaround already in the bundle** | a signed `cq_ok` URL parameter that clears one landing request, so a missing tag degrades instead of looping |

Add an **Advanced behavior** to the property containing the metadata tag:

```
<edgeservices:cookie.pass-set-cookie-policy>
```

Advanced behaviors carry raw metadata and are usually restricted to Akamai Professional
Services or your account representative — raise it with them if you cannot add one yourself.

> **Until it is enabled**, a completed challenge still lets the visitor through: the redirect
> carries a short signed `cq_ok` grant good for that one landing request. They will be
> re-challenged on the next navigation rather than getting a real session. A `?cq_ok=` visible
> in the address bar means the cookie is still being stripped.
>
> If the tag is unavailable, `PMUSER_CHEQ_CHALLENGE_STRATEGY = ACCESS_DENIED` (or `NOT_FOUND`)
> handles suspicious traffic with no cookie at all.

---

## 4. Property Manager rule for Google verify

The `/recaptcha/*` → `www.google.com` rule from **Part 1, Step 2c** is required for
Google providers (`recaptcha-v2` / `recaptcha-v3`). The `browser` provider needs no rule.

---

## 5. Creating Google keys

1. Open https://www.google.com/recaptcha/admin
2. **+** Create
3. Label: e.g. `CHEQ Akamai`
4. Choose type:
   - **reCAPTCHA v2** → **"I'm not a robot" Checkbox**  ← for `recaptcha-v2`
   - **reCAPTCHA v3** ← for `recaptcha-v3`
5. Domains: add your hostname (e.g. `www.example.com`)
6. Copy **Site Key** and **Secret Key**

### Wiring keys into the EdgeWorker

**Option A — PMUSER variables (no code changes)** — recommended:

```
PMUSER_CHEQ_USE_DYNAMIC_CONFIG = true
PMUSER_CHEQ_API_KEY            = <your CHEQ api key>
PMUSER_CHEQ_TAG_HASH           = <your tag hash>
PMUSER_CHEQ_RTI_HOST           = www.example.com   # your property hostname
PMUSER_CHEQ_MODE               = BLOCKING
PMUSER_CHEQ_CHALLENGE_PROVIDER = recaptcha-v2   # or recaptcha-v3
PMUSER_CHEQ_RECAPTCHA_SITE_KEY = <site key>
PMUSER_CHEQ_RECAPTCHA_SECRET   = <secret key>
# Host for the /recaptcha/* self-proxy — same as RTI_HOST (your property hostname)
PMUSER_CHEQ_RECAPTCHA_HOST = www.example.com
# v3 only:
PMUSER_CHEQ_RECAPTCHA_MIN_SCORE = 0.5
```

**Option B — bake into the bundle:** CHEQ can deliver a custom bundle with your keys pre-configured — ask your CHEQ team.

Key notes:
- v2 always-pass **test keys** are available for demos via `PMUSER_CHEQ_RECAPTCHA_TEST_KEYS=true` — never use them in production (every visitor passes).
- v3 always needs real keys. If Google keys are missing (either version), no challenge is wired and suspicious traffic is **allowed through** (fail-open) — it does not fall back to another provider. To challenge without Google, set `PMUSER_CHEQ_CHALLENGE_PROVIDER=browser` explicitly.
- `RECAPTCHA_HOST` is the host that has the `/recaptcha/*` → `www.google.com` rule — your **Akamai property hostname**. If unset it automatically falls back to `RTI_HOST`, which is usually correct. Do not point it at Google directly; the EdgeWorker reaches Google only through that self-proxy.

---

## 6. Choosing the challenge provider

| `challengeProvider` / `PMUSER_CHEQ_CHALLENGE_PROVIDER` | UI |
|---|---|
| `recaptcha-v2` (default) | "I'm not a robot" checkbox |
| `recaptcha-v3` | Invisible score (spinner) |
| `browser` | CHEQ JS interstitial (no Google, no `/recaptcha/*` needed) |
| `recaptcha` (legacy alias) | Same as `recaptcha-v2` |

Also required for CAPTCHA to fire:

```
mode / PMUSER_CHEQ_MODE                              = BLOCKING
challengingStrategy / PMUSER_CHEQ_CHALLENGE_STRATEGY = CAPTCHA   # default
PMUSER_CHEQ_CHALLENGE_SECRET                         = <long random string>
```

Without the signing secret no challenge is wired for any provider, and suspicious traffic passes to
origin. The reCAPTCHA providers additionally need site key, secret and verify host.

---

## 7. Full action matrix — when does CAPTCHA / block / redirect fire?

### Priority (BLOCKING mode only)

Evaluated in this order; the first match wins.

| # | Condition | Result |
|---|---|---|
| 1 | verdict = `malicious`, **or** code in `blockTTCodes`, **or** reason in `blockReasons` | **BLOCK** |
| 2 | verdict = `suspicious`, **or** code in `challengeTTCodes`, **or** reason in `challengeReasons` | **CHALLENGE** |
| 3 | code in `redirectTTCodes`, **or** reason in `redirectReasons` | **REDIRECT** |
| 4 | anything else | **ALLOW** |

Two consequences worth being explicit about:

- **`malicious` always blocks.** Setting `blockTTCodes` *adds* codes to block; it never narrows
  what a `malicious` verdict does. There is no "filter mode".
- **Block wins overlaps.** If the same code appears in both `blockTTCodes` and `challengeTTCodes`,
  it blocks. List a code in `challengeTTCodes` only if it is not also in `blockTTCodes`.

Then the *strategy* picks the page shape:

| Action | Strategy | Options |
|---|---|---|
| BLOCK | `blockingStrategy` | `ACCESS_DENIED` (403) · `NOT_FOUND` (stealth 404) · `REDIRECT` · `CAPTCHA` |
| CHALLENGE | `challengingStrategy` | `CAPTCHA` (default) · `ACCESS_DENIED` · `NOT_FOUND` · `REDIRECT` |

### CHEQ standard config → Akamai mapping

| CHEQ standard name | Akamai (`config.ts` / PMUSER) |
|---|---|
| `CHEQ_MODE` | `mode` / `PMUSER_CHEQ_MODE` |
| `CHEQ_SUSPICIOUS_ACTION` | *no direct equivalent* — a `suspicious` verdict always routes to CHALLENGE; use `challengingStrategy` / `PMUSER_CHEQ_CHALLENGE_STRATEGY` to choose what CHALLENGE does |
| `CHEQ_BLOCKING_STRATEGY` | `blockingStrategy` / `PMUSER_CHEQ_BLOCK_STRATEGY` |
| `CHEQ_THREAT_CODES_BLOCK` | `blockTTCodes` / `PMUSER_CHEQ_BLOCK_TT_CODES` |
| `CHEQ_THREAT_CODES_CAPTCHA` | `challengeTTCodes` / `PMUSER_CHEQ_CHALLENGE_TT_CODES` |
| `CHEQ_THREAT_CODES_REDIRECT` | `redirectTTCodes` / `PMUSER_CHEQ_REDIRECT_TT_CODES` |
| `CHEQ_REASONS_BLOCK` | `blockReasons` / `PMUSER_CHEQ_BLOCK_REASONS` |
| `CHEQ_REASONS_CAPTCHA` | `challengeReasons` / `PMUSER_CHEQ_CHALLENGE_REASONS` |
| `CHEQ_REASONS_REDIRECT` | `redirectReasons` / `PMUSER_CHEQ_REDIRECT_REASONS` |
| `CHEQ_REDIRECT_URL` | `redirectLocation` / `PMUSER_CHEQ_REDIRECT_LOCATION` |

### Common threat-type codes

| Code | Meaning |
|---|---|
| 3 | Automation Tools |
| 10 | Malicious Bots |
| 13 | Data Centers |
| 14 | VPN |
| 15 | Proxy |
| 19 | Good Bot |
| 21 | Geo Exclusions |
| 32 | Like Headless |

(Full threat-type table available from your CHEQ team.)

---

## 8. Policy examples (copy/paste)

### A. Default ship — malicious blocked, suspicious passes through

```
PMUSER_CHEQ_MODE = BLOCKING
# suspicious routes to CHALLENGE -> CAPTCHA, but no challenge is wired without
# PMUSER_CHEQ_CHALLENGE_SECRET, so suspicious traffic passes to origin.
# malicious is still blocked (403). See example G to stop suspicious without a CAPTCHA.
```

### A2. Suspicious → v2 checkbox (after keys are set)

```
PMUSER_CHEQ_MODE = BLOCKING
PMUSER_CHEQ_CHALLENGE_SECRET = <long random string>
PMUSER_CHEQ_CHALLENGE_PROVIDER = recaptcha-v2
PMUSER_CHEQ_RECAPTCHA_SITE_KEY = <site key>
PMUSER_CHEQ_RECAPTCHA_SECRET = <secret>
PMUSER_CHEQ_RECAPTCHA_HOST = <this property's hostname>
PMUSER_CHEQ_CHALLENGE_STRATEGY = CAPTCHA
PMUSER_CHEQ_BLOCK_STRATEGY = ACCESS_DENIED
```

### B. Suspicious → invisible v3 (score ≥ 0.7)

```
PMUSER_CHEQ_MODE = BLOCKING
PMUSER_CHEQ_CHALLENGE_SECRET = <long random string>
PMUSER_CHEQ_CHALLENGE_PROVIDER = recaptcha-v3
PMUSER_CHEQ_RECAPTCHA_SITE_KEY = <v3 site key>
PMUSER_CHEQ_RECAPTCHA_SECRET = <v3 secret>
PMUSER_CHEQ_RECAPTCHA_HOST = <this property's hostname>
PMUSER_CHEQ_RECAPTCHA_MIN_SCORE = 0.7
```

### C. Suspicious and VPN/Proxy (14,15) → CAPTCHA

```
PMUSER_CHEQ_MODE = BLOCKING
PMUSER_CHEQ_CHALLENGE_SECRET = <long random string>
PMUSER_CHEQ_CHALLENGE_TT_CODES = 14,15
# Requires a provider too - see A2, B or H.
# Codes 14,15 get CHALLENGE only because they are NOT also in blockTTCodes; block wins overlaps.
```

### D. Block extra threat codes on top of malicious

```
PMUSER_CHEQ_MODE = BLOCKING
PMUSER_CHEQ_BLOCK_TT_CODES = 3,10
# ADDS codes 3 and 10 to what is blocked. Every `malicious` verdict is still blocked as well -
# setting this list never narrows malicious blocking.
```

### E. Specific reason codes → CAPTCHA

```
PMUSER_CHEQ_CHALLENGE_REASONS = -3005,-142
```

### F. Classify only — take no action at all

```
PMUSER_CHEQ_MODE = MONITORING
# RTI is still called and x-cheq-rti-result is still set on the origin request; nothing is
# ever blocked, redirected or challenged. This is the only "observe but do not act" mode.
```

### G. Suspicious → hard block (no CAPTCHA) — simplest way to stop suspicious traffic

```
PMUSER_CHEQ_MODE = BLOCKING
PMUSER_CHEQ_CHALLENGE_STRATEGY = ACCESS_DENIED
```

Suspicious still routes to CHALLENGE, but CHALLENGE now renders 403 instead of a CAPTCHA. No
Google keys, no signing secret, no client-side anything. Use `NOT_FOUND` for the stealth 404
instead, or `REDIRECT` to send them to `PMUSER_CHEQ_REDIRECT_LOCATION`.

### H. No Google — use the CHEQ browser check

```
PMUSER_CHEQ_MODE = BLOCKING
PMUSER_CHEQ_CHALLENGE_SECRET = <long random string>
PMUSER_CHEQ_CHALLENGE_PROVIDER = browser
```

---

## 9. How to test

```bash
# Must be BLOCKING mode. To trigger a CAPTCHA on demand, either:
#   (a) set PMUSER_CHEQ_CHALLENGE_TT_CODES to a threat code your test traffic
#       matches (e.g. 14 if testing over a VPN), OR
#   (b) set PMUSER_CHEQ_BLOCK_STRATEGY=CAPTCHA (malicious also gets CAPTCHA), OR
#   (c) use traffic that RTI classifies as suspicious

# A challenged page returns status 403 with HTML containing g-recaptcha (v2)
# or grecaptcha.execute (v3); after a successful pass, a Set-Cookie: _cq_se=...
curl -sD - 'https://www.example.com/' -o /tmp/chal.html | head -20
grep -nE 'g-recaptcha|grecaptcha.execute|Access Denied' /tmp/chal.html
```

---

## 10. Checklist before go-live

- [ ] EdgeWorker **v4.1.12 or later** activated (BLOCKING for enforcement, or MONITORING for classify-only)
- [ ] EdgeWorkers behavior on the **Default Rule** with **Continue on error: On**
- [ ] `/defend/*` → `rti-global.cheqzone.com` rule live (last in rule list, SNI on)
- [ ] `/recaptcha/*` → `www.google.com` rule live if using Google (last in rule list, SNI on)
- [ ] Provider chosen: `recaptcha-v2` / `recaptcha-v3` / `browser`
- [ ] Real keys set for production (v2 test keys are demo-only; v3 always needs real keys)
- [ ] `PMUSER_CHEQ_RTI_HOST` / `PMUSER_CHEQ_RECAPTCHA_HOST` = your property hostname
- [ ] `PMUSER_CHEQ_CHALLENGE_SECRET` set — without it no challenge is served and suspicious traffic passes to origin
- [ ] Action lists (`BLOCK_TT_CODES` / `CHALLENGE_TT_CODES` / `REDIRECT_TT_CODES` and the matching `*_REASONS`) match your intended traffic policy
- [ ] Decided what a `suspicious` verdict should do: CAPTCHA (needs the secret + a provider) or `PMUSER_CHEQ_CHALLENGE_STRATEGY=ACCESS_DENIED` for a plain 403
- [ ] Confirm in DevTools: challenged pages show the widget; allowed pages show `x-cheq-rti-result` when debug is on
- [ ] HTML/documents bypass cache so every page view is re-classified (see DEPLOYMENT-GUIDE.md)

