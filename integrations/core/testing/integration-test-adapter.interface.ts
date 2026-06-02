/**
 * Richer adapter contract used by the shared integration test suite.
 *
 * ## Difference from TestAdapter (unit tests)
 * Unit tests (`TestAdapter`) mock `getAction`, `getActionStrategy`, `shouldIgnore` etc. so
 * tests control decisions precisely. Integration tests go one level deeper: they use the
 * **real** `RTIHelperService` for all decision logic and only mock the network boundary
 * (`RTIService.callRTI` or Akamai's `callRTI`). This catches bugs that unit tests miss — for
 * example, if `getAction` never returned BLOCK even for malicious verdicts, unit tests would
 * still pass (they mock it), but the integration test "returns 403 on malicious verdict"
 * would fail immediately.
 *
 * ## rtiPayload
 * Unlike `NormalizedResult`, `IntegrationNormalizedResult` exposes `rtiPayload` — the raw
 * object that was actually passed to the RTI network call. This lets integration tests assert
 * on real cookie extraction, header collection, clientIp, method and URL construction as
 * performed by the actual `RTIHelperService.parseCookies` logic, not a mock.
 *
 * ## Config control
 * Rather than a `setConfig()` method on the adapter, configuration is controlled through the
 * external `setConfig` function passed directly to `registerSharedIntegrationTests`. This
 * allows the config to be reset to a full known baseline between tests, including all fields
 * that unit tests never vary (blockTTCodes, redirectTTCodes, blockingStrategy, ignorePaths…).
 *
 * @see registerSharedIntegrationTests in ./shared-integration-tests.ts
 * @see TestAdapter in ./test-adapter.interface.ts for the unit-test variant
 */
import type { RTIResponse } from '../models/rti-response.model';

/** 
 * Richer result shape returned by integration test invocations. Includes the raw RTI
 *  request payload so tests can assert on what was actually sent to the network call. 
 */
export interface IntegrationInvokeOptions {
    path?: string;
    method?: string;
    cookies?: string;
    querystring?: string;
    ip?: string;
    headers?: Record<string, string>;
}

/** 
 * CDN-agnostic result that also exposes the raw RTI request payload that was sent.
 *  `rtiPayload` is `undefined` when RTI was never called (e.g. path was ignored). 
 */
export interface IntegrationNormalizedResult {
    status: number;
    headers: Record<string, string>;
    body: string;
    passedThrough: boolean;
    rtiPayload: any | undefined;
}

/**
 * Contract each CDN integration must implement to participate in the shared integration
 * test suite. Only the network boundary is mocked — everything else runs as in production.
 */
export interface IntegrationTestAdapter {
    name: string;
    invoke(options?: IntegrationInvokeOptions): Promise<IntegrationNormalizedResult>;
    /** Prime the mock network call to resolve with a specific RTI response. */
    setRtiResponse(response: Partial<RTIResponse>): void;
    /** Prime the mock network call to reject with the given error (simulates network failure). */
    setRtiError(error: Error): void;
}
