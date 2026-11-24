// cspell:ignore adserver CHEQ pvid
import { config } from "./config";
import { RTILoggerService } from "../../core/services/rti-logger.service";
import { RTIService } from "../../core/services/rti.service";
import { Action } from "../../core/models/action.model";
import { RTIHelperService } from "../../core/services/rti-helper.service";
import { Ids, RTIResponse } from "../../core/models/rti-response.model";
import { Mode } from "../../core/models/mode.model";
import { name, version } from "../package.json";
import { RequestHeaders, RTIRequest } from "../../core/models/rti-request.model";
import { ActionStrategy } from "../../core/models/action-strategy.model";
import { generateDefaultBlockPage } from "../../core/helpers/block-page-helpers";
import { ResponseHeaders } from "./response-headers";
import { RTIStatelessUtils } from "../../core/services/rti-stateless-utils";
import { InterstitialService } from "../../core/services/interstitial.service";
import { InterstitialFacts, InterstitialRequest, ValidMark } from "../../core/models/interstitial.model";
import { PageLoadHeaders } from "../../core/models/page-load-headers.model";
import { hmacHex32, sessionBindingKey } from "./signing";

const logger = new RTILoggerService(`${name}-${version}`, config);
const rtiHelperService = new RTIHelperService(config);
const rtiService = new RTIService(config);
// The passive interstitial (README, "Interstitial"). It reads config.interstitial and its tag line once, here, and does
// not throw. It holds nothing of a request.
const interstitialService = new InterstitialService(config, hmacHex32);

// Set only from config.originalReferer (see restoreOriginalReferer; with the shipped example, after a solved CAPTCHA),
// or in the interstitial's "header" mode from a valid mark (see readMark). In "cookie" mode a valid mark sets it only
// for the call of config.challenge (see the CAPTCHA case of carryOutStrategy). A copy the client sends is removed from
// the request this Worker sends on. Cloudflare's own pass-through after a failure sends what the client sent (README,
// "What the Worker cannot clean").
const ORIGINAL_REFERER_HEADER = RTIStatelessUtils.ORIGINAL_REFERER_HEADER;

// The outcome in the reload line (README, "Interstitial") where RTI's action on the reload gives it. For CHALLENGE the
// interstitial's decision gives it (see interstitialStrategy).
const RELOAD_OUTCOMES: Partial<Record<Action, string>> = {
    [Action.ALLOW]: "passed",
    [Action.BLOCK]: "blocked",
    [Action.REDIRECT]: "redirected",
};

// Our block, 404 and redirect answers, and the empty 403 for a prefetch, are never cached.
const responseHeaders = new ResponseHeaders();

// The requests that handle sends on with the verdict while RTI wants them challenged or blocked (in BLOCKING mode only:
// getAction gives ALLOW in any other mode), unless a valid CAPTCHA pass let them through (waivedByValidSession). An HTML
// answer to one of them is made no-store in fetch (see keepOutOfBrowserCache).
const passedOnForSuspicious = new WeakSet<Request>();

// The requests for which a valid challenge session waived the CAPTCHA (validateChallenge gave true, in the CAPTCHA case
// of carryOutStrategy). handle does not add them to passedOnForSuspicious: their answer keeps the origin's caching
// headers.
const waivedByValidSession = new WeakSet<Request>();

// Once per cold start, and never fatal: an exception while the module loads breaks every request of the Worker. Only
// reads the config and logs. The [challenge] and [interstitial] checks run first: an actionOnSuspicious check that
// throws can't hide them.
try {
    // Without isChallengeResponse a reply to the challenge page is not recognized, so in BLOCKING mode it is handled
    // like any request (e.g. forwarded with the form fields when RTI allows it).
    if (config.challenge && !config.isChallengeResponse) {
        console.warn('[challenge] config.isChallengeResponse is not set: replies to the challenge page are not recognized (see "Challenge callbacks" in the README)');
    }

    // One warning per problem in config.interstitial. With a wrong enabled or tag the interstitial is off, and a
    // challenge is handled as before it existed.
    for (const problem of interstitialService.problems) {
        console.warn(`[interstitial] ${problem} (see "Interstitial" in the README)`);
    }

    // A wrong value in actionOnSuspicious never stops the Worker, so say what to fix. What it does instead depends on the
    // value: a wrong method key in methods is not used, and a value that is not an Action counts as ALLOW; in a rule, a
    // bad regex never matches and a misspelled method is never matched, so the next rule or the method's default applies,
    // and that can be BLOCK.
    for (const problem of rtiHelperService.validateActionOnSuspicious()) {
        console.warn(`[config] ${problem} (see "actionOnSuspicious" in the README)`);
    }
} catch (e) {
    console.warn(`[config] the config check failed, continuing: ${rtiHelperService.errorMessage(e)}`);
}

const headerNames = [
    "user-agent", "host", "x-forwarded-for", "via", "referer", "accept",
    "accept-encoding", "accept-language", "accept-charset", "origin", "x-requested-with",
    "connection", "pragma", "cache-control", "content-type", "from", "x-real-ip", "true-client-ip",
    ORIGINAL_REFERER_HEADER
];

