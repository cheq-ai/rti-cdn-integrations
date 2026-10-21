import { describe, test, expect, afterEach, vi } from 'vitest';
import { RTILoggerRawResponse, RTILoggerServiceBase } from './rti-logger.service.base';

// Test-only subclass: records what the base passes to send() and lets each test decide what send() does,
// so the shared payload and error handling are tested without any transport.
class ProbeLogger extends RTILoggerServiceBase {
  sent: string[] = [];
  reply: () => Promise<RTILoggerRawResponse> = async () => ({ status: 200, statusText: 'OK' });
  get endpoint() { return this.url; }
  protected send(body: string): Promise<RTILoggerRawResponse> { this.sent.push(body); return this.reply(); }
}

const config: any = { apiKey: 'api-key', tagHash: 'tag-hash' };

describe('RTILoggerServiceBase', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('constructor', () => {
    test('uses rtiLoggerURI from config when provided', () => {
      expect(new ProbeLogger('app', { ...config, rtiLoggerURI: 'https://logger.example.com' }).endpoint).toBe('https://logger.example.com');
    });

    test.each([undefined, ''])('falls back to the default logger URL when rtiLoggerURI is %j', (rtiLoggerURI) => {
      expect(new ProbeLogger('app', { ...config, rtiLoggerURI }).endpoint).toBe('https://rtilogger.production.cheq-platform.com');
    });
  });

  describe('log', () => {
    test('sends the exact payload, in this key order', async () => {
      const logger = new ProbeLogger('my-app', config);

      await logger.log('warn', 'msg', 'act');

      expect(logger.sent).toEqual(['{"level":"warn","message":"msg","action":"act","application":"my-app","apiKey":"api-key","tagHash":"tag-hash"}']);
    });

    test('leaves action out of the payload when it is omitted', async () => {
      const logger = new ProbeLogger('app', config);

      await logger.log('audit', 'msg');

      expect(JSON.parse(logger.sent[0])).not.toHaveProperty('action');
    });

    test('resolves only after send settles', async () => {
      let settle!: () => void;
      const logger = new ProbeLogger('app', config);
      logger.reply = () => new Promise((r) => { settle = () => r({ status: 200, statusText: 'OK' }); });
      let done = false;

      const pending = logger.log('info', 'msg').then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 20));
      expect(done).toBe(false);

      settle();
      await pending;
      expect(done).toBe(true);
    });

    test('prints the debug line when debug is true', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const logger = new ProbeLogger('app', { ...config, debug: true });
      logger.reply = async () => ({ status: 202, statusText: 'Accepted' });

      await logger.log('info', 'hello', 'act');

      expect(info).toHaveBeenCalledWith('rti logger response: 202 (Accepted) for log level: info, message: hello, action: act');
    });

    test('prints nothing when debug is not set', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});

      await new ProbeLogger('app', config).log('info', 'hello');

      expect(info).not.toHaveBeenCalled();
    });

    test('treats an error status from the logger as delivered, not as an error', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = new ProbeLogger('app', config);
      logger.reply = async () => ({ status: 500, statusText: 'Internal Server Error' });

      await expect(logger.log('error', 'x')).resolves.toBeUndefined();
      expect(error).not.toHaveBeenCalled();
    });

    test('swallows a rejected send and writes "rti logger api error" to console.error', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = new ProbeLogger('app', config);
      logger.reply = async () => { throw new Error('network down'); };

      await expect(logger.log('error', 'x')).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith('rti logger api error (continue running): Error: network down');
    });

    test('swallows a synchronous throw from send and writes "rti logger error" to console.error', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = new ProbeLogger('app', config);
      logger.reply = () => { throw new Error('boom'); };

      await expect(logger.log('error', 'x')).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith('rti logger error (continue running): Error: boom');
    });

    test('swallows a payload that cannot be serialized and does not call send', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = new ProbeLogger('app', { ...config, apiKey: 1n });

      await expect(logger.log('error', 'x')).resolves.toBeUndefined();
      expect(logger.sent).toEqual([]);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/^rti logger error \(continue running\): TypeError: .*BigInt/));
    });
  });

  describe('info and error', () => {
    test('info sends level "info" with the action', async () => {
      const logger = new ProbeLogger('app', config);

      await logger.info('i1', 'a1');

      expect(JSON.parse(logger.sent[0])).toMatchObject({ level: 'info', message: 'i1', action: 'a1' });
    });

    test('error sends level "error" with the action', async () => {
      const logger = new ProbeLogger('app', config);

      await logger.error('e1', 'a2');

      expect(JSON.parse(logger.sent[0])).toMatchObject({ level: 'error', message: 'e1', action: 'a2' });
    });

    test('never reject, even when send fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = new ProbeLogger('app', config);
      logger.reply = async () => { throw new Error('down'); };

      await expect(logger.info('i')).resolves.toBeUndefined();
      await expect(logger.error('e')).resolves.toBeUndefined();
    });
  });
});
