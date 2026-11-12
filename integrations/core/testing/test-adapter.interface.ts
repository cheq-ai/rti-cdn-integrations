/**
 * Shared unit-test adapter pattern for CDN integration behavioral tests.
 *
 * ## The problem
 * Cloudflare, CloudFront and Akamai all implement the same RTI decision pipeline, but each
 * exposes a different request/response API surface. Without a shared layer every CDN would
 * need its own 40+ copy-pasted tests; a single behavior change would require fixes in three
 * places and could easily be missed.
 *
 * ## The solution — adapter pattern
 * Each CDN implements `TestAdapter`, which translates its native format into the common
 * `NormalizedResult` shape. `registerSharedBehaviorTests` then drives all CDNs through the
 * same 49 tests (3 only where `validChallengeSkipsRti` is true) without knowing any CDN-specific details.
 *
 * ## What is mocked vs real
 * CDN adapters mock the core service methods via `SharedMocks` (callRTI, shouldIgnore,
 * getAction, getActionStrategy, generateDefaultBlockPage) so tests control decisions
 * precisely. `parseCookies` and `buildRtiResultHeader` are intentionally left as real
 * implementations so tests verify actual output, not duplicated mock formulas.
 *
 * @see registerSharedBehaviorTests in ./shared-unit-tests.ts
 * @see IntegrationTestAdapter in ./integration-test-adapter.interface.ts for the richer
 *      variant used when the real RTIHelperService decision logic should run end-to-end.
 */
import type { MockInstance } from 'vitest';

/** CDN-agnostic representation of the result of a single handled request. */
export interface NormalizedResult {
    status: number;
    headers: Record<string, string>;
    body: string;
    passedThrough: boolean;
}

/** 
 * Options that can be varied per test invocation. All fields are optional — omitting
 *  them produces a default GET /page request with no cookies or extra headers. 
 */
export interface InvokeOptions {
    path?: string;
    cookies?: string;
    querystring?: string;
    method?: string;
    ip?: string;
    headers?: Record<string, string>;
}

/** 
 * The subset of CDN config that shared behavioral tests need to toggle between tests.
 *  Passed to `TestAdapter.setConfig()`. Fields not listed here (e.g. apiKey, tagHash)
 *  are fixed by each CDN adapter's beforeEach reset and never varied by shared tests. 
 */
export interface ConfigOverrides {
    debug?: boolean;
    telemetry?: boolean;
    redirectLocation?: string | undefined;
    challenge?: any;
    validateChallenge?: any;
}

/** 
 * Vitest mock handles that shared behavioral tests manipulate directly to control
 *  what the CDN handler decides, without knowing how each CDN invokes those methods.
 *  Each CDN adapter wires these into its vi.mock() factory so the same mock instances
 *  are shared between the adapter and the test suite.
 *
 *  `loggerError` and `loggerInfo` are the RTI logger mock handles. For Cloudflare they come from
 *  the `RTILoggerService` mock, for CloudFront from the `RTIHttpsLoggerService` mock (`logger.error` / `logger.info`).
 *  For Akamai they come from the `logToRTI` mock (which fills both roles). 
 */
export interface SharedMocks {
    callRTI: MockInstance;
    shouldIgnore: MockInstance;
    getAction: MockInstance;
    getActionStrategy: MockInstance;
    generateDefaultBlockPage: MockInstance;
    loggerError: MockInstance;
    loggerInfo: MockInstance;
}
/**
 * Contract that each CDN integration's test file must implement to participate in the
 * shared behavioral test suite.
 *
 * Methods fall into two categories:
 *
 * **Execution** — `invoke()` fires a real request through the CDN handler (Cloudflare
 * Worker fetch, CloudFront Lambda@Edge handle, Akamai onClientRequest) and translates
 * the CDN-native response into `NormalizedResult`. This is the only place that knows
 * about CDN-specific API shapes.
 *
 * **Test control** — `setConfig`, `resetConfig`, `getLastRTIPayload`, `assertDebugLogged`,
 * `assertNotDebugLogged`, `assertErrorLogged`, `wasTelemetryLogged` let shared tests
 * change configuration and assert on side effects (logs, telemetry) without knowing how
 * each CDN implements them.
 */
export interface TestAdapter {
    name: string;
    /**
     * true: a valid challenge session (validateChallenge → true) skips RTI and passes the request through
     * untouched (Cloudflare, Akamai). false: RTI always runs, and a valid session only waives the CAPTCHA
     * (CloudFront). The shared tests for the old behaviour run only when this is true; CloudFront covers
     * the new behaviour in its own spec. Flip it when a CDN moves to the new behaviour.
     */
    validChallengeSkipsRti: boolean;
    invoke(options?: InvokeOptions): Promise<NormalizedResult>;
    getLastRTIPayload(): any | undefined;
    setConfig(overrides: ConfigOverrides): void;
    resetConfig(): void;
    assertDebugLogged(substring: string): void;
    assertNotDebugLogged(): void;
    /** Fails if any debug log line contains `substring`, e.g. a cookie value or token that must be redacted. */
    assertNotInDebugLogs(substring: string): void;
    assertErrorLogged(substring: string): void;
    wasTelemetryLogged(): boolean;
}
