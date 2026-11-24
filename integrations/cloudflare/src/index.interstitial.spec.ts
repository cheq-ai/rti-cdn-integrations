// cspell:ignore gclid duid pvid siteverify
// The passive interstitial in the Worker: the strategy INTERSTITIAL, the line for MONITORING mode, the outcome lines,
// the empty 403 for a prefetch, the mark (_cq_it) on the reload, "cookie" mode, and the caching headers of a forwarded
// answer. Core is real (RTIHelperService, InterstitialService, the page). Only RTI (callRTI) and the RTI logger are
// mocks, so nothing reaches CHEQ's services.
// index reads config.interstitial once, when it loads, so each test loads a fresh copy of index against its own config.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { Mode } from '../../core/models/mode.model';
import { Action } from '../../core/models/action.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import type { RTIRequest } from '../../core/models/rti-request.model';
import { buildRTIResponse } from '../../core/testing/rti-response.fixture';
import { CONSOLE_LINE, CONSOLE_TAG_HASH } from '../../core/testing/interstitial.fixture';
import type { CloudflareConfig } from './config';
import { createTurnstileChallenge } from './turnstile-challenge-example';

const mocks = vi.hoisted(() => ({
    callRTI: vi.fn(),
    loggerInfo: vi.fn().mockResolvedValue(undefined),
    loggerError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/rti.service', () => ({
    RTIService: vi.fn().mockImplementation(function () { return { callRTI: mocks.callRTI }; }),
}));

vi.mock('../../core/services/rti-logger.service', () => ({
    RTILoggerService: vi.fn().mockImplementation(function () { return { info: mocks.loggerInfo, error: mocks.loggerError }; }),
}));

type Worker = (typeof import('./index'))['default'];

const BASE_CONFIG = {
    mode: Mode.BLOCKING,
    apiKey: 'k',
    tagHash: CONSOLE_TAG_HASH,
    interstitial: { enabled: true, tag: CONSOLE_LINE },
};

// The src of the tag line. The page's script sets it on the <script> element it builds, so it is in the page.
const TAG_SRC = /src="([^"]+)"/.exec(CONSOLE_LINE)![1];

const SHOWN = 'interstitial: shown, rayId=ray-1, verdict=suspicious, reasons=4,7, request=ray-cf';
const WOULD_SHOW = 'interstitial: would-show, rayId=ray-1, verdict=suspicious, reasons=4,7, request=ray-cf';

// The reload line of row 1 of the reload: sessionFound true, and onSecondVerdict ALLOW (the default).
const SECOND_VERDICT_ALLOW = 'interstitial: second-verdict:ALLOW, firstRayId=ray-1, rayId=ray-2, verdict=suspicious, reasons=4,7, sessionFound=true, request=ray-cf2';

// The URL of the page load, the page and its reload.
const PAGE_URL = 'https://example.com/sofas?gclid=abc';

// The shown line of a page load that gets the page again, with RTI's ray id ray-2.
const SHOWN_AGAIN = 'interstitial: shown, rayId=ray-2, verdict=suspicious, reasons=4,7, request=ray-cf2';

// The reload line for the mark of the page (firstRayId ray-1): `outcome` and the answer of RTI call 2.
const reloadLine = (outcome: string, sessionFound: boolean | null, { verdict = 'suspicious', rayId = 'ray-2', request = 'ray-cf2' } = {}) =>
    `interstitial: ${outcome}, firstRayId=ray-1, rayId=${rayId}, verdict=${verdict}, reasons=4,7, sessionFound=${sessionFound}, request=${request}`;

// A fresh copy of index, loaded against the base config with `config` over it, and the InterstitialService class of the
// same copy, for a spy on its prototype.
const loadWorker = async (config: Record<string, unknown> = {}) => {
    vi.resetModules();
    vi.doMock('./config', () => ({ config: { ...BASE_CONFIG, ...config } }));
    const worker: Worker = (await import('./index')).default;
    const { InterstitialService } = await import('../../core/services/interstitial.service');
    return { worker, InterstitialService };
};

// The base config's interstitial block with `settings` over it.
const interstitial = (settings: Record<string, unknown>) => ({ interstitial: { ...BASE_CONFIG.interstitial, ...settings } });

// A page load: a browser asks for a page. `headers` go over the browser's headers.
const pageLoad = (headers: Record<string, string> = {}, method = 'GET') => new Request(PAGE_URL, {
    method,
    headers: {
        'Sec-Fetch-Dest': 'document',
        'cf-ray': 'ray-cf',
        'cf-connecting-ip': '203.0.113.7',
        'user-agent': 'e2e-browser',
        Referer: 'https://www.google.com/search?q=x',
        ...headers,
    },
});

// The reload of the page: the same URL, the same client, a new cf-ray, the mark that the page's script wrote, and the
// tag's cookies (_cq_duid, _cq_s and a new _cq_pvid). Its Referer is the page's own URL: the design says that Chrome
// sent that on a script's reload (tested on 2026-11-17). `headers` go over these.
const reload = (mark: string, headers: Record<string, string> = {}, url = PAGE_URL, method = 'GET') => new Request(url, {
    method,
    headers: {
        'Sec-Fetch-Dest': 'document',
        'cf-ray': 'ray-cf2',
        'cf-connecting-ip': '203.0.113.7',
        'user-agent': 'e2e-browser',
        Referer: PAGE_URL,
        cookie: `_cq_duid=d1; _cq_s=s1; _cq_pvid=pv2; _cq_it=${mark}`,
        ...headers,
    },
});

// The mark that the page's script writes: the markValue of the script values at the end of the page.
const markOf = (body: string): string => /"markValue":"([^"]+)"/.exec(body)![1];

// The payload of RTI call `call` (0 is the first).
const rtiPayload = (call: number): RTIRequest => mocks.callRTI.mock.calls[call][0];

// RTI's answer: suspicious, ray id ray-1, reasons 4 and 7, and metadata.sessionFound.
const rtiAnswer = (sessionFound: boolean | null, overrides: Parameters<typeof buildRTIResponse>[0] = {}) => {
    const answer = buildRTIResponse({ verdict: 'suspicious', rayId: 'ray-1', reasons: [4, 7], ...overrides });
    return { ...answer, metadata: { ...answer.metadata!, sessionFound } };
};

// A config.challenge that answers with its own page.
const captchaPage = () => vi.fn<NonNullable<CloudflareConfig['challenge']>>(async () => new Response('<html>captcha</html>', { status: 403 }));

// Sends a request through the Worker. `forwarded` is the request the origin got, if any. `origin` gives the origin's
// answer: by default the text "origin" (Content-Type text/plain), which the Worker passes on as it is.
async function run(worker: Worker, request: Request, origin: () => Promise<Response> = async () => new Response('origin')) {
    const originFetch = vi.fn<(request: Request) => Promise<Response>>(origin);
    vi.stubGlobal('fetch', originFetch);
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const response = await worker.fetch(request, {}, ctx);
    return { response, ctx, originFetch, forwarded: originFetch.mock.calls[0]?.[0] };
}

type RunResult = Awaited<ReturnType<typeof run>>;

// Forwarded: the origin got the request with RTI's verdict, and its answer went to the visitor.
const expectForwardedWithVerdict = async (result: RunResult, verdict = 'suspicious') => {
    expect(result.originFetch).toHaveBeenCalledOnce();
    expect(result.forwarded!.headers.get('x-cheq-rti-result')).toContain(`verdict=${verdict}`);
    expect(await result.response.text()).toBe('origin');
};

// The interstitial page: its status, its three headers, the ray id of RTI and the tag's src. Gives the page's HTML.
const expectInterstitialPage = async (response: Response, status = 403, rayId = 'ray-1') => {
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('text/html;charset=UTF-8');
    expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    const body = await response.text();
    expect(body).toContain(`Ray ID: ${rayId}`);
    expect(body).toContain(TAG_SRC);
    return body;
};

// The lines that index wrote to the console.
const consoleLines = (log: { mock: { calls: unknown[][] } }): string[] => log.mock.calls.map(([line]) => String(line));

// Serves the page to `request` (RTI call 1 answers ray-1, suspicious, sessionFound null), and gives the mark that the
// page's script writes.
async function markFromPage(worker: Worker, request = pageLoad()): Promise<string> {
    mocks.callRTI.mockResolvedValueOnce(rtiAnswer(null));
    const { response } = await run(worker, request);
    return markOf(await expectInterstitialPage(response));
}

// The first load of the module graph is slow (seconds on a busy machine): it happens here, with a long timeout, not in
// the 5 s of a test, so each test only loads index again. The module registry and the mocks are left clean for the tests.
beforeAll(async () => {
    await loadWorker();
    vi.doUnmock('./config');
    vi.resetModules();
}, 60_000);

let expectError = false;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.clearAllMocks();
    expectError = false;
    // Also drops an answer for one call that a failed test did not use.
    mocks.callRTI.mockReset();
    mocks.callRTI.mockResolvedValue(rtiAnswer(null));
    // The cold-start warnings are tested in index.startup.spec.ts: kept out of the output here.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    try {
        if (!expectError) {
            expect(consoleError).not.toHaveBeenCalled();
            expect(mocks.loggerError).not.toHaveBeenCalled();
        }
    } finally {
        // Also when the guard fails: spies, stubs and the config mock must not leak into the next test.
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.doUnmock('./config');
        vi.resetModules();
    }
});

