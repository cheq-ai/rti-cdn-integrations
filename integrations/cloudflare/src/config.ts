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
     * Callback function invoked when {@link Action.CHALLENGE | Action } output is returned
     * @param request
     * @param response
     */
    challenge?: (request: Request, response: RTIResponse) => Promise<Response>;

    /**
     * Validate session of challenge function invoked at the beggining of the request to skip RTI check and allow the request to pass to origin
     * @param request
     */
    validateChallenge?: (request: Request) => Promise<boolean>;
}

export const config: CloudflareConfig = {
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
    telemetry: false
};
