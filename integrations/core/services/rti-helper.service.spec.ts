// cspell:ignore cheq rayid
import { describe, test, expect } from 'vitest';
import { RTIHelperService } from './rti-helper.service';
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

  // #region getCheqCookie Method Tests
  describe('getCheqCookie', () => {
    const svc = new RTIHelperService({} as any);

    test('returns undefined for empty string', () => {
      // Act & Assert
      expect(svc.getCheqCookie('')).toBeUndefined();
    });

    test('returns cookie value when present', () => {
      // Act & Assert
      expect(svc.getCheqCookie('_cheq_rti=abc123; other=1')).toBe('abc123');
    });

    test('returns empty string when _cheq_rti is not in cookie string', () => {
      // Act & Assert
      expect(svc.getCheqCookie('session=xyz; theme=dark')).toBe('');
    });

    test('finds _cheq_rti when not the first cookie', () => {
      // Act & Assert
      expect(svc.getCheqCookie('session=xyz; _cheq_rti=token99')).toBe('token99');
    });
  });
  // #endregion getCheqCookie Method Tests

  // #region capitalize Method Tests
  describe('capitalize', () => {
    const svc = new RTIHelperService({} as any);

    test('capitalizes each word with default space splitter', () => {
      // Act & Assert
      expect(svc.capitalize('hello world')).toBe('Hello World');
    });

    test('capitalizes single word', () => {
      // Act & Assert
      expect(svc.capitalize('hello')).toBe('Hello');
    });

    test('capitalizes with custom splitter', () => {
      // Act & Assert
      expect(svc.capitalize('x-y-z', '-')).toBe('X-Y-Z');
    });

    test('returns empty string when called with no arguments', () => {
      // Act & Assert
      expect(svc.capitalize()).toBe('');
    });

    test('handles already-capitalized input', () => {
      // Act & Assert
      expect(svc.capitalize('Hello')).toBe('Hello');
    });

    test('capitalizes header-style name with hyphen splitter', () => {
      // Act & Assert
      expect(svc.capitalize('x-forwarded-for', '-')).toBe('X-Forwarded-For');
    });

    test('handles single character', () => {
      // Act & Assert
      expect(svc.capitalize('a')).toBe('A');
    });
  });
  // #endregion capitalize Method Tests

  // #region getHeaderByName Method Tests
  describe('getHeaderByName', () => {
    const svc = new RTIHelperService({} as any);
    const headers: any = { 'content-type': 'text/html', 'X-Custom-Header': 'value' };

    test('finds header by lowercase name', () => {
      // Act & Assert
      expect(svc.getHeaderByName(headers, 'content-type')).toBe('text/html');
    });

    test('finds header by capitalized name', () => {
      // Act & Assert
      expect(svc.getHeaderByName(headers, 'x-custom-header')).toBe('value');
    });

    test('returns provided default when header is missing', () => {
      // Act & Assert
      expect(svc.getHeaderByName(headers, 'missing', 'fallback')).toBe('fallback');
    });

    test('returns undefined when header is missing and no default provided', () => {
      // Act & Assert
      expect(svc.getHeaderByName(headers, 'missing')).toBeUndefined();
    });

    test('returns undefined when called without name argument (uses default empty string)', () => {
      // Act & Assert
      expect(svc.getHeaderByName(headers)).toBeUndefined();
    });

    test('prefers lowercase key over title-case key when both exist', () => {
      // Arrange
      const h: any = { 'content-type': 'lower', 'Content-Type': 'title' };

      // Act & Assert
      expect(svc.getHeaderByName(h, 'content-type')).toBe('lower');
    });

    test('returns title-cased header (X-Forwarded-For) via lowercase lookup', () => {
      // Arrange
      const h: any = { 'X-Forwarded-For': '1.2.3.4' };

      // Act & Assert
      expect(svc.getHeaderByName(h, 'x-forwarded-for')).toBe('1.2.3.4');
    });

    test('returns numeric defaultValue when header is missing', () => {
      // Act & Assert
      expect(svc.getHeaderByName(headers, 'missing', 0)).toBe(0);
    });
  });
  // #endregion getHeaderByName Method Tests

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

  // #region parseCookies Method Tests
  describe('parseCookies', () => {
    const svc = new RTIHelperService({} as any);

    // --- Empty / missing input ---

    test('returns all undefined for empty string', () => {
      // Act
      const result = svc.parseCookies('');

      // Assert
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
      expect(result.sCookie).toBeUndefined();
    });

    test('does not throw when called with null (runtime guard)', () => {
      // Act
      const result = svc.parseCookies(null as any);

      // Assert
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
      expect(result.sCookie).toBeUndefined();
    });

    test('does not throw when called with undefined (runtime guard)', () => {
      // Act
      const result = svc.parseCookies(undefined as any);

      // Assert
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
      expect(result.sCookie).toBeUndefined();
    });

    test('returns all undefined when no CHEQ cookies are present', () => {
      // Act
      const result = svc.parseCookies('session=abc123; theme=dark; other=ignored');

      // Assert
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
      expect(result.sCookie).toBeUndefined();
    });

    // --- Individual cookie extraction ---

    test('extracts only _cq_duid when present', () => {
      // Act
      const result = svc.parseCookies('_cq_duid=4.16a154e6ae45bc91bf9a49b365beb989');

      // Assert
      expect(result.duidCookie).toBe('4.16a154e6ae45bc91bf9a49b365beb989');
      expect(result.pvidCookie).toBeUndefined();
      expect(result.sCookie).toBeUndefined();
    });

    test('extracts only _cq_pvid when present', () => {
      // Act
      const result = svc.parseCookies('_cq_pvid=4.247bcdf08360a9de9dee2196c1a36631');

      // Assert
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBe('4.247bcdf08360a9de9dee2196c1a36631');
      expect(result.sCookie).toBeUndefined();
    });

    test('extracts only _cq_s when present', () => {
      // Act
      const result = svc.parseCookies('_cq_s=simple-value');

      // Assert
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
      expect(result.sCookie).toBe('simple-value');
    });

    // --- All three together ---

    test('extracts all three cookies when all present', () => {
      // Act
      const b64 = 'Ll7dvXH3YTlLM7nA:0pSlsKE44ASXSpI4yGmRpP+Rdwm3eR4RvkFIY60Jz1E/mWlZSilQ7METgbQuPTv1nfazHTyvz6qWSGx6GEeMYj9gTIIS38l/v7sO/xjLE7QVlUGtCQQS+5thTzsVRLejEV/3lrOQspnfY9sp5D5lGaEYa+k3yxdOjLp1kEVk/m7RQh2Nb1+Vbn+NaSRQ6CGIgJ/5BnEkYA==';

      const result = svc.parseCookies(`_cq_duid=4.16a154e6ae45bc91bf9a49b365beb989; _cq_pvid=4.247bcdf08360a9de9dee2196c1a36631; _cq_s=${b64}`);

      // Assert
      expect(result.duidCookie).toBe('4.16a154e6ae45bc91bf9a49b365beb989');
      expect(result.pvidCookie).toBe('4.247bcdf08360a9de9dee2196c1a36631');
      expect(result.sCookie).toBe(b64);
    });

    // --- Noise cookies around CHEQ cookies ---

    test('ignores unrelated cookies when extracting all three', () => {
      // Arrange
      const b64 = 'Ll7dvXH3YTlLM7nA:0pSlsKE44ASXSpI4yGmRpP+Rdwm3eR4RvkFIY60Jz1E/mWlZSilQ7METgbQuPTv1nfazHTyvz6qWSGx6GEeMYj9gTIIS38l/v7sO/xjLE7QVlUGtCQQS+5thTzsVRLejEV/3lrOQspnfY9sp5D5lGaEYa+k3yxdOjLp1kEVk/m7RQh2Nb1+Vbn+NaSRQ6CGIgJ/5BnEkYA==:uAmNscAbgD/vSVVN3OE4Ow==';

      // Act
      const result = svc.parseCookies(`session=abc123; _cq_duid=d-uuid-xyz; theme=dark; _cq_pvid=pv-ulid-abc; _cq_s=${b64}; other=ignored`);

      // Assert
      expect(result.duidCookie).toBe('d-uuid-xyz');
      expect(result.pvidCookie).toBe('pv-ulid-abc');
      expect(result.sCookie).toBe(b64);
    });

    // --- Base64 padding in _cq_s ---

    test('preserves base64 = padding characters in _cq_s', () => {
      // Arrange
      const b64 = 'c0hdForhWGaRercD:kc/eGTcRHnanstWrlbv6fnBWg/kICuKe+hRiK6x9lCwkrSdhpKIohwyd7/JHH3aA81pNurK0WfbwmJfGwL61DFBsgrr3wYpT8muwEt/xhOrFe3Ejee4W86fnE/fe0l1b1+ld6JwCiA7tueF0weoJStmpVEKW8PTz+JTkOf9jMfEE/HYNMrG22F+h7w68Td+JeCURnRPp48TbVAtusLvNuwWwWSyuI/7OfV6akdMrey+Mr2b8i8+w9Cm58M+Ttq1ydQPcQbHGOPfI5InnCSqHbGT0mUMxdodBMXFmvQgTN07lge/+zjGSH2+s+a0b60QlNOa6rw==:Ki6FWCQbEiMijlXZ/6/BNQ==';

      // Act
      const result = svc.parseCookies(`_cq_s=${b64}`);

      // Assert
      expect(result.sCookie).toBe(b64);
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
    });

    test('preserves base64 = padding in _cq_s when mixed with other cookies', () => {
      // Arrange
      const b64 = 'Qxr2YUViJVxjN/Lj:/ZN3E52EztskUvgEC4J+kf4iZ5bM0INszRKC8IWXUzH2Qm2K4ByU/oBBroRABQOUoSPEqH8kulCnl7oy3AcaXS/RlwFPROQ7YzzGVwxWos6lTFMMbRgDlTkC7uwA50UwqlkWjrmEmmimz5gEQQc0HaDHw7TDo7INomrDm2vnJFMyKieBu0sD8k6cM1f9ORUphNF+Lezms73AyIgC7YV1RK3T3T8kpIkePoTrjzCFtM4rWQ9IHmk4Qcb39TUK+TOIyr38Sb/oODE25SLwyCgQY1KDVjyb452nlo1+E55bxXMmkocgnqDqyOOjTqtoYqROmYRhQcrjVr13gX4NPj/1OOp3pwSUsR0E1ji0VfArMzRZ6H4TfL610HnxF87NNVlyIwg+2lXu5md4PaC2pCck7q7q3fEcB+QkeA+fdlhuiI6s++MQ4+2FNyqZiIoLz/2vrLdVDgbVchS9kb3vJljm4gAswQbZHT50zrQKpXJZtduxYsWIbNOyrF2VGrzTDwyBpTumYaA+jcisuSax/Gntjtl5thWkFaq6iRYdIEFLDDK7SyMlylFGEHg8O4/Sh8ha0j3CX3Q=:GwUKuinki4bX6547azx1Rw==';

      // Act
      const result = svc.parseCookies(`session=abc; _cq_duid=d-uuid; _cq_pvid=pv-ulid; _cq_s=${b64}`);

      // Assert
      expect(result.duidCookie).toBe('d-uuid');
      expect(result.pvidCookie).toBe('pv-ulid');
      expect(result.sCookie).toBe(b64);
    });

    // --- Prefix overlap: _cq_se must not match _cq_s ---

    test('does not extract _cq_se as _cq_s', () => {
      // Act
      const result = svc.parseCookies('_cq_se=token|rayid; _cq_s=real-value');

      // Assert
      expect(result.sCookie).toBe('real-value');
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
    });

    test('returns undefined for _cq_s when only _cq_se is present', () => {
      // Act
      const result = svc.parseCookies('_cq_se=token|rayid');

      // Assert
      expect(result.sCookie).toBeUndefined();
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
    });

    // --- Special characters in values ---

    test('preserves / + : characters in _cq_s value', () => {
      // Act
      const result = svc.parseCookies('_cq_s=abc/def+ghi:jkl');

      // Assert
      expect(result.sCookie).toBe('abc/def+ghi:jkl');
      expect(result.pvidCookie).toBeUndefined();
      expect(result.duidCookie).toBeUndefined();
    });

    // --- Whitespace handling ---

    test('trims leading/trailing whitespace around each cookie token', () => {
      // Act
      const result = svc.parseCookies('  _cq_duid=d-abc  ;  _cq_pvid=pv-xyz  ;  _cq_s=s-val  ');

      // Assert
      expect(result.duidCookie).toBe('d-abc');
      expect(result.pvidCookie).toBe('pv-xyz');
      expect(result.sCookie).toBe('s-val');
    });

    // --- Empty cookie value ---

    test('returns undefined when _cq_s has no value', () => {
      // Act
      const result = svc.parseCookies('_cq_s=');

      // Assert
      expect(result.sCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
      expect(result.duidCookie).toBeUndefined();

    });

    test('returns undefined when _cq_duid has no value', () => {
      // Act
      const result = svc.parseCookies('_cq_duid=');

      // Assert
      expect(result.sCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
      expect(result.duidCookie).toBeUndefined();
    });

    // --- Empty segments (double semicolons) ---

    test('handles empty segments from double semicolons gracefully', () => {
      // Act
      const result = svc.parseCookies('_cq_duid=d-abc;; _cq_s=s-val');

      // Assert
      expect(result.duidCookie).toBe('d-abc');
      expect(result.sCookie).toBe('s-val');
      expect(result.pvidCookie).toBeUndefined();
    });

    // --- Duplicate cookie names ---

    test('returns first match when _cq_s appears twice', () => {
      // Act
      const result = svc.parseCookies('_cq_s=first; _cq_s=second');

      // Assert
      expect(result.sCookie).toBe('first');
    });
  });
  // #endregion parseCookies Method Tests

  // #region buildRtiResultHeader Method Tests
  describe('buildRtiResultHeader', () => {
    const svc = new RTIHelperService({} as any);

    function buildResponse(overrides: { verdict?: string; code?: number; version?: string; ids?: any } = {}) {
      return {
        metadata: { version: overrides.version ?? '4.1' },
        decision: { verdict: overrides.verdict ?? 'benign' },
        classification: { code: overrides.code ?? 0 },
        ids: overrides.ids ?? { rayId: 'ray-1', pageViewId: null, duid: null, uniqueVisitId: null, customParam1: null, customParam2: null },
      } as any;
    }

    const defaultIds = { rayId: 'ray-1', pageViewId: null, duid: null, uniqueVisitId: null, customParam1: null, customParam2: null };

    test('produces correct output for default response', () => {
      // Act
      const result = svc.buildRtiResultHeader(buildResponse());

      // Assert
      expect(result).toBe(`version=4.1;verdict=benign;threat-type-code=0;ids=${JSON.stringify(defaultIds)}`);
    });

    test('produces correct output with version 4.1', () => {
      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ version: '4.1' }));

      // Assert
      expect(result).toBe(`version=4.1;verdict=benign;threat-type-code=0;ids=${JSON.stringify(defaultIds)}`);
    });

    test('produces correct output with malicious verdict', () => {
      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ verdict: 'malicious' }));

      // Assert
      expect(result).toBe(`version=4.1;verdict=malicious;threat-type-code=0;ids=${JSON.stringify(defaultIds)}`);
    });

    test('produces correct output with threat-type-code 5', () => {
      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ code: 5 }));

      // Assert
      expect(result).toBe(`version=4.1;verdict=benign;threat-type-code=5;ids=${JSON.stringify(defaultIds)}`);
    });

    test('preserves null pageViewId in ids JSON', () => {
      // Act
      const result = svc.buildRtiResultHeader(buildResponse());

      // Assert
      expect(result).toBe(`version=4.1;verdict=benign;threat-type-code=0;ids=${JSON.stringify(defaultIds)}`);
    });

    test('produces correct output matching real benign response shape', () => {
      // Arrange
      const ids = { rayId: 'd07fd4d7105b1bf24912745b1fde2c55', pageViewId: null, duid: null, uniqueVisitId: null, customParam1: 'page_load', customParam2: 'a024abc8ff1b2674' };

      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ version: '4.1', verdict: 'benign', code: 0, ids }));

      // Assert
      expect(result).toBe('version=4.1;verdict=benign;threat-type-code=0;ids={"rayId":"d07fd4d7105b1bf24912745b1fde2c55","pageViewId":null,"duid":null,"uniqueVisitId":null,"customParam1":"page_load","customParam2":"a024abc8ff1b2674"}');
    });

    test('produces correct full output for all fields combined', () => {
      // Arrange
      const ids = { rayId: 'f3a1c2e4b5d6789012345678abcdef01', pageViewId: '9e8d7c6b5a4f3e2d', duid: '4.16a154e6ae45bc91bf9a49b365beb989', uniqueVisitId: 'uv-4f3e2d1c0b9a8765', customParam1: 'page_load', customParam2: 'cf-ray-abc123' };

      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ version: '4.1', verdict: 'malicious', code: 6, ids }));

      // Assert
      expect(result).toBe(`version=4.1;verdict=malicious;threat-type-code=6;ids=${JSON.stringify(ids)}`);
    });
  });
  // #endregion buildRtiResultHeader Method Tests

  // #region parseNumberList Method Tests
  describe('parseNumberList', () => {
    test('returns undefined for undefined input', () => {
      // Act & Assert
      expect(RTIHelperService.parseNumberList(undefined)).toBeUndefined();
    });

    test('returns undefined for null input', () => {
      const input: any = null;
      // Act & Assert
      expect(RTIHelperService.parseNumberList(input)).toBeUndefined();
    });

    test('returns undefined for empty string', () => {
      // Act & Assert
      expect(RTIHelperService.parseNumberList('')).toBeUndefined();
    });

    test('parses a single number', () => {
      // Act & Assert
      expect(RTIHelperService.parseNumberList('5')).toEqual([5]);
    });

    test('parses multiple comma-separated numbers', () => {
      // Act & Assert
      expect(RTIHelperService.parseNumberList('4,5,6')).toEqual([4, 5, 6]);
    });

    test('trims spaces around each value', () => {
      // Act & Assert
      expect(RTIHelperService.parseNumberList(' 4 , 5 , 6 ')).toEqual([4, 5, 6]);
    });

    test('filters trailing comma', () => {
      // Act & Assert
      expect(RTIHelperService.parseNumberList('4,5,')).toEqual([4, 5]);
    });

    test('filters leading comma', () => {
      // Act & Assert
      expect(RTIHelperService.parseNumberList(',4,5')).toEqual([4, 5]);
    });

    test('skips non-numeric entries', () => {
      // Act & Assert
      expect(RTIHelperService.parseNumberList('4,abc,6')).toEqual([4, 6]);
    });

    test('returns undefined when all entries are non-numeric', () => {
      // Act & Assert
      expect(RTIHelperService.parseNumberList('abc,def')).toBeUndefined();
    });

    test('parses negative numbers', () => {
      // Act & Assert
      expect(RTIHelperService.parseNumberList('-1,3')).toEqual([-1, 3]);
    });

    test('truncates decimals via parseInt', () => {
      // Act & Assert
      expect(RTIHelperService.parseNumberList('4.7,5.2')).toEqual([4, 5]);
    });
  });
  // #endregion parseNumberList Method Tests

  // #region parseStringList Method Tests
  describe('parseStringList', () => {
    test('returns undefined for undefined input', () => {
      // Act & Assert
      expect(RTIHelperService.parseStringList(undefined)).toBeUndefined();
    });

    test('returns undefined for null input', () => {
      // Act & Assert
      expect(RTIHelperService.parseStringList(null as any)).toBeUndefined();
    });

    test('returns undefined for empty string', () => {
      // Act & Assert
      expect(RTIHelperService.parseStringList('')).toBeUndefined();
    });

    test('returns undefined for whitespace-only entries', () => {
      // Act & Assert
      expect(RTIHelperService.parseStringList(' , , ')).toBeUndefined();
    });

    test('parses a single value', () => {
      // Act & Assert
      expect(RTIHelperService.parseStringList('/health')).toEqual(['/health']);
    });

    test('parses multiple comma-separated values', () => {
      // Act & Assert
      expect(RTIHelperService.parseStringList('/health,/ping')).toEqual(['/health', '/ping']);
    });

    test('trims spaces around each value', () => {
      // Act & Assert
      expect(RTIHelperService.parseStringList(' /health , /ping ')).toEqual(['/health', '/ping']);
    });

    test('filters trailing comma', () => {
      // Act & Assert
      expect(RTIHelperService.parseStringList('/health,')).toEqual(['/health']);
    });

    test('filters leading comma', () => {
      // Act & Assert
      expect(RTIHelperService.parseStringList(',/health')).toEqual(['/health']);
    });

    test('filters consecutive empty entries', () => {
      // Act & Assert
      expect(RTIHelperService.parseStringList('/a,,/b')).toEqual(['/a', '/b']);
    });

    test('preserves regex-like patterns intact', () => {
      // Act & Assert
      expect(RTIHelperService.parseStringList('\\.css$,\\.js$')).toEqual(['\\.css$', '\\.js$']);
    });
  });
  // #endregion parseStringList Method Tests

  // #region getCookieValue Method Tests
  describe('getCookieValue', () => {
    const svc = new RTIHelperService({} as any);

    test('returns value for matching cookie', () => {
      // Act & Assert
      expect(svc.getCookieValue(['_cq_duid=abc123'], '_cq_duid=')).toBe('abc123');
    });

    test('returns undefined when cookie not found', () => {
      // Act & Assert
      expect(svc.getCookieValue(['other=val'], '_cq_duid=')).toBeUndefined();
    });

    test('returns undefined for empty array', () => {
      // Act & Assert
      expect(svc.getCookieValue([], '_cq_s=')).toBeUndefined();
    });

    test('returns undefined when value is empty', () => {
      // Act & Assert
      expect(svc.getCookieValue(['_cq_s='], '_cq_s=')).toBeUndefined();
    });

    test('preserves = characters in value (base64)', () => {
      // Act & Assert
      expect(svc.getCookieValue(['_cq_s=abc=='], '_cq_s=')).toBe('abc==');
    });

    test('does not match prefix overlap (_cq_se vs _cq_s)', () => {
      // Act & Assert
      expect(svc.getCookieValue(['_cq_se=token'], '_cq_s=')).toBeUndefined();
    });

    test('returns first match when duplicates exist', () => {
      // Act & Assert
      expect(svc.getCookieValue(['_cq_s=first', '_cq_s=second'], '_cq_s=')).toBe('first');
    });
  });
  // #endregion getCookieValue Method Tests
});
