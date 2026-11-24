// cspell:ignore CHEQ jsonp clicktrue lordofthesuperfrogs nbsp apos Hant gclid
import { describe, test, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { createHmac } from 'node:crypto';
import { InterstitialService, readTagLine } from './interstitial.service';
import { CONSOLE_LINE, CONSOLE_TAG_HASH } from '../testing/interstitial.fixture';
import { INTERSTITIAL_SCRIPT, interstitialPage, type InterstitialScriptValues } from '../helpers/interstitial-page-helpers';
import { Action } from '../models/action.model';
import { ActionStrategy } from '../models/action-strategy.model';
import type { Config } from '../models/config.interface';
import type { HmacHex32, InterstitialFacts, InterstitialRequest } from '../models/interstitial.model';

// The src of CONSOLE_LINE, and the line's attributes as readTagLine gives them.
const SRC = 'https://rocky.lordofthesuperfrogs.com/i/89f6be46721c93dcde41c82e1e56ac78.js';
const CONSOLE_PAIRS = [['src', SRC], ['data-ch', 'v41tag'], ['class', 'ct_clicktrue_98468'], ['data-jsonp', 'onCheqResponse']];

// A tag line with these attributes and nothing between the two tags.
const scriptWith = (attributes: string): string => `<script ${attributes}></script>`;

// CONSOLE_LINE with one more attribute, data-pad, so that the line is exactly `length` characters long.
const lineOfLength = (length: number): string => {
  const start = CONSOLE_LINE.replace('></script>', ' data-pad="');
  const end = '"></script>';
  return start + 'x'.repeat(length - start.length - end.length) + end;
};

// U+2028 and U+2029, built from their codes so that this file does not hold them.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

// A service for a config with the console line's tagHash, these interstitial settings and these other settings. Its
// HMAC function records its calls.
const build = (interstitial: unknown, other: Record<string, unknown> = {}) => {
  const hmac = vi.fn<HmacHex32>();
  const config = { apiKey: 'test-api-key', tagHash: CONSOLE_TAG_HASH, ...other, interstitial } as unknown as Config;
  return { service: new InterstitialService(config, hmac), hmac };
};

// HMAC-SHA256 as its first 32 hex characters, built on node:crypto: the value Cloudflare's signing.ts gives.
const realHmac: HmacHex32 = async (key, message) => createHmac('sha256', key).update(message).digest('hex').slice(0, 32);

// The API key of the mark's tests. Its setup id (46d95e19) has letters, so that a row can write it in upper case.
const API_KEY = 'mark-api-key';

// A service with the interstitial on (the console line and these settings), and a real HMAC that records its calls.
const buildOn = (interstitial: Record<string, unknown> = {}, apiKey = API_KEY) => {
  const hmac = vi.fn<HmacHex32>(realHmac);
  const config = { apiKey, tagHash: CONSOLE_TAG_HASH, interstitial: { enabled: true, tag: CONSOLE_LINE, ...interstitial } };
  return { service: new InterstitialService(config as unknown as Config, hmac), hmac };
};

// The mark's key of an API key, and the setup id made from it, as the brief gives them.
const keyOf = (apiKey: string): Promise<string> => realHmac(apiKey, 'cheq-interstitial-mark-v1');
const setupIdOf = async (apiKey: string): Promise<string> => (await realHmac(await keyOf(apiKey), 'cheq-interstitial-setup-id')).slice(0, 8);

// A fixed clock for the mark's tests, so that each mark is the same on every run.
const NOW = 1_800_000_000_000;

// The page load that gets the interstitial: /sofas from a Google search, binding key K.
const PAGE_URL = 'https://example.com/sofas?gclid=abc';
const MADE: InterstitialRequest = { url: PAGE_URL, cookie: '', referer: 'https://www.google.com/search?q=x', bindingKey: 'K', pageLoad: true };

// What originalReferer keeps of MADE's Referer, which is on another host: its origin.
const GOOGLE = 'https://www.google.com/';

// The values a page hands its script: the JSON in INTERSTITIAL_SCRIPT(…), in the page's one <script>.
const valuesIn = (body: string): InterstitialScriptValues => {
  const script = body.slice(body.indexOf('<script>') + '<script>'.length, body.indexOf('</script>'));
  expect(script.startsWith(`${INTERSTITIAL_SCRIPT}(`)).toBe(true);
  return JSON.parse(script.slice(INTERSTITIAL_SCRIPT.length + 1, -1)) as InterstitialScriptValues;
};

// The mark that page() makes for `request`, with ray id ray-1: the markValue of the script values in the page.
const makeMark = async (service: InterstitialService, request: InterstitialRequest = MADE): Promise<string> =>
  valuesIn((await service.page(request, 'ray-1')).body).markValue;

// The reload: MADE with this Cookie header and without its own Referer, unless `more` says otherwise.
const reload = (cookie: string, more: Partial<InterstitialRequest> = {}): InterstitialRequest => ({ ...MADE, cookie, referer: null, ...more });

// The mark with part `index` changed: 0 the setup id, 1 the expiry and the signature, 2 the ray id, 3 the page tag,
// 4 the Referer.
const withPart = (mark: string, index: number, change: (part: string) => string): string =>
  mark.split('|').map((part, i) => (i === index ? change(part) : part)).join('|');

describe('readTagLine', () => {
  // #region Lines that are read
  test('reads the CHEQ console line: its attributes in order, without async', () => {
    // Act
    const result = readTagLine(CONSOLE_LINE);

    // Assert
    expect(result).toEqual({ attributes: CONSOLE_PAIRS });
  });

  test('keeps the order of the line when the attributes come in another order', () => {
    // Arrange
    const line = scriptWith(`class="ct_clicktrue_98468" data-jsonp="onCheqResponse" async src="${SRC}" data-ch="v41tag"`);

    // Act
    const result = readTagLine(line);

    // Assert
    expect(result).toEqual({
      attributes: [['class', 'ct_clicktrue_98468'], ['data-jsonp', 'onCheqResponse'], ['src', SRC], ['data-ch', 'v41tag']],
    });
  });

  test.each([
    ['single quotes', `async src='${SRC}' data-ch='v41tag' class='ct_clicktrue_98468' data-jsonp='onCheqResponse'`],
    ['one value without quotes (data-ch=v41tag)', `async src="${SRC}" data-ch=v41tag class="ct_clicktrue_98468" data-jsonp="onCheqResponse"`],
    ['no quotes at all', `async src=${SRC} data-ch=v41tag class=ct_clicktrue_98468 data-jsonp=onCheqResponse`],
    ['whitespace around =', `async src = "${SRC}" data-ch= v41tag class ='ct_clicktrue_98468' data-jsonp="onCheqResponse"`],
  ])('reads the same values with %s', (_, attributes) => {
    // Act & Assert
    expect(readTagLine(scriptWith(attributes))).toEqual({ attributes: CONSOLE_PAIRS });
  });

  test('reads &amp; in the src as &', () => {
    // Arrange
    const line = scriptWith('src="https://t.example/i/abc.js?a=1&amp;b=2" class="ct_clicktrue_1"');

    // Act
    const result = readTagLine(line);

    // Assert
    expect(result).toEqual({ attributes: [['src', 'https://t.example/i/abc.js?a=1&b=2'], ['class', 'ct_clicktrue_1']] });
  });

  test.each([
    ['&quot; as "', 'say &quot;hi&quot;', 'say "hi"'],
    ["&#39; as '", 'it&#39;s', "it's"],
    ['&amp;lt; as the text &lt;: a value is read once', 'a&amp;lt;b', 'a&lt;b'],
    ['any other &…; as written', 'a&nbsp;b&#34;c&apos;d&AMP;e&#x27;f&copy;g', 'a&nbsp;b&#34;c&apos;d&AMP;e&#x27;f&copy;g'],
    ['an & without its ; as written', 'a&b &amp c', 'a&b &amp c'],
  ])('reads %s', (_, written, read) => {
    // Arrange
    const line = scriptWith(`src="${SRC}" class="ct_clicktrue_98468" data-x="${written}"`);

    // Act
    const result = readTagLine(line);

    // Assert
    expect(result).toEqual({ attributes: [['src', SRC], ['class', 'ct_clicktrue_98468'], ['data-x', read]] });
  });

  test('leaves out defer, onload and ONERROR, as it leaves out async', () => {
    // Arrange
    const line = scriptWith(
      `async defer src="${SRC}" onload="x()" data-ch="v41tag" ONERROR="y()" class="ct_clicktrue_98468" data-jsonp="onCheqResponse"`);

    // Act & Assert
    expect(readTagLine(line)).toEqual({ attributes: CONSOLE_PAIRS });
  });

  test.each([
    ['in upper case (the names come out in lower case)',
      `<SCRIPT ASYNC SRC="${SRC}" DATA-CH="v41tag" CLASS="ct_clicktrue_98468" DATA-JSONP="onCheqResponse"></SCRIPT>`],
    ['with spaces around it', `   ${CONSOLE_LINE}   `],
    ['with line breaks around it', `\r\n${CONSOLE_LINE}\n`],
    ['with whitespace between the tags', CONSOLE_LINE.replace('></script>', '>\n  \t</script>')],
    ['with line breaks between the attributes', CONSOLE_LINE.replace(/ /g, '\n  ')],
    ['with a space before the > of the end tag', CONSOLE_LINE.replace('</script>', '</script >')],
  ])('reads the line %s', (_, line) => {
    // Act & Assert
    expect(readTagLine(line)).toEqual({ attributes: CONSOLE_PAIRS });
  });

  test('keeps the first of two attributes with the same name', () => {
    // Arrange
    const line = scriptWith(`async src="${SRC}" data-ch="v41tag" class="ct_clicktrue_98468" data-jsonp="onCheqResponse"`
      + ' data-ch="other" CLASS="ct_clicktrue_1" src="https://other.example/i/abc.js"');

    // Act & Assert
    expect(readTagLine(line)).toEqual({ attributes: CONSOLE_PAIRS });
  });

  test('does not check what it leaves out: an on… attribute, or a second attribute of the same name', () => {
    // Arrange
    const line = scriptWith(`async src="${SRC}" onload="if (a<b) x()" on!x="y" data-ch="v41tag" class="ct_clicktrue_98468"`
      + ' data-jsonp="onCheqResponse" data-ch="a<b"');

    // Act & Assert
    expect(readTagLine(line)).toEqual({ attributes: CONSOLE_PAIRS });
  });

  test('reads a line of 800 characters', () => {
    // Arrange
    const line = lineOfLength(800);

    // Act
    const result = readTagLine(line);

    // Assert
    expect(line).toHaveLength(800);
    expect(result).toEqual({ attributes: [...CONSOLE_PAIRS, ['data-pad', expect.stringMatching(/^x+$/)]] });
  });

  test('does not count the whitespace around the line in its length', () => {
    // Act & Assert
    expect(readTagLine(`  ${lineOfLength(800)}\n`)).toEqual({ attributes: [...CONSOLE_PAIRS, ['data-pad', expect.any(String)]] });
  });
  // #endregion Lines that are read

  // #region Lines that switch the interstitial off
  test.each([
    ['another element', `<img src="${SRC}" class="ct_clicktrue_98468">`],
    ['two <script> elements', CONSOLE_LINE + CONSOLE_LINE],
    ['no end tag', CONSOLE_LINE.replace('</script>', '')],
    ['text after the end tag', `${CONSOLE_LINE}x`],
    ['text before the start tag', `x${CONSOLE_LINE}`],
    ['a tag name that only starts with script', CONSOLE_LINE.replace('<script', '<scripts').replace('</script>', '</scripts>')],
    ['a quote that is not closed', scriptWith(`src="${SRC} class="ct_clicktrue_98468"`)],
    ['no > at the end of the start tag', `<script src="${SRC}" class="ct_clicktrue_98468"</script>`],
  ])('switches off a line with %s: it is not one element', (_, line) => {
    // Act & Assert
    expect(readTagLine(line)).toEqual({ problem: 'it is not one <script …></script> element' });
  });

  test('switches off a line with text between the tags', () => {
    // Arrange
    const line = `<script src="${SRC}" class="ct_clicktrue_98468">alert(1)</script>`;

    // Act & Assert
    expect(readTagLine(line)).toEqual({ problem: 'it has text between <script> and </script>' });
  });

  test.each([
    ['no src', 'async data-ch="v41tag" class="ct_clicktrue_98468"'],
    ['an empty src', 'src="" class="ct_clicktrue_98468"'],
    ['an http:// src', 'src="http://rocky.lordofthesuperfrogs.com/i/abc.js" class="ct_clicktrue_98468"'],
    ['a src that starts with //', 'src="//rocky.lordofthesuperfrogs.com/i/abc.js" class="ct_clicktrue_98468"'],
    ['a path as the src', 'src="/i/abc.js" class="ct_clicktrue_98468"'],
    ['HTTPS:// in upper case', 'src="HTTPS://rocky.lordofthesuperfrogs.com/i/abc.js" class="ct_clicktrue_98468"'],
    ['https:// alone, which is not a URL', 'src="https://" class="ct_clicktrue_98468"'],
    ['a host with a space, which is not a URL', 'src="https://rocky lordofthesuperfrogs.com/i/abc.js" class="ct_clicktrue_98468"'],
  ])('switches off a line with %s', (_, attributes) => {
    // Act & Assert
    expect(readTagLine(scriptWith(attributes))).toEqual({ problem: 'its src does not start with https://' });
  });

  test.each([
    ['no class', `async src="${SRC}" data-ch="v41tag"`],
    ['class=""', `async src="${SRC}" class=""`],
    ['a class of spaces only', `async src="${SRC}" class="   "`],
  ])('switches off a line with %s', (_, attributes) => {
    // Act & Assert
    expect(readTagLine(scriptWith(attributes))).toEqual({ problem: 'it has no class' });
  });

  test('switches off a line of 801 characters', () => {
    // Arrange
    const line = lineOfLength(801);

    // Act
    const result = readTagLine(line);

    // Assert
    expect(line).toHaveLength(801);
    expect(result).toEqual({ problem: 'it is longer than 800 characters' });
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['spaces', '  '],
    ['REPLACE_ME', 'REPLACE_ME'],
    ['REPLACE_ME with spaces around it', ' REPLACE_ME '],
    ['a number', 42],
  ])('says "it is not set" for %s', (_, line) => {
    // Act & Assert
    expect(readTagLine(line)).toEqual({ problem: 'it is not set' });
  });

  test.each([
    ['1a="b"', '1a'],
    ['data-x!="c"', 'data-x!'],
    ['_x="d"', '_x'],
  ])('switches off a line with the attribute %s', (attribute, name) => {
    // Arrange
    const line = scriptWith(`src="${SRC}" ${attribute} class="ct_clicktrue_98468"`);

    // Act & Assert
    expect(readTagLine(line)).toEqual({ problem: `it has an attribute name a page cannot set: ${name}` });
  });

  test.each([
    ['<', 'a<b'],
    ['>', 'a>b'],
    ['&lt;, read as <', 'a&lt;b'],
    ['&gt;, read as >', 'a&gt;b'],
    ['a tab', 'a\tb'],
    ['a line break', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['NUL', 'a\x00b'],
    ['U+001F', 'a\x1Fb'],
    ['DEL', 'a\x7Fb'],
    ['U+0080', 'a\x80b'],
    ['U+009F', 'a\x9Fb'],
    ['U+2028', `a${LINE_SEPARATOR}b`],
    ['U+2029', `a${PARAGRAPH_SEPARATOR}b`],
  ])('switches off a line with %s in a value', (_, value) => {
    // Arrange
    const line = scriptWith(`src="${SRC}" class="ct_clicktrue_98468" data-ch="${value}"`);

    // Act & Assert
    expect(readTagLine(line)).toEqual({ problem: 'it has a value with <, > or a control character' });
  });

  test.each([
    ['> in the src', scriptWith(`src="${SRC}?x=>" class="ct_clicktrue_98468"`)],
    ['< in a value without quotes', scriptWith(`src="${SRC}" class=ct_clicktrue_98468<b`)],
  ])('switches off a line with %s', (_, line) => {
    // Act & Assert
    expect(readTagLine(line)).toEqual({ problem: 'it has a value with <, > or a control character' });
  });
  // #endregion Lines that switch the interstitial off
});

describe('InterstitialService settings', () => {
  // The interstitial on with the console line, every other setting left out.
  const ON = { enabled: true, tag: CONSOLE_LINE };

  // The settings for ON: every default.
  const DEFAULTS = {
    tagAttributes: CONSOLE_PAIRS,
    onSecondVerdict: Action.ALLOW,
    onSessionNotFound: Action.ALLOW,
    maxWaitMs: 5000,
    statusCode: 403,
    originalRefererVia: 'header',
    binding: { ip: 'exact', userAgent: true },
    logoUrl: undefined,
    headline: 'Checking your browser',
    message: 'This usually takes about a second.',
    lang: 'en',
    logOutcomes: true,
  };

  // For each setting: what is allowed, and its default, as a problem text writes them.
  const ALLOWED: Record<string, [allowed: string, writtenDefault: string]> = {
    onSecondVerdict: ['an Action', 'Action.ALLOW'],
    onSessionNotFound: ['an Action', 'Action.ALLOW'],
    maxWaitMs: ['a whole number from 1000 to 30000', '5000'],
    statusCode: ['200 or a whole number from 400 to 599', '403'],
    originalRefererVia: ['"header" or "cookie"', '"header"'],
    binding: ['{ ip: "exact" or "none", userAgent: true or false }', '{"ip":"exact","userAgent":true}'],
    logoUrl: ['an https:// URL of at most 200 characters', 'undefined'],
    headline: ['text of 1 to 60 characters', '"Checking your browser"'],
    message: ['text of 1 to 160 characters', '"This usually takes about a second."'],
    lang: ['a language tag such as "en" or "en-US"', '"en"'],
    logOutcomes: ['true or false', 'true'],
  };

  // An https URL of `length` characters, and a language tag of 35 characters that has the allowed form.
  const logoOfLength = (length: number): string => 'https://cdn.example/' + 'a'.repeat(length - 'https://cdn.example/'.length);
  const LANG_35 = 'en-abcdefgh-abcdefgh-abcdefgh-abcde';

  // #region Off (rows 1 to 4, 9 and 10)
  test.each([
    ['no interstitial block', {}],
    ['interstitial: undefined', { interstitial: undefined }],
    ['interstitial: null', { interstitial: null }],
  ])('is off without a problem with %s', (_, other) => {
    // Arrange
    const hmac = vi.fn<HmacHex32>();

    // Act
    const service = new InterstitialService({ apiKey: 'test-api-key', tagHash: CONSOLE_TAG_HASH, ...other } as unknown as Config, hmac);

    // Assert
    expect(service.on).toBe(false);
    expect(service.settings).toBeUndefined();
    expect(service.problems).toEqual([]);
    expect(hmac).not.toHaveBeenCalled();
  });

  test.each([
    ['nothing else', { enabled: false }],
    ['the console line', { enabled: false, tag: CONSOLE_LINE }],
    ['wrong other values', { enabled: false, tag: '<img>', maxWaitMs: 1, headline: '' }],
  ])('is off without a problem with enabled: false and %s', (_, interstitial) => {
    // Act
    const { service } = build(interstitial);

    // Assert
    expect(service.on).toBe(false);
    expect(service.settings).toBeUndefined();
    expect(service.problems).toEqual([]);
  });

  test.each([
    ['"true"', { enabled: 'true', tag: CONSOLE_LINE }, '"true"'],
    ['1', { enabled: 1, tag: CONSOLE_LINE }, '1'],
    ['null', { enabled: null, tag: CONSOLE_LINE }, 'null'],
    ['left out', { tag: CONSOLE_LINE }, 'undefined'],
  ])('is off with enabled %s, and says so', (_, interstitial, written) => {
    // Act
    const { service } = build(interstitial);

    // Assert
    expect(service.on).toBe(false);
    expect(service.settings).toBeUndefined();
    expect(service.problems).toEqual([`interstitial.enabled: ${written} is not true or false, the interstitial is off`]);
  });

  test.each([
    ['is not one element (row 9)', `<img src="${SRC}" class="ct_clicktrue_98468">`, 'it is not one <script …></script> element'],
    ['has text between the tags (row 10)', `<script src="${SRC}" class="ct_clicktrue_98468">alert(1)</script>`,
      'it has text between <script> and </script>'],
    ['has an http:// src (row 11)', scriptWith('src="http://t.example/i/abc.js" class="ct_clicktrue_1"'), 'its src does not start with https://'],
    ['has no class (row 12)', scriptWith(`src="${SRC}"`), 'it has no class'],
    ['has 801 characters (row 13)', lineOfLength(801), 'it is longer than 800 characters'],
    ['has a name a page cannot set (row 15)', scriptWith(`src="${SRC}" 1a="b" class="ct_clicktrue_98468"`),
      'it has an attribute name a page cannot set: 1a'],
    ['has a value with < (row 16)', scriptWith(`src="${SRC}" class="ct_clicktrue_98468" data-ch="a<b"`),
      'it has a value with <, > or a control character'],
  ])('is off when the tag line %s, and says why', (_, tag, problem) => {
    // Act
    const { service } = build({ enabled: true, tag });

    // Assert
    expect(service.on).toBe(false);
    expect(service.settings).toBeUndefined();
    expect(service.problems).toEqual([`interstitial.tag cannot be read (${problem}), the interstitial is off`]);
  });

  test.each([
    ['left out', { enabled: true }],
    ['empty', { enabled: true, tag: '' }],
    ['spaces', { enabled: true, tag: '  ' }],
    ['REPLACE_ME', { enabled: true, tag: 'REPLACE_ME' }],
    ['a number', { enabled: true, tag: 42 }],
  ])('is off when the tag line is %s (row 14), and says to paste it', (_, interstitial) => {
    // Act
    const { service } = build(interstitial);

    // Assert
    expect(service.on).toBe(false);
    expect(service.settings).toBeUndefined();
    expect(service.problems).toEqual(['interstitial.tag is not set, the interstitial is off: paste the tag line from the CHEQ console']);
  });

  test('is off when reading the settings throws, and says why', () => {
    // Arrange
    const hmac = vi.fn<HmacHex32>();
    const config = { apiKey: 'test-api-key', tagHash: CONSOLE_TAG_HASH, get interstitial(): never { throw new Error('boom'); } };

    // Act
    const service = new InterstitialService(config as unknown as Config, hmac);

    // Assert
    expect(service.on).toBe(false);
    expect(service.settings).toBeUndefined();
    expect(service.problems).toEqual(['interstitial settings could not be read (boom), the interstitial is off']);
    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.isFrozen(service.problems)).toBe(true);
    expect(hmac).not.toHaveBeenCalled();
  });

  test('keeps only the text of the throw when a setting throws after a problem was found', () => {
    // Arrange
    const interstitial = { ...ON, onSecondVerdict: 'BLOCK', get maxWaitMs(): never { throw new Error('boom'); } };

    // Act
    const { service } = build(interstitial);

    // Assert
    expect(service.on).toBe(false);
    expect(service.settings).toBeUndefined();
    expect(service.problems).toEqual(['interstitial settings could not be read (boom), the interstitial is off']);
  });

  test.each([
    ['enabled: false', { enabled: false, tag: '<img>', maxWaitMs: 1, headline: '' }, []],
    ['enabled: "true"', { enabled: 'true', tag: '<img>', maxWaitMs: 1, headline: '' },
      ['interstitial.enabled: "true" is not true or false, the interstitial is off']],
    ['a tag line that cannot be read', { enabled: true, tag: '<img>', maxWaitMs: 1, headline: '' },
      ['interstitial.tag cannot be read (it is not one <script …></script> element), the interstitial is off']],
  ])('checks the other settings only when the interstitial is on: %s', (_, interstitial, problems) => {
    // Act
    const { service } = build(interstitial, { tagHash: 'REPLACE_ME', challengingStrategy: ActionStrategy.CAPTCHA });

    // Assert
    expect(service.on).toBe(false);
    expect(service.settings).toBeUndefined();
    expect(service.problems).toEqual(problems);
  });
  // #endregion Off (rows 1 to 4, 9 and 10)

  // #region On (rows 5 to 8)
  test('is on with the console line, and gives the default of every other setting', () => {
    // Act
    const { service, hmac } = build(ON);

    // Assert
    expect(service.on).toBe(true);
    expect(service.settings).toEqual(DEFAULTS);
    expect(service.settings?.logoUrl).toBeUndefined();
    expect(service.problems).toEqual([]);
    expect(hmac).not.toHaveBeenCalled();
  });

  test('keeps every setting that has an allowed value', () => {
    // Arrange
    const interstitial = {
      ...ON,
      onSecondVerdict: Action.BLOCK,
      onSessionNotFound: Action.CHALLENGE,
      maxWaitMs: 1000,
      statusCode: 200,
      originalRefererVia: 'cookie',
      binding: { ip: 'none', userAgent: false },
      logoUrl: 'https://cdn.example/logo.png',
      headline: 'One moment',
      message: 'We check your browser.',
      lang: 'fr-CA',
      logOutcomes: false,
    };

    // Act
    const { service } = build(interstitial);

    // Assert
    expect(service.on).toBe(true);
    expect(service.settings).toEqual({
      tagAttributes: CONSOLE_PAIRS,
      onSecondVerdict: Action.BLOCK,
      onSessionNotFound: Action.CHALLENGE,
      maxWaitMs: 1000,
      statusCode: 200,
      originalRefererVia: 'cookie',
      binding: { ip: 'none', userAgent: false },
      logoUrl: 'https://cdn.example/logo.png',
      headline: 'One moment',
      message: 'We check your browser.',
      lang: 'fr-CA',
      logOutcomes: false,
    });
    expect(service.problems).toEqual([]);
  });

  test.each([
    ['onSecondVerdict', Action.ALLOW],
    ['onSecondVerdict', Action.CHALLENGE],
    ['onSecondVerdict', Action.BLOCK],
    ['onSecondVerdict', Action.REDIRECT],
    ['onSessionNotFound', Action.REDIRECT],
    ['maxWaitMs', 1000],
    ['maxWaitMs', 30000],
    ['statusCode', 200],
    ['statusCode', 400],
    ['statusCode', 599],
    ['originalRefererVia', 'header'],
    ['originalRefererVia', 'cookie'],
    ['binding', { ip: 'exact', userAgent: false }],
    ['binding', { ip: 'none', userAgent: true }],
    ['headline', 'x'],
    ['headline', 'x'.repeat(60)],
    ['message', 'x'],
    ['message', 'x'.repeat(160)],
    ['lang', 'de'],
    ['lang', 'fra'],
    ['lang', 'zh-Hant-TW'],
    ['lang', 'EN-us'],
    ['lang', LANG_35],
    ['logOutcomes', true],
    ['logOutcomes', false],
  ])('keeps %s: %j', (name, value) => {
    // Act
    const { service } = build({ ...ON, [name]: value });

    // Assert
    expect(service.on).toBe(true);
    expect(service.settings).toEqual({ ...DEFAULTS, [name]: value });
    expect(service.problems).toEqual([]);
  });

  test.each([
    ['https://cdn.example/logo.png', 'https://cdn.example/logo.png'],
    ['https://CDN.Example/logo.png', 'https://cdn.example/logo.png'],
    ['https://cdn.example', 'https://cdn.example/'],
    [logoOfLength(200), logoOfLength(200)],
    ['https://cdn.example/' + 'é'.repeat(30), 'https://cdn.example/' + '%C3%A9'.repeat(30)],
  ])('keeps logoUrl %j as new URL(value).href', (logoUrl, href) => {
    // Act
    const { service } = build({ ...ON, logoUrl });

    // Assert
    expect(href.length).toBeLessThanOrEqual(200);
    expect(service.settings).toEqual({ ...DEFAULTS, logoUrl: href });
    expect(service.problems).toEqual([]);
  });

  test.each([
    ['https://cdn.example/ and 150 times é: 170 characters, an href of 920', 'https://cdn.example/' + 'é'.repeat(150)],
    ['https://cdn.example/, 30 times é and a: 51 characters, an href of 201', 'https://cdn.example/' + 'é'.repeat(30) + 'a'],
  ])('stays on with a logoUrl whose href is longer than 200 characters (%s), uses the default and says so', (_, logoUrl) => {
    // Act
    const { service } = build({ ...ON, logoUrl });

    // Assert
    expect(logoUrl.length).toBeLessThanOrEqual(200);
    expect(new URL(logoUrl).href.length).toBeGreaterThan(200);
    expect(service.on).toBe(true);
    expect(service.settings?.logoUrl).toBeUndefined();
    expect(service.problems).toEqual([
      `interstitial.logoUrl: ${JSON.stringify(logoUrl)} is not an https:// URL of at most 200 characters, using undefined`,
    ]);
  });

  test('keeps only ip and userAgent of binding, in an object of its own', () => {
    // Arrange
    const binding = { ip: 'none', userAgent: false, extra: 1 };

    // Act
    const { service } = build({ ...ON, binding });

    // Assert
    expect(service.settings?.binding).toEqual({ ip: 'none', userAgent: false });
    expect(service.settings?.binding).not.toBe(binding);
  });

  test.each([
    ['tagHash is REPLACE_ME', ON, { tagHash: 'REPLACE_ME' }],
    ['tagHash is another hash', ON, { tagHash: '0123456789abcdef0123456789abcdef' }],
    ['tagHash is left out', ON, { tagHash: undefined }],
    ['the src has no /i/<hash>.js', { enabled: true, tag: scriptWith('src="https://rocky.lordofthesuperfrogs.com/tag.js" class="c"') }, {}],
    ['/i/<hash>.js is in the query, not in the path',
      { enabled: true, tag: scriptWith(`src="https://rocky.lordofthesuperfrogs.com/tag.js?u=/i/${CONSOLE_TAG_HASH}.js" class="c"`) }, {}],
    ['tagHash is left out and the src has no /i/<hash>.js: both are missing',
      { enabled: true, tag: scriptWith('src="https://t.example/tag.js" class="c"') }, { tagHash: undefined }],
  ])('stays on when %s, and says so', (_, interstitial, other) => {
    // Act
    const { service } = build(interstitial, other);

    // Assert
    expect(service.on).toBe(true);
    expect(service.problems).toEqual([
      'interstitial.tag: the hash in its src is not tagHash, check that the tag line and tagHash belong to the same tag',
    ]);
  });

  test.each([
    ['a query string', CONSOLE_LINE.replace('.js"', '.js?v=2"')],
    ['a longer path', CONSOLE_LINE.replace('.com/i/', '.com/cheq/i/')],
  ])('finds the hash in a src with %s', (_, tag) => {
    // Act
    const { service } = build({ enabled: true, tag });

    // Assert
    expect(service.on).toBe(true);
    expect(service.problems).toEqual([]);
  });

  test.each([
    ['onSecondVerdict', 'BLOCK'],
    ['onSecondVerdict', 4],
    ['onSecondVerdict', null],
    ['onSessionNotFound', 'ALLOW'],
    ['onSessionNotFound', 1.5],
    ['onSessionNotFound', -1],
    ['maxWaitMs', 999],
    ['maxWaitMs', 30001],
    ['maxWaitMs', 1500.5],
    ['maxWaitMs', '5000'],
    ['statusCode', 201],
    ['statusCode', 302],
    ['statusCode', 399],
    ['statusCode', 600],
    ['statusCode', 403.5],
    ['statusCode', '403'],
    ['originalRefererVia', 'Header'],
    ['originalRefererVia', 'query'],
    ['originalRefererVia', true],
    ['binding', { ip: 'subnet', userAgent: true }],
    ['binding', { ip: 'EXACT', userAgent: true }],
    ['binding', { ip: 'exact' }],
    ['binding', { userAgent: true }],
    ['binding', { ip: 'none', userAgent: 'yes' }],
    ['binding', 'exact'],
    ['binding', null],
    ['logoUrl', 'http://cdn.example/logo.png'],
    ['logoUrl', '//cdn.example/logo.png'],
    ['logoUrl', 'https://'],
    ['logoUrl', logoOfLength(201)],
    ['logoUrl', 42],
    ['headline', ''],
    ['headline', 'x'.repeat(61)],
    ['headline', 5],
    ['message', ''],
    ['message', 'x'.repeat(161)],
    ['message', null],
    ['lang', 'english'],
    ['lang', 'e'],
    ['lang', 'en_US'],
    ['lang', 'en-'],
    ['lang', 'en-abcdefghi'],
    ['lang', `${LANG_35}f`],
    ['lang', 1],
    ['logOutcomes', 'true'],
    ['logOutcomes', 1],
    ['logOutcomes', null],
  ])('stays on with %s: %j, uses the default and says so', (name, value) => {
    // Arrange
    const [allowed, writtenDefault] = ALLOWED[name];

    // Act
    const { service } = build({ ...ON, [name]: value });

    // Assert
    expect(service.on).toBe(true);
    expect(service.settings).toEqual(DEFAULTS);
    expect(service.problems).toEqual([`interstitial.${name}: ${JSON.stringify(value)} is not ${allowed}, using ${writtenDefault}`]);
  });

  test('writes one text per wrong setting, in the order of the settings', () => {
    // Arrange
    const interstitial = {
      ...ON,
      onSecondVerdict: 'BLOCK',
      onSessionNotFound: 9,
      maxWaitMs: 1,
      statusCode: 302,
      originalRefererVia: 'url',
      binding: {},
      logoUrl: 'http://cdn.example/logo.png',
      headline: '',
      message: '',
      lang: 'x',
      logOutcomes: 'yes',
    };

    // Act
    const { service } = build(interstitial);

    // Assert
    expect(service.on).toBe(true);
    expect(service.settings).toEqual(DEFAULTS);
    expect(service.problems).toEqual([
      'interstitial.onSecondVerdict: "BLOCK" is not an Action, using Action.ALLOW',
      'interstitial.onSessionNotFound: 9 is not an Action, using Action.ALLOW',
      'interstitial.maxWaitMs: 1 is not a whole number from 1000 to 30000, using 5000',
      'interstitial.statusCode: 302 is not 200 or a whole number from 400 to 599, using 403',
      'interstitial.originalRefererVia: "url" is not "header" or "cookie", using "header"',
      'interstitial.binding: {} is not { ip: "exact" or "none", userAgent: true or false }, using {"ip":"exact","userAgent":true}',
      'interstitial.logoUrl: "http://cdn.example/logo.png" is not an https:// URL of at most 200 characters, using undefined',
      'interstitial.headline: "" is not text of 1 to 60 characters, using "Checking your browser"',
      'interstitial.message: "" is not text of 1 to 160 characters, using "This usually takes about a second."',
      'interstitial.lang: "x" is not a language tag such as "en" or "en-US", using "en"',
      'interstitial.logOutcomes: "yes" is not true or false, using true',
    ]);
  });

  test.each([
    ['CAPTCHA', ActionStrategy.CAPTCHA],
    ['ACCESS_DENIED, which is 0', ActionStrategy.ACCESS_DENIED],
    ['null', null],
  ])('stays on with challengingStrategy %s, and says that it is not used for page loads', (_, challengingStrategy) => {
    // Act
    const { service } = build(ON, { challengingStrategy });

    // Assert
    expect(service.on).toBe(true);
    expect(service.settings).toEqual(DEFAULTS);
    expect(service.problems).toEqual([
      'challengingStrategy is set but not used for page loads while the interstitial is on',
    ]);
  });

  test('writes the texts of the hash, the settings and challengingStrategy in this order', () => {
    // Act
    const { service } = build({ ...ON, maxWaitMs: 1 }, { tagHash: 'REPLACE_ME', challengingStrategy: ActionStrategy.CAPTCHA });

    // Assert
    expect(service.on).toBe(true);
    expect(service.problems).toEqual([
      'interstitial.tag: the hash in its src is not tagHash, check that the tag line and tagHash belong to the same tag',
      'interstitial.maxWaitMs: 1 is not a whole number from 1000 to 30000, using 5000',
      'challengingStrategy is set but not used for page loads while the interstitial is on',
    ]);
  });
  // #endregion On (rows 5 to 8)

  test.each([
    ['on', ON],
    ['off', { enabled: false }],
    ['off by a problem', { enabled: true }],
  ])('freezes the instance and its problems when the interstitial is %s', (_, interstitial) => {
    // Act
    const { service } = build(interstitial);

    // Assert
    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.isFrozen(service.problems)).toBe(true);
  });

  test('freezes the settings, their tag attributes, each pair of them and their binding', () => {
    // Act
    const { service } = build({ ...ON, binding: { ip: 'none', userAgent: false } });

    // Assert
    const settings = service.settings!;
    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.tagAttributes)).toBe(true);
    expect(settings.tagAttributes.length).toBeGreaterThan(0);
    expect(settings.tagAttributes.every(pair => Object.isFrozen(pair))).toBe(true);
    expect(Object.isFrozen(settings.binding)).toBe(true);
  });

  test.each([
    ['on', ON],
    ['off', { enabled: false }],
    ['off by a problem', { enabled: true }],
  ])('has only on, settings and problems as properties when the interstitial is %s: the API key and the HMAC function are private', (_, interstitial) => {
    // Act
    const { service, hmac } = build(interstitial);

    // Assert
    expect(Object.keys(service).sort()).toEqual(['on', 'problems', 'settings']);
    expect(Object.getOwnPropertyNames(service).sort()).toEqual(['on', 'problems', 'settings']);
    expect(Object.values(service)).not.toContain(hmac);
    expect(JSON.stringify(service)).not.toContain('test-api-key');
  });
});

