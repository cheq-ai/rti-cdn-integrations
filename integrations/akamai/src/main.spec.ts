// cspell:ignore cheq duid pvid unstub
/// <reference path="./types.d.ts" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    callRTI: vi.fn(),
    logToRTI: vi.fn(),
    shouldIgnore: vi.fn(),
    getAction: vi.fn(),
    getActionStrategy: vi.fn(),
    getEventType: vi.fn().mockReturnValue('pageview'),
    validateConfig: vi.fn().mockReturnValue([]),
    buildRtiResultHeader: vi.fn(),
    generateDefaultBlockPage: vi.fn().mockReturnValue('<html>blocked</html>'),
    logLog: vi.fn(),
}));

vi.mock('log', () => ({
    logger: { log: mocks.logLog },
}));


vi.mock('./config', () => ({
    config: {
        tagHash: 'tag-hash',
        apiKey: 'api-key',
        rtiHost: 'rti-proxy.example.com',
        debug: false,
        telemetry: false,
        redirectLocation: 'https://www.cheq.ai/',
        ignorePaths: [],
        timeout: 300,
        rtiLoggerHost: undefined as any,
        challenge: undefined as any,
        validateChallenge: undefined as any,
    },
    buildDynamicConfig: vi.fn().mockImplementation(() => ({
        tagHash: 'tag-hash',
        apiKey: 'api-key',
        rtiHost: 'rti-proxy.example.com',
        debug: false,
        telemetry: false,
        redirectLocation: 'https://www.cheq.ai/',
        ignorePaths: [],
        timeout: 300,
        rtiLoggerHost: undefined,
        challenge: undefined,
        validateChallenge: undefined,
    })),
}));

vi.mock('./rti-service', () => ({
    callRTI: mocks.callRTI,
}));

vi.mock('./rti-logger', () => ({
    logToRTI: mocks.logToRTI,
}));

vi.mock('../../core/services/rti-helper.service', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../core/services/rti-helper.service')>();
    return {
        RTIHelperService: vi.fn().mockImplementation(function (config: any) {
            // parseCookies and buildRtiResultHeader are pure functions with no side effects — use the
            // real implementation so tests verify actual output rather than a duplicated mock formula.
            const realInstance = new real.RTIHelperService(config);
            return {
                shouldIgnore: mocks.shouldIgnore,
                getAction: mocks.getAction,
                getActionStrategy: mocks.getActionStrategy,
                getEventType: mocks.getEventType,
                validateConfig: mocks.validateConfig,
                buildRtiResultHeader: realInstance.buildRtiResultHeader.bind(realInstance),
                parseCookies: realInstance.parseCookies.bind(realInstance),
            };
        }),
    };
});

vi.mock('../../core/helpers/block-page-helpers', () => ({
    generateCompactBlockPage: mocks.generateDefaultBlockPage,
}));

import { onClientRequest, onClientResponse } from './main';
import { Action } from '../../core/models/action.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { buildDynamicConfig } from './config';
import type { TestAdapter, NormalizedResult, InvokeOptions, ConfigOverrides } from '../../core/testing/test-adapter.interface';
import { registerSharedBehaviorTests } from '../../core/testing/shared-unit-tests';
import { buildRTIResponse } from '../../core/testing/rti-response.fixture';

function buildRequest(path = '/page', opts: {
    cookies?: string;
    querystring?: string;
    clientIp?: string;
    method?: string;
    scheme?: string;
    pmuser?: Record<string, string>;
    headers?: Record<string, string>;
    userLocation?: EWRequest['userLocation'];
} = {}): EWRequest {
    const variables: Record<string, string> = { ...(opts.pmuser ?? {}) };
    const url = `${path}${opts.querystring ? '?' + opts.querystring : ''}`;
    return {
        host: 'example.com',
        path,
        url,
        method: opts.method ?? 'GET',
        scheme: opts.scheme ?? 'https',
        clientIp: opts.clientIp ?? '1.2.3.4',
        userLocation: opts.userLocation,
        // Mirrors the LIVE Akamai runtime: absent headers come back as undefined, not [].
        // Returning [] here would hide unguarded getHeader(...)[0] crashes from the tests.
        getHeader: vi.fn((name: string) => {
            if (name === 'Cookie' && opts.cookies) return [opts.cookies];
            if (name === 'host') return ['example.com'];
            if (name === 'user-agent') return ['Mozilla/5.0'];
            if (opts.headers?.[name]) return [opts.headers[name]];
            return undefined;
        }),
        getHeaders: vi.fn(() => ({})),
        setHeader: vi.fn(),
        addHeader: vi.fn(),
        removeHeader: vi.fn(),
        getVariable: vi.fn((name: string) => variables[name]),
        setVariable: vi.fn((name: string, value: string) => { variables[name] = value; }),
        respondWith: vi.fn(),
    } as unknown as EWRequest;
}

