import { ActionStrategy } from '../../core/models/action-strategy.model';
import { Config } from '../../core/models/config.interface';
import { Mode } from '../../core/models/mode.model';
import { RTIResponse } from '../../core/models/rti-response.model';
import { turnstileChallengeExample, trunstileValidateChallengeExample } from './turnstile-challenge-example';
/**
 * See {@link https://cheq-ai.github.io/rti-cdn-integrations/interfaces/Config.html | Config}
 */
export interface CloudflareConfig extends Config {
    /**
     * Enable telemetry logging
     */
    telemetry: boolean;

    /**
     * Callback function invoked when {@link Action.CHALLENGE | Action } output is returned
     * @param request
     * @param response
     */
    challenge?: (request: Request, response: RTIResponse) => Promise<Response>;

    /**
     * Callback function invoked when {@link Action.CHALLENGE | Action } output is returned
     * @param request
     * @param response
     */
    validateChallenge?: (request: Request) => Promise<boolean>;
}

export const config: CloudflareConfig = {
    mode: Mode.MONITORING,
    apiKey: "REPLACE_ME",
    tagHash: "REPLACE_ME",
    challenge: turnstileChallengeExample,
    validateChallenge: trunstileValidateChallengeExample,
    timeout: 500,
    telemetry: true,
};
