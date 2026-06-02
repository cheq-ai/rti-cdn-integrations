// cspell:ignore PMUSER CHEQ healthcheck rtilogger
import { log } from 'log';
import { Config } from '../../core/models/config.interface';
import { RTIHelperService } from '../../core/services/rti-helper.service';
import { Mode } from '../../core/models/mode.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { RTIResponse } from '../../core/models/rti-response.model';
import { turnstileChallengeExample, turnstileValidateChallengeExample } from './turnstile-challenge-example';

/**
 * See {@link https://cheq-ai.github.io/rti-cdn-integrations/interfaces/Config.html | Config}
 */
export interface AkamaiConfig extends Config {
    /**
     * Hostname of the Akamai-proxied RTI endpoint (without protocol).
     * You must configure an Akamai property that forwards this hostname to rti-global.cheqzone.com.
     * @example "rti-proxy.your-domain.com"
     */
    rtiHost: string;

    /**
     * Callback invoked when Action.CHALLENGE is returned.
     * Receives the EWRequest and RTIResponse; returns { html, headers } to respondWith.
     */
    challenge?: (request: EWRequest, response: RTIResponse) => Promise<{ html: string; headers: Record<string, string> }>;

    /**
     * Validates an existing challenge session cookie at the start of each request.
     * If true, RTI check is skipped and the request passes to origin.
     */
    validateChallenge?: (request: EWRequest) => Promise<boolean>;

    /**
     * Hostname of the Akamai-proxied RTI logger endpoint (without protocol).
     * You must configure an Akamai property that forwards this hostname to rtilogger.production.cheq-platform.com.
     * When absent, telemetry and error logging are disabled.
     * @example "rti-logger-proxy.your-domain.com"
     */
    rtiLoggerHost?: string;
}

/**
 * Static pre-configured config — edit directly and deploy.
 * Use this instead of buildDynamicConfig if you prefer hardcoded values over PMUSER variables.
 */
export const config: AkamaiConfig = {
    mode: Mode.MONITORING, // Start with MONITORING to observe before enforcing with BLOCKING

    apiKey:  'REPLACE_ME', // Replace with your actual API key
    tagHash: 'REPLACE_ME', // Replace with your actual Tag Hash
    rtiHost: 'REPLACE_ME', // Replace with your Akamai-proxied RTI hostname (e.g. rti-proxy.your-domain.com)

    // By default we use ActionStrategy.ACCESS_DENIED but you can set it to REDIRECT or CAPTCHA as well
    //blockingStrategy: ActionStrategy.ACCESS_DENIED,

    // By default we use ActionStrategy.CAPTCHA but you can set it to REDIRECT or ACCESS_DENIED as well
    //challengingStrategy: ActionStrategy.CAPTCHA,

    // The redirect url when decision was made to redirect the traffic
    //redirectLocation: 'https://www.cheq.ai/',

    challenge: turnstileChallengeExample,
    validateChallenge: turnstileValidateChallengeExample,

    ignorePaths: [
        // Static assets
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

        // Health checks
        '^/health$',
        '^/healthcheck$',
        '^/ping$',
        '^/status$',

        // Internal / infrastructure paths
        '^/static/',
        '^/assets/',
        '^/_next/',        // Next.js static files and HMR
        '^/__webpack',     // Webpack HMR
    ],

    timeout: 300,
    debug: false,
    telemetry: false,
};

