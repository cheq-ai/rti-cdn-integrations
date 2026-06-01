// cspell:ignore duid pvid cheq SCOOKIE
/**
 * Shared integration test suite — registered once per CDN integration.
 *
 * ## Difference from shared-unit-tests (unit level)
 * Unit behavioral tests mock `getAction`, `getActionStrategy`, `shouldIgnore` etc. so
 * every decision is controlled precisely. These integration tests go one level deeper:
 * only the network boundary (`RTIService.callRTI` / Akamai's `callRTI`) is mocked.
 * Everything else — `RTIHelperService.getAction`, `getActionStrategy`, `shouldIgnore`,
 * `parseCookies`, `buildRtiResultHeader` — runs as real code.
 *
 * This catches bugs that unit tests miss. If `getAction` had a bug and never returned
 * BLOCK even for malicious verdicts, all unit tests would still pass (they mock it), but
 * the integration test "returns 403 on malicious verdict in BLOCKING mode" would fail.
 *
 * ## What it proves end-to-end
 *   ALLOW pipeline       real getAction → ALLOW → buildRtiResultHeader formats the header
 *   MONITORING mode      Mode.MONITORING short-circuit in getAction passes through malicious
 *   BLOCK by verdict     malicious verdict → getAction returns BLOCK → 403
 *   BLOCK by TT code     blockTTCodes config field read by getAction → 403
 *   REDIRECT by TT code  redirectTTCodes config → getAction + getActionStrategy → 302
 *   ignorePaths          shouldIgnore regex matching; rtiPayload is undefined (RTI not called)
 *   Cookie forwarding    parseCookies extracts real cookies into the payload
 *   Fail open            network error → catch block → request passes through
 *   NOT_FOUND strategy   blockingStrategy config honored → 404
 *   Custom redirect      redirectLocation config honored → correct 302 URL
 *   Header format        buildRtiResultHeader output: version=;verdict=;threat-type-code=;ids=
 *
 * ## How to use
 * Each CDN creates an `IntegrationTestAdapter` (mocking only the network call), then calls
 * `registerSharedIntegrationTests(adapter, setConfig)` once. The tests are registered
 * under an `[integration] {cdn-name}` describe block automatically.
 *
 * @see IntegrationTestAdapter in ./integration-test-adapter.interface.ts
 * @see registerSharedBehaviorTests in ./shared-unit-tests.ts for the unit-level suite
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Mode } from '../models/mode.model';
import { ActionStrategy } from '../models/action-strategy.model';
import type { IntegrationTestAdapter } from './integration-test-adapter.interface';
import { buildRTIResponse } from './rti-response.fixture';

// Same value as in shared-unit-tests — realistic base64-padded cookie with : and / characters
const B64_SCOOKIE = 'c0hdForhWGaRercD:kc/eGTcRHnanstWrlbv6fnBWg/kICuKe+hRiK6x9lCwkrSdhpKIohwyd7/JHH3aA81pNurK0WfbwmJfGwL61DFBsgrr3wYpT8muwEt/xhOrFe3Ejee4W86fnE/fe0l1b1+ld6JwCiA7tueF0weoJStmpVEKW8PTz+JTkOf9jMfEE/HYNMrG22F+h7w68Td+JeCURnRPp48TbVAtusLvNuwWwWSyuI/7OfV6akdMrey+Mr2b8i8+w9Cm58M+Ttq1ydQPcQbHGOPfI5InnCSqHbGT0mUMxdodBMXFmvQgTN07lge/+zjGSH2+s+a0b60QlNOa6rw==:Ki6FWCQbEiMijlXZ/6/BNQ==';

const BASE_CONFIG = {
    mode: Mode.BLOCKING,
    apiKey: 'test-api-key',
    tagHash: 'test-tag-hash',
    telemetry: false,
    debug: false,
};

/**
 * Registers integration tests that exercise the real RTIHelperService decision logic.
 * Each CDN adapter mocks only the network boundary (callRTI / httpRequest).
 */
