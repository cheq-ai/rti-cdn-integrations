// cspell:ignore duid pvid cheq SCOOKIE
/**
 * Shared behavioral test suite — 40 tests registered once per CDN integration.
 *
 * ## What it tests
 * Every behavior that must work identically across Cloudflare, CloudFront and Akamai:
 *
 *   Pass-through     ignored path, valid challenge, no validateChallenge configured
 *   ALLOW            RTI called, request passes through, x-cheq-rti-result header set
 *   Block strategies ACCESS_DENIED → 403, NOT_FOUND → 404, generateDefaultBlockPage args
 *   Redirect         302, location header, default vs custom location, x-cheq-id / page-view-id
 *   CAPTCHA          challenge callback called, absent (pass-through), throws (fail open)
 *   Cookie extraction _cq_duid, _cq_pvid, _cq_s, base64-padded values, absent cookies
 *   validateChallenge returns false (calls RTI), throws (fail open)
 *   Header absence   no x-cheq-rti-result on block or redirect responses
 *   Querystring      forwarded in endUserParams.requestUrl
 *   Error handling   RTI throws Error, RTI throws non-Error value
 *   Debug logging    payload logged when enabled, nothing when disabled
 *   Telemetry        logged when enabled, not when disabled
 *   RTI payload      clientIp, channel non-empty, HTTP method, path in requestUrl
 *
 * ## What is mocked vs real
 * `SharedMocks` (callRTI, shouldIgnore, getAction, getActionStrategy, generateDefaultBlockPage)
 * are all mocked so tests control decisions precisely. `parseCookies` and `buildRtiResultHeader`
 * use real implementations to verify actual output, not duplicated mock formulas.
 *
 * ## How to use
 * Each CDN test file creates a `TestAdapter`, creates/exposes the `SharedMocks` object,
 * then calls `registerSharedBehaviorTests(adapter, mocks)` once. The 40 tests are
 * registered under a `[shared] {cdn-name}` describe block automatically.
 *
 * @see TestAdapter in ./test-adapter.interface.ts
 * @see registerSharedIntegrationTests in ./shared-integration-tests.ts for end-to-end tests
 *      that use the real RTIHelperService instead of mocking getAction/getActionStrategy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Action } from '../models/action.model';
import { ActionStrategy } from '../models/action-strategy.model';
import type { TestAdapter, SharedMocks } from './test-adapter.interface';
import { buildRTIResponse } from './rti-response.fixture';

const B64_SCOOKIE = 'c0hdForhWGaRercD:kc/eGTcRHnanstWrlbv6fnBWg/kICuKe+hRiK6x9lCwkrSdhpKIohwyd7/JHH3aA81pNurK0WfbwmJfGwL61DFBsgrr3wYpT8muwEt/xhOrFe3Ejee4W86fnE/fe0l1b1+ld6JwCiA7tueF0weoJStmpVEKW8PTz+JTkOf9jMfEE/HYNMrG22F+h7w68Td+JeCURnRPp48TbVAtusLvNuwWwWSyuI/7OfV6akdMrey+Mr2b8i8+w9Cm58M+Ttq1ydQPcQbHGOPfI5InnCSqHbGT0mUMxdodBMXFmvQgTN07lge/+zjGSH2+s+a0b60QlNOa6rw==:Ki6FWCQbEiMijlXZ/6/BNQ==';

/**
 * Registers the common behavioral test suite for all CDN integrations.
 * `challenge` in setConfig accepts undefined | 'working' | 'throwing'.
 * `validateChallenge` accepts undefined | a vi.fn() returning a bool promise.
 *
 * ## How it works
 * Calling this function invokes Vitest's `describe()` and `it()` registration functions,
 * which tell Vitest "here are tests to run". This is equivalent to writing all ~40 `it(...)`
 * blocks directly in the CDN's spec file — just without the duplication. Vitest collects
 * everything registered during module evaluation and executes it when the suite runs.
 *
 * ## Where it is called
 * Called once per CDN at module load time in the CDN's spec file, after the adapter is built:
 * - `integrations/cloudflare/src/index.spec.ts`     → `registerSharedBehaviorTests(cloudflareAdapter, mocks)`
 * - `integrations/cloudfront/src/request-helper.spec.ts` → `registerSharedBehaviorTests(cloudfrontAdapter, mocks)`
 * - `integrations/akamai/src/main.spec.ts`           → `registerSharedBehaviorTests(akamaiAdapter, akamaiSharedMocks)`
 */
