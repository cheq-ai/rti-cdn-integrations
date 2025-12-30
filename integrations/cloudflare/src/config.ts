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
    mode: Mode.BLOCKING,
    apiKey: "bde56677-f159-4b48-a2d2-6a17cf07df56",
    tagHash: "025cc3a294c91f7ed20b1082706fc4f8",
    blockCodes: [7, 10, 11, 16, 18, 13],
    redirectCodes: [2, 3],
    redirectLocation: "https://www.cheq.ai/",
    challengeCodes: [6],
    challenge: async (request: Request, response: RTIResponse) => {
        return new Response("<html>captcha</html>");
    },
    timeout: 500,
    telemetry: true,
    debug: true,
};