describe('the interstitial in BLOCKING mode', () => {
    it('row 1: a page load that RTI wants challenged, sessionFound null, gets the interstitial page; the origin and config.challenge are not called; one shown line goes to the RTI logger through waitUntil', async () => {
        // Arrange
        const challenge = captchaPage();
        const { worker } = await loadWorker({ challenge });

        // Act
        const { response, ctx, originFetch } = await run(worker, pageLoad());

        // Assert
        await expectInterstitialPage(response);
        expect(originFetch).not.toHaveBeenCalled();
        expect(challenge).not.toHaveBeenCalled();
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN]]);
        expect(ctx.waitUntil).toHaveBeenCalledOnce();
        expect(vi.mocked(ctx.waitUntil).mock.calls[0][0]).toBe(mocks.loggerInfo.mock.results[0].value);
    });

    it('row 2: with statusCode 200 the interstitial page comes with status 200', async () => {
        // Arrange
        const { worker } = await loadWorker(interstitial({ statusCode: 200 }));

        // Act
        const { response } = await run(worker, pageLoad());

        // Assert
        await expectInterstitialPage(response, 200);
    });

    it('row 3: sessionFound true and onSecondVerdict ALLOW: forwarded with x-cheq-rti-result', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const { worker } = await loadWorker(interstitial({ onSecondVerdict: Action.ALLOW }));

        // Act
        const result = await run(worker, pageLoad());

        // Assert
        await expectForwardedWithVerdict(result);
    });

    it('row 4: sessionFound true and onSecondVerdict BLOCK: the 403 block page', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const { worker } = await loadWorker(interstitial({ onSecondVerdict: Action.BLOCK }));

        // Act
        const { response, originFetch } = await run(worker, pageLoad());

        // Assert
        expect(response.status).toBe(403);
        const body = await response.text();
        expect(body).toContain('<title>403 Access Denied</title>');
        expect(body).not.toContain(TAG_SRC);
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('row 4: sessionFound true and onSecondVerdict BLOCK, with blockingStrategy REDIRECT: a 302 to redirectLocation', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const { worker } = await loadWorker({
            blockingStrategy: ActionStrategy.REDIRECT,
            redirectLocation: 'https://shop.example/blocked',
            ...interstitial({ onSecondVerdict: Action.BLOCK }),
        });

        // Act
        const { response, originFetch } = await run(worker, pageLoad());

        // Assert
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('https://shop.example/blocked');
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('row 5: sessionFound true and onSecondVerdict REDIRECT: a 302 to redirectLocation', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const { worker } = await loadWorker({ redirectLocation: 'https://shop.example/suspicious', ...interstitial({ onSecondVerdict: Action.REDIRECT }) });

        // Act
        const { response, originFetch } = await run(worker, pageLoad());

        // Assert
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('https://shop.example/suspicious');
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('row 6: sessionFound true and onSecondVerdict CHALLENGE: config.challenge gets the copy of the request, and its page is the answer', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const challenge = captchaPage();
        const { worker } = await loadWorker({ challenge, ...interstitial({ onSecondVerdict: Action.CHALLENGE }) });
        // A verdict the client sends itself: the copy has it removed.
        const request = pageLoad({ 'x-cheq-rti-result': 'version=4.1;verdict=benign' });

        // Act
        const { response, originFetch } = await run(worker, request);

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        const challenged = challenge.mock.calls[0][0];
        expect(challenged).not.toBe(request);
        expect(challenged.url).toBe(request.url);
        expect(challenged.method).toBe('GET');
        expect(challenged.headers.get('x-cheq-rti-result')).toBeNull();
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('row 7: sessionFound true and onSecondVerdict CHALLENGE without config.challenge: forwarded with x-cheq-rti-result', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const { worker } = await loadWorker(interstitial({ onSecondVerdict: Action.CHALLENGE }));

        // Act
        const result = await run(worker, pageLoad());

        // Assert
        await expectForwardedWithVerdict(result);
    });

    it('row 7: sessionFound true and onSecondVerdict CHALLENGE with a valid session (validateChallenge gives true): forwarded with x-cheq-rti-result', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const challenge = captchaPage();
        const validateChallenge = vi.fn(async () => true);
        const { worker } = await loadWorker({ challenge, validateChallenge, ...interstitial({ onSecondVerdict: Action.CHALLENGE }) });

        // Act
        const result = await run(worker, pageLoad());

        // Assert
        await expectForwardedWithVerdict(result);
        expect(validateChallenge).toHaveBeenCalledOnce();
        expect(challenge).not.toHaveBeenCalled();
    });

    it.each([
        [true, [SHOWN]],
        [false, []],
    ])('row 8: a declared good bot (classification.code 19) gets the interstitial page like any visitor, and with debug %s the console gets %j', async (debug, lines) => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(null, { code: 19 }));
        const { worker } = await loadWorker({ debug });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        const { response, originFetch } = await run(worker, pageLoad());

        // Assert: the page, as for any visitor, and no "interstitial: forward" line
        await expectInterstitialPage(response);
        expect(originFetch).not.toHaveBeenCalled();
        expect(consoleLines(log).filter((line) => line.startsWith('interstitial:'))).toEqual(lines);
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN]]);
    });

    it.each([
        [true, ['interstitial: forward, not-a-page-load']],
        [false, []],
    ])('the guard of decide: a GET that is not a page load but gets the strategy INTERSTITIAL (only a spy gives it) is forwarded with the verdict, and with debug %s the console gets %j', async (debug, lines) => {
        // Arrange: getStrategyForRequest gives INTERSTITIAL only to a GET page load, so a spy stands in for it
        const { worker, InterstitialService } = await loadWorker({ debug });
        const { RTIHelperService } = await import('../../core/services/rti-helper.service');
        vi.spyOn(RTIHelperService.prototype, 'getStrategyForRequest').mockReturnValue({ strategy: ActionStrategy.INTERSTITIAL });
        const decide = vi.spyOn(InterstitialService.prototype, 'decide');
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        const result = await run(worker, pageLoad({ 'Sec-Fetch-Dest': 'empty' }));

        // Assert: the real decide answered with its guard
        expect(decide).toHaveBeenCalledOnce();
        expect(decide).toHaveReturnedWith({ kind: 'forward', reason: 'not-a-page-load' });
        await expectForwardedWithVerdict(result);
        expect(consoleLines(log).filter((line) => line.startsWith('interstitial:'))).toEqual(lines);
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
    });

    it.each([
        ['a GET with Sec-Fetch-Dest: empty', () => pageLoad({ 'Sec-Fetch-Dest': 'empty' })],
        ['a POST', () => pageLoad({}, 'POST')],
        ['a HEAD', () => pageLoad({}, 'HEAD')],
    ])('row 9: %s with sessionFound true and onSecondVerdict BLOCK is not a page load: forwarded with the verdict, no block page', async (_label, request) => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const { worker } = await loadWorker(interstitial({ onSecondVerdict: Action.BLOCK }));

        // Act
        const result = await run(worker, request());

        // Assert
        await expectForwardedWithVerdict(result);
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
    });

    it.each([
        ['enabled false', { enabled: false, tag: CONSOLE_LINE }],
        ['enabled true and tag REPLACE_ME', { enabled: true, tag: 'REPLACE_ME' }],
    ])('row 12: with %s the interstitial is off: config.challenge gets the page load (the CAPTCHA, as before this work)', async (_label, settings) => {
        // Arrange
        const challenge = captchaPage();
        const { worker } = await loadWorker({ challenge, interstitial: settings });
        const request = pageLoad();

        // Act
        const { response, originFetch } = await run(worker, request);

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        expect(challenge.mock.calls[0][0].url).toBe(request.url);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
    });

    it('row 13: challengingStrategy ACCESS_DENIED is not used while the interstitial is on: the page load gets the interstitial page', async () => {
        // Arrange
        const { worker } = await loadWorker({ challengingStrategy: ActionStrategy.ACCESS_DENIED });

        // Act
        const { response } = await run(worker, pageLoad());

        // Assert
        await expectInterstitialPage(response);
    });

    it('row 13: with challengingStrategy ACCESS_DENIED, sessionFound true and onSecondVerdict CHALLENGE, config.challenge answers, not the block page', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const challenge = captchaPage();
        const { worker } = await loadWorker({ challenge, challengingStrategy: ActionStrategy.ACCESS_DENIED, ...interstitial({ onSecondVerdict: Action.CHALLENGE }) });

        // Act
        const { response, originFetch } = await run(worker, pageLoad());

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('row 14: a reply to the CAPTCHA (isChallengeResponse gives true) goes to config.challenge, which answers it', async () => {
        // Arrange
        const challenge = captchaPage();
        const { worker } = await loadWorker({ challenge, isChallengeResponse: () => true });
        const request = pageLoad();

        // Act
        const { response, originFetch } = await run(worker, request);

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        expect(challenge.mock.calls[0][0].url).toBe(request.url);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
    });

    it('row 15: with logOutcomes false and debug on, no line goes to the RTI logger, and the console has the shown line', async () => {
        // Arrange
        const { worker } = await loadWorker({ debug: true, ...interstitial({ logOutcomes: false }) });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        const { response } = await run(worker, pageLoad());

        // Assert
        await expectInterstitialPage(response);
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
        expect(consoleLines(log)).toContain(SHOWN);
    });

    it('row 16: when the page cannot be built (crypto.subtle.sign rejects once), the request is forwarded with x-cheq-rti-result, and the error is logged', async () => {
        // Arrange
        expectError = true;
        const { worker } = await loadWorker();
        vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(new Error('sign failed'));

        // Act
        const result = await run(worker, pageLoad());

        // Assert
        await expectForwardedWithVerdict(result);
        expect(mocks.loggerError).toHaveBeenCalledWith("Interstitial error handling request 'ray-cf': sign failed");
        expect(consoleError).toHaveBeenCalledWith("Interstitial error handling request 'ray-cf':", expect.objectContaining({ message: 'sign failed' }));
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
    });

    it('row 17: RTI\'s answer without cheqDetection: the page is the answer, and the shown line has reasons=', async () => {
        // Arrange
        const answer = rtiAnswer(null);
        delete answer.cheqDetection;
        mocks.callRTI.mockResolvedValue(answer);
        const { worker } = await loadWorker();

        // Act
        const { response } = await run(worker, pageLoad());

        // Assert
        await expectInterstitialPage(response);
        expect(mocks.loggerInfo.mock.calls).toEqual([['interstitial: shown, rayId=ray-1, verdict=suspicious, reasons=, request=ray-cf']]);
    });

    it.each([
        ['config.originalReferer gives one', { originalReferer: () => 'https://www.bing.com/' }, 'https://www.bing.com/', JSON.stringify(['203.0.113.7', 'e2e-browser'])],
        ['without config.originalReferer, the copy has none', {}, undefined, JSON.stringify(['203.0.113.7', 'e2e-browser'])],
        // The binding key that sessionBindingKey gives for this binding: neither the IP nor the User-Agent.
        ['binding { ip: "none", userAgent: false }', interstitial({ binding: { ip: 'none', userAgent: false } }), undefined, JSON.stringify(['', ''])],
    ])('the page gets the plain facts of the copy (the binding key of the setting binding), the ray id of RTI and the copy\'s x-cheq-original-referer: %s', async (_label, config, carriedReferer, bindingKey) => {
        // Arrange
        const { worker, InterstitialService } = await loadWorker(config);
        const page = vi.spyOn(InterstitialService.prototype, 'page');
        // The client's own x-cheq-original-referer: the copy has it removed.
        const request = pageLoad({ cookie: '_cq_duid=d1', 'x-cheq-original-referer': 'https://evil.example/' });

        // Act
        const { response } = await run(worker, request);

        // Assert
        await expectInterstitialPage(response);
        expect(page).toHaveBeenCalledOnce();
        expect(page).toHaveBeenCalledWith({
            url: 'https://example.com/sofas?gclid=abc',
            cookie: '_cq_duid=d1',
            referer: 'https://www.google.com/search?q=x',
            bindingKey,
            pageLoad: true,
        }, 'ray-1', carriedReferer);
    });
});

