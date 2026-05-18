import { config } from "./config";
import { RTILoggerService } from "../../core/services/rti-logger.service";
import { RTIService } from "../../core/services/rti.service";
import { Action } from "../../core/models/action.model";
import { RTIHelperService } from "../../core/services/rti-helper.service";
import { RTIResponse } from "../../core/models/rti-response.model";
import { name, version } from "../package.json";
import { RequestHeaders, RTIRequest } from "../../core/models/rti-request.model";
import { ActionStrategy } from "../../core/models/action-strategy.model";
import { generateDefaultBlockPage } from "../../core/helpers/block-page-helpers";

const logger = new RTILoggerService(`${name}-${version}`, config);
const rtiHelperService = new RTIHelperService(config);
const rtiService = new RTIService(config);
const headerNames = ["user-agent", "host", "x-forwarded-for", "via", "referer", "accept",
                        "accept-encoding", "accept-language", "accept-charset", "origin", "x-requested-with",
                        "connection", "pragma", "cache-control", "content-type", "from", "x-real-ip", "true-client-ip"];

export default {
    async fetch(request: Request, env: unknown, context: ExecutionContext) {
        try {
            // prevent runtime error responses, fail open to origin
            context.passThroughOnException();

            // Filter out ignored paths and already validated challenges and validate challenge if exists
            const requestURL = new URL(request.url);
            if (rtiHelperService.shouldIgnore(requestURL.pathname) || (config.validateChallenge && await config.validateChallenge(request))) {
                const originResponse = await fetch(request);
                return originResponse;
            }

            const startRTI = Date.now();
            const fetchedHeaders = getHeaders(headerNames, request.headers);
            const cookieHeaderMap = (request.headers.get("cookie") || "").split(";").map(c => c.trim());
            let payload: RTIRequest = {
                tagHash: config.tagHash,
                apiKey: config.apiKey,
                isHeaderNamesOrdered: true,
                channel: "cloudflare-cdn-integration",
                customId1: rtiHelperService.getEventType(requestURL.pathname, request.method),
                customId2: request.headers.get("cf-ray") || undefined, // set the cloudflare request id for monitoring
                endUserParams: {
                    clientIp: request.headers.get("x-real-ip")!,
                    requestUrl: requestURL.href,
                    headerNames: Object.keys(fetchedHeaders).filter(x => fetchedHeaders[x]).join(","),
                    method: request.method,
                    headers: fetchedHeaders,
                },
                duidCookie: cookieHeaderMap.find(c => c.startsWith("_cq_duid="))?.split("=")[1],
                pvidCookie: cookieHeaderMap.find(c => c.startsWith("_cq_pvid="))?.split("=")[1],
                sCookie: cookieHeaderMap.find(c => c.startsWith("_cq_s="))?.split("=")[1], // Relevant for API version 4.1 and above
            };
            
            // @ts-ignore: This specific line is known to be safe
            payload.endUserParams.headers.cheq_ja3 = request.cf?.botManagement?.ja3Hash;
            if (config.debug) { console.log(`requset payload: ${JSON.stringify(payload)}`); }

            const rtiResponse = await rtiService.callRTI(payload);
            if (config.debug) { console.log(`rtiResponse: ${JSON.stringify(rtiResponse)}`); }

            const endRTI = Date.now();
            const duration = endRTI - startRTI;
            if (config.telemetry) {
                context.waitUntil(log(duration));
            }

            const action = rtiHelperService.getAction(rtiResponse);
            if (config.debug) { console.log(`action: ${action}`); }
            if (action !== Action.ALLOW) {
                const actionStrategy = rtiHelperService.getActionStrategy(action);
                switch (actionStrategy) {
                    case ActionStrategy.ACCESS_DENIED:
                        return new Response(
                            generateDefaultBlockPage('403', 'Access Denied', rtiResponse.ids, request.headers.get("cf-ray")),
                            { status: 403, headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
                        );
                    case ActionStrategy.NOT_FOUND:
                        return new Response(
                            generateDefaultBlockPage('404', 'Not Found', rtiResponse.ids, request.headers.get("cf-ray")),
                            { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
                        );
                    case ActionStrategy.REDIRECT:
                        const redirectHeaders = new Headers();
                        redirectHeaders.set("location", config.redirectLocation || "https://www.cheq.ai/");
                        redirectHeaders.set("x-cheq-id", rtiResponse.ids.rayId);
                        redirectHeaders.set("x-cheq-page-view-id", rtiResponse.ids.pageViewId ?? '');
                        redirectHeaders.set("x-cheq-cf-request-id", request.headers.get("cf-ray") || '');
                        return new Response(null, { status: 302, headers: redirectHeaders });
                    case ActionStrategy.CAPTCHA:
                        try {
                            if (config.challenge) {
                                const challengeResult = await config.challenge(request, rtiResponse);
                                return challengeResult;
                            }
                            break;
                        } catch (e) {
                            const err: Error = e as Error;
                            console.error("challenge error", err);
                            context.waitUntil(logger.error(`challenge error: ${err.message}`));
                            const originResponse = await fetch(request);
                            return originResponse;
                        }
                    default:
                        break;
                }
            }

            // action is Action.ALLOW, pass headers to origin request

            // OPTION 1 - LOCAL/DEMO: proxy to a specific origin (e.g. S3 static site).
            //   Worker URL becomes the public entry point. Uncomment and set your origin URL.
            //const originUrl = "http://your-demo-site.com" + requestURL.pathname + requestURL.search;
            //const originRequest = new Request(originUrl, request);

            // OPTION 2 - PRODUCTION: attach Worker to your domain via a route in wrangler.toml.
            //   The request already targets your origin — just pass it through as-is.
            const originRequest = new Request(request);

            // Set RTI result headers for the origin to consume. These headers won't be visible to the client, but can be logged in CloudWatch or used by the origin application.
            setHeaders(originRequest.headers, rtiResponse);
            const newResponse = await fetch(originRequest);

            // OPTION 1 - Pass x-cheq-rti-result to the browser (useful for demo/debugging).
            //   Origin responses are immutable, so we wrap them in a new Response to add the header.
            //const mutableResponse = new Response(newResponse.body, newResponse);
            //mutableResponse.headers.set("x-cheq-rti-result", originRequest.headers.get("x-cheq-rti-result") || "");
            //return mutableResponse;

            // OPTION 2 - PRODUCTION: return origin response as-is (header stays on the request, visible in CloudWatch/logs only, not the client).
            return newResponse;
        } catch (e) {
            const err: Error = e as Error;
            console.error("error", err);
            context.waitUntil(logger.error(`error: ${err.message}`));
            const originResponse = await fetch(request);
            return originResponse;
        }
    },
};

function getHeaders(headerNames: string[], headers: Headers): RequestHeaders {
    const result: RequestHeaders = {};
    for (const headerName of headerNames) {
        result[headerName] = headers.get(headerName) || undefined;
    }
    return result;
}

function setHeaders(headers: Headers, rtiResponse: RTIResponse) {
    const result = [
        `version=${rtiResponse.metadata.version}`,
        `verdict=${rtiResponse.decision.verdict}`,
        `threat-type-code=${rtiResponse.classification.code}`,
        `ids=${JSON.stringify(rtiResponse.ids)}`
    ].join(";");
    headers.set("x-cheq-rti-result", result);
}

function log(duration: number) {
    return logger.info(`rti_duration: ${duration}`);
}
