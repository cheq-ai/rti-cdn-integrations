import { CloudFrontRequestResult, CloudFrontResponseResult } from 'aws-lambda';
import { CloudFrontRequest } from 'aws-lambda/common/cloudfront';
import { Config } from '../../core/models/config.interface';
import { RTIResponse } from '../../core/models/rti-response.model';
import { Mode } from '../../core/models/mode.model';
import { trunstileValidateChallengeExample, turnstileChallengeExample } from './turnstile-challenge-example';

/**
 * See {@link https://cheq-ai.github.io/cheq-rti-client-core-js/interfaces/Config.html | Config}
 */
export interface CloudfrontConfig extends Config {
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
     * Validate session of challenge function invoked at the beginning of the request to skip RTI check and allow the request to pass to origin
     * @param request
     * @param isDebug
     */
    validateChallenge?: (request: CloudFrontRequest, isDebug: boolean | undefined) => Promise<boolean>;

    /**
     * The list of headers to keep in the request that will be sent to RTI. 
     * This is optional and can be used to reduce the size of the request if there are many headers that are not needed. 
     * If not provided (meaning empty array, null or undefined are not allowed), all headers will be kept.
     */
    keepHeadersNames: string[];
}

export const config: CloudfrontConfig = {
    mode: Mode.BLOCKING,

    apiKey: "REPLACE_ME", // Replace with your actual API key
    tagHash: "REPLACE_ME", // Replace with your actual Tag Hash
    
    challenge: turnstileChallengeExample,
    validateChallenge: trunstileValidateChallengeExample,
    
    timeout: 500,
    debug: false, // Set to true to enable debug logging, false for production
    telemetry: false,
    keepHeadersNames: [], // Optional: specify headers to keep in the request sent to RTI, otherwise all headers will be kept (in this case, pass empty array)
};
