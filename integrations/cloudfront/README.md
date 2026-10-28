<!-- cspell:ignore CHEQ cheq Paradome duid pvid referer siteverify healthcheck smarttv -->
<div align="center">
  <img src="https://raw.githubusercontent.com/cheq-ai/rti-cdn-integrations/main/assets/cheq-logo.svg">
</div>

# CHEQ RTI — CloudFront Lambda@Edge Integration

![Integration Version](https://img.shields.io/github/v/release/cheq-ai/rti-cdn-integrations?label=Integration%20Version)
![Lambda Edge Runtime](https://img.shields.io/badge/Lambda%40Edge_Runtime-Node.js_20-44cc11)
![AWS SAM CLI](https://img.shields.io/badge/AWS_SAM_CLI-v1.95.0-44cc11)

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Request Processing Flow](#request-processing-flow)
- [Action Decision Logic](#action-decision-logic)
- [SAM Template Resources](#sam-template-resources)
- [Origin Request Policies](#origin-request-policies)
- [Turnstile CAPTCHA Integration](#turnstile-captcha-integration)
- [Build, Test & Deploy](#build-test--deploy)
- [Monitoring & Debugging](#monitoring--debugging)
- [Troubleshooting](#troubleshooting)
- [Core Library Reference](#core-library-reference)
- [Additional Resources](#additional-resources)

---

## Overview

This integration deploys [CHEQ RTI (Real-Time Interception)](https://cheq.ai) as an AWS Lambda@Edge function attached to your CloudFront distribution. Every incoming request is evaluated by the RTI API to detect bots, fraud, and invalid traffic. Based on the verdict, the Lambda can:

- **Allow** — pass the request to your origin unchanged (with an `x-cheq-rti-result` header injected for origin-side visibility)
- **Block** — return HTTP 403 or 404 immediately at the edge
- **Challenge** — present a CAPTCHA/challenge page (e.g. Cloudflare Turnstile)
- **Redirect** — return HTTP 302 to a configured URL

Two deployment models are provided. Choose based on your caching strategy and security requirements:

| Solution | Lambda Trigger | Timeout | Runs on | Headers available | Recommended |
|----------|---------------|---------|---------|-------------------|-------------|
| **Viewer-Request** | Before cache | 5 s hard limit | Every request | All viewer headers automatically | **Yes** — sees every request and all headers, best fit for malicious traffic detection |
| **Origin-Request** | After cache check | 30 s | Cache misses only | Whitelisted via origin request policy (max 10) | Not recommended — misses cached requests and receives a limited header set, reducing detection accuracy |

> **Recommendation:** Use the **Viewer-Request** model. It runs on every request before the cache and has access to all viewer headers (IP, user-agent, accept-language, ...), making it the right trigger point for detecting malicious activity. The Origin-Request model can technically work but is not well-suited — it skips cached traffic entirely and only receives the headers you explicitly whitelist. (CloudFront's TLS / JA3 / JA4 fingerprint headers are the exception: they are only available to the origin-request trigger.)
>
> For a detailed comparison see [docs/LAMBDA-EDGE-COMPARISON.md](docs/LAMBDA-EDGE-COMPARISON.md).

---

## Architecture

### Origin-Request Flow vs Viewer-Request Flow

**Key difference:** Viewer-Request runs *before* the cache on every request and receives all viewer headers automatically. Origin-Request runs *after* the cache check — only on cache misses — and only receives headers you explicitly whitelist in the origin request policy. By default this means cached requests are never inspected by RTI.

You can work around the cache issue by attaching the built-in `CachingDisabled` managed cache policy, which forces every request to be a cache miss. However, this still leaves three significant drawbacks compared to Viewer-Request:

- **Headers** — you're still limited to what the origin request policy whitelists (max ~10 headers). Viewer-Request gets all of them automatically.
- **Latency** — disabling caching defeats CloudFront's main purpose and adds an extra hop (CloudFront → Lambda → Origin) on every request.
- **Cost** — origin-request invocations are billed differently and you lose all caching benefits.

### Origin-Request Flow

```
User Request
     │
     ▼
CloudFront Edge
     │
     ▼
Cache Lookup (you can configure build in caching policy "CachingDisabled" and it will be cache miss every request)
     ├─── Cache HIT ──────────────────────────────────────► Return to User
     │                                                       (RTI never runs)
     │
     └─── Cache MISS
               │
               ▼
     ┌───────────────────────────────────────────────────┐
     │  Lambda@Edge (Origin-Request, 30s timeout)        │
     │                                                   │
     │  1. shouldIgnore? ──► YES ──► pass through        │
     │  2. Call RTI API (also with a challenge session)  │
     │  3. verdict/code/reasons ──► Action               │
     │     CAPTCHA + valid session ──► treated as ALLOW  │
     │         │                                         │
     │  ALLOW  │  Block (403/404)  Challenge  Redirect   │
     │         │      │                │         │       │
     └─────────┼──────┼────────────────┼─────────┼───────┘
               │      │                │         │
               │      └── Response ◄───┘         └── 302
               │          to User
               ▼
     Inject x-cheq-rti-result header
               │
               ▼
          Origin Server
```

### Viewer-Request Flow

```
User Request
     │
     ▼
CloudFront Edge
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│  Lambda@Edge (Viewer-Request, 5s hard limit)             │
│  (same RTI logic as above)                               │
└─────────────────────────────────────────────────────────┘
     │
     ▼
Cache Lookup → Cache HIT / MISS → Origin
```

---

## Project Structure

```
integrations/cloudfront/
│
├── src/
│   ├── config.ts                      # All runtime configuration — edit this before deploying
│   ├── origin-request.ts              # Lambda@Edge entry point for origin-request trigger
│   ├── viewer-request.ts              # Lambda@Edge entry point for viewer-request trigger
│   ├── request-helper.ts              # Shared RTI processing logic (both lambdas call this)
│   ├── turnstile-challenge-example.ts # Reference CAPTCHA challenge implementation (Cloudflare Turnstile)
│   ├── request-helper.spec.ts         # Unit tests for the handler (+ the shared behavioral suite)
│   ├── request-helper.integration.spec.ts # Shared integration suite + challenge replies, with the real decision logic
│   ├── request-helper.startup.spec.ts # What request-helper logs at load (missing isChallengeResponse)
│   ├── turnstile-challenge-example.spec.ts # Challenge page, reply detection, siteverify, session signing and validation
│   ├── config.spec.ts                 # The shipped config.ts: defaults and Turnstile wiring
│   └── validate-config.spec.ts        # Sanity-check that config.ts passes validation
│
├── events/
│   ├── origin-request-event.json      # Test event for sam local invoke / direct testing
│   └── viewer-request-event.json      # Test event for viewer-request testing
│
├── docs/
│   └── LAMBDA-EDGE-COMPARISON.md      # Deep-dive: origin-request vs viewer-request
│
├── test-sam-local-origin-request.ts   # Run origin-request handler directly (npx tsx)
├── test-sam-local-viewer-request.ts   # Run viewer-request handler directly (npx tsx)
├── template.yaml                      # AWS SAM template (Lambda functions + IAM + policies)
├── samconfig.toml                     # SAM deployment defaults (stack name, region, etc.)
├── tsconfig.json                      # TypeScript config (type-check only, esbuild bundles)
├── vitest.config.ts                   # Test config (per-file coverage thresholds)
└── package.json                       # npm scripts and dependencies

integrations/core/                     # Shared library (bundled by esbuild at build time)
├── helpers/
│   ├── block-page-helpers.ts          # Generates default HTML block pages (403/404)
│   └── block-page-helpers.spec.ts     # Unit tests for block page generation
├── models/
│   ├── config.interface.ts            # Base Config interface (all options)
│   ├── action.model.ts                # Action enum: ALLOW, CHALLENGE, BLOCK, REDIRECT
│   ├── action-strategy.model.ts       # ActionStrategy enum: ACCESS_DENIED, NOT_FOUND, REDIRECT, CAPTCHA
│   ├── mode.model.ts                  # Mode enum: MONITORING, BLOCKING
│   ├── event-type.model.ts            # EventType enum: PAGE_LOAD, PURCHASE, SEARCH, etc.
│   ├── headers-map.model.ts           # Type for the flattened header name→value map
│   ├── route-to-event-type.model.ts   # RouteToEventType model (path + method → EventType mapping)
│   ├── rti-logger.interface.ts        # IRTILogger interface
│   ├── rti-params.model.ts            # RTI params model
│   ├── rti-request.model.ts           # RTI API request payload interface
│   ├── rti-response.model.ts          # RTI API response interface (decision, classification, etc.)
│   └── rti-service.interface.ts       # IRTIService interface
├── services/
│   ├── https-client.ts                # node:http/https keep-alive POST client with retry (used by the https services)
│   ├── https-client.spec.ts           # Unit tests for the https client
│   ├── rti-service.base.ts            # Shared request flow for the RTI callers (config, status check, JSON parse, errors)
│   ├── rti-service.base.spec.ts       # Unit tests for the shared RTI flow
│   ├── rti-https.service.ts           # node:http/https RTI caller (used by CloudFront)
│   ├── rti-https.service.spec.ts      # Unit tests for the https RTI caller
│   ├── rti.service.ts                 # fetch-based RTI caller (used by other CDNs)
│   ├── rti.service.spec.ts            # Unit tests for RTI service
│   ├── rti-helper.service.ts          # Action/strategy decision logic, challenge-reply strategy check, safe error messages
│   ├── rti-helper.service.spec.ts     # Unit tests for helper service
│   ├── rti-logger.service.base.ts     # Shared payload and error handling for the RTI loggers
│   ├── rti-logger.service.base.spec.ts # Unit tests for the shared logger logic
│   ├── rti-https-logger.service.ts    # node:http/https logger with a timeout (used by CloudFront)
│   ├── rti-https-logger.service.spec.ts # Unit tests for the https logger
│   ├── rti-logger.service.ts          # fetch-based logger (used by other CDNs)
│   └── rti-logger.service.spec.ts     # Unit tests for logger service
├── testing/                           # Shared test suites and adapters, run by every CDN integration
│   ├── shared-unit-tests.ts           # Behavioral suite (mocked decisions)
│   ├── shared-integration-tests.ts    # Integration suite (real RTIHelperService)
│   ├── test-adapter.interface.ts      # Adapter contract for the behavioral suite
│   ├── integration-test-adapter.interface.ts # Adapter contract for the integration suite
│   └── rti-response.fixture.ts        # buildRTIResponse() test factory
├── tsconfig.json                      # TypeScript config for core library
└── package.json                       # Core library package (private, devDeps only)
```

---

## Prerequisites

| Requirement | Version | Notes |
|------------|---------|-------|
| [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) | v1.95+ | Used to build and deploy |
| Node.js | 20.x | Matches Lambda runtime |
| AWS account | — | Deployed to **us-east-1** (Lambda@Edge requirement) |
| CloudFront distribution | — | Existing or create new during setup |
| CHEQ Paradome API key | — | From **Defend → Settings → Integration -> API Integration** in the Paradome platform |
| CHEQ Paradome Tag hash | — | From **Account Settings → Tags** in the Paradome platform |

---

## Quick Start

### 1. Install dependencies

```bash
cd integrations/cloudfront
npm install
```

### 2. Configure

Open [`src/config.ts`](src/config.ts) and set your credentials:

```typescript
export const config: CloudfrontConfig = {
     apiKey: 'YOUR_API_KEY',       // From Paradome → Defend → Settings → Integration → API Integration
     tagHash: 'YOUR_TAG_HASH',     // From Paradome → Account Settings → Tags
     mode: Mode.MONITORING,         // Start with MONITORING to observe, switch to BLOCKING to enforce
     // redirectLocation: 'https://example.com/blocked', // only together with redirectReasons (config validation fails otherwise); default https://www.cheq.ai/
     ignorePaths: undefined, // Set the paths that should be skip the RTI logic, for example: ['/images', '/api/test', '\\.css$', '\\.js$']
     telemetry: false, // Relevant when need/want to monitor telemetry
     timeout: 2000, // RTI call timeout in ms (2000 is also the default). Lower values make cold starts time out, see Memory, CPU and Cold Starts
     debug: false, // Set to true to enable debug logging, false for production
     keepHeadersNames: [], // Optional: specify headers to keep in the request sent to the RTI, otherwise all headers will be kept
     // ... rest of config
};
```

### 3. Verify config

```bash
npm test   # runs TypeScript type-check + Vitest unit tests
```

### 4. Build

Perform build after any change you want to deploy 

```bash
sam build
```

### 5. Test locally (optional)

```bash
# Direct TypeScript execution (fastest, no Docker required)
npx tsx test-sam-local-origin-request.ts
npx tsx test-sam-local-viewer-request.ts

# SAM local invocation (requires Docker)
sam local invoke OriginRequest -e events/origin-request-event.json
sam local invoke ViewerRequest -e events/viewer-request-event.json
```

### 6. Deploy

Deploy after any change to the code or SAM template (always run `sam build` first).

```bash
# Standard deploy (creates a new IAM role automatically)
sam deploy --region us-east-1

# Deploy using an existing IAM role instead of creating one (replace 123456789012 with your account id)
sam deploy --region us-east-1 --parameter-overrides ExistingRoleArn=arn:aws:iam::123456789012:role/your-role-name
```

> **DeletionPolicy:** By default, both `OriginRequest` and `ViewerRequest` Lambda functions are deleted when the stack is deleted (`DeletionPolicy` is commented out on both). To retain a function after stack deletion — preserving it and all its published versions — uncomment `#DeletionPolicy: Retain` on the relevant function in [`template.yaml`](template.yaml) before deploying.

### 7. Attach to CloudFront

After deployment, SAM outputs the Lambda version ARNs and origin request policy names:

| Output | What it is | When to use |
|--------|-----------|-------------|
| `ViewerRequestVersionARN` | Version ARN for the viewer-request Lambda | **Recommended.** Attach as the `viewer-request` Lambda@Edge trigger. Runs before the cache on every request with all viewer headers. |
| `OriginRequestVersionARN` | Version ARN for the origin-request Lambda | Attach as the `origin-request` Lambda@Edge trigger. Only runs on cache misses. The Viewer Request is the recommended approach but this one is also an option to use in specific cases  |
| `OriginRequestPolicy` | Origin request policy (with host header) | Use with the **origin-request** trigger when your origin supports the CloudFront distribution hostname. Forwards RTI-relevant headers + host. |
| `OriginRequestPolicyNoHost` | Origin request policy (no host header) | Use with the **origin-request** trigger when your origin expects its own hostname and cannot resolve the CloudFront distribution hostname (e.g. S3 REST endpoints). |
| `OriginRequestPolicyTrustedIP` *(conditional)* | Same as `OriginRequestPolicy` + the custom header specified by `TrustedIPHeader` | Only created when `TrustedIPHeader` parameter is set during deployment. The exact use case for TrustedIPHeader is unclear — carried over from the old repo without documentation. |
| `OriginRequestPolicyNoHostTrustedIP` *(conditional)* | Same as `OriginRequestPolicyNoHost` + the custom header specified by `TrustedIPHeader` | Only created when `TrustedIPHeader` parameter is set during deployment. The exact use case for TrustedIPHeader is unclear — carried over from the old repo without documentation. |

> **Note:** Origin request policies are only relevant for the **origin-request** trigger. The viewer-request trigger always receives all viewer headers automatically — no origin request policy is needed. You can use those policies but probably you like to control them yourself for your origin.

In your CloudFront distribution → **Behaviors** → **Edit**:
- Set **Lambda function associations** → add the `ViewerRequestVersionARN` as the `viewer-request` trigger (recommended), or `OriginRequestVersionARN` as the `origin-request` trigger
- If using origin-request: set **Origin request policy** to the policy name that matches your origin type (see table above)

---

## Configuration Reference

All configuration lives in [`src/config.ts`](src/config.ts) as a single exported `config` object.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | `string` | Your CHEQ API key. Available in Paradome Console (See Prerequisites section). |
| `tagHash` | `string` | Your tag hash. Available in Paradome Console (See Prerequisites section) |
| `mode` | `Mode` | `Mode.MONITORING` = observe only (no blocking). `Mode.BLOCKING` = enforce actions. Start with MONITORING to validate traffic patterns before enforcing. |


### Action Routing

These determine which traffic classification triggers which action. All fields accept arrays of numeric codes from the RTI response.
The preferable way is to do it via **Defend → Policy Management** where most of the options are available and not require redeploying the lambda

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `blockTTCodes` | `number[]` | `undefined` | Threat-type classification codes that trigger a BLOCK action. Maps to `rtiResponse.classification.code`. |
| `blockReasons` | `number[]` | `undefined` | Reason codes that trigger BLOCK. Maps to `rtiResponse.cheqDetection.reasons`. |
| `challengeTTCodes` | `number[]` | `undefined` | Threat-type codes that trigger a CHALLENGE action. |
| `challengeReasons` | `number[]` | `undefined` | Reason codes that trigger CHALLENGE. |
| `redirectTTCodes` | `number[]` | `undefined` | Threat-type codes that trigger a REDIRECT action. |
| `redirectReasons` | `number[]` | `undefined` | Reason codes that trigger REDIRECT. **Must** be paired with `redirectLocation`. |
| `redirectLocation` | `string` | `'https://www.cheq.ai/'` | URL to redirect to when a REDIRECT action is triggered. Must be set together with `redirectReasons`: config validation fails if only one of the two is set. Without it, a REDIRECT goes to `https://www.cheq.ai/`. |

**Evaluation priority (first match wins, only in `Mode.BLOCKING`):**

1. **BLOCK** — if `verdict === 'malicious'` OR `classification.code` is in `blockTTCodes` OR any of `cheqDetection.reasons` is in `blockReasons`
2. **CHALLENGE** — else if `verdict === 'suspicious'` OR `classification.code` is in `challengeTTCodes` OR any reason is in `challengeReasons`
3. **REDIRECT** — else if `classification.code` is in `redirectTTCodes` OR any reason is in `redirectReasons`
4. **ALLOW** — if none of the above match, or if `mode === Mode.MONITORING`

Within each tier, `verdict` is checked first, then `TTCodes`, then `reasons`. BLOCK always takes precedence over CHALLENGE, which always takes precedence over REDIRECT — there is no way for a REDIRECT rule to fire if a BLOCK or CHALLENGE condition also matches.

### Action Strategies

These control *how* a BLOCK or CHALLENGE is executed.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `blockingStrategy` | `ActionStrategy` | `ActionStrategy.ACCESS_DENIED` | How to respond to a BLOCK decision. `ACCESS_DENIED` = HTTP 403. `NOT_FOUND` = HTTP 404. `REDIRECT` = HTTP 302 to `redirectLocation`. `CAPTCHA` = invoke the `challenge` function. |
| `challengingStrategy` | `ActionStrategy` | `ActionStrategy.CAPTCHA` | How to respond to a CHALLENGE decision. Same options as `blockingStrategy`. |

### Path Filtering

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ignorePaths` | `string[]` | `undefined` | Array of regex pattern strings. Paths matching any pattern are passed through without RTI evaluation. Example: `['example1', '\\.css$', '\\.js$', '\\.png$', '^/health']`. Note: patterns are strings, not regex literals — do not wrap in `/` delimiters. |
| `routeToEventType` | `RouteToEventType[]` | `undefined` | Maps URL path + HTTP method patterns to CHEQ event types (e.g. PAGE_LOAD, PURCHASE, SEARCH). Used for analytics segmentation in the RTI payload. |

**`RouteToEventType` structure:**
This one seems less important for rti v4 and kept in case it will be needed.

```typescript
{
  path: string,        // regex string matched against the request pathname
  method: string,      // regex string matched against the HTTP method (e.g. 'POST|PUT')
  event_type: EventType
}
```

### Challenge Functions (CloudFront-specific)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `challenge` | `(request: CloudFrontRequest, response: RTIResponse, addRtiResultHeader?: (headers: CloudFrontHeaders) => void) => Promise<CloudFrontRequestResult \| CloudFrontResponseResult>` | `undefined` | Called when action strategy is `CAPTCHA` (and the visitor has no valid session). In `BLOCKING` mode also called for every reply to the challenge page when RTI allows it or the strategy is `CAPTCHA`, with or without a valid session, and when the request cannot be evaluated (see [The reply to the challenge page](#the-reply-to-the-challenge-page)). Any other strategy is enforced as usual. Receives the full CloudFront request and RTI response. Must return a CloudFront response (e.g. challenge page) or the request (pass-through). `addRtiResultHeader` sets `x-cheq-rti-result` on the headers you pass it; call it on the responses that should carry the verdict (the example does so only on the 302 after a solved challenge). See `turnstile-challenge-example.ts` for a reference implementation. |
| `validateChallenge` | `(request: CloudFrontRequest, isDebug?: boolean) => Promise<boolean>` | `undefined` | Called only when the RTI action strategy is `CAPTCHA` and `challenge` is set, and never for a reply that `isChallengeResponse` recognizes (in `BLOCKING` mode that reply goes to `challenge` first, see [The reply to the challenge page](#the-reply-to-the-challenge-page)). An unrecognized reply (no `isChallengeResponse`, or it returns something other than `true` or throws) goes through the usual flow, including this check. Return `true` when the visitor already solved the challenge (e.g. a valid session cookie): the challenge is waived and the request is forwarded with `x-cheq-rti-result` carrying the real verdict. It does **not** skip RTI: every request still gets a verdict. Only the `CAPTCHA` strategy is waived: `ACCESS_DENIED`, `NOT_FOUND` and `REDIRECT` are always enforced. If you set `blockingStrategy: CAPTCHA`, a valid session also waives blocked (malicious) traffic. If it throws, the request is passed through without the header (fail-open). |
| `isChallengeResponse` | `(request: CloudFrontRequest) => boolean` | `undefined` | Recognizes the reply to the challenge page; in `BLOCKING` mode such a reply always goes to `challenge` (see [The reply to the challenge page](#the-reply-to-the-challenge-page)). The Turnstile example looks for `cf-turnstile-response` in the query. Only a synchronous `true` counts: any other value, a `Promise` included, means no reply. If it throws, the request is handled as no reply and the error is logged. Not set while `challenge` is: replies are not recognized, and a warning is logged once per cold start. Not called in `MONITORING` mode, without `challenge`, or when the request is blocked, 404'd or redirected anyway. |
| `keepHeadersNames` | `string[]` | — | **Required** (pass `[]` to send all headers). When non-empty, only these header names are sent to RTI, on both triggers. Useful for reducing payload size when only certain headers are relevant. On origin-request, the origin request policy also limits which headers exist in the first place. |

### Network & Endpoints

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout` | `number` | `2000` | RTI API request timeout in milliseconds. The viewer-request Lambda has a 5-second hard limit — keep this well below 5000 for viewer-request deployments. Values around 150ms are too low for cold starts; see [Memory, CPU and Cold Starts](#memory-cpu-and-cold-starts) before choosing a value. |
| `rtiServiceURI` | `string` | `'https://rti-global.cheqzone.com/defend/4.1/traffic'` | Override the RTI service endpoint. Leave `undefined` for production. Set to a dev/staging URL for testing. |
| `rtiLoggerURI` | `string` | `'https://rtilogger.production.cheq-platform.com'` | Override the RTI logger endpoint. Leave `undefined` for production. |

### Debug & Observability

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `debug` | `boolean` | `false` | Enables verbose `console.log` output: full CloudFront event, RTI request payload, RTI response, determined action, and action strategy. These appear in CloudWatch Logs. **Disable in production** — logs contain full request data. |
| `telemetry` | `boolean` | — | Required. When `true`, sends RTI request duration (`rti_duration: {ms}`) to the logger endpoint after each RTI call. The handler waits for it (up to 1,000ms), so keep it `false` unless you are measuring. See [Telemetry](#telemetry). |
| `logErrors` | `boolean` | `true` | When `true`, errors caught while handling a request (including challenge errors) are sent to the logger endpoint. Set to `false` to stop sending them; they are still written to `console.error` (CloudWatch Logs). |

### Complete Config Example

```typescript
// Replaces the `turnstileConfig` block and the `config` object in src/config.ts. All imports are shown for
// completeness: src/config.ts already has Mode and createTurnstileChallenge, so add only ActionStrategy and EventType.
import { Mode } from '../../core/models/mode.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { EventType } from '../../core/models/event-type.model';
import { createTurnstileChallenge } from './turnstile-challenge-example';

const turnstileConfig = {
  siteKey: "REPLACE_ME",
  secretKey: "REPLACE_ME",
  sessionSigningSecret: "REPLACE_ME", // NOT the Turnstile secret: `openssl rand -hex 32`
  sessionTtlSeconds: 300,
};
const turnstileChallenge = createTurnstileChallenge(turnstileConfig); // all three undefined until configured

export const config: CloudfrontConfig = {
  // --- Required ---
  apiKey: 'YOUR_API_KEY',
  tagHash: 'YOUR_TAG_HASH',
  mode: Mode.BLOCKING,
  telemetry: false, // true adds a logger call (up to 1s) to every request, see Telemetry

  // --- Action routing ---
  // Block traffic classified with threat type code 15 (known bot)
  blockTTCodes: [15],
  // Block traffic that triggered reason code 9005
  blockReasons: [9005],
  // Challenge suspicious traffic (code 14)
  challengeTTCodes: [14],
  // Redirect specific reason codes to a landing page
  redirectReasons: [100],
  redirectLocation: 'https://your-domain.com/blocked',

  // --- Strategies ---
  blockingStrategy: ActionStrategy.ACCESS_DENIED,    // 403
  challengingStrategy: ActionStrategy.CAPTCHA,        // invoke challenge function

  // --- Path filtering ---
  // Skip RTI for static assets, bots/crawlers, monitoring, and known-safe internal paths.
  // Each entry is a regex string matched against the request pathname (not the full URL).
  ignorePaths: [
    // Static assets — no user interaction, no value in RTI evaluation
    '\\.css$', '\\.js$', '\\.mjs$', '\\.map$',
    '\\.png$', '\\.jpg$', '\\.jpeg$', '\\.gif$', '\\.webp$', '\\.svg$', '\\.ico$',
    '\\.woff$', '\\.woff2$', '\\.ttf$', '\\.eot$',
    '\\.mp4$', '\\.webm$', '\\.mp3$',
    '\\.pdf$', '\\.zip$',

    // Well-known browser/crawl requests
    '^/favicon\\.ico$',
    '^/robots\\.txt$',
    '^/sitemap.*\\.xml$',
    '^/ads\\.txt$',

    // Health checks and monitoring (AWS ALB, Route53, uptime services)
    '^/health$',
    '^/healthcheck$',
    '^/ping$',
    '^/status$',

    // Internal / infrastructure paths
    '^/_next/',        // Next.js static files and HMR
    '^/__webpack',     // Webpack HMR
    '^/static/',       // Generic static directory
    '^/assets/',       // Generic assets directory
  ],

  // Map checkout to a PURCHASE event type for analytics
  routeToEventType: [
    { path: '^/checkout', method: 'POST', event_type: EventType.PURCHASE },
    { path: '^/search', method: 'GET', event_type: EventType.SEARCH },
  ],

  // --- Challenge (CAPTCHA) ---
  challenge: turnstileChallenge.challenge,
  validateChallenge: turnstileChallenge.validateChallenge,
  isChallengeResponse: turnstileChallenge.isChallengeResponse,

  // --- Origin-request header filtering ---
  // [] or undefined = forward all available headers to RTI (recommended)
  // Explicit list = forward only these headers (reduces payload size, use when you want fine-grained control)
  keepHeadersNames: [],
  // keepHeadersNames: [
  //   // Standard viewer request headers (forwarded by all policies)
  //   'user-agent',
  //   'accept',
  //   'accept-language',
  //   'referer',
  //   'host',                               // not included in NoHost policies
  //   // IP identification
  //   'x-forwarded-for',
  //   'true-client-ip',
  //   // CloudFront TLS + fingerprint headers (forwarded by all policies)
  //   'cloudfront-viewer-tls',
  //   'cloudfront-viewer-ja3-fingerprint',
  //   'cloudfront-viewer-ja4-fingerprint',
  //   // CloudFront geo + device headers (only forwarded with OriginRequestPolicyAllHeadersAllowed)
  //   'cloudfront-viewer-country',
  //   'cloudfront-viewer-city',
  //   'cloudfront-is-mobile-viewer',
  //   'cloudfront-is-tablet-viewer',
  //   'cloudfront-is-smarttv-viewer',
  //   'cloudfront-viewer-header-order',
  //   'cloudfront-viewer-header-count',
  // ],

  // --- Network ---
  timeout: 2000, // lower values make cold starts time out, see Memory, CPU and Cold Starts
  // rtiServiceURI: undefined,  // uses production default
  // rtiLoggerURI: undefined,   // uses production default

  // --- Debug ---
  debug: false,
};
```

---

## Request Processing Flow

The full RTI flow is implemented in [`src/request-helper.ts`](src/request-helper.ts). Both `origin-request.ts` and `viewer-request.ts` are thin wrappers that call this shared helper with a `RequestType` enum value.

### Step-by-step

```
CloudFront Event
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. DEBUG LOGGING                                                 │
│    If config.debug: log full event + request type label          │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. IGNORE PATH CHECK                                             │
│    shouldIgnore(requestURL.pathname)                             │
│    Match against config.ignorePaths (regex strings)             │
│    YES → return cfRequest unchanged (pass-through, no RTI call)  │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. BUILD RTI PAYLOAD                                             │
│    - URL: constructed from host header + uri + querystring       │
│    - Headers: all headers, or filtered by keepHeadersNames       │
│    - Cookies: _cq_duid, _cq_pvid extracted (v4.0+);              │
│              _cq_s extracted (v4.1+, sent as sCookie)            │
│    - JA3/JA4: from cloudfront-viewer-ja3/ja4-fingerprint headers │
│    - Event type: from routeToEventType mapping or PAGE_LOAD      │
│    - Channel: "cloudfront-cdn-integration"                       │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. CALL RTI API                                                  │
│    POST to config.rtiServiceURI (timeout: config.timeout ms)    │
│    On HTTP >= 400: throw Error (caught below → fail-open)       │
│    On network error: throw Error (caught below → fail-open)     │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. TELEMETRY                                                     │
│    If config.telemetry: log "rti_duration: {ms}" via logger     │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. DETERMINE ACTION                                              │
│    getAction(rtiResponse) → ALLOW | BLOCK | CHALLENGE | REDIRECT │
│    In MONITORING mode: always returns ALLOW                      │
└─────────────────────────────────────────────────────────────────┘
       │
       ├─── BLOCKING + config.challenge, no strategy (ALLOW) or CAPTCHA (isChallengeReplyAllowed),
       │    and config.isChallengeResponse(req) === true (a throw counts as false, logged)
       │                  config.challenge(req, resp) → verify token, 302 to original_url
       │                  (before the session waiver; on error: fail-open)
       │
       ├─── ALLOW ──────────────────────────────────────────────────►
       │                  Inject x-cheq-rti-result header
       │                  Return cfRequest to origin
       │
       └─── BLOCK / CHALLENGE / REDIRECT
                    │
                    ▼
         getActionStrategy(action)
                    │
            ┌───────┼────────────────┬────────────────┐
            │       │                │                │
      ACCESS_DENIED  NOT_FOUND    REDIRECT          CAPTCHA
       HTTP 403      HTTP 404     HTTP 302       no config.challenge → as ALLOW
       block page    block page   Location hdr   validateChallenge(req) true
                                                   → as ALLOW (header, real verdict)
                                                 else config.challenge(req, resp)
                                                   → challenge page / cookie redirect
                                                 On error: fail-open (no header)

┌─────────────────────────────────────────────────────────────────┐
│ ERROR HANDLING (outer try/catch)                                 │
│ Any exception → console.error (+ logger unless logErrors: false) │
│                → BLOCKING challenge reply: config.challenge      │
│                  (stand-in response, see the challenge section)  │
│                → otherwise return cfRequest                      │
│ FAIL-OPEN: on any error, traffic is allowed through              │
└─────────────────────────────────────────────────────────────────┘
```

### `x-cheq-rti-result` Header Format

This header is set on every request forwarded to the origin after an RTI verdict: ALLOW, a CAPTCHA waived by a valid session, or a CAPTCHA with no `challenge` configured. The Turnstile example also adds it to the 302 after a solved challenge (seen by the browser). A copy sent by the client is always removed first, so the origin never receives a verdict the client made up (for example on an ignored path or when RTI fails):

```
x-cheq-rti-result: version={v};verdict={v};threat-type-code={n};ids={json}
```

Example:
```
x-cheq-rti-result: version=4.1;verdict=benign;threat-type-code=0;ids={"rayId":"abc123",...}
```

Your origin server can read this header for logging, analytics, or additional business logic.

---

## Action Decision Logic

### `getAction()` — Priority Order

Evaluated **only in `Mode.BLOCKING`**. In `Mode.MONITORING`, always returns `ALLOW`.

The first matching condition wins (BLOCK is evaluated before CHALLENGE, which is before REDIRECT):

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 (highest) | `rtiResponse.decision.verdict === 'malicious'` | `BLOCK` |
| 1 | `classification.code` is in `blockTTCodes` | `BLOCK` |
| 1 | any of `cheqDetection.reasons` is in `blockReasons` | `BLOCK` |
| 2 | `rtiResponse.decision.verdict === 'suspicious'` | `CHALLENGE` |
| 2 | `classification.code` is in `challengeTTCodes` | `CHALLENGE` |
| 2 | any of `cheqDetection.reasons` is in `challengeReasons` | `CHALLENGE` |
| 3 | `classification.code` is in `redirectTTCodes` | `REDIRECT` |
| 3 | any of `cheqDetection.reasons` is in `redirectReasons` | `REDIRECT` |
| 4 (lowest) | none of the above | `ALLOW` |

### `getActionStrategy()` — How to Execute the Action

| Action | Strategy used | HTTP Response |
|--------|--------------|---------------|
| `BLOCK` | `config.blockingStrategy` (default: `ACCESS_DENIED`) | 403, 404, 302, or CAPTCHA |
| `CHALLENGE` | `config.challengingStrategy` (default: `CAPTCHA`) | 403, 404, 302, or CAPTCHA |
| `REDIRECT` | Always `REDIRECT` | HTTP 302 → `config.redirectLocation` |
| `ALLOW` | `null` | Request forwarded to origin |

### Block Page Response

For `ACCESS_DENIED` (403) and `NOT_FOUND` (404), the response body is a styled HTML page generated by `generateDefaultBlockPage()` containing:

- HTTP status code and title (e.g. "403 — Access Denied")
- RTI Ray ID reference (`rtiResponse.ids.rayId`)
- CloudFront request ID (`x-amz-cf-id`) as an additional reference

---

## SAM Template Resources

The [`template.yaml`](template.yaml) defines all AWS infrastructure.

### Parameters

| Parameter | Type | Default | Usage |
|-----------|------|---------|-------|
| `TrustedIPHeader` | `String` | `''` | Name of a custom header to add to the origin request policy whitelist. When set, two additional origin request policy variants are created that include this header alongside the standard RTI headers. |
| `ExistingRoleArn` | `String` | `''` | ARN of an existing IAM execution role for the Lambdas. When empty, a new role is created automatically. |

### Lambda Functions

| Resource | Trigger | Timeout | Memory | Entry point |
|----------|---------|---------|--------|-------------|
| `OriginRequest` | `origin-request` | 30 s | 128 MB (can be raised to 10,240 MB) | `origin-request.ts` → `handle` |
| `ViewerRequest` | `viewer-request` | **5 s** (hard limit) | **128 MB** (AWS maximum for viewer triggers) | `viewer-request.ts` → `handle` |

Both functions:
- Runtime: `nodejs20.x`, x86_64
- Built with esbuild (minified, ES2020 target, no sourcemaps)
- `AutoPublishAlias: live` — automatically publishes a new version on each deploy
- IAM role: created automatically or reused via `ExistingRoleArn`

> **Important:** The viewer-request 5-second timeout is a hard CloudFront limit. The `config.timeout` (RTI API timeout) must be kept well below 5000ms for viewer-request deployments.

### Memory, CPU and Cold Starts

AWS limits for Lambda@Edge ([Lambda@Edge Limits and Quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-requirements-limits.html)):

| Trigger | Max memory | Max timeout |
|---------|-----------|-------------|
| Viewer-request / viewer-response | **128 MB** | **5 s** |
| Origin-request / origin-response | 10,240 MB | 30 s |

Lambda allocates CPU in proportion to memory. At 128 MB a function gets roughly 7% of one vCPU (a full vCPU corresponds to 1,769 MB). The viewer-request Lambda cannot be given more CPU; moving to origin-request is the only way to raise memory, at the cost of the trade-offs described in [Origin-Request Flow vs Viewer-Request Flow](#origin-request-flow-vs-viewer-request-flow).

**Why this matters for `timeout`:** the `config.timeout` timer starts when the RTI call starts, so it covers everything that call does. On a warm container that is only the request itself. On a cold container (the first request it serves) the same call also pays for:

1. Loading the HTTP client. Node 20's global `fetch` (undici) is loaded and compiled on first use, which is why this integration uses `node:https` (`RTIHttpsService`) instead.
2. DNS lookup, TCP connect and the TLS handshake to the RTI endpoint.

Both are CPU-heavy, so on 128 MB they take far longer than on a developer machine. When they exceed `config.timeout`, the call fails with `request error: The operation was aborted due to timeout` and the request is passed through without an RTI decision (fail-open).

**Observed in production:** a viewer-request deployment with `timeout: 1500` saw 8–17% of RTI calls per day abort with this error. The failed CloudFront request ids we investigated were cold starts. Low-traffic deployments are hit hardest: traffic is spread across many edge regions, so containers are often new or idle.

**Measured cost** (cold first POST to the RTI endpoint, Node 20 in Docker with CPU capped at 0.072 vCPU to approximate 128 MB, from one developer location):

| Client | Cold call, CPU capped | Cold call, no CPU cap | Warm call |
|--------|----------------------|-----------------------|-----------|
| `fetch` (previous implementation, `RTIService`) | 1,445–2,090 ms (median ~1,600) | ~670–700 ms | ~155 ms |
| `node:https` (current implementation, `RTIHttpsService`) | 1,117–1,340 ms (median ~1,180) | ~655–680 ms | ~155 ms |

These numbers show that the network cost is the same for both clients and the difference is CPU spent by the client on a cold start. Docker CPU limits only approximate Lambda's allocation and network latency from an AWS edge region differs, so treat them as indicative rather than exact.

**Guidance:**

- Do not set a timeout around 150ms for viewer-request: every cold call will time out. The fallback when `config.timeout` is not set is 2000ms.
- Switching to `node:https` removes most of the client's cold-start cost, but the connection setup (DNS, TCP, TLS) remains. At ~1.2 s per cold call in our measurement, a 1,500ms timeout leaves little margin, so edge regions far from the RTI endpoint may still time out on cold starts.
- Use the `rti_duration` telemetry (sent to the CHEQ logger endpoint, not to CloudWatch) and CloudWatch `REPORT` lines (an `Init Duration` field marks a cold start) to see how often your deployment hits this.

**The logger call adds to the same request.** The handler waits for the RTI logger before it answers the viewer: on every error (unless `logErrors` is `false`), and after every RTI call when `telemetry` is on. On a cold container this is a second new TLS connection, to a different host. The logger therefore also uses `node:https` (`RTIHttpsLoggerService`) and gives up after 1,000ms, so a slow logger cannot push the request past the 5 s viewer-request limit. Each awaited log call can add up to 1,000ms. A request can await: telemetry after the RTI call; an error log when anything fails (the RTI call, the decision, the challenge); and, for a reply to the challenge page, a log when `isChallengeResponse` throws or when the stand-in `rayId` is replaced (see [The reply to the challenge page](#the-reply-to-the-challenge-page)). Usually at most two come together (e.g. an RTI error, then a challenge error), so the worst case is about `config.timeout` + 2 × 1,000ms, plus the challenge's own time. Up to four only when several of these fail in the same request. Keep `config.timeout` at or below about 2,500ms for viewer-request. A log that times out is written to CloudWatch (`rti logger api error (continue running): ...`) and dropped. The logger endpoint also closes idle connections after 60s, so its connections are closed after 50s like the RTI ones.

#### Reused connections

Warm invocations reuse the open connection, which saves the cost of a new TLS connection: 460–765ms at the 128 MB CPU cap in our freeze test, against ~155ms on a reused connection. Both the RTI and the logger endpoint close a connection after 60s idle, so the client closes its own after 50s. Two mechanisms enforce that (the agent's timer also honours a shorter `Keep-Alive: timeout=` hint from the server; the clock check uses 50s):

- While the process runs, the agent's idle timer closes the connection.
- Between invocations the Lambda is frozen and timers do not run, so after a thaw the request could start before that overdue timer fires. Each call therefore also checks the idle time by the clock (`Date.now()` keeps moving during a freeze) and closes connections idle for 50s or more before sending.

That leaves one case: the server's close and our next request can cross on the wire. The request then fails at once with `ECONNRESET` (`socket hang up`) or `EPIPE`, usually before the server read it. The client then **retries once on a new connection**, inside the same deadline: `config.timeout` for RTI, 1,000ms for the logger (no retry is started once that time is used up). Without the retry, such a request would pass through without an RTI decision. In rare cases the server had already processed the request before the connection was reset; that request is then evaluated (or logged) twice. It is never retried when:

- the connection was new (the failure is real);
- a response had started (the server may already have handled the request);
- the error is a timeout or any other error;
- it was already retried once.

#### Differences from the previous `fetch` client

`node:https` is lower level than `fetch` and does less on its own. With the default `rtiServiceURI` and `rtiLoggerURI` none of this matters; it only does if you point them somewhere else:

- **User-Agent:** `node:https` sends none, and some firewalls reject requests without one. `HttpsClient` sends `User-Agent: cheq-rti-cloudfront` on the RTI and logger calls, which also makes them easy to find in the endpoints' logs.
- **Redirects are not followed.** `fetch` followed a 301/302/307/308 automatically; `node:https` returns it as the answer. For RTI the redirect has no JSON body, so the call fails with a JSON parse error (e.g. `request error: Unexpected end of JSON input`) and the request passes through without a decision; for the logger the log line is lost. If you override a URL, use the final address (for example `https://`, not an `http://` URL that redirects to it).
- **A byte order mark (BOM) at the start of the response is not removed.** `fetch` strips a leading `U+FEFF` before parsing; `node:https` passes it on, and `JSON.parse` fails on it (`request error: Unexpected token ...`). The RTI endpoint does not send one; a proxy or custom endpoint in front of it must not add one either.

### Origin Request Policy Resources

Three CloudFront origin request policies are always created, plus two more (`…TrustedIP`) when `TrustedIPHeader` is set. They control which viewer headers CloudFront forwards to the origin-request Lambda.

| Resource | Includes host | Includes `TrustedIPHeader` | Use case |
|----------|-------------|---------------------------|----------|
| `OriginRequestPolicy` | ✅ | ❌ | Origin supports the CloudFront distribution hostname |
| `OriginRequestPolicyNoHost` | ❌ | ❌ | Origin expects its own hostname (e.g. S3 REST API, own-domain origins) |
| `OriginRequestPolicyTrustedIP` | ✅ | ✅ | Same as `OriginRequestPolicy` + the custom header specified by `TrustedIPHeader` |
| `OriginRequestPolicyNoHostTrustedIP` | ❌ | ✅ | Same as `OriginRequestPolicyNoHost` + the custom header specified by `TrustedIPHeader` |
| `OriginRequestPolicyAllHeadersAllowed` | ✅ all viewer | N/A | Maximum header coverage (all viewer + CloudFront geo/device headers) |

> The exact use case for `TrustedIPHeader` is unclear — it was carried over from the old repo without documentation. It adds a custom header name to the origin request policy whitelist.

All policies forward:
- All cookies
- All query strings
- Whitelisted headers: `cloudfront-viewer-tls`, `cloudfront-viewer-ja3-fingerprint`, `cloudfront-viewer-ja4-fingerprint`, `accept`, `accept-language`, `referer`, `user-agent`, `x-forwarded-for`, `true-client-ip`

### Outputs

| Output Key | Description |
|-----------|-------------|
| `OriginRequestVersionARN` | Version ARN to attach as origin-request Lambda@Edge trigger |
| `ViewerRequestVersionARN` | Version ARN to attach as viewer-request Lambda@Edge trigger |
| `OriginRequestPolicy` | Policy name for custom origins (with host header) |
| `OriginRequestPolicyNoHost` | Policy name for S3/own-domain origins |
| `OriginRequestPolicyNoHostTrustedIP` | *(if TrustedIPHeader set)* Policy name without host, with trusted IP |
| `OriginRequestPolicyTrustedIP` | *(if TrustedIPHeader set)* Policy name with host and trusted IP |

`OriginRequestPolicyAllHeadersAllowed` has no output; it is named `<stack name>-origin-request-policy-all-headers-allowed`.

---

## Origin Request Policies

Origin request policies are only relevant for the **origin-request** trigger. They tell CloudFront which viewer headers to pass to the Lambda (CloudFront does not forward all viewer headers by default).

> The viewer-request trigger always receives all viewer headers — no origin request policy is needed.

### Decision Guide

```
Which origin request policy should I use?
                    │
       ┌────────────┴───────────────┐
       │                            │
  Using S3 REST origin?       Using custom origin?
  (or origin has its own       (ALB / EC2 / API GW)
   domain name)                     │
       │                ┌───────────┴──────────┐
       │           Origin resolves           Origin needs
       │           by its own host?          CloudFront host?
       │                │                        │
  NoHost policy    NoHost policy            Default policy
  (no host header)  (no host header)        (includes host header)

Add TrustedIP variant if you need an additional custom header forwarded (set via TrustedIPHeader parameter).
Use AllHeadersAllowed during development/testing for maximum visibility. The exact use case for TrustedIPHeader is unclear — carried over from the old repo without documentation.
```

### Why Policies Matter for RTI

The RTI API uses HTTP headers (user-agent, accept-language, referer, TLS fingerprints, etc.) as signals for bot detection. The more headers available in the Lambda, the higher the detection accuracy. The origin request policy whitelists the specific headers that CloudFront will forward to the Lambda.

The `keepHeadersNames` config option provides a second layer of filtering — it controls which of the forwarded headers are actually included in the RTI payload. Leave it empty (`[]`) to include all forwarded headers.

---

## Turnstile CAPTCHA Integration

This is just an example for Captcha using Cloudflare Turnstile, the customer can replace it with any implementation he wants or we can provide one.

[`src/turnstile-challenge-example.ts`](src/turnstile-challenge-example.ts) is a fully functional reference implementation of a challenge flow using [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/).

### Setup

The settings live in the `turnstileConfig` block at the top of [`src/config.ts`](src/config.ts). Replace three values:

| Setting | Where it comes from |
|---------|---------------------|
| `siteKey` | Turnstile dashboard → site key (rendered in the challenge page) |
| `secretKey` | Turnstile dashboard → secret key (sent to Cloudflare's `siteverify`) |
| `sessionSigningSecret` | A random string of at least 32 bytes: run `openssl rand -hex 32`, which prints 64 hex characters such as `4f8c2a9e61d07b35c9e2f4a18d6b03e7a5c1f9d2e8b47a06c3d5e1f9b2a84c7d` (generate your own; never reuse an example). Shorter or guessable values work but can be brute-forced, which lets anyone forge sessions. It signs the `_cq_se` session cookie. **Not the Turnstile secret.** Changing it ends every open session (visitors are challenged again). |

`sessionTtlSeconds` (default 300) sets how long a solved challenge is remembered. It must be a positive whole number of seconds; any other value (0, negative, fractional, a string) logs a warning and 300 is used.

`config.ts` passes them to `createTurnstileChallenge(turnstileConfig)`, which returns `challenge`, `validateChallenge` and `isChallengeResponse`. Until all three secrets are set (not empty, not `REPLACE_ME`) it returns none of them and logs a warning once per cold start: the CAPTCHA is disabled, and challenged traffic is forwarded to the origin with `x-cheq-rti-result`.

### How the Challenge Flow Works

```
Request arrives → strategy is CAPTCHA (CHALLENGE by default, or BLOCK with blockingStrategy: CAPTCHA)
                and there is no valid session → config.challenge() called
                    (in BLOCKING mode also for every reply, see The reply to the challenge page)
        │
        ▼
 Does the request have a `cf-turnstile-response` query parameter?
        │
   NO ──┤──► Return HTTP 403 with CAPTCHA challenge page
        │       (Turnstile widget + hidden form; `original_url` holds the path and query string)
        │       User solves the CAPTCHA
        │       Turnstile widget injects hidden `cf-turnstile-response` input into the form
        │       Form submits (GET) to the same path: the query becomes original_url, request_id
        │       and cf-turnstile-response (the visitor's own query travels inside original_url)
        │
   YES ──► POST token to Cloudflare siteverify API (server-side)
               │
          Verification fails ──► Return 403 "Verification failed" (plain text, no widget;
                                  see Troubleshooting: "Verification failed" after refresh)
               │
          Verification passes
               │
               ▼
          Generate signed session token:
          "{expiresAt}.{HMAC-SHA256(sessionSigningSecret, ["se", expiresAt, rayId])[0:32 hex]}"
               │
               ▼
          Return HTTP 302 redirect to original URL
          (host from the Host header, never the query string; original_url must be a
           same-site path, otherwise the request URI is used)
          Set-Cookie: _cq_se={token}|{rayId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300
          x-cheq-rti-result: version=…;verdict=…;threat-type-code=…;ids={…}
```

> **The 302 carries `x-cheq-rti-result`.** The example adds it with the `addRtiResultHeader` function the handler passes to
> `challenge`. It is a response to the **browser**, not the origin, so the client (bots included) can read the verdict,
> threat-type code and ids. The redirected request goes through RTI again and gets its own header on the way to the origin.

> **Why `SameSite=Lax` and not `Strict`:** visitors who arrive from another site (a link, an ad, a redirect) make a cross-site
> top-level navigation. With `Strict` the browser does not send `_cq_se` on that request, so the challenge validation sees no
> session and the visitor is challenged again every time they come in from outside. `Lax` sends the cookie on top-level `GET`
> navigations while still withholding it from cross-site subrequests (iframes, images, `fetch`) and cross-site `POST`s.
> Keep `Lax` if you copy or adapt the challenge example.

On subsequent requests RTI always runs. `config.validateChallenge` is called only when RTI asks for a CAPTCHA again
(and the request is not a reply that `isChallengeResponse` recognizes, which goes to `config.challenge` instead):

```
Read _cq_se (from all Cookie headers) → parse _cq_se as {token}|{rayId}
  (an x-cheq-challenge / x-cheq-ray-id request header, if present, overrides the token / rayId)
     │
     ▼
Split token → {expiresAt}.{signature}
     │
     ├── expired? (Date.now() > expiresAt) → return false (challenged again)
     │
     └── Recompute HMAC(sessionSigningSecret, ["se", expiresAt, rayId]), constant-time compare
              │
         Matches? → return true (CAPTCHA waived: forwarded with x-cheq-rti-result, real verdict)
         No match? → return false (challenged again)
```

A valid session waives only the `CAPTCHA` strategy (with `blockingStrategy: CAPTCHA` that includes blocked traffic). An `ACCESS_DENIED`, `NOT_FOUND` or `REDIRECT` response is enforced as usual, and a benign verdict is forwarded
with the header without checking the cookie (unless it is a reply to the challenge page). The session expiry is fixed (not extended on later requests).

> **Cost:** a request with a valid session now makes an RTI call too, which matters for cold-start timeouts on viewer-request
> (see [Memory, CPU and Cold Starts](#memory-cpu-and-cold-starts)). Checking the signature itself takes microseconds.

### The reply to the challenge page

The solved form is a new request, so RTI gives it a new verdict. When that verdict is no longer a CAPTCHA (e.g. `ALLOW`),
or a valid `_cq_se` session would waive it (two tabs, Back, refresh), forwarding it would send the origin
`?original_url=…&request_id=…&cf-turnstile-response=…` instead of the visitor's query string, without setting a session.
So in `BLOCKING` mode the handler passes every reply to `config.challenge`, which answers it (the Turnstile example
verifies the token and redirects to `original_url`):

```
BLOCKING mode, config.challenge set, and the strategy allows a reply?   (isChallengeReplyAllowed)
     │
     ├── any other strategy (ACCESS_DENIED / NOT_FOUND / REDIRECT) → enforced as usual (isChallengeResponse is not called)
     │
     └── no strategy (ALLOW) or CAPTCHA, with or without a session
              │
         config.isChallengeResponse(request) === true?   (Turnstile example: cf-turnstile-response in the query, with a value)
              │
              ├── no, not set, or it throws → the usual flow (forward, CAPTCHA, session waiver, ...)
              │
              └── yes → config.challenge (the Turnstile example:)
                         Verified → 302 to original_url with a new _cq_se session (same sessionTtlSeconds)
                         Failed (used, expired or forged token) → 403 "Verification failed" (see Troubleshooting)
```

- **The challenge recognizes its own reply.** `config.isChallengeResponse` comes with the challenge (the Turnstile
  example returns it from `createTurnstileChallenge`), so the handler knows nothing about any CAPTCHA's field names.
- **Field name only.** The Turnstile example's `isChallengeResponse` looks only for the Turnstile field name. A site's own
  `GET` form with a Turnstile widget therefore looks like a reply too: in `BLOCKING` mode it is verified by
  `config.challenge` and redirected to its own URL instead of reaching the origin. Exclude such pages with `ignorePaths`.
- **Customer code, handled defensively.** Only a synchronous `true` counts (an `async` detector's `Promise` means no reply).
  If it throws, the request is handled as no reply (the usual flow) and the error is logged, also when RTI is down.
  Without `isChallengeResponse` replies are not recognized, and a warning is logged once per cold start.
- **RTI down.** When a recognized reply cannot be evaluated (RTI error or timeout, a malformed RTI response, or any other
  error before the decision, which all end in the handler's outer `catch`), it still goes to `config.challenge`, without
  `addRtiResultHeader` and with a stand-in `response` that is **not an RTI answer**: only `ids` exists, with
  `ids.rayId` and `ids.customParam2` set to the CloudFront request id (like `customId2` in the normal RTI payload) and every
  other id `null`. There is no `decision`, `classification` or anything else.
  - **Why `ids.rayId` is set:** `challenge` needs a non-empty, unique id. The example signs the `_cq_se` session with it and
    stores it in the cookie, and `validateChallenge` rejects a session with an empty one. It is never compared with RTI, so
    the session works like any other: the visitor proved they are human to Cloudflare, only the RTI verdict is missing.
  - **Always a plain, unique id.** CloudFront does not document the request id's characters, so it is checked: if it is
    not 1 to 200 of `A-Z a-z 0-9 _ = . -` (e.g. our own `on_error_request_id (...)` fallback, which has spaces), or it
    is the constant `unknown_request_id`, `ids.rayId` is a random `cf-fallback-<uuid>` instead. `ids.customParam2` keeps
    the real CloudFront request id. Both values are logged (`console.warn`, and the RTI logger unless `logErrors` is
    `false`), so the session can be traced to the request.
  - **It is not an RTI ray id.** Do not log or report it as one in a custom `challenge`, and check any other field before
    reading it (a throw is caught and the reply is forwarded).
  - It is never taken from `request_id` in the query: the client controls that value, and it would end up in `Set-Cookie`.
  - **Cost:** while RTI is failing, each reply makes a siteverify call that a plain fail-open forward would not.
- It never lengthens a session or skips RTI: a new `_cq_se` still needs a token that Cloudflare verifies, and the
  redirected request is checked by RTI again. `MONITORING` mode forwards replies unchanged, like everything else.
- If `config.challenge` throws (e.g. the siteverify call fails), the reply is forwarded (fail-open).

### Session Cookie Format

```
_cq_se={expiresAtMs}.{hexSignature}|{rayId}
```

- `expiresAtMs`: Unix timestamp in milliseconds (TTL default: 300 seconds)
- `hexSignature`: first 32 hex characters of HMAC-SHA256 keyed with `sessionSigningSecret` over the JSON array `["se", expiresAtMs, rayId]`. Without the secret nobody can make a valid cookie. Cookies issued by the previous, unkeyed version (SHA-256 of `{expiresAtMs}:{rayId}`) fail validation, so those visitors are challenged once more after the upgrade.
- **Not bound to `_cq_duid`:** on a first visit the challenge is solved before the CHEQ tag has set `_cq_duid`, so a session bound to it stopped working as soon as the cookie appeared and the visitor had to solve the CAPTCHA twice. A copied `_cq_se` cookie therefore works in another browser until it expires (`sessionTtlSeconds`).
- `rayId`: the RTI ray ID of the request that was answered with the session, i.e. the reply to the challenge page (not
  the request that showed the page). When RTI was down, the CloudFront request id or a random `cf-fallback-<uuid>` (see
  the **RTI down** item in [The reply to the challenge page](#the-reply-to-the-challenge-page)).

### Implementing a Custom Challenge

Replace `turnstileChallenge.challenge` / `turnstileChallenge.validateChallenge` / `turnstileChallenge.isChallengeResponse` in `config.ts` with your own functions (any of them) matching these signatures:

```typescript
// config.challenge
async (
  request: CloudFrontRequest,
  rtiResponse: RTIResponse, // when RTI failed (reply only): a stand-in with only `ids`, see "RTI down"
  addRtiResultHeader?: (headers: CloudFrontHeaders) => void // optional: adds x-cheq-rti-result to these headers
): Promise<CloudFrontRequestResult | CloudFrontResponseResult>

// config.validateChallenge
async (
  request: CloudFrontRequest,
  isDebug?: boolean
): Promise<boolean>

// config.isChallengeResponse (synchronous: only `true` counts)
(
  request: CloudFrontRequest
): boolean
```

The `challenge` function must return either:
- A CloudFront **response** object (e.g. 403 with challenge page HTML, or 302 redirect)
- The original **request** (pass-through, if you want to allow after custom logic). It reaches the origin **without** `x-cheq-rti-result` unless you call `addRtiResultHeader(request.headers)` first.

A custom `challenge` must also handle the reply to its own page (see [The reply to the challenge page](#the-reply-to-the-challenge-page)),
and `isChallengeResponse` must recognize that reply (e.g. by your CAPTCHA's token field). `challenge` is called for every
request it recognizes, also when RTI allows it, when the visitor has a valid session, and when RTI fails (a stand-in
`response` with only `ids`, where `ids.rayId` is the CloudFront request id and not an RTI ray id, and no
`addRtiResultHeader`: see the **RTI down** item there). Without `isChallengeResponse`, replies are not recognized (a warning is
logged once per cold start): in `BLOCKING` mode a reply that RTI allows then reaches the origin with the form fields.

> **Note:** If `config.challenge` throws, the error is caught and the request is passed through (fail-open). Errors are logged via `console.error`, and to the RTI logger unless `logErrors` is `false`.

---

## Build, Test & Deploy

### Build

```bash
sam build
```

SAM reads `template.yaml` and invokes esbuild for each Lambda entry point:

```
src/origin-request.ts ──esbuild──► .aws-sam/build/OriginRequest/origin-request.js
src/viewer-request.ts ──esbuild──► .aws-sam/build/ViewerRequest/viewer-request.js
```

The entire `../../core/` shared library is bundled into each Lambda at build time (no runtime dependency on the core package). Minification is enabled and sourcemaps are disabled to stay within Lambda@Edge's 1 MB package size limit.

> After **any** code or config change, always run `sam build` before deploying or local testing.

### Unit Tests

```bash
npm test
# Runs: tsc (type-check) then vitest --reporter=verbose --watch false
```

Tests are in:
- `src/request-helper.spec.ts` — the handler's own tests plus the shared behavioral suite (`core/testing/shared-unit-tests.ts`)
- `src/request-helper.integration.spec.ts` — the shared integration suite and the challenge-reply cases, with the real decision logic
- `src/request-helper.startup.spec.ts` — what `request-helper.ts` logs when it loads (`challenge` without `isChallengeResponse`)
- `src/turnstile-challenge-example.spec.ts` — challenge page, reply detection, siteverify, session signing and validation
- `src/config.spec.ts` — the shipped `config.ts`: defaults and Turnstile wiring
- `src/validate-config.spec.ts` — verifies `config.ts` passes validation
- `../../core/services/*.spec.ts` — unit tests for core services (run separately from `integrations/core/`)

### Local Testing

Three approaches, from fastest to most complete:

**Option 1: Direct TypeScript execution** (fastest, no Docker)
```bash
npx tsx test-sam-local-origin-request.ts
npx tsx test-sam-local-viewer-request.ts
```
These scripts import the handler directly, call it with a test event, and print the result including the parsed `x-cheq-rti-result` header.

**Option 2: SAM local invoke** (requires Docker, closer to production)
```bash
sam build
sam local invoke OriginRequest -e events/origin-request-event.json
sam local invoke ViewerRequest -e events/viewer-request-event.json
```

**Option 3: VS Code debugger**
Use the launch configurations in `.vscode/launch.json` at the repository root:
- `Debug Origin-Request (Direct TS)` — run with breakpoints
- `Debug CloudFront Tests (Vitest)` — debug unit tests

To use a custom test event, edit the JSON files in `events/` or create a new one. The event structure must match the [CloudFront Lambda@Edge event format](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html).

### Deploy

Lambda@Edge **must** be deployed to `us-east-1` regardless of your CloudFront distribution's region.

```bash
# Standard deploy
sam deploy --region us-east-1

# Deploy with trusted IP header parameter
sam deploy --region us-east-1 --parameter-overrides TrustedIPHeader=X-Real-IP

# Deploy with existing IAM role
sam deploy --region us-east-1 --parameter-overrides ExistingRoleArn=arn:aws:iam::123456789:role/my-role
```

The stack name and other defaults are configured in [`samconfig.toml`](samconfig.toml).

### Attaching to CloudFront

After deploying, note the ARNs from the SAM output. In the AWS Console or via CLI:

1. Go to **CloudFront** → select your distribution → **Behaviors** tab
2. Click **Edit** on the behavior you want to protect
3. Under **Function associations**:
   - For origin-request: set the `OriginRequestVersionARN` as the origin request Lambda@Edge
   - For viewer-request: set the `ViewerRequestVersionARN` as the viewer request Lambda@Edge
4. Under **Origin request policy** (origin-request only): select the policy name from the SAM output

> When using the origin-request approach, ensure your cache policy is configured to allow the Lambda to run on every request. If your distribution has caching enabled and you need the Lambda on every request, create a separate CloudFront distribution pointing to your existing distribution as an origin.

---

## Monitoring & Debugging

### Debug Mode

Set `debug: true` in `config.ts` to enable verbose logging. The Lambda will emit to CloudWatch Logs:

```
Original CF Event (Origin Request Flow): {"Records":[...]}
RTI Request payload: {"tagHash":"...","endUserParams":{"clientIp":"...","headers":{...}}}
RTI Response: {"metadata":{"version":"..."},"decision":{"verdict":"benign"},...}
action upon response: ALLOW (0)
```

> Never leave `debug: true` in production — logs contain full request data including headers and IP addresses.

### Telemetry

Set `telemetry: true` to send the RTI call duration to the CHEQ RTI logger endpoint for centralized monitoring, as a log message like:

```
rti_duration: 145
```

It is not written to CloudWatch (only the logger's response line is, with `debug: true`).

**Cost:** the handler waits for this log call before it answers the viewer. Usually that is one fast POST on a reused connection, but on a cold start it opens a new TLS connection, and if the logger endpoint is slow it waits up to 1,000ms. Keep `telemetry: false` (as shipped in `config.ts`) unless you are actively measuring.

### CloudWatch Logs

Lambda@Edge functions log to CloudWatch in the region **closest to the viewer**, not us-east-1. Find logs at:

```
/aws/lambda/us-east-1.{function-name}
```

**Finding the right region from a request:** The `x-amz-cf-id` response header that CloudFront adds to every response encodes the edge POP (Point of Presence) that served the request. You can decode it to find which AWS region handled the request and therefore where its CloudWatch logs are:

1. Take the `x-amz-cf-id` value from the browser DevTools → Network tab (response headers)
2. Base64-decode the first part (before the `_`) — it contains the POP code (e.g. `LHR`, `IAD`, `NRT`)
3. Map the POP code to its AWS region — e.g. `LHR` = `eu-west-2`, `IAD` = `us-east-1`, `NRT` = `ap-northeast-1`
4. Open CloudWatch Logs in that region and search for `/aws/lambda/us-east-1.{function-name}`

Alternatively, check the CloudFront access logs for the `x-edge-location` field, which directly shows the POP code for each request.

If you don't want to decode manually, check multiple regions or enable CloudFront access logs to see the `x-edge-location` field alongside each request.

### The `x-cheq-rti-result` Header

For every request forwarded after an RTI verdict (ALLOW, a waived CAPTCHA, or a CAPTCHA with no challenge configured), this header is injected into the request before it reaches your origin. Your origin server can read it to:
- Log RTI verdicts without modifying the Lambda
- Apply additional business logic based on threat scores
- Debug discrepancies between edge and origin behavior

---

## Troubleshooting

### Lambda times out

**Symptom:** CloudWatch shows `Task timed out after X seconds`.

**Cause:** The whole handler took longer than the Lambda limit (5 s for viewer-request, 30 s for origin-request). A slow RTI call alone does not cause this: it is aborted after `config.timeout` and the request passes through. The handler's time is `config.timeout` + up to 1,000ms per awaited logger call (telemetry, errors, and the challenge-reply logs: usually at most two in one request, up to four when several things fail) + the challenge's own time. The Turnstile example verifies tokens with global `fetch` and **no timeout**, so a slow siteverify is not bounded, and the first verification in a cold container also pays the `fetch` (undici) load cost.

**Fix:** When `config.timeout` is not set, the RTI call times out after 2000ms. Increase it if your network latency to the RTI endpoint is higher. For viewer-request, keep it at or below about 2,500ms so the RTI call, two logger calls (1,000ms each, the usual maximum) and the challenge fit in the 5 s limit. Use the origin-request approach if you need more time. If you use the Turnstile example on viewer-request, add a timeout to its siteverify call (e.g. `signal: AbortSignal.timeout(1000)`). Consider checking `rti_duration` logs to understand your P99 latency.

### RTI call aborted due to timeout

**Symptom:** CloudWatch shows `request error: The operation was aborted due to timeout` for a share of requests, and those requests pass through without an RTI decision.

**Cause:** Usually a cold start. The first RTI call in a new container has to load the HTTP client and open the TLS connection on the limited CPU of a 128 MB Lambda, and that can take longer than `config.timeout`. See [Memory, CPU and Cold Starts](#memory-cpu-and-cold-starts).

**How to confirm:** In the regional log group (`/aws/lambda/us-east-1.<function-name>` in the region that ran the request), find the `REPORT` line for the failed invocation. If it has an `Init Duration` field, the failure was a cold start.

**Fix:** The viewer-request Lambda's memory (and so its CPU) cannot be raised. Raising `config.timeout` gives cold calls more room, at the cost of a slower fail-open when RTI really is unreachable.

### Headers missing from RTI payload

**Symptom:** RTI decisions seem inaccurate; expected headers not in debug payload logs.

**Cause (origin-request):** The header is not whitelisted in the origin request policy attached to the behavior.

**Fix:** Check which policy is attached to the CloudFront behavior. Add the missing header to your policy or switch to `OriginRequestPolicyAllHeadersAllowed` for testing.

**Cause (viewer-request):** `keepHeadersNames` is set and the header name is not in the list.

**Fix:** Add the header name to `keepHeadersNames`, or set it to `[]` to forward all headers.

### Cache bypasses RTI (origin-request)

**Symptom:** Some requests reach the origin without the `x-cheq-rti-result` header.

**Cause:** Those requests are cache hits. Origin-request Lambda does not run on cache hits.

**Fix:** This is expected behavior. If you need RTI on every request, either: (1) disable caching on the behavior, (2) switch to the viewer-request approach, or (3) configure a cache policy with a very short TTL for sensitive paths.

### Turnstile challenge loops infinitely

**Symptom:** Users keep seeing the CAPTCHA after completing it.

**Cause:** The `_cq_se` cookie is not being set or not being sent on subsequent requests (e.g. the cookie was set with `SameSite=Strict`, which the browser drops when the visitor arrives from another site, or the cookie domain is wrong).

**Fix:** Verify the `Set-Cookie` header in the 302 response. Check that the cookie `Path=/` is correct for your URL structure. Make sure the cookie uses `SameSite=Lax` (the shipped example does). `SameSite=Strict` breaks visitors coming from other sites: the cookie is not sent on the cross-site navigation, so they are challenged again.

A second cause: the `_cq_session` cookie name starts with `_cq_se` — the example matches `_cq_se=` (with the `=`) to avoid this collision. Verify this is the case in your implementation.

### "Verification failed" after a refresh, Back, or a long wait

**Symptom:** The visitor sees a plain `403 Verification failed. Please try again.` page with no widget, and refreshing shows it again.

**Cause:** The Turnstile token is single-use and expires after 300 seconds. The challenge form is sent with `GET`, so the token stays in the URL (`?cf-turnstile-response=...`). Refreshing or going Back after a successful challenge, opening a shared or bookmarked URL, or submitting the form more than 5 minutes after solving it sends a used or expired token. Cloudflare's siteverify rejects it (`timeout-or-duplicate`) and the example answers with the plain 403. Every refresh resends the same dead token. In `BLOCKING` mode this happens whether RTI allows the reply or asks for a CAPTCHA: either way it goes to `config.challenge` (see [The reply to the challenge page](#the-reply-to-the-challenge-page)).

**Fix:** The visitor can open the page without the query string (or navigate on), which gives a fresh challenge. To avoid the dead end, change the failure branch of `turnstileChallengeExample` to a `302` back to the same path **without** `cf-turnstile-response`, `original_url` and `request_id` (with `Cache-Control: no-store`), so the next request shows a fresh widget. This cannot loop by itself: the page only submits when the visitor clicks *Continue*. Log siteverify's `error-codes` when they are not `timeout-or-duplicate`; codes such as `invalid-input-secret` mean the `secretKey` in `config.ts` is wrong.

### SAM deploy fails with `CAPABILITY_NAMED_IAM`

**Fix:** Ensure your `samconfig.toml` includes `capabilities = "CAPABILITY_NAMED_IAM"` under `[default.deploy.parameters]`, or pass `--capabilities CAPABILITY_NAMED_IAM` to the deploy command.

### Fail-open behavior

If the RTI API is unreachable, times out, or returns an unexpected error, the Lambda **always passes the request through** to the origin unchanged (apart from removing any client-sent `x-cheq-rti-result`). This is by design — the integration prioritizes availability over security in error scenarios. One exception: in `BLOCKING` mode a reply to the challenge page still goes to `config.challenge`, which redirects it to the original URL (see [The reply to the challenge page](#the-reply-to-the-challenge-page)); if that throws too, the reply is passed through. A malformed `rtiServiceURI` or `rtiLoggerURI` also fails open: the services are created when the Lambda starts, but the URL is only checked on each call.

Errors are logged to CloudWatch (via `console.error`) and, unless `logErrors` is `false`, to the RTI logger endpoint (via `RTIHttpsLoggerService`, which gives up after 1,000ms).

---

## Core Library Reference

The `integrations/core/` package is a shared TypeScript library bundled into each Lambda at build time. You should not need to modify it for standard use cases.

### Services

| Service | File | Purpose |
|---------|------|---------|
| `RTIHttpsService` | `services/rti-https.service.ts` | RTI caller used by this integration. Sends `POST` with the request payload over `node:https` with a keep-alive agent (idle connections are closed after 50s, before the RTI endpoint's 60s idle timeout; if a pooled connection is still found dropped, the call is retried once on a new one, see [Reused connections](#reused-connections)), applies `config.timeout` to the whole call (connect, send, read body), parses the JSON response. |
| `RTIService` | `services/rti.service.ts` | `fetch`-based RTI caller used by the other CDN integrations. Same timeout handling (`config.timeout` covers the whole call) and HTTP-status error messages as `RTIHttpsService` (network errors differ: fetch reports `fetch failed`, `node:https` the Node error such as `connect ECONNREFUSED ...`), but falls back to a 150ms timeout (instead of 2000ms) when `config.timeout` is not set; handles timeouts via `AbortSignal.timeout()`. Both extend `RTIServiceBase` (`services/rti-service.base.ts`), which resolves the URL and timeout from config. |
| `RTIHelperService` | `services/rti-helper.service.ts` | Decision logic: `shouldIgnore()`, `getEventType()`, `parseCookies()`, `getAction()`, `getActionStrategy()`, `isChallengeReplyAllowed()`, `buildRtiResultHeader()`, `errorMessage()`, `getCheqCookie()`, `getHeaderByName()`, `validateConfig()`. |
| `RTIHttpsLoggerService` | `services/rti-https-logger.service.ts` | Logger used by this integration. Sends log messages to the RTI logger endpoint over `node:https` with a keep-alive agent (idle connections closed after 50s) and gives up after 1,000ms. Swallows all errors to avoid breaking the request flow. |
| `RTILoggerService` | `services/rti-logger.service.ts` | `fetch`-based logger used by the other CDN integrations. Same payload and error handling, no timeout. Both extend `RTILoggerServiceBase` (`services/rti-logger.service.base.ts`). |
| `HttpsClient` | `services/https-client.ts` | Keep-alive JSON `POST` client on `node:http`/`node:https`, shared by `RTIHttpsService` and `RTIHttpsLoggerService`. Sends `User-Agent: cheq-rti-cloudfront`; does not follow redirects or strip a BOM (see [Differences from the previous `fetch` client](#differences-from-the-previous-fetch-client)). |

### Key Enums

| Enum | Values | File |
|------|--------|------|
| `Action` | `ALLOW=0, CHALLENGE=1, BLOCK=2, REDIRECT=3` | `models/action.model.ts` |
| `ActionStrategy` | `ACCESS_DENIED=0, NOT_FOUND=1, REDIRECT=2, CAPTCHA=3` | `models/action-strategy.model.ts` |
| `Mode` | `MONITORING=0, BLOCKING=1` | `models/mode.model.ts` |
| `EventType` | `PAGE_LOAD, PURCHASE, SEARCH, REGISTRATION, ...` | `models/event-type.model.ts` |

### RTI Response Shape

The RTI API returns an `RTIResponse` object. The fields used by the integration logic are:

```typescript
{
  metadata: {
    version: string        // response schema version
  },
  decision: {
    verdict: 'benign' | 'suspicious' | 'malicious'
  },
  classification: {
    code: number           // threat type code (matched against blockTTCodes, etc.)
  },
  ids: {
    rayId: string          // unique request trace ID (included in block pages + headers)
  },
  cheqDetection: {
    reasons: number[]      // reason codes contributing to detection
  }
}
```

The full response schema (including device fingerprints, geo data, ASN, and 40+ additional fields) is documented in [`core/models/rti-response.model.ts`](../core/models/rti-response.model.ts).

---

## Additional Resources

- [Lambda@Edge Developer Guide](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-the-edge.html)
- [Lambda@Edge Limits and Quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-requirements-limits.html) — pay attention to package size (1 MB), timeout limits, and supported runtimes
- [CloudFront Origin Request Policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-origin-requests.html)
- [CloudFront Lambda@Edge Event Structure](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html)
- [Cloudflare Turnstile Documentation](https://developers.cloudflare.com/turnstile/)
- [AWS SAM CLI Documentation](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/using-sam-cli.html)
- [docs/LAMBDA-EDGE-COMPARISON.md](docs/LAMBDA-EDGE-COMPARISON.md) — in-depth comparison of origin-request vs viewer-request approaches with cost analysis, security trade-offs, and real-world scenarios

---

**Integration Version:** 0.2.0  
**Lambda Runtime:** Node.js 20.x  
**Last Updated:** October 2026
