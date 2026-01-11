import { CloudFrontRequestResult, CloudFrontResponseResult } from 'aws-lambda';
import { CloudFrontRequest } from 'aws-lambda/common/cloudfront';
import { Config } from '../../core/models/config.interface';
import { RTIResponse } from '../../core/models/rti-response.model';
import { Mode } from '../../core/models/mode.model';

/**
 * See {@link https://cheq-ai.github.io/cheq-rti-client-core-js/interfaces/Config.html | Config}
 */
export interface CloudfrontConfig extends Config {
    /**
     * Enable telemetry logging
     */
    telemetry: boolean;

    /**
     * Called when {@link https://cheq-ai.github.io/cheq-rti-client-core-js/interfaces/Config.html#challengeCodes | challengeCodes } are configured
     * @param request
     * @param response
     */
    challenge?: (
        request: CloudFrontRequest,
        response: RTIResponse,
    ) => Promise<CloudFrontRequestResult | CloudFrontResponseResult>;

    /**
     * Validate session of challenge function invoked at the beggining of the request to skip RTI check and allow the request to pass to origin
     * @param request
     */
    validateChallenge?: (request: CloudFrontRequest) => Promise<boolean>;

    /**
     * Enables local debug logging
     */
    debug?: boolean;
}

export const config: CloudfrontConfig = {
    mode: Mode.MONITORING,
    apiKey: 'REPLACE_ME',
    tagHash: 'REPLACE_ME',
    telemetry: true,
};
