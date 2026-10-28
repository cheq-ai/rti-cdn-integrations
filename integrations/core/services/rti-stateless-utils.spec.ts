// cspell:ignore cheq rayid
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RTIStatelessUtils } from './rti-stateless-utils';
import { ActionStrategy } from '../models/action-strategy.model';

describe('RTIStatelessUtils', () => {
  // #region Stateless Contract Tests
  // These guard the contract in the class name: no constructor inputs, no instance state, and no
  // imports beyond plain models - so config or a service can't creep back in unnoticed.
  describe('stateless contract', () => {
    test('takes no constructor arguments', () => {
      expect(RTIStatelessUtils.length).toBe(0);
    });

    test('holds no instance state after its methods run', () => {
      const utils = new RTIStatelessUtils();

      utils.parseCookies('_cq_duid=a; _cq_pvid=b; _cq_s=c');
      utils.getCheqCookie('_cq=x');
      utils.getHeaderByName({ 'x-test': '1' }, 'X-Test');
      utils.isChallengeReplyAllowed(ActionStrategy.CAPTCHA);
      utils.errorMessage(new Error('boom'));
      utils.buildRtiResultHeader({
        metadata: { version: '4.1' },
        decision: { verdict: 'benign', ruleName: 'rule' },
        classification: { code: 0 },
        ids: { rayId: 'ray-1' },
        cheqDetection: { reasons: [1] },
      } as any, true);

      expect(Object.getOwnPropertyNames(utils)).toEqual([]);
    });

    test('imports only from models, and never the config', () => {
      const source = readFileSync(new URL('./rti-stateless-utils.ts', import.meta.url), 'utf8');
      const imports = [...source.matchAll(/^import\s.*?from\s+["'](.+?)["']/gm)].map(m => m[1]);

      expect(imports.length).toBeGreaterThan(0);
      for (const path of imports) {
        expect(path).toMatch(/^\.\.\/models\//);
        expect(path).not.toMatch(/config/);
      }
    });
  });
  // #endregion Stateless Contract Tests

  // #region isChallengeReplyAllowed Method Tests
  describe('isChallengeReplyAllowed', () => {
    test.each([
      [true, 'no strategy (ALLOW)', null],
      [true, 'CAPTCHA', ActionStrategy.CAPTCHA],
      [false, 'ACCESS_DENIED', ActionStrategy.ACCESS_DENIED],
      [false, 'NOT_FOUND', ActionStrategy.NOT_FOUND],
      [false, 'REDIRECT', ActionStrategy.REDIRECT],
    ])('returns %s for %s', (expected, _, strategy) => {
      // Arrange
      const svc = new RTIStatelessUtils();

      // Act & Assert
      expect(svc.isChallengeReplyAllowed(strategy)).toBe(expected);
    });

    test('covers every ActionStrategy (a new strategy must be added to the table above)', () => {
      // Arrange
      const tested = [ActionStrategy.CAPTCHA, ActionStrategy.ACCESS_DENIED, ActionStrategy.NOT_FOUND, ActionStrategy.REDIRECT];

      // Act & Assert
      expect(Object.values(ActionStrategy).filter(v => typeof v === 'number').sort()).toEqual([...tested].sort());
    });
  });
  // #endregion isChallengeReplyAllowed Method Tests

  // #region errorMessage Method Tests
  describe('errorMessage', () => {
    // A Proxy that throws on every operation: instanceof, property reads, Symbol.toStringTag and conversion all fail.
    const hostileProxy = () => new Proxy({}, {
      get() { throw new Error('get trap'); },
      getPrototypeOf() { throw new Error('getPrototypeOf trap'); },
      has() { throw new Error('has trap'); },
    });

    class CustomError extends Error {}

    test.each([
      // Errors: their message
      ['an Error', () => new Error('boom'), 'boom'],
      ['a TypeError', () => new TypeError('bad type'), 'bad type'],
      ['an Error subclass', () => new CustomError('custom'), 'custom'],
      ['an Error with an empty message', () => new Error(''), ''],
      ['an AbortSignal timeout DOMException', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'The operation was aborted due to timeout'],
      // Primitives: String()
      ['undefined', () => undefined, 'undefined'],
      ['null', () => null, 'null'],
      ['a string', () => 'boom', 'boom'],
      ['an empty string', () => '', ''],
      ['a number', () => 42, '42'],
      ['NaN', () => NaN, 'NaN'],
      ['a boolean', () => false, 'false'],
      ['a bigint', () => 10n, '10'],
      ['a symbol', () => Symbol('s'), 'Symbol(s)'],
      // Objects: String(), which uses toString / Symbol.toStringTag
      ['a plain object', () => ({ a: 1 }), '[object Object]'],
      ['an error-like object (not an Error, so no .message)', () => ({ message: 'looks like an error' }), '[object Object]'],
      ['an object with its own toString', () => ({ toString: () => 'custom string' }), 'custom string'],
      ['an object with Symbol.toStringTag', () => ({ [Symbol.toStringTag]: 'Tagged' }), '[object Tagged]'],
      ['an array', () => [1, 'two'], '1,two'],
      ['a Date', () => new Date(0), new Date(0).toString()],
      // String() throws: fall back to Object.prototype.toString
      ['a null-prototype object', () => Object.create(null), '[object Object]'],
      ['an object whose toString throws', () => ({ toString() { throw new Error('toString failed'); } }), '[object Object]'],
      ['an object whose toString returns an object', () => ({ toString: () => ({}), valueOf: () => ({}) }), '[object Object]'],
      ['an Error whose message getter throws', () => Object.defineProperty(new Error(), 'message', { get() { throw new Error('getter'); } }), '[object Error]'],
      // An Error whose message is not a string: converted, or a caller's `${...}` would throw on it
      ['an Error with a number message', () => Object.assign(new Error(), { message: 42 }), '42'],
      ['an Error with a Symbol message', () => Object.assign(new Error(), { message: Symbol('s') }), 'Symbol(s)'],
      ['an Error with an undefined message', () => Object.assign(new Error(), { message: undefined }), 'undefined'],
      ['an Error with an object message whose toString throws', () => Object.assign(new Error(), { message: { toString() { throw new Error('x'); } } }), '[object Error]'],
      // Everything throws: a fixed text
      ['a Proxy that throws on every operation', hostileProxy, 'unknown error'],
      ['a revoked Proxy', () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; }, 'unknown error'],
    ])('returns the message of %s', (_, value, expected) => {
      // Arrange
      const svc = new RTIStatelessUtils();

      // Act & Assert
      expect(svc.errorMessage(value())).toBe(expected);
    });

    test('returns the message of an Error from another realm (e.g. vm), through String()', async () => {
      // Arrange: instanceof Error is false across realms, so the message comes from Error.prototype.toString
      const { runInNewContext } = await import('node:vm');
      const foreign = runInNewContext('new Error("from vm")');
      const svc = new RTIStatelessUtils();

      // Act & Assert
      expect(foreign instanceof Error).toBe(false);
      expect(svc.errorMessage(foreign)).toBe('Error: from vm');
    });

    test('always returns a string that a template literal can embed', () => {
      // Arrange
      const svc = new RTIStatelessUtils();
      const values = [
        undefined, null, 0, '', Symbol(), 1n, {}, [], Object.create(null), hostileProxy(), new Error(),
        Object.assign(new Error(), { message: Symbol() }),
        Object.assign(new Error(), { message: { toString() { throw new Error('x'); } } }),
      ];

      // Act & Assert
      for (const value of values) {
        const message = svc.errorMessage(value);
        expect(typeof message).toBe('string');
        expect(() => `log: ${message}`).not.toThrow();
      }
    });
  });
  // #endregion errorMessage Method Tests

  // #region getCheqCookie Method Tests
  describe('getCheqCookie', () => {
    const svc = new RTIStatelessUtils();

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
    const svc = new RTIStatelessUtils();

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
    const svc = new RTIStatelessUtils();
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

  // #region parseCookies Method Tests
  describe('parseCookies', () => {
    const svc = new RTIStatelessUtils();

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
    const svc = new RTIStatelessUtils();

    function buildResponse(overrides: { verdict?: string; code?: number; version?: string; ids?: any; reasons?: number[]; ruleName?: string | null } = {}) {
      return {
        metadata: { version: overrides.version ?? '4.1' },
        decision: { verdict: overrides.verdict ?? 'benign', ruleName: overrides.ruleName ?? null },
        classification: { code: overrides.code ?? 0 },
        ids: overrides.ids ?? { rayId: 'ray-1', pageViewId: null, duid: null, uniqueVisitId: null, customParam1: null, customParam2: null },
        cheqDetection: { reasons: overrides.reasons ?? [] },
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

    // --- includeDebugData: appends reasons + rule-name (Akamai opt-in) ---

    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);

    test('omits debug data by default even when reasons and ruleName are present', () => {
      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ reasons: [1, 2], ruleName: 'Suspicious UA' }));

      // Assert
      expect(result).toBe(`version=4.1;verdict=benign;threat-type-code=0;ids=${JSON.stringify(defaultIds)}`);
    });

    test('appends reasons and rule-name when includeDebugData is true', () => {
      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ reasons: [1, 2, 3], ruleName: 'Suspicious UA' }), true);

      // Assert
      expect(result).toBe(`version=4.1;verdict=benign;threat-type-code=0;ids=${JSON.stringify(defaultIds)};reasons=1,2,3;rule-name=Suspicious UA`);
    });

    test('emits an empty reasons value when the reasons array is empty', () => {
      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ reasons: [], ruleName: 'Rule A' }), true);

      // Assert
      expect(result).toContain(';reasons=;rule-name=Rule A');
    });

    test('emits an empty rule-name when ruleName is null', () => {
      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ reasons: [7], ruleName: null }), true);

      // Assert
      expect(result).toContain(';reasons=7;rule-name=');
    });

    test('replaces semicolons in ruleName so they cannot split the header', () => {
      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ ruleName: 'block;allow' }), true);

      // Assert
      expect(result).toContain(';rule-name=block,allow');
    });

    test('strips CR and LF from ruleName to prevent header injection', () => {
      // Arrange
      const ruleName = 'evil' + CR + LF + 'x-injected: 1';

      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ ruleName }), true);

      // Assert
      expect(result).toContain(';rule-name=evilx-injected: 1');
      expect(result).not.toContain(CR);
      expect(result).not.toContain(LF);
    });

    test('strips non-printable and non-ASCII characters from ruleName', () => {
      // Arrange - e-acute (233) is non-ASCII, BEL (7) is a control character
      const ruleName = 'caf' + String.fromCharCode(233) + String.fromCharCode(7) + 'rule';

      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ ruleName }), true);

      // Assert
      expect(result).toContain(';rule-name=cafrule');
    });

    test('truncates ruleName at 128 characters', () => {
      // Arrange
      const longName = 'a'.repeat(200);

      // Act
      const result = svc.buildRtiResultHeader(buildResponse({ ruleName: longName }), true);

      // Assert
      expect(result).toContain(`;rule-name=${'a'.repeat(128)}`);
      expect(result).not.toContain('a'.repeat(129));
    });
  });
  // #endregion buildRtiResultHeader Method Tests

  // #region parseNumberList Method Tests
  describe('parseNumberList', () => {
    test('returns undefined for undefined input', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList(undefined)).toBeUndefined();
    });

    test('returns undefined for null input', () => {
      const input: any = null;
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList(input)).toBeUndefined();
    });

    test('returns undefined for empty string', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList('')).toBeUndefined();
    });

    test('parses a single number', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList('5')).toEqual([5]);
    });

    test('parses multiple comma-separated numbers', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList('4,5,6')).toEqual([4, 5, 6]);
    });

    test('trims spaces around each value', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList(' 4 , 5 , 6 ')).toEqual([4, 5, 6]);
    });

    test('filters trailing comma', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList('4,5,')).toEqual([4, 5]);
    });

    test('filters leading comma', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList(',4,5')).toEqual([4, 5]);
    });

    test('skips non-numeric entries', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList('4,abc,6')).toEqual([4, 6]);
    });

    test('returns undefined when all entries are non-numeric', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList('abc,def')).toBeUndefined();
    });

    test('parses negative numbers', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList('-1,3')).toEqual([-1, 3]);
    });

    test('truncates decimals via parseInt', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseNumberList('4.7,5.2')).toEqual([4, 5]);
    });
  });
  // #endregion parseNumberList Method Tests

  // #region parseStringList Method Tests
  describe('parseStringList', () => {
    test('returns undefined for undefined input', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseStringList(undefined)).toBeUndefined();
    });

    test('returns undefined for null input', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseStringList(null as any)).toBeUndefined();
    });

    test('returns undefined for empty string', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseStringList('')).toBeUndefined();
    });

    test('returns undefined for whitespace-only entries', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseStringList(' , , ')).toBeUndefined();
    });

    test('parses a single value', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseStringList('/health')).toEqual(['/health']);
    });

    test('parses multiple comma-separated values', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseStringList('/health,/ping')).toEqual(['/health', '/ping']);
    });

    test('trims spaces around each value', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseStringList(' /health , /ping ')).toEqual(['/health', '/ping']);
    });

    test('filters trailing comma', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseStringList('/health,')).toEqual(['/health']);
    });

    test('filters leading comma', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseStringList(',/health')).toEqual(['/health']);
    });

    test('filters consecutive empty entries', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseStringList('/a,,/b')).toEqual(['/a', '/b']);
    });

    test('preserves regex-like patterns intact', () => {
      // Act & Assert
      expect(RTIStatelessUtils.parseStringList('\\.css$,\\.js$')).toEqual(['\\.css$', '\\.js$']);
    });
  });
  // #endregion parseStringList Method Tests

  // #region safeReturnPath Method Tests
  describe('safeReturnPath', () => {
    const safeReturnPath = (raw: string | null | undefined) => RTIStatelessUtils.safeReturnPath(raw);
    const hex = (code: number) => `0x${code.toString(16).toUpperCase().padStart(2, '0')}`;
    const ASCII = Array.from({ length: 0x80 }, (_, code) => code);
    const CONTROLS = ASCII.filter(code => code < 0x20 || code === 0x7F);
    const PRINTABLE = ASCII.filter(code => code >= 0x20 && code < 0x7F);

    // How a browser resolves the value: as a relative Location (CloudFront without a Host header) and as the
    // absolute one the integrations build otherwise. Node's URL is the same WHATWG parser browsers implement.
    // A value the parser rejects (e.g. "/\t/%" becomes an invalid host) does not count as staying on the site.
    const BASE = 'https://example.com';
    const staysOnSite = (path: string) => {
      try {
        return new URL(path, `${BASE}/current`).origin === BASE && new URL(`${BASE}${path}`).origin === BASE;
      } catch {
        return false;
      }
    };

    describe('empty input', () => {
      test.each([
        ['undefined', undefined],
        ['null', null],
        ['an empty string', ''],
      ])('rejects %s', (_, raw) => {
        // Act & Assert
        expect(safeReturnPath(raw)).toBeUndefined();
      });
    });

    describe('first character: must be "/"', () => {
      test.each(ASCII.filter(code => code !== 0x2F).map(code => [hex(code), code]))(
        'rejects a value starting with %s', (_, code) => {
          // Act & Assert
          expect(safeReturnPath(`${String.fromCharCode(code)}evil.com`)).toBeUndefined();
        });

      test.each([
        ['an absolute https URL', 'https://evil.com/x'],
        ['an absolute http URL', 'http://evil.com'],
        ['a javascript: URL', 'javascript:alert(1)'],
        ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
        ['a bare host', 'evil.com'],
        ['a userinfo-style value', '@evil.com'],
        ['a dot-prefixed host', '.evil.com'],
        ['a path after a leading space', ' /page'],
        ['a path after a leading tab', '\t/page'],
        ['two backslashes', '\\\\evil.com'],
        ['a backslash then a slash', '\\/evil.com'],
        ['a non-ASCII look-alike slash (U+FF0F)', '／／evil.com'],
      ])('rejects %s', (_, raw) => {
        // Act & Assert
        expect(safeReturnPath(raw)).toBeUndefined();
      });
    });

    describe('second character: "/" and "\\" make it protocol-relative', () => {
      test.each([['/', '//evil.com'], ['\\', '/\\evil.com']])('rejects "%s" as the second character', (_, raw) => {
        // Act & Assert
        expect(safeReturnPath(raw)).toBeUndefined();
        expect(staysOnSite(raw)).toBe(false);
      });

      test.each(PRINTABLE.filter(code => code !== 0x2F && code !== 0x5C).map(code => [hex(code), code]))(
        'accepts %s as the second character', (_, code) => {
          // Arrange
          const path = `/${String.fromCharCode(code)}evil.com`;

          // Act & Assert
          expect(safeReturnPath(path)).toBe(path);
          expect(staysOnSite(path)).toBe(true);
        });
    });

    describe('ASCII control characters: rejected anywhere', () => {
      test('covers all 33 of them (0x00-0x1F and 0x7F)', () => {
        // Act & Assert
        expect(CONTROLS).toHaveLength(33);
      });

      test.each(CONTROLS.map(code => [hex(code), code]))(
        'rejects %s right after the slash, mid-path, in the query, in the fragment and at the end', (_, code) => {
          // Arrange
          const ch = String.fromCharCode(code);

          // Act & Assert
          for (const raw of [`/${ch}/evil.com`, `/${ch}\\evil.com`, `/a${ch}b`, `/a?q=${ch}`, `/a#${ch}`, `/a${ch}`]) {
            expect(safeReturnPath(raw)).toBeUndefined();
          }
        });

      test.each([
        ['a CRLF header injection', '/page\r\nSet-Cookie: a=1'],
        ['a bare LF header injection', '/page\nLocation: https://evil.com'],
        ['several tabs and newlines before the second slash', '/\t\n\r\t/evil.com'],
        ['a tab between two slashes later on', '/a/\t/b'],
      ])('rejects %s', (_, raw) => {
        // Act & Assert
        expect(safeReturnPath(raw)).toBeUndefined();
      });

      test('the rule is needed: tab, LF and CR are deleted by the browser, turning /<c>/host into another host', () => {
        // Arrange: each passes the leading-slash checks on its own
        const values = ['/\t/evil.com', '/\n/evil.com', '/\r/evil.com', '/\t\\evil.com'];

        // Act & Assert
        for (const raw of values) {
          expect(raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')).toBe(true);
          expect(new URL(raw, BASE).host).toBe('evil.com');
          expect(safeReturnPath(raw)).toBeUndefined();
        }
      });
    });

    describe('printable ASCII after the second character: accepted', () => {
      test.each(PRINTABLE.map(code => [hex(code), code]))(
        'accepts %s mid-path, in the query, in the fragment and at the end', (_, code) => {
          // Arrange
          const ch = String.fromCharCode(code);

          // Act & Assert: "/" and "\" here only add a path segment, they cannot change the host
          for (const path of [`/a${ch}b`, `/a?q=${ch}`, `/a#${ch}`, `/a${ch}`]) {
            expect(safeReturnPath(path)).toBe(path);
            expect(staysOnSite(path)).toBe(true);
          }
        });
    });

    describe('non-ASCII: accepted, a browser never reads it as "/" or "\\" in a path', () => {
      test.each([
        ['a C1 control (U+0080)', '\u0080'],
        ['a C1 control (U+009F)', '\u009F'],
        ['a no-break space (U+00A0)', ' '],
        ['a line separator (U+2028)', ' '],
        ['a paragraph separator (U+2029)', ' '],
        ['a byte-order mark (U+FEFF)', '﻿'],
        ['a fullwidth solidus (U+FF0F)', '／'],
        ['a fullwidth reverse solidus (U+FF3C)', '＼'],
        ['a division slash (U+2215)', '∕'],
        ['a fraction slash (U+2044)', '⁄'],
        ['an ideographic full stop (U+3002)', '。'],
        ['an accented letter', 'é'],
        ['an emoji', '\u{1F600}'],
      ])('accepts %s right after the slash', (_, ch) => {
        // Arrange
        const path = `/${ch}${ch}evil.com`;

        // Act & Assert
        expect(safeReturnPath(path)).toBe(path);
        expect(staysOnSite(path)).toBe(true);
      });

      test('accepts every character from U+0080 to U+FFFF right after the slash, and each stays on the site', () => {
        // Arrange: the whole Basic Multilingual Plane above ASCII, lone surrogates (U+D800-U+DFFF) included
        const codes = Array.from({ length: 0x10000 - 0x80 }, (_, i) => 0x80 + i);

        // Act
        const wrong = codes.filter(code => {
          const ch = String.fromCharCode(code);
          const path = `/${ch}${ch}evil.com`;
          return safeReturnPath(path) !== path || !staysOnSite(path);
        }).map(hex);

        // Assert
        expect(codes).toHaveLength(65_408);
        expect(wrong).toEqual([]);
      });
    });

    describe('realistic paths: accepted unchanged', () => {
      test.each([
        ['the root', '/'],
        ['a path', '/landing'],
        ['a nested path', '/shop/shoes/42'],
        ['a path with a query string', '/search?q=shoes&page=2'],
        ['a path with tracking parameters', '/landing?gclid=abc&utm_source=x'],
        ['a path with a fragment', '/page#top'],
        ['an empty query and fragment', '/?#'],
        ['dot segments (they stay on the site)', '/../../etc/passwd'],
        ['a double slash later in the path', '/a//b'],
        ['a backslash later in the path', '/a\\b'],
        ['a space in the path', '/a b'],
        ['a still-encoded tab (literal text to the browser)', '/a%09/b'],
        ['still-encoded slashes after the first', '/%2F%2Fevil.com'],
        ['a still-encoded backslash after the first', '/%5Cevil.com'],
        ['a full URL in the query string', '/redirect?to=https://evil.com'],
        ['a very long path', `/${'a'.repeat(10_000)}`],
      ])('accepts %s', (_, path) => {
        // Act & Assert: the same string comes back - nothing is trimmed, decoded or normalised
        expect(safeReturnPath(path)).toBe(path);
        expect(staysOnSite(path)).toBe(true);
      });
    });

    describe('agrees with the browser on every short string of risky characters', () => {
      // Every string of 1 to 4 characters over these is tried (88,740 of them): slashes, the characters the browser
      // deletes, other controls, and the characters that shape a URL (scheme, userinfo, port, query, fragment).
      const ALPHABET = ['/', '\\', '\t', '\n', '\r', '\x00', '\x7F', ' ', '.', ':', '@', '%', '?', '#', 'a', '。', '／'];
      const allStrings = (maxLength: number) => {
        let level = [''];
        const all: string[] = [];
        for (let length = 1; length <= maxLength; length++) {
          level = level.flatMap(prefix => ALPHABET.map(ch => prefix + ch));
          all.push(...level);
        }
        return all;
      };
      const STRINGS = allStrings(4);

      test('every accepted value stays on the site', () => {
        // Act
        const accepted = STRINGS.filter(raw => safeReturnPath(raw) !== undefined);
        const leaving = accepted.filter(raw => !staysOnSite(raw)).map(raw => JSON.stringify(raw));

        // Assert
        expect(accepted.length).toBeGreaterThan(1000);
        expect(leaving).toEqual([]);
      });

      test('the check above has teeth: without the control-character rule some accepted values leave the site', () => {
        // Arrange: safeReturnPath before the control-character rule was added
        const leadingSlashOnly = (raw: string) => raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\');

        // Act
        const leaving = STRINGS.filter(raw => leadingSlashOnly(raw) && !staysOnSite(raw));

        // Assert
        expect(leaving).toContain('/\t/a');
        expect(leaving).toContain('/\n\\a');
      });
    });
  });
  // #endregion safeReturnPath Method Tests

  // #region getCookieValue Method Tests
  describe('getCookieValue', () => {
    const svc = new RTIStatelessUtils();

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
