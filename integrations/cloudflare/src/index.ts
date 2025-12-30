import { config } from "./config";
import { RTILoggerService } from "../../core/services/rti-logger.service";
import { RTIService } from "../../core/services/rti.service";
import { Action } from "../../core/models/action.model";
import { RTIHelperService } from "../../core/services/rti-helper.service";
import { RTIResponse } from "../../core/models/rti-response.model";
import { name, version } from "../package.json";
import { RequestHeaders, RTIRequest } from "../../core/models/rti-request.model";

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
            const requestURL = new URL(request.url);
            if (rtiHelperService.shouldIgnore(requestURL.pathname)) {
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
                endUserParams: {
                    clientIp: request.headers.get("x-real-ip")!,
                    requestUrl: requestURL.href,
                    headerNames: Object.keys(fetchedHeaders).filter(x => fetchedHeaders[x]).join(","),
                    method: request.method,
                    headers: fetchedHeaders,
                },
                duidCookie: cookieHeaderMap.find(c => c.startsWith("_cq_duid="))?.split("=")[1],
                pvidCookie: cookieHeaderMap.find(c => c.startsWith("_cq_pvid="))?.split("=")[1],
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
            if (action === Action.BLOCK) {
                return new Response(null, { status: 403 });
            } else if (action === Action.REDIRECT) {
                const headers = new Headers();
                headers.append("location", config.redirectLocation!);
                return new Response(null, { status: 302, headers });
            } else if (action === Action.CHALLENGE && config.challenge) {
                try {
                    const challengeResult = await config.challenge(request, rtiResponse);
                    return challengeResult;
                } catch (e) {
                    const err: Error = e as Error;
                    console.error("challenge error", err);
                    context.waitUntil(logger.error(`challenge error: ${err.message}`));
                    const originResponse = await fetch(request);
                    return originResponse;
                }
            }
            // action is Action.ALLOW, pass headers to origin request
            const originRequest = new Request(request);
            setHeaders(originRequest.headers, rtiResponse);
            const originResponse = await fetch(originRequest);

            // set headers on viewer response
            const newResponse = new Response(originResponse.body, originResponse);
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
        `ids=${JSON.stringify(rtiResponse.ids)}`,
    ].join(";");
    headers.set("x-cheq-rti-result", result);
}

function log(duration: number) {
    return logger.info(`rti_duration: ${duration}`);
}
