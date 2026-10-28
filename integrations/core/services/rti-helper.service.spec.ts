// cspell:ignore cheq rayid
import { describe, test, expect } from 'vitest';
import { RTIHelperService } from './rti-helper.service';
import { RTIStatelessUtils } from './rti-stateless-utils';
import { Mode } from '../models/mode.model';
import { Action } from '../models/action.model';
import { ActionStrategy } from '../models/action-strategy.model';

describe('RTIHelperService', () => {
  // #region shouldIgnore Method Tests
  describe('shouldIgnore', () => {
    test('returns false when ignorePaths is not configured', () => {
      // Arrange
      const svc = new RTIHelperService({} as any);

      // Act & Assert
      expect(svc.shouldIgnore('/health')).toBe(false);
      expect(svc.shouldIgnore('/')).toBe(false);
    });

    test('returns false when ignorePaths is empty array', () => {
      // Arrange
      const svc = new RTIHelperService({ ignorePaths: [] } as any);

      // Act
      const result = svc.shouldIgnore('/health');

      // Assert
      expect(result).toBe(false);
    });

    test('matches prefix pattern', () => {
      // Arrange
      const svc = new RTIHelperService({ ignorePaths: [/^\/health/] } as any);

      // Act & Assert
      expect(svc.shouldIgnore('/health')).toBe(true);
      expect(svc.shouldIgnore('/health/ok')).toBe(true);
      expect(svc.shouldIgnore('/other')).toBe(false);
    });

    test('matches exact path with anchors', () => {
      // Arrange
      const svc = new RTIHelperService({ ignorePaths: [/^\/ping$/] } as any);

      // Act & Assert
      expect(svc.shouldIgnore('/ping')).toBe(true);
      expect(svc.shouldIgnore('/ping/extra')).toBe(false);
      expect(svc.shouldIgnore('/not-ping')).toBe(false);
    });

    test('matches any of multiple patterns', () => {
      // Arrange
      const svc = new RTIHelperService({ ignorePaths: [/^\/health/, /^\/static/, /^\/api\/v1/] } as any);

      // Act & Assert
      expect(svc.shouldIgnore('/health')).toBe(true);
      expect(svc.shouldIgnore('/static/main.css')).toBe(true);
      expect(svc.shouldIgnore('/api/v1/users')).toBe(true);
      expect(svc.shouldIgnore('/api/v2/users')).toBe(false);
      expect(svc.shouldIgnore('/home')).toBe(false);
    });

    test('matches static asset file extensions', () => {
      // Arrange
      const svc = new RTIHelperService({ ignorePaths: [/\.(js|css|png|jpg|svg|ico|woff2?)$/i] } as any);

      // Act & Assert
      expect(svc.shouldIgnore('/main.js')).toBe(true);
      expect(svc.shouldIgnore('/styles.css')).toBe(true);
      expect(svc.shouldIgnore('/logo.PNG')).toBe(true);   // case-insensitive
      expect(svc.shouldIgnore('/font.woff2')).toBe(true);
      expect(svc.shouldIgnore('/page')).toBe(false);
      expect(svc.shouldIgnore('/download')).toBe(false);
    });

    test('matches using combination of prefix and extension patterns', () => {
      // Arrange
      const svc = new RTIHelperService({ ignorePaths: [/^\/static/, /\.(js|css|png)$/] } as any);

      // Act & Assert
      expect(svc.shouldIgnore('/static/bundle.js')).toBe(true);  // prefix
      expect(svc.shouldIgnore('/other/main.css')).toBe(true);    // extension
      expect(svc.shouldIgnore('/dynamic/page')).toBe(false);     // neither
    });
  });
  // #endregion shouldIgnore Method Tests

  // #region getEventType Method Tests
  describe('getEventType', () => {
    test('returns PAGE_LOAD when routeToEventType is not configured', () => {
      // Arrange
      const svc = new RTIHelperService({} as any);

      // Act & Assert
      expect(svc.getEventType('/any', 'GET')).toBe('page_load');
    });

    test('returns mapped event type when path and method both match', () => {
      // Arrange
      const mapping = [{ path: /^\/api\//, method: /^GET$/, event_type: 'API' } as any];
      const svc = new RTIHelperService({ routeToEventType: mapping } as any);

      // Act & Assert
      expect(svc.getEventType('/api/x', 'GET')).toBe('API');
    });

    test('returns PAGE_LOAD when path matches but method does not', () => {
      // Arrange
      const mapping = [{ path: /^\/api\//, method: /^GET$/, event_type: 'API' } as any];
      const svc = new RTIHelperService({ routeToEventType: mapping } as any);

      // Act & Assert
      expect(svc.getEventType('/api/x', 'POST')).toBe('page_load');
    });

    test('returns PAGE_LOAD when no mapping matches', () => {
      // Arrange
      const mapping = [{ path: /^\/api\//, method: /^GET$/, event_type: 'API' } as any];
      const svc = new RTIHelperService({ routeToEventType: mapping } as any);

      // Act & Assert
      expect(svc.getEventType('/other', 'GET')).toBe('page_load');
    });

    test('returns PAGE_LOAD when routeToEventType is empty array', () => {
      // Arrange
      const svc = new RTIHelperService({ routeToEventType: [] } as any);

      // Act & Assert
      expect(svc.getEventType('/api/x', 'GET')).toBe('page_load');
    });

    test('returns first matching route when multiple routes match', () => {
      // Arrange
      const mapping = [
        { path: /^\/api\//, method: /^GET$/, event_type: 'FIRST' },
        { path: /^\/api\//, method: /^GET$/, event_type: 'SECOND' },
      ] as any;
      const svc = new RTIHelperService({ routeToEventType: mapping } as any);

      // Act & Assert
      expect(svc.getEventType('/api/x', 'GET')).toBe('FIRST');
    });

    test('supports pipe-separated method string', () => {
      // Arrange
      const mapping = [{ path: '/api/cart', method: 'POST|PUT', event_type: 'CART' } as any];
      const svc = new RTIHelperService({ routeToEventType: mapping } as any);

      // Act & Assert
      expect(svc.getEventType('/api/cart', 'POST')).toBe('CART');
      expect(svc.getEventType('/api/cart', 'PUT')).toBe('CART');
    });

    test('supports end-anchored regex path', () => {
      // Arrange
      const mapping = [{ path: /^\/api\/payment$/, method: /^POST$/, event_type: 'PAY' } as any];
      const svc = new RTIHelperService({ routeToEventType: mapping } as any);

      // Act & Assert
      expect(svc.getEventType('/api/payment', 'POST')).toBe('PAY');
      expect(svc.getEventType('/api/payment/extra', 'POST')).toBe('page_load');
    });
  });
  // #endregion getEventType Method Tests

  // #region getAction Method Tests
  describe('getAction', () => {
    const resp = (code: number, verdict: string, reasons: string[] = []) => ({
      classification: { code },
      decision: { verdict },
      cheqDetection: { reasons },
    } as any);

    // MONITORING mode always allows
    test('returns ALLOW in MONITORING mode regardless of verdict or code', () => {
      // Arrange
      const svc = new RTIHelperService({ mode: Mode.MONITORING, blockTTCodes: [100] } as any);

      // Act & Assert
      expect(svc.getAction(resp(100, 'malicious'))).toBe(Action.ALLOW);
    });

    // BLOCKING mode — no match → ALLOW
    test('returns ALLOW in BLOCKING mode for benign verdict with no matching codes', () => {
      // Arrange
      const svc = new RTIHelperService({ mode: Mode.BLOCKING } as any);

      // Act & Assert
      expect(svc.getAction(resp(1, 'benign'))).toBe(Action.ALLOW);
    });

    test('returns ALLOW in BLOCKING mode when all TTCodes and reasons are configured but none match', () => {
      // Arrange
      const svc = new RTIHelperService({
        mode: Mode.BLOCKING,
        blockTTCodes: [100], blockReasons: ['block-reason'],
        challengeTTCodes: [200], challengeReasons: ['challenge-reason'],
        redirectTTCodes: [300], redirectReasons: ['redirect-reason'],
      } as any);

      // Act & Assert
      expect(svc.getAction(resp(1, 'benign', ['other-reason']))).toBe(Action.ALLOW);
    });

    // BLOCK triggers
    test.each([
      ['malicious verdict',    { code: 1,   verdict: 'malicious', reasons: [] },      {}],
      ['matching blockTTCode', { code: 100, verdict: 'benign',    reasons: [] },      { blockTTCodes: [100] }],
      ['matching blockReason', { code: 1,   verdict: 'benign',    reasons: ['rx'] },  { blockReasons: ['rx'] }],
    ])('returns BLOCK for %s', (_label, { code, verdict, reasons }, extra) => {
      // Arrange
      const svc = new RTIHelperService({ mode: Mode.BLOCKING, ...extra } as any);

      // Act & Assert
      expect(svc.getAction(resp(code, verdict, reasons))).toBe(Action.BLOCK);
    });

    // CHALLENGE triggers
    test.each([
      ['suspicious verdict',      { code: 1,   verdict: 'suspicious', reasons: [] },      {}],
      ['matching challengeTTCode',{ code: 200, verdict: 'benign',      reasons: [] },      { challengeTTCodes: [200] }],
      ['matching challengeReason',{ code: 1,   verdict: 'benign',      reasons: ['ry'] },  { challengeReasons: ['ry'] }],
    ])('returns CHALLENGE for %s', (_label, { code, verdict, reasons }, extra) => {
      // Arrange
      const svc = new RTIHelperService({ mode: Mode.BLOCKING, ...extra } as any);

      // Act & Assert
      expect(svc.getAction(resp(code, verdict, reasons))).toBe(Action.CHALLENGE);
    });

    // REDIRECT triggers
    test.each([
      ['matching redirectTTCode', { code: 300, verdict: 'benign', reasons: [] },      { redirectTTCodes: [300] }],
      ['matching redirectReason', { code: 1,   verdict: 'benign', reasons: ['rz'] },  { redirectReasons: ['rz'] }],
    ])('returns REDIRECT for %s', (_label, { code, verdict, reasons }, extra) => {
      // Arrange
      const svc = new RTIHelperService({ mode: Mode.BLOCKING, ...extra } as any);

      // Act & Assert
      expect(svc.getAction(resp(code, verdict, reasons))).toBe(Action.REDIRECT);
    });
  });
  // #endregion getAction Method Tests

  // #region getActionStrategy Method Tests
  describe('getActionStrategy', () => {
    test('returns configured blockingStrategy', () => {
      // Arrange
      const svc = new RTIHelperService({ blockingStrategy: ActionStrategy.NOT_FOUND } as any);

      // Act & Assert
      expect(svc.getActionStrategy(Action.BLOCK)).toBe(ActionStrategy.NOT_FOUND);
    });

    test('returns ACCESS_DENIED as default when blockingStrategy is not configured', () => {
      // Arrange
      const svc = new RTIHelperService({} as any);

      // Act & Assert
      expect(svc.getActionStrategy(Action.BLOCK)).toBe(ActionStrategy.ACCESS_DENIED);
    });

    test('returns configured challengingStrategy', () => {
      // Arrange
      const svc = new RTIHelperService({ challengingStrategy: ActionStrategy.ACCESS_DENIED } as any);

      // Act & Assert
      expect(svc.getActionStrategy(Action.CHALLENGE)).toBe(ActionStrategy.ACCESS_DENIED);
    });

    test('returns CAPTCHA as default when challengingStrategy is not configured', () => {
      // Arrange
      const svc = new RTIHelperService({} as any);

      // Act & Assert
      expect(svc.getActionStrategy(Action.CHALLENGE)).toBe(ActionStrategy.CAPTCHA);
    });

    test('returns REDIRECT for REDIRECT action', () => {
      // Arrange
      const svc = new RTIHelperService({} as any);

      // Act & Assert
      expect(svc.getActionStrategy(Action.REDIRECT)).toBe(ActionStrategy.REDIRECT);
    });

    test('returns null for ALLOW action', () => {
      // Arrange
      const svc = new RTIHelperService({} as any);

      // Act & Assert
      expect(svc.getActionStrategy(Action.ALLOW)).toBeNull();
    });

    test('returns REDIRECT when blockingStrategy is REDIRECT', () => {
      // Arrange
      const svc = new RTIHelperService({ blockingStrategy: ActionStrategy.REDIRECT } as any);

      // Act & Assert
      expect(svc.getActionStrategy(Action.BLOCK)).toBe(ActionStrategy.REDIRECT);
    });

    test('returns CAPTCHA when blockingStrategy is CAPTCHA', () => {
      // Arrange
      const svc = new RTIHelperService({ blockingStrategy: ActionStrategy.CAPTCHA } as any);

      // Act & Assert
      expect(svc.getActionStrategy(Action.BLOCK)).toBe(ActionStrategy.CAPTCHA);
    });
  });
  // #endregion getActionStrategy Method Tests

  // #region validateConfig Method Tests
  describe('validateConfig', () => {
    test('returns error when redirectReasons defined but redirectLocation is not', () => {
      // Arrange
      const svc = new RTIHelperService({ redirectReasons: ['r1'], redirectLocation: undefined } as any);

      // Act
      const errors = svc.validateConfig();

      // Assert
      expect(errors.length).toBeGreaterThan(0);
    });

    test('returns error when redirectLocation defined but redirectReasons is not', () => {
      // Arrange
      const svc = new RTIHelperService({ redirectLocation: 'https://x', redirectReasons: undefined } as any);

      // Act
      const errors = svc.validateConfig();

      // Assert
      expect(errors.length).toBeGreaterThan(0);
    });

    test('returns no errors when both redirectReasons and redirectLocation are defined', () => {
      // Arrange
      const svc = new RTIHelperService({ redirectReasons: ['r1'], redirectLocation: 'https://x' } as any);

      // Act
      const errors = svc.validateConfig();

      // Assert
      expect(errors).toHaveLength(0);
    });

    test('returns no errors when neither redirectReasons nor redirectLocation are defined', () => {
      // Arrange
      const svc = new RTIHelperService({} as any);

      // Act
      const errors = svc.validateConfig();

      // Assert
      expect(errors).toHaveLength(0);
    });

    test('returns no errors when redirectReasons is empty array (no redirect configured)', () => {
      // Arrange
      const svc = new RTIHelperService({ redirectReasons: [], redirectLocation: undefined } as any);

      // Act
      const errors = svc.validateConfig();

      // Assert
      expect(errors).toHaveLength(0);
    });
  });
  // #endregion validateConfig Method Tests


  // #region Inheritance Tests
  // The method tests for the config-free helpers live in rti-stateless-utils.spec.ts and test that class directly,
  // so none of them would notice if this class stopped extending it. The integrations call those helpers through
  // RTIHelperService (e.g. rtiHelperService.parseCookies, RTIHelperService.parseNumberList), so this checks the link.
  describe('inheritance', () => {
    test('extends RTIStatelessUtils, so the config-free helpers are available on the service', () => {
      expect(new RTIHelperService({} as any)).toBeInstanceOf(RTIStatelessUtils);
    });
  });
  // #endregion Inheritance Tests
});
