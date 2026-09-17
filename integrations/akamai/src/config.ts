// cspell:ignore PMUSER CHEQ healthcheck rtilogger
import { logger as log } from 'log';
import { Config } from '../../core/models/config.interface';
import { RTIHelperService } from '../../core/services/rti-helper.service';
import { Mode } from '../../core/models/mode.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { RTIResponse } from '../../core/models/rti-response.model';
import { createCheqChallenge } from './cheq-challenge';
import { createRecaptchaChallenge, createRecaptchaSessionValidator, RECAPTCHA_V2_TEST_SITE_KEY, RECAPTCHA_V2_TEST_SECRET } from './recaptcha-v2-challenge';
import { readChallengeSecret } from './challenge-signing';

/**
 * See {@link https://cheq-ai.github.io/rti-cdn-integrations/interfaces/Config.html | Config}
 */
/**
 * Which challenge UI to serve when the action is CHALLENGE and challengingStrategy is CAPTCHA.
 * - `recaptcha-v2` Google "I'm not a robot" checkbox (needs Google site + secret keys)
 * - `recaptcha-v3` Google invisible score-based (needs Google keys + a score threshold)
 * - `browser`      self-contained JS interstitial, no third party involved
 */
export type ChallengeProvider = 'recaptcha-v2' | 'recaptcha-v3' | 'browser';

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

    /**
     * Which challenge UI to serve. Default `recaptcha-v2`.
     * Legacy alias `recaptcha` (in PMUSER) maps to `recaptcha-v2`.
     */
    challengeProvider?: ChallengeProvider;

    /**
     * True when usable Google reCAPTCHA site + secret keys and a verify host are present.
     * This says nothing about whether a challenge is available - the `browser` provider needs
     * no Google keys at all. For that question use `challenge !== undefined`, which cannot
     * drift out of step with what is actually wired.
     */
    googleRecaptchaConfigured?: boolean;

    /**
     * v3 only - minimum Google score to pass (0.0 bot .. 1.0 human). Default 0.5.
     * Settable via PMUSER_CHEQ_RECAPTCHA_MIN_SCORE.
     */
    recaptchaScoreThreshold?: number;
}


// `debug` is required rather than defaulted: the one caller always passes it, so a default was
// an unreachable branch, and requiring it makes any future caller state its intent.
function normalizeProvider(raw: string | undefined, debug: boolean): ChallengeProvider {
    const v = (raw ?? 'recaptcha-v2').toLowerCase();
    if (v === 'browser') return 'browser';
    if (v === 'recaptcha-v3' || v === 'v3') return 'recaptcha-v3';
    // 'recaptcha' is a legacy alias for v2. Anything else is a typo: fall back rather than throw,
    // but say so - otherwise e.g. 'broswer' silently becomes reCAPTCHA-without-keys, i.e. no
    // challenge at all, with nothing explaining why.
    if (debug && v !== 'recaptcha-v2' && v !== 'recaptcha') {
        log.log(`[cheq] unrecognised PMUSER_CHEQ_CHALLENGE_PROVIDER '${raw}', using recaptcha-v2`);
    }
    return 'recaptcha-v2';
}

/** Google keys are usable when both are present and neither is still a placeholder. */
function isGoogleRecaptchaConfigured(siteKey?: string, secret?: string): boolean {
    const sk = (siteKey ?? '').trim();
    const sec = (secret ?? '').trim();
    if (!sk || !sec) return false;
    return sk !== 'REPLACE_ME' && sec !== 'REPLACE_ME';
}

type RecaptchaKeyOpts = {
    siteKey?: string;
    secret?: string;
    /** Host for the verify sub-request - the property carrying the /recaptcha/* self-proxy rule. */
    verifyHost?: string;
    scoreThreshold?: number;
    /** Seconds a passed CAPTCHA stays valid before re-challenge. Default 900. */
    sessionTtlSeconds?: number;
    /** Explicit opt-in to Google's always-pass v2 test keys, for demos only. */
    useTestKeys?: boolean;
};