function buildResponse(): EWResponse {
    return {
        status: 200,
        getHeader: vi.fn(() => undefined),
        setHeader: vi.fn(),
        addHeader: vi.fn(),
        removeHeader: vi.fn(),
    } as unknown as EWResponse;
}

const defaultConfig = {
    tagHash: 'tag-hash',
    apiKey: 'api-key',
    rtiHost: 'rti-proxy.example.com',
    debug: false,
    telemetry: false,
    redirectLocation: 'https://www.cheq.ai/',
    ignorePaths: [],
    timeout: 300,
    rtiLoggerHost: undefined as string | undefined,
    challenge: undefined as any,
    validateChallenge: undefined as any,
};

// --- Akamai adapter ---

// Tracks respondWith calls across invoke(). Held on an object rather than a bare `let` so the
// mock callback below can assign to it without TS control-flow analysis narrowing it to `null`.
const respondState: { last: { status: number; headers: Record<string, string>; body: string } | null } = { last: null };

const akamaiAdapter: TestAdapter = {
    name: 'akamai edgeworker',

    // invoke() always injects PMUSER_CHEQ_USE_DYNAMIC_CONFIG so that setConfig overrides (via buildDynamicConfig)
    // take effect on every invocation. Static config is tested in separate describe blocks below.
    async invoke(options: InvokeOptions = {}): Promise<NormalizedResult> {
        respondState.last = null;
        const req = buildRequest(options.path ?? '/page', {
            cookies: options.cookies,
            querystring: options.querystring,
            method: options.method,
            clientIp: options.ip,
            headers: options.headers,
            pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' },
        });

        vi.mocked(req.respondWith).mockImplementation((status: number, headers: Record<string, string>, body: string) => {
            respondState.last = { status, headers, body };
        });

        await onClientRequest(req);

        // Cast: TS control-flow analysis still treats respondState.last as `null` after the reset
        // above, because the assignment happens inside the mock callback.
        const captured = respondState.last as { status: number; headers: Record<string, string>; body: string } | null;
        if (captured) {
            const h: Record<string, string> = {};
            for (const [k, v] of Object.entries(captured.headers)) {
                h[k.toLowerCase()] = v;
            }
            // Location header may be capitalized in akamai responses
            if (captured.headers['Location']) h['location'] = captured.headers['Location'];
            return {
                status: captured.status,
                headers: h,
                body: captured.body,
                passedThrough: false,
            };
        }

        // Pass-through: respondWith not called, but x-cheq-rti-result may have been set via setHeader
        const setHeaderCalls = vi.mocked(req.setHeader).mock.calls;
        const rtiHeader = setHeaderCalls.find(([name]) => name === 'x-cheq-rti-result')?.[1] as string | undefined;
        return {
            status: 200,
            headers: rtiHeader ? { 'x-cheq-rti-result': rtiHeader } : {},
            body: '',
            passedThrough: true,
        };
    },

    getLastRTIPayload() {
        return mocks.callRTI.mock.calls[0]?.[0];
    },

    setConfig(overrides: ConfigOverrides) {
        const updated = { ...defaultConfig };
        if ('debug' in overrides) updated.debug = overrides.debug ?? false;
        if ('telemetry' in overrides) {
            updated.telemetry = overrides.telemetry ?? false;
            // Akamai requires rtiLoggerHost to be set alongside telemetry to actually call logToRTI
            if (overrides.telemetry) updated.rtiLoggerHost = 'logger.example.com';
        }
        if ('redirectLocation' in overrides) updated.redirectLocation = overrides.redirectLocation as any;
        if ('validateChallenge' in overrides) updated.validateChallenge = overrides.validateChallenge;
        if ('challenge' in overrides) {
            if (overrides.challenge === 'working') {
                updated.challenge = vi.fn().mockResolvedValue({ html: '<html>captcha</html>', headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
            } else if (overrides.challenge === 'throwing') {
                updated.challenge = vi.fn().mockRejectedValue(new Error('challenge failed'));
            } else {
                updated.challenge = overrides.challenge;
            }
        }
        vi.mocked(buildDynamicConfig).mockReturnValue(updated as any);
        // Force dynamic config path by setting PMUSER variable — adapter always uses dynamic config
        // so that setConfig overrides take effect. The static config path is tested separately.
    },

    resetConfig() {
        vi.mocked(buildDynamicConfig).mockReturnValue({ ...defaultConfig } as any);
    },

    assertDebugLogged(substring: string) {
        const logged = mocks.logLog.mock.calls.some((args: any[]) => String(args[0]).includes(substring));
        expect(logged, `expected debug log containing "${substring}"`).toBe(true);
    },

    assertNotDebugLogged() {
        expect(mocks.logLog).not.toHaveBeenCalled();
    },

    assertErrorLogged(substring: string) {
        const logged = mocks.logLog.mock.calls.some((args: any[]) => String(args[0]).includes(substring));
        expect(logged, `expected error log containing "${substring}"`).toBe(true);
    },

    wasTelemetryLogged() {
        return mocks.logToRTI.mock.calls.some((args: any[]) => String(args[1]).includes('rti_duration'));
    },
};

// --- Register shared behavioral tests ---
// Akamai uses logToRTI for both error logging and telemetry info, not RTILoggerService.
// loggerError and loggerInfo are aliased so SharedMocks is satisfied.
const akamaiSharedMocks = {
    ...mocks,
    loggerError: mocks.logLog,     // log.log is always called on errors (unconditional)
    loggerInfo: mocks.logToRTI,    // logToRTI is called for telemetry info (gated on rtiLoggerHost)
};

registerSharedBehaviorTests(akamaiAdapter, akamaiSharedMocks);

// --- Akamai-specific tests ---

describe('akamai edgeworker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.shouldIgnore.mockReturnValue(false);
        mocks.getAction.mockReturnValue(Action.ALLOW);
        mocks.callRTI.mockResolvedValue(buildRTIResponse());
        vi.mocked(buildDynamicConfig).mockReturnValue({ ...defaultConfig } as any);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // --- Config selection ---

    it('uses static config when PMUSER_CHEQ_USE_DYNAMIC_CONFIG is absent', async () => {
        // Arrange
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(buildDynamicConfig).not.toHaveBeenCalled();
        expect(mocks.callRTI).toHaveBeenCalled();
    });

    it('uses dynamic config when PMUSER_CHEQ_USE_DYNAMIC_CONFIG is true', async () => {
        // Arrange
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(buildDynamicConfig).toHaveBeenCalledWith(req);
        expect(mocks.callRTI).toHaveBeenCalled();
    });

    // --- Pass-through: ignored path ---

    it('does not call RTI when path is ignored', async () => {
        // Arrange
        mocks.shouldIgnore.mockReturnValue(true);
        const req = buildRequest('/favicon.ico');

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.callRTI).not.toHaveBeenCalled();
        expect(req.respondWith).not.toHaveBeenCalled();
    });

    it('logs ignored path when debug is enabled', async () => {
        // Arrange
        mocks.shouldIgnore.mockReturnValue(true);
        vi.mocked(buildDynamicConfig).mockReturnValue({ ...defaultConfig, debug: true } as any);
        const req = buildRequest('/favicon.ico', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('path ignored'));
    });

    it('does not log when path is ignored and debug is disabled', async () => {
        // Arrange
        mocks.shouldIgnore.mockReturnValue(true);
        const req = buildRequest('/favicon.ico');

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logLog).not.toHaveBeenCalled();
    });

    // --- Pass-through: validated challenge ---

    it('does not call RTI when challenge is already valid', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            validateChallenge: vi.fn().mockResolvedValue(true),
        } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.callRTI).not.toHaveBeenCalled();
        expect(req.respondWith).not.toHaveBeenCalled();
    });

    it('logs challenge skip when debug is enabled', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            debug: true,
            validateChallenge: vi.fn().mockResolvedValue(true),
        } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('valid challenge session'));
    });

    it('calls RTI when validateChallenge is defined but returns false', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            validateChallenge: vi.fn().mockResolvedValue(false),
        } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.callRTI).toHaveBeenCalled();
    });

    it('calls RTI when validateChallenge is not configured', async () => {
        // Arrange
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.callRTI).toHaveBeenCalled();
    });

    // --- ALLOW: sets x-cheq-rti-result on request ---

    // Regression: getHeader() returns undefined (not []) for absent headers on the live
    // runtime. Indexing [0] unguarded threw, the outer catch swallowed it, and the request
    // failed open - so RTI was never called for any request without a Cookie header, i.e.
    // most bot traffic and every first-time visitor.
    it('still calls RTI when the Cookie header is absent', async () => {
        // Arrange - buildRequest with no cookies: getHeader('Cookie') returns undefined
        const req = buildRequest('/page');

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.callRTI).toHaveBeenCalled();
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBeUndefined();
        expect(payload.pvidCookie).toBeUndefined();
        expect(payload.sCookie).toBeUndefined();
    });

    // customId2 now comes from a PMUSER variable, so an absent one must yield undefined, not ''.
    it('still populates customId2 as undefined when PMUSER_CHEQ_REQUEST_ID is absent', async () => {
        // Arrange
        const req = buildRequest('/page');

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.callRTI).toHaveBeenCalled();
        expect(mocks.callRTI.mock.calls[0][0].customId2).toBeUndefined();
    });

    it('calls RTI and sets x-cheq-rti-result header on ALLOW', async () => {
        // Arrange
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.callRTI).toHaveBeenCalled();
        expect(req.setHeader).toHaveBeenCalledWith('x-cheq-rti-result', expect.stringContaining('version=4.1'));
    });

    // --- ALLOW: PMUSER_CHEQ_RTI_DEBUG_DATA appends reasons + rule-name ---
    // Read straight from the property variable rather than from config, so it works on
    // both the static and the dynamic config paths (same approach as onClientResponse
    // and PMUSER_CHEQ_DEBUG). Akamai is the only integration that opts in.

    it('omits reasons and rule-name from x-cheq-rti-result by default', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ reasons: [4, 9], ruleName: 'Datacenter IP' }));
        const req = buildRequest('/page');

        // Act
        await onClientRequest(req);

        // Assert
        const header = vi.mocked(req.setHeader).mock.calls.find(([name]) => name === 'x-cheq-rti-result')?.[1] as string;
        expect(header).toContain('version=4.1');
        expect(header).not.toContain('reasons=');
        expect(header).not.toContain('rule-name=');
    });

    it('appends reasons and rule-name when PMUSER_CHEQ_RTI_DEBUG_DATA is true', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ reasons: [4, 9], ruleName: 'Datacenter IP' }));
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_RTI_DEBUG_DATA': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        const header = vi.mocked(req.setHeader).mock.calls.find(([name]) => name === 'x-cheq-rti-result')?.[1] as string;
        expect(header).toContain(';reasons=4,9');
        expect(header).toContain(';rule-name=Datacenter IP');
    });

    it('treats any PMUSER_CHEQ_RTI_DEBUG_DATA value other than "true" as off', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ reasons: [4, 9], ruleName: 'Datacenter IP' }));
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_RTI_DEBUG_DATA': '1' } });

        // Act
        await onClientRequest(req);

        // Assert
        const header = vi.mocked(req.setHeader).mock.calls.find(([name]) => name === 'x-cheq-rti-result')?.[1] as string;
        expect(header).not.toContain('reasons=');
    });

    it('stores rtiResultHeader in PMUSER_CHEQ_RTI_FLOW only when debug is enabled', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({ ...defaultConfig, debug: true } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.setVariable).toHaveBeenCalledWith('PMUSER_CHEQ_RTI_FLOW', expect.stringContaining('version=4.1'));
    });

    it('does not store PMUSER_CHEQ_RTI_FLOW when debug is disabled', async () => {
        // Arrange
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.setVariable).not.toHaveBeenCalledWith('PMUSER_CHEQ_RTI_FLOW', expect.anything());
    });

    // --- Debug logging ---

    it('logs payload when debug is enabled', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({ ...defaultConfig, debug: true } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('[cheq] payload'));
    });

    it('logs verdict when debug is enabled', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({ ...defaultConfig, debug: true } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('[cheq] verdict'));
    });

    it('does not log when debug is disabled', async () => {
        // Arrange
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logLog).not.toHaveBeenCalled();
    });

    // --- RTI payload contents ---

    it('sends channel=akamai-cdn-integration in RTI payload', async () => {
        // Arrange
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.channel).toBe('akamai-cdn-integration');
    });

    it('sends clientIp from request.clientIp in RTI payload', async () => {
        // Arrange
        const req = buildRequest('/page', { clientIp: '5.6.7.8' });

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.clientIp).toBe('5.6.7.8');
    });

    it('defaults callRTI timeout to 300 when config.timeout is undefined', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({ ...defaultConfig, timeout: undefined } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.callRTI).toHaveBeenCalledWith(expect.anything(), expect.any(String), 300);
    });

    // The Akamai request id is NOT an inbound header - EdgeWorkers can only read PMUSER_*
    // variables (not built-ins like AK_REQUEST_ID), so the operator maps it in Property Manager
    // with a Set Variable behavior, exactly as they do for JA3/JA4/TLS.
    it('reads customId2 from PMUSER_CHEQ_REQUEST_ID', async () => {
        // Arrange
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_REQUEST_ID': 'akamai-req-xyz' } });

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.customId2).toBe('akamai-req-xyz');
    });

    it('sets customId2 to undefined when PMUSER_CHEQ_REQUEST_ID is absent', async () => {
        // Arrange
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.customId2).toBeUndefined();
    });

    // --- Fingerprint / TLS / geo enrichment ---

    it('sends cheq_ja3 when PMUSER_CHEQ_JA3 is set', async () => {
        // Arrange
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_JA3': 'ja3-fingerprint' } });

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect((payload.endUserParams.headers as any).cheq_ja3).toBe('ja3-fingerprint');
    });

    it('sends cheq_ja4 when PMUSER_CHEQ_JA4 is set', async () => {
        // Arrange
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_JA4': 'ja4-fingerprint' } });

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect((payload.endUserParams.headers as any).cheq_ja4).toBe('ja4-fingerprint');
    });

    it('sends cheq_tls_cipher when PMUSER_CHEQ_TLS_CIPHER is set', async () => {
        // Arrange
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_TLS_CIPHER': 'ECDHE-RSA-AES128' } });

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect((payload.endUserParams.headers as any).cheq_tls_cipher).toBe('ECDHE-RSA-AES128');
    });

    it('sends cheq_tls_version when PMUSER_CHEQ_TLS_VERSION is set', async () => {
        // Arrange
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_TLS_VERSION': 'TLSv1.3' } });

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect((payload.endUserParams.headers as any).cheq_tls_version).toBe('TLSv1.3');
    });

    it('sends cheq_geo_region from userLocation.region', async () => {
        // Arrange
        const req = buildRequest('/page', { userLocation: { region: 'us-east-1' } });

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect((payload.endUserParams.headers as any).cheq_geo_region).toBe('us-east-1');
    });

    it('omits enrichment fields when PMUSER variables are absent', async () => {
        // Arrange
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        const headers = payload.endUserParams.headers as any;
        expect(headers.cheq_ja3).toBeUndefined();
        expect(headers.cheq_ja4).toBeUndefined();
        expect(headers.cheq_tls_cipher).toBeUndefined();
        expect(headers.cheq_tls_version).toBeUndefined();
    });

    it('omits cheq_geo_region when userLocation is undefined', async () => {
        // Arrange
        const req = buildRequest('/page', { userLocation: undefined });

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect((payload.endUserParams.headers as any).cheq_geo_region).toBeUndefined();
    });

    // --- collectHeaders ---

    it('collects headers with values and omits empty ones', async () => {
        // Arrange
        const req = buildRequest('/page', { headers: { 'sec-fetch-dest': 'document' } });

        // Act
        await onClientRequest(req);

        // Assert
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.endUserParams.headers['sec-fetch-dest']).toBe('document');
        expect(payload.endUserParams.headers['via']).toBeUndefined();
    });

    // --- Block strategies ---

    it('calls respondWith 403 and block page on ACCESS_DENIED', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).toHaveBeenCalledWith(403, expect.objectContaining({ 'Content-Type': 'text/html;charset=UTF-8' }), '<html>blocked</html>');
        expect(mocks.generateDefaultBlockPage).toHaveBeenCalledWith('403', 'Access Denied', expect.objectContaining({ rayId: 'ray-123' }));
    });

    it('calls respondWith 404 and block page on NOT_FOUND', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.NOT_FOUND);
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).toHaveBeenCalledWith(404, expect.anything(), '<html>blocked</html>');
        expect(mocks.generateDefaultBlockPage).toHaveBeenCalledWith('404', 'Not Found', expect.objectContaining({ rayId: 'ray-123' }));
    });

    // NOT_FOUND is the stealth strategy - the page itself carries no CHEQ ids. Emitting them
    // as headers in production would tell a bot it was detected, so they are debug-only.

    it('omits the CHEQ id headers from the 404 when debug is disabled', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.NOT_FOUND);
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        const headers = vi.mocked(req.respondWith).mock.calls[0][1];
        expect(headers['Content-Type']).toBe('text/html;charset=UTF-8');
        expect(headers['x-cheq-id']).toBeUndefined();
        expect(headers['x-cheq-page-view-id']).toBeUndefined();
        expect(headers['x-cheq-cdn-request-id']).toBeUndefined();
    });

    it('adds the CHEQ id headers to the 404 when debug is enabled', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({ ...defaultConfig, debug: true } as any);
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.NOT_FOUND);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ rayId: 'ray-xyz', pageViewId: 'pv-456' }));
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true', 'PMUSER_CHEQ_REQUEST_ID': 'akamai-req-1' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).toHaveBeenCalledWith(404, expect.objectContaining({
            'Content-Type': 'text/html;charset=UTF-8',
            'x-cheq-cdn-request-id': 'akamai-req-1',
            'x-cheq-id': 'ray-xyz',
            'x-cheq-page-view-id': 'pv-456',
        }), '<html>blocked</html>');
    });

    it('sets the 404 x-cheq-page-view-id to an empty string when pageViewId is null', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({ ...defaultConfig, debug: true } as any);
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.NOT_FOUND);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ rayId: 'ray-xyz', pageViewId: null }));
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        const headers = vi.mocked(req.respondWith).mock.calls[0][1];
        expect(headers['x-cheq-page-view-id']).toBe('');
        expect(headers['x-cheq-cdn-request-id']).toBe('');
    });

    // --- Redirect ---

    it('calls respondWith 302 with Location on REDIRECT', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ rayId: 'ray-xyz', pageViewId: 'pv-456' }));
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).toHaveBeenCalledWith(302, expect.objectContaining({
            'Location': 'https://www.cheq.ai/',
            'x-cheq-id': 'ray-xyz',
            'x-cheq-page-view-id': 'pv-456',
        }), '');
    });

    it('sets x-cheq-page-view-id to empty string when pageViewId is null', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ pageViewId: null }));
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        const headers = vi.mocked(req.respondWith).mock.calls[0][1];
        expect(headers['x-cheq-page-view-id']).toBe('');
    });

    it('sets x-cheq-cdn-request-id from PMUSER_CHEQ_REQUEST_ID on REDIRECT', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({
            rayId: 'b196ca1f77553f84b0a8e8e3c5f64c27',
            pageViewId: '16183c3ded45c554f9b4bb71a42d8e71',
        }));
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_REQUEST_ID': 'akamai-req-abc' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).toHaveBeenCalledWith(302, expect.objectContaining({
            'Location': 'https://www.cheq.ai/',
            'x-cheq-cdn-request-id': 'akamai-req-abc',
            'x-cheq-id': 'b196ca1f77553f84b0a8e8e3c5f64c27',
            'x-cheq-page-view-id': '16183c3ded45c554f9b4bb71a42d8e71',
        }), '');
    });

    it('sets x-cheq-cdn-request-id to empty string when PMUSER_CHEQ_REQUEST_ID is absent on REDIRECT', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        const headers = vi.mocked(req.respondWith).mock.calls[0][1];
        expect(headers['x-cheq-cdn-request-id']).toBe('');
    });

    it('defaults redirect location to cheq.ai when not configured', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig, redirectLocation: undefined,
        } as any);
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        const headers = vi.mocked(req.respondWith).mock.calls[0][1];
        expect(headers['Location']).toBe('https://www.cheq.ai/');
    });

    // --- CAPTCHA ---

    it('calls challenge and responds 403 when no Location header in result', async () => {
        // Arrange
        const challengeResult = { html: '<html>captcha</html>', headers: { 'Content-Type': 'text/html;charset=UTF-8' } };
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            challenge: vi.fn().mockResolvedValue(challengeResult),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).toHaveBeenCalledWith(403, expect.objectContaining({ 'Content-Type': 'text/html;charset=UTF-8' }), '<html>captcha</html>');
    });

    it('responds 302 when challenge result has Location header', async () => {
        // Arrange
        const challengeResult = { html: '', headers: { 'Location': 'https://example.com/redirect' } };
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            challenge: vi.fn().mockResolvedValue(challengeResult),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).toHaveBeenCalledWith(302, expect.objectContaining({ 'Location': 'https://example.com/redirect' }), '');
    });

    it('passes through on CAPTCHA but no challenge configured', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).not.toHaveBeenCalled();
        expect(req.setHeader).toHaveBeenCalledWith('x-cheq-rti-result', expect.any(String));
    });

    it('logs the fall-through when CAPTCHA is selected but no challenge is configured and debug is enabled', async () => {
        // Arrange
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        vi.mocked(buildDynamicConfig).mockReturnValue({ ...defaultConfig, debug: true, challenge: undefined } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).not.toHaveBeenCalled();
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('no challenge configured'));
    });

    it('passes through when challenge throws', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            challenge: vi.fn().mockRejectedValue(new Error('challenge failed')),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).not.toHaveBeenCalled();
    });

    // A throwing challenge falls through to ALLOW, which is indistinguishable from a healthy
    // benign verdict from outside - the visitor is simply let past the challenge. On the live
    // property that hid a broken verify sub-request for an entire QA round: appending
    // ?g-recaptcha-response=anything bypassed the CAPTCHA and nothing anywhere said so.
    it('surfaces a challenge error in PMUSER_CHEQ_RTI_FLOW when debug is enabled', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            debug: true,
            challenge: vi.fn().mockRejectedValue(new Error('verify exploded')),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.setVariable).toHaveBeenCalledWith(
            'PMUSER_CHEQ_RTI_FLOW',
            expect.stringContaining('challenge-error=verify exploded'),
        );
    });

    it('does not put the challenge error on the header sent to origin', async () => {
        // Arrange - origin gets the clean classification result; the error is debug-only.
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            debug: true,
            challenge: vi.fn().mockRejectedValue(new Error('verify exploded')),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        const sent = vi.mocked(req.setHeader).mock.calls.find(([n]) => n === 'x-cheq-rti-result')?.[1] as string;
        expect(sent).not.toContain('challenge-error');
    });

    it('logs challenge error when challenge throws and debug is enabled', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            debug: true,
            challenge: vi.fn().mockRejectedValue(new Error('challenge failed')),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('challenge error'));
    });

    it('logs to log.log and logToRTI when validateChallenge throws', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            rtiLoggerHost: 'logger.example.com',
            validateChallenge: vi.fn().mockRejectedValue(new Error('validate crash')),
        } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).not.toHaveBeenCalled();
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('[cheq] error: validate crash'));
        expect(mocks.logToRTI).toHaveBeenCalledWith('error', expect.stringContaining('validate crash'), expect.any(String), expect.any(String), expect.any(String), 'logger.example.com');
    });

    it('logs to log.log and logToRTI when challenge throws', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            rtiLoggerHost: 'logger.example.com',
            challenge: vi.fn().mockRejectedValue(new Error('challenge crash')),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).not.toHaveBeenCalled();
        expect(mocks.logLog).not.toHaveBeenCalled(); // debug is false — challenge error only logged when debug:true
        expect(mocks.logToRTI).toHaveBeenCalledWith('error', expect.stringContaining('challenge crash'), expect.any(String), expect.any(String), expect.any(String), 'logger.example.com');
    });

    // --- Error handling ---

    it('fails open (no respondWith) when RTI call throws', async () => {
        // Arrange
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.respondWith).not.toHaveBeenCalled();
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('RTI timeout'));
    });

    it('uses String(e) fallback when error has no message', async () => {
        // Arrange
        mocks.callRTI.mockRejectedValue('plain string error');
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('plain string error'));
    });

    // A fail-open is indistinguishable from a healthy ALLOW from outside: both are a 200
    // with no x-cheq-rti-result on the response. That ambiguity cost real debugging time on
    // the live property, so when debug is on the reason is parked in the same variable
    // onClientResponse already echoes - no new property variable to declare in Property Manager.
    it('surfaces the fail-open reason in PMUSER_CHEQ_RTI_FLOW when debug is enabled', async () => {
        // Arrange
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_DEBUG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.setVariable).toHaveBeenCalledWith('PMUSER_CHEQ_RTI_FLOW', 'failed-open; error=RTI timeout');
    });

    it('does not surface the fail-open reason when debug is disabled', async () => {
        // Arrange
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.setVariable).not.toHaveBeenCalledWith('PMUSER_CHEQ_RTI_FLOW', expect.anything());
    });

    it('surfaces a non-Error fail-open reason via String(e)', async () => {
        // Arrange
        mocks.callRTI.mockRejectedValue('plain string error');
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_DEBUG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(req.setVariable).toHaveBeenCalledWith('PMUSER_CHEQ_RTI_FLOW', 'failed-open; error=plain string error');
    });

    it('still fails open when storing the fail-open reason throws', async () => {
        // Arrange - setVariable throws on the live runtime if the property variable is not
        // declared. The diagnostic must not turn a fail-open into a rejected onClientRequest,
        // which the EdgeWorkers behavior serves as a 500 unless 'Continue on error' is On.
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_DEBUG': 'true' } });
        req.setVariable = vi.fn(() => { throw new Error('undeclared variable'); });

        // Act & Assert
        await expect(onClientRequest(req)).resolves.toBeUndefined();
        expect(req.respondWith).not.toHaveBeenCalled();
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('RTI timeout'));
    });

    // --- RTI Logger ---

    it('calls logToRTI with rti_duration when telemetry is enabled and rtiLoggerHost is set', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig, telemetry: true, rtiLoggerHost: 'logger.example.com',
        } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logToRTI).toHaveBeenCalledWith('info', expect.stringMatching(/^rti_duration: \d+$/), expect.stringMatching(/^rti-cdn-integrations\.akamai-\d+\.\d+\.\d+$/), 'api-key', 'tag-hash', 'logger.example.com');
    });

    // Akamai permits only TWO subrequests per onClientRequest and callRTI has spent one. A
    // CAPTCHA needs the other for Google's siteverify, so telemetry must yield it. On the live
    // property it did not, siteverify threw "exceeded the limit of 2 subrequests", the CAPTCHA
    // case caught it and fell through to ALLOW - so ?g-recaptcha-response=anything walked
    // straight past the challenge.
    it('skips telemetry when a CAPTCHA verify needs the remaining subrequest', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            telemetry: true,
            rtiLoggerHost: 'logger.example.com',
            challenge: vi.fn().mockResolvedValue({ html: '<html>captcha</html>', headers: {} }),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert - the challenge was served, and no telemetry subrequest competed with it
        expect(req.respondWith).toHaveBeenCalled();
        expect(mocks.logToRTI).not.toHaveBeenCalledWith('info', expect.stringContaining('rti_duration'), expect.anything(), expect.anything(), expect.anything(), expect.anything());
    });

    it('still sends telemetry when no CAPTCHA verify is coming', async () => {
        // Arrange - ALLOW leaves the second subrequest unused, so telemetry may have it.
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig, telemetry: true, rtiLoggerHost: 'logger.example.com',
        } as any);
        mocks.getAction.mockReturnValue(Action.ALLOW);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logToRTI).toHaveBeenCalledWith('info', expect.stringContaining('rti_duration'), expect.anything(), expect.anything(), expect.anything(), 'logger.example.com');
    });

    it('does not call logToRTI when telemetry is disabled', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig, telemetry: false, rtiLoggerHost: 'logger.example.com',
        } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logToRTI).not.toHaveBeenCalledWith('info', expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String));
    });

    it('does not call logToRTI for telemetry when rtiLoggerHost is undefined', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig, telemetry: true, rtiLoggerHost: undefined,
        } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logToRTI).not.toHaveBeenCalled();
    });

    it('calls logToRTI with error when RTI call throws and rtiLoggerHost is set', async () => {
        // Arrange
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig, rtiLoggerHost: 'logger.example.com',
        } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logToRTI).toHaveBeenCalledWith('error', 'error: RTI timeout', expect.stringMatching(/^rti-cdn-integrations\.akamai-\d+\.\d+\.\d+$/), 'api-key', 'tag-hash', 'logger.example.com');
    });

    it('does not call logToRTI on error when rtiLoggerHost is undefined', async () => {
        // Arrange
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        const req = buildRequest();

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logToRTI).not.toHaveBeenCalled();
    });

    it('calls logToRTI with String(e) fallback when non-Error is thrown and rtiLoggerHost is set', async () => {
        // Arrange
        mocks.callRTI.mockRejectedValue('plain string error');
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig, rtiLoggerHost: 'logger.example.com',
        } as any);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logToRTI).toHaveBeenCalledWith('error', 'error: plain string error', expect.any(String), expect.any(String), expect.any(String), 'logger.example.com');
    });

    it('calls logToRTI with challenge error when challenge throws and rtiLoggerHost is set', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            rtiLoggerHost: 'logger.example.com',
            challenge: vi.fn().mockRejectedValue(new Error('challenge failed')),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logToRTI).toHaveBeenCalledWith('error', 'challenge error: challenge failed', expect.stringMatching(/^rti-cdn-integrations\.akamai-\d+\.\d+\.\d+$/), 'api-key', 'tag-hash', 'logger.example.com');
    });

    it('does not call logToRTI for challenge error when rtiLoggerHost is undefined', async () => {
        // Arrange
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            rtiLoggerHost: undefined,
            challenge: vi.fn().mockRejectedValue(new Error('challenge failed')),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logToRTI).not.toHaveBeenCalled();
    });

    it('uses String(e) fallback when challenge throws a non-Error value and debug is enabled', async () => {
        // Arrange — non-Error thrown: covers String(e) branch in challenge catch
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            debug: true,
            challenge: vi.fn().mockRejectedValue('plain challenge error'),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logLog).toHaveBeenCalledWith(expect.stringContaining('plain challenge error'));
    });

    it('uses String(e) fallback when challenge throws a non-Error value and logToRTI is configured', async () => {
        // Arrange — non-Error thrown: covers String(e) branch in logToRTI call
        vi.mocked(buildDynamicConfig).mockReturnValue({
            ...defaultConfig,
            rtiLoggerHost: 'logger.example.com',
            challenge: vi.fn().mockRejectedValue('plain challenge error'),
        } as any);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const req = buildRequest('/page', { pmuser: { 'PMUSER_CHEQ_USE_DYNAMIC_CONFIG': 'true' } });

        // Act
        await onClientRequest(req);

        // Assert
        expect(mocks.logToRTI).toHaveBeenCalledWith('error', 'challenge error: plain challenge error', expect.any(String), expect.any(String), expect.any(String), 'logger.example.com');
    });

    // --- onClientResponse ---

    it('adds x-cheq-rti-result header on response when debug is enabled and flow variable is set', () => {
        // Arrange
        const req = buildRequest();
        const variables: Record<string, string> = {
            'PMUSER_CHEQ_DEBUG': 'true',
            'PMUSER_CHEQ_RTI_FLOW': 'version=4.1;verdict=benign;threat-type-code=0;ids={}',
        };
        vi.mocked(req.getVariable).mockImplementation((name: string) => variables[name]);
        const res = buildResponse();

        // Act
        onClientResponse(req, res);

        // Assert
        expect(res.addHeader).toHaveBeenCalledWith('x-cheq-rti-result', 'version=4.1;verdict=benign;threat-type-code=0;ids={}');
    });

    it('does not add header when flow variable is absent', () => {
        // Arrange
        const req = buildRequest();
        vi.mocked(req.getVariable).mockImplementation((name: string) =>
            name === 'PMUSER_CHEQ_DEBUG' ? 'true' : undefined
        );
        const res = buildResponse();

        // Act
        onClientResponse(req, res);

        // Assert
        expect(res.addHeader).not.toHaveBeenCalled();
    });

    it('does not add debug headers when debug is disabled', () => {
        // Arrange
        const req = buildRequest();
        vi.mocked(req.getVariable).mockReturnValue(undefined);
        const res = buildResponse();

        // Act
        onClientResponse(req, res);

        // Assert
        expect(res.addHeader).not.toHaveBeenCalled();
    });

    it('does not add header when PMUSER_CHEQ_RTI_FLOW is empty string', () => {
        // Arrange
        const req = buildRequest();
        vi.mocked(req.getVariable).mockImplementation((name: string) => {
            if (name === 'PMUSER_CHEQ_DEBUG') return 'true';
            if (name === 'PMUSER_CHEQ_RTI_FLOW') return '';
            return undefined;
        });
        const res = buildResponse();

        // Act
        onClientResponse(req, res);

        // Assert
        expect(res.addHeader).not.toHaveBeenCalled();
    });
});