describe('the interstitial in MONITORING mode (FR-7)', () => {
    it('row 10: a page load that would get the page is forwarded with the verdict, and one would-show line goes to the RTI logger through waitUntil', async () => {
        // Arrange
        const { worker } = await loadWorker({ mode: Mode.MONITORING });

        // Act
        const result = await run(worker, pageLoad());

        // Assert
        await expectForwardedWithVerdict(result);
        expect(mocks.loggerInfo.mock.calls).toEqual([[WOULD_SHOW]]);
        expect(result.ctx.waitUntil).toHaveBeenCalledOnce();
        expect(vi.mocked(result.ctx.waitUntil).mock.calls[0][0]).toBe(mocks.loggerInfo.mock.results[0].value);
    });

    it('row 10: with logOutcomes false no would-show line goes to the RTI logger', async () => {
        // Arrange
        const { worker } = await loadWorker({ mode: Mode.MONITORING, ...interstitial({ logOutcomes: false }) });

        // Act
        const result = await run(worker, pageLoad());

        // Assert
        await expectForwardedWithVerdict(result);
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
    });

    it('row 10: for a benign answer no would-show line is sent', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(null, { verdict: 'benign' }));
        const { worker } = await loadWorker({ mode: Mode.MONITORING, debug: true });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        const result = await run(worker, pageLoad());

        // Assert
        await expectForwardedWithVerdict(result, 'benign');
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
        expect(consoleLines(log).filter((line) => line.startsWith('interstitial:'))).toEqual([]);
    });

    it('row 10: a declared good bot (classification.code 19) is forwarded with the verdict, and one would-show line is sent, like any visitor', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(null, { code: 19 }));
        const { worker } = await loadWorker({ mode: Mode.MONITORING });

        // Act
        const result = await run(worker, pageLoad());

        // Assert
        await expectForwardedWithVerdict(result);
        expect(mocks.loggerInfo.mock.calls).toEqual([[WOULD_SHOW]]);
    });

    it.each([
        ['sessionFound true', {}, () => rtiAnswer(true)],
        ['a path that the rule { path: \'^/sofas\', methods: [\'GET\'], action: Action.ALLOW } covers', { actionOnSuspicious: { rules: [{ path: '^/sofas', methods: ['GET'], action: Action.ALLOW }] } }, () => rtiAnswer(null)],
    ])('row 10: a page load with %s is forwarded with the verdict, and no would-show line is sent', async (_label, config, answer) => {
        // Arrange
        mocks.callRTI.mockResolvedValue(answer());
        const { worker } = await loadWorker({ mode: Mode.MONITORING, ...config });

        // Act
        const result = await run(worker, pageLoad());

        // Assert
        await expectForwardedWithVerdict(result);
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
    });

    it('row 11: when decide throws, the request is forwarded with the verdict, and the error is logged', async () => {
        // Arrange
        expectError = true;
        const { worker, InterstitialService } = await loadWorker({ mode: Mode.MONITORING });
        vi.spyOn(InterstitialService.prototype, 'decide').mockImplementation(() => { throw new Error('boom'); });

        // Act
        const result = await run(worker, pageLoad());

        // Assert
        await expectForwardedWithVerdict(result);
        expect(mocks.loggerError).toHaveBeenCalledWith("Interstitial error handling request 'ray-cf': boom");
        expect(consoleError).toHaveBeenCalledWith("Interstitial error handling request 'ray-cf':", expect.objectContaining({ message: 'boom' }));
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
    });
});

describe('a prefetch of a page that would get the interstitial', () => {
    const prefetch = () => pageLoad({ 'Sec-Purpose': 'prefetch' });

    // The empty 403 of the CAPTCHA branch: no body, no cookie, the request ids and no-store.
    const expectEmpty403 = async (response: Response) => {
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('');
        expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
        expect(response.headers.get('x-cheq-cdn-request-id')).toBe('ray-cf');
        expect(response.headers.get('x-cheq-id')).toBe('ray-1');
        expect(response.headers.get('x-cheq-page-view-id')).toBe('');
        expect(response.headers.get('content-type')).toBeNull();
        expect(response.headers.get('set-cookie')).toBeNull();
    };

    it.each([
        [true, ['prefetch: an empty 403 in place of the interstitial']],
        [false, []],
    ])('row 18: gets the empty 403: no page, no mark, no shown line, config.challenge not called; with debug %s the console gets %j', async (debug, lines) => {
        // Arrange
        const challenge = captchaPage();
        const { worker, InterstitialService } = await loadWorker({ challenge, debug });
        const page = vi.spyOn(InterstitialService.prototype, 'page');
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        const { response, originFetch } = await run(worker, prefetch());

        // Assert
        await expectEmpty403(response);
        expect(page).not.toHaveBeenCalled();
        expect(challenge).not.toHaveBeenCalled();
        expect(originFetch).not.toHaveBeenCalled();
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
        expect(consoleLines(log).filter((line) => line.startsWith('prefetch:') || line.startsWith('interstitial:'))).toEqual(lines);
    });

    it('row 19: in MONITORING mode it is forwarded with the verdict, and no would-show line is sent', async () => {
        // Arrange
        const challenge = captchaPage();
        const { worker } = await loadWorker({ mode: Mode.MONITORING, challenge, debug: true });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        const result = await run(worker, prefetch());

        // Assert
        await expectForwardedWithVerdict(result);
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
        expect(consoleLines(log).filter((line) => line.startsWith('interstitial:'))).toEqual([]);
        expect(challenge).not.toHaveBeenCalled();
    });

    it('row 20: with sessionFound true and onSecondVerdict CHALLENGE, the CAPTCHA branch checks the prefetch itself: its empty 403 and its own debug line, config.challenge not called', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const challenge = captchaPage();
        const { worker } = await loadWorker({ challenge, debug: true, ...interstitial({ onSecondVerdict: Action.CHALLENGE }) });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Act
        const { response, originFetch } = await run(worker, prefetch());

        // Assert
        await expectEmpty403(response);
        expect(challenge).not.toHaveBeenCalled();
        expect(originFetch).not.toHaveBeenCalled();
        expect(consoleLines(log).filter((line) => line.startsWith('prefetch:'))).toEqual(['prefetch: an empty 403 in place of the challenge page']);
    });
});