describe('InterstitialService.decide', () => {
  // On, with actions that are not the defaults, so that each "act" row shows which setting it took.
  const { service } = build({ enabled: true, tag: CONSOLE_LINE, onSecondVerdict: Action.BLOCK, onSessionNotFound: Action.REDIRECT });

  // The facts of no row: a page load, no session, no mark.
  const NO_ROW: InterstitialFacts = { pageLoad: true, sessionFound: null, validMark: false };

  test.each([
    ['1, not a page load', { pageLoad: false }, { kind: 'forward', reason: 'not-a-page-load' }],
    ['2, sessionFound true', { sessionFound: true }, { kind: 'act', action: Action.BLOCK, reason: 'second-verdict' }],
    ['3, a valid mark and sessionFound null', { validMark: true }, { kind: 'act', action: Action.REDIRECT, reason: 'no-session' }],
    ['3, a valid mark and sessionFound false', { validMark: true, sessionFound: false }, { kind: 'act', action: Action.REDIRECT, reason: 'no-session' }],
    ['4, none of these, sessionFound null', {}, { kind: 'show' }],
    ['4, none of these, sessionFound false', { sessionFound: false }, { kind: 'show' }],
  ])('row %s', (_, facts, outcome) => {
    // Act & Assert
    expect(service.decide({ ...NO_ROW, ...facts })).toEqual(outcome);
  });

  test.each([
    ['1 comes before 2 and 3', { pageLoad: false, sessionFound: true, validMark: true }, { kind: 'forward', reason: 'not-a-page-load' }],
    ['2 comes before 3', { sessionFound: true, validMark: true }, { kind: 'act', action: Action.BLOCK, reason: 'second-verdict' }],
  ])('row %s', (_, facts, outcome) => {
    // Act & Assert
    expect(service.decide({ ...NO_ROW, ...facts })).toEqual(outcome);
  });

  test('takes the default actions (ALLOW) when the settings leave them out', () => {
    // Arrange
    const { service: defaults } = build({ enabled: true, tag: CONSOLE_LINE });

    // Act & Assert
    expect(defaults.decide({ ...NO_ROW, sessionFound: true })).toEqual({ kind: 'act', action: Action.ALLOW, reason: 'second-verdict' });
    expect(defaults.decide({ ...NO_ROW, validMark: true })).toEqual({ kind: 'act', action: Action.ALLOW, reason: 'no-session' });
  });

  test.each([
    ['the facts of no row', {}],
    ['sessionFound true', { sessionFound: true }],
    ['a valid mark', { validMark: true }],
    ['not a page load', { pageLoad: false }],
  ])('gives row 1 with the interstitial off, whatever the facts: %s', (_, facts) => {
    // Arrange
    const { service: off } = build({ enabled: false });

    // Act & Assert
    expect(off.decide({ ...NO_ROW, ...facts })).toEqual({ kind: 'forward', reason: 'not-a-page-load' });
  });
});

