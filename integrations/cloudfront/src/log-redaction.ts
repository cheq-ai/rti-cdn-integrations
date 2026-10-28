// cspell:ignore cheq
// Redaction for CloudFront's debug log of the Lambda@Edge event. The rules (cookie names only, the session token and
// credentials as [REDACTED]) are shared by every integration and live in RTIStatelessUtils; only the event's
// `name → [{ key, value }]` header shape is CloudFront's, so only that is here. The RTI payload is logged with
// rtiHelperService.stringifyRedactedPayload. Only what is LOGGED is redacted: the event itself is never changed,
// since the real request is still forwarded to the origin.
import { CloudFrontRequestEvent } from 'aws-lambda';
import { RTIStatelessUtils } from '../../core/services/rti-stateless-utils';

/**
 * A redacted copy of a CloudFront headers map (`name → [{ key, value }]`, one entry per header line): each value goes
 * through `redact`. Entries of any other shape are kept as they are.
 */
function redactCloudFrontHeaders(headers: Record<string, unknown>, redact: (name: string, value: string) => string): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [name, entries] of Object.entries(headers)) {
        redacted[name] = Array.isArray(entries)
            ? entries.map(entry => entry && typeof entry === 'object' && typeof entry.value === 'string'
                ? { ...entry, value: redact(name, entry.value) }
                : entry)
            : entries;
    }
    return redacted;
}

/**
 * `JSON.stringify(event)` for the debug log, redacted while serializing, so `event` is neither changed nor copied:
 * - `headers` (the viewer's request headers) by `utils.redactHeaderValue`: cookie names only, `[REDACTED]` for the
 *   session token and credentials. The handler passes its RTIHelperService, which is an RTIStatelessUtils.
 * - `customHeaders` (origin-request only: the headers the operator configured for the origin, in `origin.custom` or
 *   `origin.s3`) entirely: they are often a shared secret proving to the origin that a request came through
 *   CloudFront, and no name tells which ones are. Their names are kept.
 */
export function stringifyRedactedEvent(event: CloudFrontRequestEvent, utils: RTIStatelessUtils): string {
    return JSON.stringify(event, (key, nested) => {
        if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
            return nested;
        }
        if (key === 'headers') {
            return redactCloudFrontHeaders(nested, (name, value) => utils.redactHeaderValue(name, value));
        }
        if (key === 'customHeaders') {
            return redactCloudFrontHeaders(nested, () => RTIStatelessUtils.REDACTED);
        }
        return nested;
    });
}
