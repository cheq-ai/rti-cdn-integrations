// cspell:ignore cheqzone
// Akamai-specific RTI caller. Akamai EdgeWorkers do not have fetch(), so this uses
// httpRequest — Akamai's built-in sub-request API. The target URL must be routed
// through an Akamai property; the customer configures an origin that forwards to
// rti-global.cheqzone.com. See integrations/core/services/rti.service.ts for the
// standard fetch()-based implementation used by all other integrations.
import { httpRequest } from 'http-request';
import { RTIRequest } from '../../core/models/rti-request.model';
import { RTIResponse } from '../../core/models/rti-response.model';

export async function callRTI(payload: RTIRequest, rtiHost: string, timeout: number): Promise<RTIResponse> {
    const body = JSON.stringify(payload);

    const response = await httpRequest('/defend/4.1/traffic', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Host': rtiHost,
        },
        body,
        timeout,
    });

    if (response.status >= 400) {
        const errorBody = await response.text();
        throw new Error(`Invalid RTI request, response code: ${response.status}, body: ${errorBody}`);
    }

    return await response.json() as RTIResponse;
}
