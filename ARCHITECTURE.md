<!-- cspell:ignore CHEQ cheq cheqzone rtilogger PMUSER duid pvid akamai -->
# Architecture

How `rti-cdn-integrations` is put together: one shared core, four CDN adapters, and a shared
test harness that drives all of them through the same behavioral suite.

---

## What this repository is

Edge-side integrations that call the **CHEQ Real-Time Interception (RTI)** API to classify
traffic — bots, credential stuffing, ad fraud, other automated threats — *before* it reaches
the customer's origin. One integration per CDN.

RTI API version is **4.1** (`POST /defend/4.1/traffic`).

| Integration | Runtime | Entry point |
| --- | --- | --- |
| Cloudflare | Workers | `integrations/cloudflare/src/index.ts` |
| CloudFront | Lambda@Edge | `integrations/cloudfront/src/viewer-request.ts` / `origin-request.ts` (shared logic in `request-helper.ts`) |
| Akamai | EdgeWorkers | `integrations/akamai/src/main.ts` |
| Fastly | VCL (+ Compute) | `integrations/fastly/vcl/cheq_rti.vcl` |

---

## One core, four adapters

`integrations/core/` holds every piece of CDN-agnostic logic. Each CDN directory is a thin
adapter whose only job is translating that CDN's native request/response API to and from the
core.

```
                        ┌─────────────────────────────┐
                        │   integrations/core/        │
                        │                             │
   cloudflare/  ───────▶│  RTIHelperService           │
   cloudfront/  ───────▶│    decision pipeline        │
   akamai/      ───────▶│  RTIService / RTILogger     │
                        │  RTIStatelessUtils (shared) │
                        │  models/ helpers/ testing/  │
   fastly/  (separate)  └─────────────────────────────┘
```

### Core layout

