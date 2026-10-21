import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { AddressInfo } from 'node:net';

// Only https.request is replaced, and it delegates to the real implementation by default.
// This lets the default-URL test see the URL without going to the network,
// while every other test talks to a real local http server.
const httpsRequest = vi.hoisted(() => ({ impl: undefined as undefined | ((...args: any[]) => any) }));
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  const request = (...args: any[]) => (httpsRequest.impl ?? (actual.request as any))(...args);
  return { ...actual, request, default: { ...actual, request } };
});

import { RTIHttpsService } from "./rti-https.service";
import { RTIService } from "./rti.service";
import { HttpsClient } from "./https-client";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

describe("RTIHttpsService", () => {
  let server: http.Server;
  let baseUrl: string;
  let handler: Handler;
  let connections: number;

  beforeEach(async () => {
    connections = 0;
    handler = (_req, res) => res.end('{}');
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, res, body));
    });
    server.on('connection', () => connections++);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/traffic`;
  });

  afterEach(async () => {
    httpsRequest.impl = undefined;
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('constructor', () => {
    test('uses rtiServiceURI from config when provided', async () => {
      let path: string | undefined;
      handler = (req, res) => { path = req.url; res.end('{}'); };

      const svc = new RTIHttpsService({ rtiServiceURI: baseUrl } as any);
      await svc.callRTI({} as any);

      expect(path).toBe('/traffic');
    });

    test('falls back to default RTI URL when rtiServiceURI is not configured', async () => {
      let calledUrl: unknown;
      httpsRequest.impl = (url: unknown) => {
        calledUrl = url;
        throw new Error('stop before network');
      };

      const svc = new RTIHttpsService({} as any);
      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: stop before network/);

      expect(String(calledUrl)).toBe('https://rti-global.cheqzone.com/defend/4.1/traffic');
    });

    test('applies the defaultTimeout ctor parameter when config.timeout is not set', async () => {
      handler = () => { /* never respond */ };

      const svc = new RTIHttpsService({ rtiServiceURI: baseUrl } as any, 150);
      const start = Date.now();
      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: The operation was aborted due to timeout/);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('timeout and URL', () => {
    test('falls back to a 2000ms timeout when neither config.timeout nor defaultTimeout is set', async () => {
      const post = vi.spyOn(HttpsClient.prototype, 'post');

      await new RTIHttpsService({ rtiServiceURI: baseUrl } as any).callRTI({} as any);

      expect(post).toHaveBeenCalledWith(expect.any(String), 2000);
    });

    test('config.timeout takes precedence over the defaultTimeout ctor parameter', async () => {
      const post = vi.spyOn(HttpsClient.prototype, 'post');

      await new RTIHttpsService({ rtiServiceURI: baseUrl, timeout: 700 } as any, 150).callRTI({} as any);

      expect(post).toHaveBeenCalledWith(expect.any(String), 700);
    });

    test('a malformed rtiServiceURI does not throw at construction; callRTI rejects instead (fail-open)', async () => {
      let svc!: RTIHttpsService;

      expect(() => { svc = new RTIHttpsService({ rtiServiceURI: 'REPLACE_ME' } as any); }).not.toThrow();
      await expect(svc.callRTI({} as any)).rejects.toThrow(/^request error: Invalid URL/);
    });

    test('sends User-Agent cheq-rti-cloudfront', async () => {
      let userAgent: string | undefined;
      handler = (req, res) => { userAgent = req.headers['user-agent']; res.end('{}'); };

      await new RTIHttpsService({ rtiServiceURI: baseUrl } as any).callRTI({} as any);

      expect(userAgent).toBe('cheq-rti-cloudfront');
    });

    test('gives the same timeout error message as the fetch-based RTIService', async () => {
      handler = () => { /* never respond */ };
      const cfg = { timeout: 100, rtiServiceURI: baseUrl } as any;

      const viaHttps = await new RTIHttpsService(cfg).callRTI({} as any).catch((e: Error) => e.message);
      const viaFetch = await new RTIService(cfg).callRTI({} as any).catch((e: Error) => e.message);

      expect(viaHttps).toBe('request error: The operation was aborted due to timeout');
      expect(viaFetch).toBe(viaHttps);
    });
  });

  describe('callRTI', () => {
    test('sends POST with correct headers and serialized body', async () => {
      let received: { method?: string; contentType?: string; contentLength?: string; body?: string } = {};
      handler = (req, res, body) => {
        received = { method: req.method, contentType: req.headers['content-type'], contentLength: req.headers['content-length'], body };
        res.end('{}');
      };

      const payload = { tagHash: 'th', apiKey: 'ak', note: 'héllo' } as any;
      const svc = new RTIHttpsService({ rtiServiceURI: baseUrl } as any);
      await svc.callRTI(payload);

      expect(received.method).toBe('POST');
      expect(received.contentType).toBe('application/json');
      expect(received.contentLength).toBe(String(Buffer.byteLength(JSON.stringify(payload))));
      expect(JSON.parse(received.body!)).toEqual(payload);
    });

    test('returns parsed JSON on 200 response', async () => {
      const fakeBody = { decision: { verdict: 'benign' }, metadata: { version: '1' }, classification: { code: 0 }, ids: [] };
      handler = (_req, res) => res.end(JSON.stringify(fakeBody));

      const svc = new RTIHttpsService({ timeout: 1000, rtiServiceURI: baseUrl } as any);
      await expect(svc.callRTI({} as any)).resolves.toEqual(fakeBody);
    });

    test('returns parsed JSON on 399 response (just below error boundary)', async () => {
      const fakeBody = { decision: { verdict: 'benign' }, classification: { code: 0 }, ids: [] };
      handler = (_req, res) => { res.statusCode = 399; res.end(JSON.stringify(fakeBody)); };

      const svc = new RTIHttpsService({ rtiServiceURI: baseUrl } as any);
      await expect(svc.callRTI({} as any)).resolves.toEqual(fakeBody);
    });

    test('throws with status code and body on 400 response', async () => {
      handler = (_req, res) => { res.statusCode = 400; res.end('bad request'); };

      const svc = new RTIHttpsService({ timeout: 1000, rtiServiceURI: baseUrl } as any);
      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: Invalid RTI request, response code: 400, body: bad request/);
    });

    test('throws with status code and body on 500 response', async () => {
      handler = (_req, res) => { res.statusCode = 500; res.end('internal server error'); };

      const svc = new RTIHttpsService({ rtiServiceURI: baseUrl } as any);
      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: Invalid RTI request, response code: 500, body: internal server error/);
    });

    test('wraps network error with "request error:" prefix', async () => {
      const closedUrl = baseUrl;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server = http.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

      const svc = new RTIHttpsService({ timeout: 1000, rtiServiceURI: closedUrl } as any);
      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: .*ECONNREFUSED/);
    });

    test('aborts with timeout error when the server does not respond', async () => {
      handler = () => { /* never respond */ };

      const svc = new RTIHttpsService({ timeout: 50, rtiServiceURI: baseUrl } as any);
      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: The operation was aborted due to timeout/);
    });

    test('timeout also covers a response body that stalls', async () => {
      handler = (_req, res) => { res.writeHead(200); res.write('{"partial":'); /* never end */ };

      const svc = new RTIHttpsService({ timeout: 100, rtiServiceURI: baseUrl } as any);
      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: The operation was aborted due to timeout/);
    });

    test('wraps malformed JSON response with "request error:" prefix', async () => {
      handler = (_req, res) => res.end('not json');

      const svc = new RTIHttpsService({ rtiServiceURI: baseUrl } as any);
      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: Unexpected token/);
    });

    test('closes a pooled connection after the idle timeout', async () => {
      let closed = 0;
      server.on('connection', (socket) => socket.on('close', () => closed++));

      const svc = new RTIHttpsService({ timeout: 1000, rtiServiceURI: baseUrl } as any, undefined, 200);
      await svc.callRTI({} as any);
      await new Promise((r) => setTimeout(r, 500));

      expect(closed).toBe(1);
      await svc.callRTI({} as any);
      expect(connections).toBe(2);
    });

    test('keeps a pooled connection open for 50s by default, below the RTI 60s server idle timeout', () => {
      const agent = (new RTIHttpsService({} as any) as any).client.agent;

      expect(agent.options.timeout).toBe(50000);
    });

    test('creates one agent matching the URL protocol', () => {
      const httpsAgent = (new RTIHttpsService({} as any) as any).client.agent;
      const httpAgent = (new RTIHttpsService({ rtiServiceURI: baseUrl } as any) as any).client.agent;

      expect(httpsAgent).toBeInstanceOf(https.Agent);
      expect(httpAgent).toBeInstanceOf(http.Agent);
      expect(httpAgent).not.toBeInstanceOf(https.Agent);
    });

    test('retries once on a new connection when the pooled connection was dropped', async () => {
      let n = 0;
      handler = (req, res) => (++n === 2 ? req.socket.destroy() : res.end('{"decision":{"verdict":"benign"}}'));
      const svc = new RTIHttpsService({ timeout: 1000, rtiServiceURI: baseUrl } as any);
      await svc.callRTI({} as any);

      await expect(svc.callRTI({} as any)).resolves.toEqual({ decision: { verdict: 'benign' } });
      expect(connections).toBe(2);
    });

    test('reports the error when the retry also fails', async () => {
      let n = 0;
      handler = (req, res) => (++n === 1 ? res.end('{}') : req.socket.destroy());
      const svc = new RTIHttpsService({ timeout: 1000, rtiServiceURI: baseUrl } as any);
      await svc.callRTI({} as any);

      await expect(svc.callRTI({} as any)).rejects.toThrow(/request error: socket hang up/);
      expect(n).toBe(3);
    });

    test('reuses the connection across calls (keep-alive)', async () => {
      const svc = new RTIHttpsService({ timeout: 1000, rtiServiceURI: baseUrl } as any);
      await svc.callRTI({} as any);
      await new Promise((r) => setTimeout(r, 20));
      await svc.callRTI({} as any);

      expect(connections).toBe(1);
    });
  });
});