// The reload of the page carries the mark (_cq_it) that the page's script wrote. Each test serves the page first (RTI
// call 1: ray-1), takes the mark from the page, and sends the reload (RTI call 2: ray-2).
describe('the mark (_cq_it) on the reload', () => {
    it.each([
        ['row 1: the reload', {}, {}],
        ['row 5: the reload from another IP, with binding { ip: "none", userAgent: true }', interstitial({ binding: { ip: 'none', userAgent: true } }), { 'cf-connecting-ip': '203.0.113.8' }],
    ])('%s, sessionFound true: forwarded with the verdict and the original Referer; RTI gets customId3 and the original Referer; the reload line says second-verdict:ALLOW', async (_label, config, headers) => {
        // Arrange
        const { worker } = await loadWorker(config);
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(true, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark, headers));

        // Assert
        await expectForwardedWithVerdict(result);
        expect(result.forwarded!.headers.get('x-cheq-original-referer')).toBe('https://www.google.com/');
        expect(rtiPayload(1).customId3).toBe('interstitial:ray-1');
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBe('https://www.google.com/');
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN], [SECOND_VERDICT_ALLOW]]);
        expect(result.ctx.waitUntil).toHaveBeenCalledWith(mocks.loggerInfo.mock.results[1].value);
    });

    it('row 2: the reload, sessionFound false: forwarded with the verdict; the reload line says no-session:ALLOW', async () => {
        // Arrange
        const { worker } = await loadWorker();
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(false, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark));

        // Assert
        await expectForwardedWithVerdict(result);
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN], [reloadLine('no-session:ALLOW', false)]]);
    });

    it.each([
        ['benign: forwarded with the verdict, and the reload line says passed', {}, { verdict: 'benign' as const }, 'passed',
            (result: RunResult) => expectForwardedWithVerdict(result, 'benign')],
        ['malicious: the block page, and the reload line says blocked', {}, { verdict: 'malicious' as const }, 'blocked',
            async ({ response, originFetch }: RunResult) => {
                expect(response.status).toBe(403);
                expect(await response.text()).toContain('<title>403 Access Denied</title>');
                expect(originFetch).not.toHaveBeenCalled();
            }],
        ['benign with a redirectTTCodes match: a 302 to redirectLocation, and the reload line says redirected',
            { redirectTTCodes: [42], redirectLocation: 'https://shop.example/moved' }, { verdict: 'benign' as const, code: 42 }, 'redirected',
            async ({ response, originFetch }: RunResult) => {
                expect(response.status).toBe(302);
                expect(response.headers.get('location')).toBe('https://shop.example/moved');
                expect(originFetch).not.toHaveBeenCalled();
            }],
    ])('row 3: the reload, RTI %s', async (_label, config, answer, outcome, expectAnswer) => {
        // Arrange
        const { worker } = await loadWorker(config);
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(true, { rayId: 'ray-2', ...answer }));

        // Act
        const result = await run(worker, reload(mark));

        // Assert
        await expectAnswer(result);
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN], [reloadLine(outcome, true, { verdict: answer.verdict })]]);
    });

    it.each([
        ['another cf-connecting-ip', { 'cf-connecting-ip': '203.0.113.8' }],
        ['another user-agent', { 'user-agent': 'other-browser' }],
    ])('row 4: the reload from %s has no valid mark: the interstitial again; no customId3, no original Referer, no reload line', async (_label, headers) => {
        // Arrange
        const { worker } = await loadWorker();
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(false, { rayId: 'ray-2' }));

        // Act
        const { response } = await run(worker, reload(mark, headers));

        // Assert
        await expectInterstitialPage(response, 403, 'ray-2');
        expect(rtiPayload(1).customId3).toBeUndefined();
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBeUndefined();
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN], [SHOWN_AGAIN]]);
    });

    it('row 6: the mark on https://example.com/sofas/ (the origin\'s redirect target), sessionFound false: the no-session action, forwarded with the verdict; no interstitial, no customId3, no original Referer, no reload line', async () => {
        // Arrange
        const { worker } = await loadWorker();
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(false, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark, {}, 'https://example.com/sofas/'));

        // Assert
        await expectForwardedWithVerdict(result);
        expect(result.forwarded!.headers.get('x-cheq-original-referer')).toBeNull();
        expect(rtiPayload(1).customId3).toBeUndefined();
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBeUndefined();
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN]]);
    });

    it('row 7: the mark on its page with Referer https://example.com/other: RTI gets customId3, and no original Referer is added', async () => {
        // Arrange
        const { worker } = await loadWorker();
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(true, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark, { Referer: 'https://example.com/other' }));

        // Assert
        await expectForwardedWithVerdict(result);
        expect(result.forwarded!.headers.get('x-cheq-original-referer')).toBeNull();
        expect(rtiPayload(1).customId3).toBe('interstitial:ray-1');
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBeUndefined();
    });

    it('row 8: the reload with a config.originalReferer that gives https://partner.example/, sessionFound true: forwarded with that value (a valid _cq_rf wins over the mark)', async () => {
        // Arrange: nothing for the page load, so the mark carries the Referer from Google; then https://partner.example/
        const originalReferer = vi.fn<NonNullable<CloudflareConfig['originalReferer']>>().mockReturnValueOnce(undefined).mockReturnValue('https://partner.example/');
        const { worker } = await loadWorker({ originalReferer });
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(true, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark));

        // Assert
        await expectForwardedWithVerdict(result);
        expect(originalReferer).toHaveBeenCalledTimes(2);
        expect(result.forwarded!.headers.get('x-cheq-original-referer')).toBe('https://partner.example/');
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBe('https://partner.example/');
    });

    // Row 9: two clients at the same time in one isolate. RTI answers with the ray id of the request's cf-ray (cf-A:
    // ray-A) and sessionFound null. Its answer for cf-A waits until it was called for cf-B, so both page loads are in the
    // Worker at the same time. The reloads cf-A2 and cf-B2 each wait at RTI until both have called it, so both have read
    // their mark before either goes on. A mark kept in module state would then be the other client's for at least one
    // of them after RTI.
    const rtiForTwoClients = () => {
        let calledForB!: () => void;
        const bCalled = new Promise<void>((resolve) => { calledForB = resolve; });
        let reloadsIn = 0;
        let bothIn!: () => void;
        const both = new Promise<void>((resolve) => { bothIn = resolve; });
        mocks.callRTI.mockImplementation(async (payload: RTIRequest) => {
            if (payload.customId2 === 'cf-A2' || payload.customId2 === 'cf-B2') {
                if (++reloadsIn === 2) {
                    bothIn();
                }
                await both;
            }
            if (payload.customId2 === 'cf-A') {
                await bCalled;
            } else {
                calledForB();
            }
            return rtiAnswer(null, { rayId: payload.customId2!.replace('cf-', 'ray-') });
        });
    };
    const client = (ip: string, cfRay: string) => ({ 'cf-connecting-ip': ip, 'cf-ray': cfRay });
    // Sends the requests through the Worker at the same time. One origin for all of them.
    const atOnce = (worker: Worker, requests: Request[]) => {
        vi.stubGlobal('fetch', vi.fn(async (_request: Request) => new Response('origin')));
        const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
        return Promise.all(requests.map((request) => worker.fetch(request, {}, ctx)));
    };
    const loggedLines = () => mocks.loggerInfo.mock.calls.map(([line]) => line).sort();

    it('row 9: two page loads at once from two clients: each page holds its own ray id and mark, and each shown line its own pair; then each reload gets customId3 with its own ray id, and a mark sent from the other client\'s IP is not valid', async () => {
        // Arrange
        const { worker } = await loadWorker();
        rtiForTwoClients();

        // Act 1: the two page loads at once
        const pages = await atOnce(worker, [pageLoad(client('203.0.113.1', 'cf-A')), pageLoad(client('203.0.113.2', 'cf-B'))]);

        // Assert 1
        const [pageA, pageB] = await Promise.all(pages.map((response) => response.text()));
        expect(pageA).toContain('Ray ID: ray-A');
        expect(pageB).toContain('Ray ID: ray-B');
        const [markA, markB] = [markOf(pageA), markOf(pageB)];
        expect(markA.split('|')[2]).toBe('ray-A');
        expect(markB.split('|')[2]).toBe('ray-B');
        expect(loggedLines()).toEqual([
            'interstitial: shown, rayId=ray-A, verdict=suspicious, reasons=4,7, request=cf-A',
            'interstitial: shown, rayId=ray-B, verdict=suspicious, reasons=4,7, request=cf-B',
        ]);

        // Act 2: each client's reload, and A's mark sent from B's IP, at once
        mocks.loggerInfo.mockClear();
        const reloads = await atOnce(worker, [
            reload(markA, client('203.0.113.1', 'cf-A2')),
            reload(markB, client('203.0.113.2', 'cf-B2')),
            reload(markA, client('203.0.113.2', 'cf-X')),
        ]);

        // Assert 2: each reload carries the ray id of its own page to RTI. A's mark from B's IP is no mark: the page again
        const customId3 = (cfRay: string) => mocks.callRTI.mock.calls.map(([payload]) => payload as RTIRequest).find((payload) => payload.customId2 === cfRay)!.customId3;
        expect(customId3('cf-A2')).toBe('interstitial:ray-A');
        expect(customId3('cf-B2')).toBe('interstitial:ray-B');
        expect(customId3('cf-X')).toBeUndefined();
        expect(await reloads[0].text()).toBe('origin');
        expect(await reloads[1].text()).toBe('origin');
        expect(await reloads[2].text()).toContain('Ray ID: ray-X');
        expect(loggedLines()).toEqual([
            'interstitial: no-session:ALLOW, firstRayId=ray-A, rayId=ray-A2, verdict=suspicious, reasons=4,7, sessionFound=null, request=cf-A2',
            'interstitial: no-session:ALLOW, firstRayId=ray-B, rayId=ray-B2, verdict=suspicious, reasons=4,7, sessionFound=null, request=cf-B2',
            'interstitial: shown, rayId=ray-X, verdict=suspicious, reasons=4,7, request=cf-X',
        ]);
    });

    it('row 9 in "cookie" mode, onSessionNotFound CHALLENGE: A comes from Google and B from Bing; the two reloads wait at RTI at the same time, and each config.challenge gets the copy with its own client\'s original Referer; RTI gets none', async () => {
        // Arrange: config.challenge notes the x-cheq-original-referer of each request it gets, during the call
        const referers: Record<string, string | null> = {};
        const challenge = vi.fn<NonNullable<CloudflareConfig['challenge']>>(async (request) => {
            referers[request.headers.get('cf-ray')!] = request.headers.get('x-cheq-original-referer');
            return new Response('<html>captcha</html>', { status: 403 });
        });
        const { worker } = await loadWorker({ challenge, ...interstitial({ originalRefererVia: 'cookie', onSessionNotFound: Action.CHALLENGE }) });
        rtiForTwoClients();
        const pages = await atOnce(worker, [
            pageLoad(client('203.0.113.1', 'cf-A')),
            pageLoad({ ...client('203.0.113.2', 'cf-B'), Referer: 'https://www.bing.com/search?q=y' }),
        ]);
        const [markA, markB] = await Promise.all(pages.map(async (response) => markOf(await response.text())));
        mocks.loggerInfo.mockClear();

        // Act: each client's reload, at once
        const reloads = await atOnce(worker, [reload(markA, client('203.0.113.1', 'cf-A2')), reload(markB, client('203.0.113.2', 'cf-B2'))]);

        // Assert
        expect(referers).toEqual({ 'cf-A2': 'https://www.google.com/', 'cf-B2': 'https://www.bing.com/' });
        expect(await reloads[0].text()).toBe('<html>captcha</html>');
        expect(await reloads[1].text()).toBe('<html>captcha</html>');
        const rtiReferers = mocks.callRTI.mock.calls.map(([payload]) => (payload as RTIRequest).endUserParams.headers!['x-cheq-original-referer']);
        expect(rtiReferers).toEqual([undefined, undefined, undefined, undefined]);
        expect(loggedLines()).toEqual([
            'interstitial: no-session:CHALLENGE, firstRayId=ray-A, rayId=ray-A2, verdict=suspicious, reasons=4,7, sessionFound=null, request=cf-A2',
            'interstitial: no-session:CHALLENGE, firstRayId=ray-B, rayId=ray-B2, verdict=suspicious, reasons=4,7, sessionFound=null, request=cf-B2',
        ]);
    });

    it('the reload line cannot change what the request gets: RTI says benign without ids, and the reload has a valid mark for its page; the line fails, the error is logged, and the request is forwarded with x-cheq-rti-result', async () => {
        // Arrange
        expectError = true;
        const { worker } = await loadWorker();
        const mark = await markFromPage(worker);
        // The reload line reads ids.rayId, so it throws without ids. x-cheq-rti-result does not need them.
        mocks.callRTI.mockResolvedValue({ ...rtiAnswer(true, { verdict: 'benign' }), ids: undefined });

        // Act
        const result = await run(worker, reload(mark));

        // Assert
        await expectForwardedWithVerdict(result, 'benign');
        expect(mocks.loggerError).toHaveBeenCalledOnce();
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringMatching(/^Interstitial error handling request 'ray-cf2': /));
        expect(consoleError).toHaveBeenCalledWith("Interstitial error handling request 'ray-cf2':", expect.any(TypeError));
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN]]);
    });

    it('the reload line cannot change what the request gets where the interstitial\'s decision gives it: RTI says suspicious without ids, sessionFound true, onSecondVerdict BLOCK, and the reload has a valid mark for its page; the line fails, the error is logged once, and the request gets the 403 block page', async () => {
        // Arrange
        expectError = true;
        const { worker } = await loadWorker(interstitial({ onSecondVerdict: Action.BLOCK }));
        const mark = await markFromPage(worker);
        // The reload line reads ids.rayId, so it throws without ids. The block page does not need them.
        mocks.callRTI.mockResolvedValue({ ...rtiAnswer(true), ids: undefined });

        // Act
        const { response, originFetch } = await run(worker, reload(mark));

        // Assert
        expect(response.status).toBe(403);
        expect(await response.text()).toContain('<title>403 Access Denied</title>');
        expect(originFetch).not.toHaveBeenCalled();
        expect(mocks.loggerError).toHaveBeenCalledOnce();
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringMatching(/^Interstitial error handling request 'ray-cf2': /));
        expect(consoleError).toHaveBeenCalledOnce();
        expect(consoleError).toHaveBeenCalledWith("Interstitial error handling request 'ray-cf2':", expect.any(TypeError));
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN]]);
    });

    it('the shown line cannot change what the request gets: RTI\'s reasons are text, not a list, so the line fails; the error is logged once, and the page load still gets the interstitial page', async () => {
        // Arrange
        expectError = true;
        const answer = rtiAnswer(null);
        // The shown line joins the reasons, so it throws when they are not a list. The page does not read them.
        mocks.callRTI.mockResolvedValue({ ...answer, cheqDetection: { ...answer.cheqDetection, reasons: '4,7' } });
        const { worker } = await loadWorker();

        // Act
        const { response, originFetch } = await run(worker, pageLoad());

        // Assert
        await expectInterstitialPage(response);
        expect(originFetch).not.toHaveBeenCalled();
        expect(mocks.loggerError).toHaveBeenCalledOnce();
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringMatching(/^Interstitial error handling request 'ray-cf': /));
        expect(consoleError).toHaveBeenCalledOnce();
        expect(consoleError).toHaveBeenCalledWith("Interstitial error handling request 'ray-cf':", expect.any(TypeError));
        expect(mocks.loggerInfo).not.toHaveBeenCalled();
    });

    it.each([
        ['suspicious', 'suspicious' as const],
        // RTI's action is ALLOW: the action alone would give the reload line ("passed"), but a HEAD is not a page load.
        ['benign', 'benign' as const],
    ])('row 10: the reload as a HEAD, sessionFound true, RTI %s: forwarded with the verdict; RTI gets customId3 (the mark counts for its page on any request); no reload line', async (_label, verdict) => {
        // Arrange
        const { worker } = await loadWorker();
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(true, { rayId: 'ray-2', verdict }));

        // Act
        const result = await run(worker, reload(mark, {}, PAGE_URL, 'HEAD'));

        // Assert
        await expectForwardedWithVerdict(result, verdict);
        expect(result.forwarded!.method).toBe('HEAD');
        expect(rtiPayload(1).customId3).toBe('interstitial:ray-1');
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN]]);
    });

    it('row 11: onSecondVerdict CHALLENGE, sessionFound true: config.challenge gets the copy with the mark\'s original Referer, not the client\'s own x-cheq-original-referer; RTI got the mark\'s value too', async () => {
        // Arrange
        const challenge = captchaPage();
        const { worker } = await loadWorker({ challenge, ...interstitial({ onSecondVerdict: Action.CHALLENGE }) });
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(true, { rayId: 'ray-2' }));
        // The client's own x-cheq-original-referer: the handler removes it from the copy before it reads the mark.
        const request = reload(mark, { 'x-cheq-original-referer': 'https://evil.example/' });

        // Act
        const { response, originFetch } = await run(worker, request);

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        const challenged = challenge.mock.calls[0][0];
        expect(challenged).not.toBe(request);
        expect(challenged.headers.get('x-cheq-original-referer')).toBe('https://www.google.com/');
        expect(request.headers.get('x-cheq-original-referer')).toBe('https://evil.example/');
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBe('https://www.google.com/');
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN], [reloadLine('second-verdict:CHALLENGE', true)]]);
    });

    it('row 12: the page, then the CAPTCHA (the Turnstile example, onSecondVerdict CHALLENGE): the reload gets the CAPTCHA page with the mark\'s original Referer, the solved reply a 302 with _cq_se and _cq_rf, and the landing request is forwarded with x-cheq-original-referer https://www.google.com/', async () => {
        // Arrange
        const { worker } = await loadWorker({
            ...createTurnstileChallenge({ siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'signing-secret', sessionTtlSeconds: 300 }),
            ...interstitial({ onSecondVerdict: Action.CHALLENGE }),
        });
        // Sends a request through the Worker. siteverify accepts every token, as in index.integration.spec.ts; every
        // other fetch is the origin.
        const send = async (request: Request) => {
            const originFetch = vi.fn(async (_request: Request) => new Response('origin'));
            vi.stubGlobal('fetch', vi.fn(async (input: Request | string) => input === 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
                ? new Response(JSON.stringify({ success: true, hostname: 'example.com', action: 'cheq-challenge' }))
                : originFetch(input as Request)));
            const response = await worker.fetch(request, {}, { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
            return { response, originFetch, forwarded: originFetch.mock.calls[0]?.[0] };
        };
        const mark = await markFromPage(worker);

        // Act 1: the reload. RTI finds the tag's session and says suspicious again
        mocks.callRTI.mockResolvedValueOnce(rtiAnswer(true, { rayId: 'ray-2' }));
        const captcha = await send(reload(mark));

        // Assert 1: the CAPTCHA page carries the original Referer from the mark
        expect(captcha.response.status).toBe(403);
        const html = await captcha.response.text();
        expect(html).toContain('name="original_url" value="/sofas?gclid=abc"');
        expect(html).toContain('name="original_referer" value="https://www.google.com/"');
        expect(captcha.originFetch).not.toHaveBeenCalled();

        // Act 2: the solved form comes back as a GET, with the page's fields and the token
        mocks.callRTI.mockResolvedValueOnce(rtiAnswer(true, { rayId: 'ray-3' }));
        const query = new URLSearchParams({
            original_url: '/sofas?gclid=abc', request_id: 'ray-2', original_referer: 'https://www.google.com/', 'cf-turnstile-response': 'tok',
        }).toString();
        const reply = await send(reload(mark, { 'cf-ray': 'ray-cf3' }, `https://example.com/sofas?${query}`));

        // Assert 2
        expect(reply.response.status).toBe(302);
        expect(reply.response.headers.get('location')).toBe(PAGE_URL);
        const setCookies = reply.response.headers.getSetCookie();
        expect(setCookies.map((cookie) => cookie.split('=')[0])).toEqual(['_cq_se', '_cq_rf']);
        expect(reply.originFetch).not.toHaveBeenCalled();

        // Act 3: the landing request, with the cookies of the 302. RTI has the tag's session and says suspicious again
        mocks.callRTI.mockResolvedValueOnce(rtiAnswer(true, { rayId: 'ray-4' }));
        const cookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
        const landing = await send(reload(mark, { 'cf-ray': 'ray-cf4', cookie: `_cq_duid=d1; _cq_s=s1; _cq_pvid=pv2; _cq_it=${mark}; ${cookies}` }));

        // Assert 3: the session waives the CAPTCHA, and the origin gets the verdict and the original Referer
        expect(landing.originFetch).toHaveBeenCalledOnce();
        expect(landing.forwarded!.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
        expect(landing.forwarded!.headers.get('x-cheq-original-referer')).toBe('https://www.google.com/');
    });

    it('row 13: with the interstitial off, a request with a _cq_it cookie is handled as before this work (config.challenge gets it), and crypto.subtle.sign is not called', async () => {
        // Arrange
        const challenge = captchaPage();
        const { worker } = await loadWorker({ challenge, interstitial: { enabled: false, tag: CONSOLE_LINE } });
        const sign = vi.spyOn(crypto.subtle, 'sign');
        // A value written the way the page writes a mark.
        const request = pageLoad({ cookie: '_cq_it=0123abcd|9999999999999.0123456789abcdef0123456789abcdef|ray-1|0123456789abcdef|' });

        // Act
        const { response, originFetch } = await run(worker, request);

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        expect(challenge.mock.calls[0][0].url).toBe(request.url);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
        expect(sign).not.toHaveBeenCalled();
        expect(rtiPayload(0).customId3).toBeUndefined();
    });

    it('row 14: a page load with a forged mark (another signature), suspicious: the interstitial page, and no line about the mark', async () => {
        // Arrange
        const { worker } = await loadWorker();
        const mark = await markFromPage(worker);
        const forged = mark.replace(/\.[0-9a-f]{32}\|/, `.${'0'.repeat(32)}|`);
        mocks.callRTI.mockResolvedValue(rtiAnswer(null, { rayId: 'ray-2' }));

        // Act
        const { response } = await run(worker, pageLoad({ 'cf-ray': 'ray-cf2', cookie: `_cq_it=${forged}` }));

        // Assert
        expect(forged).not.toBe(mark);
        await expectInterstitialPage(response, 403, 'ray-2');
        expect(rtiPayload(1).customId3).toBeUndefined();
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN], [SHOWN_AGAIN]]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    // What a client can write: text that is not a mark, and a real mark with %ED%A0%80 as its ray id (half of a UTF-16
    // surrogate pair, which decodeURIComponent cannot decode).
    const notAMark = () => '1.a|%|a|%';
    const undecodable = (mark: string) => mark.split('|').map((part, i) => (i === 2 ? '%ED%A0%80' : part)).join('|');
    it.each([
        ['1.a|%|a|%', 'suspicious', 'the interstitial page', notAMark, (result: RunResult) => expectInterstitialPage(result.response, 403, 'ray-2')],
        ['1.a|%|a|%', 'benign', 'forwarded with x-cheq-rti-result', notAMark, (result: RunResult) => expectForwardedWithVerdict(result, 'benign')],
        ['a mark with %ED%A0%80 as its ray id', 'suspicious', 'the interstitial page', undecodable, (result: RunResult) => expectInterstitialPage(result.response, 403, 'ray-2')],
        ['a mark with %ED%A0%80 as its ray id', 'benign', 'forwarded with x-cheq-rti-result', undecodable, (result: RunResult) => expectForwardedWithVerdict(result, 'benign')],
    ] as const)('row 15: _cq_it=%s is no mark, and RTI is called; RTI %s: %s', async (_label, verdict, _answer, cookieValue, expectAnswer) => {
        // Arrange
        const { worker } = await loadWorker();
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(null, { rayId: 'ray-2', verdict }));

        // Act
        const result = await run(worker, reload(cookieValue(mark)));

        // Assert
        expect(mocks.callRTI).toHaveBeenCalledTimes(2);
        expect(rtiPayload(1).customId3).toBeUndefined();
        await expectAnswer(result);
    });

    it('row 16: when crypto.subtle.sign rejects while the mark is read, the error is logged, RTI is called, and the request is handled as one without a mark', async () => {
        // Arrange
        expectError = true;
        const { worker } = await loadWorker();
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(false, { rayId: 'ray-2' }));
        vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(new Error('sign failed'));

        // Act
        const { response } = await run(worker, reload(mark));

        // Assert: without a mark, sessionFound false gives the page again (with the mark: the no-session action)
        expect(mocks.loggerError).toHaveBeenCalledOnce();
        expect(mocks.loggerError).toHaveBeenCalledWith("Interstitial error handling request 'ray-cf2': sign failed");
        expect(consoleError).toHaveBeenCalledWith("Interstitial error handling request 'ray-cf2':", expect.objectContaining({ message: 'sign failed' }));
        expect(mocks.callRTI).toHaveBeenCalledTimes(2);
        expect(rtiPayload(1).customId3).toBeUndefined();
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBeUndefined();
        await expectInterstitialPage(response, 403, 'ray-2');
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN], [SHOWN_AGAIN]]);
    });

    it.each([
        ['benign', rtiAnswer(true, { rayId: 'ray-2', verdict: 'benign' })],
        ['suspicious', rtiAnswer(true, { rayId: 'ray-2' })],
    ])('row 17: a reply to the CAPTCHA with a valid mark for its page, RTI %s: config.challenge answers it before the switch, and no reload line is sent', async (_label, answer) => {
        // Arrange
        const challenge = captchaPage();
        const isChallengeResponse = (request: Request) => new URL(request.url).searchParams.has('cf-turnstile-response');
        const { worker } = await loadWorker({ challenge, isChallengeResponse });
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(answer);
        const reply = reload(mark, {}, 'https://example.com/sofas?original_url=%2Fsofas%3Fgclid%3Dabc&cf-turnstile-response=tok');

        // Act
        const { response, originFetch } = await run(worker, reply);

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        expect(challenge.mock.calls[0][0].url).toBe(reply.url);
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN]]);
    });

    it('row 18: the mark on https://www.example.com/sofas?gclid=abc (the origin sent the reload to the www host; the design says that the mark, written for the main domain, goes along), Referer https://example.com/sofas?gclid=abc, sessionFound false: forwarded, no interstitial; the same path counts as the mark\'s page, so customId3 and a reload line are sent again; no original Referer (its Referer is the page on another host)', async () => {
        // Arrange
        const { worker } = await loadWorker();
        const mark = await markFromPage(worker);

        // Act: the reload on example.com, which the origin answers with a redirect to the www host; then that request
        mocks.callRTI.mockResolvedValueOnce(rtiAnswer(false, { rayId: 'ray-2' }));
        await run(worker, reload(mark));
        mocks.callRTI.mockResolvedValueOnce(rtiAnswer(false, { rayId: 'ray-3' }));
        const result = await run(worker, reload(mark, { 'cf-ray': 'ray-cf3' }, 'https://www.example.com/sofas?gclid=abc'));

        // Assert
        await expectForwardedWithVerdict(result);
        expect(result.forwarded!.headers.get('x-cheq-original-referer')).toBeNull();
        expect(rtiPayload(2).customId3).toBe('interstitial:ray-1');
        expect(rtiPayload(2).endUserParams.headers!['x-cheq-original-referer']).toBeUndefined();
        expect(mocks.loggerInfo.mock.calls).toEqual([
            [SHOWN],
            [reloadLine('no-session:ALLOW', false)],
            [reloadLine('no-session:ALLOW', false, { rayId: 'ray-3', request: 'ray-cf3' })],
        ]);
    });

    it('row 19: the reload as a prefetch (Sec-Purpose: prefetch), sessionFound false: the no-session action, as a visit gets: forwarded with the verdict; no empty 403, no reload line', async () => {
        // Arrange
        const { worker } = await loadWorker();
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(false, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark, { 'Sec-Purpose': 'prefetch' }));

        // Assert
        await expectForwardedWithVerdict(result);
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN]]);
    });

    it('in MONITORING mode, the reload with a valid mark for its page: forwarded with the verdict; RTI gets customId3; no would-show line (BLOCKING mode would not show the page) and no reload line', async () => {
        // Arrange: a mark from a page in BLOCKING mode, then the reload in MONITORING mode (the same apiKey)
        const blocking = await loadWorker();
        const mark = await markFromPage(blocking.worker);
        const { worker } = await loadWorker({ mode: Mode.MONITORING });
        mocks.callRTI.mockResolvedValue(rtiAnswer(false, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark));

        // Assert
        await expectForwardedWithVerdict(result);
        expect(rtiPayload(1).customId3).toBe('interstitial:ray-1');
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN]]);
    });

    it('in "cookie" mode, the reload: forwarded without x-cheq-original-referer, to RTI and to the origin; RTI gets customId3', async () => {
        // Arrange
        const { worker } = await loadWorker(interstitial({ originalRefererVia: 'cookie' }));
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(true, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark));

        // Assert
        await expectForwardedWithVerdict(result);
        expect(result.forwarded!.headers.get('x-cheq-original-referer')).toBeNull();
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBeUndefined();
        expect(rtiPayload(1).customId3).toBe('interstitial:ray-1');
    });
});

