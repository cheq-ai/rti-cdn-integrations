// cspell:ignore cheqzone rtilogger
// Akamai-specific RTI logger. Mirrors the payload of RTILoggerService but uses
// httpRequest() instead of fetch() — Akamai EdgeWorkers do not have fetch().
// The rtiLoggerHost must be an Akamai-proxied hostname routing to rtilogger.production.cheq-platform.com.
// See integrations/core/services/rti-logger.service.ts for the standard fetch()-based implementation
// used by all other integrations.
import { httpRequest } from 'http-request';
import { log } from 'log';

export async function logToRTI(
    level: 'info' | 'error',
    message: string,
    application: string,
    apiKey: string,
    tagHash: string,
    rtiLoggerHost: string,
    action?: string,
): Promise<void> {
    try {
        const body = JSON.stringify({ level, message, action, application, apiKey, tagHash });
        await httpRequest('/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Host': rtiLoggerHost },
            body,
            timeout: 1000,
        });
    } catch (e) {
        log.log('[cheq] logToRTI error:', e instanceof Error ? e.message : String(e));
    }
}