export default {
    async fetch(request: Request, env: unknown, context: ExecutionContext): Promise<Response> {
        // prevent runtime error responses, fail open to origin
        context.passThroughOnException();

        // The request the origin gets, unless the Worker answers itself or config.challenge returns another request.
        const originRequest = new Request(request);

        // handle only decides: our own answer (block page, redirect, challenge page, interstitial page, the empty 403 for a
        // prefetch), or the request to send on.
        const result = await handle(request, originRequest, context);
        // The copy holds the body. When the copy is not sent on, nobody reads that body, and wrangler dev then stalls the
        // next request (seen with wrangler 4.56.0; whether production does is not known). So the body is read to the end
        // in the background and thrown away. In wrangler dev 4.56.0 that ended the stall after an answer with a body (the
        // block page, the CAPTCHA page); after a redirect (no body) the next request still hung or got a 503 about one time
        // in three in runs of only that case (3 of 32 in mixed runs). Awaiting the read ended the stall every time, but then
        // our own answer waits for the client's whole body, in production too (README, "Test locally").
        // Only our own answer is followed by this read. A Request that config.challenge returns may carry the copy's body
        // (new Request(url, copy) shares the stream), so it is sent on as returned and its body is left alone.
        if (result instanceof Response && originRequest.body && !originRequest.bodyUsed) {
            context.waitUntil(originRequest.body.pipeTo(new WritableStream()).catch(() => {}));
        }
        if (result instanceof Response) {
            return result;
        }
        const response = await forwardToOrigin(result);
        return passedOnForSuspicious.has(result) ? keepOutOfBrowserCache(response) : response;
    },
};

/**
 * An HTML answer to a request that handle passed on while RTI wanted it challenged or blocked gets
 * Cache-Control: no-store, unless a valid CAPTCHA pass let the request through (passedOnForSuspicious; the owner's
 * decision of 2026-11-24). Such a request was let through by actionOnSuspicious, the interstitial or a missing
 * config.challenge. Kept, the browser could show that page later for a link click, a redirect or Back without asking
 * the Worker, and the interstitial or the CAPTCHA would not come (seen in Chromium and Firefox for a page that a script
 * fetched; README, "Which request gets a page"). Any other answer, and the rest of this one, is returned as the site
 * sent it.
 */
function keepOutOfBrowserCache(response: Response): Response {
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        return response;
    }
    const marked = new Response(response.body, response); // the origin's headers cannot be changed in place
    for (const [name, value] of Object.entries(responseHeaders.noStore())) {
        marked.headers.set(name, value);
    }
    return marked;
}

/**
 * The only place that calls the origin. It is outside handle's error handling on purpose: a failing origin
 * is not an RTI error, so it is neither logged as one nor called a second time by this Worker. Cloudflare's own
 * pass-through (passThroughOnException) may still send the visitor's request to the origin again. Cloudflare's
 * documentation says (Workers runtime APIs, "Context (ctx)") that the pass-through cannot send a body again once it
 * has been read: a POST whose origin call fails here can then reach the origin without its body.
 */
function forwardToOrigin(request: Request): Promise<Response> {
    // OPTION 1 - LOCAL/DEMO: proxy to a specific origin (e.g. an S3 static site). The Worker URL becomes the
    //   public entry point. Uncomment, set your origin URL, and comment out OPTION 2.
    //const url = new URL(request.url);
    //const demoRequest = new Request("http://your-demo-site.com" + url.pathname + url.search, request);
    //return fetch(demoRequest);
    //
    //   To also show x-cheq-rti-result to the browser (demo/debugging only), return this instead:
    //return fetch(demoRequest).then((response) => {
    //    const visible = new Response(response.body, response); // origin responses are immutable
    //    const verdict = request.headers.get("x-cheq-rti-result");
    //    if (verdict) visible.headers.set("x-cheq-rti-result", verdict); // only when RTI gave one
    //    return visible;
    //});

    // OPTION 2 - PRODUCTION: the Worker is attached to your domain by a route in wrangler.toml, so the
    //   request already targets your origin. Pass it through as it is.
    return fetch(request);
}

/**
 * Decides what happens to a request and never calls the origin itself: it returns either our own answer
 * (block page, redirect, challenge page, interstitial page, the empty 403 for a prefetch) or the request to send on.
 * Errors fail open: the request is sent on, except a reply to the challenge page, which still goes to config.challenge
 * (see the outer catch).
 * `originRequest` is the copy of `request` made in fetch (it holds the body). handle cleans it and returns it to send
 * on, unless it answers itself or config.challenge returns another Request.
 */
