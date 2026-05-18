import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    callRTI: vi.fn(),
    shouldIgnore: vi.fn(),
    getAction: vi.fn(),
    getActionStrategy: vi.fn(),
    getEventType: vi.fn().mockReturnValue('pageview'),
    validateConfig: vi.fn().mockReturnValue([]),
    loggerInfo: vi.fn().mockResolvedValue(undefined),
    loggerError: vi.fn().mockResolvedValue(undefined),
    generateDefaultBlockPage: vi.fn().mockReturnValue('<html>blocked</html>'),
}));

vi.mock('../package.json', () => ({ name: 'test', version: '1.0.0' }));

vi.mock('./config', () => ({
    config: {
        tagHash: 'tag-hash',
        apiKey: 'api-key',
        debug: false,
        telemetry: false,
        redirectLocation: 'https://www.cheq.ai/',
        challenge: undefined as any,
        validateChallenge: undefined as any,
    },
}));

vi.mock('../../core/services/rti.service', () => ({
    RTIService: vi.fn().mockImplementation(function () { return { callRTI: mocks.callRTI }; }),
}));

vi.mock('../../core/services/rti-helper.service', () => ({
    RTIHelperService: vi.fn().mockImplementation(function () {
        return {
            shouldIgnore: mocks.shouldIgnore,
            getAction: mocks.getAction,
            getActionStrategy: mocks.getActionStrategy,
            getEventType: mocks.getEventType,
            validateConfig: mocks.validateConfig,
        };
    }),
}));

vi.mock('../../core/services/rti-logger.service', () => ({
    RTILoggerService: vi.fn().mockImplementation(function () {
        return { info: mocks.loggerInfo, error: mocks.loggerError };
    }),
}));

vi.mock('../../core/helpers/block-page-helpers', () => ({
    generateDefaultBlockPage: mocks.generateDefaultBlockPage,
}));

import worker from './index';
import { Action } from '../../core/models/action.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { config } from './config';
import { Ids } from '../../core/models/rti-response.model';

const BASE_URL = 'https://example.com';

function buildRequest(path = '/page', opts: {
    cookies?: string;
    cfRay?: string;
    xRealIp?: string;
    querystring?: string;
} = {}): Request {
    const url = `${BASE_URL}${path}${opts.querystring ? '?' + opts.querystring : ''}`;
    const headers = new Headers();
    headers.set('host', 'example.com');
    headers.set('user-agent', 'Mozilla/5.0');
    if (opts.cookies) headers.set('cookie', opts.cookies);
    if (opts.cfRay) headers.set('cf-ray', opts.cfRay);
    if (opts.xRealIp) headers.set('x-real-ip', opts.xRealIp);
    return new Request(url, { headers });
}