// "cookie" mode: the Worker keeps the mark's original Referer for a CAPTCHA on the request. RTI and the origin do not
// get it as x-cheq-original-referer. Each test serves the page first (RTI call 1: ray-1), takes the mark from the page,
// and sends the reload (RTI call 2: ray-2).
describe('"cookie" mode (originalRefererVia "cookie")', () => {
    // The base config's interstitial block in "cookie" mode, with `settings` over it.
    const cookieMode = (settings: Record<string, unknown> = {}) => interstitial({ originalRefererVia: 'cookie', ...settings });

    // A config.challenge that answers with its own page. It notes the x-cheq-original-referer of each request it gets
    // during the call: the header comes off the copy after the call.
    const captchaPageNotingReferer = () => {
        const referers: (string | null)[] = [];
        const challenge = vi.fn<NonNullable<CloudflareConfig['challenge']>>(async (request) => {
            referers.push(request.headers.get('x-cheq-original-referer'));
            return new Response('<html>captcha</html>', { status: 403 });
        });
        return { challenge, referers };
    };

    // The hidden fields of the CAPTCHA page's form, for the solved reply that a test sends. The values in these tests have
    // no character that the page escapes.
    const formFields = (html: string) =>
        new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, name, value]) => [name, value]));

    it('row 1: the reload, sessionFound false: forwarded with the verdict; no x-cheq-original-referer reaches RTI or the origin', async () => {
        // Arrange
        const { worker } = await loadWorker(cookieMode());
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(false, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark));

        // Assert
        await expectForwardedWithVerdict(result);
        expect(result.forwarded!.headers.get('x-cheq-original-referer')).toBeNull();
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBeUndefined();
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN], [reloadLine('no-session:ALLOW', false)]]);
    });

    it('row 2: onSessionNotFound CHALLENGE, the reload, sessionFound false: config.challenge gets the copy with x-cheq-original-referer https://www.google.com/ during the call, and its page is the answer; RTI gets none, and the header is off the copy after the call', async () => {
        // Arrange
        const { challenge, referers } = captchaPageNotingReferer();
        const { worker } = await loadWorker({ challenge, ...cookieMode({ onSessionNotFound: Action.CHALLENGE }) });
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(false, { rayId: 'ray-2' }));
        const request = reload(mark);

        // Act
        const { response, originFetch } = await run(worker, request);

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        const challenged = challenge.mock.calls[0][0];
        expect(challenged).not.toBe(request);
        expect(challenged.url).toBe(request.url);
        expect(referers).toEqual(['https://www.google.com/']);
        expect(challenged.headers.get('x-cheq-original-referer')).toBeNull();
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBeUndefined();
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN], [reloadLine('no-session:CHALLENGE', false)]]);
    });

    it.each([
        ['returns its request', async (request: Request) => request, []],
        ['returns new Request(request.url, request)', async (request: Request) => new Request(request.url, request), []],
        ['throws', async (_request: Request): Promise<Request> => { throw new Error('challenge failed'); },
            ["Challenge error handling request 'ray-cf2': challenge failed"]],
    ])('row 3: as row 2, with a config.challenge that %s: it was called, and the request forwarded has no x-cheq-original-referer (Review Focus 5)', async (_label, answer, errors) => {
        // Arrange
        expectError = errors.length > 0;
        const challenge = vi.fn<NonNullable<CloudflareConfig['challenge']>>(answer);
        const { worker } = await loadWorker({ challenge, ...cookieMode({ onSessionNotFound: Action.CHALLENGE }) });
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(false, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark));

        // Assert
        expect(challenge).toHaveBeenCalledOnce();
        expect(result.originFetch).toHaveBeenCalledOnce();
        expect(result.forwarded!.url).toBe(PAGE_URL);
        expect(result.forwarded!.headers.get('x-cheq-original-referer')).toBeNull();
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBeUndefined();
        expect(mocks.loggerError.mock.calls).toEqual(errors.map((error) => [error]));
    });

    it('row 4: the page, then the CAPTCHA (the Turnstile example, onSecondVerdict CHALLENGE), both with originalRefererVia "cookie": the CAPTCHA page carries the mark\'s original Referer, and the solved reply\'s 302 sets _cq_ref with it; no request to RTI or the origin carries x-cheq-original-referer', async () => {
        // Arrange
        const { worker } = await loadWorker({
            ...createTurnstileChallenge({ siteKey: 'site-key', secretKey: 'turnstile-secret', sessionSigningSecret: 'signing-secret', sessionTtlSeconds: 300, originalRefererVia: 'cookie' }),
            ...cookieMode({ onSecondVerdict: Action.CHALLENGE }),
        });
        // Sends a request through the Worker. siteverify accepts every token, as in index.integration.spec.ts; every
        // other fetch is the origin, noted in originFetch for the whole test.
        const originFetch = vi.fn(async (_request: Request) => new Response('origin'));
        const send = (request: Request) => {
            vi.stubGlobal('fetch', vi.fn(async (input: Request | string) => input === 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
                ? new Response(JSON.stringify({ success: true, hostname: 'example.com', action: 'cheq-challenge' }))
                : originFetch(input as Request)));
            return worker.fetch(request, {}, { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
        };
        const mark = await markFromPage(worker);

        // Act 1: the reload. RTI finds the tag's session and says suspicious again
        mocks.callRTI.mockResolvedValueOnce(rtiAnswer(true, { rayId: 'ray-2' }));
        const captcha = await send(reload(mark));

        // Assert 1: the CAPTCHA page carries the original Referer from the mark
        expect(captcha.status).toBe(403);
        const html = await captcha.text();
        expect(html).toContain('name="original_referer" value="https://www.google.com/"');

        // Act 2: the solved form comes back as a GET, with the page's fields and the token
        mocks.callRTI.mockResolvedValueOnce(rtiAnswer(true, { rayId: 'ray-3' }));
        const fields = formFields(html);
        fields.set('cf-turnstile-response', 'tok');
        const reply = await send(reload(mark, { 'cf-ray': 'ray-cf3' }, `https://example.com/sofas?${fields}`));

        // Assert 2: the 302 sets _cq_se and _cq_ref; the part of _cq_ref after the "|" is the original Referer
        expect(reply.status).toBe(302);
        expect(reply.headers.get('location')).toBe(PAGE_URL);
        const setCookies = reply.headers.getSetCookie();
        expect(setCookies.map((cookie) => cookie.split('=')[0])).toEqual(['_cq_se', '_cq_ref']);
        const refCookieValue = setCookies[1].split(';')[0].slice('_cq_ref='.length);
        expect(decodeURIComponent(refCookieValue.split('|')[1])).toBe('https://www.google.com/');

        // Act 3: the landing request, with the cookies of the 302. RTI has the tag's session and says suspicious again
        mocks.callRTI.mockResolvedValueOnce(rtiAnswer(true, { rayId: 'ray-4' }));
        const cookies = setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
        const landing = await send(reload(mark, { 'cf-ray': 'ray-cf4', cookie: `_cq_duid=d1; _cq_s=s1; _cq_pvid=pv2; _cq_it=${mark}; ${cookies}` }));

        // Assert 3: the session waives the CAPTCHA, and the origin gets the verdict. Only the landing request reached the
        // origin, and neither it nor any RTI call carried x-cheq-original-referer
        expect(await landing.text()).toBe('origin');
        expect(originFetch).toHaveBeenCalledOnce();
        const forwarded = originFetch.mock.calls[0][0];
        expect(forwarded.headers.get('x-cheq-rti-result')).toContain('verdict=suspicious');
        expect(forwarded.headers.get('x-cheq-original-referer')).toBeNull();
        const rtiReferers = mocks.callRTI.mock.calls.map(([payload]) => (payload as RTIRequest).endUserParams.headers!['x-cheq-original-referer']);
        expect(rtiReferers).toEqual([undefined, undefined, undefined, undefined]);
    });

    it('a block verdict shown as a CAPTCHA (blockingStrategy CAPTCHA) on the reload: config.challenge gets the copy with the mark\'s original Referer during the call; RTI and the origin get none', async () => {
        // Arrange
        const { challenge, referers } = captchaPageNotingReferer();
        const { worker } = await loadWorker({ challenge, blockingStrategy: ActionStrategy.CAPTCHA, ...cookieMode() });
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(true, { rayId: 'ray-2', verdict: 'malicious' }));

        // Act
        const { response, originFetch } = await run(worker, reload(mark));

        // Assert
        expect(referers).toEqual(['https://www.google.com/']);
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBeUndefined();
        expect(await response.text()).toBe('<html>captcha</html>');
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('a config.originalReferer that gives https://partner.example/ on the reload (the CAPTCHA in "header" mode) wins over the mark: config.challenge gets that value, the request it returns keeps it, and RTI gets it', async () => {
        // Arrange: nothing for the page load, so the mark carries the Referer from Google; then https://partner.example/
        const originalReferer = vi.fn<NonNullable<CloudflareConfig['originalReferer']>>().mockReturnValueOnce(undefined).mockReturnValue('https://partner.example/');
        const referers: (string | null)[] = [];
        const challenge = vi.fn<NonNullable<CloudflareConfig['challenge']>>(async (request) => {
            referers.push(request.headers.get('x-cheq-original-referer'));
            return request;
        });
        const { worker } = await loadWorker({ originalReferer, challenge, ...cookieMode({ onSessionNotFound: Action.CHALLENGE }) });
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(false, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark));

        // Assert
        expect(referers).toEqual(['https://partner.example/']);
        expect(result.forwarded!.headers.get('x-cheq-original-referer')).toBe('https://partner.example/');
        expect(rtiPayload(1).endUserParams.headers!['x-cheq-original-referer']).toBe('https://partner.example/');
    });

    it('the page gets the kept Referer as carriedReferer when the copy has no x-cheq-original-referer (decide shows the page only without a valid mark, so a spy makes it answer "show" for the reload)', async () => {
        // Arrange
        const { worker, InterstitialService } = await loadWorker(cookieMode());
        const mark = await markFromPage(worker);
        vi.spyOn(InterstitialService.prototype, 'decide').mockReturnValue({ kind: 'show' });
        const page = vi.spyOn(InterstitialService.prototype, 'page');
        mocks.callRTI.mockResolvedValue(rtiAnswer(false, { rayId: 'ray-2' }));

        // Act
        const { response } = await run(worker, reload(mark));

        // Assert
        await expectInterstitialPage(response, 403, 'ray-2');
        expect(page).toHaveBeenCalledOnce();
        expect(page.mock.calls[0][1]).toBe('ray-2');
        expect(page.mock.calls[0][2]).toBe('https://www.google.com/');
    });
});