async function handle(request: Request, originRequest: Request, context: ExecutionContext): Promise<Response | Request> {
    // A client must not be able to hand the origin its own verdict: on paths that return without one (ignored
    // path, RTI error, a throw from validateChallenge or challenge, a Request that challenge returns without it)
    // its copy would reach the origin.
    originRequest.headers.delete("x-cheq-rti-result");
    // Same for the original Referer: only config.originalReferer and a valid mark set it (see ORIGINAL_REFERER_HEADER).
    originRequest.headers.delete(ORIGINAL_REFERER_HEADER);
    await restoreOriginalReferer(originRequest);

    try {
        // Filter out ignored paths. A valid challenge session does not skip RTI: it is checked only when RTI
        // asks for a CAPTCHA (below), so the request still gets a verdict and the x-cheq-rti-result header.
        const requestURL = new URL(request.url);
        if (rtiHelperService.shouldIgnore(requestURL.pathname)) {
            return originRequest;
        }

        // Whether the request is a page load: worked out once, before RTI is called, from the request sent on.
        const method = originRequest.method;
        // The four headers of the request sent on, for isPageLoad and isPrefetch. A missing header is null.
        const pageLoadHeaders: PageLoadHeaders = {
            secFetchDest: originRequest.headers.get("sec-fetch-dest"),
            accept: originRequest.headers.get("accept"),
            secPurpose: originRequest.headers.get("sec-purpose"),
            purpose: originRequest.headers.get("purpose"),
        };
        const pageLoad = rtiHelperService.isPageLoad(method, pageLoadHeaders);

        // The interstitial's mark (_cq_it), read before RTI is called while the interstitial is on. What it is for, and
        // why it counts on every page of the site: the comments at InterstitialService.readMark.
        const mark = interstitialService.on ? await readMark(originRequest, pageLoad, context) : undefined;
        // "cookie" mode: the mark's original Referer is only kept here, for a CAPTCHA on this request (the CAPTCHA case of
        // carryOutStrategy). RTI and the origin do not get it as x-cheq-original-referer. As in "header" mode, a value
        // that config.originalReferer set wins: then nothing is kept.
        const keptReferer = mark?.referer !== undefined && interstitialService.settings!.originalRefererVia === "cookie"
            && !originRequest.headers.has(ORIGINAL_REFERER_HEADER) ? mark.referer : undefined;

        const startRTI = Date.now();
        // Built from the request the origin gets: without the client's copies, with the original Referer if set.
        const fetchedHeaders = getHeaders(headerNames, originRequest.headers);
        const { duidCookie, pvidCookie, sCookie } = rtiHelperService.parseCookies(originRequest.headers.get("cookie") || "");
        let payload: RTIRequest = {
            tagHash: config.tagHash,
            apiKey: config.apiKey,
            isHeaderNamesOrdered: true,
            channel: "cloudflare-cdn-integration",
            customId1: rtiHelperService.getEventType(requestURL.pathname, request.method),
            customId2: originRequest.headers.get("cf-ray") || undefined, // set the cloudflare request id for monitoring
            // A valid mark for this page: the ray id of RTI call 1, so the two calls can be joined.
            customId3: mark?.forThisPage ? `interstitial:${mark.firstRayId}` : undefined,
            endUserParams: {
                clientIp: originRequest.headers.get("x-real-ip")!,
                requestUrl: requestURL.href,
                headerNames: Object.keys(fetchedHeaders).filter(x => fetchedHeaders[x]).join(","),
                method: request.method,
                headers: fetchedHeaders,
            },
            duidCookie: duidCookie, // Relevant for API version 4.0 and above
            pvidCookie: pvidCookie, // Relevant for API version 4.0 and above
            sCookie: sCookie,       // Relevant for API version 4.1 and above
        };

        // @ts-ignore: This specific line is known to be safe
        payload.endUserParams.headers.cheq_ja3 = request.cf?.botManagement?.ja3Hash || undefined;

        if (config.debug) {
            // Redacted (cookie names only, no session token or credentials): see RTIStatelessUtils.stringifyRedactedPayload
            console.log(`RTI Request payload: ${rtiHelperService.stringifyRedactedPayload(payload)}`);
        }

        // Reload too early: not handled, only written down (the owner's decision). The design says that the tag's server
        // saves a new session in its own region at once, and copies it to the other regions in the background (read in
        // adserver on 2026-11-17). If the reload's RTI call lands in another region within the first moments, RTI answers
        // sessionFound: false, and the visitor gets the no-session action without the tag's verdict. Not built: when a
        // valid mark comes with a _cq_pvid cookie and RTI says false, wait about 300 ms and call RTI once more.
        const rtiResponse = await rtiService.callRTI(payload);

        if (config.debug) {
            console.log(`RTI Response: ${JSON.stringify(rtiResponse)}`);
        }

        const endRTI = Date.now();
        const duration = endRTI - startRTI;

        if (config.telemetry) {
            context.waitUntil(log(duration));
        }

        const action = rtiHelperService.getAction(rtiResponse);

        if (config.debug) {
            const actionName = Action[action];
            console.log(`action upon response: ${actionName ? `${actionName} (${action})` : action}`);
        }

        // MONITORING mode (FR-7): no request gets the interstitial, but a line says when a page load would get it.
        if (interstitialService.on && config.mode === Mode.MONITORING) {
            logWouldShow(originRequest, context, rtiResponse, requestURL.pathname, pageLoad, pageLoadHeaders, mark);
        }

        // RTI's action as a strategy for this request. When RTI says CHALLENGE and the strategy is CAPTCHA, three questions
        // decide which request gets the page (README, "Which request gets a page"): a rule of config.actionOnSuspicious
        // that matches the path and covers the method, then a page load gets the page, then the method's default (ALLOW
        // without one: forwarded with the verdict). A block verdict shown as a CAPTCHA (blockingStrategy: CAPTCHA) asks no
        // question: a GET or HEAD gets the page, and a request with a body still follows actionOnSuspicious. Where the
        // page would be the answer, a prefetch gets an empty 403 instead (see the CAPTCHA case of carryOutStrategy).
        // While the interstitial is on, the page for a page load is the interstitial (INTERSTITIAL), whatever
        // challengingStrategy says (see interstitialStrategy).
        const { strategy: actionStrategy, actionOnSuspicious } = rtiHelperService.getStrategyForRequest(action, method, requestURL.pathname, pageLoad, interstitialService.on);

        // Every value as its name and its raw value. Cannot throw: a value with no name (null, undefined, an unknown number)
        // reads as "none" next to the raw value. actionOnSuspicious is set only when it decided (a rule or a method's
        // default, when the strategy is CAPTCHA).
        if (config.debug && action !== Action.ALLOW) {
            console.log(`action strategy: ${ActionStrategy[actionStrategy ?? -1] ?? "none"} (${actionStrategy}), actionOnSuspicious: ${Action[actionOnSuspicious ?? -1] ?? "none"} (${actionOnSuspicious}), method: ${method}, pageLoad: ${pageLoad}`);
        }

        // The reply to a challenge page is a new request with a new verdict. Whatever that verdict (ALLOW, CAPTCHA,
        // INTERSTITIAL) and whatever session the visitor has, config.challenge answers it (it verifies the answer and sends
        // the visitor on). Forwarded instead, the origin would get the token and the form fields in place of the visitor's
        // query string. Checked before the session waiver (two tabs, Back, refresh). Only for ALLOW, CAPTCHA or
        // INTERSTITIAL (isChallengeReplyAllowed: a CAPTCHA can come after the interstitial): any other strategy (blocks,
        // 404s, redirects) is enforced as usual.
        if (rtiHelperService.isChallengeReplyAllowed(actionStrategy) && shouldAnswerChallengeReply(originRequest, context)) {
            if (config.debug) {
                console.log("challenge reply, passing it to challenge");
            }
            return await answerChallengeReply(originRequest, context, rtiResponse, (headers) => setHeaders(headers, rtiResponse));
        }

        // The reload line, where RTI's action gives its outcome: ALLOW, BLOCK or REDIRECT. It is sent once the decision is
        // known, so a reply to the challenge page (answered above) gets none. For CHALLENGE the line comes from the
        // interstitial's decision (see interstitialStrategy). So a challenged page load for which a rule of
        // actionOnSuspicious gives ALLOW, BLOCK or REDIRECT gets none. An error in the line is logged, and the request
        // goes on as without it (sendReloadLine).
        const reloadOutcome = RELOAD_OUTCOMES[action];
        if (reloadOutcome !== undefined) {
            sendReloadLine(context, reloadOutcome, mark, pageLoad, pageLoadHeaders, rtiResponse, originRequest);
        }

        if (action !== Action.ALLOW) {
            const answer = actionStrategy === ActionStrategy.INTERSTITIAL
                ? await interstitialStrategy(request, originRequest, context, rtiResponse, pageLoad, pageLoadHeaders, mark, keptReferer)
                : await carryOutStrategy(actionStrategy, request, originRequest, context, rtiResponse, pageLoadHeaders, keptReferer);
            if (answer) {
                return answer;
            }
        }

        // action is Action.ALLOW, or no strategy applies (e.g. a request that actionOnSuspicious lets through, such as a GET
        // that is not a page load), or a CAPTCHA that was waived or has no challenge, or the interstitial's decision sends
        // the request on (or it failed): pass headers to origin request

        // Set the RTI result header for the origin to consume. It is not visible to the client; the origin can log it
        // or act on it.
        setHeaders(originRequest.headers, rtiResponse);
        // RTI wants the request challenged or blocked, and no valid CAPTCHA pass let it through: fetch makes the origin's
        // HTML answer no-store (see passedOnForSuspicious).
        if (action !== Action.ALLOW && !waivedByValidSession.has(originRequest)) {
            passedOnForSuspicious.add(originRequest);
        }
        return originRequest;
    } catch (e) {
        logError(context, `Error handling request '${getCdnRequestId(request)}'`, e);

        // The request could not be evaluated (RTI error or timeout, a malformed RTI response, any other error before the
        // decision): a reply is still answered by config.challenge, or the origin would get the form fields. There is no
        // verdict, so it gets a stand-in response and no addRtiResultHeader.
        if (shouldAnswerChallengeReply(originRequest, context)) {
            return await answerChallengeReply(originRequest, context, rtiFailureResponse(originRequest, context));
        }
        return originRequest;
    }
}

