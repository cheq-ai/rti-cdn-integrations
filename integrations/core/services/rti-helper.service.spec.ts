// cspell:ignore cheq rayid propfind
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
  describe('getStrategyForRequest', () => {
    const svc = (config: any = {}) => new RTIHelperService(config);

    test('ALLOW is null (forward), for every method', () => {
      expect(svc().getStrategyForRequest(Action.ALLOW, 'GET', '/x')).toEqual({ strategy: null });
      expect(svc().getStrategyForRequest(Action.ALLOW, 'POST', '/x')).toEqual({ strategy: null });
    });

    test('maps RTI\'s action like getActionStrategy for GET and HEAD, whatever actionOnSuspicious says', () => {
      const s = svc({ blockingStrategy: ActionStrategy.NOT_FOUND, actionOnSuspicious: { rules: [{ path: '.*', action: Action.ALLOW }] } });
      expect(s.getStrategyForRequest(Action.BLOCK, 'GET', '/x')).toEqual({ strategy: ActionStrategy.NOT_FOUND });
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'GET', '/x')).toEqual({ strategy: ActionStrategy.CAPTCHA });
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'HEAD', '/x')).toEqual({ strategy: ActionStrategy.CAPTCHA });
      expect(s.getStrategyForRequest(Action.REDIRECT, 'GET', '/x')).toEqual({ strategy: ActionStrategy.REDIRECT });
    });

    test.each([Action.BLOCK, Action.REDIRECT])('%s on a body method is kept: actionOnSuspicious is only for a CAPTCHA', (action) => {
      const s = svc({ actionOnSuspicious: { methods: { POST: Action.ALLOW } } });
      expect(s.getStrategyForRequest(action, 'POST', '/x')).toEqual({ strategy: s.getActionStrategy(action) });
    });

    test('a CHALLENGE on a body method with nothing set: forward, and says ALLOW decided it', () => {
      expect(svc().getStrategyForRequest(Action.CHALLENGE, 'POST', '/x')).toEqual({ strategy: null, actionOnSuspicious: Action.ALLOW });
    });

    test('a CHALLENGE on a body method follows actionOnSuspicious, mapped like any Action', () => {
      const s = svc({
        blockingStrategy: ActionStrategy.NOT_FOUND,
        actionOnSuspicious: { methods: { POST: Action.BLOCK, PUT: Action.REDIRECT, PATCH: Action.CHALLENGE, DELETE: Action.ALLOW } },
      });
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'POST', '/x')).toEqual({ strategy: ActionStrategy.NOT_FOUND, actionOnSuspicious: Action.BLOCK });
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'PUT', '/x')).toEqual({ strategy: ActionStrategy.REDIRECT, actionOnSuspicious: Action.REDIRECT });
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'PATCH', '/x')).toEqual({ strategy: ActionStrategy.CAPTCHA, actionOnSuspicious: Action.CHALLENGE });
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'DELETE', '/x')).toEqual({ strategy: null, actionOnSuspicious: Action.ALLOW });
    });

    test('a BLOCK shown as a CAPTCHA (blockingStrategy CAPTCHA) on a body method also follows actionOnSuspicious', () => {
      const s = svc({ blockingStrategy: ActionStrategy.CAPTCHA, actionOnSuspicious: { methods: { POST: Action.REDIRECT } } });
      expect(s.getStrategyForRequest(Action.BLOCK, 'POST', '/x')).toEqual({ strategy: ActionStrategy.REDIRECT, actionOnSuspicious: Action.REDIRECT });
    });

    test('uses the path for rules', () => {
      const s = svc({ actionOnSuspicious: { rules: [{ path: '^/login$', action: Action.BLOCK }] } });
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'POST', '/login').strategy).toBe(ActionStrategy.ACCESS_DENIED);
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'POST', '/search').strategy).toBeNull();
    });

    // With the page-load fact (the fourth argument), RTI's CHALLENGE with the CAPTCHA strategy asks three questions:
    // 1. a rule covers the request: it decides; 2. a page load: the page; 3. else the method's default, else ALLOW.
    const PAGE = { strategy: ActionStrategy.CAPTCHA };
    const FORWARD = { strategy: null, actionOnSuspicious: Action.ALLOW };
    const CHALLENGED = { strategy: ActionStrategy.CAPTCHA, actionOnSuspicious: Action.CHALLENGE };
    const TWO_RULES = {
      rules: [
        { path: '^/login$', methods: ['POST'], action: Action.CHALLENGE },
        { path: '^/api/', methods: ['GET'], action: Action.ALLOW },
      ],
    };

    test.each([
      ['GET /sofas, a page load: the page (question 2)', 'GET', '/sofas', true, PAGE],
      ['GET /api/cart, not a page load: forwarded, the GET rule says ALLOW (question 1)', 'GET', '/api/cart', false, FORWARD],
      ['GET /search/suggest, not a page load: forwarded, no rule and no default (question 3)', 'GET', '/search/suggest', false, FORWARD],
      ['GET /api/cart, a page load: forwarded, the rule decides before the page-load fact (question 1)', 'GET', '/api/cart', true, FORWARD],
      ['HEAD /sofas, not a page load: forwarded, no default (question 3)', 'HEAD', '/sofas', false, FORWARD],
      ['POST /login: the CAPTCHA, the POST rule says CHALLENGE (question 1)', 'POST', '/login', false, CHALLENGED],
      ['POST /api/order: forwarded, the GET rule does not cover POST (question 3)', 'POST', '/api/order', false, FORWARD],
      ['GET /login, not a page load: forwarded, the POST rule does not cover GET (question 3)', 'GET', '/login', false, FORWARD],
    ])('two rules, no defaults: %s', (_, method, path, isPageLoad, expected) => {
      // Arrange
      const s = svc({ actionOnSuspicious: TWO_RULES });

      // Act & Assert
      expect(s.getStrategyForRequest(Action.CHALLENGE, method, path, isPageLoad)).toEqual(expected);
    });

    test.each([
      ['get /api/cart, not a page load: forwarded, the GET rule says ALLOW (question 1)', 'get', '/api/cart', false, FORWARD],
      ['get /api/cart, a page load: forwarded, the rule decides before the page-load fact (question 1)', 'get', '/api/cart', true, FORWARD],
      ['post /login without the page-load fact: the CAPTCHA, the POST rule says CHALLENGE', 'post', '/login', undefined, CHALLENGED],
    ])('two rules, a method in lower case: %s', (_, method, path, isPageLoad, expected) => {
      // Arrange
      const s = svc({ actionOnSuspicious: TWO_RULES });

      // Act & Assert
      expect(s.getStrategyForRequest(Action.CHALLENGE, method, path, isPageLoad)).toEqual(expected);
    });

    test.each([
      ['GET /search/suggest', 'GET', '/search/suggest'],
      ['HEAD /sofas', 'HEAD', '/sofas'],
      ['GET /login', 'GET', '/login'],
    ])('two rules and methods { GET: CHALLENGE, HEAD: CHALLENGE }: %s, not a page load, gets the CAPTCHA, as before', (_, method, path) => {
      // Arrange
      const s = svc({ actionOnSuspicious: { ...TWO_RULES, methods: { GET: Action.CHALLENGE, HEAD: Action.CHALLENGE } } });

      // Act & Assert
      expect(s.getStrategyForRequest(Action.CHALLENGE, method, path, false)).toEqual(CHALLENGED);
    });

    test('the page-load fact comes before the default: with methods { GET: BLOCK } a page load gets the page, another GET is blocked', () => {
      // Arrange
      const s = svc({ actionOnSuspicious: { methods: { GET: Action.BLOCK } } });

      // Act & Assert
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'GET', '/sofas', true)).toEqual(PAGE);
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'GET', '/sofas', false)).toEqual({ strategy: ActionStrategy.ACCESS_DENIED, actionOnSuspicious: Action.BLOCK });
    });

    test('a rule without methods does not cover GET or HEAD: a page load gets the page, another GET or HEAD follows its default', () => {
      // Arrange: the rule covers the five methods with a body
      const s = svc({ actionOnSuspicious: { methods: { GET: Action.REDIRECT }, rules: [{ path: '^/api/', action: Action.BLOCK }] } });

      // Act & Assert
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'GET', '/api/cart', true)).toEqual(PAGE);
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'GET', '/api/cart', false)).toEqual({ strategy: ActionStrategy.REDIRECT, actionOnSuspicious: Action.REDIRECT });
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'HEAD', '/api/cart', false)).toEqual(FORWARD);
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'POST', '/api/cart', false)).toEqual({ strategy: ActionStrategy.ACCESS_DENIED, actionOnSuspicious: Action.BLOCK });
    });

    test.each([
      ['BLOCK', Action.BLOCK, ActionStrategy.NOT_FOUND],
      ['REDIRECT', Action.REDIRECT, ActionStrategy.REDIRECT],
    ])('%s from a GET rule or a GET default gets the strategy of getActionStrategy, with actionOnSuspicious set', (_, action, strategy) => {
      // Arrange
      const byRule = svc({ blockingStrategy: ActionStrategy.NOT_FOUND, actionOnSuspicious: { rules: [{ path: '^/api/', methods: ['GET'], action }] } });
      const byDefault = svc({ blockingStrategy: ActionStrategy.NOT_FOUND, actionOnSuspicious: { methods: { GET: action } } });
      expect(byRule.getActionStrategy(action)).toBe(strategy);

      // Act & Assert
      expect(byRule.getStrategyForRequest(Action.CHALLENGE, 'GET', '/api/cart', true)).toEqual({ strategy, actionOnSuspicious: action });
      expect(byRule.getStrategyForRequest(Action.CHALLENGE, 'GET', '/api/cart', false)).toEqual({ strategy, actionOnSuspicious: action });
      expect(byDefault.getStrategyForRequest(Action.CHALLENGE, 'GET', '/api/cart', false)).toEqual({ strategy, actionOnSuspicious: action });
    });

    test('a GET rule whose action is not an Action still decides for a page load: it counts as ALLOW, so the GET is forwarded', () => {
      // Arrange: the string 'BLOCK', not the enum
      const s = svc({ actionOnSuspicious: { rules: [{ path: '.*', methods: ['GET'], action: 'BLOCK' }] } });

      // Act & Assert
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'GET', '/sofas', true)).toEqual(FORWARD);
    });

    test('a block verdict shown as a CAPTCHA asks no question: a GET gets the page whatever GET settings say, a POST follows actionOnSuspicious', () => {
      // Arrange: blockingStrategy CAPTCHA, and GET settings that would forward a GET that is not a page load
      const withDefault = svc({ blockingStrategy: ActionStrategy.CAPTCHA, actionOnSuspicious: { methods: { GET: Action.ALLOW, POST: Action.REDIRECT } } });
      const withRule = svc({ blockingStrategy: ActionStrategy.CAPTCHA, actionOnSuspicious: { rules: [{ path: '^/api/', methods: ['GET'], action: Action.ALLOW }] } });

      // Act & Assert
      expect(withDefault.getStrategyForRequest(Action.BLOCK, 'GET', '/api/cart', false)).toEqual(PAGE);
      expect(withRule.getStrategyForRequest(Action.BLOCK, 'GET', '/api/cart', false)).toEqual(PAGE);
      expect(withDefault.getStrategyForRequest(Action.BLOCK, 'POST', '/api/cart', false)).toEqual({ strategy: ActionStrategy.REDIRECT, actionOnSuspicious: Action.REDIRECT });
    });

    test('without the page-load fact a GET and a HEAD get the page, as before, whatever the GET and HEAD settings say', () => {
      // Arrange: GET and HEAD settings that would forward them
      const s = svc({ actionOnSuspicious: {
        methods: { GET: Action.ALLOW, HEAD: Action.ALLOW },
        rules: [{ path: '^/api/', methods: ['GET', 'HEAD'], action: Action.ALLOW }],
      } });

      // Act & Assert
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'GET', '/api/cart')).toEqual(PAGE);
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'HEAD', '/api/cart')).toEqual(PAGE);
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'GET', '/sofas', undefined)).toEqual(PAGE);
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'HEAD', '/sofas', undefined)).toEqual(PAGE);
    });

    test('a strategy other than CAPTCHA is kept whatever the page-load fact', () => {
      // Arrange
      const s = svc({ challengingStrategy: ActionStrategy.ACCESS_DENIED, actionOnSuspicious: { methods: { GET: Action.ALLOW } } });

      // Act & Assert
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'GET', '/x', false)).toEqual({ strategy: ActionStrategy.ACCESS_DENIED });
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'GET', '/x', true)).toEqual({ strategy: ActionStrategy.ACCESS_DENIED });
      expect(s.getStrategyForRequest(Action.ALLOW, 'GET', '/x', true)).toEqual({ strategy: null });
    });

    test.each(['PROPFIND', 'CONNECT', 'TRACE'])('%s, not one of the seven methods and not a page load, is forwarded: ALLOW, also when a rule or a default names it', (method) => {
      // Arrange: a rule and a default that name the method, forced past the type
      const s = svc({ actionOnSuspicious: { methods: { [method]: Action.BLOCK }, rules: [{ path: '.*', methods: [method], action: Action.BLOCK }] } });

      // Act & Assert
      expect(s.getStrategyForRequest(Action.CHALLENGE, method, '/x', false)).toEqual(FORWARD);
    });

    test('a method outside the seven, in any case, is forwarded also with isPageLoad true: the method decides first', () => {
      // Arrange: isPageLoad is true only for a GET, so this caller passes a wrong fact
      const s = svc();

      // Act & Assert
      for (const method of ['PROPFIND', 'propfind', 'Trace']) {
        expect(s.getStrategyForRequest(Action.CHALLENGE, method, '/x', true)).toEqual(FORWARD);
      }
    });

    test.each([
      ['a POST with methods { POST: ALLOW } is forwarded', 'POST', { methods: { POST: Action.ALLOW } }, FORWARD],
      ['a HEAD with no default is forwarded', 'HEAD', {}, FORWARD],
      ['a HEAD with methods { HEAD: CHALLENGE } gets the CAPTCHA', 'HEAD', { methods: { HEAD: Action.CHALLENGE } }, CHALLENGED],
    ])('question 2 is asked only for a GET: with isPageLoad true, %s', (_, method, settings, expected) => {
      // Arrange: isPageLoad is true only for a GET, so this caller passes a wrong fact
      const s = svc({ actionOnSuspicious: settings });

      // Act & Assert
      expect(s.getStrategyForRequest(Action.CHALLENGE, method, '/x', true)).toEqual(expected);
    });

    test.each(['GET', 'get', 'Get'])('%s with isPageLoad true gets the page: a GET in any case is a GET', (method) => {
      // Act & Assert
      expect(svc().getStrategyForRequest(Action.CHALLENGE, method, '/sofas', true)).toEqual(PAGE);
    });

    test('null as the page-load fact counts as not passed: a GET gets the page as before, whatever its default says', () => {
      // Arrange: a caller in plain JS can pass null; forced past the type
      const s = svc({ actionOnSuspicious: { methods: { GET: Action.BLOCK } } });

      // Act & Assert
      expect(s.getStrategyForRequest(Action.CHALLENGE, 'GET', '/sofas', null as any)).toEqual(PAGE);
    });
  });

  describe('getActionOnSuspicious', () => {
    const svc = (actionOnSuspicious?: any) => new RTIHelperService({ actionOnSuspicious } as any);

    test('every method is ALLOW when nothing is set', () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        expect(svc().getActionOnSuspicious(method, '/x')).toBe(Action.ALLOW);
      }
    });

    test('uses the method default; a method not listed is ALLOW', () => {
      const s = svc({ methods: { POST: Action.BLOCK, PUT: Action.CHALLENGE } });
      expect(s.getActionOnSuspicious('POST', '/x')).toBe(Action.BLOCK);
      expect(s.getActionOnSuspicious('PUT', '/x')).toBe(Action.CHALLENGE);
      expect(s.getActionOnSuspicious('DELETE', '/x')).toBe(Action.ALLOW);
    });

    test('matches the method in any case', () => {
      expect(svc({ methods: { POST: Action.BLOCK } }).getActionOnSuspicious('post', '/x')).toBe(Action.BLOCK);
    });

    test.each([
      ['a rule that names POST', { rules: [{ path: '^/login$', methods: ['POST'], action: Action.BLOCK }] }],
      ['a rule without methods', { rules: [{ path: '^/login$', action: Action.BLOCK }] }],
    ])('matches a method in another case against %s', (_, settings) => {
      // Act & Assert
      expect(svc(settings).getActionOnSuspicious('post', '/login')).toBe(Action.BLOCK);
    });

    test('a matching rule wins over the method default; the first match wins', () => {
      const s = svc({
        methods: { POST: Action.ALLOW },
        rules: [
          { path: '^/login$', methods: ['POST'], action: Action.CHALLENGE },
          { path: '^/log', action: Action.BLOCK },
        ],
      });
      expect(s.getActionOnSuspicious('POST', '/login')).toBe(Action.CHALLENGE);
      expect(s.getActionOnSuspicious('PUT', '/login')).toBe(Action.BLOCK);
      expect(s.getActionOnSuspicious('POST', '/logout')).toBe(Action.BLOCK);
      expect(s.getActionOnSuspicious('POST', '/search')).toBe(Action.ALLOW);
    });

    test('a rule with methods applies only to them', () => {
      const s = svc({ rules: [{ path: '^/api/', methods: ['DELETE'], action: Action.BLOCK }] });
      expect(s.getActionOnSuspicious('DELETE', '/api/item')).toBe(Action.BLOCK);
      expect(s.getActionOnSuspicious('POST', '/api/item')).toBe(Action.ALLOW);
    });

    test('a rule with a bad regex never matches; the next rule or the default is used', () => {
      const s = svc({ methods: { POST: Action.REDIRECT }, rules: [{ path: '([', action: Action.BLOCK }] });
      expect(s.getActionOnSuspicious('POST', '/x')).toBe(Action.REDIRECT);
    });

    test.each([
      ['a rule that names it decides', { rules: [{ path: '^/api/', methods: ['GET', 'HEAD'], action: Action.BLOCK }] }, Action.BLOCK],
      ['its default decides', { methods: { GET: Action.REDIRECT, HEAD: Action.REDIRECT } }, Action.REDIRECT],
      ['with neither, it is ALLOW', { methods: { POST: Action.BLOCK } }, Action.ALLOW],
      ['a rule without methods does not cover it, so it is ALLOW', { rules: [{ path: '^/api/', action: Action.BLOCK }] }, Action.ALLOW],
    ])('GET and HEAD: %s', (_, settings, expected) => {
      // Arrange
      const s = svc(settings);

      // Act & Assert
      expect(s.getActionOnSuspicious('GET', '/api/cart')).toBe(expected);
      expect(s.getActionOnSuspicious('HEAD', '/api/cart')).toBe(expected);
    });

    test.each(['CONNECT', 'TRACE', 'PROPFIND'])('%s is ALLOW here: not one of the seven methods, so no rule or default is used', (method) => {
      // Arrange: a rule and a default that name the method, forced past the type
      const s = svc({ methods: { [method]: Action.BLOCK }, rules: [{ path: '.*', methods: [method], action: Action.BLOCK }] });

      // Act & Assert
      expect(s.getActionOnSuspicious(method, '/x')).toBe(Action.ALLOW);
    });

    test.each([undefined, 'BLOCK', 99, -1, null])('a value that is not an Action (%j) counts as ALLOW', (value) => {
      expect(svc({ methods: { POST: value } }).getActionOnSuspicious('POST', '/x')).toBe(Action.ALLOW);
      // The rule still decides: the default behind it is not used.
      expect(svc({ methods: { POST: Action.BLOCK }, rules: [{ path: '.*', action: value }] }).getActionOnSuspicious('POST', '/x')).toBe(Action.ALLOW);
    });
  });

  describe('validateActionOnSuspicious', () => {
    test('no problems for a valid setting, or none at all', () => {
      expect(new RTIHelperService({} as any).validateActionOnSuspicious()).toEqual([]);
      expect(new RTIHelperService({ actionOnSuspicious: {
        methods: { POST: Action.CHALLENGE, OPTIONS: Action.ALLOW },
        rules: [{ path: '^/login$', methods: ['POST'], action: Action.BLOCK }],
      } } as any).validateActionOnSuspicious()).toEqual([]);
    });

    test('names every problem: an unknown method, a value that is not an Action, a bad regex', () => {
      const problems = new RTIHelperService({ actionOnSuspicious: {
        methods: { FETCH: Action.BLOCK, POST: 'BLOCK' },
        rules: [{ path: '([', methods: ['FETCH'], action: 7 }],
      } } as any).validateActionOnSuspicious();
      expect(problems).toEqual([
        "actionOnSuspicious.methods: 'FETCH' is not one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
        'actionOnSuspicious.methods.POST: "BLOCK" is not an Action',
        "actionOnSuspicious.rules[0].path: '([' is not a valid regex",
        "actionOnSuspicious.rules[0].methods: 'FETCH' is not one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
        'actionOnSuspicious.rules[0].action: 7 is not an Action',
      ]);
    });

    test('GET and HEAD are valid in methods and in a rule: no problem', () => {
      // Act
      const problems = new RTIHelperService({ actionOnSuspicious: {
        methods: { GET: Action.ALLOW, HEAD: Action.CHALLENGE },
        rules: [{ path: '^/api/', methods: ['GET', 'HEAD'], action: Action.ALLOW }],
      } } as any).validateActionOnSuspicious();

      // Assert
      expect(problems).toEqual([]);
    });

    test('validateConfig includes these problems', () => {
      const svc = new RTIHelperService({ actionOnSuspicious: { methods: { POST: 9 } } } as any);
      expect(svc.validateConfig()).toContain('actionOnSuspicious.methods.POST: 9 is not an Action');
    });

    test('a rule without methods (the five methods with a body) has no problem, and a wrong one still gets its own message', () => {
      // Act
      const found = new RTIHelperService({ actionOnSuspicious: {
        rules: [{ path: '^/api/', action: Action.BLOCK }, { path: '([', action: Action.BLOCK }],
      } } as any).validateActionOnSuspicious();

      // Assert: only the second rule's regex
      expect(found).toEqual(["actionOnSuspicious.rules[1].path: '([' is not a valid regex"]);
    });
  });

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

    /**
     * The methods, getters and setters a class declares itself that do not use the config: neither read `this.config`
     * nor call (or read) another member of the class that does, through a chain of any length. Read from the source
     * (Function.prototype.toString), through the property descriptors, so a getter is never run.
     */
    const membersWithoutConfig = (cls: { prototype: object }): string[] => {
      const sources = new Map<string, string>();
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(cls.prototype))) {
        if (name === 'constructor') {
          continue;
        }
        const parts = [descriptor.value, descriptor.get, descriptor.set].filter(part => typeof part === 'function');
        sources.set(name, parts.map(part => part.toString()).join('\n'));
      }
      const usesConfig = new Set<string>();
      // \b: `this.configuration` or `this.configFree` is not the config
      const reads = (source: string, member: string) => new RegExp(`\\bthis\\.${member}\\b`).test(source);
      let found = true;
      while (found) {
        found = false;
        for (const [name, source] of sources) {
          if (!usesConfig.has(name) && (reads(source, 'config') || [...usesConfig].some(other => reads(source, other)))) {
            usesConfig.add(name);
            found = true;
          }
        }
      }
      return [...sources.keys()].filter(name => !usesConfig.has(name));
    };

    test('declares only methods that use the config: a config-free helper belongs in RTIStatelessUtils', () => {
      // getStrategyForRequest reads no config itself: it calls getActionStrategy and getActionOnSuspicious, which do
      expect(Object.getOwnPropertyNames(RTIHelperService.prototype).length).toBeGreaterThan(1);
      expect(membersWithoutConfig(RTIHelperService)).toEqual([]);
    });

    test('declares no static members: a static method has no instance, so no config, and belongs in RTIStatelessUtils', () => {
      // Act: what every class has (length, name, prototype) aside
      const statics = Object.getOwnPropertyNames(RTIHelperService).filter(name => !['length', 'name', 'prototype'].includes(name));

      // Assert
      expect(statics).toEqual([]);
    });

    test('holds no instance state but the config: a helper in an arrow-function field would escape the checks above', () => {
      // Act & Assert
      expect(Object.getOwnPropertyNames(new RTIHelperService({} as any))).toEqual(['config']);
    });

    test('the check finds every config-free member of a class, and only those', () => {
      // Arrange: each member is one case the check must get right
      class Example {
        config = {};
        configuration = {};
        readsConfig() { return this.config; }
        callsReader() { return this.readsConfig(); }
        callsCaller() { return this.callsReader(); }
        get configGetter() { return this.config; }
        readsGetter() { return this.configGetter; }
        free(path: string) { return path.trim(); }
        readsAnotherField() { return this.configuration; }
        get freeGetter() { return 1; }
        set freeSetter(value: number) { void value; }
        loopA(): unknown { return this.loopB(); }
        loopB(): unknown { return this.loopA(); }
      }

      // Act & Assert
      expect(membersWithoutConfig(Example).sort()).toEqual(['free', 'freeGetter', 'freeSetter', 'loopA', 'loopB', 'readsAnotherField'].sort());
    });

    test.each(['isBodylessMethod', 'isAction', 'pathMatches'])('%s is inherited from RTIStatelessUtils, not declared here', (name) => {
      // Act & Assert
      expect(Object.getOwnPropertyNames(RTIHelperService.prototype)).not.toContain(name);
      expect((new RTIHelperService({} as any) as any)[name]).toBe((RTIStatelessUtils.prototype as any)[name]);
    });
  });
  // #endregion Inheritance Tests
});
