// The block page in the Worker: a request that RTI wants blocked gets the page, with the settings of config.blockPage.
// RTI (callRTI) and the RTI logger are mocks, so nothing reaches CHEQ's services. The config and the origin's
// fetch are mocks too. The block page is core's real one.
// index reads config.blockPage once, when it loads, so each test loads a fresh copy of index against its own config.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { Mode } from '../../core/models/mode.model';
import { ActionStrategy } from '../../core/models/action-strategy.model';
import { buildRTIResponse } from '../../core/testing/rti-response.fixture';
import { PAGE_FOOTER } from '../../core/helpers/page-look';

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

// The four settings of the block page, all valid.
const SETTINGS = { logoUrl: 'https://cdn.example/l.svg', headline: 'Stop', message: 'Not for you.', lang: 'de' };

// A fresh copy of index, loaded in BLOCKING mode with `config` over the base config.
const loadWorker = async (config: Record<string, unknown> = {}): Promise<Worker> => {
    vi.resetModules();
    vi.doMock('./config', () => ({ config: { mode: Mode.BLOCKING, apiKey: 'k', tagHash: 't', ...config } }));
    return (await import('./index')).default;
};

// A page load: a browser asks for a page. `cfRay` is the cf-ray header, which the Worker hands to the page as the
// Additional Platform ID.
const pageLoad = (cfRay = 'ray-cf') => new Request('https://example.com/page', {
    headers: { 'Sec-Fetch-Dest': 'document', 'cf-ray': cfRay, 'user-agent': 'e2e-browser' },
});

// RTI's answer: malicious, so in BLOCKING mode the request is blocked. `rayId` is RTI's id of the request.
const malicious = (rayId = 'ray-1') => buildRTIResponse({ verdict: 'malicious', rayId });

// Sends a request through the Worker. The origin's fetch is a mock: a blocked request does not reach it.
async function run(worker: Worker, request: Request) {
    const originFetch = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('origin'));
    vi.stubGlobal('fetch', originFetch);
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const response = await worker.fetch(request, {}, ctx);
    return { response, originFetch };
}

// The first load of the module graph is slow (seconds on a busy machine): it happens here, with a long timeout, not in
// the 5 s of a test, so each test only loads index again. The module registry and the mocks are left clean for the tests.
beforeAll(async () => {
    await loadWorker();
    vi.doUnmock('./config');
    vi.resetModules();
}, 60_000);

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.clearAllMocks();
    // Also drops an answer for one call that a failed test did not use.
    mocks.callRTI.mockReset();
    mocks.callRTI.mockResolvedValue(malicious());
    // The cold-start warnings are tested in index.startup.spec.ts: kept out of the output here.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    try {
        // A block logs no error.
        expect(consoleError).not.toHaveBeenCalled();
        expect(mocks.loggerError).not.toHaveBeenCalled();
    } finally {
        // Also when the guard fails: spies, stubs and the config mock must not leak into the next test.
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.doUnmock('./config');
        vi.resetModules();
    }
});

describe('the block page in BLOCKING mode, for a request that RTI says is malicious', () => {
    it.each([
        ['no blockPage', {}],
        ['blockPage "x", which is not a settings block', { blockPage: 'x' }],
        ['blockPage with an empty headline and a lang that is not a language tag', { blockPage: { headline: '', lang: 'english' } }],
    ])('%s: the default page, with status 403 and not to be stored', async (_, config) => {
        // Arrange
        const worker = await loadWorker(config);

        // Act
        const { response, originFetch } = await run(worker, pageLoad());

        // Assert
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
        const body = await response.text();
        expect(body).toContain('<html lang="en">');
        expect(body).toContain('<h1>Access Denied</h1>');
        expect(body).toContain('background:#fff');
        expect(body).toContain(PAGE_FOOTER);
        expect(originFetch).not.toHaveBeenCalled();
    });

    it('blockPage with its four settings: the 403 page with that language, headline, message and logo', async () => {
        // Arrange
        const worker = await loadWorker({ blockPage: SETTINGS });

        // Act
        const { response } = await run(worker, pageLoad());

        // Assert
        expect(response.status).toBe(403);
        const body = await response.text();
        expect(body).toContain('<html lang="de">');
        expect(body).toContain('<h1>Stop</h1>');
        expect(body).toContain('Not for you.');
        expect(body).toContain('<img src="https://cdn.example/l.svg" alt="">');
    });

    it('blockPage with blockingStrategy NOT_FOUND: the 404 page with the headline', async () => {
        // Arrange
        const worker = await loadWorker({ blockingStrategy: ActionStrategy.NOT_FOUND, blockPage: SETTINGS });

        // Act
        const { response } = await run(worker, pageLoad());

        // Assert
        expect(response.status).toBe(404);
        expect(await response.text()).toContain('<h1>Stop</h1>');
    });

    it('two requests to one loaded Worker get pages with their own ray ids', async () => {
        // Arrange: each request gets its own RTI ray id and its own cf-ray header
        const worker = await loadWorker({ blockPage: SETTINGS });
        mocks.callRTI.mockResolvedValueOnce(malicious('rti-ray-a')).mockResolvedValueOnce(malicious('rti-ray-b'));

        // Act
        const first = await (await run(worker, pageLoad('cf-ray-a'))).response.text();
        const second = await (await run(worker, pageLoad('cf-ray-b'))).response.text();

        // Assert: both pages have the settings, and each page has only its own ids
        expect(first).toContain('<h1>Stop</h1>');
        expect(first).toContain('rti-ray-a');
        expect(first).toContain('cf-ray-a');
        expect(first).not.toContain('rti-ray-b');
        expect(first).not.toContain('cf-ray-b');
        expect(second).toContain('<h1>Stop</h1>');
        expect(second).toContain('rti-ray-b');
        expect(second).toContain('cf-ray-b');
        expect(second).not.toContain('rti-ray-a');
        expect(second).not.toContain('cf-ray-a');
    });
});