/**
 * Carries out a strategy: RTI's strategy for this request, or the Action that the interstitial's decision gives. The
 * answer is ours (the block page, a redirect, the challenge page, the empty 403 for a prefetch), a Request that
 * config.challenge returns, or `undefined`: handle then sends the copy on with the verdict.
 * `keptReferer` is the mark's original Referer that handle keeps in "cookie" mode, for the CAPTCHA case.
 */
async function carryOutStrategy(strategy: ActionStrategy | null, request: Request, originRequest: Request, context: ExecutionContext, rtiResponse: RTIResponse, pageLoadHeaders: PageLoadHeaders, keptReferer: string | undefined): Promise<Response | Request | undefined> {
    switch (strategy) {
        case ActionStrategy.ACCESS_DENIED:
            return blockPage(403, 'Access Denied', request, rtiResponse);
        case ActionStrategy.NOT_FOUND:
            return blockPage(404, 'Not Found', request, rtiResponse);
        case ActionStrategy.REDIRECT:
            return new Response(null, {
                status: 302,
                headers: {
                    "x-cheq-cdn-request-id": request.headers.get("cf-ray") || '',
                    "x-cheq-id": rtiResponse.ids.rayId,
                    "x-cheq-page-view-id": rtiResponse.ids.pageViewId ?? '',
                    "location": config.redirectLocation || "https://www.cheq.ai/",
                    ...responseHeaders.noStore(),
                },
            });
        case ActionStrategy.CAPTCHA:
            try {
                if (config.challenge) {
                    // A visitor who already solved the challenge (valid _cq_se session) is not challenged
                    // again: forward with the real verdict. Only the CAPTCHA is waived, never a block,
                    // 404 or redirect. If validateChallenge throws, the catch below fails open.
                    if (await isValidChallenge(originRequest, config.debug)) {
                        if (config.debug) {
                            console.log("valid challenge session, waiving CAPTCHA");
                        }
                        // handle does not mark a request waived here, so the origin's answer keeps its caching headers
                        // (see passedOnForSuspicious).
                        waivedByValidSession.add(originRequest);
                        return undefined;
                    }
                    // A prefetch (Sec-Purpose or Purpose contains "prefetch") gets an empty 403 in place of the
                    // challenge page: the owner's decision of 2026-11-23 (README, "Which request gets a page";
                    // RTIStatelessUtils.isPrefetch says what MDN writes about it). Checked after the session
                    // waiver, so a valid session forwards a prefetch with the verdict, as it would a visit.
                    // A page that a site names in <link rel="prefetch"> is asked for with Sec-Fetch-Dest: empty, so it
                    // is not a page load and, as shipped, does not get here: it is forwarded with the verdict (the JSDoc
                    // of RTIStatelessUtils.isPrefetch; README, the known limits of "Which request gets a page"). Its
                    // HTML answer is made no-store in fetch (keepOutOfBrowserCache), so the browser does not reuse it
                    // for the click: in Chromium 131 the click then got the CAPTCHA (2026-11-24).
                    if (rtiHelperService.isPrefetch(pageLoadHeaders)) {
                        if (config.debug) {
                            console.log("prefetch: an empty 403 in place of the challenge page");
                        }
                        return prefetchAnswer(request, rtiResponse);
                    }
                    // A GET gets here when it is a page load that no rule covers; a GET or HEAD also when
                    // actionOnSuspicious or blockingStrategy: CAPTCHA sends it to the CAPTCHA (README, "Which
                    // request gets a page"). While the interstitial is on, a page load gets here when the
                    // interstitial's decision gives CHALLENGE. It is challenged in place: after the challenge, the
                    // visitor is back on the page they asked for. A request with a body (POST, PUT, PATCH, DELETE,
                    // OPTIONS) gets the page for where the visitor came from (the Referer, same site only), or the
                    // site's home page without a usable Referer. The body is not kept (a challenge page cannot carry
                    // it through): the visitor can send it again after solving the challenge.
                    const afterChallengeRequest = rtiHelperService.isBodylessMethod(originRequest.method) ? originRequest : refererAfterChallengeRequest(originRequest);
                    // "cookie" mode: the copy gets the kept original Referer as x-cheq-original-referer for this call
                    // only, so that the CAPTCHA page can carry it on. RTI was called before, without it. The header
                    // comes off again before the request leaves handle: from the copy and from a Request that
                    // config.challenge returns, also when the call throws. So the origin does not get it either.
                    const refererForCall = keptReferer !== undefined && afterChallengeRequest === originRequest;
                    if (refererForCall) {
                        originRequest.headers.set(ORIGINAL_REFERER_HEADER, keptReferer);
                    }
                    try {
                        // Passed on as it is, without the header of this call: a Response is our answer, a Request is
                        // forwarded. Awaited here, so a rejection is caught below.
                        const answer = await config.challenge(afterChallengeRequest, rtiResponse, (headers) => setHeaders(headers, rtiResponse));
                        if (refererForCall && answer instanceof Request) {
                            answer.headers.delete(ORIGINAL_REFERER_HEADER);
                        }
                        return answer;
                    } finally {
                        if (refererForCall) {
                            originRequest.headers.delete(ORIGINAL_REFERER_HEADER);
                        }
                    }
                }
                return undefined;
            } catch (e) {
                logError(context, `Challenge error handling request '${getCdnRequestId(request)}'`, e);
                return originRequest;
            }
        default:
            return undefined;
    }
}