describe('InterstitialService.page', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    ['403, the default', {}, 403],
    ['200, when the settings say so', { statusCode: 200 }, 200],
  ])('answers with the status of the settings: %s', async (_, interstitial, status) => {
    // Arrange
    const { service } = buildOn(interstitial);

    // Act
    const answer = await service.page(MADE, 'ray-1');

    // Assert
    expect(answer.status).toBe(status);
  });

  test('answers with exactly three headers: the type, no caching and noindex', async () => {
    // Arrange
    const { service } = buildOn();

    // Act
    const answer = await service.page(MADE, 'ray-1');

    // Assert
    expect(answer.headers).toStrictEqual({
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Robots-Tag': 'noindex',
    });
  });

  test('answers with the page of interstitialPage, for the settings, the ray id and the script values', async () => {
    // Arrange
    const { service } = buildOn({ headline: 'One moment' });

    // Act
    const answer = await service.page(MADE, 'ray-1');

    // Assert
    expect(answer.body).toBe(interstitialPage(service.settings!, 'ray-1', valuesIn(answer.body)));
    expect(answer.body).toContain('<h1>One moment</h1>');
  });

  test.each([5000, 30000])('makes the mark as the brief gives it, with maxWaitMs %i', async (maxWaitMs) => {
    // Arrange
    const { service } = buildOn({ maxWaitMs });
    const key = await keyOf(API_KEY);
    const pageTag = (await realHmac(key, JSON.stringify(['page', '/sofas']))).slice(0, 16);
    const expiresAt = NOW + maxWaitMs + 70000;
    const signature = await realHmac(key, JSON.stringify(['it', expiresAt, 'ray-1', pageTag, GOOGLE, 'K']));

    // Act
    const values = valuesIn((await service.page(MADE, 'ray-1')).body);

    // Assert: <setup id>|<expiresAt>.<signature>|<ray id>|<page tag>|<Referer>
    expect(values.markValue).toBe(`${await setupIdOf(API_KEY)}|${expiresAt}.${signature}|ray-1|${pageTag}|${encodeURIComponent(GOOGLE)}`);
  });

  test('hands the script the mark, its name, the setup id, the attributes, 60 seconds, the tag and maxWaitMs', async () => {
    // Arrange
    const { service } = buildOn({ maxWaitMs: 7000 });

    // Act
    const values = valuesIn((await service.page(MADE, 'ray-1')).body);

    // Assert
    expect(values).toStrictEqual({
      markName: '_cq_it',
      markValue: expect.stringMatching(/^[0-9a-f]{8}\|/),
      setupId: await setupIdOf(API_KEY),
      cookieAttributes: '; Path=/; SameSite=Lax; Secure',
      maxAgeSeconds: 60,
      tag: service.settings!.tagAttributes,
      maxWaitMs: 7000,
    });
  });

  test.each([
    ['https:', 'https://example.com/sofas?gclid=abc', '; Path=/; SameSite=Lax; Secure'],
    ['http:', 'http://example.com/sofas?gclid=abc', '; Path=/; SameSite=Lax'],
  ])('hands the script cookieAttributes that start with "; ", with Secure only for an https: URL: %s', async (_, url, attributes) => {
    // Arrange
    const { service } = buildOn();

    // Act
    const values = valuesIn((await service.page({ ...MADE, url }, 'ray-1')).body);

    // Assert
    expect(values.cookieAttributes.startsWith('; ')).toBe(true);
    expect(values.cookieAttributes).toBe(attributes);
  });

  test('hands the script a setup id of 8 lower-case hex characters, so it is not empty', async () => {
    // Arrange
    const { service } = buildOn();

    // Act
    const values = valuesIn((await service.page(MADE, 'ray-1')).body);

    // Assert
    expect(values.setupId).toMatch(/^[0-9a-f]{8}$/);
  });

  test('makes a mark with no ;, comma or space for a ray id and a Referer that hold them: both are URL-encoded', async () => {
    // Arrange
    const { service } = buildOn();
    const rayId = 'r|a y;1,é';

    // Act
    const values = valuesIn((await service.page({ ...MADE, referer: 'https://example.com/a b;c,d' }, rayId)).body);

    // Assert
    expect(values.markValue).not.toMatch(/[;, ]/);
    expect(values.markValue.split('|')[2]).toBe(encodeURIComponent(rayId));
  });

  test.each([
    ['"cookie" mode: the original Referer as it is, not encoded', { originalRefererVia: 'cookie' }, MADE.referer, GOOGLE],
    ['"header" mode: no referer', { originalRefererVia: 'header' }, MADE.referer, undefined],
    ['"cookie" mode without an original Referer: no referer, not ""', { originalRefererVia: 'cookie' }, null, undefined],
  ])('hands the script referer only in "cookie" mode: %s', async (_, interstitial, referer, expected) => {
    // Arrange
    const { service } = buildOn(interstitial);

    // Act
    const values = valuesIn((await service.page({ ...MADE, referer }, 'ray-1')).body);

    // Assert
    expect('referer' in values).toBe(expected !== undefined);
    expect(values.referer).toBe(expected);
  });

  test('rejects when the HMAC rejects, and so does readMark: that is no client input, and the glue catches it', async () => {
    // Arrange
    const hmac = vi.fn<HmacHex32>().mockRejectedValue(new Error('no HMAC'));
    const config = { apiKey: API_KEY, tagHash: CONSOLE_TAG_HASH, interstitial: { enabled: true, tag: CONSOLE_LINE } };
    const service = new InterstitialService(config as unknown as Config, hmac);

    // Act & Assert
    await expect(service.page(MADE, 'ray-1')).rejects.toThrow('no HMAC');
    await expect(service.readMark(reload('_cq_it=x'))).rejects.toThrow('no HMAC');
  });

  test('rejects while the interstitial is off, without calling the HMAC', async () => {
    // Arrange
    const { service, hmac } = buildOn({ enabled: false });

    // Act & Assert
    await expect(service.page(MADE, 'ray-1')).rejects.toThrow('the interstitial is off');
    expect(hmac).not.toHaveBeenCalled();
  });
});

