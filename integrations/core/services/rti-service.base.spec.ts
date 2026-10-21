import { describe, test, expect } from 'vitest';
import { RTIRawResponse, RTIServiceBase } from "./rti-service.base";

// Test-only subclass: exposes the values resolved by the base constructor and lets each test decide
// what send() does, so the shared callRTI flow is tested without any transport.
class ProbeService extends RTIServiceBase {
  sent: string[] = [];
  reply: () => Promise<RTIRawResponse> = async () => ({ status: 200, body: '{}' });
  get timeout() { return this.rtiTimeout; }
  get endpoint() { return this.url; }
  protected send(body: string): Promise<RTIRawResponse> { this.sent.push(body); return this.reply(); }
}

const probe = (reply: () => Promise<RTIRawResponse>) => {
  const svc = new ProbeService({} as any);
  svc.reply = reply;
  return svc;
};

describe("RTIServiceBase", () => {
  describe('timeout', () => {
    test('uses config.timeout when provided', () => {
      expect(new ProbeService({ timeout: 700 } as any, 3000).timeout).toBe(700);
    });

    test('uses the defaultTimeout ctor parameter when config.timeout is not set', () => {
      expect(new ProbeService({} as any, 3000).timeout).toBe(3000);
    });

    test('falls back to 2000 when neither config.timeout nor defaultTimeout is given', () => {
      expect(new ProbeService({} as any).timeout).toBe(2000);
    });

    test('keeps config.timeout 0 instead of falling back (?? semantics)', () => {
      expect(new ProbeService({ timeout: 0 } as any, 3000).timeout).toBe(0);
    });
  });

  describe('url', () => {
    test('uses rtiServiceURI from config when provided', () => {
      expect(new ProbeService({ rtiServiceURI: 'https://custom.example.com' } as any).endpoint).toBe('https://custom.example.com');
    });

    test('falls back to the default RTI URL', () => {
      expect(new ProbeService({} as any).endpoint).toBe('https://rti-global.cheqzone.com/defend/4.1/traffic');
    });

    test('falls back to the default RTI URL when rtiServiceURI is an empty string', () => {
      expect(new ProbeService({ rtiServiceURI: '' } as any).endpoint).toBe('https://rti-global.cheqzone.com/defend/4.1/traffic');
    });
  });

  describe('callRTI', () => {
    test('passes the JSON-serialized payload to send', async () => {
      const svc = probe(async () => ({ status: 200, body: '{}' }));
      const payload = { tagHash: 'th', apiKey: 'ak', note: 'héllo' } as any;

      await svc.callRTI(payload);

      expect(svc.sent).toEqual([JSON.stringify(payload)]);
    });

    test('returns the parsed body for a status below 400', async () => {
      const body = { decision: { verdict: 'benign' }, ids: [] };
      await expect(probe(async () => ({ status: 200, body: JSON.stringify(body) })).callRTI({} as any)).resolves.toEqual(body);
      await expect(probe(async () => ({ status: 399, body: JSON.stringify(body) })).callRTI({} as any)).resolves.toEqual(body);
    });

    test.each([400, 403, 500, 503])('throws with the status and body for status %i', async (status) => {
      await expect(probe(async () => ({ status, body: 'nope' })).callRTI({} as any))
        .rejects.toThrow(`request error: Invalid RTI request, response code: ${status}, body: nope`);
    });

    test('wraps an empty body as a JSON parse error', async () => {
      await expect(probe(async () => ({ status: 200, body: '' })).callRTI({} as any))
        .rejects.toThrow('request error: Unexpected end of JSON input');
    });

    test('wraps a malformed body as a JSON parse error', async () => {
      await expect(probe(async () => ({ status: 200, body: 'not json' })).callRTI({} as any))
        .rejects.toThrow(/^request error: Unexpected token/);
    });

    test('wraps a send rejection with the "request error:" prefix', async () => {
      await expect(probe(async () => { throw new Error('connect ECONNREFUSED'); }).callRTI({} as any))
        .rejects.toThrow('request error: connect ECONNREFUSED');
    });

    test('keeps the reason when send rejects with something other than an Error', async () => {
      await expect(probe(() => Promise.reject('boom')).callRTI({} as any)).rejects.toThrow('request error: boom');
    });

    test('rejects with an Error instance', async () => {
      await expect(probe(async () => ({ status: 500, body: '' })).callRTI({} as any)).rejects.toBeInstanceOf(Error);
    });
  });
});