// The empty 403 for a prefetch that would get a page, the challenge page or the interstitial (README, "Which request
// gets a page"): no body, the request ids and no-store.
function prefetchAnswer(request: Request, rtiResponse: RTIResponse): Response {
    return new Response(null, {
        status: 403,
        headers: {
            "x-cheq-cdn-request-id": request.headers.get("cf-ray") || '',
            "x-cheq-id": rtiResponse.ids.rayId,
            "x-cheq-page-view-id": rtiResponse.ids.pageViewId ?? '',
            ...responseHeaders.noStore(),
        },
    });
}

/**
 * The strategy INTERSTITIAL: a page load that RTI wants challenged while the interstitial is on (README,
 * "Interstitial"). InterstitialService.decide says what the request gets:
 * - forward: it is sent on with the verdict (a request that is not a page load).
 * - show: the interstitial page, and the shown line. A prefetch gets the empty 403 instead: no page, no mark, no line.
 * - act: the Action of onSecondVerdict or onSessionNotFound, carried out by carryOutStrategy. CHALLENGE is the CAPTCHA,
 *   whatever challengingStrategy says, and ALLOW sends the request on with the verdict. The reload of the page gets the
 *   reload line first (sendReloadLine).
 * An error in the shown line or the reload line is logged and changes nothing else: the request still gets the page, or
 * the answer of act. Any other error is logged, and the request is sent on with the verdict (`undefined`, as for
 * forward). Not so for an error in the CAPTCHA case that act reaches: that case keeps its own catch, logs `Challenge
 * error handling request …`, and sends the copy on without x-cheq-rti-result, as the CAPTCHA does without the
 * interstitial.
 * `keptReferer` is the mark's original Referer that handle keeps in "cookie" mode. The CAPTCHA that act reaches gets it.
 */