export function registerSharedBehaviorTests(adapter: TestAdapter, mocks: SharedMocks): void {
    describe(`[shared] ${adapter.name}`, () => {
        beforeEach(() => {
            vi.clearAllMocks();
            vi.unstubAllGlobals();
            adapter.resetConfig();
            mocks.shouldIgnore.mockReturnValue(false);
            mocks.getAction.mockReturnValue(Action.ALLOW);
            mocks.getActionStrategy.mockReturnValue(null);
            mocks.callRTI.mockResolvedValue(buildRTIResponse());
            mocks.generateDefaultBlockPage.mockReturnValue('<html>blocked</html>');
        });

        //#region Pass-through tests

        it('passes through without calling RTI when path is ignored', async () => {
            // Arrange
            mocks.shouldIgnore.mockReturnValue(true);

            // Act
            const result = await adapter.invoke({ path: '/favicon.ico' });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(mocks.callRTI).not.toHaveBeenCalled();
            expect(mocks.getAction).not.toHaveBeenCalled();
            expect(mocks.getActionStrategy).not.toHaveBeenCalled();
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
        });

        it('passes through without calling RTI when challenge is already valid', async () => {
            // Arrange
            adapter.setConfig({ validateChallenge: vi.fn().mockResolvedValue(true) });

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(mocks.callRTI).not.toHaveBeenCalled();
            expect(mocks.getAction).not.toHaveBeenCalled();
            expect(mocks.getActionStrategy).not.toHaveBeenCalled();
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
        });

        it('passes through (fails open) when validateChallenge throws', async () => {
            // Arrange
            adapter.setConfig({ validateChallenge: vi.fn().mockRejectedValue(new Error('validate crash')) });

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(mocks.callRTI).not.toHaveBeenCalled();
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
            adapter.assertErrorLogged('validate crash');
            expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('validate crash'));
        });

        it('passes through (fails open) when challenge throws', async () => {
            // Arrange
            adapter.setConfig({ challenge: 'throwing' });
            mocks.getAction.mockReturnValue(Action.CHALLENGE);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);

            // Act
            const result = await adapter.invoke();

            // Assert
            // Note: x-cheq-rti-result presence is CDN-specific — Akamai falls through to the
            // ALLOW path after a challenge error (setting the header), while Cloudflare and
            // CloudFront return early from the catch block (no header). Not asserted here.
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
            // Error logging for challenge failures is CDN-specific (gated on debug/rtiLoggerHost in Akamai)
            // and is verified in the CDN-specific test suites instead.
        });

        it('calls RTI when validateChallenge is not configured', async () => {
            // Arrange
            adapter.setConfig({ validateChallenge: undefined });

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getAction).toHaveBeenCalled();
            expect(mocks.getActionStrategy).not.toHaveBeenCalled();
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
        });

        it('calls challenge and returns its result when RTI response leads to CAPTCHA strategy', async () => {
            // Arrange
            mocks.getAction.mockReturnValue(Action.CHALLENGE);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
            adapter.setConfig({ challenge: 'working' });

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(403);
            expect(result.body).toContain('captcha');
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getAction).toHaveBeenCalledOnce();
            expect(mocks.getActionStrategy).toHaveBeenCalledWith(Action.CHALLENGE);
        });

        //#endregion Pass-through tests

        //#region ALLOW tests

        it('calls RTI and passes through on ALLOW', async () => {
            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getAction).toHaveBeenCalledWith(expect.objectContaining({ decision: expect.anything() }));
            expect(mocks.getActionStrategy).not.toHaveBeenCalled();
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeDefined();
        });

        it('sets x-cheq-rti-result header on ALLOW containing version, verdict, threat-type-code, ids', async () => {
            // Arrange
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ version: '4.1', verdict: 'benign', code: 0, rayId: 'ray-123' }));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            const header = result.headers['x-cheq-rti-result'];
            expect(header).toBeDefined();
            expect(header).toContain('version=4.1');
            expect(header).toContain('verdict=benign');
            expect(header).toContain('threat-type-code=0');
            expect(header).toContain('ids=');
        });

        it('sets x-cheq-rti-result header on ALLOW with exact serialized format including all ids fields', async () => {
            // Arrange — realistic benign response with all ids fields populated
            const ids = {
                rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
                pageViewId: '16183c3ded45c554f9b4bb71a42d8e71',
                duid: '49a3b40d890a64b031b28fd50a6888d7',
                uniqueVisitId: 'uv-4f3e2d1c0b9a8765',
                customParam1: 'page_load',
                customParam2: 'cf-ray-abc123',
                customParam3: null,
                customParam4: null,
            };
            mocks.callRTI.mockResolvedValue({
                metadata: { version: '4.1' },
                decision: { verdict: 'benign' },
                classification: { code: 0 },
                ids,
                cheqDetection: { reasons: [] },
            });

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            const header = result.headers['x-cheq-rti-result'];
            expect(header).toBe(`version=4.1;verdict=benign;threat-type-code=0;ids=${JSON.stringify(ids)}`);
        });

        it('x-cheq-rti-result does not contain reasons', async () => {
            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeDefined();
            expect(result.headers['x-cheq-rti-result']).not.toContain('reasons=');
        });

        it('x-cheq-rti-result does not expose apiKey', async () => {
            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeDefined();
            expect(result.headers['x-cheq-rti-result']).not.toContain('api-key');
        });

        it('x-cheq-rti-result uses semicolon-delimited key=value format', async () => {
            // Arrange
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ version: '4.1', verdict: 'benign', code: 0, rayId: 'ray-fmt' }));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            const header = result.headers['x-cheq-rti-result'];
            expect(header).toMatch(/version=[^;]+;verdict=[^;]+;threat-type-code=\d+;ids=\{/);
        });

        //#endregion ALLOW tests

        //#region Block strategies tests

        it('returns 403 block page with rayId only when ACCESS_DENIED and RTI returns sparse ids', async () => {
            // Arrange — sparse ids: only rayId set, pageViewId null
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27' }));
            mocks.getAction.mockReturnValue(Action.BLOCK);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getActionStrategy).toHaveBeenCalledWith(Action.BLOCK);
            expect(mocks.generateDefaultBlockPage).toHaveBeenCalledOnce();
            expect(result.status).toBe(403);
            expect(result.headers['content-type']).toMatch(/text\/html/);
            expect(result.body).toContain('blocked');
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            const [status, title, ids] = mocks.generateDefaultBlockPage.mock.calls[0];
            expect(status).toBe('403');
            expect(title).toBe('Access Denied');
            expect(ids).toMatchObject({ rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27', pageViewId: null });
        });

        it('returns 403 block page with rayId and pageViewId when ACCESS_DENIED and RTI returns full ids', async () => {
            // Arrange — rayId and pageViewId both set
            mocks.callRTI.mockResolvedValue(buildRTIResponse({
                rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
                pageViewId: '16183c3ded45c554f9b4bb71a42d8e71',
            }));
            mocks.getAction.mockReturnValue(Action.BLOCK);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getActionStrategy).toHaveBeenCalledWith(Action.BLOCK);
            expect(mocks.generateDefaultBlockPage).toHaveBeenCalledOnce();
            expect(result.status).toBe(403);
            expect(result.headers['content-type']).toMatch(/text\/html/);
            expect(result.body).toContain('blocked');
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            const [status, title, ids] = mocks.generateDefaultBlockPage.mock.calls[0];
            expect(status).toBe('403');
            expect(title).toBe('Access Denied');
            expect(ids).toMatchObject({
                rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
                pageViewId: '16183c3ded45c554f9b4bb71a42d8e71',
            });
        });

        it('returns 404 block page with rayId only when NOT_FOUND and RTI returns sparse ids', async () => {
            // Arrange — sparse ids: only rayId set, pageViewId null
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27' }));
            mocks.getAction.mockReturnValue(Action.BLOCK);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.NOT_FOUND);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getActionStrategy).toHaveBeenCalledWith(Action.BLOCK);
            expect(mocks.generateDefaultBlockPage).toHaveBeenCalledOnce();
            expect(result.status).toBe(404);
            expect(result.headers['content-type']).toMatch(/text\/html/);
            expect(result.body).toContain('blocked');
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            const [status, title, ids] = mocks.generateDefaultBlockPage.mock.calls[0];
            expect(status).toBe('404');
            expect(title).toBe('Not Found');
            expect(ids).toMatchObject({ rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27', pageViewId: null });
        });

        it('returns 404 block page with rayId and pageViewId when NOT_FOUND and RTI returns full ids', async () => {
            // Arrange — rayId and pageViewId both set
            mocks.callRTI.mockResolvedValue(buildRTIResponse({
                rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
                pageViewId: '16183c3ded45c554f9b4bb71a42d8e71',
            }));
            mocks.getAction.mockReturnValue(Action.BLOCK);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.NOT_FOUND);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getActionStrategy).toHaveBeenCalledWith(Action.BLOCK);
            expect(mocks.generateDefaultBlockPage).toHaveBeenCalledOnce();
            expect(result.status).toBe(404);
            expect(result.headers['content-type']).toMatch(/text\/html/);
            expect(result.body).toContain('blocked');
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            const [status, title, ids] = mocks.generateDefaultBlockPage.mock.calls[0];
            expect(status).toBe('404');
            expect(title).toBe('Not Found');
            expect(ids).toMatchObject({
                rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
                pageViewId: '16183c3ded45c554f9b4bb71a42d8e71',
            });
        });

        it('returns Content-Type text/html;charset=UTF-8 on ACCESS_DENIED block response', async () => {
            // Arrange
            mocks.getAction.mockReturnValue(Action.BLOCK);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(403);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['content-type']).toMatch(/text\/html/);
        });

        it('does not set x-cheq-rti-result on ACCESS_DENIED block response', async () => {
            // Arrange
            mocks.getAction.mockReturnValue(Action.BLOCK);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(403);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
        });

        //#endregion Block strategies tests

        //#region Redirect tests

        it('returns 302 with redirect location on REDIRECT', async () => {
            // Arrange
            mocks.getAction.mockReturnValue(Action.REDIRECT);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(302);
            expect(result.headers['location']).toBe('https://www.cheq.ai/');
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(mocks.getActionStrategy).toHaveBeenCalledWith(Action.REDIRECT);
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
        });

        it('defaults redirect location to cheq.ai when redirectLocation is not configured', async () => {
            // Arrange
            adapter.setConfig({ redirectLocation: undefined });
            mocks.getAction.mockReturnValue(Action.REDIRECT);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(302);
            expect(result.headers['location']).toBe('https://www.cheq.ai/');
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
        });

        it('uses custom redirectLocation when configured', async () => {
            // Arrange
            mocks.callRTI.mockResolvedValue(buildRTIResponse({
                rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
                pageViewId: '16183c3ded45c554f9b4bb71a42d8e71',
            }));
            mocks.getAction.mockReturnValue(Action.REDIRECT);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
            adapter.setConfig({ redirectLocation: 'https://custom.example.com/blocked' });

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getActionStrategy).toHaveBeenCalledWith(Action.REDIRECT);
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
            expect(result.status).toBe(302);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['location']).toBe('https://custom.example.com/blocked');
            expect(result.headers['x-cheq-id']).toBe('b196ca1f77553f84b0a8e8e3c5f64c27');
            expect(result.headers['x-cheq-page-view-id']).toBe('16183c3ded45c554f9b4bb71a42d8e71');
            expect(result.headers['x-cheq-cdn-request-id']).toBeDefined();
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
        });

        it('sets x-cheq-id to rayId on REDIRECT', async () => {
            // Arrange
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ rayId: 'ray-xyz' }));
            mocks.getAction.mockReturnValue(Action.REDIRECT);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(302);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-id']).toBe('ray-xyz');
        });

        it('sets x-cheq-page-view-id to pageViewId when present on REDIRECT', async () => {
            // Arrange
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ pageViewId: 'pv-456' }));
            mocks.getAction.mockReturnValue(Action.REDIRECT);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(302);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-page-view-id']).toBe('pv-456');
        });

        it('sets x-cheq-page-view-id to empty string when pageViewId is null on REDIRECT', async () => {
            // Arrange
            mocks.callRTI.mockResolvedValue(buildRTIResponse({ pageViewId: null }));
            mocks.getAction.mockReturnValue(Action.REDIRECT);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(302);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-page-view-id']).toBe('');
        });

        it('redirect response has all headers correct when rayId set and pageViewId is null', async () => {
            // Arrange — sparse ids: rayId set, pageViewId null → x-cheq-page-view-id must be empty string
            mocks.callRTI.mockResolvedValue(buildRTIResponse({
                rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
                pageViewId: null,
            }));
            mocks.getAction.mockReturnValue(Action.REDIRECT);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getActionStrategy).toHaveBeenCalledWith(Action.REDIRECT);
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
            expect(result.status).toBe(302);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['location']).toBe('https://www.cheq.ai/');
            expect(result.headers['x-cheq-id']).toBe('b196ca1f77553f84b0a8e8e3c5f64c27');
            expect(result.headers['x-cheq-page-view-id']).toBe('');
            expect(result.headers['x-cheq-cdn-request-id']).toBeDefined();
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
        });

        it('redirect response has all headers correct when both rayId and pageViewId are set', async () => {
            // Arrange — full ids: both rayId and pageViewId set, with a custom redirect location
            mocks.callRTI.mockResolvedValue(buildRTIResponse({
                rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
                pageViewId: '16183c3ded45c554f9b4bb71a42d8e71',
            }));
            mocks.getAction.mockReturnValue(Action.REDIRECT);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
            adapter.setConfig({ redirectLocation: 'https://blocked.example.com/' });

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getActionStrategy).toHaveBeenCalledWith(Action.REDIRECT);
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
            expect(result.status).toBe(302);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['location']).toBe('https://blocked.example.com/');
            expect(result.headers['x-cheq-id']).toBe('b196ca1f77553f84b0a8e8e3c5f64c27');
            expect(result.headers['x-cheq-page-view-id']).toBe('16183c3ded45c554f9b4bb71a42d8e71');
            expect(result.headers['x-cheq-cdn-request-id']).toBeDefined();
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
        });

        it('sets x-cheq-cdn-request-id header on REDIRECT', async () => {
            // Arrange
            mocks.callRTI.mockResolvedValue(buildRTIResponse({
                rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
                pageViewId: '16183c3ded45c554f9b4bb71a42d8e71',
            }));
            mocks.getAction.mockReturnValue(Action.REDIRECT);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getActionStrategy).toHaveBeenCalledWith(Action.REDIRECT);
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
            expect(result.status).toBe(302);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['location']).toBe('https://www.cheq.ai/');
            expect(result.headers['x-cheq-id']).toBe('b196ca1f77553f84b0a8e8e3c5f64c27');
            expect(result.headers['x-cheq-page-view-id']).toBe('16183c3ded45c554f9b4bb71a42d8e71');
            // x-cheq-cdn-request-id is always present on redirect; its exact value is CDN-specific
            // (cf-ray for Cloudflare, requestId for CloudFront, x-akamai-request-id for Akamai)
            // and is verified in CDN-specific tests.
            expect(result.headers['x-cheq-cdn-request-id']).toBeDefined();
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
        });

        it('does not set x-cheq-rti-result on REDIRECT response', async () => {
            // Arrange
            mocks.getAction.mockReturnValue(Action.REDIRECT);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.status).toBe(302);
            expect(result.passedThrough).toBe(false);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
        });

        //#endregion Redirect tests

        //#region CAPTCHA tests

        it('calls challenge and returns its result when CAPTCHA and challenge is configured', async () => {
            // Arrange
            adapter.setConfig({ challenge: 'working' });
            mocks.getAction.mockReturnValue(Action.CHALLENGE);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(false);
            expect(result.status).toBe(403);
            expect(result.body).toContain('captcha');
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
        });

        it('passes through when CAPTCHA but no challenge configured', async () => {
            // Arrange
            adapter.setConfig({ challenge: undefined });
            mocks.getAction.mockReturnValue(Action.CHALLENGE);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
        });

        it('passes through when challenge throws', async () => {
            // Arrange
            adapter.setConfig({ challenge: 'throwing' });
            mocks.getAction.mockReturnValue(Action.CHALLENGE);
            mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
        });

        it('passes through when action strategy is unrecognized (default case)', async () => {
            // Arrange
            mocks.getAction.mockReturnValue(Action.BLOCK);
            mocks.getActionStrategy.mockReturnValue(null);

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getActionStrategy).toHaveBeenCalledWith(Action.BLOCK);
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
        });

        //#endregion CAPTCHA tests

        //#region Cookie extraction tests

        it('extracts _cq_duid, _cq_pvid, and _cq_s from cookie header', async () => {
            // Act
            const result = await adapter.invoke({ cookies: '_cq_duid=d-abc; _cq_pvid=pv-xyz; _cq_s=s-token' });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            const payload = adapter.getLastRTIPayload();
            expect(payload.duidCookie).toBe('d-abc');
            expect(payload.pvidCookie).toBe('pv-xyz');
            expect(payload.sCookie).toBe('s-token');
        });

        it('extracts base64-padded _cq_s intact when mixed with other unrelated cookies', async () => {
            // Act
            const result = await adapter.invoke({ cookies: `session=abc123; _cq_s=${B64_SCOOKIE}; other=ignored` });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            const payload = adapter.getLastRTIPayload();
            expect(payload.sCookie).toBe(B64_SCOOKIE);
            expect(payload.duidCookie).toBeUndefined();
            expect(payload.pvidCookie).toBeUndefined();
        });

        it('extracts _cq_duid, _cq_pvid and base64-padded _cq_s when mixed with other unrelated cookies', async () => {
            // Arrange
            const cookies = `session=abc123; _cq_duid=4.16a154e6ae45bc91bf9a49b365beb989; theme=dark; _cq_pvid=4.247bcdf08360a9de9dee2196c1a36631; _cq_s=${B64_SCOOKIE}; other=ignored`;

            // Act
            const result = await adapter.invoke({ cookies });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            const payload = adapter.getLastRTIPayload();
            expect(payload.duidCookie).toBe('4.16a154e6ae45bc91bf9a49b365beb989');
            expect(payload.pvidCookie).toBe('4.247bcdf08360a9de9dee2196c1a36631');
            expect(payload.sCookie).toBe(B64_SCOOKIE);
        });

        it('leaves cookie fields undefined when cookies are absent', async () => {
            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            const payload = adapter.getLastRTIPayload();
            expect(payload.duidCookie).toBeUndefined();
            expect(payload.pvidCookie).toBeUndefined();
            expect(payload.sCookie).toBeUndefined();
        });

        //#endregion Cookie extraction tests

        //#region validateChallenge edge cases tests

        it('calls RTI when validateChallenge returns false', async () => {
            // Arrange
            adapter.setConfig({ validateChallenge: vi.fn().mockResolvedValue(false) });

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            expect(mocks.getAction).toHaveBeenCalled();
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeDefined();
        });

        it('passes through (fails open) when validateChallenge throws', async () => {
            // Arrange
            adapter.setConfig({ validateChallenge: vi.fn().mockRejectedValue(new Error('validate crash')) });

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(mocks.callRTI).not.toHaveBeenCalled();
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
        });

        //#endregion validateChallenge edge cases tests

        //#region Querystring tests

        it('includes querystring in RTI payload requestUrl', async () => {
            // Act
            const result = await adapter.invoke({ querystring: 'utm_source=test&foo=bar' });

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(mocks.callRTI).toHaveBeenCalledOnce();
            const payload = adapter.getLastRTIPayload();
            expect(payload.endUserParams.requestUrl).toContain('utm_source=test');
        });

        //#endregion Querystring tests

        //#region Error handling tests

        it('passes through (fails open) when RTI call throws', async () => {
            // Arrange
            mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
            adapter.assertErrorLogged('RTI timeout');
            expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('RTI timeout'));
        });

        it('passes through (fails open) when RTI call throws a non-Error value', async () => {
            // Arrange
            mocks.callRTI.mockRejectedValue('plain string error');

            // Act
            const result = await adapter.invoke();

            // Assert
            expect(result.passedThrough).toBe(true);
            expect(result.status).toBe(200);
            expect(result.headers['x-cheq-rti-result']).toBeUndefined();
            expect(mocks.generateDefaultBlockPage).not.toHaveBeenCalled();
            expect(mocks.loggerError).toHaveBeenCalled();
        });

        //#endregion Error handling tests

        //#region Debug logging tests

        it('logs payload when debug is enabled', async () => {
            // Arrange
            adapter.setConfig({ debug: true });

            // Act
            await adapter.invoke();

            // Assert
            adapter.assertDebugLogged('payload');
        });

        it('does not log when debug is disabled', async () => {
            // Arrange
            adapter.setConfig({ debug: false });

            // Act
            await adapter.invoke();

            // Assert
            adapter.assertNotDebugLogged();
        });

        //#endregion Debug logging tests

        //#region Telemetry tests

        it('logs telemetry when telemetry is enabled', async () => {
            // Arrange
            adapter.setConfig({ telemetry: true });

            // Act
            await adapter.invoke();

            // Assert
            expect(adapter.wasTelemetryLogged()).toBe(true);
            expect(mocks.loggerInfo).toHaveBeenCalled();
        });

        it('does not log telemetry when telemetry is disabled', async () => {
            // Arrange
            adapter.setConfig({ telemetry: false });

            // Act
            await adapter.invoke();

            // Assert
            expect(adapter.wasTelemetryLogged()).toBe(false);
        });

        //#endregion Telemetry tests

        //#region RTI payload fields tests

        it('includes clientIp in RTI payload endUserParams', async () => {
            // Act
            await adapter.invoke({ ip: '9.8.7.6' });

            // Assert
            const payload = adapter.getLastRTIPayload();
            expect(payload.endUserParams.clientIp).toBe('9.8.7.6');
        });

        it('includes a non-empty channel string in RTI payload', async () => {
            // Act
            await adapter.invoke();

            // Assert
            const payload = adapter.getLastRTIPayload();
            expect(typeof payload.channel).toBe('string');
            expect(payload.channel.length).toBeGreaterThan(0);
        });

        it('includes HTTP method in RTI payload endUserParams', async () => {
            // Act
            await adapter.invoke({ method: 'POST' });

            // Assert
            const payload = adapter.getLastRTIPayload();
            expect(payload.endUserParams.method).toBe('POST');
        });

        it('includes request path in RTI payload endUserParams.requestUrl', async () => {
            // Act
            await adapter.invoke({ path: '/foo/bar' });

            // Assert
            const payload = adapter.getLastRTIPayload();
            expect(payload.endUserParams.requestUrl).toContain('/foo/bar');
        });

        //#endregion RTI payload fields tests
    });
}
