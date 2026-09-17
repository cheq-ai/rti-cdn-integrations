// cspell:ignore PMUSER CHEQ
import { AkamaiConfig, buildDynamicConfig, config as staticConfig } from './config';
import { callRTI } from './rti-service';
import { logToRTI } from './rti-logger';
import { RTIHelperService } from '../../core/services/rti-helper.service';
import { Action } from '../../core/models/action.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { generateCompactBlockPage } from '../../core/helpers/block-page-helpers';
import { RequestHeaders, RTIRequest } from '../../core/models/rti-request.model';
import { logger as log } from 'log';

// Keep in sync with edgeworker-version in bundle.json - identifies the deployed build in RTI logs.
const APPLICATION = 'rti-cdn-integrations.akamai-4.1.14';

const HEADER_NAMES = [
    'user-agent', 'host', 'x-forwarded-for', 'via', 'referer', 'accept',
    'accept-encoding', 'accept-language', 'accept-charset', 'origin',
    'x-requested-with', 'connection', 'pragma', 'cache-control',
    'content-type', 'from', 'x-real-ip', 'true-client-ip',
    // Sec-Fetch metadata — request context signals useful for bot detection
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user', 'sec-fetch-storage-access',
    // Client Hints — browser/device identity signals
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-ch-ua-arch',
    'sec-ch-ua-model', 'sec-ch-ua-full-version-list', 'sec-ch-device-memory',
    // HTTP Message Signatures
    'signature', 'signature-agent', 'signature-input',
];


/**
 * Safe single-value header accessor. On the live Akamai runtime getHeader() returns
 * undefined - not an empty array - when the header is absent, so indexing [0] directly
 * throws. The throw is swallowed by onClientRequest's catch, which fails open, so the
 * symptom is RTI silently never being called rather than a visible error.
 */
function getHeaderValue(request: EWRequest, name: string): string | undefined {
    return request.getHeader(name)?.[0];
}

function collectHeaders(request: EWRequest): RequestHeaders {
    const result: RequestHeaders = {};
    for (const name of HEADER_NAMES) {
        const val = getHeaderValue(request, name);

        if (val) {
            result[name] = val;
        }
    }

    return result;
}

/**
 * Called by Akamai on every incoming request, before it reaches the origin.
 * Classifies the traffic via RTI and either blocks/redirects/challenges the request
 * or enriches it with an x-cheq-rti-result header and passes it through to origin.
 */