async function interstitialStrategy(request: Request, originRequest: Request, context: ExecutionContext, rtiResponse: RTIResponse, pageLoad: boolean, pageLoadHeaders: PageLoadHeaders, mark: ValidMark | undefined, keptReferer: string | undefined): Promise<Response | Request | undefined> {
    try {
        const outcome = interstitialService.decide(interstitialFacts(rtiResponse, pageLoad, mark));
        switch (outcome.kind) {
            case "forward":
                if (config.debug) {
                    console.log(`interstitial: forward, ${outcome.reason}`);
                }
                return undefined;
            case "act": {
                // second-verdict:<Action> (RTI found the tag's session) or no-session:<Action> (a valid mark, no session).
                sendReloadLine(context, `${outcome.reason}:${Action[outcome.action]}`, mark, pageLoad, pageLoadHeaders, rtiResponse, originRequest);
                const strategy = outcome.action === Action.CHALLENGE ? ActionStrategy.CAPTCHA : rtiHelperService.getActionStrategy(outcome.action);
                return await carryOutStrategy(strategy, request, originRequest, context, rtiResponse, pageLoadHeaders, keptReferer);
            }
            case "show": {
                // A prefetch gets the empty 403 in place of the page, with no mark and no shown line: the owner's
                // decision of 2026-11-23 (README, "Which request gets a page").
                if (rtiHelperService.isPrefetch(pageLoadHeaders)) {
                    if (config.debug) {
                        console.log("prefetch: an empty 403 in place of the interstitial");
                    }
                    return prefetchAnswer(request, rtiResponse);
                }
                // The copy's x-cheq-original-referer, else the value kept in "cookie" mode. A kept value comes from a
                // valid mark, and decide shows the page only without one: the page gets a kept value only if decide
                // changes.
                const carriedReferer = originRequest.headers.get(ORIGINAL_REFERER_HEADER) ?? keptReferer;
                const page = await interstitialService.page(interstitialRequest(originRequest, pageLoad), rtiResponse.ids.rayId, carriedReferer);
                const response = new Response(page.body, { status: page.status, headers: page.headers });
                // The shown line has its own catch: an error in it is logged, and the page is still the answer.
                try {
                    sendOutcomeLine(context, shownLine("shown", rtiResponse, originRequest));
                } catch (e) {
                    logInterstitialError(context, originRequest, e);
                }
                return response;
            }
        }
    } catch (e) {
        logInterstitialError(context, originRequest, e);
        return undefined;
    }
}

/**
 * MONITORING mode (FR-7): no request gets the interstitial. The would-show line says that a page load would get the page
 * in BLOCKING mode: getEnforcedAction gives CHALLENGE, the strategy for it is INTERSTITIAL, decide says show (so a valid
 * mark gives no line), and it is not a prefetch (a prefetch would get the empty 403). An error is logged, and the request
 * goes on as before.
 */
function logWouldShow(originRequest: Request, context: ExecutionContext, rtiResponse: RTIResponse, path: string, pageLoad: boolean, pageLoadHeaders: PageLoadHeaders, mark: ValidMark | undefined): void {
    try {
        const enforced = rtiHelperService.getEnforcedAction(rtiResponse);
        if (enforced === Action.CHALLENGE
            && rtiHelperService.getStrategyForRequest(enforced, originRequest.method, path, pageLoad, interstitialService.on).strategy === ActionStrategy.INTERSTITIAL
            && interstitialService.decide(interstitialFacts(rtiResponse, pageLoad, mark)).kind === "show"
            && !rtiHelperService.isPrefetch(pageLoadHeaders)) {
            sendOutcomeLine(context, shownLine("would-show", rtiResponse, originRequest));
        }
    } catch (e) {
        logInterstitialError(context, originRequest, e);
    }
}

// The plain facts that InterstitialService.decide needs. `mark` is the request's valid mark (readMark), if it has one.
function interstitialFacts(rtiResponse: RTIResponse, pageLoad: boolean, mark: ValidMark | undefined): InterstitialFacts {
    return {
        // A declared good bot (a crawler such as Google's or Bing's) is not checked here. RTI is expected to give it a
        // benign verdict, so it does not reach the interstitial (agreed with the PM on 2026-11-24; the product spec's
        // FR-2 had asked for a check). If a site's good bots get a suspicious verdict, set that in the policy screen of
        // the CHEQ console: here they would get the interstitial like any visitor.
        pageLoad,
        sessionFound: rtiResponse.metadata?.sessionFound ?? null,
        validMark: mark !== undefined,
    };
}

/**
 * The valid mark (_cq_it) of the copy, or `undefined` (InterstitialService.readMark). In "header" mode the mark's
 * original Referer becomes x-cheq-original-referer on the copy, so that RTI and the origin get it, unless
 * config.originalReferer (with the shipped example, a valid _cq_rf) already set one. handle removed the client's own
 * copy of that header before, so the copy carries only a value this Worker set. In "cookie" mode the copy is not
 * changed, and handle keeps the Referer (keptReferer). An error is logged and counts as no mark: RTI is still called.
 */
async function readMark(originRequest: Request, pageLoad: boolean, context: ExecutionContext): Promise<ValidMark | undefined> {
    try {
        const mark = await interstitialService.readMark(interstitialRequest(originRequest, pageLoad));
        if (mark?.referer !== undefined && interstitialService.settings!.originalRefererVia === "header" && !originRequest.headers.has(ORIGINAL_REFERER_HEADER)) {
            originRequest.headers.set(ORIGINAL_REFERER_HEADER, mark.referer);
        }
        return mark;
    } catch (e) {
        logInterstitialError(context, originRequest, e);
        return undefined;
    }
}

