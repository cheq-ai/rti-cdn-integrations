import { ActionStrategy } from '../../core/models/action-strategy.model';
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
}

export const config: CloudflareConfig = {
    mode: Mode.MONITORING,
    apiKey: "REPLACE_ME",
    tagHash: "REPLACE_ME",
    challenge: async (request: Request, response: RTIResponse) => {
        return new Response("<html>captcha</html>");
    },
    timeout: 500,
    telemetry: true,
};
