import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { AddressInfo } from 'node:net';
import { HttpsClient } from './https-client';

// The retry cases are reproduced with a server that drops the connection (no response) on chosen requests.
// From the client's side this is what happens when a pooled connection was closed by the server
// and the client sends on it before it has seen the close.
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void;

// Makes the first request fail with the given error code as if it had been sent on a pooled connection.
// Used for errors a local server cannot produce reliably (EPIPE needs the write to race the close).
// blockMs keeps the event loop busy first, like a CPU-starved Lambda that handles the error late.
function failFirstRequestOnPooledSocket(client: HttpsClient, code: string, blockMs = 0) {
  const realRequest = (client as any).request;
  let calls = 0;
  (client as any).request = (...args: any[]) => {
    const req = realRequest(...args);
    if (++calls === 1) {
      Object.defineProperty(req, 'reusedSocket', { value: true });
      const until = Date.now() + blockMs;
      while (Date.now() < until) { /* busy wait */ }
      process.nextTick(() => req.destroy(Object.assign(new Error(`simulated ${code}`), { code })));
    }
    return req;
  };
}

const activeTimers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

describe('HttpsClient', () => {
  let server: http.Server;
  let url: string;
  let handler: Handler;
  let requests: number;
  let connections: number;
  let bodies: string[];

  beforeEach(async () => {
    requests = 0;
    connections = 0;
    bodies = [];
    handler = (_req, res) => res.end('ok');
    server = http.createServer((req, res) => {
      const n = ++requests;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { bodies.push(body); handler(req, res, n); });
    });
    server.on('connection', () => connections++);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('post', () => {
    test('resolves with status, statusText and body', async () => {
      handler = (_req, res) => { res.writeHead(201, 'Created'); res.end('{"a":1}'); };

      await expect(new HttpsClient(url, 50000).post('{}', 1000)).resolves.toEqual({ status: 201, statusText: 'Created', body: '{"a":1}' });
    });

    test('resolves (does not reject) on 4xx and 5xx', async () => {
      handler = (_req, res, n) => { res.statusCode = n === 1 ? 404 : 500; res.end('err'); };
      const client = new HttpsClient(url, 50000);

      await expect(client.post('{}', 1000)).resolves.toMatchObject({ status: 404, body: 'err' });
      await expect(client.post('{}', 1000)).resolves.toMatchObject({ status: 500, body: 'err' });
    });

    test('resolves an empty body', async () => {
      handler = (_req, res) => { res.statusCode = 204; res.end(); };

      await expect(new HttpsClient(url, 50000).post('{}', 1000)).resolves.toMatchObject({ status: 204, body: '' });
    });

    test('reassembles a multibyte character split across chunks', async () => {
      const euro = Buffer.from('€');
      handler = (_req, res) => { res.write(euro.subarray(0, 1)); setTimeout(() => res.end(euro.subarray(1)), 20); };

      await expect(new HttpsClient(url, 50000).post('{}', 1000)).resolves.toMatchObject({ body: '€' });
    });

    test('sends POST with JSON content type and the byte length of a multibyte body', async () => {
      let seen: http.IncomingHttpHeaders = {};
      let method = '';
      handler = (req, res) => { seen = req.headers; method = req.method!; res.end(); };
      const body = '{"t":"héllo €"}';

      await new HttpsClient(url, 50000).post(body, 1000);

      expect(method).toBe('POST');
      expect(seen['content-type']).toBe('application/json');
      expect(seen['content-length']).toBe(String(Buffer.byteLength(body)));
      expect(bodies[0]).toBe(body);
    });

    test('keeps the path and query string of the URL', async () => {
      let path = '';
      handler = (req, res) => { path = req.url!; res.end(); };

      await new HttpsClient(`${url}defend/4.1/traffic?x=1&y=2`, 50000).post('{}', 1000);

      expect(path).toBe('/defend/4.1/traffic?x=1&y=2');
    });

    test('sends User-Agent cheq-rti-cloudfront on every attempt, also on a retry', async () => {
      const agents: (string | undefined)[] = [];
      handler = (req, res, n) => { agents.push(req.headers['user-agent']); n === 2 ? req.socket.destroy() : res.end(); };
      const client = new HttpsClient(url, 50000);

      await client.post('{}', 1000);
      await client.post('{}', 1000);

      expect(requests).toBe(3);
      expect(agents).toEqual(['cheq-rti-cloudfront', 'cheq-rti-cloudfront', 'cheq-rti-cloudfront']);
    });

    test('times out on a new connection that never responds, without retrying', async () => {
      handler = () => { /* never respond */ };

      await expect(new HttpsClient(url, 50000).post('{}', 100)).rejects.toThrow(/The operation was aborted due to timeout/);
      expect(requests).toBe(1);
    });

    test('rejects with the timeout error when the timeout is 0', async () => {
      await expect(new HttpsClient(url, 50000).post('{}', 0)).rejects.toThrow(/The operation was aborted due to timeout/);
    });

    test('leaves no timer running after success, an error status or a failure', async () => {
      const client = new HttpsClient(url, 50000);
      const before = activeTimers();

      await client.post('{}', 5000);
      handler = (_req, res) => { res.statusCode = 500; res.end(); };
      await client.post('{}', 5000);
      handler = (req) => req.socket.destroy();
      await expect(new HttpsClient(url, 50000).post('{}', 5000)).rejects.toThrow();

      // <= rather than ===: a timer from elsewhere in the run may end meanwhile; a leak can only add one.
      expect(activeTimers()).toBeLessThanOrEqual(before);
    });

    test('a slow response is not cut off by the idle socket timeout', async () => {
      handler = (_req, res) => void setTimeout(() => res.end('slow'), 300);

      await expect(new HttpsClient(url, 100).post('{}', 2000)).resolves.toMatchObject({ body: 'slow' });
    });

    test.each(['REPLACE_ME', 'rtilogger.example.com', 'https://exa mple.com', 'https://'])(
      'does not throw in the constructor for the malformed URL %j; post rejects instead', async (bad) => {
        let client!: HttpsClient;
        expect(() => { client = new HttpsClient(bad, 50000); }).not.toThrow();
        await expect(client.post('{}', 1000)).rejects.toThrow(/Invalid URL/);
      });

    test('rejects a URL with an unsupported protocol', async () => {
      await expect(new HttpsClient('ftp://example.com/', 50000).post('{}', 1000)).rejects.toThrow(/not supported/);
    });

    test('uses an https.Agent for an https URL and an http.Agent otherwise', () => {
      expect((new HttpsClient('https://example.com/', 50000) as any).agent).toBeInstanceOf(https.Agent);
      expect((new HttpsClient(url, 50000) as any).agent).not.toBeInstanceOf(https.Agent);
    });

    test('destroys the request on timeout, so no busy socket is left in the pool', async () => {
      handler = () => { /* never responds */ };
      const client = new HttpsClient(url, 50000);
      const agent = (client as any).agent as http.Agent;

      await expect(client.post('{}', 100)).rejects.toThrow(/The operation was aborted due to timeout/);
      await new Promise((r) => setTimeout(r, 50));

      // Only rejecting (without req.destroy) would leave the socket in agent.sockets, still waiting for the response.
      expect(Object.keys(agent.sockets)).toHaveLength(0);
      expect(Object.keys(agent.freeSockets)).toHaveLength(0);
    });

    test('resolves a 3xx as the answer and does not follow Location (unlike fetch)', async () => {
      const paths: string[] = [];
      handler = (req, res) => { paths.push(req.url!); res.writeHead(302, { Location: '/other' }); res.end(); };

      await expect(new HttpsClient(url, 50000).post('{}', 1000)).resolves.toMatchObject({ status: 302 });
      expect(paths).toEqual(['/']);
    });

    test('keeps a leading BOM in the body (unlike fetch)', async () => {
      handler = (_req, res) => res.end('﻿{}');

      const { body } = await new HttpsClient(url, 50000).post('{}', 1000);

      expect(body.charCodeAt(0)).toBe(0xFEFF);
      expect(body).toBe('﻿{}');
    });
  });

  describe('idle limit by the wall clock (Lambda freeze)', () => {
    afterEach(() => vi.restoreAllMocks());

    test('does not reuse a pooled connection idle longer than the limit, even if its timer has not fired', async () => {
      // A frozen Lambda runs no timers, so after a thaw the agent's idle timer may not have closed the
      // connection yet. Date.now() moves on during a freeze; simulate that by jumping the clock.
      const reused: boolean[] = [];
      const client = new HttpsClient(url, 50000);
      const realRequest = (client as any).request;
      (client as any).request = (...args: any[]) => {
        const req = realRequest(...args);
        req.on('socket', () => reused.push(req.reusedSocket));
        return req;
      };
      await client.post('{}', 1000);

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
      await client.post('{}', 1000);

      expect(connections).toBe(2);
      expect(reused).toEqual([false, false]);
      expect(requests).toBe(2); // a new connection straight away, not a failed send plus a retry
    });

    test('reuses the pooled connection while it has been idle for less than the limit', async () => {
      const client = new HttpsClient(url, 50000);
      await client.post('{}', 1000);

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 49_000);
      await client.post('{}', 1000);

      expect(connections).toBe(1);
    });

    test('counts idle time from the end of the last call, including a failed one', async () => {
      const client = new HttpsClient(url, 50000);
      await client.post('{}', 1000);
      const t0 = Date.now();
      handler = (_req, res) => { res.statusCode = 500; res.end(); };
      vi.spyOn(Date, 'now').mockReturnValue(t0 + 40_000);
      await client.post('{}', 1000); // ends at t0 + 40s, connection back in the pool

      vi.spyOn(Date, 'now').mockReturnValue(t0 + 80_000); // 40s idle since the last call
      await client.post('{}', 1000);

      expect(connections).toBe(1);
    });
  });

  describe('retry on a dropped pooled connection', () => {
    test('retries once on a new connection when a reused connection is reset before any response', async () => {
      handler = (req, res, n) => (n === 2 ? req.socket.destroy() : res.end(`ok${n}`));
      const client = new HttpsClient(url, 50000);

      await client.post('{}', 1000);
      const second = await client.post('{}', 1000);

      expect(second.body).toBe('ok3');
      expect(connections).toBe(2);
    });

    test('retries once when a reused connection fails with EPIPE', async () => {
      const client = new HttpsClient(url, 50000);
      failFirstRequestOnPooledSocket(client, 'EPIPE');

      await expect(client.post('{}', 1000)).resolves.toMatchObject({ status: 200, body: 'ok' });
    });

    test.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'])('does not retry %s on a reused connection', async (code) => {
      const client = new HttpsClient(url, 50000);
      failFirstRequestOnPooledSocket(client, code);

      await expect(client.post('{}', 1000)).rejects.toMatchObject({ code });
    });

    test('the retry sends the same body', async () => {
      handler = (req, res, n) => (n === 2 ? req.socket.destroy() : res.end('ok'));
      const client = new HttpsClient(url, 50000);
      await client.post('{"first":1}', 1000);

      await client.post('{"text":"héllo"}', 1000);

      expect(bodies.slice(1)).toEqual(['{"text":"héllo"}', '{"text":"héllo"}']);
    });

    test('the connection opened by the retry is pooled for the next call', async () => {
      handler = (req, res, n) => (n === 2 ? req.socket.destroy() : res.end('ok'));
      const client = new HttpsClient(url, 50000);
      await client.post('{}', 1000);
      await client.post('{}', 1000);
      await new Promise((r) => setTimeout(r, 20));

      await client.post('{}', 1000);

      expect(connections).toBe(2);
    });

    test('does not start a retry once the deadline has passed', async () => {
      const client = new HttpsClient(url, 50000);
      failFirstRequestOnPooledSocket(client, 'ECONNRESET', 100);

      await expect(client.post('{}', 50)).rejects.toThrow(/The operation was aborted due to timeout/);
      await new Promise((r) => setTimeout(r, 100));

      // Only the simulated first attempt opened a connection; no retry was started.
      expect(connections).toBe(1);
      expect(requests).toBe(0);
    });

    test('leaves no timer running after a retry succeeds', async () => {
      handler = (req, res, n) => (n === 2 ? req.socket.destroy() : res.end('ok'));
      const client = new HttpsClient(url, 50000);
      await client.post('{}', 1000);
      const before = activeTimers();

      await client.post('{}', 5000);

      expect(requests).toBe(3);
      // <= rather than ===: a timer from elsewhere in the run may end meanwhile; a leak can only add one.
      expect(activeTimers()).toBeLessThanOrEqual(before);
    });

    test('does not retry when a new connection is reset', async () => {
      handler = (req) => req.socket.destroy();
      const client = new HttpsClient(url, 50000);

      await expect(client.post('{}', 1000)).rejects.toThrow(/socket hang up/);
      expect(requests).toBe(1);
    });

    test('retries at most once', async () => {
      handler = (req, res, n) => (n === 1 || n === 4 ? res.end('ok') : req.socket.destroy());
      const client = new HttpsClient(url, 50000);
      await client.post('{}', 1000);

      // Request 2 is on the pooled connection and is retried; request 3 is the retry, on a new connection.
      await expect(client.post('{}', 1000)).rejects.toThrow(/socket hang up/);
      expect(requests).toBe(3);
    });

    test('retries at most once even when the retry also lands on a dropped pooled connection', async () => {
      handler = (req, res, n) => (n <= 2 ? res.end('ok') : req.socket.destroy());
      const client = new HttpsClient(url, 50000);
      // Two concurrent calls leave two connections in the pool.
      await Promise.all([client.post('{}', 1000), client.post('{}', 1000)]);
      expect(connections).toBe(2);

      // Request 3 fails on one pooled connection, its retry (request 4) on the other; nothing after that.
      await expect(client.post('{}', 1000)).rejects.toThrow(/socket hang up/);
      expect(requests).toBe(4);
    });

    test('does not retry a timeout on a reused connection', async () => {
      handler = (_req, res, n) => { if (n === 1) res.end('ok'); /* request 2 never gets a response */ };
      const client = new HttpsClient(url, 50000);
      await client.post('{}', 1000);

      await expect(client.post('{}', 100)).rejects.toThrow(/The operation was aborted due to timeout/);
      expect(requests).toBe(2);
    });

    test('does not retry once a response has started', async () => {
      handler = (req, res, n) => {
        if (n === 1) return res.end('ok');
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('partial', () => req.socket.destroy());
      };
      const client = new HttpsClient(url, 50000);
      await client.post('{}', 1000);

      await expect(client.post('{}', 1000)).rejects.toThrow(/aborted/);
      expect(requests).toBe(2);
    });

    test('the retry gets only the time left from the original timeout', async () => {
      handler = (req, res, n) => {
        if (n === 1) return res.end('ok');
        if (n === 2) return void setTimeout(() => req.socket.destroy(), 500);
        /* the retry never gets a response */
      };
      const client = new HttpsClient(url, 50000);
      await client.post('{}', 1000);

      const start = Date.now();
      await expect(client.post('{}', 1000)).rejects.toThrow(/The operation was aborted due to timeout/);
      const elapsed = Date.now() - start;

      expect(requests).toBe(3);
      // One 1000ms budget for both attempts. A fresh timeout for the retry would end at ~1500ms.
      expect(elapsed).toBeGreaterThanOrEqual(990);
      expect(elapsed).toBeLessThan(1400);
    });

    test('does not retry a reused-socket ECONNRESET reported on the request after the response started', async () => {
      // Node 20/22 report a drop after the response on `res`, so this path is forced by emitting the error on
      // `req` from inside the response callback. It pins the `!responded` guard.
      handler = (_req, res, n) => {
        if (n === 1) { res.writeHead(200); res.write('partial'); return; } // response started, body never ends
        res.end('retried');
      };
      const client = new HttpsClient(url, 50000);
      const realRequest = (client as any).request;
      let calls = 0;
      (client as any).request = (target: string, opts: any, onResponse: (res: http.IncomingMessage) => void) => {
        const req = realRequest(target, opts, (res: http.IncomingMessage) => {
          onResponse(res);
          if (calls === 1) req.emit('error', Object.assign(new Error('simulated reset'), { code: 'ECONNRESET' }));
        });
        if (++calls === 1) Object.defineProperty(req, 'reusedSocket', { value: true });
        return req;
      };

      await expect(client.post('{}', 1000)).rejects.toThrow(/simulated reset/);
      await new Promise((r) => setTimeout(r, 50));
      expect(requests).toBe(1);
    });
  });
});