// Whether the request gets the reload line: in BLOCKING mode, a page load with a valid mark for its own page that is not
// a prefetch.
function getsReloadLine(mark: ValidMark, pageLoad: boolean, pageLoadHeaders: PageLoadHeaders): boolean {
    return config.mode === Mode.BLOCKING && pageLoad && mark.forThisPage && !rtiHelperService.isPrefetch(pageLoadHeaders);
}

/**
 * Sends the reload line for `outcome` when the request gets one (getsReloadLine). `mark` is the request's valid mark, if
 * it has one. Used by handle and by the act case of interstitialStrategy. No log line may change what the request
 * gets: an error while the line is checked, built or sent is logged, and nothing else changes.
 */
function sendReloadLine(context: ExecutionContext, outcome: string, mark: ValidMark | undefined, pageLoad: boolean, pageLoadHeaders: PageLoadHeaders, rtiResponse: RTIResponse, originRequest: Request): void {
    try {
        if (mark !== undefined && getsReloadLine(mark, pageLoad, pageLoadHeaders)) {
            sendOutcomeLine(context, reloadLine(outcome, mark, rtiResponse, originRequest));
        }
    } catch (e) {
        logInterstitialError(context, originRequest, e);
    }
}

// The reload line for `outcome`. The first ray id comes from the mark, so it can be joined to the shown line.
function reloadLine(outcome: string, mark: ValidMark, rtiResponse: RTIResponse, originRequest: Request): string {
    return `interstitial: ${outcome}, firstRayId=${mark.firstRayId}, rayId=${rtiResponse.ids.rayId}, verdict=${rtiResponse.decision.verdict}, reasons=${reasons(rtiResponse)}, sessionFound=${rtiResponse.metadata?.sessionFound ?? null}, request=${getCdnRequestId(originRequest)}`;
}

// The plain facts of the request sent on (the copy) for InterstitialService. The binding key follows the interstitial's
// `binding`. Only while the interstitial is on: its settings are there then.
function interstitialRequest(originRequest: Request, pageLoad: boolean): InterstitialRequest {
    return {
        url: originRequest.url,
        cookie: originRequest.headers.get("cookie") ?? "",
        referer: originRequest.headers.get("referer"),
        bindingKey: sessionBindingKey({ sessionBinding: interstitialService.settings!.binding }, originRequest),
        pageLoad,
    };
}

// The line for a page load that gets the interstitial ("shown"), or would get it in MONITORING mode ("would-show").
function shownLine(kind: "shown" | "would-show", rtiResponse: RTIResponse, originRequest: Request): string {
    return `interstitial: ${kind}, rayId=${rtiResponse.ids.rayId}, verdict=${rtiResponse.decision.verdict}, reasons=${reasons(rtiResponse)}, request=${getCdnRequestId(originRequest)}`;
}

// RTI's reason codes for an outcome line, joined with ",". "" when RTI gives none.
function reasons(rtiResponse: RTIResponse): string {
    return rtiResponse.cheqDetection?.reasons?.join(",") ?? "";
}

// Sends one outcome line of the interstitial: to the RTI logger through waitUntil, unless logOutcomes is false, and to
// the console in debug mode. Only while the interstitial is on: its settings are there then.
function sendOutcomeLine(context: ExecutionContext, line: string): void {
    if (config.debug) {
        console.log(line);
    }
    if (interstitialService.settings!.logOutcomes) {
        context.waitUntil(logger.info(line));
    }
}

// A reply goes to config.challenge in BLOCKING mode only: MONITORING never changes a response. config.isChallengeResponse
// is customer code: only a synchronous `true` counts (an async detector's Promise is no reply), and if it throws, the
// request is handled as no reply and the error is logged. It must never throw out of here: this also runs in the outer
// catch of handle, which must not throw.
function shouldAnswerChallengeReply(request: Request, context: ExecutionContext): boolean {
    if (config.mode !== Mode.BLOCKING || !config.challenge || !config.isChallengeResponse) {
        return false;
    }
    try {
        return config.isChallengeResponse(request) === true;
    } catch (e) {
        logError(context, `Challenge reply check error handling request '${getCdnRequestId(request)}'`, e);
        return false;
    }
}

// Passes a challenge reply to config.challenge. If it throws, the request is forwarded (fail open): the origin gets the
// reply as it is, the token and form fields in place of the visitor's query string. A challenge that read the body from
// request.clone() leaves it to forward. This is the last resort for a challenge that does not answer its own errors.
async function answerChallengeReply(request: Request, context: ExecutionContext, rtiResponse: RTIResponse, addRtiResultHeader?: (headers: Headers) => void): Promise<Response | Request> {
    try {
        return await config.challenge!(request, rtiResponse, addRtiResultHeader);
    } catch (e) {
        logError(context, `Challenge error handling request '${getCdnRequestId(request)}'`, e);
        return request;
    }
}

