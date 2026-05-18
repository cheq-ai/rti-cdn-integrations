import { CloudFrontRequestResult, CloudFrontResponseResult } from 'aws-lambda';
import { CloudFrontRequest } from 'aws-lambda/common/cloudfront';
import { Config } from '../../core/models/config.interface';
import { RTIResponse } from '../../core/models/rti-response.model';
import { Mode } from '../../core/models/mode.model';
import { trunstileValidateChallengeExample, turnstileChallengeExample } from './turnstile-challenge-example';
import { ActionStrategy } from '../../core/models/action-strategy.model';

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

// Example for maintaining developer debug configuration can be found in cheq repo under: cheq-testing-website/src/frontend/pages/cdn/cloudfront/README.md
export const config: CloudfrontConfig = {
    mode: Mode.MONITORING, // Start with MONITORING to observe before enforcing with BLOCKING

    apiKey: "REPLACE_ME", // Replace with your actual API key
    tagHash: "REPLACE_ME", // Replace with your actual Tag Hash
    
    // By default we use ActionStrategy.ACCESS_DENIED but you can set it to REDIRECT or CAPTCHA as well, but make sure to implement the relevant functions and configurations for each strategy
    //blockingStrategy: ActionStrategy.ACCESS_DENIED, 
    
    // By default we use ActionStrategy.CAPTCHA but you can set it to REDIRECT or ACCESS_DENIED as well, but make sure to implement the relevant functions and configurations for each strategy
    //challengingStrategy: ActionStrategy.CAPTCHA

    // The redirect url when decision was made to redirect the traffic
    //redirectLocation: 'https://www.cheq.ai/',

    challenge: turnstileChallengeExample,
    validateChallenge: trunstileValidateChallengeExample,

    // Example for ignored paths
    ignorePaths: [
        // Static assets — no user interaction, no value in RTI evaluation
        '\\.css$', '\\.js$', '\\.mjs$', '\\.map$',
        '\\.png$', '\\.jpg$', '\\.jpeg$', '\\.gif$', '\\.webp$', '\\.svg$', '\\.ico$',
        '\\.woff$', '\\.woff2$', '\\.ttf$', '\\.eot$',
        '\\.mp4$', '\\.webm$', '\\.mp3$',
        '\\.pdf$', '\\.zip$',

        // Well-known browser/crawl requests
        '^/favicon\\.ico$',
        '^/robots\\.txt$',
        '^/sitemap.*\\.xml$',
        '^/ads\\.txt$',

        // Health checks and monitoring (AWS ALB, Route53, uptime services)
        '^/health$',
        '^/healthcheck$',
        '^/ping$',
        '^/status$',

        // Internal / infrastructure paths
        '^/_next/',        // Next.js static files and HMR
        '^/__webpack',     // Webpack HMR
        '^/static/',       // Generic static directory
        '^/assets/',       // Generic assets directory
    ],
        
    timeout: 500,
    debug: false, // Set to true to enable debug logging, false for production
    telemetry: false,
    keepHeadersNames: [], // Optional: specify headers to keep in the request sent to RTI, otherwise all headers will be kept (in this case, pass empty array)
};
