// cspell:ignore PMUSER CHEQ
import { buildDynamicConfig, config as staticConfig } from './config';
import { callRTI } from './rti-service';
import { logToRTI } from './rti-logger';
import { RTIHelperService } from '../../core/services/rti-helper.service';
import { Action } from '../../core/models/action.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { generateDefaultBlockPage } from '../../core/helpers/block-page-helpers';
import { RequestHeaders, RTIRequest } from '../../core/models/rti-request.model';
import { log } from 'log';

const APPLICATION = 'rti-cdn-integrations.akamai-1.0.0';

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

function collectHeaders(request: EWRequest): RequestHeaders {
    const result: RequestHeaders = {};
    for (const name of HEADER_NAMES) {
        const vals = request.getHeader(name);
        const val = vals && vals.length > 0 ? vals[0] : undefined;

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
    let config = staticConfig;
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
        const { duidCookie, pvidCookie, sCookie } = rtiHelper.parseCookies(request.getHeader('Cookie')[0] ?? '');
        const requestUrl = `${request.scheme}://${request.host}${request.url}`;

        const payload: RTIRequest = {
            tagHash: config.tagHash,
            apiKey: config.apiKey,
            isHeaderNamesOrdered: true,
            channel: 'akamai-cdn-integration',
            customId1: rtiHelper.getEventType(request.path, request.method),
            customId2: request.getHeader('x-akamai-request-id')[0] ?? undefined, // set the akamai request id for monitoring
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

        if (config.telemetry && config.rtiLoggerHost) {
            logToRTI('info', `rti_duration: ${Date.now() - startRTI}`, APPLICATION, config.apiKey, config.tagHash, config.rtiLoggerHost);
        }

        if (config.debug) {
            log.log(`[cheq] verdict: ${rtiResponse.decision.verdict}, code: ${rtiResponse.classification.code}`);
        }

        const action = rtiHelper.getAction(rtiResponse);

        if (action !== Action.ALLOW) {
            const actionStrategy = rtiHelper.getActionStrategy(action);

            switch (actionStrategy) {
                case ActionStrategy.ACCESS_DENIED: {
                    const html = generateDefaultBlockPage('403', 'Access Denied', rtiResponse.ids);
                    request.respondWith(403, { 'Content-Type': 'text/html;charset=UTF-8' }, html);
                    return;
                }
                case ActionStrategy.NOT_FOUND: {
                    const html = generateDefaultBlockPage('404', 'Not Found', rtiResponse.ids);
                    request.respondWith(404, { 'Content-Type': 'text/html;charset=UTF-8' }, html);
                    return;
                }
                case ActionStrategy.REDIRECT: {
                    request.respondWith(302, {
                        'Location': config.redirectLocation || 'https://www.cheq.ai/',
                        'x-cheq-cdn-request-id': request.getHeader('x-akamai-request-id')[0] ?? '',
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
                    } catch (e) {
                        if (config.debug) {
                            log.log(`[cheq] challenge error: ${e instanceof Error ? e.message : String(e)}`);
                        }
                        if (config.rtiLoggerHost) {
                            logToRTI('error', `challenge error: ${e instanceof Error ? e.message : String(e)}`, APPLICATION, config.apiKey, config.tagHash, config.rtiLoggerHost);
                        }
                    }
                    break;
                }
            }
        }

        // ALLOW: enrich request to origin
        const rtiResultHeader = rtiHelper.buildRtiResultHeader(rtiResponse);
        request.setHeader('x-cheq-rti-result', rtiResultHeader);

        // Store for onClientResponse — only needed when debug is enabled
        if (config.debug) {
            request.setVariable('PMUSER_CHEQ_RTI_FLOW', rtiResultHeader);
        }

    } catch (e) {
        // Fail open — request proceeds to origin
        log.log(`[cheq] error: ${e instanceof Error ? e.message : String(e)}`);
        if (config.rtiLoggerHost) {
            logToRTI('error', `error: ${e instanceof Error ? e.message : String(e)}`, APPLICATION, config.apiKey, config.tagHash, config.rtiLoggerHost);
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
