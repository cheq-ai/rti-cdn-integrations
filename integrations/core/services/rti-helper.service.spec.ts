// cspell:ignore cheq
import { describe, test, expect } from 'vitest';
import { RTIHelperService } from './rti-helper.service';
import { Mode } from '../models/mode.model';
import { Action } from '../models/action.model';
import { ActionStrategy } from '../models/action-strategy.model';

describe('RTIHelperService', () => {
  describe('shouldIgnore', () => {
    test('returns false when ignorePaths is not configured', () => {
      const svc = new RTIHelperService({} as any);
      expect(svc.shouldIgnore('/health')).toBe(false);
      expect(svc.shouldIgnore('/')).toBe(false);
    });

    test('returns false when ignorePaths is empty array', () => {
      const svc = new RTIHelperService({ ignorePaths: [] } as any);
      expect(svc.shouldIgnore('/health')).toBe(false);
    });

    test('matches prefix pattern', () => {
      const svc = new RTIHelperService({ ignorePaths: [/^\/health/] } as any);
      expect(svc.shouldIgnore('/health')).toBe(true);
      expect(svc.shouldIgnore('/health/ok')).toBe(true);
      expect(svc.shouldIgnore('/other')).toBe(false);
    });

    test('matches exact path with anchors', () => {
      const svc = new RTIHelperService({ ignorePaths: [/^\/ping$/] } as any);
      expect(svc.shouldIgnore('/ping')).toBe(true);
      expect(svc.shouldIgnore('/ping/extra')).toBe(false);
      expect(svc.shouldIgnore('/not-ping')).toBe(false);
    });

    test('matches any of multiple patterns', () => {
      const svc = new RTIHelperService({ ignorePaths: [/^\/health/, /^\/static/, /^\/api\/v1/] } as any);
      expect(svc.shouldIgnore('/health')).toBe(true);
      expect(svc.shouldIgnore('/static/main.css')).toBe(true);
      expect(svc.shouldIgnore('/api/v1/users')).toBe(true);
      expect(svc.shouldIgnore('/api/v2/users')).toBe(false);
      expect(svc.shouldIgnore('/home')).toBe(false);
    });

    test('matches static asset file extensions', () => {
      const svc = new RTIHelperService({ ignorePaths: [/\.(js|css|png|jpg|svg|ico|woff2?)$/i] } as any);
      expect(svc.shouldIgnore('/main.js')).toBe(true);
      expect(svc.shouldIgnore('/styles.css')).toBe(true);
      expect(svc.shouldIgnore('/logo.PNG')).toBe(true);   // case-insensitive
      expect(svc.shouldIgnore('/font.woff2')).toBe(true);
      expect(svc.shouldIgnore('/page')).toBe(false);
      expect(svc.shouldIgnore('/download')).toBe(false);
    });

    test('matches using combination of prefix and extension patterns', () => {
      const svc = new RTIHelperService({ ignorePaths: [/^\/static/, /\.(js|css|png)$/] } as any);
      expect(svc.shouldIgnore('/static/bundle.js')).toBe(true);  // prefix
      expect(svc.shouldIgnore('/other/main.css')).toBe(true);    // extension
      expect(svc.shouldIgnore('/dynamic/page')).toBe(false);     // neither
    });
  });

  describe('getEventType', () => {
    test('returns PAGE_LOAD when routeToEventType is not configured', () => {
      const svc = new RTIHelperService({} as any);
      expect(svc.getEventType('/any', 'GET')).toBe('page_load');
    });

    test('returns mapped event type when path and method both match', () => {
      const mapping = [{ path: /^\/api\//, method: /^GET$/, event_type: 'API' } as any];
      const svc = new RTIHelperService({ routeToEventType: mapping } as any);
      expect(svc.getEventType('/api/x', 'GET')).toBe('API');
    });

    test('returns PAGE_LOAD when path matches but method does not', () => {
      const mapping = [{ path: /^\/api\//, method: /^GET$/, event_type: 'API' } as any];
      const svc = new RTIHelperService({ routeToEventType: mapping } as any);
      expect(svc.getEventType('/api/x', 'POST')).toBe('page_load');
    });

    test('returns PAGE_LOAD when no mapping matches', () => {
      const mapping = [{ path: /^\/api\//, method: /^GET$/, event_type: 'API' } as any];
      const svc = new RTIHelperService({ routeToEventType: mapping } as any);
      expect(svc.getEventType('/other', 'GET')).toBe('page_load');
    });
  });

  describe('getAction', () => {
    const resp = (code: number, verdict: string, reasons: string[] = []) => ({
      classification: { code },
      decision: { verdict },
      cheqDetection: { reasons },
    } as any);

    test('returns ALLOW in MONITORING mode regardless of verdict or code', () => {
      const svc = new RTIHelperService({ mode: Mode.MONITORING, blockTTCodes: [100] } as any);
      expect(svc.getAction(resp(100, 'malicious'))).toBe(Action.ALLOW);
    });

    test('returns ALLOW in BLOCKING mode for benign verdict with no matching codes', () => {
      const svc = new RTIHelperService({ mode: Mode.BLOCKING } as any);
      expect(svc.getAction(resp(1, 'benign'))).toBe(Action.ALLOW);
    });

    test('returns ALLOW in BLOCKING mode when all TTCodes and reasons are configured but none match', () => {
      const svc = new RTIHelperService({
        mode: Mode.BLOCKING,
        blockTTCodes: [100],
        blockReasons: ['block-reason'],
        challengeTTCodes: [200],
        challengeReasons: ['challenge-reason'],
        redirectTTCodes: [300],
        redirectReasons: ['redirect-reason'],
      } as any);
      expect(svc.getAction(resp(1, 'benign', ['other-reason']))).toBe(Action.ALLOW);
    });

    test('returns BLOCK for malicious verdict', () => {
      const svc = new RTIHelperService({ mode: Mode.BLOCKING } as any);
      expect(svc.getAction(resp(1, 'malicious'))).toBe(Action.BLOCK);
    });

    test('returns BLOCK for matching blockTTCode', () => {
      const svc = new RTIHelperService({ mode: Mode.BLOCKING, blockTTCodes: [100] } as any);
      expect(svc.getAction(resp(100, 'benign'))).toBe(Action.BLOCK);
    });

    test('returns BLOCK for matching blockReason', () => {
      const svc = new RTIHelperService({ mode: Mode.BLOCKING, blockReasons: ['reason-x'] } as any);
      expect(svc.getAction(resp(1, 'benign', ['reason-x']))).toBe(Action.BLOCK);
    });

    test('returns CHALLENGE for suspicious verdict', () => {
      const svc = new RTIHelperService({ mode: Mode.BLOCKING } as any);
      expect(svc.getAction(resp(1, 'suspicious'))).toBe(Action.CHALLENGE);
    });

    test('returns CHALLENGE for matching challengeTTCode', () => {
      const svc = new RTIHelperService({ mode: Mode.BLOCKING, challengeTTCodes: [200] } as any);
      expect(svc.getAction(resp(200, 'benign'))).toBe(Action.CHALLENGE);
    });

    test('returns CHALLENGE for matching challengeReason', () => {
      const svc = new RTIHelperService({ mode: Mode.BLOCKING, challengeReasons: ['reason-y'] } as any);
      expect(svc.getAction(resp(1, 'benign', ['reason-y']))).toBe(Action.CHALLENGE);
    });

    test('returns REDIRECT for matching redirectTTCode', () => {
      const svc = new RTIHelperService({ mode: Mode.BLOCKING, redirectTTCodes: [300] } as any);
      expect(svc.getAction(resp(300, 'benign'))).toBe(Action.REDIRECT);
    });

    test('returns REDIRECT for matching redirectReason', () => {
      const svc = new RTIHelperService({ mode: Mode.BLOCKING, redirectReasons: ['reason-z'] } as any);
      expect(svc.getAction(resp(1, 'benign', ['reason-z']))).toBe(Action.REDIRECT);
    });
  });

  describe('getActionStrategy', () => {
    test('returns configured blockingStrategy', () => {
      const svc = new RTIHelperService({ blockingStrategy: ActionStrategy.NOT_FOUND } as any);
      expect(svc.getActionStrategy(Action.BLOCK)).toBe(ActionStrategy.NOT_FOUND);
    });

    test('returns ACCESS_DENIED as default when blockingStrategy is not configured', () => {
      const svc = new RTIHelperService({} as any);
      expect(svc.getActionStrategy(Action.BLOCK)).toBe(ActionStrategy.ACCESS_DENIED);
    });

    test('returns configured challengingStrategy', () => {
      const svc = new RTIHelperService({ challengingStrategy: ActionStrategy.ACCESS_DENIED } as any);
      expect(svc.getActionStrategy(Action.CHALLENGE)).toBe(ActionStrategy.ACCESS_DENIED);
    });

    test('returns CAPTCHA as default when challengingStrategy is not configured', () => {
      const svc = new RTIHelperService({} as any);
      expect(svc.getActionStrategy(Action.CHALLENGE)).toBe(ActionStrategy.CAPTCHA);
    });

    test('returns REDIRECT for REDIRECT action', () => {
      const svc = new RTIHelperService({} as any);
      expect(svc.getActionStrategy(Action.REDIRECT)).toBe(ActionStrategy.REDIRECT);
    });

    test('returns null for ALLOW action', () => {
      const svc = new RTIHelperService({} as any);
      expect(svc.getActionStrategy(Action.ALLOW)).toBeNull();
    });
  });

  describe('getCheqCookie', () => {
    const svc = new RTIHelperService({} as any);

    test('returns undefined for empty string', () => {
      expect(svc.getCheqCookie('')).toBeUndefined();
    });

    test('returns cookie value when present', () => {
      expect(svc.getCheqCookie('_cheq_rti=abc123; other=1')).toBe('abc123');
    });

    test('returns empty string when _cheq_rti is not in cookie string', () => {
      expect(svc.getCheqCookie('session=xyz; theme=dark')).toBe('');
    });

    test('finds _cheq_rti when not the first cookie', () => {
      expect(svc.getCheqCookie('session=xyz; _cheq_rti=token99')).toBe('token99');
    });
  });

  describe('capitalize', () => {
    const svc = new RTIHelperService({} as any);

    test('capitalizes each word with default space splitter', () => {
      expect(svc.capitalize('hello world')).toBe('Hello World');
    });

    test('capitalizes single word', () => {
      expect(svc.capitalize('hello')).toBe('Hello');
    });

    test('capitalizes with custom splitter', () => {
      expect(svc.capitalize('x-y-z', '-')).toBe('X-Y-Z');
    });

    test('returns empty string when called with no arguments', () => {
      expect(svc.capitalize()).toBe('');
    });
  });

  describe('getHeaderByName', () => {
    const svc = new RTIHelperService({} as any);
    const headers: any = { 'content-type': 'text/html', 'X-Custom-Header': 'value' };

    test('finds header by lowercase name', () => {
      expect(svc.getHeaderByName(headers, 'content-type')).toBe('text/html');
    });

    test('finds header by capitalized name', () => {
      expect(svc.getHeaderByName(headers, 'x-custom-header')).toBe('value');
    });

    test('returns provided default when header is missing', () => {
      expect(svc.getHeaderByName(headers, 'missing', 'fallback')).toBe('fallback');
    });

    test('returns undefined when header is missing and no default provided', () => {
      expect(svc.getHeaderByName(headers, 'missing')).toBeUndefined();
    });
  });

  describe('validateConfig', () => {
    test('returns error when redirectReasons defined but redirectLocation is not', () => {
      const svc = new RTIHelperService({ redirectReasons: ['r1'], redirectLocation: undefined } as any);
      expect(svc.validateConfig().length).toBeGreaterThan(0);
    });

    test('returns error when redirectLocation defined but redirectReasons is not', () => {
      const svc = new RTIHelperService({ redirectLocation: 'https://x', redirectReasons: undefined } as any);
      expect(svc.validateConfig().length).toBeGreaterThan(0);
    });

    test('returns no errors when both redirectReasons and redirectLocation are defined', () => {
      const svc = new RTIHelperService({ redirectReasons: ['r1'], redirectLocation: 'https://x' } as any);
      expect(svc.validateConfig()).toHaveLength(0);
    });

    test('returns no errors when neither redirectReasons nor redirectLocation are defined', () => {
      const svc = new RTIHelperService({} as any);
      expect(svc.validateConfig()).toHaveLength(0);
    });
  });
});