// Stands in for the RTI response when the request could not be evaluated (see the outer catch in handle), so a
// challenge reply can still be answered. It is NOT an RTI answer: there is no verdict, classification or other data,
// only ids, and the cast hides that from the type.
// - ids.rayId is the cf-ray value, not an RTI ray id. challenge needs a non-empty, unique id: the Turnstile example signs
//   the session with it and stores it in the _cq_se cookie (an empty one would issue a session that never works). It is
//   never compared with RTI. Never an id from the query: the client controls that, and it would end up in Set-Cookie.
// - A cf-ray value that is not a plain id (cookie separators, spaces), empty, missing or too long is replaced by a
//   random one, and logged with both values so it can be traced. The Worker does not set this header itself, so its
//   value is checked, not assumed.
// - ids.customParam2 is the real cf-ray value (null without one), as customId2 is in the RTI payload of the normal flow.
function rtiFailureResponse(request: Request, context: ExecutionContext): RTIResponse {
    const cfRay = request.headers.get("cf-ray") ?? "";
    let rayId = cfRay;
    if (!/^[A-Za-z0-9_=.-]{1,200}$/.test(cfRay)) {
        rayId = `cf-fallback-${crypto.randomUUID()}`;
        const message = `RTI failed and the Cloudflare request id ${JSON.stringify(getCdnRequestId(request))} is not usable as the stand-in rayId, using ${rayId}`;
        console.warn(`[challenge] ${message}`);
        if (config.logErrors !== false) {
            context.waitUntil(logger.error(message));
        }
    }
    const ids: Ids = {
        rayId,
        pageViewId: null, duid: null, uniqueVisitId: null,
        customParam1: null, customParam2: cfRay || null, customParam3: null, customParam4: null,
    };
    return { ids } as RTIResponse;
}

/**
 * Logs an error to the console and, unless config.logErrors is false, to the RTI logger. The logger call goes to
 * waitUntil: the Worker answers without waiting for it, and the runtime keeps it running until it is done.
 * `e` is whatever was thrown (undefined, null, any object): errorMessage turns it into text without throwing.
 */
function logError(context: ExecutionContext, message: string, e: unknown): void {
    console.error(`${message}:`, e);
    if (config.logErrors !== false) {
        context.waitUntil(logger.error(`${message}: ${rtiHelperService.errorMessage(e)}`));
    }
}

// Logs an error of the interstitial's code for the request (logError): `Interstitial error handling request '<cf-ray>'`.
function logInterstitialError(context: ExecutionContext, originRequest: Request, e: unknown): void {
    logError(context, `Interstitial error handling request '${getCdnRequestId(originRequest)}'`, e);
}

// Whether the visitor already solved the challenge (a valid session). false when validateChallenge is not set.
async function isValidChallenge(request: Request, isDebug: boolean | undefined): Promise<boolean> {
    return await config.validateChallenge?.(request, isDebug) ?? false;
}

// Cloudflare's id of the request (the cf-ray header), for tracking and debugging.
function getCdnRequestId(request: Request): string {
    return request.headers.get("cf-ray") || "unknown_request_id";
}

/**
 * The request the visitor makes after passing the challenge, when a request with a body is challenged (actionOnSuspicious CHALLENGE):
 * a GET for the page the visitor came from (the Referer, only on the host of this request's URL, which is always there:
 * a request built by other code may have no Host header), so after solving they are back on the form
 * and can send it again. Without a usable Referer (none, another site, or not a URL), a GET for the site's home page
 * ("/"): an address on another site is never used, so the CAPTCHA can't be turned into an open redirect.
 * Only the path and the query are set, on this request's own URL: a Referer path that starts with "//" stays a path
 * here, where `new URL(path, base)` would read it as another host. The body is not kept, and neither is
 * x-cheq-original-referer: the CAPTCHA page takes that header first, and the form page carries its own Referer (README,
 * "The original Referer"). The other headers and the redirect mode are kept. The real request is not changed: it is
 * still the one checked for a session, and it keeps x-cheq-original-referer.
 */
function refererAfterChallengeRequest(request: Request): Request {
    const url = new URL(request.url);
    const referer = rtiHelperService.sameSiteReferer(request.headers.get("referer"), url.host);
    url.pathname = referer?.path ?? "/";
    url.search = referer?.query ?? "";
    // A copy of the headers, so x-cheq-original-referer comes off the GET only.
    const headers = new Headers(request.headers);
    headers.delete(ORIGINAL_REFERER_HEADER);
    return new Request(url.href, { method: "GET", headers, redirect: request.redirect });
}

// After a solved CAPTCHA: where the visitor came from before it, as x-cheq-original-referer for RTI and the origin.
// The callback may return a promise. An error only means no header: the request goes on. Never rejects.
async function restoreOriginalReferer(request: Request): Promise<void> {
    if (!config.originalReferer) {
        return;
    }
    try {
        const referer = await config.originalReferer(request);
        if (referer) {
            // Throws on a value a header cannot hold (a line break inside the value): caught below, so no header is injected.
            request.headers.set(ORIGINAL_REFERER_HEADER, referer);
        }
    } catch (e) {
        console.error(`[challenge] originalReferer failed, forwarding without ${ORIGINAL_REFERER_HEADER}: ${rtiHelperService.errorMessage(e)}`);
    }
}

// Our own 403 or 404 page for a blocked request.
function blockPage(status: 403 | 404, title: string, request: Request, rtiResponse: RTIResponse): Response {
    return new Response(
        generateDefaultBlockPage(String(status), title, rtiResponse.ids, request.headers.get("cf-ray")),
        { status, headers: responseHeaders.html() }
    );
}

function getHeaders(headerNames: string[], headers: Headers): RequestHeaders {
    const result: RequestHeaders = {};
    for (const headerName of headerNames) {
        result[headerName] = headers.get(headerName) || undefined;
    }
    return result;
}

function setHeaders(headers: Headers, rtiResponse: RTIResponse) {
    headers.set("x-cheq-rti-result", rtiHelperService.buildRtiResultHeader(rtiResponse));
}

function log(duration: number) {
    return logger.info(`rti_duration: ${duration}`);
}