describe('InterstitialService.readMark', () => {
  // The clock. A test moves it.
  let now: MockInstance<() => number>;

  beforeEach(() => {
    now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // What readMark gives on the reload of MADE: valid, for this page, with the mark's Referer.
  const ON_ITS_PAGE = { firstRayId: 'ray-1', forThisPage: true, referer: GOOGLE };

  // #region Valid marks
  test.each([
    ['missing (null)', null],
    ['empty', ''],
  ])('reads back the mark on the reload of the same request, its own Referer %s (row 1)', async (_, referer) => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${mark}`, { referer }));

    // Assert
    expect(valid).toStrictEqual(ON_ITS_PAGE);
  });

  test('finds the mark among other cookies, with spaces around them', async () => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);

    // Act
    const valid = await service.readMark(reload(`a=1;  _cq_it=${mark} ; _cq_pvid=x`));

    // Assert
    expect(valid).toStrictEqual(ON_ITS_PAGE);
  });

  test('reads back a ray id that the mark holds URL-encoded', async () => {
    // Arrange
    const { service } = buildOn();
    const rayId = 'r|a y;1,é';
    const mark = valuesIn((await service.page(MADE, rayId)).body).markValue;

    // Act
    const valid = await service.readMark(reload(`_cq_it=${mark}`));

    // Assert
    expect(valid).toStrictEqual({ ...ON_ITS_PAGE, firstRayId: rayId });
  });

  test.each([5000, 30000])('accepts the mark up to its expiry, maxWaitMs (%i) and 70 seconds after the page, and not 1 ms later (row 2)', async (maxWaitMs) => {
    // Arrange: the script writes the mark up to maxWaitMs after it starts, with Max-Age=60.
    const { service } = buildOn({ maxWaitMs });
    const mark = await makeMark(service);
    const expiresAt = NOW + maxWaitMs + 70000;

    // Act
    now.mockReturnValue(expiresAt);
    const atExpiry = await service.readMark(reload(`_cq_it=${mark}`));
    now.mockReturnValue(expiresAt + 1);
    const later = await service.readMark(reload(`_cq_it=${mark}`));

    // Assert
    expect(mark.split('|')[1].split('.')[0]).toBe(String(expiresAt));
    expect(atExpiry).toStrictEqual(ON_ITS_PAGE);
    expect(later).toBeUndefined();
  });

  test.each([
    ['the origin\'s redirect target /sofas/', 'https://example.com/sofas/'],
    ['another path with the same query, /en/sofas', 'https://example.com/en/sofas?gclid=abc'],
  ])('gives a valid mark that is not for this page, without the mark\'s Referer, on %s (row 7)', async (_, url) => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${mark}`, { url }));

    // Assert
    expect(valid).toStrictEqual({ firstRayId: 'ray-1', forThisPage: false });
  });

  test.each([
    ['the page itself: the same host, path and query (row 9)', PAGE_URL, PAGE_URL, true],
    ['the page itself with its host in upper case, a port and a #fragment', PAGE_URL, 'https://EXAMPLE.com:8443/sofas?gclid=abc#top', true],
    ['another page of the site (row 8)', PAGE_URL, 'https://example.com/other', false],
    ['the same path with another query', PAGE_URL, 'https://example.com/sofas?gclid=xyz', false],
    ['the same path without the query', PAGE_URL, 'https://example.com/sofas', false],
    ['the same path and query on another site', PAGE_URL, 'https://www.google.com/sofas?gclid=abc', false],
    ['text that is not a URL', PAGE_URL, 'not a url', false],
    ['the mark\'s page, and the request on another host of the main domain', 'https://www.example.com/sofas?gclid=abc', PAGE_URL, false],
  ])('gives the mark\'s Referer on the mark\'s page only when the own Referer is missing or the page itself: %s', async (_, url, referer, withReferer) => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${mark}`, { url, referer }));

    // Assert
    expect(valid).toStrictEqual(withReferer ? ON_ITS_PAGE : { firstRayId: 'ray-1', forThisPage: true });
  });

  test('gives a valid mark for this page without its Referer when the request is not a page load (row 10)', async () => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${mark}`, { pageLoad: false }));

    // Assert
    expect(valid).toStrictEqual({ firstRayId: 'ray-1', forThisPage: true });
  });

  test('makes a short mark for a path of 5000 characters, and reads it back (row 11)', async () => {
    // Arrange
    const { service } = buildOn();
    const url = `https://example.com/${'a'.repeat(4999)}`;

    // Act
    const mark = await makeMark(service, { ...MADE, url });
    const valid = await service.readMark(reload(`_cq_it=${mark}`, { url }));

    // Assert
    expect(new URL(url).pathname).toHaveLength(5000);
    expect(mark.length).toBeLessThan(200 + encodeURIComponent(GOOGLE).length);
    expect(valid).toStrictEqual(ON_ITS_PAGE);
  });

  test('carries a Referer with |, ;, a comma, a space, % and é, and reads it back the same (row 12)', async () => {
    // Arrange: a Referer on the same host, so that originalReferer keeps its path and query. The URL parser encodes the
    // space and the é. The |, ;, comma and % stay.
    const { service } = buildOn({ originalRefererVia: 'cookie' });
    const referer = 'https://example.com/a|b;c,d e%f/é?q=|;, %é';
    const original = 'https://example.com/a|b;c,d%20e%f/%C3%A9?q=|;,%20%%C3%A9';

    // Act
    const values = valuesIn((await service.page({ ...MADE, referer }, 'ray-1')).body);
    const valid = await service.readMark(reload(`_cq_it=${values.markValue}`));

    // Assert
    expect(values.referer).toBe(original);
    expect(values.markValue).not.toMatch(/[;, ]/);
    expect(valid).toStrictEqual({ firstRayId: 'ray-1', forThisPage: true, referer: original });
  });

  test('makes a mark that ends with | when there is no Referer, and reads it back without referer (row 13)', async () => {
    // Arrange
    const { service } = buildOn();

    // Act
    const mark = await makeMark(service, { ...MADE, referer: null });
    const valid = await service.readMark(reload(`_cq_it=${mark}`));

    // Assert
    expect(mark.endsWith('|')).toBe(true);
    expect(valid).toStrictEqual({ firstRayId: 'ray-1', forThisPage: true });
  });

  test.each([
    ['https://partner.example/: that one', 'https://partner.example/', 'https://partner.example/'],
    ['"": the request\'s own', '', GOOGLE],
    ['left out: the request\'s own', undefined, GOOGLE],
  ])('carries the original Referer of carriedReferer %s (row 14)', async (_, carriedReferer, expected) => {
    // Arrange
    const { service } = buildOn({ originalRefererVia: 'cookie' });

    // Act
    const values = valuesIn((await service.page(MADE, 'ray-1', carriedReferer)).body);
    const valid = await service.readMark(reload(`_cq_it=${values.markValue}`));

    // Assert
    expect(values.markValue.split('|')[4]).toBe(encodeURIComponent(expected));
    expect(values.referer).toBe(expected);
    expect(valid).toStrictEqual({ ...ON_ITS_PAGE, referer: expected });
  });

  test('checks the first _cq_it with our id: a mark of another setup before ours is skipped (row 15)', async () => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);
    const otherMark = await makeMark(buildOn({}, 'other-api-key').service);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${otherMark}; _cq_it=${mark}`));

    // Assert
    expect(valid).toStrictEqual(ON_ITS_PAGE);
  });
  // #endregion Valid marks

  // #region No mark
  test('gives no mark to another client: binding key K2 (row 3)', async () => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${mark}`, { bindingKey: 'K2' }));

    // Assert
    expect(valid).toBeUndefined();
  });

  test.each([
    ['the expiry, 1 ms later', (m: string) => withPart(m, 1, p => p.replace(/^\d+/, e => String(Number(e) + 1)))],
    ['the signature, its last character', (m: string) => withPart(m, 1, p => p.slice(0, -1) + (p.endsWith('0') ? '1' : '0'))],
    // The last character stays, so the compare must keep every difference it found before, not only the last one.
    ['the signature, its first character', (m: string) => withPart(m, 1, p => p.replace(/\.(.)/, (_, c: string) => `.${c === '0' ? '1' : '0'}`))],
    ['the ray id', (m: string) => withPart(m, 2, () => 'ray-2')],
    ['the page tag, its last character', (m: string) => withPart(m, 3, p => p.slice(0, -1) + (p.endsWith('0') ? '1' : '0'))],
    ['the Referer', (m: string) => withPart(m, 4, () => encodeURIComponent('https://evil.example/'))],
    ['the ray id part missing', (m: string) => m.split('|').filter((_, i) => i !== 2).join('|')],
    ['a sixth part', (m: string) => `${m}|x`],
    ['a third part after the signature', (m: string) => withPart(m, 1, p => `${p}.x`)],
    ['the expiry written with a + (+123)', (m: string) => withPart(m, 1, p => `+${p}`)],
    ['the expiry written with a leading 0 (0123)', (m: string) => withPart(m, 1, p => `0${p}`)],
    ['the signature in upper-case hex', (m: string) => withPart(m, 1, p => p.toUpperCase())],
    ['the page tag in upper-case hex', (m: string) => withPart(m, 3, p => p.toUpperCase())],
    ['the ray id encoded another way: ray%2D1 for ray-1', (m: string) => withPart(m, 2, () => 'ray%2D1')],
    ['the Referer with its escapes in lower case', (m: string) => withPart(m, 4, p => p.toLowerCase())],
  ])('gives no mark when a mark has %s (row 4)', async (_, edit) => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);
    const edited = edit(mark);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${edited}`));

    // Assert
    expect(edited).not.toBe(mark);
    expect(valid).toBeUndefined();
  });

  test.each([
    ['1.a|%|a|%, as a client can write it', (_mark: string) => '1.a|%|a|%'],
    ['1.a|%|a|% after our setup id', (mark: string) => `${mark.split('|')[0]}|1.a|%|a|%`],
    ['our mark with %ED%A0%80 as its ray id', (mark: string) => withPart(mark, 2, () => '%ED%A0%80')],
    ['our mark with %ED%A0%80 as its Referer', (mark: string) => withPart(mark, 4, () => '%ED%A0%80')],
    ['our mark with a lone % as its ray id', (mark: string) => withPart(mark, 2, () => '%')],
  ])('gives no mark, and does not reject, for text that does not parse or decode: %s (row 5)', async (_, valueOf) => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);

    // Act & Assert
    await expect(service.readMark(reload(`_cq_it=${valueOf(mark)}`))).resolves.toBeUndefined();
  });

  test('gives no mark for a mark of another setup, after two HMAC calls: the key and our id (row 6)', async () => {
    // Arrange
    const { service, hmac } = buildOn();
    const otherMark = await makeMark(buildOn({}, 'other-api-key').service);
    const key = await keyOf(API_KEY);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${otherMark}`));

    // Assert
    expect(otherMark.split('|')[0]).toBe(await setupIdOf('other-api-key'));
    expect(otherMark.split('|')[0]).not.toBe(await setupIdOf(API_KEY));
    expect(valid).toBeUndefined();
    expect(hmac.mock.calls).toEqual([[API_KEY, 'cheq-interstitial-mark-v1'], [key, 'cheq-interstitial-setup-id']]);
  });

  test('checks only the first _cq_it with our id: our edited mark before our valid one gives no mark (row 15)', async () => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${withPart(mark, 2, () => 'ray-2')}; _cq_it=${mark}`));

    // Assert
    expect(valid).toBeUndefined();
  });

  test.each([
    ['the interstitial is off, with a mark that is valid otherwise', { enabled: false }, (mark: string) => `_cq_it=${mark}`],
    ['there is no Cookie header', {}, (_mark: string) => ''],
    ['no cookie is named _cq_it', {}, (_mark: string) => 'a=1; _cq_itx=2; x_cq_it=3; _cq_pvid=4'],
  ])('gives no mark, without calling the HMAC, when %s (row 16)', async (_, interstitial, cookieWith) => {
    // Arrange
    const mark = await makeMark(buildOn().service);
    const { service, hmac } = buildOn(interstitial);

    // Act
    const valid = await service.readMark(reload(cookieWith(mark)));

    // Assert
    expect(valid).toBeUndefined();
    expect(hmac).not.toHaveBeenCalled();
  });

  test.each([
    ['our id in upper case', (id: string) => id.toUpperCase()],
    ['our id without its last character: 7 characters', (id: string) => id.slice(0, 7)],
    ['our id with one more character: 9 characters', (id: string) => `${id}0`],
  ])('gives no mark when the id field is not our 8 lower-case hex characters: %s (row 17)', async (_, change) => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);
    const edited = withPart(mark, 0, change);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${edited}`));

    // Assert
    expect(edited).not.toBe(mark);
    expect(valid).toBeUndefined();
  });

  test('gives no mark for a mark without its id field: its four other parts (row 17)', async () => {
    // Arrange
    const { service } = buildOn();
    const mark = await makeMark(service);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${mark.split('|').slice(1).join('|')}`));

    // Assert
    expect(valid).toBeUndefined();
  });

  test('gives no mark when the HMAC gives a signature of another length: the compare does not shorten it', async () => {
    // Arrange: the mark is made with the real HMAC. The reader's HMAC gives "" for the signature, and the real value
    // for anything else.
    const mark = await makeMark(buildOn().service);
    const hmac = vi.fn<HmacHex32>(async (key, message) => (message.startsWith('["it",') ? '' : realHmac(key, message)));
    const config = { apiKey: API_KEY, tagHash: CONSOLE_TAG_HASH, interstitial: { enabled: true, tag: CONSOLE_LINE } };
    const service = new InterstitialService(config as unknown as Config, hmac);

    // Act
    const valid = await service.readMark(reload(`_cq_it=${mark}`));

    // Assert
    expect(hmac).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^\["it",/));
    expect(valid).toBeUndefined();
  });
  // #endregion No mark
});
