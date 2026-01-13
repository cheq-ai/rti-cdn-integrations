import { CloudFrontRequestEvent, CloudFrontRequestResult } from 'aws-lambda';
import { config } from './config';
import { RTILoggerService } from "../../core/services/rti-logger.service";
import { RTIService } from "../../core/services/rti.service";
import { RTIHelperService } from "../../core/services/rti-helper.service";
import { name, version } from "../package.json";
import { RequestHeaders, RTIRequest } from "../../core/models/rti-request.model";
import { CloudFrontHeaders, CloudFrontRequest } from 'aws-lambda/common/cloudfront';
import { Action } from '../../core/models/action.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { RTIResponse } from '../../core/models/rti-response.model';

const logger = new RTILoggerService(`${name}-${version}`, config);
const rtiHelperService = new RTIHelperService(config);
const rtiService = new RTIService(config);
const headerNames = ["user-agent", "host", "x-forwarded-for", "via", "referer", "accept",
                        "accept-encoding", "accept-language", "accept-charset", "origin", "x-requested-with",
                        "connection", "pragma", "cache-control", "content-type", "from", "x-real-ip", "true-client-ip"];

export const handle = async (event: CloudFrontRequestEvent): Promise<CloudFrontRequestResult> => {
    const cfRequest = event.Records[0].cf.request;
    if (config.debug) {
        console.log(`cfRequest: ${JSON.stringify(cfRequest)}`);
    }
    try {
        const requestURL = new URL(getRequestUrl((cfRequest.headers["host"]?.map((kv) => kv.value) || "").join(', '), cfRequest.uri, cfRequest.querystring));
        if (rtiHelperService.shouldIgnore(requestURL.pathname) || (config.validateChallenge && await config.validateChallenge(cfRequest))) {
            return cfRequest;
        }
        const startRTI = Date.now();
        const fetchedHeaders = getHeaders(headerNames, cfRequest.headers);
        const cookieHeaderMap = (cfRequest.headers["cookie"]?.map((kv) => kv.value).join(', ') || "").split(";").map(c => c.trim());
        let payload: RTIRequest = {
            tagHash: config.tagHash,
            apiKey: config.apiKey,
            isHeaderNamesOrdered: true,
            channel: "cloudfront-cdn-integration",
            customId1: rtiHelperService.getEventType(requestURL.pathname, cfRequest.method),
            endUserParams: {
                clientIp: cfRequest.clientIp,
                requestUrl: requestURL.href,
                headerNames: Object.keys(fetchedHeaders).filter(x => fetchedHeaders[x]).join(","),
                method: cfRequest.method,
                headers: fetchedHeaders,
            },
            duidCookie: cookieHeaderMap.find(c => c.startsWith("_cq_duid="))?.split("=")[1],
            pvidCookie: cookieHeaderMap.find(c => c.startsWith("_cq_pvid="))?.split("=")[1],
        };
        // @ts-ignore: This specific line is known to be safe
        payload.endUserParams.headers.cheq_ja3 = cfRequest.headers["cloudfront-viewer-ja3-fingerprint"].map((kv) => kv.value).join(', ');
        if (config.debug) { console.log(`requset payload: ${JSON.stringify(payload)}`); }

        const rtiResponse = await rtiService.callRTI(payload);
        if (config.debug) { console.log(`rtiResponse: ${JSON.stringify(rtiResponse)}`); }

        const endRTI = Date.now();
        const duration = endRTI - startRTI;
        if (config.telemetry) {
            await logger.info(`rti_duration: ${duration}`);
        }
        
        const action = rtiHelperService.getAction(rtiResponse);
        if (config.debug) { console.log(`action: ${action}`); }
        if (action !== Action.ALLOW) {
            const actionStrategy = rtiHelperService.getActionStrategy(action);
            switch (actionStrategy) {
                case ActionStrategy.ACCESS_DENIED:
                    return {
                        status: '403',
                    };
                case ActionStrategy.NOT_FOUND:
                    return {
                        status: '404',
                    };
                case ActionStrategy.REDIRECT:
                    const headers = {};
                    // @ts-ignore
                    headers.location = [{ key: 'Location', value: config.redirectLocation || "https://www.cheq.ai/" }];
                    return {
                        status: '302',
                        headers,
                    };
                case ActionStrategy.CAPTCHA:
                    try {
                        if (config.challenge) {
                            const challengeResult = await config.challenge(cfRequest, rtiResponse);
                            return challengeResult;
                        }
                        break;
                    } catch (e) {
                        const err: Error = e as Error;
                        console.error("challenge error", err);
                        await logger.error(`challenge error: ${err.message}`);
                        return cfRequest;
                    }
                default:
                    break;
            }
        }

        // action is Action.ALLOW, pass headers to origin request
        setHeaders(cfRequest.headers, rtiResponse);
        return cfRequest;
    } catch (e) {
        const err: Error = e as Error;
        console.error('error', err);
        await logger.error(`error: ${err.message}`);
    }
    return cfRequest;
};

function getRequestUrl(host: string, uri: string, queryString?: string): string {
    let url = `https://${host}${uri}`;
    if (queryString) {
        url += `?${queryString}`;
    }
    return url;
}

function setHeaders(headers: CloudFrontHeaders, rtiResponse: RTIResponse) {
    const result = [
        `version=${rtiResponse.metadata.version}`,
        `verdict=${rtiResponse.decision.verdict}`,
        `threat-type-code=${rtiResponse.classification.code}`,
        `ids=${JSON.stringify(rtiResponse.ids)}`,
    ].join(";");
    headers["x-cheq-rti-result"] = [{value: result }];
}

function getHeaders(headerNames: string[], headers: CloudFrontHeaders): RequestHeaders {
    const result: RequestHeaders = {};
    for (const headerName of headerNames) {
        if (headers[headerName]) {
            const headerValues = headers[headerName];
            result[headerName] = headerValues.map((kv) => kv.value).join(', ');
        }
    }
    return result;
}
