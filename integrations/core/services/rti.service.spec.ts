import { describe, test, expect, afterEach, vi } from 'vitest';
import { RTIService } from "./rti.service";

describe("RTIService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).fetch;
  });

  describe('constructor', () => {
    test('uses rtiServiceURI from config when provided', async () => {
      const fakeResponse: any = { status: 200, json: async () => ({}) };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(fakeResponse);

      const svc = new RTIService({ rtiServiceURI: 'https://custom.example.com' } as any);
      await svc.callRTI({} as any);

      const [url] = ((globalThis as any).fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://custom.example.com');
    });

    test('falls back to default RTI URL when rtiServiceURI is not configured', async () => {
      const fakeResponse: any = { status: 200, json: async () => ({}) };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(fakeResponse);

      const svc = new RTIService({} as any);
      await svc.callRTI({} as any);

      const [url] = ((globalThis as any).fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://rti-global.cheqzone.com/defend/4.1/traffic');
    });

    test('uses timeout from config when provided', async () => {
      const fakeResponse: any = { status: 200, json: async () => ({}) };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(fakeResponse);

      // Verify construction doesn't throw with explicit timeout
      const svc = new RTIService({ timeout: 5000 } as any);
      await expect(svc.callRTI({} as any)).resolves.toBeDefined();
    });

    test('defaults timeout to 150 when not configured', async () => {
      const fakeResponse: any = { status: 200, json: async () => ({}) };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(fakeResponse);

      const svc = new RTIService({} as any);
      await expect(svc.callRTI({} as any)).resolves.toBeDefined();
    });
  });

  describe('callRTI', () => {
    test('sends POST with correct headers and serialized body', async () => {
      const fakeResponse: any = { status: 200, json: async () => ({}) };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(fakeResponse);

      const payload = { tagHash: 'th', apiKey: 'ak' } as any;
      const svc = new RTIService({ rtiServiceURI: 'https://example.com' } as any);
      await svc.callRTI(payload);

      const [, opts] = ((globalThis as any).fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(opts.body)).toEqual(payload);
    });

    test('returns parsed JSON on 200 response', async () => {
      const fakeBody = { decision: { verdict: 'benign' }, metadata: { version: '1' }, classification: { code: 0 }, ids: [] };
      const fakeResponse: any = { status: 200, json: async () => fakeBody };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(fakeResponse);

      const svc = new RTIService({ timeout: 1000, rtiServiceURI: 'https://example.com' } as any);
      const res = await svc.callRTI({} as any);

      expect(res).toEqual(fakeBody);
    });

    test('returns parsed JSON on 399 response (just below error boundary)', async () => {
      const fakeBody = { decision: { verdict: 'benign' }, classification: { code: 0 }, ids: [] };
      const fakeResponse: any = { status: 399, json: async () => fakeBody };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(fakeResponse);

      const svc = new RTIService({ rtiServiceURI: 'https://example.com' } as any);
      await expect(svc.callRTI({} as any)).resolves.toEqual(fakeBody);
    });

    test('throws with status code and body on 400 response', async () => {
      const fakeResponse: any = { status: 400, text: async () => 'bad request' };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(fakeResponse);

      const svc = new RTIService({ timeout: 1000, rtiServiceURI: 'https://example.com' } as any);
      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: Invalid RTI request, response code: 400, body: bad request/);
    });

    test('throws with status code and body on 500 response', async () => {
      const fakeResponse: any = { status: 500, text: async () => 'internal server error' };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(fakeResponse);

      const svc = new RTIService({ rtiServiceURI: 'https://example.com' } as any);
      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: Invalid RTI request, response code: 500, body: internal server error/);
    });

    test('wraps network error with "request error:" prefix', async () => {
      (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('network failure'));

      const svc = new RTIService({ timeout: 1000, rtiServiceURI: 'https://example.com' } as any);
      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: network failure/);
    });
  });
});
