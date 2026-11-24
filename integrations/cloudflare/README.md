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

`npm run test` runs `tsc` and the tests. They check that your config is valid. While `apiKey`, `tagHash`, the three
Turnstile secrets and `interstitial.tag` are all still `REPLACE_ME`, they also check that `config.ts` still has the
shipped defaults; those checks are skipped once one of the six has your value. `npm run deploy` runs the same tests
first, and deploys only when they pass.

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

**A Worker name for `workers.dev`:** use letters, digits and hyphens only. The Worker's address is
`https://<name>.<subdomain>.workers.dev`, and a `_` in a host name breaks some clients: on 2026-11-23, Playwright's
WebKit 18.2 (the engine of Safari) could not open `https://cheq-rti-v4_1-interstitial.cheqai.workers.dev` at all
("SSL connect error") and opened the same domain without `_`; Chromium, Firefox and `curl` opened both. Real Safari was
not tried. A Worker on your own domain (a route) is not affected: its name is not in the address.

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
redirect, a CAPTCHA page, the interstitial page, the empty 403 for a prefetch), which the Worker sends as it is, or the
request to send on, which `forwardToOrigin` passes to the origin. `forwardToOrigin` is the only place that calls the
origin (see [Local or demo origin](#local-or-demo-origin)).

A request goes through eight steps (the copy in `fetch`, the rest in `handle`):

1. **Copy.** `fetch` copies the request before `handle` starts, and the request body moves to the copy, so every config
   callback gets the copy, never the incoming request. The copy is what reaches the origin, unless the Worker answers
   itself (then it reads the rest of the copy's body in the background and throws it away; for a local run, see
   [Test locally](#test-locally-using-wrangler)) or `config.challenge` returns another `Request`, which is sent on as
   returned. An `x-cheq-rti-result` or `x-cheq-original-referer` sent by the client is removed from the copy. Then
   `config.originalReferer` is called (it may return a promise); a value becomes `x-cheq-original-referer`. If it
   throws or rejects, the error is written to the console and the request goes on without the header.
2. **Ignored path.** A path that matches `ignorePaths` is forwarded without calling RTI.
3. **RTI.** While the interstitial is on, the Worker first reads its mark (`_cq_it`) from the copy (see
   [The mark cookie](#the-mark-cookie)). In `"header"` mode a valid mark for this page can set `x-cheq-original-referer`
   on the copy. The RTI payload is built from the copy: a fixed list of headers (`x-cheq-original-referer` among them),
   the CHEQ cookies, and the JA3 hash from the incoming request's `cf`. A request with a valid mark for its own page
   also sends `customId3: interstitial:<ray id of the first RTI call>`. With `telemetry: true` the duration of the call
   goes to the RTI logger through `waitUntil`.
4. **Decision.** RTI's answer becomes an action (`getAction`), and the action a strategy for this method and path
   (`getStrategyForRequest`). When RTI wants the request challenged and the strategy is `CAPTCHA`, three questions
   decide whether it gets the CAPTCHA page: a rule of [`actionOnSuspicious`](#actiononsuspicious), then whether it is
   a page load (`isPageLoad`), then the method's default (see [Which request gets a page](#which-request-gets-a-page)).
   While the interstitial is on, a `GET` page load that RTI wants challenged, and that no rule decides otherwise, gets
   the strategy `INTERSTITIAL` in place of the CAPTCHA page, whatever `challengingStrategy` says (see
   [Interstitial](#interstitial)). In `MONITORING` mode the Worker logs a `would-show` line where `BLOCKING` mode would
   show that page.
5. **Challenge reply.** In `BLOCKING` mode, with `challenge` and `isChallengeResponse` set, a request that
   `isChallengeResponse` recognizes goes to `config.challenge` when the strategy is none (ALLOW), `CAPTCHA` or
   `INTERSTITIAL`, whatever session the visitor has. A throwing `isChallengeResponse` counts as no reply. A throwing
   `challenge` is logged and the request is forwarded.
6. **By strategy.**
   - `ACCESS_DENIED`, `NOT_FOUND`: our 403 or 404 block page, with HTML and no-store headers.
   - `REDIRECT`: a 302 to `redirectLocation` (default `https://www.cheq.ai/`), with `x-cheq-cdn-request-id`,
     `x-cheq-id`, `x-cheq-page-view-id` and no-store.
   - `CAPTCHA` without `config.challenge`: forwarded with the verdict.
   - `CAPTCHA`, and `validateChallenge` returns `true` (a valid session): forwarded with the verdict. The session waives
     only the CAPTCHA, never a block, a 404 or a redirect.
   - `CAPTCHA` for a prefetch (`Sec-Purpose` or `Purpose` contains `prefetch`): an empty 403 with
     `x-cheq-cdn-request-id`, `x-cheq-id`, `x-cheq-page-view-id` and no-store, in place of the CAPTCHA page (see
     [Which request gets a page](#which-request-gets-a-page)).
   - `CAPTCHA` otherwise: `config.challenge`. A `GET` gets here when it is a page load that no rule covers; a `GET` or
     `HEAD` also when `actionOnSuspicious` or `blockingStrategy: CAPTCHA` sends it to the CAPTCHA (see
     [Which request gets a page](#which-request-gets-a-page)). It is challenged in place. A request with a body is
     challenged for the page it came from: a `GET`, without the body, for the same-site `Referer`, or for `/` without
     one. Only the path and the query of the request's own URL are changed, so the host cannot change.
   - A throw from `validateChallenge` or `challenge`: logged, and the request is forwarded without the verdict.
   - `INTERSTITIAL`: the interstitial's decision (see [How it works](#how-it-works)). A request for which RTI found the
     tag's session gets `onSecondVerdict`, and one with a valid mark `onSessionNotFound`: each is carried out as the
     cases above, and `Action.CHALLENGE` is the `CAPTCHA` case. Otherwise the interstitial page, or the empty 403 for a
     prefetch. A throw in the interstitial's code is logged, and the request is forwarded with the verdict. A throw in
     one of its log lines is logged and changes nothing else (see [Monitoring and logs](#monitoring-and-logs)).
7. **Allow.** Every other request (ALLOW, a request that `actionOnSuspicious` lets through, such as a `GET` that is not
    a page load, the `CAPTCHA` cases above that are forwarded with the verdict, and the interstitial's forwards) gets
    `x-cheq-rti-result` on the copy, and the copy is forwarded. When RTI wants the request challenged or blocked
    (`BLOCKING` mode) and no valid CAPTCHA session let it through, the origin's HTML answer gets
    `Cache-Control: no-store` (see [Which request gets a page](#which-request-gets-a-page)).
8. **Any error before the decision** (an RTI error or timeout, a malformed RTI response): logged. A recognized challenge
   reply (the same conditions as step 5) still goes to `config.challenge`, with a stand-in response and no
   `addRtiResultHeader` (see [Challenge callbacks](#challenge-callbacks)). Everything else is forwarded, without the
   verdict. Why an RTI call times out, and how to choose `timeout`: [RTI timeout and latency](#rti-timeout-and-latency).

**Logs.** Errors go to `console.error`, and to the RTI logger through `waitUntil` unless `logErrors` is `false`:
`Error handling request '<id>'`, `Challenge error handling request '<id>'`,
`Challenge reply check error handling request '<id>'` and `Interstitial error handling request '<id>'`, where `<id>`
is the `cf-ray` value or `unknown_request_id`. With `debug: true` the Worker also logs the RTI payload (redacted), the
RTI response, the action, the strategy, and the lines `challenge reply, passing it to challenge`,
`valid challenge session, waiving CAPTCHA`, `prefetch: an empty 403 in place of the challenge page`,
`interstitial: forward, <reason>` and `prefetch: an empty 403 in place of the interstitial`. The interstitial's own
lines go to the RTI logger as info lines (see [Monitoring and logs](#monitoring-and-logs)).

**Cold start.** When the module loads, the Worker logs one warning when `challenge` is set without
`isChallengeResponse`, then one per problem in `interstitial`
(`[interstitial] <problem> (see "Interstitial" in the README)`, see [Settings](#settings)), then one per problem in
`actionOnSuspicious` (`[config] <problem> (see "actionOnSuspicious" in the README)`). If the `actionOnSuspicious`
check throws, it logs `[config] the config check failed, continuing: …` and the Worker still starts. While the three
Turnstile secrets are `REPLACE_ME` (as shipped), it also logs
`[turnstile] CAPTCHA disabled, not configured: siteKey, secretKey, sessionSigningSecret (set them in config.ts)`.
With `enabled: true` and `interstitial.tag` still `REPLACE_ME` (as shipped), it logs
`[interstitial] interstitial.tag is not set, the interstitial is off: paste the tag line from the CHEQ console (see "Interstitial" in the README)`.

### RTI timeout and latency

`timeout` in `config.ts` (500 ms as shipped) is the longest the Worker waits for RTI. The timer starts when the RTI call
starts. When it runs out, the call fails with `request error: The operation was aborted due to timeout`, which is
logged as `Error handling request '<id>': …` (step 8 of [How a request is handled](#how-a-request-is-handled)), and the
request is forwarded without an RTI decision and without `x-cheq-rti-result`: no block and no CAPTCHA. The timeout is a
limit, not a delay: an answer that comes sooner is used at once.

**Where the time goes.** Not in the Worker. `fetch` is part of the Workers runtime, so nothing is loaded on a cold start,
and a request used about 1 ms of CPU in the measurement below. The CloudFront integration replaced `fetch` because
loading it on a small Lambda is slow (see [Memory, CPU and Cold Starts](../cloudfront/README.md#memory-cpu-and-cold-starts));
the Worker has no such cost. The time is the network between the Cloudflare location that runs the Worker and the RTI
endpoint:

- On a connection that is already open, a call takes about one round trip to the RTI region.
- A call that needs a new connection first pays for the DNS lookup, the TCP connect and the TLS handshake: about three
  round trips more.

Which call finds an open connection is up to Cloudflare; the Worker cannot keep one open itself. So the slow call is not
only the first request after a deploy. In the measurement below, slow and fast calls alternated for the first requests;
after that all calls were fast, also after 86 s without traffic.

**Measured** on 2026-11-23: the Worker in Cloudflare's Tel Aviv location (`TLV`), the dev RTI endpoint
(`obs.dev.cheqzone.com`, in AWS us-east-1), each RTI call timed inside the Worker from the `debug` log lines
(`RTI Request payload` to `RTI Response`):

| Call | RTI call |
|---|---|
| On an open connection | 170–185 ms |
| On a new connection | 610–620 ms |
| The first request after a deploy | timed out at `timeout: 1000`; answered at `timeout: 2000` (1.04 s in all, seen from the client) |

From a developer PC in Israel, the production endpoint `rti-global.cheqzone.com` (it resolved to AWS ap-south-1, Mumbai,
from there) answered in about 160 ms on an open connection and in 670–930 ms on a new one. These numbers are from one
location: a Cloudflare location close to an RTI region sees much smaller ones.

**Choosing `timeout`.**

- 500 ms (as shipped) covers calls on an open connection. From a location about 150 ms from the RTI region, every call
  on a new connection times out and the request goes through unchecked. A site with little traffic has the fewest open
  connections and is hit hardest.
- Allow about four round trips to the RTI region, plus a margin. From Tel Aviv that is about 1,000 ms, and 2,000 ms
  also covered the first request after a deploy.
- A higher value costs only when RTI is slow or cannot be reached: a visitor then waits up to `timeout` before the
  request goes through unchecked.

**Checking a deployment.** `npx wrangler tail <worker name>` shows each timeout as an `(error)` line with
`The operation was aborted due to timeout`. With `debug: true` and `npx wrangler tail <worker name> --format json`, every
log line has a `timestamp`: the gap between `RTI Request payload` and `RTI Response` is the RTI call, and `wallTime` and
`cpuTime` are the request's totals. With `telemetry: true`, the duration of every call goes to the RTI logger (step 3
above).

### actionOnSuspicious and logErrors

Both are in the `config` object in [`src/config.ts`](src/config.ts). For example:

```ts
actionOnSuspicious: {
    methods: {
        GET: Action.ALLOW, HEAD: Action.ALLOW, // a GET that is not a page load, and a HEAD
        POST: Action.ALLOW, PUT: Action.ALLOW, PATCH: Action.ALLOW, DELETE: Action.ALLOW, OPTIONS: Action.ALLOW,
    },
    rules: [
        { path: '^/login$', methods: ['POST'], action: Action.CHALLENGE }, // login form: CAPTCHA, then log in again
        { path: '^/api/', action: Action.BLOCK },                          // every body method under /api/
    ],
},
logErrors: true, // false: caught errors go to the console only, not to the RTI logger
```

The shipped config has every method on `Action.ALLOW`, `rules: []` and `logErrors: true`.

#### Which request gets a page

When RTI wants a request challenged (its action is `CHALLENGE`, and the strategy is `CAPTCHA`, the default
`challengingStrategy`), the Worker asks three questions, in this order:

1. **Does a rule of `actionOnSuspicious.rules` match the path and cover the method?** The first such rule decides.
2. **Is the request a page load (below)?** It gets the CAPTCHA page (a prefetch of a page gets an empty 403, below).
3. **Otherwise** the method's default in `actionOnSuspicious.methods` decides. Without a default the action is
   `Action.ALLOW`: the request is forwarded to the origin with `x-cheq-rti-result`.

An example with two rules and no defaults: `{ path: '^/login$', methods: ['POST'], action: Action.CHALLENGE }` and
`{ path: '^/api/', methods: ['GET'], action: Action.ALLOW }`.

| # | A request that RTI wants challenged | Before this version | Now | Question |
|---|---|---|---|---|
| 1 | `GET /sofas`, a page load | the CAPTCHA page | the CAPTCHA page | 2 |
| 2 | `GET /api/cart`, from the page's script | the CAPTCHA page, the script breaks | forwarded | 1 |
| 3 | `GET /search/suggest`, from the page's script, no rule | the CAPTCHA page, the script breaks | forwarded | 3 |
| 4 | `GET /sofas`, from a client that sends `Sec-Fetch-Dest: empty`, or from `curl` | the CAPTCHA page | forwarded | 3 |
| 5 | `HEAD /sofas` | the CAPTCHA page | forwarded | 3 |
| 6 | `POST /login` | the CAPTCHA page | the CAPTCHA page, for the page it came from | 1 |
| 7 | `POST /api/order` | the CAPTCHA page | forwarded | 3 |

Before this version, every request that RTI wanted challenged got the CAPTCHA page, whatever its method. "Forwarded"
means sent to the origin with `x-cheq-rti-result`, so the origin decides.

**The browser does not keep a flagged page let through without a CAPTCHA pass.** In `BLOCKING` mode the Worker can
forward a request that RTI wants challenged or blocked. Then the origin's HTML answer (`Content-Type` `text/html` or
`application/xhtml+xml`) gets `Cache-Control: no-store, no-cache, must-revalidate`, unless a valid CAPTCHA session
let the request through or the request is forwarded without the verdict (after an error). The
rest of the answer (status, body, the other headers) is not changed. A page that the browser keeps could be shown
later for a link click, a redirect or Back without asking the Worker, so the visitor would get it without the
interstitial or the CAPTCHA. That was seen in Chromium 131 and Firefox 132 on 2026-11-23, for a page that a script
fetched, with an origin that sends no `Cache-Control`. These requests get `no-store` on the origin's HTML answer:

- a request that a rule or a default of `actionOnSuspicious` lets through (`Action.ALLOW`), such as a `GET` that is
  not a page load;
- a page load that the interstitial lets through, with `onSecondVerdict` or `onSessionNotFound` set to `Action.ALLOW`
  (see [Interstitial](#interstitial)), and a request that the Worker forwards after an error in the interstitial's
  code;
- a request that would get the CAPTCHA page but is forwarded because `config.challenge` is not set (as shipped, until
  the three Turnstile secrets are set), also when the interstitial's `Action.CHALLENGE` or `blockingStrategy: CAPTCHA`
  led there.

These keep the origin's caching headers:

- an answer that is not HTML (JSON, an image, a script);
- the answer to a request that RTI lets through (its action is `ALLOW`, as for a benign verdict), and every answer in
  `MONITORING` mode;
- the answer to a request that a valid CAPTCHA session lets through (`validateChallenge` gives `true`; with the
  Turnstile example also during a [siteverify pause](#siteverify-pause));
- the answer to a request forwarded without the verdict (an ignored path, an RTI error, a throw from
  `validateChallenge` or `challenge`), and to a `Request` that `config.challenge` returns.

CloudFront cannot do this: it runs on the request and cannot change the origin's answer (see its README,
[Which request gets a page](../cloudfront/README.md#which-request-gets-a-page)).

**While the interstitial is on**, the page of question 2 for a `GET` page load is the interstitial, whatever
`challengingStrategy` says, and a rule's `Action.CHALLENGE` for a `GET` page load means the interstitial too (row 1).
Every other request gets the answer of this section, `challengingStrategy` included (rows 2 to 7). See
[Interstitial](#interstitial).

**A page load** is a `GET` that a browser sends to show a page. The Worker tells it by two headers of the request,
`Sec-Fetch-Dest` and `Accept`, and a prefetch (below) by two more, `Sec-Purpose` and `Purpose`. Cloudflare's docs say
that a Worker gets "the incoming HTTP request"
([Fetch Handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/); documented, not tested at
Cloudflare's edge). A Request Header Transform Rule runs before the Worker, and one that removes such a header takes it
from the Worker too (see [What the Worker cannot clean](#what-the-worker-cannot-clean)). When a header does not arrive,
the list below applies: without `Sec-Fetch-Dest`, `Accept` decides; with neither, a `GET` counts as a page load.

- **`Sec-Fetch-Dest: document`** is a page load. In MDN's words, "the request is the result of a user-initiated
  top-level navigation" ([Sec-Fetch-Dest](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Dest)).
  Any other value is not: `empty` (MDN names `fetch()` and `XMLHttpRequest` for it), `iframe`, `image`, `script`.
- **Without `Sec-Fetch-Dest`**, `Accept` decides: a page load asks for `text/html`, as browsers do for a page
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Content_negotiation/List_of_default_Accept_values)).
  `Sec-Fetch-Dest` is missing from Safari before 16.4
  ([MDN's compatibility data](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Dest#browser_compatibility))
  and for a site on plain `http://` (MDN: "The header is only included in requests to potentially trustworthy URLs").
- **With neither header** the Worker cannot tell, and the `GET` counts as a page load, as before this version.
- **`Sec-Purpose` and `Purpose`** do not change it: a prefetch of a page is a page load. What it gets is below.
- A `HEAD` is never a page load, and neither is a request with a body.

Header values are compared in any case, and spaces around `Sec-Fetch-Dest` do not count. A header sent more than once
is judged as one value, its values joined with `, ` as `Headers.get` returns them
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Headers/get)): `Sec-Fetch-Dest` sent twice as `document` reads
`document, document`, which is not a page load. With `debug: true` the strategy line ends with the result:
`..., method: GET, pageLoad: true`.

**A prefetch** is a request that a browser sends to load a page before the visitor opens it. MDN's
[Speculation Rules API](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API) page says that such a
request is sent with `Sec-Purpose: prefetch` (`prefetch;prerender` for a prerender), that the browser keeps a
prefetched page "in a per-document in-memory cache" and uses it when the visitor goes to that page, and that "If a
non-success response code is returned (any HTTP status other than in the 200-299 range after redirects), then the page
will not be prefetched/prerendered". So where a visit would get the CAPTCHA page, a request whose `Sec-Purpose` or
`Purpose` contains `prefetch` gets an empty 403: no body, the request ids (`x-cheq-cdn-request-id`, `x-cheq-id`,
`x-cheq-page-view-id`) and `Cache-Control: no-store, no-cache, must-revalidate`. `config.challenge` is not called. The
browser then does not keep the page, and the visitor's own visit goes through RTI as usual. Nobody ran this in a
browser here.

- This holds wherever this README says that a request gets the CAPTCHA page: a page load, a request that a rule or a
  default sends to the CAPTCHA, a block shown as a CAPTCHA (`blockingStrategy: CAPTCHA`).
- As for a visit, a valid CAPTCHA session waives it (the prefetch is forwarded with the verdict), and without
  `config.challenge` the prefetch is forwarded with the verdict.
- A reply to the challenge page that `isChallengeResponse` recognizes is answered before this check (step 5 of
  [How a request is handled](#how-a-request-is-handled)).
- With `debug: true` the Worker logs `prefetch: an empty 403 in place of the challenge page`.

**What `Action.CHALLENGE` means** when a rule or a default gives it: the CAPTCHA. A `GET` or `HEAD` gets the CAPTCHA
page in place, for its own URL. A request with a body gets it for the page it came from (see the table of
[actionOnSuspicious](#actiononsuspicious)). `Action.ALLOW` forwards the request with the verdict, and `Action.BLOCK` and
`Action.REDIRECT` are carried out as usual.

**A request RTI wants blocked:** whether it is a page load changes nothing for it. The three questions are asked only
for a request that RTI wants challenged, so a client cannot get past a block by sending the headers of a background
call. A block page, a 404 or a redirect from RTI applies to every method. With
`blockingStrategy: ActionStrategy.CAPTCHA` a block is a CAPTCHA too: a `GET` or `HEAD` gets the CAPTCHA page, page load
or not, and the `GET` and `HEAD` settings of `actionOnSuspicious` are not used. A request with a body follows
`actionOnSuspicious`, which cannot see whether RTI said block or challenge, so its setting applies to both: with the
shipped `Action.ALLOW` the request is forwarded with `x-cheq-rti-result`. A site with that setting that wants these
requests stopped sets `Action.BLOCK` or `Action.CHALLENGE` for their methods or paths.

**To give a `GET` or `HEAD` the CAPTCHA page again, as before this version**, set one line in `methods`:
`GET: Action.CHALLENGE, HEAD: Action.CHALLENGE`. Then a `GET` or `HEAD` that RTI wants challenged gets the CAPTCHA
page, page load or not, unless a rule covers it. List the paths that a page's scripts call in `Action.ALLOW` rules, as
in row 2.

**Known limits:**

- A client can send the headers of a background call, such as `Sec-Fetch-Dest: empty`, and then gets no page: it is
  forwarded with `x-cheq-rti-result`, like a script's call. So is a client that sends `Accept: */*` without
  `Sec-Fetch-Dest`, as `curl` 8.14.1 does. The origin can act on the verdict, or a rule or a default can say
  `Action.CHALLENGE` or `Action.BLOCK` for such requests. If your origin answers differently depending on
  `x-cheq-rti-result`, make that answer uncacheable (`Cache-Control: private, no-store`). A suspicious `GET` that is
  not a page load now reaches the origin with the verdict, and a cache that stores the origin's answer to it would
  serve that answer to other visitors.
- A suspicious `HEAD` is forwarded by default: it is never a page load, and the shipped default is `Action.ALLOW`. Set
  `HEAD: Action.CHALLENGE` or `HEAD: Action.BLOCK` to stop it.
- A prefetch that is not a page load (`Sec-Purpose: prefetch` with `Sec-Fetch-Dest: empty`, for example) is forwarded
  with `x-cheq-rti-result` like any background `GET`, as shipped. The usual case is a page that a site names in
  `<link rel="prefetch">`: MDN's
  [`rel=prefetch`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/prefetch) page says that
  the browser asks for it with `Sec-Purpose: prefetch` and `Sec-Fetch-Dest: empty`, and that "The result is kept in the
  HTTP cache on disk". Its HTML answer gets `Cache-Control: no-store` like any page forwarded this way (see
  [The browser does not keep a flagged page let through without a CAPTCHA pass](#which-request-gets-a-page)), so the browser does not reuse it
  for the click. Seen on 2026-11-24 in Chromium 131: with the mark, the click on a prefetched page went to the Worker
  and got the CAPTCHA page. Without it (the Worker before this change) the click showed the prefetched page, without
  the CAPTCHA. Firefox 132 and WebKit 18.2 sent no prefetch request in the same test. The prefetch itself still reaches
  the origin with the verdict. `methods: { GET: Action.CHALLENGE }` gives it the empty 403 instead, unless a rule
  covers it. With that setting, give the paths of background calls `Action.ALLOW` rules.

#### actionOnSuspicious

| Action | What the request gets |
|---|---|
| `Action.ALLOW` (default for every method) | Forwarded with `x-cheq-rti-result`, so the origin decides. |
| `Action.CHALLENGE` | The CAPTCHA page. A `GET` or `HEAD` gets it in place, for its own URL. A request with a body gets it built for the page the visitor came from (the `Referer`, same site only; without one, or from another site, the site's home page `/`), because a CAPTCHA page can't carry a request body through its redirect (a login, a checkout, a bank's 3-D Secure return). After solving they are back on that page and send the form again. The body itself is not kept. A visitor with a valid session is not challenged: the request is forwarded with the verdict. While the CAPTCHA is off (no `config.challenge`), the request is forwarded with the verdict too. |
| `Action.BLOCK` | The `blockingStrategy` answer (403 by default, or 404). With `blockingStrategy: CAPTCHA` it is the CAPTCHA page, as for `Action.CHALLENGE`. |
| `Action.REDIRECT` | A 302 to `redirectLocation`. |

- `methods` is the default per method. A method left out is `ALLOW`. `GET` and `HEAD` are valid keys: the `GET` default
  is used only for a `GET` that is not a page load (see [Which request gets a page](#which-request-gets-a-page)).
- `rules` match the path with a regex (like `ignorePaths`) and, optionally, a list of methods, where `GET` and `HEAD`
  are valid too. A rule without `methods` covers the five methods with a body (`POST`, `PUT`, `PATCH`, `DELETE`,
  `OPTIONS`), not `GET` or `HEAD`. They are checked in order; the first match wins over `methods`, and for a page load
  over the CAPTCHA page (the rules are asked before the page load). In the Turnstile example the reply to the CAPTCHA
  page is a `GET` to the URL that showed it. When RTI wants that reply challenged too, a `GET` rule for that path
  decides: `Action.BLOCK` or `Action.REDIRECT` stops the reply, also after the visitor solved the CAPTCHA (with
  `blockingStrategy: CAPTCHA` a block is the CAPTCHA, and the reply is answered). On a path where a request can get the
  CAPTCHA, give `GET` the action `Action.ALLOW` or `Action.CHALLENGE`.
- `OPTIONS` is the browser's CORS preflight, sent before a cross-site call. Blocking or challenging it breaks that call.
- A typo is logged as a warning once per cold start (`[config] <problem> (see "actionOnSuspicious" in the README)`).
  What it does depends on where it is. A key in `methods` that isn't one of these seven is not used (a method left out
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
(the four log lines in [How a request is handled](#how-a-request-is-handled)) and the warning about a stand-in `rayId`
(see [Challenge callbacks](#challenge-callbacks)) also go to the RTI logger, through `waitUntil`, so the visitor's
answer does not wait for it. `false` stops sending them; they are still written to the console. A failing
`config.originalReferer`, and the Turnstile example's own `[turnstile]` and `[validateChallenge]` lines, only ever go to
the console. The interstitial's outcome lines follow `logOutcomes`, not `logErrors` (see
[Monitoring and logs](#monitoring-and-logs)).

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

- **When:** the strategy is `CAPTCHA` (a CHALLENGE by default, see `challengingStrategy`, for a page load that no rule
  covers while the interstitial is off, or for a request that `actionOnSuspicious` sends to the CAPTCHA, see
  [Which request gets a page](#which-request-gets-a-page); a BLOCK with `blockingStrategy: CAPTCHA`; while the
  interstitial is on, a page load for which `onSecondVerdict` or `onSessionNotFound` gives `Action.CHALLENGE`, see
  [The interstitial and the CAPTCHA](#the-interstitial-and-the-captcha)) and `validateChallenge` does not report a
  valid session, unless the request is a prefetch (it gets an empty 403, see
  [Which request gets a page](#which-request-gets-a-page)). In `BLOCKING` mode also for every reply that
  `isChallengeResponse` recognizes, when the strategy is none (ALLOW), `CAPTCHA` or `INTERSTITIAL`, with or without a
  session, and when RTI is down (below).
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
- **When:** in `BLOCKING` mode, with `challenge` set, when the strategy is none (ALLOW), `CAPTCHA` or `INTERSTITIAL`,
  and when RTI is down. Not called in `MONITORING` mode, without `challenge`, or when the request is blocked, 404'd or
  redirected anyway.
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
  only. It copies the header only when the request has one: a request forwarded without a verdict (an ignored path, an
  RTI error) gets none.

A demo with OPTION 1 differs from the shipped code in three more ways:

- **The tests.** Eight tests expect the request to be forwarded as it is (the same object, the original URL), and fail
  with OPTION 1, so `npm run deploy` stops after `npm test`. Deploy a demo with `npx wrangler deploy`, and put
  OPTION 2 back before you commit.
- **Dev keys need the dev RTI.** `config.ts` calls the production RTI endpoints unless `rtiServiceURI` and
  `rtiLoggerURI` are set. With keys of the dev environment, set both to the dev endpoints, or every request fails and
  is forwarded without a verdict.
- **The timeout.** A demo far from the RTI region needs a `timeout` above the shipped 500 ms (see
  [RTI timeout and latency](#rti-timeout-and-latency)).

Every request that is forwarded goes through this function (allowed traffic, ignored paths, every error path of
`handle`), so the one switch covers them all. Our own answers (block pages, redirects, the CAPTCHA page, the
interstitial page, the empty 403 for a prefetch) never reach it.
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

### Interstitial

Cloudflare only for now. While the interstitial is on, a page load that RTI wants challenged first gets a short CHEQ
page. The page runs your CHEQ tag and reloads by itself, and RTI then decides a second time, with the tag's data.
Without the interstitial, the tag's data reaches RTI only with the visitor's next request, so a bot that loads one page
and leaves is judged without that data.

The shipped `config.ts` has the `interstitial` block with `enabled: true` and `tag: "REPLACE_ME"`. So the interstitial
stays off, with one warning at cold start, until you paste your tag line (see [The tag line](#the-tag-line)).
`enabled: false` is "Standard mode": a challenge gets the CAPTCHA (if it is set up), as before.

#### How it works

```
request 1   GET /sofas?gclid=abc             no tag cookies yet
            RTI call 1: suspicious
            a GET page load, no mark  ->  the interstitial page, at the same URL (403)

browser     the page adds your CHEQ tag, and the tag writes its cookies (_cq_pvid among them)
            the page's script waits for a new _cq_pvid value, writes the mark cookie _cq_it, and reloads

request 2   GET /sofas?gclid=abc             the tag's cookies and the mark
            the Worker checks the mark ("header" mode: it sets x-cheq-original-referer)
            RTI call 2, now with the tag's data, and customId3: interstitial:<ray id of call 1>
              benign                                    -> the origin
              malicious                                 -> the blockingStrategy answer (the block page by default)
              suspicious, RTI found the tag's session   -> onSecondVerdict (Action.ALLOW by default)
              suspicious, no tag session, a valid mark  -> onSessionNotFound (Action.ALLOW by default)
```

The reload keeps the URL, its query and its `#fragment`, so the visitor lands on the page they asked for (the design
says that Chrome did so for `location.reload()`, tested on 2026-11-17, and a local run with Chrome 157 on 2026-11-23
saw the same).

A page load gets the interstitial when all of these hold:

1. The mode is `BLOCKING`, and the interstitial is on: `enabled` is `true` and the tag line can be read.
2. RTI says challenge: a suspicious verdict, or a match in `challengeTTCodes` or `challengeReasons`. A block verdict is
   checked first, and is handled as before.
3. The request is a `GET` page load (see [Which request gets a page](#which-request-gets-a-page)), and no rule of
   `actionOnSuspicious` that covers it says otherwise. A rule's `Action.CHALLENGE` for it means the interstitial too.
4. RTI has not found the tag's session: `metadata.sessionFound` is not `true`. A visitor whose session RTI has gets
   `onSecondVerdict` at once, with no page: on the reload, or when the tag ran on an earlier page.
5. The request has no valid mark (see [The mark cookie](#the-mark-cookie)). A request with one gets
   `onSessionNotFound`.

**The Worker does not check for good bots.** A declared good bot (a crawler such as Google's or Bing's) is expected to
get a benign verdict from RTI, and so no interstitial. If your policy makes such a crawler suspicious, it gets the
interstitial like any visitor, and a crawler that runs no JavaScript cannot pass it. The fix is in the policy screen of
the CHEQ console, not in the Worker.

Two more cases: a prefetch of the page (`Sec-Purpose` or `Purpose` contains `prefetch`) gets an empty 403 in its place,
as in place of the CAPTCHA page. A reply to the CAPTCHA page that `isChallengeResponse` recognizes goes to
`config.challenge` first (step 5 of [How a request is handled](#how-a-request-is-handled)).

**With the defaults, the visitor gets the site after the reload** unless RTI's second answer is a block: both
`onSecondVerdict` and `onSessionNotFound` are `Action.ALLOW`, which forwards the request with `x-cheq-rti-result`. To
stop such page loads, set them (see [The interstitial and the CAPTCHA](#the-interstitial-and-the-captcha)).

**The page** is our own HTML, answered at the URL the visitor asked for, with the status `statusCode` (403 by default)
and the headers `Content-Type: text/html;charset=UTF-8`, `Cache-Control: no-store, no-cache, must-revalidate` and
`X-Robots-Tag: noindex`. It shows the logo, the headline ("Checking your browser"), the message ("This usually takes
about a second.") in a live region, a turning ring (it stands still for `prefers-reduced-motion`), `Ray ID:` with the
ray id of RTI call 1, and "Protected by Cheq.ai". The `<title>` is the headline. Without JavaScript it shows "Please
turn on JavaScript, then reload the page." Its one script does this:

1. If a mark of this setup is already there, the Worker did not accept it, and another reload would loop. The page
   stops and shows "We could not check your browser." with a **Try again** button, which deletes the mark and reloads.
2. It remembers each `_cq_pvid` value there is now, and adds your tag: a `<script>` element with the attributes of
   your tag line.
3. It checks every 50 ms for a `_cq_pvid` value that was not there at the start. The tag writes a new value on each
   run, and it calls its callback (`data-jsonp`) before it writes the cookie, so the callback cannot say that the tag
   is done (both read in the tag's code, adserver, on 2026-11-17).
4. When the new value is there, the tag fails to load, or `maxWaitMs` has passed, it writes the mark (and, in
   `"cookie"` mode, `_cq_ref` when there is an original Referer) and calls `location.reload()`.
5. If it cannot read the new mark back, cookies are blocked: it does not reload, and shows "Please allow cookies for
   this site, then reload the page."

The page only reads the tag's cookies. It does not change or delete them.

#### Settings

`config.interstitial` in [`src/config.ts`](src/config.ts). Without the block the interstitial is off. While it is on,
a wrong value of a setting other than `enabled` and `tag` gets a warning and its default, and the interstitial stays
on. Left out, such a setting gets its default without a warning (`null` is a wrong value).

| Setting | What it is | Default | Allowed | A wrong value |
|---|---|---|---|---|
| `enabled` | Turns the interstitial on | none (`true` in the shipped `config.ts`) | `true` or `false` | Off, with a warning, also when it is left out |
| `tag` | Your tag line, see [The tag line](#the-tag-line) | none (`"REPLACE_ME"` as shipped) | one `<script …></script>` line | Off, with a warning that says what is wrong |
| `onSecondVerdict` | What a `GET` page load gets when RTI wants it challenged and has found the tag's session | `Action.ALLOW` | `Action.ALLOW`, `Action.BLOCK`, `Action.REDIRECT` or `Action.CHALLENGE` | A warning, and `Action.ALLOW` |
| `onSessionNotFound` | What a `GET` page load with a valid mark gets when RTI wants it challenged and has no tag session | `Action.ALLOW` | the same four | A warning, and `Action.ALLOW` |
| `maxWaitMs` | How long the page waits for the tag before it reloads anyway, in milliseconds | `5000` | a whole number from 1000 to 30000 | A warning, and `5000` |
| `statusCode` | The HTTP status of the page | `403` | `200`, or a whole number from 400 to 599 | A warning, and `403` |
| `originalRefererVia` | How the original Referer is delivered after the reload, see [The original Referer after the interstitial](#the-original-referer-after-the-interstitial) | `"header"` | `"header"` or `"cookie"` | A warning, and `"header"` |
| `binding` | Which client a mark belongs to, see [The mark cookie](#the-mark-cookie) | `{ ip: "exact", userAgent: true }` | `ip`: `"exact"` or `"none"`, `userAgent`: `true` or `false` | A warning, and the default |
| `logoUrl` | The logo on the page | CHEQ's logo, inline | an `https://` URL of at most 200 characters, also as the URL parser writes it | A warning, and CHEQ's logo |
| `headline` | The page's headline and `<title>` | `"Checking your browser"` | text of 1 to 60 characters | A warning, and the default |
| `message` | The text under the headline | `"This usually takes about a second."` | text of 1 to 160 characters | A warning, and the default |
| `lang` | The page's language | `"en"` | a language tag such as `"en"` or `"en-US"` | A warning, and `"en"` |
| `logOutcomes` | One line per interstitial decision to the RTI logger, see [Monitoring and logs](#monitoring-and-logs) | `true` | `true` or `false` | A warning, and `true` |

`Action.CHALLENGE` in `onSecondVerdict` or `onSessionNotFound` is the CAPTCHA, see
[The interstitial and the CAPTCHA](#the-interstitial-and-the-captcha). `Action.REDIRECT` there sends the visitor to
`redirectLocation`, and the config check of `npm run test` then accepts a `redirectLocation` without
`redirectReasons`. The page's other texts are fixed, in English: "We could not check your browser.", **Try again**,
"Please allow cookies for this site, then reload the page.", "Please turn on JavaScript, then reload the page.",
`Ray ID:` and "Protected by Cheq.ai".

**`challengingStrategy` is not used for page loads while the interstitial is on.** Only a `GET` page load can get the
interstitial. Every other request (a `POST`, a `HEAD`, a script's `fetch`) gets the answer it gets with the
interstitial off, `challengingStrategy` included (see
[The interstitial and the CAPTCHA](#the-interstitial-and-the-captcha)).

**Cold start.** The Worker logs one warning per problem, as
`[interstitial] <problem> (see "Interstitial" in the README)`, after the `[challenge]` warning and before the
`[config]` warnings of `actionOnSuspicious`. The problems:

- `interstitial.tag is not set, the interstitial is off: paste the tag line from the CHEQ console` (as shipped)
- `interstitial.tag cannot be read (<why>), the interstitial is off`, see [The tag line](#the-tag-line)
- `interstitial.enabled: <value> is not true or false, the interstitial is off`
- `interstitial.<setting>: <value> is not <what is allowed>, using <default>`, for example
  `interstitial.maxWaitMs: 10 is not a whole number from 1000 to 30000, using 5000`
- `interstitial.tag: the hash in its src is not tagHash, check that the tag line and tagHash belong to the same tag`
- `challengingStrategy is set but not used for page loads while the interstitial is on`
- `interstitial settings could not be read (<message>), the interstitial is off`, when reading them throws (for
  example on a value that JSON cannot write, such as a bigint)

Cloudflare only for now: CloudFront and the other CDNs do not read `interstitial`.

Each setting in full, below: [`enabled`](#enabled), [`tag`](#tag), [`onSecondVerdict`](#onsecondverdict),
[`onSessionNotFound`](#onsessionnotfound), [`maxWaitMs`](#maxwaitms), [`statusCode`](#statuscode),
[`originalRefererVia`](#originalreferervia), [`binding`](#binding),
[the page's look](#the-pages-look-logourl-headline-message-lang) and [`logOutcomes`](#logoutcomes).

##### `enabled`

Turns the interstitial on or off.

- `true`: on, as soon as `tag` holds a tag line that can be read. In `BLOCKING` mode a `GET` page load that RTI wants
  challenged can then get the page (see [How it works](#how-it-works)). In `MONITORING` mode no page is shown, and the
  Worker logs a `would-show` line instead.
- `false`: off ("Standard mode"). A suspicious page load gets what it got before the interstitial existed: by default
  the CAPTCHA, when `challenge` is set (see [Which request gets a page](#which-request-gets-a-page)), and without a
  `challenge` it is forwarded with `x-cheq-rti-result`.
- The shipped `config.ts` has `true`. `tag` ships as `"REPLACE_ME"`, so the interstitial stays off until you paste
  your tag line.
- Any other value, and a block without `enabled`: off, with the warning
  `interstitial.enabled: <value> is not true or false, the interstitial is off`. Only the boolean `true` switches it
  on: the string `"true"` does not.
- No `interstitial` block at all: off, without a warning.

##### `tag`

Your CHEQ tag line. The page loads your tag from it.

- Paste the whole `<script …></script>` line of the tag snippet in the CHEQ console, as one string in single quotes.
  [The tag line](#the-tag-line) shows an example and lists what is kept, left out and refused.
- The Worker never writes the line into the page as text. It reads the line's attributes once, at cold start, and
  leaves out `async`, `defer` and every `on…` attribute. The page's script builds the tag's `<script>` element from the
  attributes that are left.
- Not set (`"REPLACE_ME"`, empty, or not a string): off, with the warning
  `interstitial.tag is not set, the interstitial is off: paste the tag line from the CHEQ console`. This is the
  shipped state.
- A line that cannot be read (not one `<script>` element, text between the tags, a `src` that is not `https://`, no
  `class`, longer than 800 characters, an unsafe attribute name or value): off, with the warning
  `interstitial.tag cannot be read (<why>), the interstitial is off`.
- The hash in the `src` (`/i/<hash>.js`) must be your `tagHash`. If it is not, the Worker warns at cold start, and the
  interstitial stays on.
- The tag needs its option `ck4`. The page waits for the tag's `_cq_pvid` cookie, and the tag writes it only with
  `ck4` (read in adserver on 2026-11-17). RTI looks up the tag's session by that cookie (the product spec, FR-4). So
  without `ck4` the page waits the whole `maxWaitMs`, RTI finds no tag session on the reload, and `onSessionNotFound`
  decides. On a test host such as `*.cloudfront.net` the tag also needs `apd` (see [The tag line](#the-tag-line)).

##### `onSecondVerdict`

What a suspicious page load gets when the tag has run.

- When it applies: RTI wants a `GET` page load challenged, and RTI has found the tag's session
  (`sessionFound: true`). That happens on the reload right after the interstitial, when the tag did its work. It also
  happens on a later page of a visitor whose tag ran on an earlier page: that visitor gets no interstitial, and this
  setting decides at once.
- It does not apply when RTI says benign (the page) or malicious (the block), nor to a request that is not a page
  load.
- `Action.ALLOW` (the default, as the product spec asks): the page, forwarded to your origin with
  `x-cheq-rti-result` (`verdict=suspicious`). The origin's HTML answer reaches the visitor with
  `Cache-Control: no-store` (see [Which request gets a page](#which-request-gets-a-page)).
- `Action.BLOCK`: what `blockingStrategy` gives. By default that is the block page (403). It can also be a 404, a
  redirect or the CAPTCHA, if `blockingStrategy` says so.
- `Action.REDIRECT`: a 302 to `redirectLocation`. Set `redirectLocation`. The config check of `npm run test` then
  accepts it without `redirectReasons`.
- `Action.CHALLENGE`: the CAPTCHA of `challenge` (the Turnstile example), whatever `challengingStrategy` says. A
  valid CAPTCHA pass (`_cq_se`) skips it, and the page is forwarded. Without a `challenge` the page is forwarded with
  the verdict. See [The interstitial and the CAPTCHA](#the-interstitial-and-the-captcha).
- A wrong value: a warning, and `Action.ALLOW`.
- On the reload, the log line says `second-verdict:<ACTION>` (see [Monitoring and logs](#monitoring-and-logs)).

##### `onSessionNotFound`

What a suspicious page load gets when the tag did not run, right after the interstitial.

- When it applies: RTI wants a `GET` page load challenged, RTI has no tag session (`sessionFound` is `false` or
  missing), and the request carries a valid mark: the cookie that the interstitial page wrote, valid for 60 seconds
  (see [The mark cookie](#the-mark-cookie)). This is the reload of a visitor whose tag was blocked (an ad blocker, a
  DNS filter), failed to load, or whose session had not reached RTI yet.
- Without this setting such a visitor would get the interstitial again and again. With it, that visitor gets no second
  interstitial (the product spec's loop guard, FR-6).
- The mark counts on every page of your site for its 60 seconds. So such a visitor gets this setting's answer on each
  page in that time, not a new interstitial.
- The values are the four of `onSecondVerdict`, with the same results: `ALLOW` forwards with the verdict (the origin's
  HTML answer reaches the visitor with `Cache-Control: no-store`), `BLOCK` gives what `blockingStrategy` gives,
  `REDIRECT` a 302 to `redirectLocation`, `CHALLENGE` the CAPTCHA.
- Default `Action.ALLOW`: the product spec's FR-6 makes "open" the default and leaves the choice to each site.
- The trade-off. `ALLOW` lets a client pass after one extra request when it blocks the tag, or copies the mark out of
  the page without running it. `BLOCK` or `CHALLENGE` stops such a client, but also stops real visitors whose ad
  blocker blocks the tag. The product spec asks to check first whether ad and tracker block lists include
  `tag.cheqzone.com`.
- A wrong value: a warning, and `Action.ALLOW`.
- On the reload, the log line says `no-session:<ACTION>`.

##### `maxWaitMs`

How long the page waits for the tag, in milliseconds.

- The page reloads as soon as one of these happens: the tag writes a new `_cq_pvid` cookie (the page checks every
  50 ms), the tag's script fails to load, or adding the tag fails. If none happens, it reloads after `maxWaitMs`.
- Default `5000`. Allowed: a whole number from 1000 to 30000. A wrong value: a warning, and `5000`.
- Too short: the page can reload before the tag's data has reached RTI, and the visitor gets `onSessionNotFound`
  instead of the tag's verdict. Too long: a visitor whose tag hangs looks at the page longer. A tag whose script cannot
  load ends the wait at once, through its load error (seen in a local Chrome run with a tag that answered 404).
- The Worker accepts the page's mark until `maxWaitMs` plus 70 seconds after the page was served: the cookie's 60
  seconds, plus 10 seconds for the page to arrive. So a long wait does not make the mark expire early.
- The product spec's target for a flagged visitor: at most 1.5 seconds added, at p75.

##### `statusCode`

The HTTP status that the interstitial page is sent with.

- Default `403`. Allowed: `200`, or a whole number from 400 to 599. A wrong value: a warning, and `403`.
- The visitor sees the same page either way: the browser shows it and runs its script. A local Chrome run with `403`
  reloaded as expected.
- The status tells crawlers, monitors and log tools whether this answer is the page's content. `403` says it is not.
  `200` would make the page look like your page in such tools. The page is also sent with
  `Cache-Control: no-store, no-cache, must-revalidate` and `X-Robots-Tag: noindex`, and holds
  `<meta name="robots" content="noindex">`, so it is not cached and not indexed.
- Good bots (crawlers such as Google's and Bing's) are expected to get a benign verdict from RTI, and so no page. If
  your policy makes them suspicious, they get the page like any visitor, whatever the status (see
  [How it works](#how-it-works)).
- The product spec leaves the status to an SEO review. `403` is the default until then.
- A prefetch never gets the page. Where the page would be shown, a prefetch gets an empty 403, whatever this setting
  says.

##### `originalRefererVia`

How your site learns where the visitor came from, after the interstitial.

- Why it is needed: our page starts the reload, so the reload's own `Referer` is the page itself (seen in a local
  Chrome run). Without help, your origin would see its own URL as the referrer, instead of a search engine or a
  campaign.
- What is carried: the Referer of the first request, as a browser sends it by default. From another site that is only
  its origin, such as `https://www.google.com/`. From your own site it is the full URL, unless it is the page itself.
- `"header"` (the default): on the reload, the Worker adds `x-cheq-original-referer: <where the visitor came from>` to
  the request your origin gets, and to the headers RTI gets. Your origin reads that header. It is added on the page the
  visitor asked for; a page your origin redirects the reload to does not get it, with one exception in
  [Known limits](#known-limits).
- `"cookie"`: the page's script writes a `_cq_ref` cookie for 60 seconds, holding the page's address and where the
  visitor came from, in the format of the CAPTCHA's `_cq_ref`. Your site's own script reads it. Neither your origin nor
  RTI gets `x-cheq-original-referer` in this mode. No `_cq_ref` is written when there is no original Referer.
- Use the same value as the CAPTCHA's `originalRefererVia` (in `turnstileConfig`, `"header"` when left out), so a
  visitor who gets both pages gives your site the same signal.
- A wrong value: a warning, and `"header"`.
- Details: [The original Referer after the interstitial](#the-original-referer-after-the-interstitial).

##### `binding`

Which client a mark belongs to. The same shape and default as the CAPTCHA's `sessionBinding`.

- The mark is signed together with the client's IP address and User-Agent, as this setting says. A request from
  another IP address, or with another User-Agent, has no valid mark.
- `ip: "exact"` (the default): the IP address (`CF-Connecting-IP`) must be the same. `ip: "none"`: not checked.
- `userAgent: true` (the default): the User-Agent must be the same. `false`: not checked.
- Give both fields. `{ ip: "none" }` alone is a wrong value: a warning, and the default.
- When the IP changes between the page and the reload (a VPN, iCloud Private Relay, a phone that switches networks),
  the Worker finds no valid mark. If RTI still wants the request challenged, the page comes again, and its script
  finds its own mark and stops with "We could not check your browser." and a **Try again** button. It does not loop.
- `ip: "none"` spares those visitors. Its cost: a mark copied to another client is accepted from any IP address for
  its 60 seconds.

##### The page's look: `logoUrl`, `headline`, `message`, `lang`

Your branding on the page (the product spec's FR-9). Leave them out for CHEQ's look.

- `logoUrl`: the `https://` address of an image you host, at most 200 characters, also as the URL parser writes it.
  It is shown in place of CHEQ's logo, as an image with an empty `alt`. Default: CHEQ's logo, inline in the page. If
  your image does not load, the page still works.
- `headline`: the page's heading and its `<title>`, 1 to 60 characters. Default `Checking your browser`.
- `message`: the text under the heading, 1 to 160 characters. It sits in a live region (`role="status"`), so screen
  readers announce it. Default `This usually takes about a second.`
- `lang`: the page's language, as in `<html lang="…">`: a tag such as `en` or `en-US`, at most 35 characters. Default
  `en`.
- The texts are escaped for HTML: they are shown as written and cannot add markup.
- The page's other texts are fixed, in English: "We could not check your browser.", **Try again**, "Please allow
  cookies for this site, then reload the page.", "Please turn on JavaScript, then reload the page.", `Ray ID:` and
  "Protected by Cheq.ai". They stay in English whatever `lang` says.
- A wrong value: a warning, and that setting's default.

##### `logOutcomes`

Whether the Worker sends a log line for each interstitial decision.

- `true` (the default): lines go to the RTI logger, as info lines: `shown` when a page is served, `would-show` in
  `MONITORING` mode, and on the reload `passed`, `blocked`, `redirected`, `second-verdict:<ACTION>` or
  `no-session:<ACTION>`. Each line has the ray ids, the verdict, RTI's reason codes and the `cf-ray`. The formats are
  in [Monitoring and logs](#monitoring-and-logs).
- These lines are how you count what the interstitial does: how many pages were served, and what the reloads got (the
  product spec's FR-6 and its launch number). A count per interstitial takes the first reload line per `firstRayId`.
- `false`: no such line goes to the RTI logger. With `debug: true` the lines still go to the console. Errors are logged
  as before (`logErrors`).
- `customId3` on RTI's second call does not depend on this setting.
- A wrong value: a warning, and `true`.

#### The tag line

Paste the tag line of your tag snippet in the CHEQ console into `tag`, as one string: the whole
`<script …></script>` line. Put it in single quotes, because the line holds double quotes:

```ts
tag: '<script async src="https://…/i/<tagHash>.js" data-ch="…" class="ct_clicktrue_…" data-jsonp="…"></script>',
```

The Worker reads the line once, at cold start. It never writes the line into the page as text: the page's script
builds the `<script>` element itself and sets the line's attributes on it one by one, so nothing in the line can
become markup or code of the page.

- **Kept:** every attribute but the ones left out below, so the tag gets the settings it has on your own pages. Names
  come out in lower case.
  Of two attributes with the same name, the first is kept. A value can be in double quotes, in single quotes or
  without quotes. In a value, `&amp;`, `&quot;`, `&#39;`, `&lt;` and `&gt;` are read as the characters they stand for,
  and any other `&…;` stays as written. `data-jsonp` is kept too: the function it names is on your pages, not on
  ours, and the design says that the tag skips a callback that does not exist (read in adserver on 2026-11-17).
- **Left out:** `async` and `defer` (the design says that a script added by code is asynchronous anyway), and any
  attribute whose name starts with `on` (an event handler would be code in our page).
- **Refused:** a line that does not fit turns the interstitial off, with the warning
  `[interstitial] interstitial.tag cannot be read (<why>), the interstitial is off (see "Interstitial" in the README)`.
  `<why>` is one of these, in the order they are checked:
  - `it is longer than 800 characters` (without the whitespace around it)
  - `it is not one <script …></script> element`
  - `it has text between <script> and </script>`
  - `it has an attribute name a page cannot set: <name>` (a name must match `^[A-Za-z][A-Za-z0-9_.:-]*$`)
  - `it has a value with <, > or a control character`, after the five character references above are read. The line
    separator and the paragraph separator (U+2028, U+2029) count as control characters here.
  - `its src does not start with https://` (also for a `src` that is not a URL)
  - `it has no class`: the design says that the tag finds its own element by its class (`ct_clicktrue_<id>`) and
    reads its settings from that element (read in adserver on 2026-11-17)

  The attributes that are left out are not checked. A line that is missing, blank or still `REPLACE_ME` gives
  `interstitial.tag is not set, …` instead.

**Your tag needs its option `ck4`.** The tag writes `_cq_duid` and `_cq_pvid` only when `ck4` is on (read in adserver
on 2026-11-17), and the page waits for a new `_cq_pvid`. Without `ck4` each interstitial waits the whole `maxWaitMs`
before it reloads. The design says that a tag's options are part of the script it is served as: the test tag's `.js`
file holds `"ck4":1,"ck":1,"apd":1`. So open the `src` of your tag line and look for `"ck4":1`.

**On a test host such as `*.cloudfront.net` the tag also needs its option `apd`.** The tag writes its cookies for the
site's main domain (`.shop.com`, read in adserver on 2026-11-17). Where that domain is a public suffix, the browser
refuses the cookie: Chrome did on `*.cloudfront.net` (checked on 2026-11-18). `apd` makes the tag write them for the
host only. `*.workers.dev` was not checked.

**`tagHash`.** The hash in the line's `src` (the `<hash>` of `…/i/<hash>.js` at the end of its path) should be your
`tagHash`. When it is not, or one of them is missing, the Worker logs once per cold start
`[interstitial] interstitial.tag: the hash in its src is not tagHash, check that the tag line and tagHash belong to the same tag (see "Interstitial" in the README)`.
The interstitial stays on.

#### The interstitial and the CAPTCHA

"CAPTCHA on" means that `config.challenge` is set: with the shipped Turnstile example, once its three secrets are
filled in. "Interstitial on" means that `enabled` is `true` and the tag line can be read. The tables are for
`BLOCKING` mode and a `GET` page load that RTI wants challenged, from a visitor for whom RTI has no tag session yet.

| Interstitial | CAPTCHA | The first page the visitor gets |
|---|---|---|
| off | off | None. The request goes to the origin with `x-cheq-rti-result`. |
| off | on | The CAPTCHA, as before. |
| on | off | The interstitial. |
| on | on | The interstitial. |

After the interstitial the page reloads, and RTI answers a second time:

| RTI's second answer | What happens |
|---|---|
| Benign | The origin. |
| Malicious | The `blockingStrategy` answer: the block page by default. |
| Suspicious again, and RTI found the tag's session (`sessionFound: true`) | The setting `onSecondVerdict`. |
| Suspicious again, and RTI found no tag session | The setting `onSessionNotFound`. |

Both settings take the same four values:

| Value | What the visitor gets |
|---|---|
| `Action.ALLOW` (default) | The origin, with `x-cheq-rti-result`. |
| `Action.BLOCK` | The `blockingStrategy` answer: the block page by default. |
| `Action.REDIRECT` | A 302 to `redirectLocation`. |
| `Action.CHALLENGE` | The CAPTCHA when it is on, whatever `challengingStrategy` says. As for any CAPTCHA, a valid session (`validateChallenge`; `_cq_se` with the Turnstile example) waives it, and a prefetch gets the empty 403. When the CAPTCHA is off: the origin, with `x-cheq-rti-result`. |

So a visitor sees both pages only when the CAPTCHA is on and the reload gets it: one of the two settings is
`Action.CHALLENGE`, or the reload gets a block (RTI's second answer is malicious, or a setting is `Action.BLOCK`) with
`blockingStrategy: CAPTCHA`. The interstitial is then the first of the two:

```
1  GET /sofas  (from Google)   RTI: suspicious         -> the interstitial
2  the tag runs, the page reloads
3  GET /sofas                  RTI: suspicious again   -> the CAPTCHA (onSecondVerdict is CHALLENGE)
4  the visitor solves it       the Worker checks it    -> 302 to /sofas, with the pass cookie _cq_se
5  GET /sofas                  RTI: suspicious again   -> the pass is valid -> the origin
```

- Request 5 gets no second interstitial, because RTI knows the visitor's tag session by then. It gets no second
  CAPTCHA, because of the pass.
- In `"header"` mode the origin gets `x-cheq-original-referer: https://www.google.com/` on request 5, as after the
  CAPTCHA alone. In `"cookie"` mode `_cq_ref` holds it (see
  [The original Referer after the interstitial](#the-original-referer-after-the-interstitial)).
- A visitor whose tag did not run has no tag session. Once their mark has expired (the browser keeps it 60 seconds),
  the next page load that RTI wants challenged gets the interstitial again. A valid CAPTCHA session does not change
  that: it waives only the CAPTCHA, so this can happen right after a CAPTCHA that took longer than the mark's 60
  seconds to solve.
- In `MONITORING` mode no page is shown in any row. The Worker logs what it would have shown (see
  [Monitoring and logs](#monitoring-and-logs)).

**Only a `GET` page load can get the interstitial, and `challengingStrategy` is not used for page loads while the
interstitial is on.** A rule of `actionOnSuspicious` that covers such a page load still decides, and its
`Action.CHALLENGE` means the interstitial. `Action.CHALLENGE` in `onSecondVerdict` or `onSessionNotFound` means the
CAPTCHA. Every other request (a `POST`, a `HEAD`, a script's `fetch`) gets the answer it gets with the interstitial off,
`challengingStrategy` included. With the default `challengingStrategy` (`CAPTCHA`), a rule or a method default of
`actionOnSuspicious` decides, and without one the request is forwarded with `x-cheq-rti-result` (see
[Which request gets a page](#which-request-gets-a-page)). A request with a body can get the CAPTCHA there, as before.
Another `challengingStrategy` (`ACCESS_DENIED`, `NOT_FOUND` or `REDIRECT`) applies to such a request as before: it gets
that answer, and `actionOnSuspicious` is not asked. With `challengingStrategy` set, the Worker logs once per cold start
`[interstitial] challengingStrategy is set but not used for page loads while the interstitial is on (see "Interstitial" in the README)`.

#### The mark cookie

```
_cq_it=<setup id>|<expiresAt>.<signature>|<ray id of RTI call 1>|<page tag>|<original Referer>
    ; Max-Age=60; Path=/; SameSite=Lax; Secure (on https only); Domain=<the site's main domain, when the browser accepts it>
```

**What it is for.** The page's script writes it right before the reload, and the reload brings it. It says that the
page ran, so a visitor whose tag did not run gets `onSessionNotFound` and not the page again. And it carries where the
visitor came from before the page (see
[The original Referer after the interstitial](#the-original-referer-after-the-interstitial)).

- **The setup id:** 8 hex characters of a keyed hash, made from the mark's key. It does not reveal the key. A mark with
  another setup's id is no mark for this Worker, and the page's own mark replaces it.
- **`expiresAt`:** when the Worker stops accepting the mark: `maxWaitMs` plus 70 seconds after the page was served.
  The browser keeps the mark 60 seconds from the moment the script writes it (up to `maxWaitMs` after the page
  started), and 10 seconds are allowed for the page to arrive. The 10 seconds are an allowance, not a measurement.
- **The signature:** HMAC-SHA256, its first 32 hex characters, over
  `JSON.stringify(["it", expiresAt, rayId, pageTag, referer, bindingKey])`, the way the CAPTCHA signs `_cq_rf`. The
  key is made from your `apiKey`, so there is no new secret to set. A new `apiKey` ends every open mark.
- **The page tag:** 16 hex characters of a keyed hash of the URL's path, so the cookie stays short for any URL.
- **The ray id and the original Referer** are URL-encoded. The Referer is empty when there is none.
- **60 seconds:** the script writes the mark with `Max-Age=60`. Without `Secure` on plain http, so that a local run
  works.
- **The binding.** A mark is valid only for the client it was made for, like the CAPTCHA's session. `binding` has the
  shape and the default of the CAPTCHA's `sessionBinding` (see [Session binding](#session-binding)): the client's IP
  (`CF-Connecting-IP`) and its User-Agent. The mark holds neither: they are only part of what is signed. A request
  from another IP or with another User-Agent has no valid mark. For visitors whose IP changes between the page and the
  reload (a VPN, iCloud Private Relay, a pool of addresses), set `binding: { ip: "none", userAgent: true }`.
- **Checked on every request** while the interstitial is on, after the ignored paths and before RTI is called. Only the
  first `_cq_it` with this setup's id is checked. A missing, expired, forged or foreign mark is ignored without a log
  line, and RTI is called as for any request.

**Why a cookie that the page's script writes.** A `Set-Cookie` on our page would hand the mark to any client that
keeps cookies, also to one that does not run the page. **Option C, not built:** the page tells the Worker "I ran", and
the Worker remembers the IP, User-Agent, URL and Referer for 60 seconds in Cloudflare's Cache API or in KV, so nothing
goes into the browser. The design says that the Cache API works per data center and does nothing on `*.workers.dev`,
that KV needs a namespace per customer, and that a visitor whose IP changes is not recognized.

**For the site's main domain.** The script tries `Domain=` values built from the host name, from the shortest with two
labels upward (`shop.com`, then `www.shop.com`), and keeps the first whose new value it can read back. A browser
refuses a cookie for a public suffix (Chrome did for `cloudfront.net`, the design says), so the next one is tried.
With a `Domain=` kept, the mark is sent to every host of that domain for its 60 seconds, and a reload that the origin
redirects to the `www` host shows no second interstitial. For an IP address, for a host with one label (`localhost`),
and when none of the `Domain=` values can be read back, the mark is written for the host only. Nobody has run this in
a browser yet, and a local run on `localhost` cannot show it.

**The mark counts on every page of the site, not only on the page it was made for** (a decision of 2026-11-22). Why:
an origin often answers the reload with a redirect (a trailing slash, a locale, a campaign URL), and a mark for one
page only would give a visitor whose tag did not run a second interstitial on the redirect target. Whom it concerns:
only a client for whom RTI has no tag session, because its tag did not run or the reload came too early. When RTI has
the session, `onSecondVerdict` applies and the mark is not used. The price: for the 60 seconds of the mark, such a
client gets the no-session action (`onSessionNotFound`) on every page of the site that RTI wants challenged, without a
new interstitial. The mark's Referer and `customId3` stay on the mark's own page (its path).

#### The original Referer after the interstitial

The same as after the CAPTCHA (see [The original Referer](#the-original-referer)). After the reload the browser's
`Referer`, and `document.referrer` on your page, is the page's own URL: the design says that Chrome sends it on a
script's reload (tested on 2026-11-17), and a local run with Chrome 157 saw it sent without the `#fragment`
(2026-11-23). So the mark carries the original Referer of the request that got the page,
built as the CAPTCHA builds it: from another site only its origin (`https://www.google.com/`), from this host the full
URL without the `#fragment`, cut to 420 characters, and nothing for no Referer. When that request already carried an
`x-cheq-original-referer` that this Worker set, that value goes into the mark.

The Worker uses the mark's Referer only on a page load of the mark's own path whose own `Referer` is missing or is the
page itself (the same host, path and query). A request that brings another Referer keeps its own, for example a click
from another page of the site within the 60 seconds.

On plain http a link from an https site brings no Referer under Chrome's default referrer policy: in a local run on
`http://localhost`, Chrome 157 sent none from `https://www.google.com/`, so the mark had none. With the referrer policy
`origin` set on that navigation, it sent `https://www.google.com/`. Check the original Referer on an https site.

`originalRefererVia` (the interstitial's own setting, default `"header"`) says how the value is delivered, as the
CAPTCHA's setting of the same name does:

- `"header"`: on the reload the Worker adds `x-cheq-original-referer` to the request, before RTI is called. RTI and the
  origin get it. A value that `config.originalReferer` gives (with the Turnstile example, a valid `_cq_rf`) wins.
- `"cookie"`: when there is an original Referer, the page's script also writes `_cq_ref`, in the CAPTCHA's format
  `{return URL}|{Referer}` (both URL-encoded; the return URL is the page's path, query and `#fragment`), with
  `Max-Age=60; Path=/; SameSite=Lax`, `Secure` on https, and the mark's domain. The Worker never reads it and adds no
  header, so RTI does not get the value, and the origin gets it only inside the `Cookie` header. The one exception:
  when a CAPTCHA follows on the reload, the request that `config.challenge` gets carries the header for that call only,
  so the CAPTCHA page can carry the value on. It is taken off again before the request goes on.

The same snippet as for the CAPTCHA reads `_cq_ref` (see [The original Referer](#the-original-referer)). In the chain
with both pages, the interstitial's `_cq_ref` (for the main domain) and the CAPTCHA's (for the host) can both be
there. They hold the same Referer.

The Referer's way in both modes, with the interstitial and the CAPTCHA set to the same mode (`originalRefererVia` here
and in `turnstileConfig`). Inside the Worker the way is the same in both modes: the Worker checks the mark and hands the
value to the CAPTCHA page on the request. The mode decides only who gets the value at the end.

| Step | `"header"` | `"cookie"` |
|---|---|---|
| The interstitial's script, before the reload | Writes the mark. | Writes the mark, and `_cq_ref` for the site's scripts when there is an original Referer. |
| The reload: the Worker, before RTI | Checks the mark and sets `x-cheq-original-referer` on the request. RTI gets it. | Checks the mark and keeps the value. RTI gets no extra header. |
| No CAPTCHA follows | The origin gets the header on this request. | No header is added. `_cq_ref` is in the browser: the site's scripts read it, and the origin gets it in the `Cookie` header. |
| A CAPTCHA follows: its page | Reads the header from the request. | Reads the header, which the Worker added to this request for the page only. |
| The 302 after the solve | Sets `_cq_rf` (signed). | Sets `_cq_ref` (readable). |
| The landing request | The Worker reads `_cq_rf` and sets the header. The origin and RTI get it. | No header is added. The site's scripts read `_cq_ref`, and the origin gets it in the `Cookie` header. |

`document.referrer` on your page is the page's own URL in both modes, as after the CAPTCHA. No page of ours can change
that.

#### Monitoring and logs

Two kinds of lines go to the RTI logger as info lines, through `waitUntil`, unless `logOutcomes` is `false`. With
`debug: true` they also go to the console:

```
interstitial: shown, rayId=<ray id of call 1>, verdict=<verdict>, reasons=<codes>, request=<cf-ray>
interstitial: <outcome>, firstRayId=<ray id of call 1>, rayId=<ray id of call 2>, verdict=<verdict>, reasons=<codes>, sessionFound=<true|false|null>, request=<cf-ray>
```

- **`shown`** is written when the page is served.
- **`would-show`** takes its place in `MONITORING` mode. No page is shown there, and the request goes on as usual. The
  line says that the page load would get the page in `BLOCKING` mode: RTI wants it challenged, the strategy is
  `INTERSTITIAL`, the decision is "show" (so a tag session or a valid mark gives no line), and it is not a
  prefetch.
- **The reload line** (the second format) is written in `BLOCKING` mode for a page load with a valid mark for its own
  page, when it is not a prefetch. `<outcome>` is `passed`, `blocked` or `redirected` when RTI's action is ALLOW,
  BLOCK or REDIRECT. When RTI wants it challenged again, it is `second-verdict:<ACTION>` or `no-session:<ACTION>`, with
  the value of `onSecondVerdict` or `onSessionNotFound` (`ALLOW`, `BLOCK`, `REDIRECT` or `CHALLENGE`). A reply to the
  CAPTCHA page that the CAPTCHA answers gets no line. Neither does a challenge for which a rule of
  `actionOnSuspicious` gives `ALLOW`, `BLOCK` or `REDIRECT`. A rule's `CHALLENGE` gets the line,
  as without a rule. A reply that RTI blocks or redirects is not answered by the CAPTCHA: with a valid mark for its
  page it gets a `blocked` or `redirected` line.
  The first ray id comes from the mark, so the two lines of one visitor can be joined. A `shown` line without
  a reload line means that the visitor left. A redirect of the reload to the same path gives a second reload line with
  the same `firstRayId` (see [Known limits](#known-limits)), so a count per interstitial takes the first line per
  `firstRayId`.
- `reasons=` holds RTI's reason codes joined with `,` (empty without any), `sessionFound=` is RTI's
  `metadata.sessionFound` (`null` when RTI does not say), and `request=` is the `cf-ray` value, or
  `unknown_request_id`.

**`customId3`.** A request with a valid mark for its own page (its path) sends RTI
`customId3: interstitial:<ray id of call 1>`, in both modes. In RTI's data the row of call 2 can then be joined to
the row of call 1. A visitor who loads the same page again within the mark's 60 seconds is marked again, so a query
takes the first row per ray id.

**Debug lines** (`debug: true`): `interstitial: forward, <reason>` when the interstitial's decision sends the request on
with the verdict, where `<reason>` is `not-a-page-load`, and
`prefetch: an empty 403 in place of the interstitial`. The strategy line reads `action strategy: INTERSTITIAL (4), …`.

**Errors** are logged as `Interstitial error handling request '<id>'`, to the console and, unless `logErrors` is
`false`, to the RTI logger. An error while the mark is read counts as no mark (RTI is still called). An error in one of
the lines above (`shown`, `would-show` or a reload line) changes nothing else: the request gets the answer it gets
without the line, such as the page or the block page. An error in the decision or the page forwards the request with
the verdict. A CAPTCHA that the decision leads to keeps its own error handling (`Challenge error handling request
'<id>'`, forwarded without the verdict).

#### Known limits

- **A client can avoid the page by not asking for one.** A bot can send the headers of a script's call
  (`Sec-Fetch-Dest: empty`), and a client such as `curl` does not ask for a page at all. Such a request gets no page,
  neither the interstitial nor the CAPTCHA, and is forwarded with the verdict. `methods: { GET: Action.CHALLENGE }`
  gives such a `GET` the CAPTCHA (see [Which request gets a page](#which-request-gets-a-page)).
- **A page that a site names in `<link rel="prefetch">`** is asked for as a background request and forwarded with the
  verdict. Its HTML answer gets `Cache-Control: no-store` (see the known limits of
  [Which request gets a page](#which-request-gets-a-page)), so the click goes to the Worker and gets the interstitial
  like any page load. That was seen for the CAPTCHA in Chromium 131 on 2026-11-24; nobody ran it with the interstitial.
- **A suspicious prefetch of a page gets an empty 403,** with no mark and no log line.
- **With `onSessionNotFound: Action.ALLOW` (the default), a client that blocks the tag passes** after one extra
  request: the page, then the reload with the mark.
- **A client that copies the mark out of the page** without running it gets the no-session action, like a client that
  blocks the tag. The mark is in the page's script.
- **For the 60 seconds of a mark, a client without a tag session gets the no-session action on every page of the
  site that RTI wants challenged,** not only on the page that showed the interstitial (see
  [The mark cookie](#the-mark-cookie)).
- **A visitor whose tag is blocked gets the interstitial again,** about once a minute (each time the mark has expired),
  as long as RTI wants their page loads challenged.
- **Reload too early.** The design says that the tag's server saves a new session in its own region at once and copies
  it to the other regions in the background (read in adserver on 2026-11-17). If the reload's RTI call lands in another
  region within the first moments, RTI answers `sessionFound: false`, and the visitor gets the no-session action
  without the tag's verdict. Not built: when a valid mark comes with a `_cq_pvid` cookie and RTI says `false`, wait
  about 300 ms and call RTI once more.
- **A visitor whose IP or User-Agent changes** between the page and the reload has no valid mark. When RTI has no tag
  session either, the visitor gets the page again, and it shows "We could not check your browser." with **Try
  again**. `binding: { ip: "none", userAgent: true }` turns the IP part off.
- **Two tabs of a flagged visitor at the same time:** the second tab can find the first tab's fresh mark and show "We
  could not check your browser." One click on **Try again** recovers.
- **A tab that the browser freezes or slows** while the page waits for the tag (a background tab, an app switch on a
  phone) can write the mark late. If it is more than the 10-second allowance late, the browser keeps the mark longer
  than the Worker accepts it, and a page load in that time shows the same text when RTI has no tag session. One click
  on **Try again** recovers. In a local run, headless Chrome 157 reloaded a tab that was hidden from the start after
  1.4 seconds (0.4 seconds in front), without that text. Nobody tried a tab hidden for minutes.
- **Cookies blocked:** the page cannot keep the mark, so it shows "Please allow cookies for this site, then reload the
  page." and does not reload. **JavaScript off:** it shows "Please turn on JavaScript, then reload the page." Both
  visitors stay on the page as long as RTI wants their page loads challenged.
- **A good bot that your policy makes suspicious gets the interstitial like any visitor.** Good bots (crawlers such as
  Google's and Bing's) are expected to get a benign verdict from RTI, and so no page. A crawler that runs no JavaScript
  cannot pass the page. Fix it in the policy screen of the CHEQ console, not in the Worker.
- **A second page load of the same page within the mark's 60 seconds that brings no Referer of its own** (the visitor
  reloads, or types the address again) gets the mark's Referer once more, and `customId3` again.
- **After a redirect of the origin, the target page gets no original Referer from the mark,** as the CAPTCHA's `_cq_rf`
  is given only on its landing page. The exception is the next point.
- **A redirect target with the mark's path that brings no `Referer` of its own also gets the mark's original
  Referer:** the origin redirects the reload to the `www` host, or drops the query, and the browser sends no Referer on
  the redirect. In `"header"` mode the origin can then see `x-cheq-original-referer` on the reload and again on the
  target. Seen in a local Chrome run: with `Referrer-Policy: no-referrer` on the origin's 302 from `/sofas?gclid=abc` to
  `/sofas`, both requests carried the header, at the origin and in RTI's payload. Without that policy only the reload
  carried it. A signed tag over the host, path and query would prevent it, and was not built.
- **A redirect of the reload to a host of another main domain** does not take the mark along, so a visitor without a
  tag session gets a second interstitial there. A host where the Worker does not run ignores the mark.
- **Hosts of the main domain that run the Worker with different setups** (another `apiKey`) each ignore the other's
  mark, with no error page. The two marks have the same name, `Domain` and `Path`, so each one replaces the other (a
  new cookie with the same name, domain and path removes the old one: RFC 6265, section 5.3, step 11, read on
  2026-11-23). A visitor without a tag session who goes back and forth between the hosts gets the interstitial at each
  switch, as long as RTI wants their page loads challenged.
- **`customId3` and the reload line repeat when the origin redirects the reload to the same path,** on the same host
  (dropping the query, for example) or on another host of the main domain. A local Chrome run saw two
  `second-verdict:ALLOW` lines with the same `firstRayId` for one interstitial. So a count of outcomes per interstitial
  takes the first line per `firstRayId`, and a query of RTI's data the first row per ray id.
- **The reload line names RTI's action, not what the visitor got:** a `BLOCK` with `blockingStrategy: CAPTCHA` logs
  `blocked` while the visitor gets the CAPTCHA (or the site, with a valid `_cq_se`).
- **A request that carries the CAPTCHA's reply** (one that `isChallengeResponse` recognizes: with the Turnstile
  example, `cf-turnstile-response` in the query) goes to `config.challenge` before the interstitial's decision. So with
  `onSecondVerdict` or `onSessionNotFound` set to `Action.BLOCK` or `Action.REDIRECT`, such a request gets the CAPTCHA
  instead. RTI is still called, and the next page load still gets the block.
- **Not checked: a response header that your zone adds to every answer,** such as a `Content-Security-Policy` from a
  Transform Rule, could stop the page's inline script, and the page would then not reload. Nobody checked whether such
  rules apply to an answer the Worker builds. If your zone has one, try a flagged page load once on a test host.

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
> - **Only a page load gets the CAPTCHA page by default.** The old version showed the CAPTCHA page to every request
>   that RTI wanted challenged, whatever its method. Now a page load gets it (a browser's `GET` for a page), unless a
>   rule of `actionOnSuspicious` covers it. Every other request follows `actionOnSuspicious`, which ships with
>   `Action.ALLOW` for all seven methods: it is forwarded to the origin with `x-cheq-rti-result` (see
>   [Which request gets a page](#which-request-gets-a-page)). What a site notices: a `GET` that is not a page load (a
>   script's `fetch`, an API client) is forwarded with `x-cheq-rti-result` where it got the CAPTCHA page before, and so
>   is a suspicious `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS`. Any other method is forwarded too. A
>   suspicious prefetch of a page gets an empty 403 where it got the CAPTCHA page before. One line in `methods` brings
>   the old behavior back for `GET` and `HEAD` (a prefetch keeps the empty 403):
>   `GET: Action.CHALLENGE, HEAD: Action.CHALLENGE`. If a login or checkout form should keep its CAPTCHA (or be
>   blocked), add a rule for its path (see [actionOnSuspicious](#actiononsuspicious)). With `blockingStrategy: CAPTCHA`
>   that includes a request with a body that RTI wants blocked (the old version showed it the CAPTCHA page): set
>   `Action.BLOCK` or `Action.CHALLENGE` to stop it.
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
Request arrives → strategy is CAPTCHA (CHALLENGE by default, for a page load that no rule covers, or for a request
                that actionOnSuspicious sends to the CAPTCHA, see Which request gets a page; or BLOCK with
                blockingStrategy: CAPTCHA; while the interstitial is on, a page load gets the interstitial first,
                and the CAPTCHA when onSecondVerdict or onSessionNotFound is CHALLENGE, see Interstitial)
                and there is no valid session and it is not a prefetch → config.challenge() called
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
     └── no strategy (ALLOW), CAPTCHA or INTERSTITIAL, with or without a session
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

   The page takes it from the request's `x-cheq-original-referer` header when that header has a value, else from the
   request's `Referer`.
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
seconds. While the interstitial is on, a valid mark sets it too: after the interstitial, for the same client, on the
mark's page (see [The original Referer after the interstitial](#the-original-referer-after-the-interstitial)).

**`"header"`:**

- `_cq_rf={expiresAt}.{signature}|{Referer, URL-encoded}`. The signature is an HMAC with `sessionSigningSecret` over
  the expiry, the Referer, the landing page's path and the client binding (IP and User-Agent, per `sessionBinding`),
  like `_cq_se`. A made-up, edited, expired or copied cookie, or one sent to another page, adds no header.
- An `x-cheq-original-referer` sent by the client is removed from the request the Worker forwards, so the header comes
  from `config.originalReferer` (with the example, only after a solved CAPTCHA) or, while the interstitial is on, from
  a valid mark. The exception is Cloudflare's pass-through after a failure, which sends what the client sent (see
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
`_cq_rf` can, or a valid mark of the interstitial), and RTI never gets it: the Worker sends RTI the three CHEQ cookies
of the tag, not the `Cookie` header. The origin gets it inside the `Cookie` header, as the browser sent it, like any
other cookie: it can fool the
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

A custom `challenge` finds the original Referer where the example's challenge page finds it: in the
`x-cheq-original-referer` header of the request it gets when that header has a value, else in its `Referer` (see
[The original Referer](#the-original-referer)).

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