export function registerSharedIntegrationTests(
    adapter: IntegrationTestAdapter,
    setConfig: (config: any) => void,
): void {
    describe(`[integration] ${adapter.name}`, () => {
        beforeEach(() => {
            setConfig({ ...BASE_CONFIG });
            adapter.setRtiResponse(buildRTIResponse());
        });

        //#region ALLOW tests

        it('passes through and sets x-cheq-rti-result on benign verdict', async () => {
            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeDefined();
            expect(result.headers['x-cheq-rti-result']).toContain('verdict=benign');
            expect(result.headers['x-cheq-rti-result']).toMatch(/version=[^;]+;verdict=[^;]+;threat-type-code=\d+;ids=\{/);
            expect(result.headers['x-cheq-rti-result']).not.toContain('reasons=');
            expect(result.headers['x-cheq-rti-result']).not.toContain('test-api-key');
            expect(result.headers['location']).toBeUndefined();
            expect(result.body).not.toContain('Access Denied');
            expect(result.rtiPayload).toBeDefined();
        });

        //#endregion ALLOW tests

        //#region MONITORING mode tests

        it('passes through even on malicious verdict in MONITORING mode', async () => {
            // Arrange
            setConfig({ ...BASE_CONFIG, mode: Mode.MONITORING });
            adapter.setRtiResponse(buildRTIResponse({ verdict: 'malicious', code: 0 }));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeDefined();
            expect(result.headers['x-cheq-rti-result']).toContain('verdict=malicious');
            expect(result.headers['x-cheq-rti-result']).toContain('version=');
            expect(result.headers['x-cheq-rti-result']).toContain('threat-type-code=');
            expect(result.headers['location']).toBeUndefined();
            expect(result.body).not.toContain('blocked');
            expect(result.rtiPayload).toBeDefined();
        });

        //#endregion MONITORING mode tests

        //#region Block strategies tests

        it('returns 403 on malicious verdict in BLOCKING mode', async () => {
            // Arrange
            adapter.setRtiResponse(buildRTIResponse({ verdict: 'malicious' }));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(403);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['content-type']).toMatch(/text\/html/);
            expect(result.headers['content-type']).toContain('charset=UTF-8');
            expect(result.body).toBeDefined();
            expect(result.body).toContain('blocked');
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(result.headers['location']).toBeUndefined();
            expect(result.headers['x-cheq-id']).toBeUndefined();
            expect(result.headers['x-cheq-page-view-id']).toBeUndefined();
            expect(result.rtiPayload).toBeDefined();
        });

        it('returns 403 when classification code is in blockTTCodes', async () => {
            // Arrange
            setConfig({ ...BASE_CONFIG, blockTTCodes: [5, 6] });
            // benign verdict but code 5 triggers block
            adapter.setRtiResponse(buildRTIResponse({ verdict: 'benign', code: 5 }));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(403);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['content-type']).toMatch(/text\/html/);
            expect(result.headers['content-type']).toContain('charset=UTF-8');
            expect(result.body).toBeDefined();
            expect(result.body).toContain('blocked');
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(result.headers['location']).toBeUndefined();
            expect(result.headers['x-cheq-id']).toBeUndefined();
            expect(result.headers['x-cheq-page-view-id']).toBeUndefined();
            expect(result.rtiPayload).toBeDefined();
            expect(result.rtiPayload.endUserParams).toBeDefined();
        });

        it('returns 404 when blockingStrategy is NOT_FOUND and verdict is malicious', async () => {
            // Arrange
            setConfig({ ...BASE_CONFIG, blockingStrategy: ActionStrategy.NOT_FOUND });
            adapter.setRtiResponse(buildRTIResponse({ verdict: 'malicious' }));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(404);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['content-type']).toMatch(/text\/html/);
            expect(result.headers['content-type']).toContain('charset=UTF-8');
            expect(result.body).toBeDefined();
            expect(result.body).toContain('blocked');
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(result.headers['location']).toBeUndefined();
            expect(result.headers['x-cheq-id']).toBeUndefined();
            expect(result.headers['x-cheq-page-view-id']).toBeUndefined();
            expect(result.rtiPayload).toBeDefined();
        });

        //#endregion Block strategies tests

        //#region Redirect tests

        it('returns 302 when classification code is in redirectTTCodes', async () => {
            // Arrange
            setConfig({ ...BASE_CONFIG, redirectTTCodes: [10], redirectLocation: 'https://redirect.example.com/' });
            adapter.setRtiResponse(buildRTIResponse({ verdict: 'benign', code: 10 }));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(302);
            expect(result.headers['location']).toBe('https://redirect.example.com/');
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(result.headers['x-cheq-id']).toBeDefined();
            expect(result.headers['x-cheq-page-view-id']).toBeDefined();
            expect(result.headers['x-cheq-cdn-request-id']).toBeDefined();
            expect(result.body).not.toContain('Access Denied');
            expect(result.rtiPayload).toBeDefined();
        });

        it('uses custom redirectLocation when configured for REDIRECT action', async () => {
            // Arrange
            setConfig({ ...BASE_CONFIG, redirectTTCodes: [7], redirectLocation: 'https://custom.example.com/' });
            adapter.setRtiResponse(buildRTIResponse({ verdict: 'benign', code: 7 }));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(302);
            expect(result.headers['location']).toBe('https://custom.example.com/');
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(result.headers['x-cheq-id']).toBeDefined();
            expect(result.headers['x-cheq-page-view-id']).toBeDefined();
            expect(result.headers['x-cheq-cdn-request-id']).toBeDefined();
            expect(result.body).not.toContain('Access Denied');
            expect(result.rtiPayload).toBeDefined();
        });

        it('defaults redirect location to cheq.ai when redirectLocation is not configured', async () => {
            // Arrange — redirectTTCodes set but no redirectLocation
            setConfig({ ...BASE_CONFIG, redirectTTCodes: [10] });
            adapter.setRtiResponse(buildRTIResponse({ verdict: 'benign', code: 10 }));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(302);
            expect(result.headers['location']).toBe('https://www.cheq.ai/');
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
        });

        it('sets x-cheq-page-view-id to empty string when pageViewId is null on REDIRECT', async () => {
            // Arrange
            setConfig({ ...BASE_CONFIG, redirectTTCodes: [10], redirectLocation: 'https://redirect.example.com/' });
            adapter.setRtiResponse(buildRTIResponse({ verdict: 'benign', code: 10, rayId: 'ray-123', pageViewId: null }));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(302);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-page-view-id']).toBe('');
        });

        //#endregion Redirect tests

        //#region Ignore paths tests

        it('passes through without calling RTI when path matches ignorePaths', async () => {
            // Arrange
            setConfig({ ...BASE_CONFIG, ignorePaths: ['/health'] });

            // Act
            const result = await adapter.invoke({ path: '/health' });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(result.headers['location']).toBeUndefined();
            expect(result.headers['x-cheq-id']).toBeUndefined();
            expect(result.body).not.toContain('blocked');
            // RTI was not called — rtiPayload is undefined
            expect(result.rtiPayload).toBeUndefined();
        });

        //#endregion Ignore paths tests

        //#region Cookie extraction tests

        it('forwards _cq_duid, _cq_pvid, _cq_s cookies to RTI payload', async () => {
            // Act
            const result = await adapter.invoke({
                cookies: '_cq_duid=d-abc; _cq_pvid=pv-xyz; _cq_s=s-token',
            });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeDefined();
            expect(result.rtiPayload).toBeDefined();
            expect(result.rtiPayload.endUserParams).toBeDefined();
            expect(result.rtiPayload.duidCookie).toBe('d-abc');
            expect(result.rtiPayload.pvidCookie).toBe('pv-xyz');
            expect(result.rtiPayload.sCookie).toBe('s-token');
        });

        it('extracts base64-padded _cq_s intact when mixed with other cookies', async () => {
            // Act
            const result = await adapter.invoke({
                cookies: `session=abc123; _cq_s=${B64_SCOOKIE}; other=ignored`,
            });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.rtiPayload).toBeDefined();
            expect(result.rtiPayload.sCookie).toBe(B64_SCOOKIE);
            expect(result.rtiPayload.duidCookie).toBeUndefined();
            expect(result.rtiPayload.pvidCookie).toBeUndefined();
        });

        it('leaves all cookie fields undefined when no cookies provided', async () => {
            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.rtiPayload).toBeDefined();
            expect(result.rtiPayload.duidCookie).toBeUndefined();
            expect(result.rtiPayload.pvidCookie).toBeUndefined();
            expect(result.rtiPayload.sCookie).toBeUndefined();
        });

        //#endregion Cookie extraction tests

        //#region Error handling tests

        it('passes through (fails open) when RTI network call throws', async () => {
            // Arrange
            adapter.setRtiError(new Error('network timeout'));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(result.headers['location']).toBeUndefined();
            expect(result.body).not.toContain('blocked');
            // rtiPayload is defined because the payload was built and passed to callRTI before it threw
            expect(result.rtiPayload).toBeDefined();
        });

        //#endregion Error handling tests

        //#region RTI payload fields tests

        it('includes clientIp in RTI payload endUserParams', async () => {
            // Act
            const result = await adapter.invoke({ ip: '203.0.113.42' });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.rtiPayload).toBeDefined();
            expect(result.rtiPayload.endUserParams.clientIp).toBe('203.0.113.42');
        });

        it('includes HTTP method in RTI payload endUserParams', async () => {
            // Act
            const result = await adapter.invoke({ method: 'POST' });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.rtiPayload).toBeDefined();
            expect(result.rtiPayload.endUserParams.method).toBe('POST');
        });

        it('includes request path in RTI payload endUserParams.requestUrl', async () => {
            // Act
            const result = await adapter.invoke({ path: '/foo/bar' });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.rtiPayload).toBeDefined();
            expect(result.rtiPayload.endUserParams.requestUrl).toContain('/foo/bar');
        });

        it('includes a non-empty channel string in RTI payload', async () => {
            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.rtiPayload).toBeDefined();
            expect(typeof result.rtiPayload.channel).toBe('string');
            expect(result.rtiPayload.channel.length).toBeGreaterThan(0);
        });

        it('includes querystring in RTI payload requestUrl', async () => {
            // Act
            const result = await adapter.invoke({ querystring: 'utm_source=test&foo=bar' });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.rtiPayload).toBeDefined();
            expect(result.rtiPayload.endUserParams.requestUrl).toContain('utm_source=test');
            expect(result.rtiPayload.endUserParams.requestUrl).toContain('foo=bar');
        });

        //#endregion RTI payload fields tests

        //#region x-cheq-rti-result format tests

        it('x-cheq-rti-result header contains version, verdict, threat-type-code, ids on ALLOW', async () => {
            // Arrange — realistic benign response with a known ray ID
            const ids = {
                rayId: 'd07fd4d7105b1bf24912745b1fde2c55',
                pageViewId: null,
                duid: null,
                uniqueVisitId: null,
                customParam1: null,
                customParam2: null,
                customParam3: null,
                customParam4: null,
            };
            adapter.setRtiResponse({
                metadata: { version: '4.1' } as any,
                decision: { verdict: 'benign' } as any,
                classification: { code: 0 } as any,
                ids,
                cheqDetection: { reasons: [] } as any,
            });

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            const header = result.headers['x-cheq-rti-result'];
            expect(header).toBe(`version=4.1;verdict=benign;threat-type-code=0;ids=${JSON.stringify(ids)}`);
            expect(header).not.toContain('reasons=');
            expect(header).not.toContain('test-api-key');
            expect(result.headers['location']).toBeUndefined();
            expect(result.rtiPayload).toBeDefined();
        });

        it('x-cheq-rti-result does not contain reasons or apiKey on ALLOW', async () => {
            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            const header = result.headers['x-cheq-rti-result'];
            expect(header).toBeDefined();
            expect(header).not.toContain('reasons=');
            expect(header).not.toContain('test-api-key');
        });

        //#endregion x-cheq-rti-result format tests
    });
}