/**
 * Builds config entirely from Akamai Property Manager variables (PMUSER_*).
 * All values must be set in the Akamai Control Center — nothing is hardcoded here.
 * See README.md for the full list of supported variables and their descriptions.
 * 
 * PMUSER Variables:
 *   PMUSER_CHEQ_USE_DYNAMIC_CONFIG — "true" to read all config from PMUSER variables; omit or "false" to use the static config object
 *   PMUSER_CHEQ_API_KEY            — Your CHEQ API key
 *   PMUSER_CHEQ_TAG_HASH           — Your tag hash
 *   PMUSER_CHEQ_RTI_HOST           — Akamai-proxied RTI hostname (e.g. rti-proxy.your-domain.com)
 *   PMUSER_CHEQ_MODE               — "MONITORING" or "BLOCKING" (default: MONITORING)
 *   PMUSER_CHEQ_TIMEOUT            — RTI timeout in ms (default: 300)
 *   PMUSER_CHEQ_DEBUG              — "true" to enable debug response headers
 *   PMUSER_CHEQ_TELEMETRY          — "true" to enable telemetry logging
 *   PMUSER_CHEQ_BLOCK_STRATEGY     — "ACCESS_DENIED", "NOT_FOUND", "REDIRECT", or "CAPTCHA"
 *   PMUSER_CHEQ_CHALLENGE_STRATEGY — "ACCESS_DENIED", "NOT_FOUND", "REDIRECT", or "CAPTCHA"
 *   PMUSER_CHEQ_BLOCK_TT_CODES     — Comma-separated threat type codes to block (e.g. "4,5,6")
 *   PMUSER_CHEQ_BLOCK_REASONS      — Comma-separated reason codes to block
 *   PMUSER_CHEQ_CHALLENGE_TT_CODES — Comma-separated threat type codes to challenge
 *   PMUSER_CHEQ_CHALLENGE_REASONS  — Comma-separated reason codes to challenge
 *   PMUSER_CHEQ_REDIRECT_TT_CODES  — Comma-separated threat type codes to redirect
 *   PMUSER_CHEQ_REDIRECT_REASONS   — Comma-separated reason codes to redirect
 *   PMUSER_CHEQ_REDIRECT_LOCATION  — Redirect destination URL
 *   PMUSER_CHEQ_IGNORE_PATHS       — Comma-separated regex patterns for paths to skip
 */
export function buildDynamicConfig(request: EWRequest): AkamaiConfig {
    const modeStr = request.getVariable('PMUSER_CHEQ_MODE') ?? Mode[Mode.MONITORING];
    
    // NaN (missing/invalid), 0, and negatives all fall back to 300.
    const timeout = Math.max(parseInt(request.getVariable('PMUSER_CHEQ_TIMEOUT') ?? '', 10), 0) || 300;

    const blockStrategyStr = request.getVariable('PMUSER_CHEQ_BLOCK_STRATEGY') as keyof typeof ActionStrategy | undefined;
    const challengeStrategyStr = request.getVariable('PMUSER_CHEQ_CHALLENGE_STRATEGY') as keyof typeof ActionStrategy | undefined;

    const config: AkamaiConfig = {
        apiKey:    request.getVariable('PMUSER_CHEQ_API_KEY')    ?? '',
        tagHash:   request.getVariable('PMUSER_CHEQ_TAG_HASH')   ?? '',
        rtiHost:   request.getVariable('PMUSER_CHEQ_RTI_HOST')   ?? '',
        mode:      Mode[modeStr as keyof typeof Mode] ?? Mode.MONITORING,
        timeout,
        debug:     request.getVariable('PMUSER_CHEQ_DEBUG') === 'true',
        telemetry: request.getVariable('PMUSER_CHEQ_TELEMETRY') === 'true',

        blockingStrategy:    blockStrategyStr    ? ActionStrategy[blockStrategyStr]    : undefined,
        challengingStrategy: challengeStrategyStr ? ActionStrategy[challengeStrategyStr] : undefined,

        blockTTCodes:     RTIHelperService.parseNumberList(request.getVariable('PMUSER_CHEQ_BLOCK_TT_CODES')),
        blockReasons:     RTIHelperService.parseNumberList(request.getVariable('PMUSER_CHEQ_BLOCK_REASONS')),
        
        challengeTTCodes: RTIHelperService.parseNumberList(request.getVariable('PMUSER_CHEQ_CHALLENGE_TT_CODES')),
        challengeReasons: RTIHelperService.parseNumberList(request.getVariable('PMUSER_CHEQ_CHALLENGE_REASONS')),
        
        redirectTTCodes:  RTIHelperService.parseNumberList(request.getVariable('PMUSER_CHEQ_REDIRECT_TT_CODES')),
        redirectReasons:  RTIHelperService.parseNumberList(request.getVariable('PMUSER_CHEQ_REDIRECT_REASONS')),
        redirectLocation: request.getVariable('PMUSER_CHEQ_REDIRECT_LOCATION'),

        ignorePaths: RTIHelperService.parseStringList(request.getVariable('PMUSER_CHEQ_IGNORE_PATHS')),

        rtiLoggerHost: request.getVariable('PMUSER_CHEQ_RTI_LOGGER_HOST') || undefined,

        // Callbacks cannot be expressed as panel variables — wired in code.
        challenge:         turnstileChallengeExample,
        validateChallenge: turnstileValidateChallengeExample,
    };

    if (config.debug) {
        const { apiKey: _k, tagHash: _t, ...safeConfig } = config;
        log.log('cheq config:', JSON.stringify(safeConfig));
    }

    return config;
}
