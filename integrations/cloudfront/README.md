<!-- cspell:ignore CHEQ cheq Paradome trunstile duid pvid referer siteverify healthcheck smarttv -->
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

> **Recommendation:** Use the **Viewer-Request** model. It runs on every request before the cache and has access to all viewer headers (including TLS fingerprints, IP, user-agent), making it the right trigger point for detecting malicious activity. The Origin-Request model can technically work but is not well-suited — it skips cached traffic entirely and only receives the headers you explicitly whitelist.
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
     │  2. validChallenge? ─► YES ──► pass through       │
     │  3. Call RTI API                                  │
     │  4. verdict/code/reasons ──► Action               │
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
│   ├── request-helper.test.ts         # Unit tests for the core flow
│   └── validate-config.test.ts        # Sanity-check that config.ts passes validation
│
├── events/
│   ├── origin-request-event.json      # Test event for sam local invoke / direct testing
│   └── viewer-request-event.json      # Test event for viewer-request testing
│
├── assets/                            # Static assets (e.g. images used in docs)
│
├── docs/
│   └── LAMBDA-EDGE-COMPARISON.md      # Deep-dive: origin-request vs viewer-request
│
├── test-sam-local-origin-request.ts   # Run origin-request handler directly (npx tsx)
├── test-sam-local-viewer-request.ts   # Run viewer-request handler directly (npx tsx)
├── template.yaml                      # AWS SAM template (Lambda functions + IAM + policies)
├── samconfig.toml                     # SAM deployment defaults (stack name, region, etc.)
├── tsconfig.json                      # TypeScript config (type-check only, esbuild bundles)
└── package.json                       # npm scripts and dependencies