export async function onClientRequest(request: EWRequest): Promise<void> {
    // Hoist config so the catch block can use rtiLoggerHost for error logging.
    // Initialized to staticConfig so it's always set even if buildDynamicConfig throws.
    let config : AkamaiConfig = staticConfig;
    try {
        if (request.getVariable('PMUSER_CHEQ_USE_DYNAMIC_CONFIG') === 'true') {
            config = buildDynamicConfig(request);
        }

        // Initialize helper instances
        const rtiHelper = new RTIHelperService(config);

        // Filter out ignored paths
        if (rtiHelper.shouldIgnore(request.path)) {
            if (config.debug) {
                log.log(`[cheq] path ignored: ${request.path}`);
            }
            return;
        }

        // Filter already validated challenges
        if (config.validateChallenge && await config.validateChallenge(request)) {
            if (config.debug) {
                log.log('[cheq] valid challenge session, skipping RTI');
            }
            return;
        }

        const fetchedHeaders = collectHeaders(request);
        // getHeader always returns an array; [0] is undefined when absent, ?? '' produces an empty parse.
        const { duidCookie, pvidCookie, sCookie } = rtiHelper.parseCookies(getHeaderValue(request, 'Cookie') ?? '');
        const requestUrl = `${request.scheme}://${request.host}${request.url}`;

        const payload: RTIRequest = {
            tagHash: config.tagHash,
            apiKey: config.apiKey,
            isHeaderNamesOrdered: false,
            channel: 'akamai-cdn-integration',
            customId1: rtiHelper.getEventType(request.path, request.method),
            customId2: request.getVariable('PMUSER_CHEQ_REQUEST_ID') || undefined,
            endUserParams: {
                clientIp: request.clientIp,
                requestUrl,
                headerNames: Object.keys(fetchedHeaders).filter(k => fetchedHeaders[k]).join(','),
                method: request.method,
                headers: fetchedHeaders,
            },
            duidCookie,
            pvidCookie,
            sCookie,
        };

        // Fingerprint and TLS data — operator maps Akamai built-in variables (e.g. AK_TLS_CIPHER_NAME,
        // AK_TLS_VERSION, Bot Manager JA3) to these PMUSER variables in Property Manager.
        // @ts-ignore: dynamic header assignment is safe here
        payload.endUserParams.headers.cheq_ja3 = request.getVariable('PMUSER_CHEQ_JA3') || undefined;
        // @ts-ignore: dynamic header assignment is safe here
        payload.endUserParams.headers.cheq_ja4 = request.getVariable('PMUSER_CHEQ_JA4') || undefined;
        // @ts-ignore: dynamic header assignment is safe here
        payload.endUserParams.headers.cheq_tls_cipher = request.getVariable('PMUSER_CHEQ_TLS_CIPHER') || undefined;
        // @ts-ignore: dynamic header assignment is safe here
        payload.endUserParams.headers.cheq_tls_version = request.getVariable('PMUSER_CHEQ_TLS_VERSION') || undefined;
        // @ts-ignore: dynamic header assignment is safe here
        payload.endUserParams.headers.cheq_geo_region = request.userLocation?.region || undefined;

        if (config.debug) {
            log.log(`[cheq] payload: ${JSON.stringify(payload)}`);
        }

        const startRTI = Date.now();
        const rtiResponse = await callRTI(payload, config.rtiHost, config.timeout ?? 300);

        const rtiDuration = Date.now() - startRTI;

        if (config.debug) {
            log.log(`[cheq] verdict: ${rtiResponse.decision.verdict}, code: ${rtiResponse.classification.code}`);
        }

        const action = rtiHelper.getAction(rtiResponse);
        const actionStrategy = action !== Action.ALLOW ? rtiHelper.getActionStrategy(action) : null;

        // Akamai allows only TWO sub-requests per onClientRequest, and callRTI has already spent
        // one. A CAPTCHA needs the other for Google's siteverify, so telemetry has to yield it:
        // going over the limit makes the verify throw, the CAPTCHA case below catches that and
        // falls through to ALLOW, and the visitor walks past the challenge. Losing one timing
        // metric is a far better trade than losing the enforcement it was measuring.
        const captchaWillVerify = actionStrategy === ActionStrategy.CAPTCHA && !!config.challenge;
        if (config.telemetry && config.rtiLoggerHost && !captchaWillVerify) {
            logToRTI('info', `rti_duration: ${rtiDuration}`, APPLICATION, config.apiKey, config.tagHash, config.rtiLoggerHost);
        }

        // A throwing challenge falls through to ALLOW below, which looks exactly like a benign
        // verdict from outside - the visitor is simply let past the challenge. Captured here so
        // the debug header can say so.
        let challengeError: string | undefined;

        if (action !== Action.ALLOW) {
            switch (actionStrategy) {
                case ActionStrategy.ACCESS_DENIED: {
                    const html = generateCompactBlockPage('403', 'Access Denied', rtiResponse.ids);
                    request.respondWith(403, { 'Content-Type': 'text/html;charset=UTF-8' }, html);
                    return;
                }
                case ActionStrategy.NOT_FOUND: {
                    const html = generateCompactBlockPage('404', 'Not Found', rtiResponse.ids);

                    // NOT_FOUND is the stealth strategy: generateCompactBlockPage deliberately
                    // discards the ids for 404, so the page gives a bot no hint it was detected.
                    // Emitting the ids as headers would hand back exactly that hint, so they are
                    // debug-only - enough to tie a 404 to an RTI decision during rollout, and
                    // absent in production where the stealth is the point.
                    const headers: Record<string, string> = { 'Content-Type': 'text/html;charset=UTF-8' };
                    if (config.debug) {
                        headers['x-cheq-cdn-request-id'] = request.getVariable('PMUSER_CHEQ_REQUEST_ID') ?? '';
                        headers['x-cheq-id'] = rtiResponse.ids.rayId;
                        headers['x-cheq-page-view-id'] = rtiResponse.ids.pageViewId ?? '';
                    }

                    request.respondWith(404, headers, html);
                    return;
                }
                case ActionStrategy.REDIRECT: {
                    request.respondWith(302, {
                        'Location': config.redirectLocation || 'https://www.cheq.ai/',
                        'x-cheq-cdn-request-id': request.getVariable('PMUSER_CHEQ_REQUEST_ID') ?? '',
                        'x-cheq-id': rtiResponse.ids.rayId,
                        'x-cheq-page-view-id': rtiResponse.ids.pageViewId ?? '',
                    }, '');
                    return;
                }
                case ActionStrategy.CAPTCHA: {
                    try {
                        if (config.challenge) {
                            const { html, headers } = await config.challenge(request, rtiResponse);
                            const status = headers['Location'] ? 302 : 403;
                            request.respondWith(status, headers, html);
                            return;
                        }

                        // CAPTCHA was selected but no challenge callback is wired, so the request
                        // falls through to origin. Silent otherwise, and easy to mistake for the
                        // integration ignoring challengingStrategy - so say so when debugging.
                        if (config.debug) {
                            log.log('[cheq] CAPTCHA action but no challenge configured - allowing request');
                        }
                    } catch (e) {
                        challengeError = e instanceof Error ? e.message : String(e);
                        if (config.debug) {
                            log.log(`[cheq] challenge error: ${challengeError}`);
                        }
                        if (config.rtiLoggerHost) {
                            logToRTI('error', `challenge error: ${e instanceof Error ? e.message : String(e)}`, APPLICATION, config.apiKey, config.tagHash, config.rtiLoggerHost);
                        }
                    }
                    break;
                }
            }
        }

        // ALLOW: enrich request to origin.
        // PMUSER_CHEQ_RTI_DEBUG_DATA adds the detection reason codes and the name of
        // the rule behind the verdict. Read straight from the property variable rather than
        // from config so it works on both the static and dynamic config paths - the same
        // approach onClientResponse takes with PMUSER_CHEQ_DEBUG. Off unless set to "true".
        const includeDebugData = request.getVariable('PMUSER_CHEQ_RTI_DEBUG_DATA') === 'true';
        const rtiResultHeader = rtiHelper.buildRtiResultHeader(rtiResponse, includeDebugData);
        request.setHeader('x-cheq-rti-result', rtiResultHeader);

        // Store for onClientResponse — only needed when debug is enabled. A failed challenge is
        // appended here and NOT to the header above: origin gets the clean classification result,
        // while a browser with debug on can tell "allowed because benign" from "allowed because
        // the challenge blew up", which are otherwise identical.
        if (config.debug) {
            request.setVariable('PMUSER_CHEQ_RTI_FLOW', challengeError ? `${rtiResultHeader};challenge-error=${challengeError}` : rtiResultHeader);
        }

    } catch (e) {
        // Fail open — request proceeds to origin
        const message = e instanceof Error ? e.message : String(e);
        log.log(`[cheq] error: ${message}`);

        // A fail-open is indistinguishable from a healthy ALLOW when seen from the client:
        // both are a 200 with no x-cheq-rti-result on the response. Park the reason in the
        // variable onClientResponse already echoes so the two can be told apart in the
        // browser, without declaring a new property variable. PMUSER_CHEQ_DEBUG is read
        // directly rather than via config.debug because buildDynamicConfig may be what threw -
        // leaving config as staticConfig - and because it is the flag onClientResponse gates on.
        // Guarded separately: a throw escaping this catch would reject onClientRequest, which
        // serves a 500 when the EdgeWorkers behavior has 'Continue on error' set to Off.
        try {
            if (request.getVariable('PMUSER_CHEQ_DEBUG') === 'true') {
                request.setVariable('PMUSER_CHEQ_RTI_FLOW', `failed-open; error=${message}`);
            }
        } catch { /* diagnostics must never break the fail-open path */ }

        if (config.rtiLoggerHost) {
            logToRTI('error', `error: ${message}`, APPLICATION, config.apiKey, config.tagHash, config.rtiLoggerHost);
        }
    }
}

/**
 * Called by Akamai after the origin responds, before the response is sent to the client.
 * When debug is enabled, echoes the x-cheq-rti-result header on the response for observability.
 */
export function onClientResponse(request: EWRequest, response: EWResponse): void {
    try {
        // PMUSER_CHEQ_DEBUG is equivalent to the value of config.debug, but since we don't have access to config here, we check the pmuser variable directly.
        const debugEnabled = request.getVariable('PMUSER_CHEQ_DEBUG') === 'true';
        
        if (!debugEnabled) {
            return;
        }

        const rtiResult = request.getVariable('PMUSER_CHEQ_RTI_FLOW');
        if (rtiResult) {
            response.addHeader('x-cheq-rti-result', rtiResult);
        }
    } catch { /* fail silently */ }
}