/**
 * THE single place that decides whether a challenge can be served, and which one.
 *
 * Both preconditions are checked here and nowhere else:
 *   1. a signing secret for the `_cq_se` cookie (PMUSER_CHEQ_CHALLENGE_SECRET)
 *   2. a usable provider - `browser` needs nothing further; the reCAPTCHA providers need
 *      Google site + secret keys AND a verify host for the self-proxy sub-request
 *
 * Failing either returns no callbacks, so `config.challenge === undefined` is the one true
 * answer to "is a challenge available". The providers no longer look the secret up themselves;
 * it is bound into them here, so the rule cannot drift between three files.
 */
function resolveChallengeCallbacks(
    provider: ChallengeProvider,
    challengeSecret: string | undefined,
    recaptcha?: RecaptchaKeyOpts,
): { callbacks: Pick<AkamaiConfig, 'challenge' | 'validateChallenge'>; googleRecaptchaConfigured: boolean } {
    // Without a signing secret every token and cookie we issued would be forgeable, and that
    // cookie authorises skipping RTI. No secret means no challenge, whatever else is set.
    if (!challengeSecret) {
        return { callbacks: {}, googleRecaptchaConfigured: false };
    }

    if (provider === 'browser') {
        return {
            callbacks: createCheqChallenge(challengeSecret),
            googleRecaptchaConfigured: false, // no Google keys involved; a challenge IS available
        };
    }

    let siteKey = recaptcha?.siteKey;
    let secret = recaptcha?.secret;

    // Opt-in only: never silently fall back to test keys, or an operator would believe CAPTCHA
    // was protecting them while Google's test keys pass every request by design.
    if (provider === 'recaptcha-v2' && recaptcha?.useTestKeys && !isGoogleRecaptchaConfigured(siteKey, secret)) {
        siteKey = RECAPTCHA_V2_TEST_SITE_KEY;
        secret = RECAPTCHA_V2_TEST_SECRET;
    }

    const verifyHost = recaptcha?.verifyHost || '';
    if (!isGoogleRecaptchaConfigured(siteKey, secret) || !verifyHost) {
        return { callbacks: {}, googleRecaptchaConfigured: false };
    }

    return {
        callbacks: {
            challenge: createRecaptchaChallenge({
                version: provider === 'recaptcha-v3' ? 'v3' : 'v2',
                siteKey: siteKey!,
                secret: secret!,
                verifyHost,
                scoreThreshold: recaptcha?.scoreThreshold,
                sessionTtlSeconds: recaptcha?.sessionTtlSeconds,
                sessionSecret: challengeSecret,
            }),
            validateChallenge: createRecaptchaSessionValidator(challengeSecret),
        },
        googleRecaptchaConfigured: true,
    };
}

/**
 * Paths skipped before any RTI call. Shared by both configuration paths: the static config
 * below, and `buildDynamicConfig` whenever `PMUSER_CHEQ_IGNORE_PATHS` is unset.
 *
 * That fallback matters. `parseStringList` returns undefined for an unset variable and
 * `shouldIgnore()` reads undefined as "ignore nothing", so a dynamic config without the
 * variable would classify every stylesheet, image and favicon - and, far worse, would stop
 * excluding the worker's own self-proxy paths, which must never be classified themselves.
 *
 * Setting the variable REPLACES this list rather than extending it, so an operator who
 * narrows it must keep `^/defend/` and, when using a Google CAPTCHA, `^/recaptcha/`.
 */