| Path | Responsibility |
| --- | --- |
| `core/models/` | Types only — `Config`, `RTIRequest`, `RTIResponse`, `Action`, `ActionStrategy`, `Mode`, `EventType` |
| `core/services/rti-helper.service.ts` | The decision pipeline: everything that reads `config` (ignore paths, event type, action, strategy, config validation). Extends `RTIStatelessUtils` |
| `core/services/rti-stateless-utils.ts` | The config-free helpers every integration shares: cookie and header parsing, the `x-cheq-rti-result` header, `original_url` and host checks for challenges, debug-log redaction, `errorMessage`. No constructor arguments, no state, imports only models (its spec enforces this) |
| `core/services/rti-service.base.ts` | Shared RTI request flow (config, status check, JSON parse, errors); subclasses only send |
| `core/services/rti.service.ts` | `fetch()`-based RTI client (Cloudflare) |
| `core/services/rti-https.service.ts` | `node:https`-based RTI client (CloudFront: avoids the `fetch` cold-start cost on 128 MB Lambda@Edge) |
| `core/services/rti-logger.service.base.ts` | Shared logger payload and error handling |
| `core/services/rti-logger.service.ts` | `fetch()`-based telemetry/error logger (Cloudflare) |
| `core/services/rti-https-logger.service.ts` | `node:https`-based logger with a 1 s timeout (CloudFront) |
| `core/services/https-client.ts` | Keep-alive `node:http`/`node:https` POST client with a single retry on a dropped pooled connection |
| `core/helpers/block-page-helpers.ts` | Renders the HTML 403/404 block page |
| `core/testing/` | Shared test harness — see [Testing](#testing) |

Fastly is the exception: it shares no `core/` code, for reasons covered under
[Fastly](#fastly--vcl--compute).

---

## The decision pipeline

Every request follows the same path. Only the adapter layer differs per CDN.

```
   incoming request
         │
         ▼
   shouldIgnore(path) ─────────────────── match? ──▶ pass to origin
         │
         ▼
   validateChallenge(request) ─────────── valid? ──▶ pass to origin   (Cloudflare, Akamai;
         │                                                            CloudFront: see below)
         ▼
   getEventType(path, method)     →  customId1
   parseCookies(cookieHeader)     →  _cq_duid / _cq_pvid / _cq_s
   collect headers, clientIp, url, fingerprints
         │
         ▼
   callRTI(payload) ───────────────────── error? ──▶ pass to origin (fail open)
         │
         ▼
   getAction(rtiResponse)
         │
         ├── ALLOW ──▶ set x-cheq-rti-result header ──▶ pass to origin
         │
         └── BLOCK / CHALLENGE / REDIRECT
                   │
                   ▼
             getActionStrategy(action)
                   ├── ACCESS_DENIED ──▶ 403 + block page
                   ├── NOT_FOUND     ──▶ 404 + block page
                   ├── REDIRECT      ──▶ 302 + Location
                   └── CAPTCHA       ──▶ config.challenge(request, response)
```

CloudFront differs: it does not call `validateChallenge` before RTI. It always calls RTI, and checks
`validateChallenge` only in the `CAPTCHA` branch: a valid session waives the challenge and the request is
forwarded with `x-cheq-rti-result` (the real verdict). Otherwise it calls
`config.challenge(request, response, addRtiResultHeader)`.

CloudFront also routes the reply to its challenge page. The solved form is a new request with a new verdict, so in
`BLOCKING` mode, when the strategy is none (ALLOW) or `CAPTCHA` (`isChallengeReplyAllowed`) and the
`config.isChallengeResponse` callback recognizes the request, it goes to `config.challenge` before the session waiver,
which verifies it and redirects to the original URL. Any other strategy (blocks, 404s, redirects) is enforced as usual. When the request cannot be
evaluated (RTI error or timeout, a malformed RTI response, any other error before the decision), a recognized reply
still goes to `config.challenge`, with a stand-in response (only `ids`) and no `addRtiResultHeader`.

### Action

`Action` is what to do; `ActionStrategy` is how to do it. Both are resolved in
`RTIHelperService`.

`getAction()` derives the verdict from the RTI response, then applies config overrides:

| Source | Result |
| --- | --- |
| `decision.verdict === "malicious"` | `BLOCK` |
| `decision.verdict === "suspicious"` | `CHALLENGE` |
| `classification.code` in `blockTTCodes` / `challengeTTCodes` / `redirectTTCodes` | `BLOCK` / `CHALLENGE` / `REDIRECT` |
| any of `cheqDetection.reasons` in `blockReasons` / `challengeReasons` / `redirectReasons` | `BLOCK` / `CHALLENGE` / `REDIRECT` |
| otherwise | `ALLOW` |

**`Mode.MONITORING` short-circuits the whole thing to `ALLOW`.** RTI is still called and
telemetry still flows, but no action is ever taken. Every shipped config ships in
`MONITORING` — operators opt into `BLOCKING` deliberately.

### ActionStrategy

| Action | Config field | Default |
| --- | --- | --- |
| `BLOCK` | `blockingStrategy` | `ACCESS_DENIED` (403) |
| `CHALLENGE` | `challengingStrategy` | `CAPTCHA` |
| `REDIRECT` | — | always `REDIRECT` (302) |

`CAPTCHA` only does anything when `config.challenge` is wired up; with no challenge callback
the request falls through to origin. Cloudflare and CloudFront ship a Cloudflare Turnstile
reference in `turnstile-challenge-example.ts`; Akamai ships `cheq-challenge.ts` and
`recaptcha-v2-challenge.ts`; Fastly verifies reCAPTCHA v2 in its Compute service.

### Fail open, always

Every error path passes the request to origin: RTI timeout, network failure, malformed
response, a throwing `validateChallenge`, a throwing `challenge`, an unrecognized action
strategy. On CloudFront a throwing `isChallengeResponse` counts as "not a reply", and a reply whose RTI call failed
is still passed to `challenge` (if that throws too, it is passed to origin). Logging in a catch uses
`errorMessage()` (from `RTIStatelessUtils`, called through `RTIHelperService`), which never throws, whatever was thrown. A broken integration degrades to a no-op rather than taking the customer's site
down. Cloudflare reinforces this at the platform level with `passThroughOnException()`.

### Cookies

Session correlation accuracy depends on forwarding three CHEQ cookies:

| Cookie | Payload field | Since |
| --- | --- | --- |
| `_cq_duid` | `duidCookie` | v4.0 |
| `_cq_pvid` | `pvidCookie` | v4.0 |
| `_cq_s` | `sCookie` | v4.1 |

`parseCookies()` (in `RTIStatelessUtils`, called through `RTIHelperService`) has two deliberate details worth
preserving:

- It extracts values with `substring`, not `split('=')`, so base64 padding (`abc==`) survives
  intact.
- It matches on an exact `name=` prefix, so the challenge-session cookie `_cq_se` is never
  mistaken for `_cq_s`.

### Debug logs never carry secrets

With debug on, every integration logs the RTI payload, and CloudFront also logs the whole Lambda@Edge event. Both go
through `RTIStatelessUtils` redaction first: a `cookie` header shows the cookie **names** only, and `x-cheq-challenge`
(the challenge session token), `authorization` and `proxy-authorization` show `[REDACTED]`. CloudFront's event log
also shows every origin custom header value (`customHeaders`, often a shared origin secret) as `[REDACTED]`. Only the log changes; the
origin and RTI still receive the real headers. `duidCookie`, `pvidCookie` and `sCookie` stay in the payload log: they
are CHEQ's own ids, needed to debug RTI. Akamai and Cloudflare send RTI a fixed header allowlist without those headers,
so redaction there is a safety net for when the list grows. A shared test (`core/testing/shared-unit-tests.ts`) checks
all three integrations.

### Challenge session cookie: `SameSite=Lax`, never `Strict`

Every challenge implementation sets its "challenge passed" session cookie with `SameSite=Lax`:
`_cq_se` on CloudFront, Cloudflare and Akamai, and `captchaAuth` / `cq_session_token` on Fastly.

`Strict` was used originally and broke real traffic. A visitor who arrives from another site
(a link, an ad, a redirect) makes a cross-site top-level navigation, and the browser does not send
a `Strict` cookie on that request. The challenge validation sees no session, so the visitor is
challenged again every time they come in from outside, even after passing. `Lax` sends the cookie
on top-level `GET` navigations and still withholds it from cross-site subrequests (iframes,
images, `fetch`) and cross-site `POST`s, which is all the protection this cookie needs. Each
`Set-Cookie` line carries a comment saying so. Keep `Lax` when adapting a challenge example.

### Origin enrichment

On `ALLOW`, the request forwarded to origin carries:

```
x-cheq-rti-result: version=4.1;verdict=benign;threat-type-code=0;ids={"rayId":"...",...}
```

This is a *request* header, so it is not visible to the browser — it is there for origin
application logic and CDN access logs. Block and redirect responses deliberately omit it; those
responses already carry the reference IDs in the page body. One exception: CloudFront passes
`config.challenge` an `addRtiResultHeader` function, and its Turnstile example adds the header to the
302 sent to the browser after a solved challenge.

Those four fields are what every integration emits. `buildRtiResultHeader` takes an optional
`includeDebugData` flag that appends `reasons` (the detection reason codes) and `rule-name`
(the rule behind the verdict); only Akamai opts in, per request via
`PMUSER_CHEQ_RTI_DEBUG_DATA`. Callers that omit the flag get the base header
unchanged.

---

## The integrations

### Cloudflare — Workers

The cleanest reference implementation, and the best starting point for reading the codebase.

- `passThroughOnException()` guarantees fail-open at the platform level.
- `context.waitUntil()` fires telemetry without adding latency to the request.
- JA3 fingerprint comes free from `request.cf.botManagement.ja3Hash`.
- Config is a static object in `src/config.ts`, edited before `wrangler deploy`.

`index.ts` carries paired `OPTION 1` (local/demo, proxy to a fixed origin) and `OPTION 2`
(production, pass through as-is) comment blocks. They must be switched together — mixing them
sends ignored paths to one origin and allowed traffic to another.

### CloudFront — Lambda@Edge

One shared handler, two triggers. `viewer-request.ts` and `origin-request.ts` are three-line
wrappers over `request-helper.ts`, distinguished by a `RequestType` enum.

The trigger choice is a real trade-off:

| | Viewer request | Origin request |
| --- | --- | --- |
| Viewer headers | all available, no whitelisting | governed by origin request policy |
| CloudFront-injected headers (`cloudfront-viewer-ja3-fingerprint`, `-ja4-`, `-tls`) | **not available** | available |
| Fires on | every request | cache misses only |

So JA3/JA4 fingerprints are only obtainable at origin-request.
`docs/LAMBDA-EDGE-COMPARISON.md` covers the full comparison.

`keepHeadersNames` is CloudFront-specific: an allow-list that trims the RTI payload. An empty
array means "send everything" — `null`/`undefined` are not accepted.

### Akamai — EdgeWorkers

Five platform constraints shape this integration.

**1. There is no `fetch()` in EdgeWorkers.** Akamai provides `httpRequest` from the built-in
`http-request` module instead, so Akamai cannot use `core/services/rti.service.ts` or
`rti-logger.service.ts`. It carries its own `src/rti-service.ts` and `src/rti-logger.ts`
implementing the same contracts. Both core files and both Akamai files carry cross-references
pointing at each other.

**2. Sub-requests must stay inside Akamai's network.** The EdgeWorker cannot call
`rti-global.cheqzone.com` directly. The operator configures an Akamai property that proxies
it, then sets that hostname as `rtiHost`. Same for `rtiLoggerHost` (proxying
`rtilogger.production.cheq-platform.com`) and, for the Google CAPTCHA providers,
`www.google.com` via a `/recaptcha/*` rule.
Telemetry and error logging are disabled when `rtiLoggerHost` is absent.

**3. `onClientRequest` gets two sub-requests, total.** `callRTI` spends one. The other is
reserved for a CAPTCHA's `siteverify` call, so `main.ts` skips the telemetry post when a CAPTCHA
verify is about to run — losing a timing metric beats losing the enforcement it measures.
Exceeding the budget throws, the CAPTCHA case catches it, and the request falls through to ALLOW:
the challenge is silently bypassed. Any new sub-request in this handler has to account for it.

**4. There are no browser globals.** `crypto`, `TextEncoder` and `URLSearchParams` are built-in
*modules*, not globals: `import { crypto } from 'crypto'`, `import { TextEncoder } from 'encoding'`,
`import URLSearchParams from 'url-search-params'`. Used bare they type-check anyway — `tsconfig.json`
pulls in the `dom` lib — and pass every unit test, because vitest runs on Node where all three are
globals. They then throw `ReferenceError` on the edge, and in the challenge path that throw is
swallowed by `main.ts`'s CAPTCHA catch, so the only symptom is every challenge silently falling
through to ALLOW. `types.d.ts` declares the modules, `challenge-signing.spec.ts` mocks them so a
revert to globals fails the suite, and `vitest.config.ts` aliases them to Node's implementations.

**5. `Set-Cookie` is denied on `respondWith()`.** Akamai drops the header — silently — unless the
property carries the `<edgeservices:cookie.pass-set-cookie-policy>` metadata tag, added through an
Advanced behavior. The `_cq_se` session cookie is what makes a passed challenge stick, so without
the tag the visitor completes the challenge, lands without a cookie, is classified suspicious again
and is challenged again, forever.

The tag is the **proper fix and the only route to real sessions**; it is a property-level
permission, not something the bundle can arrange. Until it is in place the redirect also carries a
short signed `cq_ok` grant (10s, signed under `og:` so it cannot be swapped with the cookie's `se:`)
which clears that one landing request — turning an infinite redirect loop into "challenged again on
the next navigation". A visible `?cq_ok=` in the address bar means the cookie is still being
stripped. All three providers share this behaviour.

Two further differences from the other integrations:

- **Runtime config.** Setting `PMUSER_CHEQ_USE_DYNAMIC_CONFIG=true` makes
  `buildDynamicConfig()` assemble the entire config from Property Manager `PMUSER_*`
  variables — no redeploy needed to change mode, thresholds, or ignore paths. `config.ts`
  documents every supported variable. Callbacks (`challenge`, `validateChallenge`) cannot be
  expressed as panel variables and stay wired in code.
- **A richer header set.** Beyond the standard list, Akamai collects Sec-Fetch metadata,
  Client Hints (`sec-ch-ua-*`), and HTTP Message Signatures — plus TLS data and geo region
  mapped in through `PMUSER_*` variables.

`onClientResponse` is debug-only: when `PMUSER_CHEQ_DEBUG=true` it echoes `x-cheq-rti-result`
onto the response so the verdict is visible in a browser.

**Build.** EdgeWorkers require a single self-contained `main.js` — no runtime npm installs.
Rollup bundles `src/` plus the shared `core/` into `dist/main.js`, leaving Akamai's built-in
modules (`http-request`, `log`, `cookies`, `crypto`, `encoding`, `url-search-params`) external. `npm run package` produces the uploadable
`cheq-rti-edgeworker.tgz`. `src/types.d.ts` declares the ambient EdgeWorker types (`EWRequest`,
`EWResponse`, the built-in modules) — they are not npm packages.

### Fastly — VCL + Compute

Architecturally separate from the other three, and the reason is a VCL limitation: **VCL
cannot branch mid-request.** It cannot make an external call, read the result, then decide what
to do.

The workaround is a **two-restart pattern**, where "backend" means something different on each
pass:

```
RESTART 0 — the RTI check
  vcl_recv     stash original request; build X-Cheq-Param-* headers;
               backend := CHEQ RTI; convert to POST
  vcl_pass     X-Cheq-Param-* headers forwarded to RTI (no JSON body)
  vcl_fetch    read verdict from X-Cheq-Res-* response headers → set X-Cheq-Action
               RTI HTTP error → allow (fail open, logged)
               → return(restart)
  vcl_error    503 — RTI unreachable, vcl_fetch never ran
               → return(restart) with X-Cheq-Action unset
                 (restart 1 reads unset as allow)

RESTART 1 — the real request
  backend := customer origin, but only when X-Cheq-Action is allow.
  block / redirect / challenge are served synthetically from the edge;
  origin is never called.
```

The lifecycle therefore runs **twice per client request**, against a different backend each
time.

Two deployment options, both documented in `vcl/README.md`:

- **VCL Snippets** (recommended) — `vcl/snippets/` inject into lifecycle hooks and coexist with
  existing VCL.
- **Full custom VCL** — `include` `cheq_rti.vcl`; `example_main.vcl` is a complete wiring
  reference.

The **Compute@Edge service** (`fastly/compute/`) exists only for reCAPTCHA v2 verification —
RTI itself runs directly in VCL. `handler.js` documents its backend contract explicitly, so the
CAPTCHA provider can be swapped for anything satisfying the same request/response shape:

```
Request:  POST /validate/<site_key>
          body: g-recaptcha-response=<token>   (form-urlencoded)
          header: origurl=<post-success redirect target>
Success:  302 + Location: <origurl>
          + Set-Cookie: captchaAuth=1 (HttpOnly, Secure, SameSite=Lax, 900s)
Failure:  200 + captchaFail: 1      (VCL restarts to re-show the challenge)
Error:    200                        (fail open)
```

The reCAPTCHA secret lives in a Fastly Config Store (`cheq_rti_config`), created in the
console — the `[local_server]` block in `fastly.toml` only applies to `fastly compute serve`.

---

## Testing

The strongest part of the codebase, and the piece most worth understanding before changing
behavior.

### The problem

Three CDNs implement the same pipeline behind three different APIs. Written naively, each CDN
needs its own ~49 near-identical tests — so a single behavior change means edits in three
places, and one missed edit means silent divergence.

### The solution — adapter pattern

`core/testing/` defines the harness. Each CDN implements an adapter that normalizes its native
result into a common shape, and one shared suite drives all of them:

```
                       ┌───────────────────────────────────┐
   cloudflare adapter ─┤                                   │
   cloudfront adapter ─┤  registerSharedBehaviorTests()    │ → [shared] <cdn-name>
   akamai adapter     ─┤  registerSharedIntegrationTests() │
                       └───────────────────────────────────┘
```

`NormalizedResult` — `{ status, headers, body, passedThrough }` — is the common currency. The
adapter's `invoke()` is the only code that knows about CDN-specific API shapes.

### Two layers

| | Shared unit tests | Shared integration tests |
| --- | --- | --- |
| File | `testing/shared-unit-tests.ts` | `testing/shared-integration-tests.ts` |
| Contract | `TestAdapter` | `IntegrationTestAdapter` |
| Mocked | `callRTI`, `shouldIgnore`, `getAction`, `getActionStrategy`, `generateDefaultBlockPage` | **only** the network boundary |
| Decision logic | controlled by the test | the **real** `RTIHelperService` |
| Also exposes | — | `rtiPayload` — what was actually sent to RTI |

The split is deliberate, and the interface docs spell out why. If `getAction` were broken and
never returned `BLOCK` for a malicious verdict, unit tests would still pass — they mock it. The
integration test *"returns 403 on malicious verdict"* fails immediately.

Note what is **not** mocked at the unit layer: `parseCookies` and `buildRtiResultHeader` run
for real, so tests verify actual output rather than a duplicated mock formula.

### Running

Each integration installs and tests independently — there is no root `package.json` or
workspace.

```bash
cd integrations/<cdn> && npm test         # tsc (where configured) + vitest
cd integrations/<cdn> && npm run coverage # istanbul; thresholds in vitest.config.ts
```

Coverage thresholds are 95% statements / 90% branches / 95% functions / 95% lines.

**Requires Node >= 20** — vitest 4 will not start on older runtimes.

---

## Adding a CDN integration

1. Create `integrations/<cdn>/` with its own `package.json`, `tsconfig.json`,
   `vitest.config.ts`.
2. Extend `Config` with any CDN-specific fields (see `AkamaiConfig`, `CloudfrontConfig`).
3. Write the adapter: collect headers, build the `RTIRequest`, then drive the core pipeline in
   order — `shouldIgnore` → `validateChallenge` → `getEventType` / `parseCookies` → `callRTI` →
   `getAction` → `getActionStrategy` (Cloudflare, Akamai). CloudFront instead calls RTI first and
   checks `validateChallenge` only for a `CAPTCHA` strategy; new adapters should follow CloudFront.
4. Reuse `core/services/rti.service.ts` if the runtime has `fetch()`. On a low-CPU Node runtime
   (like 128 MB Lambda@Edge), use `rti-https.service.ts` and `rti-https-logger.service.ts` instead:
   loading `fetch` on a cold start is slow enough to hit the RTI timeout. If neither fits, implement
   `IRTIService` and `IRTILogger` against the platform's HTTP API — and cross-reference the
   core files, as Akamai does.
5. Implement `TestAdapter` and `IntegrationTestAdapter`, then call
   `registerSharedBehaviorTests()` and `registerSharedIntegrationTests()`. The full behavioral
   suite comes for free.
6. Fail open on every error path.