integrations/core/                     # Shared library (bundled by esbuild at build time)
├── helpers/
│   ├── block-page-helpers.ts          # Generates default HTML block pages (403/404)
│   └── block-page-helpers.test.ts     # Unit tests for block page generation
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
│   ├── rti.service.ts                 # HTTP client for the RTI API
│   ├── rti.service.spec.ts            # Unit tests for RTI service
│   ├── rti-helper.service.ts          # Action/strategy decision logic
│   ├── rti-helper.service.spec.ts     # Unit tests for helper service
│   ├── rti-logger.service.ts          # Telemetry/error logging to RTI logger endpoint
│   └── rti-logger.service.spec.ts     # Unit tests for logger service
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
const config: CloudfrontConfig = {
     apiKey: 'YOUR_API_KEY',       // From Paradome → Settings → Defend
     tagHash: 'YOUR_TAG_HASH',     // From Paradome → Settings → TAGS
     mode: Mode.BLOCKING,           // Start with MONITORING to observe before enforcing
     redirectLocation: 'any page you desire to to act as redirect page' // by default it is https://www.cheq.ai/
     ignorePaths: undefined, // Set the paths that should be skip the RTI logic, for example: ['/images', '/api/test', '\\.css$', '\\.js$']
     telemetry: false, // Relevant when need/want to monitor telemetry
     timeout: 500, // RTI call default timeout if this one is not set is 150 ms
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
| `redirectLocation` | `string` | By default it will be `https://www.cheq.ai/` but it is assumed that customer would like to use different page |


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
| `redirectLocation` | `string` | `'https://www.cheq.ai/'` | URL to redirect to when a REDIRECT action is triggered. Required when using `redirectReasons` or `redirectTTCodes`. |

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
| `challenge` | `(request: CloudFrontRequest, response: RTIResponse) => Promise<CloudFrontRequestResult \| CloudFrontResponseResult>` | `undefined` | Called when action strategy is `CAPTCHA`. Receives the full CloudFront request and RTI response. Must return a CloudFront response (e.g. challenge page) or the request (pass-through). See `turnstile-challenge-example.ts` for a reference implementation. |
| `validateChallenge` | `(request: CloudFrontRequest, isDebug?: boolean) => Promise<boolean>` | `undefined` | Called at the start of every request **before** the RTI call. Return `true` to skip RTI and pass the request through (e.g. when the user has already completed a challenge and has a valid session cookie). |
| `keepHeadersNames` | `string[]` | `undefined` | **Origin-request only.** When non-empty, only these header names are collected and forwarded to RTI. When empty or `undefined`, all available headers are forwarded. Useful for reducing payload size when only certain headers are relevant. In viewer-request, all headers are always available. |

### Network & Endpoints

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout` | `number` | `150` | RTI API request timeout in milliseconds. The viewer-request Lambda has a 5-second hard limit — keep this well below 5000 for viewer-request deployments. Default 150ms is suitable for most use cases. |
| `rtiServiceURI` | `string` | `'https://rti-global.cheqzone.com/defend/4.1/traffic'` | Override the RTI service endpoint. Leave `undefined` for production. Set to a dev/staging URL for testing. |
| `rtiLoggerURI` | `string` | `'https://rtilogger.production.cheq-platform.com'` | Override the RTI logger endpoint. Leave `undefined` for production. |

### Debug & Observability

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `debug` | `boolean` | `false` | Enables verbose `console.log` output: full CloudFront event, RTI request payload, RTI response, determined action, and action strategy. These appear in CloudWatch Logs. **Disable in production** — logs contain full request data. |
| `telemetry` | `boolean` | — | Required. When `true`, sends RTI request duration (`rti_duration: {ms}`) to the logger endpoint after each RTI call. |

### Complete Config Example

```typescript
import { Mode, ActionStrategy, EventType } from '../../core/models';
import { CloudfrontConfig } from './config';
import { turnstileChallengeExample, trunstileValidateChallengeExample } from './turnstile-challenge-example';

export const config: CloudfrontConfig = {
  // --- Required ---
  apiKey: 'YOUR_API_KEY',
  tagHash: 'YOUR_TAG_HASH',
  mode: Mode.BLOCKING,
  telemetry: true,

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
  challenge: turnstileChallengeExample,
  validateChallenge: trunstileValidateChallengeExample,

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
  timeout: 150,
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
│ 3. CHALLENGE VALIDATION                                          │
│    config.validateChallenge?.(cfRequest, isDebug)               │
│    YES (valid session) → return cfRequest (skip RTI)            │
│    NO or not configured → continue                              │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. BUILD RTI PAYLOAD                                             │
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
│ 5. CALL RTI API                                                  │
│    POST to config.rtiServiceURI (timeout: config.timeout ms)    │
│    On HTTP >= 400: throw Error (caught below → fail-open)       │
│    On network error: throw Error (caught below → fail-open)     │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. TELEMETRY                                                     │
│    If config.telemetry: log "rti_duration: {ms}" via logger     │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 7. DETERMINE ACTION                                              │
│    getAction(rtiResponse) → ALLOW | BLOCK | CHALLENGE | REDIRECT │
│    In MONITORING mode: always returns ALLOW                      │
└─────────────────────────────────────────────────────────────────┘
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
       HTTP 403      HTTP 404     HTTP 302       config.challenge(req, resp)
       block page    block page   Location hdr   challenge page / cookie redirect
                                                 On error: fail-open

┌─────────────────────────────────────────────────────────────────┐
│ ERROR HANDLING (outer try/catch)                                 │
│ Any exception → log error via console + logger → return cfRequest│
│ FAIL-OPEN: on any error, traffic is allowed through              │
└─────────────────────────────────────────────────────────────────┘
```

### `x-cheq-rti-result` Header Format

When a request is **allowed**, this header is injected before forwarding to origin:

```
x-cheq-rti-result: version={v};verdict={v};threat-type-code={n};ids={json};reasons={n,n,...}
```

Example:
```
x-cheq-rti-result: version=4.1;verdict=benign;threat-type-code=0;ids={"rayId":"abc123",...};reasons=
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
| `OriginRequest` | `origin-request` | 30 s | 128 MB | `origin-request.ts` → `handle` |
| `ViewerRequest` | `viewer-request` | **5 s** (hard limit) | 128 MB | `viewer-request.ts` → `handle` |

Both functions:
- Runtime: `nodejs20.x`, x86_64
- Built with esbuild (minified, ES2020 target, no sourcemaps)
- `AutoPublishAlias: live` — automatically publishes a new version on each deploy
- IAM role: created automatically or reused via `ExistingRoleArn`

> **Important:** The viewer-request 5-second timeout is a hard CloudFront limit. The `config.timeout` (RTI API timeout) must be kept well below 5000ms for viewer-request deployments. The default of 150ms is recommended.

### Origin Request Policies

Five CloudFront origin request policies are created. They control which viewer headers CloudFront forwards to the origin-request Lambda.

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

### How the Challenge Flow Works

```
Request arrives → RTI verdict triggers CHALLENGE → config.challenge() called
        │
        ▼
 Does the request have a `cf-turnstile-response` query parameter?
        │
   NO ──┤──► Return HTTP 403 with CAPTCHA challenge page
        │       (Turnstile widget + hidden form)
        │       User solves the CAPTCHA
        │       Form submits back to same URL with token appended
        │
   YES ──► POST token to Cloudflare siteverify API (server-side)
               │
          Verification fails ──► Return 403 "Verification failed"
               │
          Verification passes
               │
               ▼
          Generate signed session token:
          "{expiresAt}.{sha256(expiresAt:rayId)[0:16]}"
               │
               ▼
          Return HTTP 302 redirect to original URL
          Set-Cookie: _cq_se={token}|{rayId}; HttpOnly; Secure; SameSite=Strict; Max-Age=300
```

On subsequent requests, `config.validateChallenge` (`trunstileValidateChallengeExample`) runs **before** the RTI call:

```
Read _cq_se cookie → parse {token}|{rayId}
     │
     ▼
Split token → {expiresAt}.{signature}
     │
     ├── expired? (Date.now() > expiresAt) → return false (RTI runs again)
     │
     └── Recompute sha256(expiresAt:rayId) and compare signature
              │
         Matches? → return true (skip RTI, pass through)
         No match? → return false (RTI runs)
```

### Session Cookie Format

```
_cq_se={expiresAtMs}.{hexSignature}|{rayId}
```

- `expiresAtMs`: Unix timestamp in milliseconds (TTL default: 300 seconds)
- `hexSignature`: First 16 hex characters of SHA-256(`{expiresAtMs}:{rayId}`)
- `rayId`: RTI ray ID from the original BLOCK/CHALLENGE response

### Implementing a Custom Challenge

Replace `turnstileChallengeExample` with your own function matching this signature:

```typescript
// config.challenge
async (
  request: CloudFrontRequest,
  rtiResponse: RTIResponse
): Promise<CloudFrontRequestResult | CloudFrontResponseResult>

// config.validateChallenge
async (
  request: CloudFrontRequest,
  isDebug?: boolean
): Promise<boolean>
```

The `challenge` function must return either:
- A CloudFront **response** object (e.g. 403 with challenge page HTML, or 302 redirect)
- The original **request** (pass-through, if you want to allow after custom logic)

> **Note:** If `config.challenge` throws, the error is caught and the request is passed through (fail-open). Errors are logged via `console.error` and the RTI logger.

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
- `src/request-helper.test.ts` — 20+ tests covering all branches of the RTI flow
- `src/validate-config.test.ts` — verifies `config.ts` passes validation
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
Use the launch configurations in `.vscode/launch.json`:
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
[Origin Request Flow] Original CF Event: {"Records":[...]}
RTI Request payload: {"tagHash":"...","endUserParams":{"clientIp":"...","headers":{...}}}
RTI Response: {"metadata":{"version":"..."},"decision":{"verdict":"benign"},...}
action upon response: ALLOW (0)
action strategy: none (should not happen)
```

> Never leave `debug: true` in production — logs contain full request data including headers and IP addresses.

### Telemetry

Set `telemetry: true` to log RTI response duration. Appears in CloudWatch Logs as:

```
rti_duration: 145
```

This is also sent to the RTI logger endpoint for centralized monitoring.

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

For all **allowed** requests, this header is injected into the request before it reaches your origin. Your origin server can read it to:
- Log RTI verdicts without modifying the Lambda
- Apply additional business logic based on threat scores
- Debug discrepancies between edge and origin behavior

---

## Troubleshooting

### Lambda times out

**Symptom:** CloudWatch shows `Task timed out after X seconds`.

**Cause:** RTI API response is taking longer than `config.timeout`.

**Fix:** The default `config.timeout` is 150ms. Increase it if your network latency to the RTI endpoint is higher. For viewer-request, you cannot exceed ~4500ms (5s Lambda limit minus overhead). Use the origin-request approach if you need more time. Consider checking `rti_duration` logs to understand your P99 latency.

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

**Cause:** The `_cq_se` cookie is not being set or not being sent on subsequent requests (e.g. `SameSite=Strict` blocks it on cross-site navigation, or the cookie domain is wrong).

**Fix:** Verify the `Set-Cookie` header in the 302 response. Check that the cookie `Path=/` is correct for your URL structure. For cross-site navigation, consider changing `SameSite=Strict` to `SameSite=Lax` in the challenge implementation.

A second cause: the `_cq_session` cookie name starts with `_cq_se` — the example uses `startsWith("_cq_se=")` (with the `=`) to avoid this collision. Verify this is the case in your implementation.

### SAM deploy fails with `CAPABILITY_NAMED_IAM`

**Fix:** Ensure your `samconfig.toml` includes `capabilities = "CAPABILITY_NAMED_IAM"` under `[default.deploy.parameters]`, or pass `--capabilities CAPABILITY_NAMED_IAM` to the deploy command.

### Fail-open behavior

If the RTI API is unreachable, times out, or returns an unexpected error, the Lambda **always passes the request through** to the origin unchanged. This is by design — the integration prioritizes availability over security in error scenarios.

Errors are logged to both CloudWatch (via `console.error`) and the RTI logger endpoint (via `RTILoggerService`).

---

## Core Library Reference

The `integrations/core/` package is a shared TypeScript library bundled into each Lambda at build time. You should not need to modify it for standard use cases.

### Services

| Service | File | Purpose |
|---------|------|---------|
| `RTIService` | `services/rti.service.ts` | HTTP client for the RTI API. Sends `POST` with the request payload, handles timeouts via `AbortSignal.timeout()`, parses the JSON response. |
| `RTIHelperService` | `services/rti-helper.service.ts` | Decision logic: `shouldIgnore()`, `getEventType()`, `getAction()`, `getActionStrategy()`, `getCheqCookie()`, `getHeaderByName()`, `validateConfig()`. |
| `RTILoggerService` | `services/rti-logger.service.ts` | Fire-and-forget telemetry logger. Sends log messages to the RTI logger endpoint. Swallows all errors to avoid breaking the request flow. |

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
**Last Updated:** April 2026
