import { Config } from '../../core/models/config.interface';
import { Mode } from '../../core/models/mode.model';
import { RTIResponse } from '../../core/models/rti-response.model';

/**
 * See {@link https://cheq-ai.github.io/rti-cdn-integrations/interfaces/Config.html | Config}
 */
export interface CloudflareConfig extends Config {
    /**
     * Enable telemetry logging
     */
    telemetry: boolean;

    /**
     * Called when {@link https://cheq-ai.github.io/rti-cdn-integrations/interfaces/Config.html#challengeCodes | challengeCodes } are configured
     * @param request
     * @param response
     */
    challenge?: (request: Request, response: RTIResponse) => Promise<Response>;

    /**
     * Enables local debug logging
     */
    debug?: boolean;
}

export const config: CloudflareConfig = {
    mode: Mode.MONITORING,
    apiKey: 'REPLACE_ME',
    tagHash: 'REPLACE_ME',
    blockCodes: [7, 10, 11, 16, 18],
    redirectCodes: [2, 3, 6],
    redirectLocation: "https://www.cheq.ai/",
    timeout: 300,
    telemetry: true,
};
