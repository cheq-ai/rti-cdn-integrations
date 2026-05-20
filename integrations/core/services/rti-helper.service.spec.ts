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

    test('returns undefined when called without name argument (uses default empty string)', () => {
      expect(svc.getHeaderByName(headers)).toBeUndefined();
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

  describe('parseCookies', () => {
    const svc = new RTIHelperService({} as any);

    // --- Empty / missing input ---

    test('returns all undefined for empty string', () => {
      const result = svc.parseCookies('');
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
      expect(result.sCookie).toBeUndefined();
    });

    test('returns all undefined when no CHEQ cookies are present', () => {
      const result = svc.parseCookies('session=abc123; theme=dark; other=ignored');
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
      expect(result.sCookie).toBeUndefined();
    });

    // --- Individual cookie extraction ---

    test('extracts only _cq_duid when present', () => {
      const result = svc.parseCookies('_cq_duid=4.16a154e6ae45bc91bf9a49b365beb989');
      expect(result.duidCookie).toBe('4.16a154e6ae45bc91bf9a49b365beb989');
      expect(result.pvidCookie).toBeUndefined();
      expect(result.sCookie).toBeUndefined();
    });

    test('extracts only _cq_pvid when present', () => {
      const result = svc.parseCookies('_cq_pvid=4.247bcdf08360a9de9dee2196c1a36631');
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBe('4.247bcdf08360a9de9dee2196c1a36631');
      expect(result.sCookie).toBeUndefined();
    });

    test('extracts only _cq_s when present', () => {
      const result = svc.parseCookies('_cq_s=simple-value');
      expect(result.duidCookie).toBeUndefined();
      expect(result.pvidCookie).toBeUndefined();
      expect(result.sCookie).toBe('simple-value');
    });

    // --- All three together ---

    test('extracts all three cookies when all present', () => {
      const result = svc.parseCookies('_cq_duid=4.16a154e6ae45bc91bf9a49b365beb989; _cq_pvid=4.247bcdf08360a9de9dee2196c1a36631; _cq_s=simple-value');
      expect(result.duidCookie).toBe('4.16a154e6ae45bc91bf9a49b365beb989');
      expect(result.pvidCookie).toBe('4.247bcdf08360a9de9dee2196c1a36631');
      expect(result.sCookie).toBe('simple-value');
    });

    // --- Noise cookies around CHEQ cookies ---

    test('ignores unrelated cookies when extracting all three', () => {
      const b64 = 'Ll7dvXH3YTlLM7nA:0pSlsKE44ASXSpI4yGmRpP+Rdwm3eR4RvkFIY60Jz1E/mWlZSilQ7METgbQuPTv1nfazHTyvz6qWSGx6GEeMYj9gTIIS38l/v7sO/xjLE7QVlUGtCQQS+5thTzsVRLejEV/3lrOQspnfY9sp5D5lGaEYa+k3yxdOjLp1kEVk/m7RQh2Nb1+Vbn+NaSRQ6CGIgJ/5BnEkYA==:uAmNscAbgD/vSVVN3OE4Ow==';
      const result = svc.parseCookies(`session=abc123; _cq_duid=d-uuid-xyz; theme=dark; _cq_pvid=pv-ulid-abc; _cq_s=${b64}; other=ignored`);
      expect(result.duidCookie).toBe('d-uuid-xyz');
      expect(result.pvidCookie).toBe('pv-ulid-abc');
      expect(result.sCookie).toBe(b64);
    });

    // --- Base64 padding in _cq_s ---

    test('preserves base64 = padding characters in _cq_s', () => {
      const b64 = 'c0hdForhWGaRercD:kc/eGTcRHnanstWrlbv6fnBWg/kICuKe+hRiK6x9lCwkrSdhpKIohwyd7/JHH3aA81pNurK0WfbwmJfGwL61DFBsgrr3wYpT8muwEt/xhOrFe3Ejee4W86fnE/fe0l1b1+ld6JwCiA7tueF0weoJStmpVEKW8PTz+JTkOf9jMfEE/HYNMrG22F+h7w68Td+JeCURnRPp48TbVAtusLvNuwWwWSyuI/7OfV6akdMrey+Mr2b8i8+w9Cm58M+Ttq1ydQPcQbHGOPfI5InnCSqHbGT0mUMxdodBMXFmvQgTN07lge/+zjGSH2+s+a0b60QlNOa6rw==:Ki6FWCQbEiMijlXZ/6/BNQ==';
      expect(svc.parseCookies(`_cq_s=${b64}`).sCookie).toBe(b64);
    });

    test('preserves base64 = padding in _cq_s when mixed with other cookies', () => {
      const b64 = 'Qxr2YUViJVxjN/Lj:/ZN3E52EztskUvgEC4J+kf4iZ5bM0INszRKC8IWXUzH2Qm2K4ByU/oBBroRABQOUoSPEqH8kulCnl7oy3AcaXS/RlwFPROQ7YzzGVwxWos6lTFMMbRgDlTkC7uwA50UwqlkWjrmEmmimz5gEQQc0HaDHw7TDo7INomrDm2vnJFMyKieBu0sD8k6cM1f9ORUphNF+Lezms73AyIgC7YV1RK3T3T8kpIkePoTrjzCFtM4rWQ9IHmk4Qcb39TUK+TOIyr38Sb/oODE25SLwyCgQY1KDVjyb452nlo1+E55bxXMmkocgnqDqyOOjTqtoYqROmYRhQcrjVr13gX4NPj/1OOp3pwSUsR0E1ji0VfArMzRZ6H4TfL610HnxF87NNVlyIwg+2lXu5md4PaC2pCck7q7q3fEcB+QkeA+fdlhuiI6s++MQ4+2FNyqZiIoLz/2vrLdVDgbVchS9kb3vJljm4gAswQbZHT50zrQKpXJZtduxYsWIbNOyrF2VGrzTDwyBpTumYaA+jcisuSax/Gntjtl5thWkFaq6iRYdIEFLDDK7SyMlylFGEHg8O4/Sh8ha0j3CX3Q=:GwUKuinki4bX6547azx1Rw==';
      const result = svc.parseCookies(`session=abc; _cq_duid=d-uuid; _cq_pvid=pv-ulid; _cq_s=${b64}`);
      expect(result.duidCookie).toBe('d-uuid');
      expect(result.pvidCookie).toBe('pv-ulid');
      expect(result.sCookie).toBe(b64);
    });

    // --- Prefix overlap: _cq_se must not match _cq_s ---

    test('does not extract _cq_se as _cq_s', () => {
      expect(svc.parseCookies('_cq_se=token|rayid; _cq_s=real-value').sCookie).toBe('real-value');
    });

    test('returns undefined for _cq_s when only _cq_se is present', () => {
      expect(svc.parseCookies('_cq_se=token|rayid').sCookie).toBeUndefined();
    });

    // --- Special characters in values ---

    test('preserves / + : characters in _cq_s value', () => {
      expect(svc.parseCookies('_cq_s=abc/def+ghi:jkl').sCookie).toBe('abc/def+ghi:jkl');
    });

    // --- Whitespace handling ---

    test('trims leading/trailing whitespace around each cookie token', () => {
      const result = svc.parseCookies('  _cq_duid=d-abc  ;  _cq_pvid=pv-xyz  ;  _cq_s=s-val  ');
      expect(result.duidCookie).toBe('d-abc');
      expect(result.pvidCookie).toBe('pv-xyz');
      expect(result.sCookie).toBe('s-val');
    });

    // --- Empty cookie value ---

    test('returns undefined when _cq_s has no value', () => {
      expect(svc.parseCookies('_cq_s=').sCookie).toBeUndefined();
    });

    test('returns undefined when _cq_duid has no value', () => {
      expect(svc.parseCookies('_cq_duid=').duidCookie).toBeUndefined();
    });

    // --- Duplicate cookie names ---

    test('returns first match when _cq_s appears twice', () => {
      expect(svc.parseCookies('_cq_s=first; _cq_s=second').sCookie).toBe('first');
    });
  });
});