function buildContext(): ExecutionContext {
    return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function buildRTIResponse(overrides: Partial<{ rayId: string; pageViewId: string | null }> = {}) {
    const ids: Ids = { rayId: overrides.rayId ?? 'ray-123', pageViewId: overrides.pageViewId ?? null, duid: null, uniqueVisitId: null, customParam1: null, customParam2: null, customParam3: null, customParam4: null };
    return {
        metadata: { version: '4.1' },
        decision: { verdict: 'valid' },
        classification: { code: 0 },
        ids,
        cheqDetection: { reasons: ['reason1'] },
    };
}

describe('cloudflare worker', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.shouldIgnore.mockReturnValue(false);
        mocks.getAction.mockReturnValue(Action.ALLOW);
        mocks.callRTI.mockResolvedValue(buildRTIResponse());
        (config as any).debug = false;
        (config as any).telemetry = false;
        (config as any).challenge = undefined;
        (config as any).validateChallenge = undefined;
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        vi.unstubAllGlobals();
    });

    // --- Pass-through: ignored path ---

    it('passes through without calling RTI when path is ignored', async () => {
        mocks.shouldIgnore.mockReturnValue(true);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const result = await worker.fetch(buildRequest('/favicon.ico'), {}, buildContext());
        expect(result.status).toBe(200);
        expect(mocks.callRTI).not.toHaveBeenCalled();
    });

    it('passes through without calling RTI when challenge is already valid', async () => {
        (config as any).validateChallenge = vi.fn().mockResolvedValue(true);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const result = await worker.fetch(buildRequest(), {}, buildContext());
        expect(mocks.callRTI).not.toHaveBeenCalled();
        expect(result.status).toBe(200);
    });

    // --- ALLOW: passes to origin with x-cheq-rti-result header ---

    it('calls RTI and passes request to origin with x-cheq-rti-result header on ALLOW', async () => {
        let capturedRequest: Request | undefined;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((req: Request) => {
            capturedRequest = req;
            return Promise.resolve(new Response('origin'));
        }));
        await worker.fetch(buildRequest(), {}, buildContext());
        expect(mocks.callRTI).toHaveBeenCalled();
        expect(capturedRequest?.headers.get('x-cheq-rti-result')).toContain('version=4.1');
    });

    // --- x-cheq-rti-result header content ---

    it('x-cheq-rti-result contains version, verdict, threat-type-code, and ids', async () => {
        let capturedRequest: Request | undefined;
        vi.stubGlobal('fetch', vi.fn().mockImplementation((req: Request) => {
            capturedRequest = req;
            return Promise.resolve(new Response('origin'));
        }));
        await worker.fetch(buildRequest(), {}, buildContext());
        const header = capturedRequest?.headers.get('x-cheq-rti-result') ?? '';
        expect(header).toContain('version=4.1');
        expect(header).toContain('verdict=valid');
        expect(header).toContain('threat-type-code=0');
        expect(header).toContain('ids=');
        expect(header).not.toContain('reasons=');
    });

    // --- Block strategies ---

    it('returns 403 with block page HTML when action strategy is ACCESS_DENIED', async () => {
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);
        const result = await worker.fetch(buildRequest(), {}, buildContext());
        expect(result.status).toBe(403);
        expect(await result.text()).toBe('<html>blocked</html>');
        expect(mocks.generateDefaultBlockPage).toHaveBeenCalledWith('403', 'Access Denied', expect.objectContaining({ rayId: 'ray-123' }), null);
    });

    it('returns 404 with block page HTML when action strategy is NOT_FOUND', async () => {
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.NOT_FOUND);
        const result = await worker.fetch(buildRequest(), {}, buildContext());
        expect(result.status).toBe(404);
        expect(mocks.generateDefaultBlockPage).toHaveBeenCalledWith('404', 'Not Found', expect.objectContaining({ rayId: 'ray-123' }), null);
    });

    it('passes cf-ray as additionalCdnId to generateDefaultBlockPage', async () => {
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.ACCESS_DENIED);
        await worker.fetch(buildRequest('/page', { cfRay: 'ray-abc-123' }), {}, buildContext());
        expect(mocks.generateDefaultBlockPage).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.anything(), 'ray-abc-123');
    });

    // --- Redirect ---

    it('returns 302 with location and tracking headers on REDIRECT', async () => {
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ rayId: 'ray-xyz', pageViewId: 'pv-456' }));
        const result = await worker.fetch(buildRequest('/page', { cfRay: 'cf-ray-val' }), {}, buildContext());
        expect(result.status).toBe(302);
        expect(result.headers.get('location')).toBe('https://www.cheq.ai/');
        expect(result.headers.get('x-cheq-id')).toBe('ray-xyz');
        expect(result.headers.get('x-cheq-page-view-id')).toBe('pv-456');
        expect(result.headers.get('x-cheq-cf-request-id')).toBe('cf-ray-val');
    });

    it('sets x-cheq-page-view-id to empty string when pageViewId is null', async () => {
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        mocks.callRTI.mockResolvedValue(buildRTIResponse({ pageViewId: null }));
        const result = await worker.fetch(buildRequest(), {}, buildContext());
        expect(result.headers.get('x-cheq-page-view-id')).toBe('');
    });

    it('defaults redirect location to cheq.ai when redirectLocation is not configured', async () => {
        (config as any).redirectLocation = undefined;
        mocks.getAction.mockReturnValue(Action.REDIRECT);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.REDIRECT);
        const result = await worker.fetch(buildRequest(), {}, buildContext());
        expect(result.status).toBe(302);
        expect(result.headers.get('location')).toBe('https://www.cheq.ai/');
    });

    // --- CAPTCHA ---

    it('calls challenge and returns its result when CAPTCHA and challenge is configured', async () => {
        const challengeResponse = new Response('<html>captcha</html>', { status: 200 });
        (config as any).challenge = vi.fn().mockResolvedValue(challengeResponse);
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        const result = await worker.fetch(buildRequest(), {}, buildContext());
        expect(result).toBe(challengeResponse);
    });

    it('passes through and logs error when challenge throws', async () => {
        (config as any).challenge = vi.fn().mockRejectedValue(new Error('challenge failed'));
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('origin')));
        const ctx = buildContext();
        const result = await worker.fetch(buildRequest(), {}, ctx);
        expect(result.status).toBe(200);
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('challenge failed'));
    });

    it('passes through when CAPTCHA but no challenge configured', async () => {
        mocks.getAction.mockReturnValue(Action.CHALLENGE);
        mocks.getActionStrategy.mockReturnValue(ActionStrategy.CAPTCHA);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('origin')));
        const result = await worker.fetch(buildRequest(), {}, buildContext());
        expect(result.status).toBe(200);
    });

    // --- Default/unrecognized strategy ---

    it('passes through when action strategy is unrecognized (default case)', async () => {
        mocks.getAction.mockReturnValue(Action.BLOCK);
        mocks.getActionStrategy.mockReturnValue(null);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('origin')));
        const result = await worker.fetch(buildRequest(), {}, buildContext());
        expect(result.status).toBe(200);
    });

    // --- Cookie extraction ---

    it('extracts _cq_duid, _cq_pvid, and _cq_s from cookie header', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        await worker.fetch(buildRequest('/page', { cookies: '_cq_duid=d-abc; _cq_pvid=pv-xyz; _cq_s=s-token' }), {}, buildContext());
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBe('d-abc');
        expect(payload.pvidCookie).toBe('pv-xyz');
        expect(payload.sCookie).toBe('s-token');
    });

    it('leaves cookie fields undefined when cookies are absent', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        await worker.fetch(buildRequest(), {}, buildContext());
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.duidCookie).toBeUndefined();
        expect(payload.pvidCookie).toBeUndefined();
        expect(payload.sCookie).toBeUndefined();
    });

    // --- customId2 (cf-ray) ---

    it('passes cf-ray as customId2 in RTI payload', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        await worker.fetch(buildRequest('/page', { cfRay: 'cf-ray-12345' }), {}, buildContext());
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.customId2).toBe('cf-ray-12345');
    });

    it('sets customId2 to undefined when cf-ray header is absent', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        await worker.fetch(buildRequest(), {}, buildContext());
        const payload = mocks.callRTI.mock.calls[0][0];
        expect(payload.customId2).toBeUndefined();
    });

    // --- Telemetry ---

    it('calls context.waitUntil with logger when telemetry is enabled', async () => {
        (config as any).telemetry = true;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const ctx = buildContext();
        await worker.fetch(buildRequest(), {}, ctx);
        expect(ctx.waitUntil).toHaveBeenCalled();
    });

    // --- Debug logging ---

    it('logs payload and response when debug is enabled', async () => {
        (config as any).debug = true;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await worker.fetch(buildRequest(), {}, buildContext());
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('requset payload'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('rtiResponse'));
        consoleSpy.mockRestore();
    });

    it('logs action when debug is enabled', async () => {
        (config as any).debug = true;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await worker.fetch(buildRequest(), {}, buildContext());
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('action:'));
        consoleSpy.mockRestore();
    });

    // --- Error handling ---

    it('passes through and logs error when RTI call throws', async () => {
        mocks.callRTI.mockRejectedValue(new Error('RTI timeout'));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('origin')));
        const ctx = buildContext();
        const result = await worker.fetch(buildRequest(), {}, ctx);
        expect(result.status).toBe(200);
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining('RTI timeout'));
        expect(ctx.waitUntil).toHaveBeenCalled();
    });
});