// What the browser may keep of the origin's answer (keepOutOfBrowserCache in fetch; the owner's decision of 2026-11-24).
// In BLOCKING mode, when RTI wanted a request challenged or blocked and the Worker forwards it with the verdict, the
// origin's HTML answer gets no-store, unless a valid CAPTCHA pass let the request through: a page that the browser keeps
// could be shown later without asking the Worker. A benign verdict, MONITORING mode and a valid pass keep the origin's
// caching headers.
describe('what the browser may keep of an answer forwarded while the interstitial is on', () => {
    // The origin's answer: an HTML page with its own Cache-Control. Its text is "origin", as expectForwardedWithVerdict
    // checks.
    const originPage = async () => new Response('origin', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=600' } });
    const NO_STORE = 'no-store, no-cache, must-revalidate';

    it('a suspicious GET that is not a page load (Sec-Fetch-Dest: empty), no rule, GET: Action.ALLOW: forwarded with the verdict, and the origin\'s HTML answer gets no-store', async () => {
        // Arrange
        const { worker } = await loadWorker({ actionOnSuspicious: { methods: { GET: Action.ALLOW } } });

        // Act
        const result = await run(worker, pageLoad({ 'Sec-Fetch-Dest': 'empty' }), originPage);

        // Assert
        await expectForwardedWithVerdict(result);
        expect(result.response.headers.get('cache-control')).toBe(NO_STORE);
    });

    it.each([
        ['sessionFound true, onSecondVerdict ALLOW', true, interstitial({ onSecondVerdict: Action.ALLOW }), 'second-verdict:ALLOW'],
        ['sessionFound false, onSessionNotFound ALLOW', false, interstitial({ onSessionNotFound: Action.ALLOW }), 'no-session:ALLOW'],
    ])('the reload with a valid mark for its page, %s: forwarded with the verdict, and the origin\'s HTML answer gets no-store', async (_label, sessionFound, config, outcome) => {
        // Arrange
        const { worker } = await loadWorker(config);
        const mark = await markFromPage(worker);
        mocks.callRTI.mockResolvedValue(rtiAnswer(sessionFound, { rayId: 'ray-2' }));

        // Act
        const result = await run(worker, reload(mark), originPage);

        // Assert: the reload line shows that the mark was valid for its page, and which setting let the request through
        await expectForwardedWithVerdict(result);
        expect(result.response.headers.get('cache-control')).toBe(NO_STORE);
        expect(mocks.loggerInfo.mock.calls).toEqual([[SHOWN], [reloadLine(outcome, sessionFound)]]);
    });

    it('sessionFound true, onSecondVerdict CHALLENGE, no config.challenge: forwarded with the verdict, and the origin\'s HTML answer gets no-store', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const { worker } = await loadWorker(interstitial({ onSecondVerdict: Action.CHALLENGE }));

        // Act
        const result = await run(worker, pageLoad(), originPage);

        // Assert
        await expectForwardedWithVerdict(result);
        expect(result.response.headers.get('cache-control')).toBe(NO_STORE);
    });

    it('the forward outcome of decide (a GET that is not a page load gets the strategy INTERSTITIAL, which only a spy gives): forwarded with the verdict, and the origin\'s HTML answer gets no-store', async () => {
        // Arrange
        const { worker, InterstitialService } = await loadWorker();
        const { RTIHelperService } = await import('../../core/services/rti-helper.service');
        vi.spyOn(RTIHelperService.prototype, 'getStrategyForRequest').mockReturnValue({ strategy: ActionStrategy.INTERSTITIAL });
        const decide = vi.spyOn(InterstitialService.prototype, 'decide');

        // Act
        const result = await run(worker, pageLoad({ 'Sec-Fetch-Dest': 'empty' }), originPage);

        // Assert
        expect(decide).toHaveReturnedWith({ kind: 'forward', reason: 'not-a-page-load' });
        await expectForwardedWithVerdict(result);
        expect(result.response.headers.get('cache-control')).toBe(NO_STORE);
    });

    it('an error in the interstitial\'s code (crypto.subtle.sign rejects once, so the page cannot be built): forwarded with the verdict, and the origin\'s HTML answer gets no-store', async () => {
        // Arrange
        expectError = true;
        const { worker } = await loadWorker();
        vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(new Error('sign failed'));

        // Act
        const result = await run(worker, pageLoad(), originPage);

        // Assert
        expect(mocks.loggerError).toHaveBeenCalledWith("Interstitial error handling request 'ray-cf': sign failed");
        await expectForwardedWithVerdict(result);
        expect(result.response.headers.get('cache-control')).toBe(NO_STORE);
    });

    it('sessionFound true, onSecondVerdict CHALLENGE, a valid CAPTCHA pass (validateChallenge gives true): forwarded with the verdict, and the origin\'s HTML answer keeps its Cache-Control: max-age=600', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const challenge = captchaPage();
        const validateChallenge = vi.fn(async () => true);
        const { worker } = await loadWorker({ challenge, validateChallenge, ...interstitial({ onSecondVerdict: Action.CHALLENGE }) });

        // Act
        const result = await run(worker, pageLoad(), originPage);

        // Assert
        expect(validateChallenge).toHaveBeenCalledOnce();
        expect(challenge).not.toHaveBeenCalled();
        await expectForwardedWithVerdict(result);
        expect(result.response.headers.get('cache-control')).toBe('max-age=600');
    });

    it.each([
        ['MONITORING mode, a suspicious page load', { mode: Mode.MONITORING }, () => rtiAnswer(null), 'suspicious'],
        ['a benign verdict on a page load', {}, () => rtiAnswer(null, { verdict: 'benign' }), 'benign'],
    ])('%s: forwarded with the verdict, and the origin\'s HTML answer keeps its Cache-Control: max-age=600', async (_label, config, answer, verdict) => {
        // Arrange
        mocks.callRTI.mockResolvedValue(answer());
        const { worker } = await loadWorker(config);

        // Act
        const result = await run(worker, pageLoad(), originPage);

        // Assert
        await expectForwardedWithVerdict(result, verdict);
        expect(result.response.headers.get('cache-control')).toBe('max-age=600');
    });

    it('a block shown as the CAPTCHA (blockingStrategy CAPTCHA) with a valid CAPTCHA pass: forwarded with the verdict, and the origin\'s HTML answer keeps its Cache-Control: max-age=600', async () => {
        // Arrange
        mocks.callRTI.mockResolvedValue(rtiAnswer(null, { verdict: 'malicious' }));
        const challenge = captchaPage();
        const validateChallenge = vi.fn(async () => true);
        const { worker } = await loadWorker({ challenge, validateChallenge, blockingStrategy: ActionStrategy.CAPTCHA });

        // Act
        const result = await run(worker, pageLoad(), originPage);

        // Assert
        expect(validateChallenge).toHaveBeenCalledOnce();
        expect(challenge).not.toHaveBeenCalled();
        await expectForwardedWithVerdict(result, 'malicious');
        expect(result.response.headers.get('cache-control')).toBe('max-age=600');
    });

    it('validateChallenge throws (the CAPTCHA case fails open): forwarded without the verdict, and the origin\'s HTML answer keeps its Cache-Control: max-age=600', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockResolvedValue(rtiAnswer(true));
        const challenge = captchaPage();
        const { worker } = await loadWorker({ challenge, validateChallenge: vi.fn(async () => { throw new Error('vc'); }), ...interstitial({ onSecondVerdict: Action.CHALLENGE }) });

        // Act
        const result = await run(worker, pageLoad(), originPage);

        // Assert
        expect(result.forwarded!.headers.get('x-cheq-rti-result')).toBeNull();
        expect(result.response.headers.get('cache-control')).toBe('max-age=600');
    });

    it('RTI rejects (handle fails open): forwarded without the verdict, and the origin\'s HTML answer keeps its Cache-Control: max-age=600', async () => {
        // Arrange
        expectError = true;
        mocks.callRTI.mockRejectedValue(new Error('rti down'));
        const { worker } = await loadWorker();

        // Act
        const result = await run(worker, pageLoad(), originPage);

        // Assert
        expect(result.forwarded!.headers.get('x-cheq-rti-result')).toBeNull();
        expect(result.response.headers.get('cache-control')).toBe('max-age=600');
    });
});
