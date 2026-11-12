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

    test.each(['GET', 'HEAD', 'CONNECT', 'TRACE'])('%s is always ALLOW here (not a body method)', (method) => {
      const s = svc({ rules: [{ path: '.*', action: Action.BLOCK }] });
      expect(s.getActionOnSuspicious(method, '/x')).toBe(Action.ALLOW);
    });

    test.each([undefined, 'BLOCK', 99, -1, null])('a value that is not an Action (%j) is ALLOW, so a typo never blocks', (value) => {
      expect(svc({ methods: { POST: value } }).getActionOnSuspicious('POST', '/x')).toBe(Action.ALLOW);
      expect(svc({ rules: [{ path: '.*', action: value }] }).getActionOnSuspicious('POST', '/x')).toBe(Action.ALLOW);
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
        methods: { GET: Action.BLOCK, POST: 'BLOCK' },
        rules: [{ path: '([', methods: ['HEAD'], action: 7 }],
      } } as any).validateActionOnSuspicious();
      expect(problems).toEqual([
        "actionOnSuspicious.methods: 'GET' is not one of POST, PUT, PATCH, DELETE, OPTIONS",
        'actionOnSuspicious.methods.POST: "BLOCK" is not an Action',
        "actionOnSuspicious.rules[0].path: '([' is not a valid regex",
        "actionOnSuspicious.rules[0].methods: 'HEAD' is not one of POST, PUT, PATCH, DELETE, OPTIONS",
        'actionOnSuspicious.rules[0].action: 7 is not an Action',
      ]);
    });

    test('validateConfig includes these problems', () => {
      const svc = new RTIHelperService({ actionOnSuspicious: { methods: { POST: 9 } } } as any);
      expect(svc.validateConfig()).toContain('actionOnSuspicious.methods.POST: 9 is not an Action');
    });

    test('a rule without methods (every method) has no problem, and a wrong one still gets its own message', () => {
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
