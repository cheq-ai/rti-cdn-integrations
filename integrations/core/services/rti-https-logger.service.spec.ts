import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
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

import { RTIHttpsLoggerService } from './rti-https-logger.service';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

describe('RTIHttpsLoggerService', () => {
  let server: http.Server;
  let baseUrl: string;
  let handler: Handler;
  let connections: number;
  let config: any;

  beforeEach(async () => {
    connections = 0;
    handler = (_req, res) => res.end();
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, res, body));
    });
    server.on('connection', () => connections++);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/log`;
    config = { apiKey: 'api-key', tagHash: 'tag-hash', debug: false, rtiLoggerURI: baseUrl };
  });

  afterEach(async () => {
    httpsRequest.impl = undefined;
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('constructor', () => {
    test('uses rtiLoggerURI from config when provided', async () => {
      let path: string | undefined;
      handler = (req, res) => { path = req.url; res.end(); };

      await new RTIHttpsLoggerService('app', config).log('info', 'msg');

      expect(path).toBe('/log');
    });

    test('falls back to default logger URL when rtiLoggerURI is not configured', async () => {
      let calledUrl: unknown;
      httpsRequest.impl = (url: unknown) => {
        calledUrl = url;
        throw new Error('stop before network');
      };
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await new RTIHttpsLoggerService('app', { apiKey: 'k', tagHash: 'h' } as any).log('info', 'msg');

      expect(String(calledUrl)).toBe('https://rtilogger.production.cheq-platform.com');
    });
  });

  describe('log', () => {
    test('sends POST with correct headers and body fields', async () => {
      let received: { method?: string; contentType?: string; contentLength?: string; body?: string } = {};
      handler = (req, res, body) => {
        received = { method: req.method, contentType: req.headers['content-type'], contentLength: req.headers['content-length'], body };
        res.end();
      };

      await new RTIHttpsLoggerService('my-app', config).log('info', 'héllo', 'act');

      expect(received.method).toBe('POST');
      expect(received.contentType).toBe('application/json');
      expect(received.contentLength).toBe(String(Buffer.byteLength(received.body!)));
      expect(JSON.parse(received.body!)).toEqual({
        level: 'info',
        message: 'héllo',
        action: 'act',
        application: 'my-app',
        apiKey: 'api-key',
        tagHash: 'tag-hash',
      });
    });

    test('sends User-Agent cheq-rti-cloudfront', async () => {
      let userAgent: string | undefined;
      handler = (req, res) => { userAgent = req.headers['user-agent']; res.end(); };

      await new RTIHttpsLoggerService('app', config).log('info', 'x');

      expect(userAgent).toBe('cheq-rti-cloudfront');
    });

    test('sends log without action when action is omitted', async () => {
      let body = '';
      handler = (_req, res, b) => { body = b; res.end(); };

      await new RTIHttpsLoggerService('app', config).log('warn', 'no-action');

      expect(JSON.parse(body).action).toBeUndefined();
      expect(JSON.parse(body).message).toBe('no-action');
    });

    test('prints debug info to console.info when debug is true', async () => {
      const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

      await new RTIHttpsLoggerService('app', { ...config, debug: true }).log('info', 'hello', 'act');

      expect(consoleInfo).toHaveBeenCalledWith('rti logger response: 200 (OK) for log level: info, message: hello, action: act');
    });

    test('does not call console.info when debug is false', async () => {
      const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

      await new RTIHttpsLoggerService('app', config).log('info', 'hello', 'act');

      expect(consoleInfo).not.toHaveBeenCalled();
    });

    test('swallows a network error and logs to console.error', async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server = http.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(new RTIHttpsLoggerService('app', config).log('error', 'fail')).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/^rti logger api error \(continue running\): .*ECONNREFUSED/));
    });

    test('gives up after 1000ms by default so a slow logger cannot hold the request', async () => {
      handler = () => { /* never respond */ };
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const start = Date.now();
      await expect(new RTIHttpsLoggerService('app', config).log('error', 'slow')).resolves.toBeUndefined();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(990);
      expect(elapsed).toBeLessThan(2000);
      expect(consoleError).toHaveBeenCalledWith('rti logger api error (continue running): Error: The operation was aborted due to timeout');
    });

    test('applies the timeout ctor parameter', async () => {
      handler = () => { /* never respond */ };
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const start = Date.now();
      await new RTIHttpsLoggerService('app', config, 100).log('error', 'slow');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(800);
      expect(consoleError).toHaveBeenCalledWith('rti logger api error (continue running): Error: The operation was aborted due to timeout');
    });

    test('the logger timeout does not follow config.timeout', async () => {
      handler = (_req, res) => void setTimeout(() => res.end(), 300);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      // config.timeout is the RTI timeout; a 10ms RTI timeout must not cut a 300ms log call.
      await new RTIHttpsLoggerService('app', { ...config, timeout: 10 }).log('info', 'slow but fine');

      expect(consoleError).not.toHaveBeenCalled();
    });

    test('times out when the response headers arrive but the body stalls', async () => {
      handler = (_req, res) => { res.writeHead(200, { 'Content-Length': '10' }); res.write('par'); };
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(new RTIHttpsLoggerService('app', config, 100).log('info', 'x')).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith('rti logger api error (continue running): Error: The operation was aborted due to timeout');
    });

    test('an error status from the logger is printed in debug mode and not reported as an error', async () => {
      handler = (_req, res) => { res.statusCode = 500; res.end(); };
      const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      await new RTIHttpsLoggerService('app', { ...config, debug: true }).log('error', 'e');

      expect(consoleInfo).toHaveBeenCalledWith('rti logger response: 500 (Internal Server Error) for log level: error, message: e, action: undefined');
      expect(consoleError).not.toHaveBeenCalled();
    });

    test('a malformed rtiLoggerURI does not throw at construction; log() reports it and resolves', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      let logger!: RTIHttpsLoggerService;

      expect(() => { logger = new RTIHttpsLoggerService('app', { ...config, rtiLoggerURI: 'REPLACE_ME' }); }).not.toThrow();
      await expect(logger.log('error', 'x')).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/^rti logger api error \(continue running\): TypeError: Invalid URL/));
    });

    test('does not retry when the connection drops after the response started', async () => {
      let n = 0;
      handler = (req, res) => {
        if (++n === 1) return res.end();
        res.writeHead(200, { 'Content-Length': '10' });
        res.write('par', () => req.socket.destroy());
      };
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const svc = new RTIHttpsLoggerService('app', config);
      await svc.log('info', 'one');

      await svc.log('info', 'two');

      expect(n).toBe(2);
      expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/^rti logger api error \(continue running\): Error: aborted/));
    });

    test('reuses the connection across calls (keep-alive)', async () => {
      const svc = new RTIHttpsLoggerService('app', config);
      await svc.log('info', 'one');
      await new Promise((r) => setTimeout(r, 20));
      await svc.log('info', 'two');

      expect(connections).toBe(1);
    });

    test('delivers the log on a new connection when the pooled connection was dropped', async () => {
      const received: string[] = [];
      let n = 0;
      handler = (req, res, body) => {
        if (++n === 2) return void req.socket.destroy();
        received.push(JSON.parse(body).message);
        res.end();
      };
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const svc = new RTIHttpsLoggerService('app', config);
      await svc.log('info', 'one');

      await svc.log('error', 'two');

      expect(received).toEqual(['one', 'two']);
      expect(connections).toBe(2);
      expect(consoleError).not.toHaveBeenCalled();
    });

    test('closes a pooled connection after the idle timeout ctor parameter', async () => {
      let closed = 0;
      server.on('connection', (socket) => socket.on('close', () => closed++));

      const svc = new RTIHttpsLoggerService('app', config, undefined, 200);
      await svc.log('info', 'one');
      await new Promise((r) => setTimeout(r, 500));

      expect(closed).toBe(1);
    });
  });

  describe('info and error', () => {
    test('info sends level "info"', async () => {
      let body = '';
      handler = (_req, res, b) => { body = b; res.end(); };

      await new RTIHttpsLoggerService('app', config).info('i1', 'a1');

      expect(JSON.parse(body)).toMatchObject({ level: 'info', message: 'i1', action: 'a1' });
    });

    test('error sends level "error"', async () => {
      let body = '';
      handler = (_req, res, b) => { body = b; res.end(); };

      await new RTIHttpsLoggerService('app', config).error('e1');

      expect(JSON.parse(body)).toMatchObject({ level: 'error', message: 'e1' });
    });
  });
});
