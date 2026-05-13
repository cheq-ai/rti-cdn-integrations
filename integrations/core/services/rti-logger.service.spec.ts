import { describe, test, expect, afterEach, vi } from 'vitest';
import { RTILoggerService } from './rti-logger.service';

describe('RTILoggerService', () => {
  const baseConfig: any = {
    apiKey: 'api-key',
    tagHash: 'tag-hash',
    debug: false,
    rtiLoggerURI: 'https://example-logger.local',
  };

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).fetch;
  });

  describe('constructor', () => {
    test('uses rtiLoggerURI from config when provided', async () => {
      const mockResponse: any = { status: 200, statusText: 'OK' };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(mockResponse);

      const svc = new RTILoggerService('app', baseConfig);
      await svc.log('info', 'msg');

      const [url] = ((globalThis as any).fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://example-logger.local');
    });

    test('falls back to default logger URL when rtiLoggerURI is not configured', async () => {
      const mockResponse: any = { status: 200, statusText: 'OK' };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(mockResponse);

      const svc = new RTILoggerService('app', { apiKey: 'k', tagHash: 'h' } as any);
      await svc.log('info', 'msg');

      const [url] = ((globalThis as any).fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://rtilogger.production.cheq-platform.com');
    });
  });

  describe('log', () => {
    test('sends POST with correct body fields', async () => {
      const mockResponse: any = { status: 200, statusText: 'OK' };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(mockResponse);

      const svc = new RTILoggerService('my-app', baseConfig);
      await svc.log('info', 'hello', 'act');

      const [, opts] = ((globalThis as any).fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(opts.body as string);
      expect(body).toMatchObject({
        level: 'info',
        message: 'hello',
        action: 'act',
        application: 'my-app',
        apiKey: 'api-key',
        tagHash: 'tag-hash',
      });
    });

    test('sends log without action when action is omitted', async () => {
      const mockResponse: any = { status: 200, statusText: 'OK' };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(mockResponse);

      const svc = new RTILoggerService('app', baseConfig);
      await svc.log('warn', 'no-action');

      const [, opts] = ((globalThis as any).fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.action).toBeUndefined();
      expect(body.message).toBe('no-action');
    });

    test('prints debug info to console.info when debug is true', async () => {
      const mockResponse: any = { status: 200, statusText: 'OK' };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(mockResponse);
      const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

      const svc = new RTILoggerService('app', { ...baseConfig, debug: true });
      await svc.log('info', 'hello', 'act');

      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining('rti logger response: 200 (OK) for log level: info, message: hello, action: act'));
    });

    test('does not call console.info when debug is false', async () => {
      const mockResponse: any = { status: 200, statusText: 'OK' };
      (globalThis as any).fetch = vi.fn().mockResolvedValue(mockResponse);
      const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

      const svc = new RTILoggerService('app', { ...baseConfig, debug: false });
      await svc.log('info', 'hello', 'act');

      expect(consoleInfo).not.toHaveBeenCalled();
    });

    test('swallows fetch rejection and logs to console.error', async () => {
      (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('network failure'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const svc = new RTILoggerService('app', baseConfig);
      await expect(svc.log('error', 'fail', 'act')).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('rti logger api error (continue running): Error: network failure'));

    });

    test('catches synchronous throw from fetch and logs to console.error', async () => {
      (globalThis as any).fetch = vi.fn().mockImplementation(() => { throw new Error('sync boom'); });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const svc = new RTILoggerService('app', baseConfig);
      await expect(svc.log('error', 'fail')).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('rti logger error (continue running): Error: sync boom'));
    });
  });

  describe('info and error', () => {
    test('info delegates to log with level "info"', async () => {
      const svc = new RTILoggerService('app', baseConfig);
      const logSpy = vi.spyOn(svc as any, 'log').mockResolvedValue(undefined);

      await svc.info('i1', 'a1');

      expect(logSpy).toHaveBeenCalledWith('info', 'i1', 'a1');
    });

    test('error delegates to log with level "error"', async () => {
      const svc = new RTILoggerService('app', baseConfig);
      const logSpy = vi.spyOn(svc as any, 'log').mockResolvedValue(undefined);

      await svc.error('e1', 'a2');

      expect(logSpy).toHaveBeenCalledWith('error', 'e1', 'a2');
    });

    test('info works without action argument', async () => {
      const svc = new RTILoggerService('app', baseConfig);
      const logSpy = vi.spyOn(svc as any, 'log').mockResolvedValue(undefined);

      await svc.info('msg-only');

      expect(logSpy).toHaveBeenCalledWith('info', 'msg-only', undefined);
    });

    test('error works without action argument', async () => {
      const svc = new RTILoggerService('app', baseConfig);
      const logSpy = vi.spyOn(svc as any, 'log').mockResolvedValue(undefined);

      await svc.error('err-only');

      expect(logSpy).toHaveBeenCalledWith('error', 'err-only', undefined);
    });
  });
});
