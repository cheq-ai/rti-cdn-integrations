<div align="center">
  <img src="https://raw.githubusercontent.com/cheq-ai/rti-cdn-integrations/main/assets/cheq-logo.svg">
</div>

# cheq-rti-cdn-integrations::cloudflare

![Integration Version](https://img.shields.io/github/v/release/cheq-ai/rti-cdn-integrations?label=Integration%20Version)
![Cloudflare Wrangler on npm](https://img.shields.io/npm/v/wrangler.svg?logo=npm&logoColor=fff&label=Cloudflare+Wrangler+on+npm&color=orange)

This repository provides the components to invoke RTI from Cloudflare.

### Documentation

[Cloudflare Integration](https://github.com/cheq-ai/rti-cdn-integrations/blob/main/integrations/cloudflare/README.md)

Built with [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/)

### Prerequisites:

- You need Node.js v20+ (required by wrangler)

- Modify the [configuration](https://github.com/cheq-ai/rti-cdn-integrations/blob/main/integrations/cloudflare/src/config.ts)
at `src/config.ts` to set your `apiKey`, `tagHash` and the other settings of the integration.

### Login to Cloudflare (one-time)
```bash
npx wrangler login
```

### Verify config

```bash
npm i; npm run test
```

`npm run test` runs `tsc` and the tests. They check that your config is valid. While `apiKey`, `tagHash` and the three
Turnstile secrets are all still `REPLACE_ME`, they also check that `config.ts` still has the shipped defaults; those
checks are skipped once one of the five has your value. `npm run deploy` runs the same tests first, and deploys only
when they pass.

### Test locally (using Wrangler)

A local run has no origin behind the Worker, so first switch `forwardToOrigin` to OPTION 1 (see
[Local or demo origin](#local-or-demo-origin)): with the shipped OPTION 2, `fetch(request)` goes to the local address,
which is the Worker itself (`wrangler dev` 4.56.0).

```bash
npm i; npm run start
```

In our `wrangler dev` 4.56.0 runs, after the Worker answered a request with a body (a `POST`) with a redirect, the next
request hung (no answer while the client waited, up to 35 s; the request after it was answered) or got
`503 Your worker restarted mid-request`, about one time in three in runs of only that case (27 of 80); after the block
page or the CAPTCHA page it did not (0 of 80). Whether production does this is not known. Awaiting the body read in
`fetch` ([`src/index.ts`](src/index.ts)) instead of passing it to `context.waitUntil` ended it in every try (0 of 138
follow-up requests, including 40 in a run of only redirects):

```ts
await originRequest.body.pipeTo(new WritableStream()).catch(() => {});
```

This line is not shipped, and the tests in `src/index.spec.ts` that look at `waitUntil` expect the background read.
Its cost, in production too: the Worker's own answer waits for the client's whole body, and a client that never
finishes it gets no answer from the Worker.

### Deploy (using Wrangler)
```bash
npm i; npm run deploy
```

### Example Deploy Output
```
Old v4 Deployment ID: 2874786b-81d1-4f73-973e-8ec5a8305b6c (cheq-rti-v4-integration-cloudflare)

New v4.1 Deployment ID (Code modified so the origin is the S3 static site and the rti response header returned to caller - both not relevant for prod): f582e7d2-56e9-439c-95c2-251a65562292 (cheq-rti-v4_1-integration-cloudflare)
```

### Cloudflare Configuration
Set up routes in `wrangler.toml` or using Cloudflare Dashboard

https://developers.cloudflare.com/workers/wrangler/configuration/

https://developers.cloudflare.com/workers/platform/triggers/routes/

### How a request is handled

The Worker's `fetch` in [`src/index.ts`](src/index.ts) first calls `context.passThroughOnException()`. Then `handle`
decides what happens to the request. It never calls the origin: it returns either our own answer (a block page, a
redirect, a CAPTCHA page), which the Worker sends as it is, or the request to send on, which `forwardToOrigin` passes to
the origin. `forwardToOrigin` is the only place that calls the origin (see [Local or demo origin](#local-or-demo-origin)).

A request goes through eight steps (the copy in `fetch`, the rest in `handle`):

1. **Copy.** `fetch` copies the request before `handle` starts, and the request body moves to the copy, so every config
   callback gets the copy, never the incoming request. The copy is what reaches the origin, unless the Worker answers
   itself (then it reads the rest of the copy's body in the background and throws it away; for a local run, see
   [Test locally](#test-locally-using-wrangler)) or `config.challenge` returns another `Request`, which is sent on as
   returned. An `x-cheq-rti-result` or `x-cheq-original-referer` sent by the client is removed from the copy. Then
   `config.originalReferer` is called (it may return a promise); a value becomes `x-cheq-original-referer`. If it
   throws or rejects, the error is written to the console and the request goes on without the header.
2. **Ignored path.** A path that matches `ignorePaths` is forwarded without calling RTI.
3. **RTI.** The RTI payload is built from the copy: a fixed list of headers (`x-cheq-original-referer` among them), the
   CHEQ cookies, and the JA3 hash from the incoming request's `cf`. With `telemetry: true` the duration of the call goes
   to the RTI logger through `waitUntil`.
4. **Decision.** RTI's answer becomes an action (`getAction`), and the action a strategy for this method and path
   (`getStrategyForRequest`). For a `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS` with a CAPTCHA verdict,
   [`actionOnSuspicious`](#actiononsuspicious) decides.
5. **Challenge reply.** In `BLOCKING` mode, with `challenge` and `isChallengeResponse` set, a request that
   `isChallengeResponse` recognizes goes to `config.challenge` when the strategy is none (ALLOW) or `CAPTCHA`, whatever
   session the visitor has. A throwing `isChallengeResponse` counts as no reply. A throwing `challenge` is logged and the
   request is forwarded.
6. **By strategy.**
   - `ACCESS_DENIED`, `NOT_FOUND`: our 403 or 404 block page, with HTML and no-store headers.
   - `REDIRECT`: a 302 to `redirectLocation` (default `https://www.cheq.ai/`), with `x-cheq-cdn-request-id`,
     `x-cheq-id`, `x-cheq-page-view-id` and no-store.
   - `CAPTCHA` without `config.challenge`: forwarded with the verdict.
   - `CAPTCHA`, and `validateChallenge` returns `true` (a valid session): forwarded with the verdict. The session waives
     only the CAPTCHA, never a block, a 404 or a redirect.
   - `CAPTCHA` otherwise: `config.challenge`. A `GET` or `HEAD` is challenged in place. A request with a body is
     challenged for the page it came from: a `GET`, without the body, for the same-site `Referer`, or for `/` without
     one. Only the path and the query of the request's own URL are changed, so the host cannot change.
   - A throw from `validateChallenge` or `challenge`: logged, and the request is forwarded without the verdict.
7. **Allow.** Every other request (ALLOW, a request with a body that `actionOnSuspicious` lets through, and the `CAPTCHA`
   cases above that are forwarded with the verdict) gets `x-cheq-rti-result` on the copy, and the copy is forwarded.
8. **Any error before the decision** (an RTI error or timeout, a malformed RTI response): logged. A recognized challenge
   reply (the same conditions as step 5) still goes to `config.challenge`, with a stand-in response and no
   `addRtiResultHeader` (see [Challenge callbacks](#challenge-callbacks)). Everything else is forwarded, without the
   verdict.

**Logs.** Errors go to `console.error`, and to the RTI logger through `waitUntil` unless `logErrors` is `false`:
`Error handling request '<id>'`, `Challenge error handling request '<id>'` and
`Challenge reply check error handling request '<id>'`, where `<id>` is the `cf-ray` value or `unknown_request_id`.
With `debug: true` the Worker also logs the RTI payload (redacted), the RTI response, the action, the strategy, and the
lines `challenge reply, passing it to challenge` and `valid challenge session, waiving CAPTCHA`.

**Cold start.** When the module loads, the Worker logs one warning when `challenge` is set without
`isChallengeResponse`, then one per problem in `actionOnSuspicious`
(`[config] <problem> (see "actionOnSuspicious" in the README)`). If the `actionOnSuspicious` check throws, it logs
`[config] the config check failed, continuing: …` and the Worker still starts. While the three Turnstile secrets are
`REPLACE_ME` (as shipped), it also logs
`[turnstile] CAPTCHA disabled, not configured: siteKey, secretKey, sessionSigningSecret (set them in config.ts)`.

### actionOnSuspicious and logErrors

Both are in the `config` object in [`src/config.ts`](src/config.ts). For example:

```ts
actionOnSuspicious: {
    methods: { POST: Action.ALLOW, PUT: Action.ALLOW, PATCH: Action.ALLOW, DELETE: Action.ALLOW, OPTIONS: Action.ALLOW },
    rules: [
        { path: '^/login$', methods: ['POST'], action: Action.CHALLENGE }, // login form: CAPTCHA, then log in again
        { path: '^/api/', action: Action.BLOCK },                          // every body method under /api/
    ],
},
logErrors: true, // false: caught errors go to the console only, not to the RTI logger
```

The shipped config has every method on `Action.ALLOW`, `rules: []` and `logErrors: true`.

#### actionOnSuspicious

**Only `GET` and `HEAD` are challenged in place.** A CAPTCHA page can't carry a request body through its redirect (a
login, a checkout, a bank's 3-D Secure return). For a `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS` with a CAPTCHA
verdict, `actionOnSuspicious` says what to do instead. Blocks, 404s and redirects from RTI still apply to every method,
except with `blockingStrategy: CAPTCHA`: then a block is a CAPTCHA verdict too, so a request with a body that RTI wants
blocked follows `actionOnSuspicious` as well (forwarded with `x-cheq-rti-result`, as shipped). A site with that setting
that wants these requests stopped sets `Action.BLOCK` or `Action.CHALLENGE` for their methods or paths.
`actionOnSuspicious` cannot see whether RTI said block or challenge, so the setting applies to both.

| Action | What a request with a body gets |
|---|---|
| `Action.ALLOW` (default for every method) | Forwarded with `x-cheq-rti-result`, so the origin decides. |
| `Action.CHALLENGE` | The CAPTCHA page, built for the page the visitor came from (the `Referer`, same site only; without one, or from another site, the site's home page `/`). After solving they are back on that page and send the form again. The body itself is not kept. A visitor with a valid session is not challenged: the request is forwarded with the verdict. While the CAPTCHA is off (no `config.challenge`), the request is forwarded with the verdict too. |
| `Action.BLOCK` | The `blockingStrategy` answer (403 by default, or 404). With `blockingStrategy: CAPTCHA` it is the CAPTCHA page, as for `Action.CHALLENGE`. |
| `Action.REDIRECT` | A 302 to `redirectLocation`. |

- `methods` is the default per method. A method left out is `ALLOW`.
- `rules` match the path with a regex (like `ignorePaths`) and, optionally, a list of methods. They are checked in
  order; the first match wins over `methods`.
- `OPTIONS` is the browser's CORS preflight, sent before a cross-site call. Blocking or challenging it breaks that call.
- A typo is logged as a warning once per cold start (`[config] <problem> (see "actionOnSuspicious" in the README)`).
  What it does depends on where it is. A key in `methods` that isn't one of these five is not used (a method left out
  is `ALLOW`), and a value that isn't an `Action`, in `methods` or as a rule's `action`, counts as `ALLOW`. A rule with
  a bad regex never matches, and a method misspelled in a rule's `methods` (`'post'`, `'PST'`) is never matched by it:
  the next rule or the method's default applies, and that can be `BLOCK`.
- **Known limit: keep exactly the shape shown above.** `config.ts` is TypeScript, which enforces it. A value forced past
  it (`as any`, or a config built in plain JS) is not checked when the Worker runs:
  - **Every rule needs a `path`, written as a string** (`'^/login$'`, not `/^\/login$/`). JavaScript turns any other
    value into a regex: a rule **without** a `path` matches **every** path, so `{ methods: ['POST'], action:
    Action.BLOCK }` blocks every suspicious `POST`, and `path: null` matches paths containing `null`. The cold-start
    warning does not catch it.
  - `rules` that aren't a list, a rule that isn't an object (`null`, a hole in the list), `methods` that aren't a list,
    or a value that JSON can't write (a bigint, a circular object) can throw. The cold-start check catches that: it logs
    `[config] the config check failed, continuing: …` and the Worker starts. During a request it fails open: the
    request is forwarded without `x-cheq-rti-result`.
  - `methods: 'POST'` as a string, not a list, is matched as a substring.
- A `Referer` on another site is never used: the visitor goes to the home page instead. Sending them back to another
  site would turn the CAPTCHA into an open redirect.

#### logErrors

`logErrors` defaults to `true`; only an explicit `false` turns it off. When it is on, the errors the handler catches
(the three log lines in [How a request is handled](#how-a-request-is-handled)) and the warning about a stand-in `rayId`
(see [Challenge callbacks](#challenge-callbacks)) also go to the RTI logger, through `waitUntil`, so the visitor's
answer does not wait for it. `false` stops sending them; they are still written to the console. A failing
`config.originalReferer`, and the Turnstile example's own `[turnstile]` and `[validateChallenge]` lines, only ever go to
the console.

### Challenge callbacks

`config.ts` has four optional callbacks for a CAPTCHA, or any other challenge. The shipped config takes all four from
the Turnstile example (see [Turnstile CAPTCHA](#turnstile-captcha)).

```ts
challenge?: (request: Request, response: RTIResponse, addRtiResultHeader?: (headers: Headers) => void) => Promise<Response | Request>;
validateChallenge?: (request: Request, isDebug: boolean | undefined) => Promise<boolean>;
isChallengeResponse?: (request: Request) => boolean;            // only a synchronous true counts
originalReferer?: (request: Request) => string | undefined | Promise<string | undefined>;
```

`validateChallenge`, `isChallengeResponse` and `originalReferer` get the copy of the request that is forwarded (see
[How a request is handled](#how-a-request-is-handled)), body included. They must read only the URL and the headers
(read the body from `request.clone()` if needed): a callback that reads the body itself leaves nothing to forward.

**`challenge(request, response, addRtiResultHeader?)`**

- **When:** the strategy is `CAPTCHA` (a CHALLENGE by default, see `challengingStrategy`; a BLOCK with
  `blockingStrategy: CAPTCHA`; a request with a body with `actionOnSuspicious` CHALLENGE) and `validateChallenge` does
  not report a valid session. In `BLOCKING` mode also for every reply that `isChallengeResponse` recognizes, when the
  strategy is none (ALLOW) or `CAPTCHA`, with or without a session, and when RTI is down (below).
- **Gets:** the copy that is forwarded. For a challenged request with a body, a `GET` without the body for the page it
  came from.
- **Returns:** a `Response`, sent to the visitor as it is, or a `Request`, forwarded as it is. A returned request carries
  `x-cheq-rti-result` only if you call `addRtiResultHeader(request.headers)` first. What it returns is not checked at
  run time: TypeScript rejects a `challenge` that can return anything else.
- **`addRtiResultHeader`** sets `x-cheq-rti-result` (this request's verdict) on the `Headers` you pass it. Call it on
  what should carry the verdict; the example calls it only on the 302 after a solved CAPTCHA. It is not passed when RTI
  is down.
- **A throw** (or a rejected promise) is logged as `Challenge error handling request '<id>'`, and the request is
  forwarded without the verdict. For a reply to the challenge page, that means the origin gets the token and the form
  fields in place of the visitor's query string: answer your own errors on a reply (the example never throws on one).
- **The body:** a `challenge` that reads the request body should read it from `request.clone()`. A consumed body cannot
  be forwarded if the challenge then fails.

**RTI down.** When a recognized reply cannot be evaluated (an RTI error or timeout, a malformed RTI response, or any
other error before the decision), `challenge` is still called, without `addRtiResultHeader` and with a stand-in
`response` that is **not an RTI answer**: only `ids` exists. There is no `decision`, `classification` or anything else.

- `ids.rayId` is the `cf-ray` value when it is 1 to 200 of `A-Z a-z 0-9 _ = . -`. Otherwise (missing, empty, too long,
  other characters) it is a random `cf-fallback-<uuid>`, and both values are logged: `console.warn`
  `[challenge] RTI failed and the Cloudflare request id "…" is not usable as the stand-in rayId, using cf-fallback-…`,
  and the RTI logger unless `logErrors` is `false`.
- `ids.customParam2` is the `cf-ray` value, or `null` without one. Every other id is `null`.
- **Why `ids.rayId` is set:** `challenge` needs a non-empty, unique id. The example signs the `_cq_se` session with it
  and stores it in the cookie. It is never compared with RTI. It is never taken from `request_id` in the query: the
  client controls that value, and it would end up in `Set-Cookie`.
- **It is not an RTI ray id.** Do not log or report it as one, and check any other field before reading it.

**`validateChallenge(request, isDebug)`**

- **When:** only when the strategy is `CAPTCHA` and `challenge` is set, and never for a reply that
  `isChallengeResponse` recognizes (in `BLOCKING` mode that reply goes to `challenge` first).
- **Returns** `true` when the visitor already solved the challenge (a valid session): the CAPTCHA is waived and the
  request is forwarded with `x-cheq-rti-result`, the real verdict. It does **not** skip RTI. Only `CAPTCHA` is waived:
  `ACCESS_DENIED`, `NOT_FOUND` and `REDIRECT` are always enforced. With `blockingStrategy: CAPTCHA`, a valid session
  also waives blocked traffic.
- **A throw** is logged as `Challenge error handling request '<id>'`, and the request is forwarded without the verdict.

**`isChallengeResponse(request)`**

- Recognizes the reply to the challenge page. The Turnstile example looks for `cf-turnstile-response` in the query.
- **When:** in `BLOCKING` mode, with `challenge` set, when the strategy is none (ALLOW) or `CAPTCHA`, and when RTI is
  down. Not called in `MONITORING` mode, without `challenge`, or when the request is blocked, 404'd or redirected
  anyway.
- Only a synchronous `true` counts: any other value, a `Promise` included, means no reply.
- **A throw:** the request is handled as no reply, and the error is logged as
  `Challenge reply check error handling request '<id>'`.
- **Not set while `challenge` is:** replies are not recognized, and one warning is logged per cold start:
  `[challenge] config.isChallengeResponse is not set: replies to the challenge page are not recognized (see "Challenge
  callbacks" in the README)`. In `BLOCKING` mode a reply that RTI allows then reaches the origin with the form fields.

**`originalReferer(request)`**

- **When:** on every request, ignored paths included, before RTI.
- **Returns** where the visitor came from before a CAPTCHA they just solved, or `undefined`. It may return a promise of
  either, which is awaited. The Turnstile example's does: signing is asynchronous in a Worker.
- The value becomes the `x-cheq-original-referer` request header, so RTI and the origin get it. A copy sent by the
  client is always removed first.
- **A throw or a rejection:** the request goes on without the header, and
  `[challenge] originalReferer failed, forwarding without x-cheq-original-referer: <message>` is written to the console
  (not to the RTI logger). A value a header cannot hold (a line break inside it) counts as an error.
- The Turnstile example returns it only with `originalRefererVia: "header"` (the default).

### Local or demo origin

`forwardToOrigin` in [`src/index.ts`](src/index.ts) is the only place that calls the origin, and it holds the switch
between a production and a local or demo origin, in one place:

- **OPTION 2, production (shipped):** the Worker is attached to your domain by a route in `wrangler.toml` (or in the
  dashboard), so the request already targets your origin and is passed through as it is.
- **OPTION 1, local or demo:** every forwarded request goes to one fixed origin (e.g. an S3 static site), and the
  Worker's URL becomes the public entry point. Uncomment it, set your origin URL, and comment out OPTION 2. Its second
  variant also copies `x-cheq-rti-result` into the response, so the browser shows the verdict: for demos and debugging
  only.

Every request that is forwarded goes through this function (allowed traffic, ignored paths, every error path of
`handle`), so the one switch covers them all. Our own answers (block pages, redirects, the CAPTCHA page) never reach
it.
`forwardToOrigin` is outside `handle`'s error handling: a failing origin is not logged as our error and not called a
second time by this Worker. Cloudflare's pass-through still applies, and may send the request to the origin again, with
the headers the client sent and possibly without its body (see the next section).

### What the Worker cannot clean

The Worker removes a client-sent `x-cheq-rti-result` and `x-cheq-original-referer` from the request it forwards. It
cannot do that when the Worker itself fails: an exception it does not catch, or an origin call that fails (`fetch`
throws in `forwardToOrigin`). Then `passThroughOnException()` makes Cloudflare send the visitor's original request to
the origin, with the headers the client sent. That request still has any `x-cheq-rti-result` or
`x-cheq-original-referer` the client sent, and the Worker cannot change it.

Its body may be missing. The Worker moves the body into the copy it forwards, and Cloudflare's documentation
([Context (ctx)](https://developers.cloudflare.com/workers/runtime-apis/context/)) says: "If the origin `fetch()`
throws after consuming the request body, the fallback request may reach your origin without the original body and fail
with an unrelated `4xx` error." So a `POST` whose origin call fails can reach the origin empty (documented, not seen
here: `wrangler dev` 4.56.0 answers every exception with its own 500 instead of passing the request through).

If your origin acts on these headers, remove both from every incoming request with a Cloudflare **Request Header
Transform Rule** (in the dashboard, under **Rules**). These rules run before the Worker: Cloudflare's documentation of
[Request Header Transform Rules](https://developers.cloudflare.com/rules/transform/request-header-modification/) notes
that when such a rule removes `x-forwarded-for`, the header is absent in a Worker that handles the request. The Worker
sets its own `x-cheq-rti-result` and `x-cheq-original-referer` later, on the copy it forwards.

- **When incoming requests match:** the custom filter expression `(cf.worker.upstream_zone != "example.com")`, with
  your zone's name in place of `example.com`.
- **Then:** remove `x-cheq-rti-result`, and remove `x-cheq-original-referer`.

The filter leaves out the request the Worker itself sends to the origin. Cloudflare's rules can see such a same-zone
Workers subrequest (its rate limiting documentation says so), and whether a Request Header Transform Rule runs on it is
not documented: without the filter, the rule could remove the verdict the Worker just set. A visitor's request always
matches: [`cf.worker.upstream_zone`](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/cf.worker.upstream_zone/)
is empty for a request that does not come from a Worker. After adding the rule, check once on a test zone that an
allowed request still reaches the origin with `x-cheq-rti-result`.

**Spellings with underscores.** The Worker removes these two names only as written, with hyphens. A header the client
spells with underscores (`x_cheq_rti_result`, `x_cheq_original_referer`) is another header to the Worker, and it is
forwarded as the client sent it. That matters only for an origin that treats `-` and `_` in header names as the same,
as CGI does (by RFC 3875's rule both spellings become `HTTP_X_CHEQ_RTI_RESULT`): such an origin should drop the
underscore spellings itself.

### Turnstile CAPTCHA

> **Upgrading from an earlier version:**
>
> - **The Turnstile keys moved.** They used to be constants in `src/turnstile-challenge-example.ts`. They are now in
>   `turnstileConfig` in `src/config.ts`, together with a new `sessionSigningSecret`: set all three there. Until all
>   three are set, the CAPTCHA is off, and challenged traffic is forwarded with `x-cheq-rti-result`. The old exports
>   `turnstileChallengeExample` and `turnstileValidateChallengeExample` are gone: a `config.ts` that imports them no
>   longer builds. Build the callbacks with `createTurnstileChallenge(turnstileConfig)` and set `challenge`,
>   `validateChallenge`, `isChallengeResponse` and `originalReferer` from what it returns, as the shipped
>   `src/config.ts` does.
> - **Old sessions stop working once.** Sessions issued by the old version fail validation: those visitors are
>   challenged once more. Nothing to do.
> - **Only `GET` and `HEAD` are challenged in place.** The old version showed the CAPTCHA page to every method. Now a
>   `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS` with a CAPTCHA verdict follows `actionOnSuspicious`, which ships with
>   `Action.ALLOW` for all five: the request is forwarded to the origin with `x-cheq-rti-result`. Any other method is
>   forwarded too. If a login or checkout form should keep its CAPTCHA (or be blocked), add a rule for its path (see
>   [actionOnSuspicious](#actiononsuspicious)). With `blockingStrategy: CAPTCHA` that includes a request RTI wants
>   blocked (the old version showed it the CAPTCHA page): set `Action.BLOCK` or `Action.CHALLENGE` to stop it.
> - **A valid session no longer skips RTI.** The old version checked `_cq_se` before calling RTI and forwarded a visitor
>   with a valid session without an RTI call and without `x-cheq-rti-result`. Now every request that `ignorePaths` does
>   not exclude is checked by RTI, and the session only waives the `CAPTCHA` strategy: `ACCESS_DENIED`, `NOT_FOUND` and
>   `REDIRECT` are enforced. Nothing to change, but expect one RTI call per request of such a visitor (it waits up to
>   `timeout`, 500 ms as shipped), and `x-cheq-rti-result` on those requests at the origin.
> - **The error log lines changed.** In the RTI logger, the old `error: <message>` and `challenge error: <message>` are
>   now `Error handling request '<id>': <message>` and `Challenge error handling request '<id>': <message>`, and
>   `Challenge reply check error handling request '<id>': <message>` is new (`<id>` is the `cf-ray` value or
>   `unknown_request_id`). On the console, `error` and `challenge error` are now `Error handling request '<id>':` and
>   `Challenge error handling request '<id>':`, each followed by the error. The debug lines `request payload: …`,
>   `rtiResponse: …` and `action: <n>` are now `RTI Request payload: …`, `RTI Response: …` and
>   `action upon response: <NAME> (<n>)`. Update alerts and log searches built on the old text.
> - **A custom challenge's reply must be recognized by `isChallengeResponse`.** The old version passed a request to
>   `config.challenge` only when RTI asked for a CAPTCHA, so the example's page could reply with a `POST` form. Now, in
>   `BLOCKING` mode, a request that `isChallengeResponse` recognizes goes to `config.challenge` whatever its verdict and
>   session, unless it is blocked, 404'd or redirected. Only a synchronous `true` counts, and it must read only the URL
>   and the headers, so it cannot see a token in a form body: a `POST` reply that it does not recognize is handled like
>   any `POST` (forwarded, as shipped). If you wrote your own challenge, set `isChallengeResponse`, and make the reply
>   recognizable by its URL or headers, e.g. a `GET` form with the token in the query, as the example does. The shipped
>   example needs nothing.
> - **The 302 after a solved CAPTCHA carries `x-cheq-rti-result`**, so the browser (and a bot) can read the verdict,
>   threat-type code and ids. Nothing to do (see [How the challenge flow works](#how-the-challenge-flow-works)).
> - **The session is bound to the visitor's IP and User-Agent** (header sessions too): after a change, the visitor is
>   asked again if RTI asks for a CAPTCHA ([Session binding](#session-binding)).
> - **The redirect after a solve goes to `https://`** (default port for an http request; a local run keeps http), not to
>   the scheme, host and port in the form ([A visitor on plain http](#a-visitor-on-plain-http)).
> - **It stays on this site:** the request's own host, and `original_url` must be a path; the old version went to any
>   URL in the form ([How the challenge flow works](#how-the-challenge-flow-works)).
> - **The challenge form is a `GET`** (it was a `POST`): the token is in the reply's URL, so in browser history, URL
>   logs and the RTI payload's `requestUrl` ([Token checks](#token-checks)).
> - **A token must be solved on this host and on the CHEQ widget**, so Cloudflare's test keys no longer pass
>   ([Token checks](#token-checks)).
> - **A site's own `GET` form with a Turnstile widget is taken for a reply** (`BLOCKING`, CAPTCHA on) and does not reach
>   the origin: use `ignorePaths` ([The reply to the challenge page](#the-reply-to-the-challenge-page)).
> - **A client's own `x-cheq-rti-result` and `x-cheq-original-referer` are removed**, except on Cloudflare's
>   pass-through ([What the Worker cannot clean](#what-the-worker-cannot-clean)).
> - **New: `x-cheq-original-referer` and the `_cq_rf` cookie** (`_cq_ref` with `originalRefererVia: "cookie"`) carry
>   where the visitor came from through the CAPTCHA ([The original Referer](#the-original-referer)).
> - **`Cache-Control: no-store, no-cache, must-revalidate`** is now on the block pages, the redirect to
>   `redirectLocation` and the CAPTCHA's 302s, not only on the CAPTCHA page
>   ([How a request is handled](#how-a-request-is-handled)).
> - **siteverify: a 1.5 s timeout, a retry page, and a 60 s pause after 3 errors in a row** (as shipped); before, no
>   time limit, and an error was logged as a challenge error ([Siteverify pause](#siteverify-pause)).
> - **A failed origin call is not logged or called again by the Worker** (the old one logged `error: <message>` and
>   fetched again); Cloudflare's pass-through may send it again ([Local or demo origin](#local-or-demo-origin)).
> - **The OPTION 1 / OPTION 2 switch is now in `forwardToOrigin`**: redo a local or demo edit of the old `index.ts`
>   there ([Local or demo origin](#local-or-demo-origin)).

The CAPTCHA is an example, using [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/). Replace it with
any implementation you want (see [Implementing a custom challenge](#implementing-a-custom-challenge)).
[`src/turnstile-challenge-example.ts`](src/turnstile-challenge-example.ts) is a fully functional reference
implementation. It is a port of CloudFront's example: the same settings, pages, cookies and rules, on the Worker's own
APIs (Web Crypto and `fetch`).

#### Setup

The settings live in the `turnstileConfig` block at the top of [`src/config.ts`](src/config.ts). Replace three values:

| Setting | Where it comes from |
|---------|---------------------|
| `siteKey` | Turnstile dashboard → site key (rendered in the challenge page) |
| `secretKey` | Turnstile dashboard → secret key (sent to Cloudflare's `siteverify`) |
| `sessionSigningSecret` | A random string of at least 32 bytes: run `openssl rand -hex 32`, which prints 64 hex characters (generate your own; never reuse one from an example). Shorter or guessable values work but can be brute-forced, which lets anyone forge sessions. It signs the `_cq_se` session cookie and the `_cq_rf` Referer cookie. **Not the Turnstile secret.** Changing it ends every open session (visitors are challenged again). |

`config.ts` passes them to `createTurnstileChallenge(turnstileConfig)`, which returns `challenge`, `validateChallenge`,
`isChallengeResponse` and `originalReferer` (the last one only with `originalRefererVia: "header"`). Until all three
secrets are set (not empty, not `REPLACE_ME`) it returns none of them and logs a warning once per cold start: the
CAPTCHA is off, and challenged traffic is forwarded to the origin with `x-cheq-rti-result`. Settings it cannot read at
all turn the CAPTCHA off too, with a warning: it never throws while the module loads.

`sessionTtlSeconds` (default 300) sets how long a solved challenge is remembered. It must be a positive whole number of
seconds, at most 34,560,000 (400 days, the most browsers keep a cookie); any other value (0, negative, fractional, a
string, or more than 400 days) logs a warning and 300 is used.

`allowedHostnames` (optional, e.g. `["example.com"]`): without it, a solved CAPTCHA is accepted only if Cloudflare says
it was solved on the request's own host. Set it when the site answers on several host names and a token solved on one
must count on another. Then a token is accepted only if it was solved on one of the listed hosts or a subdomain of one.
Write each entry as a plain host name: `example.com` also covers `www.example.com` and `shop.eu.example.com`, but not
look-alikes such as `evilexample.com` or `example.com.evil.net`. An entry like `*.example.com` or `.example.com` never
matches anything: when no other entry matches, the solved CAPTCHA is rejected. List only domains whose every
subdomain you trust: a subdomain that serves other people's content would count too. Case and a `:port` are ignored.
A list with an entry that is not a string, or is empty once a scheme, port and path are removed (such as `""` or
`"https://"`), is ignored as a whole, with a warning, and the request's own host is checked instead.

`originalRefererVia` (default `"header"`): how the page the visitor came from before the CAPTCHA reaches the site, in
the `x-cheq-original-referer` request header (`"header"`) or the `_cq_ref` cookie for the site's scripts (`"cookie"`);
see [The original Referer](#the-original-referer). Any other value logs a warning and `"header"` is used.

`sessionBinding` (default `{ ip: "exact", userAgent: true }`) binds the session to the client that solved the
challenge, so a copied cookie does not work elsewhere; see [Session binding](#session-binding). `ip` is `"exact"` or
`"none"`, `userAgent` is `true` or `false`; any other value logs a warning and the default is used.

`siteverifyErrorsToPause` (default 3) and `siteverifyPauseSeconds` (default 60): when Cloudflare's siteverify fails that
many times in a row (timeout, network error, 5xx or a body that is not JSON), the CAPTCHA is paused for that many
seconds and challenged traffic is forwarded with `x-cheq-rti-result`. Any other error while answering a solved CAPTCHA
(a bug or an unexpected input, e.g. while signing the session) counts the same way, so a step that always fails can't
keep visitors on the CAPTCHA. A reply that siteverify answers with a 2xx, and that is then answered without an error
(a passed or a rejected token), resets the count. A 4xx (e.g. a 429 rate limit) neither counts nor resets it: it is
shown as a failed check, so flooding junk tokens can't switch the CAPTCHA off. A token longer than 2048 characters is
not sent to siteverify and leaves the count as it is.
`siteverifyErrorsToPause: 0` turns the pause off: during a Cloudflare outage visitors get the CAPTCHA again and again,
but it is never skipped. `siteverifyErrorsToPause` must be a whole number from 0, `siteverifyPauseSeconds` from 1; any
other value logs a warning and the default is used.

**The site must answer on HTTPS.** After a solved CAPTCHA the visitor is sent to the request's own host over https (an
https request keeps its port; a request that came over http goes to the default port). Only a local run on
`localhost`, `127.0.0.1` or `[::1]` keeps http and its port. The session cookie is `Secure`, so a browser drops it from
an answer sent over plain http: a visitor who came over http solves the CAPTCHA, is sent to https, and is asked once
more there if RTI asks for a CAPTCHA again. [A visitor on plain http](#a-visitor-on-plain-http) says what else follows
from it, and what to do about it.

#### Siteverify pause

What to do when siteverify is down is set by `siteverifyErrorsToPause`:

| Value | Behavior |
|---|---|
| 1 or more (fail open) | The CAPTCHA is skipped after that many errors in a row, for `siteverifyPauseSeconds`. 1 skips it right away; the default 3 lets visitors retry first. |
| 0 (fail closed) | The CAPTCHA is never skipped: visitors get it again, with "We couldn't verify you right now. Please try again.", until Cloudflare is back. |

**The count is per isolate, not for the whole site.** Cloudflare runs the Worker in many isolates (in its data centers
around the world, often several in one), and they share no memory. Each one counts its own siteverify errors and
pauses on its own. One isolate serves several requests at once, so a reply that was already waiting for siteverify when
the pause started still records its answer when it comes back: a success ends the pause. Cloudflare can drop an isolate
at any moment (after a deploy, or to free resources); a new one starts at 0 errors, not paused.

What visitors see during a siteverify outage:

1. The first visitors on each isolate solve the CAPTCHA and get it again, with "We couldn't verify you right now.
   Please try again." (not "Verification failed": it isn't their fault).
2. The error that reaches the limit (3 by default) pauses that isolate: that visitor is sent back to the page and
   passes, and so do its other challenged visitors during the pause, with `x-cheq-rti-result`. With `1` this is the
   first error.
3. In a real outage every busy isolate reaches 3 within seconds. Until then it is mixed: one request may pass on a
   paused isolate and the next get the CAPTCHA on another.
4. After `siteverifyPauseSeconds` each isolate tries siteverify again; if it still fails, it pauses again after 3
   errors, or fewer: a reply that was already waiting for siteverify when the pause started, and comes back with an
   error during the pause, counts toward the next one.

This is the usual way a "stop calling a failing service" switch works in serverless code. Sharing the count would need
a store such as KV, read on every challenged request, with its own latency, cost and failure modes. That is not worth it
for an outage that lasts minutes.

**Known limit:** if Turnstile itself fails while the Worker runs (`challenges.cloudflare.com` does not answer, or the
widget cannot load or produce a token), the visitor cannot solve the CAPTCHA: the **Continue to Website** button stays
disabled, no reply is sent, siteverify is never called and the pause never starts. Visitors with a CAPTCHA verdict stay
on the challenge page until Turnstile is back; a visitor with a valid session still passes. This is the same for any
CAPTCHA vendor outage. A fallback would have to trust the browser ("the widget failed"), which a bot can fake.

#### How the challenge flow works

```
Request arrives → strategy is CAPTCHA (CHALLENGE by default, or BLOCK with blockingStrategy: CAPTCHA)
                and there is no valid session → config.challenge() called
                    (in BLOCKING mode also for every reply, see The reply to the challenge page)
        │
        ▼
 Does the request have a `cf-turnstile-response` query parameter?
        │
   NO ──┤──► Return HTTP 403 with CAPTCHA challenge page
        │       (Turnstile widget + hidden form; `original_url` holds the path and query string,
        │        `original_referer` where the visitor came from, see The original Referer)
        │       User solves the CAPTCHA
        │       Turnstile widget injects hidden `cf-turnstile-response` input into the form
        │       Form (no action) submits (GET) to the page's own URL: the query becomes original_url,
        │       request_id and cf-turnstile-response (the visitor's own query travels inside
        │       original_url; the page's script adds the #fragment, which never reaches the server)
        │
   YES ──► POST token to Cloudflare siteverify API (server-side, 1.5 s timeout,
               │                                   remoteip from CF-Connecting-IP)
               │
          siteverify error ──► 403 with the widget again and "We couldn't verify you right now".
          (timeout, network,      Enough errors in a row pause the CAPTCHA (siteverifyErrorsToPause /
           5xx, not JSON,         siteverifyPauseSeconds): then a 302 back to original_url, no session.
           or any error           Never thrown, so the token never reaches the origin.
           answering it)
               │
          Verification fails ──► Return 403 with the widget again and "Verification failed. Please try again."
          (or hostname / action
           do not match: Token checks)
               │
          Verification passes
               │
               ▼
          Generate signed session token, bound to this client (IP + User-Agent, see Session binding):
          "{expiresAt}.{HMAC-SHA256(sessionSigningSecret, ["se", expiresAt, rayId, bindingKey])[0:32 hex]}"
               │
               ▼
          Return HTTP 302 redirect to original URL
          (https:// + the request's own host, http only on a local run, never from the query string; original_url must be a
           same-site path, or the request's own path plus ?query / #fragment (kept even
           for a path like //page), otherwise the request's own path)
          Set-Cookie: _cq_se={token}|{rayId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300
          Set-Cookie: _cq_rf={signed original Referer}; Path={landing path}; HttpOnly; Secure; SameSite=Lax; Max-Age=60
          (only with an original_referer; with originalRefererVia: "cookie" instead
           _cq_ref={return URL}|{Referer}; Path=/; Secure; SameSite=Lax; Max-Age=60; see The original Referer)
          Cache-Control: no-store, no-cache, must-revalidate
          x-cheq-rti-result: version=…;verdict=…;threat-type-code=…;ids={…}
```

The `Location` is built through the URL parser, so it is always a value a header can hold, and its host is always the
request's own.

> **The 302 carries `x-cheq-rti-result`.** The example adds it with the `addRtiResultHeader` function the handler passes
> to `challenge`. It is a response to the **browser**, not the origin, so the client (bots included) can read the
> verdict, threat-type code and ids. The redirected request goes through RTI again and gets its own header on the way to
> the origin.

> **Why `SameSite=Lax` and not `Strict`:** visitors who arrive from another site (a link, an ad, a redirect) make a
> cross-site top-level navigation. With `Strict` the browser does not send `_cq_se` on that request, so the challenge
> validation sees no session and the visitor is challenged again every time they come in from outside. `Lax` sends the
> cookie on top-level `GET` navigations while still withholding it from cross-site subrequests (iframes, images,
> `fetch`) and cross-site `POST`s. Keep `Lax` if you copy or adapt the challenge example.

On subsequent requests RTI always runs. `config.validateChallenge` is called only when RTI asks for a CAPTCHA again
(and the request is not a reply that `isChallengeResponse` recognizes, which goes to `config.challenge` instead):

```
Read _cq_se from the Cookie header → parse _cq_se as {token}|{rayId}
  (an x-cheq-challenge / x-cheq-ray-id request header, if present, overrides the token / rayId)
     │
     ▼
Split token → {expiresAt}.{signature}
     │
     ├── not exactly two parts, or expiresAt not spelled as issued → return false (challenged again)
     │     (see Session cookie format)
     │
     ├── expired? (Date.now() > expiresAt) → return false (challenged again)
     │
     └── Recompute HMAC(sessionSigningSecret, ["se", expiresAt, rayId, bindingKey]), constant-time compare,
         with bindingKey from THIS request's IP and User-Agent (see Session binding)
              │
         Matches? → return true (CAPTCHA waived: forwarded with x-cheq-rti-result, real verdict)
         No match? → return false (challenged again: forged, tampered, or another client)
```

A valid session waives only the `CAPTCHA` strategy (with `blockingStrategy: CAPTCHA` that includes blocked traffic). An
`ACCESS_DENIED`, `NOT_FOUND` or `REDIRECT` response is enforced as usual, and a benign verdict is forwarded with the
header without checking the cookie (unless it is a reply to the challenge page). The session expiry is fixed (not
extended on later requests). While the CAPTCHA is paused, `validateChallenge` waives it without checking the cookie.

> **Cost:** a request with a valid session makes an RTI call too. Checking the signature itself is one HMAC.

#### Token checks

siteverify's `success` only says a token is genuine for the site key. The example accepts a token only when siteverify
also reports that it was solved **on this host** (`hostname` equals the host of the request's URL, or with
`allowedHostnames` one of those hosts or a subdomain of one; both sides are compared in lowercase, without a `:port`,
and without a scheme, userinfo, path or trailing dot should either ever carry one) and **on the CHEQ widget** (`action`
is `cheq-challenge`, set by `data-action` on the challenge page). That stops a token solved on another site that shares
the site key, or on another Turnstile widget of this site (the customer's own login or newsletter form), from buying a
CHEQ session. A rejected token gets the usual "Verification failed" response, and when the token was genuine the cause
is logged (`console.warn`, never the token): `[turnstile] token valid but hostname 'x' ≠ request host 'y' (if the site
answers on several host names, set allowedHostnames)`, `... is not in allowedHostnames or a subdomain of one (...)`, or
`... action '' ≠ 'cheq-challenge' (is data-action missing from the challenge page?)`.

- **Do not remove `data-action="cheq-challenge"`** from the challenge page (or change `CHALLENGE_ACTION` on one side
  only). Without it every token is rejected, and visitors loop on the CAPTCHA. An empty or missing action is never
  accepted as a fallback: the site's other widgets usually have none, so that would let exactly those tokens through.
- **Do not give the challenge form an `action` built from the request URL.** The example leaves `action` out, so the
  browser submits to the page's own URL. A path like `//evil.com/` in an `action` is a link to another site, and the
  solved form (and its token) would go there. To keep a `#fragment`, which never reaches the server, add
  `location.hash` to `original_url` on submit, as the example does.
- **Test keys:** Cloudflare's test secret keys answer with `hostname: "example.com"` and no `action` (see their
  [testing docs](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)). The action check rejects every
  test token, and the log shows
  `[turnstile] token valid but action '' ≠ 'cheq-challenge' (is data-action missing from the challenge page?)`, whose
  hint does not apply here. The hostname check rejects it too, with its own warning, unless `allowedHostnames` covers
  `example.com`, or, without `allowedHostnames`, the request's host is `example.com`. Use real keys to test the whole
  flow end to end.
- **The token stays in the URL.** The challenge form submits with `GET`, so `cf-turnstile-response` appears in the
  query string (browser history, and any log that records URLs). That is a known, low-risk limitation: a token is
  single-use and expires within minutes.
- A token longer than 2048 characters (the most Turnstile issues) is not sent to siteverify: the widget is shown again
  with "Verification failed", and it does not count toward the pause.

#### The reply to the challenge page

The solved form is a new request, so RTI gives it a new verdict. When that verdict is no longer a CAPTCHA (e.g.
`ALLOW`), or a valid `_cq_se` session would waive it (two tabs, Back, refresh), forwarding it would send the origin
`?original_url=…&request_id=…&cf-turnstile-response=…` instead of the visitor's query string, without setting a
session. So in `BLOCKING` mode the handler passes every reply to `config.challenge`, which answers it (the Turnstile
example verifies the token and redirects to `original_url`):

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
                         Failed (used, expired or forged token, or one solved on another site or widget:
                                 see Token checks) → 403 with the widget again and an error message
                         siteverify error, or any error answering it → 403 with the widget again, or once the
                                 CAPTCHA is paused, 302 to original_url, no session
```

- **The challenge recognizes its own reply.** `config.isChallengeResponse` comes with the challenge (the Turnstile
  example returns it from `createTurnstileChallenge`), so the handler knows nothing about any CAPTCHA's field names.
- **Field name only.** The Turnstile example's `isChallengeResponse` looks only for the Turnstile field name. A site's
  own `GET` form with a Turnstile widget therefore looks like a reply too, and in `BLOCKING` mode its submission never
  reaches the origin. `config.challenge` sends its token to siteverify, and the token check rejects it: a token from
  another site key fails siteverify, and one from the same site key fails the action check. The visitor gets the CHEQ
  challenge page (403) with "Verification failed. Please try again.", and solving it takes them to the path the form
  was sent to, without the form's fields. Exclude such pages with `ignorePaths`.
- **Customer code, handled defensively.** Only a synchronous `true` counts (an `async` detector's `Promise` means no
  reply). If it throws, the request is handled as no reply (the usual flow) and the error is logged, also when RTI is
  down. Without `isChallengeResponse` replies are not recognized, and a warning is logged once per cold start.
- **RTI down.** When a recognized reply cannot be evaluated, it still goes to `config.challenge`, without
  `addRtiResultHeader` and with a stand-in `response` that has only `ids`: `ids.rayId` is the `cf-ray` value or a random
  `cf-fallback-<uuid>` (see [Challenge callbacks](#challenge-callbacks)). The example signs the session with it, so the
  session works like any other: the visitor proved they are human to Cloudflare, only the RTI verdict is missing.
  **Cost:** while RTI is failing, each reply makes a siteverify call that a plain fail-open forward would not.
- It never lengthens a session or skips RTI: a new `_cq_se` still needs a token that Cloudflare verifies, and the
  redirected request is checked by RTI again. `MONITORING` mode forwards replies unchanged, like everything else.
- **The example never throws on a reply.** A siteverify error, or any other error answering the reply (a bug or an
  unexpected input, e.g. while signing the session), gets the widget again with "We couldn't verify you right now", and
  counts toward the pause (see [Siteverify pause](#siteverify-pause)). Once paused: a 302 back to `original_url` without
  a session, where the CAPTCHA is waived. Either way the token never reaches the origin, and the visitor's own query
  string comes back with `original_url`. If a custom `config.challenge` throws, the reply is forwarded (fail open): the
  origin gets `?original_url=…&request_id=…&cf-turnstile-response=…` instead of the visitor's query string, so a custom
  challenge should answer its own errors the same way.
- **A very long page URL.** The reply's own URL is the page's path, followed by the page's path and query again
  (URL-encoded in `original_url`, so longer than they were), `request_id`, the original Referer and the token (up to
  2048 characters). Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) page lists
  a URL size of 16 KB. So a page URL of several KB can make the reply longer than that, and that visitor can't pass the
  CAPTCHA. Not tested at Cloudflare's edge; a local run (`wrangler dev` 4.56.0) accepted reply URLs of 22,651
  characters.

#### Session cookie format

```
_cq_se={expiresAtMs}.{hexSignature}|{rayId}
```

- `expiresAtMs`: Unix timestamp in milliseconds (TTL default: 300 seconds)
- **Only the exact form issued is accepted.** The token must be exactly two parts (`{expiresAtMs}.{hexSignature}`, so
  `….junk` is rejected), and `expiresAtMs` must read back as itself: `String(Number(x)) === x` for a safe integer.
  Leading zeros, spaces, `+`, exponents, hex or trailing letters are rejected before the signature is checked, even
  when they would name the same number.
- `hexSignature`: the first 32 hex characters of HMAC-SHA256 (Web Crypto) keyed with `sessionSigningSecret` over the
  JSON array `["se", expiresAtMs, rayId, bindingKey]`, where `bindingKey` is `JSON.stringify([ip, userAgent])` of the
  client (see [Session binding](#session-binding)). The same inputs give the same signature as on CloudFront. Without
  the secret nobody can make a valid cookie. Cookies issued by the earlier Cloudflare example (the unkeyed SHA-256 of
  `{expiresAtMs}:{rayId}`) fail validation, so those visitors are challenged once more after the upgrade.
- **The cookie carries no IP and no User-Agent.** `bindingKey` is only part of the HMAC input; validation recomputes it
  from the request.
- **Not bound to `_cq_duid`:** on a first visit the challenge is solved before the CHEQ tag has set `_cq_duid`, so a
  session bound to it stopped working as soon as the cookie appeared and the visitor had to solve the CAPTCHA twice. The
  IP and User-Agent are there from the first request, so the session is bound to those instead.
- `rayId`: the RTI ray ID of the request that was answered with the session, i.e. the reply to the challenge page (not
  the request that showed the page). When RTI was down, the `cf-ray` value or a random `cf-fallback-<uuid>` (see
  **RTI down** in [Challenge callbacks](#challenge-callbacks)).

#### Session binding

A `_cq_se` session works only from the client that solved the challenge, like Cloudflare's `cf_clearance`, which is
tied to the visitor and device. Without a binding, a copied cookie would work from any client until it expired. It is
bound to:

- **The User-Agent, exactly** (several `User-Agent` headers arrive joined). Another browser, or the same browser after
  an update that changes its User-Agent, needs a new CAPTCHA.
- **The client IP, exactly**, from the `CF-Connecting-IP` header. An IPv6 address is first written the way the URL
  parser writes it (`2001:0DB8:0:0:0:0:0:1` → `2001:db8::1`), so every spelling of it is the same client, and an
  IPv4-mapped one in hex (`::ffff:1.2.3.4` → `::ffff:102:304`). An IPv4-mapped IPv6 address is another client than the
  IPv4 address itself (`::ffff:203.0.113.7` is not `203.0.113.7`). Without `CF-Connecting-IP` the IP part is `null`:
  such a session matches only requests that have no `CF-Connecting-IP` either.

```ts
sessionBinding: { ip: "exact", userAgent: true }, // in turnstileConfig, config.ts (the default)
```

| `ip` | Bound to | A new CAPTCHA when |
|------|----------|--------------------|
| `"exact"` (default) | the address | the address changes at all |
| `"none"` | nothing | never because of the IP |

`userAgent: false` stops binding the User-Agent. With `{ ip: "none", userAgent: false }` a session works from any
client.

**Visitors whose address changes** are challenged again each time it does: IPv6 privacy addresses that rotate,
carrier-grade NAT, corporate proxies, VPNs and iCloud Private Relay that hand out a different address from a pool,
Wi-Fi ↔ cellular, and dual-stack (IPv4 on one connection, IPv6 on the next). If that traffic matters, use `ip: "none"`
(the session is then bound by User-Agent only).

**A mismatch is never a block:** `validateChallenge` returns `false`, so RTI's CAPTCHA strategy shows the widget
again, and the visitor gets a new session for their new address or browser once they solve it.

**Never stored.** The IP and User-Agent are only inside the HMAC input (`bindingKey`, see
[Session cookie format](#session-cookie-format)), and validation recomputes `bindingKey` from the request. The debug
log of a failed check says
`signature match: false (session binding mismatch (ip or user-agent), or a forged or tampered session)`: it cannot
tell which, because the cookie has no binding to compare, and it never logs the IP or User-Agent.

**The session in headers** (`x-cheq-challenge` + `x-cheq-ray-id`) is bound the same way: the request carrying it must
come from the same User-Agent and IP.

**Changing `sessionBinding`** ends every open session, since the binding key changes: those visitors are challenged
once more (with a 5-minute TTL, at most for those 5 minutes).

#### A visitor on plain http

A visitor whose request reaches the Worker over plain `http://` may have to solve the CAPTCHA twice:

1. `GET http://shop.com/sofas`: RTI says suspicious, and the Worker answers with the CAPTCHA page.
2. The visitor solves it. The Worker checks the token and answers with a 302 to `https://shop.com/sofas` that sets the
   session cookie `_cq_se`.
3. The browser drops the cookie: it is `Secure`, and the answer came over plain http.
4. `GET https://shop.com/sofas` arrives without a session. RTI checks it again, and if it asks for a CAPTCHA again, the
   Worker answers with the CAPTCHA page again.
5. The visitor solves it again. This answer comes over https, the browser keeps the cookie, and the visitor is through.

What follows from it:

- **A visitor who arrives on https solves once.**
- **It ends after the second solve only while the visitor stays on https.** Outside a local run, a browser does not
  send a `Secure` cookie over http. So a later request over `http://` (a link with a full `http://` address, a
  bookmark) arrives without the session, and gets the CAPTCHA again whenever RTI asks for one.
- **The original Referer is lost.** `_cq_rf` (or `_cq_ref`) is `Secure` too, so the browser drops it in step 3. The
  request of step 4 names the site itself as its Referer (`http://shop.com/`: a browser sends only the origin when the
  scheme changes), and the second CAPTCHA page carries that. After step 5 the origin and RTI get
  `x-cheq-original-referer: http://shop.com/` (with `"cookie"`, `_cq_ref` holds it), not the page the visitor came
  from.
- **A local run keeps http and solves once, in Chrome.** Browsers make an exception for `localhost`
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)), and Chrome keeps a `Secure`
  cookie from `localhost`, `127.0.0.1` and `[::1]` over http. Safari does not
  ([WebKit bug 232088](https://bugs.webkit.org/show_bug.cgi?id=232088)): there a local run asks again after every
  solve, so test locally in another browser.
- **A local run is one where the Worker sees `localhost`, `127.0.0.1` or `[::1]`:** `wrangler dev` with no `routes`
  (as `wrangler.toml` ships) and no `dev.host` (in wrangler's source it sets that host as a route does; not run).
  Seen with `wrangler dev` 4.56.0: without `routes` the Worker sees the address the client used
  (`http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`); with `routes` it sees the route's host over http, and
  the redirect after a solve is rewritten to `https://` on the local address, which the local http server does not
  answer. So a local CAPTCHA run needs a configuration without `routes`.

The example leaves all of this as it is on purpose, to stay small: a site that shows the CAPTCHA should not answer on
plain http at all. There are two ways to get there.

**At Cloudflare (recommended).** Turn on
[Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/) for
the zone. Cloudflare then answers a request over http with a redirect to https. Cloudflare documents the order only
for the Page Rule with this name: Page Rules run before the Worker, and this rule is respected for a visitor's request
to a Worker route ([Page Rules with Workers](https://developers.cloudflare.com/workers/configuration/workers-with-page-rules/)).
For the zone setting it states no order, and neither was tested for this example. So check it once on your zone, with
a client that really sends http: a browser may switch an `http://` address to https by itself. Run `npx wrangler tail`
in one terminal and `curl -sI http://shop.com/tail-check` in another. The answer must be a redirect to
`https://shop.com/tail-check`, and the tail must show no line for `http://shop.com/tail-check`. On a busy Worker the
tail drops lines and says so: `--ip self` shows only your own requests.

**In the Worker (optional).** If visitors still reach the Worker over `http://`, put these lines into
`turnstileChallengeExample` in `src/turnstile-challenge-example.ts`, at the top of `if (!token) {`, in place of the
comment there that starts with "A visitor on plain http gets the CAPTCHA page here too":

```ts
// A visitor on plain http is sent to https before the CAPTCHA page, so one solve is enough. A local run keeps
// http (see returnUrl).
if (url.protocol === "http:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
    return new Response(null, { status: 302, headers: { Location: `https://${url.hostname}${url.pathname}${url.search}`, ...responseHeaders.noStore() } });
}
```

A request on plain http that would get the CAPTCHA page is then answered with a 302 to https, on the same host and
the default port. The path and the query are the ones the CAPTCHA page would have had: the request's own, or, for a
request with a body that `actionOnSuspicious` challenges, those of the page it came from. The CAPTCHA page is then
only shown on https. So one solve is enough, a later `http://` request is sent to https, where the session counts, and
the page carries the Referer the browser sends there.

- These lines are not part of the shipped example. The shipped tests pass with them, but none of them runs these
  lines. Add your own tests: an `http://` request gets the 302, and an `https://` request and `localhost` still get
  the CAPTCHA page.
- Use them only when the visitors themselves use http. If a proxy in front of Cloudflare reaches it over http while
  the visitors are on https, these lines send every challenged visitor into a redirect loop.
- Under `wrangler dev` with `routes` (see above), wrangler rewrites their redirect to `https://` on the local address,
  which the local server does not answer: a challenged request ends there.

#### The original Referer

After a CAPTCHA, the landing page's `Referer` (and `document.referrer`) is the CAPTCHA page, not the page the visitor
came from (Google, an ad, a partner). The example carries the original Referer through the CAPTCHA:

1. The challenge page puts it in a hidden field, `original_referer`, the way a browser sends a Referer by default:
   - from another site, only its origin, as browsers send it: `https://www.google.com/`
   - from this host, the full URL without the `#fragment`: `https://shop.com/category?page=2`
   - cut to 420 characters (the most GA4 keeps for `page_referrer`), never in the middle of an encoded character
   - nothing for no Referer, or one that is not an http(s) URL
2. The form sends it with the token, in the reply's URL.
3. Only on the 302 after a **verified** solve, the Worker checks it again (the client controls the URL) and hands it on
   in a cookie (below). A failed token, a retry page or a paused CAPTCHA set nothing.

`originalRefererVia` in `turnstileConfig` says who gets it:

| `originalRefererVia` | Cookie on the 302 | Who gets the Referer |
|---|---|---|
| `"header"` (default) | `_cq_rf`, signed and `HttpOnly`, landing page only, 60 seconds | The origin and RTI: on the landing request the Worker adds `x-cheq-original-referer: https://www.google.com/` |
| `"cookie"` | `_cq_ref`, readable by scripts, `Path=/`, 60 seconds | The site's own scripts (snippet below). The Worker never reads it back |

**What the header is worth.** The value is what the visitor's browser reported as its Referer, carried through the
CAPTCHA. It is as trustworthy as a `Referer` header, no more: do not treat it as verified. What the signature
guarantees is that the header is only set after a solved CAPTCHA, for the same client, on the landing page, within 60
seconds.

**`"header"`:**

- `_cq_rf={expiresAt}.{signature}|{Referer, URL-encoded}`. The signature is an HMAC with `sessionSigningSecret` over
  the expiry, the Referer, the landing page's path and the client binding (IP and User-Agent, per `sessionBinding`),
  like `_cq_se`. A made-up, edited, expired or copied cookie, or one sent to another page, adds no header.
- An `x-cheq-original-referer` sent by the client is removed from the request the Worker forwards, so the header comes
  from `config.originalReferer`: with the example, only after a solved CAPTCHA. The exception is Cloudflare's
  pass-through after a failure, which sends what the client sent (see
  [What the Worker cannot clean](#what-the-worker-cannot-clean)).
- The header is added before the RTI call, and it is on the Worker's list of headers for RTI, so RTI gets it too.
- The cookie is not deleted after use: `config.originalReferer` sees only the request, and the origin's response goes
  back to the visitor unchanged, so nothing sets a cookie on it. A reload of the landing page within 60 seconds gets
  the header again.
- If the origin writes it into the HTML (for analytics), that page must not be cached, or the next visitor gets it too.
- A custom challenge can set it the same way: `config.originalReferer(request)` is called on every request, and what
  it returns becomes the header (see [Challenge callbacks](#challenge-callbacks)).
- The landing page's path is the path of the URL the 302 sends the visitor to, as the URL parser writes it. The landing
  request's path went through the same parser, so the two match also when the parser rewrites the path
  (`/a/../shop/item` is `/shop/item`). It also goes into `_cq_rf`'s `Path` (`/` if it has a `;`, `,` or a space).
- When the path the Worker sees on the landing request differs from the signed one, for example because the zone's own
  URL normalization rewrote it, the signature does not match and the header is not restored. It fails safe: the
  request goes on without it.

**`"cookie"`:** the same format as on CloudFront, so the same snippet reads it on both CDNs:
`_cq_ref={return URL}|{Referer}`, both URL-encoded, `Path=/; Secure; SameSite=Lax; Max-Age=60`. Read it before the
analytics tag reads the referrer:

```js
const carried = document.cookie.split('; ').find(c => c.startsWith('_cq_ref='));
const originalReferrer = carried ? decodeURIComponent(carried.split('|')[1] ?? '') : document.referrer;
```

The Worker never reads `_cq_ref`, so a planted or edited one never becomes `x-cheq-original-referer` (only a valid
`_cq_rf` can), and RTI never gets it: the Worker sends RTI the three CHEQ cookies of the tag, not the `Cookie`
header. The origin gets it inside the `Cookie` header, as the browser sent it, like any other cookie: it can fool the
site's own scripts, and any origin code that reads it.

In both modes, **a request with a body** (`actionOnSuspicious` CHALLENGE) carries its own Referer, the form page.

**On plain http** the original Referer is lost, in both modes. `_cq_rf` and `_cq_ref` are `Secure`, so a browser drops
them from an answer sent over http. If RTI asks for a CAPTCHA again on https, the visitor solves it a second time
there, and that page gets the site's own http address as its Referer. So the origin and RTI get
`x-cheq-original-referer: http://shop.com/` (with `"cookie"`, `_cq_ref` holds that value), not the page the visitor
came from. See [A visitor on plain http](#a-visitor-on-plain-http) for the whole chain and for what to do about it.

#### Implementing a custom challenge

Replace `turnstileChallenge.challenge`, `turnstileChallenge.validateChallenge`, `turnstileChallenge.isChallengeResponse`
and `turnstileChallenge.originalReferer` in `config.ts` with your own functions (any of them) matching these
signatures:

```typescript
// config.challenge
async (
  request: Request,
  rtiResponse: RTIResponse, // when RTI failed (reply only): a stand-in with only `ids`, see "RTI down"
  addRtiResultHeader?: (headers: Headers) => void // optional: adds x-cheq-rti-result to these headers
): Promise<Response | Request>

// config.validateChallenge
async (
  request: Request,
  isDebug: boolean | undefined
): Promise<boolean>

// config.isChallengeResponse (synchronous: only `true` counts)
(
  request: Request
): boolean

// config.originalReferer (may return a promise)
(
  request: Request
): string | undefined | Promise<string | undefined>
```

The `challenge` function must return either:
- A `Response` (e.g. 403 with challenge page HTML, or a 302 redirect). A 302 with two cookies needs a `Headers` object
  with one `append("Set-Cookie", …)` per cookie, as the example builds it.
- A `Request` (pass-through, if you want to allow after custom logic). It reaches the origin **without**
  `x-cheq-rti-result` unless you call `addRtiResultHeader(request.headers)` first. If your challenge reads the body,
  read it from `request.clone()`, so the request can still be forwarded.

A custom `challenge` must also handle the reply to its own page (see
[The reply to the challenge page](#the-reply-to-the-challenge-page)), and `isChallengeResponse` must recognize that
reply (e.g. by your CAPTCHA's token field). `challenge` is called for every request it recognizes, also when RTI allows
it, when the visitor has a valid session, and when RTI fails (a stand-in `response` with only `ids`, where `ids.rayId`
is the `cf-ray` value and not an RTI ray id, and no `addRtiResultHeader`). Without `isChallengeResponse`, replies are
not recognized (a warning is logged once per cold start): in `BLOCKING` mode a reply that RTI allows then reaches the
origin with the form fields.

> **Note:** If `config.challenge` throws, the error is caught and the request is passed through (fail open). Errors are
> logged via `console.error`, and to the RTI logger unless `logErrors` is `false`. For a reply to the challenge page,
> passing it through means the origin gets the token and the form fields in place of the visitor's query string: handle
> errors on a reply inside `challenge` instead (the Turnstile example shows the widget again, then redirects to
> `original_url` once paused).

### Troubleshooting

#### Turnstile challenge loops infinitely

**Symptom:** Users keep seeing the CAPTCHA after completing it.

**Cause:** The `_cq_se` cookie is not being set or not being sent on subsequent requests (e.g. the cookie was set with
`SameSite=Strict`, which the browser drops when the visitor arrives from another site, or the cookie domain is wrong).

**Fix:** Verify the `Set-Cookie` header in the 302 response. Check that the cookie `Path=/` is correct for your URL
structure. Make sure the cookie uses `SameSite=Lax` (the shipped example does). `SameSite=Strict` breaks visitors coming
from other sites: the cookie is not sent on the cross-site navigation, so they are challenged again.

**Another cause, plain http:** the cookie is `Secure`: outside a local run, a browser drops it from an answer sent over
http, and does not send it over http. A visitor who solves the CAPTCHA on http is sent to https and asked once more
there if RTI challenges again, and again on every later `http://` page that RTI challenges. See
[A visitor on plain http](#a-visitor-on-plain-http).

**Another cause, the session binding:** the session only works from the same User-Agent and IP
(see [Session binding](#session-binding)). A visitor whose address changes (a rotating IPv6 privacy address, a NAT or
proxy pool, IPv4 ↔ IPv6, Wi-Fi ↔ cellular), or whose browser changes its User-Agent, is challenged again. Turn on
`debug` and look for `signature match: false (session binding mismatch ...`. Use `ip: "none"` for such traffic.

A further cause: the `_cq_session` cookie name starts with `_cq_se`. The example matches `_cq_se=` (with the `=`) to
avoid this collision. Verify this is the case in your implementation.

#### "Verification failed" after a refresh, a reopened link, or a long wait

**Symptom:** The visitor sees the challenge page again with "Verification failed. Please try again." above the widget.

**Cause:** The Turnstile token is single-use and expires after 300 seconds. The challenge form is sent with `GET`, so
the token stays in the URL (`?cf-turnstile-response=...`) of the reply, and of a retry page (the challenge page shown
again after a failed check, at the reply's URL). Refreshing or reopening a retry page, and opening a reply's URL a
second time (shared or bookmarked), send the same token again; a form sent more than 5 minutes after the widget was
solved sends an expired one. Cloudflare's siteverify rejects it (`timeout-or-duplicate`) and the example shows the
widget again with the error message. In `BLOCKING` mode this happens whether RTI allows the reply or asks for a
CAPTCHA: either way it goes to `config.challenge` (see
[The reply to the challenge page](#the-reply-to-the-challenge-page)).

**Second cause, for every visitor and every token:** the token is genuine but fails the [token checks](#token-checks):
the hostname does not match (a site on several host names without `allowedHostnames`, an `allowedHostnames` entry
written as `*.example.com` or `.example.com`, or Cloudflare's test keys) or the action is not `cheq-challenge`
(`data-action` removed from the challenge page). The Worker's log (e.g. `npx wrangler tail`) then shows a
`[turnstile] token valid but …` warning naming the mismatch. Fix the setup as described there.

**Fix:** The visitor solves the widget again; the new token works. If it fails for every visitor and the log has no
`token valid but …` warning, check `secretKey` and `siteKey` in `turnstileConfig`: the example does not log siteverify's
`error-codes` (such as `invalid-input-secret`).