export const DEFAULT_IGNORE_PATHS: string[] = [
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

    // Akamai self-proxy paths - the EdgeWorker's own sub-requests route back
    // through this property, so they must never be classified themselves.
    '^/defend/',       // RTI self-proxy (see rtiHost)
    '^/recaptcha/',    // Google verify self-proxy, when a CAPTCHA provider is configured
    '^/akamai/',       // Akamai-internal paths

    '^/_next/',        // Next.js static files and HMR
    '^/__webpack',     // Webpack HMR
    ];

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

    // Challenge provider, recorded for reference. No callbacks are wired on this path: the
    // _cq_se signing secret comes from the PMUSER_CHEQ_CHALLENGE_SECRET property variable, which
    // only exists per request, whereas this object is built once at module load. Serving a
    // challenge signed with a bundled key would make it forgeable, so the static path
    // deliberately offers none - use buildDynamicConfig (PMUSER_CHEQ_USE_DYNAMIC_CONFIG=true)
    // if you want CAPTCHA.
    challengeProvider: 'recaptcha-v2',
    challenge: undefined,
    validateChallenge: undefined,

    ignorePaths: [...DEFAULT_IGNORE_PATHS],

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

    const isDebugMode = request.getVariable('PMUSER_CHEQ_DEBUG') === 'true';

    // Captcha resolution logic:
    // ---------------------------------------------------------------------------------------------

    const challengeProvider = normalizeProvider(request.getVariable('PMUSER_CHEQ_CHALLENGE_PROVIDER') ?? undefined, isDebugMode);

    // score threshold for reCAPTCHA v3. If not set, the default is 0.5 (Google's default)
    const scoreRaw = request.getVariable('PMUSER_CHEQ_RECAPTCHA_MIN_SCORE');
    const scoreParsed = scoreRaw ? parseFloat(scoreRaw) : NaN;
    const scoreThreshold = !isNaN(scoreParsed) ? scoreParsed : undefined;

    // Seconds a passed CAPTCHA session stays valid before the visitor is re-challenged.
    // Radix 10 - parseInt's second argument is the base, not a fallback value. Passing 600
    // there is an invalid radix, which makes parseInt return NaN for every input and silently
    // disables the variable. An unset/invalid value falls through to the provider default (900s).
    const ttlRaw = parseInt(request.getVariable('PMUSER_CHEQ_CHALLENGE_TTL') ?? '', 10);
    const challengeTtl = !isNaN(ttlRaw) && ttlRaw > 0 ? ttlRaw : undefined;
    const recaptchaKeyOpts: RecaptchaKeyOpts = {
        siteKey: request.getVariable('PMUSER_CHEQ_RECAPTCHA_SITE_KEY') || undefined,
        secret:  request.getVariable('PMUSER_CHEQ_RECAPTCHA_SECRET') || undefined,
        // The verify sub-request Host must be THIS property (self-proxy /recaptcha/* -> google).
        // Falls back to RTI_HOST so clients need not configure a third copy of the hostname.
        verifyHost: request.getVariable('PMUSER_CHEQ_RECAPTCHA_HOST')
            || request.getVariable('PMUSER_CHEQ_RTI_HOST')
            || undefined,
        scoreThreshold,
        sessionTtlSeconds: challengeTtl,
        useTestKeys: request.getVariable('PMUSER_CHEQ_RECAPTCHA_TEST_KEYS') === 'true',
    }

    const { callbacks, googleRecaptchaConfigured } = resolveChallengeCallbacks(
        challengeProvider, 
        readChallengeSecret(request), 
        recaptchaKeyOpts
    );
    // ---------------------------------------------------------------------------------------------

    const blockStrategyStr = request.getVariable('PMUSER_CHEQ_BLOCK_STRATEGY') as keyof typeof ActionStrategy | undefined;
    const challengeStrategyStr = request.getVariable('PMUSER_CHEQ_CHALLENGE_STRATEGY') as keyof typeof ActionStrategy | undefined;

    const config: AkamaiConfig = {
        apiKey:    request.getVariable('PMUSER_CHEQ_API_KEY')    ?? '',
        tagHash:   request.getVariable('PMUSER_CHEQ_TAG_HASH')   ?? '',
        rtiHost:   request.getVariable('PMUSER_CHEQ_RTI_HOST')   ?? '',
        mode:      Mode[modeStr as keyof typeof Mode] ?? Mode.MONITORING,
        timeout,
        debug: isDebugMode,
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

        ignorePaths: RTIHelperService.parseStringList(request.getVariable('PMUSER_CHEQ_IGNORE_PATHS')) ?? [...DEFAULT_IGNORE_PATHS],

        rtiLoggerHost: request.getVariable('PMUSER_CHEQ_RTI_LOGGER_HOST') || undefined,

        challengeProvider,
        googleRecaptchaConfigured,
        recaptchaScoreThreshold: scoreThreshold,

        // Callbacks cannot be expressed as panel variables - resolved above from the provider,
        // the Google keys and the signing secret. Empty when a challenge cannot be served.
        ...callbacks,
    };

    if (config.debug) {
        const { apiKey: _k, tagHash: _t, ...safeConfig } = config;
        log.log('cheq config:', JSON.stringify(safeConfig));
    }

    return config;
}
