// cspell:ignore CHEQ jsonp clicktrue lordofthesuperfrogs gclid
import { describe, test, expect, vi, afterEach, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { INTERSTITIAL_SCRIPT, interstitialPage, scriptJson, type InterstitialScriptValues } from './interstitial-page-helpers';
import { InterstitialService } from '../services/interstitial.service';
import { RTIStatelessUtils } from '../services/rti-stateless-utils';
import { CONSOLE_LINE, CONSOLE_TAG_HASH } from '../testing/interstitial.fixture';
import type { Config } from '../models/config.interface';
import type { HmacHex32, ResolvedInterstitialSettings } from '../models/interstitial.model';

// Built from their codes, so that this file holds no backslash escape and no U+2028 or U+2029.
const BACKSLASH = String.fromCharCode(92);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const CHINESE = String.fromCharCode(0x4e2d);

// The settings of an interstitial that is on with the console's tag line and these settings, every other one its
// default. They come from InterstitialService, so a value it would not accept fails the test here.
const settingsWith = (interstitial: Record<string, unknown> = {}): ResolvedInterstitialSettings => {
  const config = { apiKey: 'test-api-key', tagHash: CONSOLE_TAG_HASH, interstitial: { enabled: true, tag: CONSOLE_LINE, ...interstitial } };
  const service = new InterstitialService(config as unknown as Config, vi.fn<HmacHex32>());
  expect(service.problems).toEqual([]);
  return service.settings!;
};

// This setup's id, and a mark that starts with it.
const SETUP_ID = '5e7a9c01';
const MARK_VALUE = `${SETUP_ID}|1700000060000.0123456789abcdef0123456789abcdef|ray-1|0123456789abcdef|https%3A%2F%2Fwww.google.com%2F`;

// The script's values for a page of these settings.
const valuesFor = (settings: ResolvedInterstitialSettings, more: Partial<InterstitialScriptValues> = {}): InterstitialScriptValues => ({
  markName: '_cq_it',
  markValue: MARK_VALUE,
  setupId: SETUP_ID,
  cookieAttributes: '; Path=/; SameSite=Lax',
  maxAgeSeconds: 60,
  tag: settings.tagAttributes,
  maxWaitMs: settings.maxWaitMs,
  ...more,
});

// How often `part` is in `text`.
const count = (text: string, part: string): number => text.split(part).length - 1;

// The text between the page's <script> and </script>.
const scriptOf = (page: string): string => page.slice(page.indexOf('<script>') + '<script>'.length, page.indexOf('</script>'));

describe('interstitialPage', () => {
  test('builds the page with the defaults (row 1)', () => {
    // Arrange
    const settings = settingsWith();

    // Act
    const page = interstitialPage(settings, 'ray-1', valuesFor(settings));

    // Assert
    expect(page.startsWith('<!DOCTYPE html>')).toBe(true);
    for (const part of ['<html lang="en">', '<meta name="robots" content="noindex">', '<title>Checking your browser</title>',
      '<h1>Checking your browser</h1>', 'Ray ID: ray-1', 'Protected by Cheq.ai', 'background:#fff', '<svg']) {
      expect(page).toContain(part);
    }
    expect(page).toMatch(/<(\w+) [^>]*role="status" aria-live="polite"[^>]*>This usually takes about a second\.<\/\1>/);
    expect(page).toMatch(/<noscript>(<p>)?Please turn on JavaScript, then reload the page\.(<\/p>)?<\/noscript>/);
    expect(page).toMatch(/<p [^>]*\bhidden\b[^>]*>We could not check your browser\. <button type="button">Try again<\/button><\/p>/);
    expect(page).toMatch(/<p [^>]*\bhidden\b[^>]*>Please allow cookies for this site, then reload the page\.<\/p>/);
    expect(page).not.toContain('<img');
  });

  test('has a progress ring that stops for prefers-reduced-motion (row 1)', () => {
    // Arrange
    const settings = settingsWith();

    // Act
    const page = interstitialPage(settings, 'ray-1', valuesFor(settings));

    // Assert
    const ring = /<div id="(\w+)" aria-hidden="true"><\/div>/.exec(page)?.[1];
    expect(ring).toBeDefined();
    const animation = new RegExp(`#${ring}\\{[^}]*animation:(\\w+) [^}]*\\}`).exec(page)?.[1];
    expect(page).toContain(`@keyframes ${animation}{`);
    expect(page).toContain(`@media (prefers-reduced-motion:reduce){#${ring}{animation:none}}`);
  });

  test('shows the logo of logoUrl, escaped, in place of the inline logo (row 2)', () => {
    // Arrange
    const settings = settingsWith({ logoUrl: 'https://cdn.example/l.svg?a=1&b=2' });

    // Act
    const page = interstitialPage(settings, 'ray-1', valuesFor(settings));

    // Assert
    expect(page).toContain('<img src="https://cdn.example/l.svg?a=1&amp;b=2" alt="">');
    expect(page).not.toContain('<svg');
  });

  test('escapes the headline, the message, the ray id and the language (row 3)', () => {
    // Arrange
    const text = `<script>alert(1)</script>"'&`;
    const settings = settingsWith({ headline: text, message: text, lang: 'en-US' });

    // Act
    const page = interstitialPage(settings, text, valuesFor(settings));

    // Assert
    expect(count(page, '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;')).toBe(4);
    expect(page).not.toContain('<script>alert');
    expect(page).toContain('<html lang="en-US">');
  });

  test('writes each < of the script values as an escape, so a value cannot end the script (row 4)', () => {
    // Arrange
    const settings = settingsWith();
    const values = valuesFor(settings, { markValue: `${SETUP_ID}|</script><script>alert(1)</script>` });

    // Act
    const page = interstitialPage(settings, 'ray-1', values);

    // Assert
    expect(count(page, '<script')).toBe(1);
    expect(count(page, '</script>')).toBe(1);
    const script = scriptOf(page);
    expect(script.startsWith(`${INTERSTITIAL_SCRIPT}(`)).toBe(true);
    const json = script.slice(INTERSTITIAL_SCRIPT.length + 1, -1);
    expect(json).not.toContain('<');
    expect(json).toContain(`${BACKSLASH}u003c/script>${BACKSLASH}u003cscript>alert(1)${BACKSLASH}u003c/script>`);
    expect(JSON.parse(json)).toEqual(values);
  });

  test('stays below 12288 bytes with the longest values the settings allow (row 6)', () => {
    // Arrange: a tag line of 800 characters, with values of " (in single quotes) and of a three-byte character.
    const start = `<script src='https://rocky.lordofthesuperfrogs.com/i/${CONSOLE_TAG_HASH}.js' class='${'"'.repeat(100)}' data-x='`;
    const end = `'></script>`;
    const tag = start + CHINESE.repeat(800 - start.length - end.length) + end;
    const logoUrl = 'https://cdn.example/l.svg?' + '&'.repeat(200 - 'https://cdn.example/l.svg?'.length);
    const settings = settingsWith({ tag, logoUrl, headline: '"'.repeat(60), message: '"'.repeat(160) });
    const values = valuesFor(settings, { markValue: 'm'.repeat(1500), referer: 'r'.repeat(420) });

    // Act
    const page = interstitialPage(settings, 'f'.repeat(64), values);

    // Assert
    expect(tag).toHaveLength(800);
    expect(settings.logoUrl).toHaveLength(200);
    expect(settings.headline).toHaveLength(60);
    expect(settings.message).toHaveLength(160);
    expect(new TextEncoder().encode(page).length).toBeLessThan(12288);
  });
});

describe('scriptJson', () => {
  test('writes U+2028 and U+2029 as escapes (row 5)', () => {
    // Act & Assert
    expect(scriptJson(LINE_SEPARATOR + PARAGRAPH_SEPARATOR)).toBe(`"${BACKSLASH}u2028${BACKSLASH}u2029"`);
  });

  test.each([
    ['<, > and &', 'a<b>c&d'],
    ['quotes', `"it's"`],
    ['U+2028 and U+2029', `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`],
    ['an object with all of them', { tag: [['data-x', `<"'&>${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`]], maxWaitMs: 5000 }],
  ])('gives back the same value through JSON.parse for %s (row 5)', (_, value) => {
    // Act
    const json = scriptJson(value);

    // Assert
    expect(json).not.toContain('<');
    expect(json).not.toContain(LINE_SEPARATOR);
    expect(json).not.toContain(PARAGRAPH_SEPARATOR);
    expect(JSON.parse(json)).toEqual(value);
  });
});

describe('INTERSTITIAL_SCRIPT', () => {
  test('is one function expression with no </ and no <!-- in any case, so it cannot end the <script> element (row 7)', () => {
    // Act & Assert
    expect(INTERSTITIAL_SCRIPT).toMatch(/^\(function \(c\) \{[\s\S]*\}\)$/);
    expect(INTERSTITIAL_SCRIPT.toLowerCase()).not.toContain('</');
    expect(INTERSTITIAL_SCRIPT.toLowerCase()).not.toContain('<!--');
  });
});

describe('the interstitial code in core stays neutral (row 8)', () => {
  test.each([
    ['../models/interstitial.model.ts'],
    ['../services/interstitial.service.ts'],
    ['./interstitial-page-helpers.ts'],
  ])('%s imports nothing from node: and uses no Request, Response, Headers or crypto', (path) => {
    // Arrange
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');

    // Act
    const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+["'](.+?)["']/gm)].map(m => m[1]);

    // Assert
    expect(imports.filter(i => i.startsWith('node:'))).toEqual([]);
    for (const part of ['Request(', 'Response(', 'new Headers', 'crypto.']) {
      expect(source).not.toContain(part);
    }
  });
});

// #region The fake browser for the script's tests

/** One cookie in the fake jar. `domain` undefined: kept for the host only. */
interface StoredCookie { name: string; value: string; domain?: string }

/**
 * A cookie jar that knows domains, as a browser does. A write with `Domain=d` is kept when `d` is the host or ends it
 * after a dot, and is not refused (the public-suffix case). A write without `Domain` is kept for the host only.
 * `Max-Age=0` deletes the cookie of that name and domain. A new value replaces the cookie of the same name and domain.
 */
class FakeJar {
  readonly cookies: StoredCookie[] = [];
  /** `Domain` values the jar refuses, as a browser refuses a public suffix. */
  refused: string[] = [];
  refuseEveryDomain = false;
  refuseEveryWrite = false;

  constructor(readonly host: string) {}

  /** What `document.cookie` reads: `name=value; …` for every cookie the host sees. */
  read(): string {
    return this.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  /** A write to `document.cookie`: `name=value; Attribute=value; …`. */
  write(text: string): void {
    const [pair, ...attributes] = text.split(';').map(part => part.trim());
    const valueOf = (name: string) => attributes.find(a => a.toLowerCase().startsWith(`${name}=`))?.slice(name.length + 1);
    const domain = valueOf('domain')?.toLowerCase().replace(/^\./, '');
    const refused = this.refuseEveryWrite || (domain !== undefined && (this.refuseEveryDomain || this.refused.includes(domain)
      || !(this.host === domain || this.host.endsWith(`.${domain}`))));
    if (!refused) {
      const at = pair.indexOf('=');
      this.store(pair.slice(0, at), pair.slice(at + 1), domain, Number(valueOf('max-age')) <= 0);
    }
  }

  /** Keeps a cookie, or deletes it, as the tag or an earlier page would. */
  store(name: string, value: string, domain?: string, remove = false): void {
    const index = this.cookies.findIndex(c => c.name === name && c.domain === domain);
    if (remove) {
      this.cookies.splice(index, index >= 0 ? 1 : 0);
    } else if (index >= 0) {
      this.cookies[index].value = value;
    } else {
      this.cookies.push({ name, value, domain });
    }
  }

  /** Copies of the cookies named `name`. */
  find(name: string): StoredCookie[] {
    return this.cookies.filter(c => c.name === name).map(c => ({ ...c }));
  }
}

/** An element of the page with an id: its attributes and text as written, and what the script changes. */
interface FakeElement {
  attributes: string;
  hidden: boolean;
  textContent: string;
  children: FakeElement[];
  onclick?: () => void;
  appendChild(child: FakeElement): void;
  querySelector(selector: string): FakeElement | null;
}

/** The elements with an id in the page's markup. querySelector('button') finds a <button> inside one. */
const elementsOf = (page: string): Record<string, FakeElement> => {
  const element = (attributes: string, textContent: string, button: FakeElement | null): FakeElement => {
    const made: FakeElement = {
      attributes,
      hidden: /\shidden\b/.test(attributes),
      textContent,
      children: [],
      appendChild: child => { made.children.push(child); },
      querySelector: selector => (selector === 'button' ? button : null),
    };
    return made;
  };
  const elements: Record<string, FakeElement> = {};
  for (const [, , id, attributes, inner] of page.matchAll(/<(\w+) id="(\w+)"([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const button = inner.includes('<button') ? element('', 'Try again', null) : null;
    elements[id] = element(attributes, inner.replace(/<[^>]*>/g, ''), button);
  }
  return elements;
};

/** The element the script makes for the tag. */
interface FakeTag {
  name: string;
  attributes: [string, string][];
  onerror?: () => void;
  setAttribute(name: string, value: string): void;
}

/** What a run of the script did. */
interface Run {
  jar: FakeJar;
  /** Each write of the script to `document.cookie`, in order. */
  writes: string[];
  tag?: FakeTag;
  head: unknown[];
  elements: Record<string, FakeElement>;
  location: { reload: Mock; replace: Mock; assign: Mock };
  /** Each value the script gave `location.href`. */
  hrefs: string[];
  /** The `_cq_it` cookies in the jar when `reload` was called. */
  marksAtReload?: StoredCookie[];
}

/** How a run starts. */
interface Start {
  /** `location.hostname`. Default `www.shop.com`. */
  host?: string;
  /** The cookies in the jar when the page starts: name, value and domain (left out: the host only). */
  cookies?: [string, string, string?][];
  jar?: Partial<Pick<FakeJar, 'refused' | 'refuseEveryDomain' | 'refuseEveryWrite'>>;
  values?: Partial<InterstitialScriptValues>;
  path?: string;
  search?: string;
  hash?: string;
  setAttributeThrows?: boolean;
}

/** The run of the current test, checked after it (row 12). */
let current: Run | undefined;

/**
 * Runs INTERSTITIAL_SCRIPT with a fake document, location and window, with fake timers, on the page of the default
 * settings. The values have `maxWaitMs: 5000`.
 */
const start = (options: Start = {}): Run => {
  vi.useFakeTimers();
  const host = options.host ?? 'www.shop.com';
  const jar = Object.assign(new FakeJar(host), options.jar);
  for (const [name, value, domain] of options.cookies ?? []) {
    jar.store(name, value, domain);
  }
  const settings = settingsWith();
  const values = valuesFor(settings, options.values);
  const run: Run = {
    jar,
    writes: [],
    head: [],
    elements: elementsOf(interstitialPage(settings, 'ray-1', values)),
    location: { reload: vi.fn(() => { run.marksAtReload = jar.find('_cq_it'); }), replace: vi.fn(), assign: vi.fn() },
    hrefs: [],
  };
  const document = {
    get cookie(): string { return jar.read(); },
    set cookie(text: string) { run.writes.push(text); jar.write(text); },
    createElement: (name: string): FakeTag => {
      const tag: FakeTag = {
        name,
        attributes: [],
        setAttribute: (attribute, value) => {
          if (options.setAttributeThrows) {
            throw new Error('setAttribute failed');
          }
          tag.attributes.push([attribute, value]);
        },
      };
      run.tag = tag;
      return tag;
    },
    head: { appendChild: (child: unknown) => { run.head.push(child); } },
    getElementById: (id: string) => run.elements[id] ?? null,
  };
  const location = {
    protocol: 'https:',
    hostname: host,
    pathname: options.path ?? '/sofas',
    search: options.search ?? '',
    hash: options.hash ?? '',
    ...run.location,
    set href(value: string) { run.hrefs.push(value); },
  };
  current = run;
  const script = new Function('document', 'location', 'window', `return ${INTERSTITIAL_SCRIPT}`)(document, location, {});
  (script as (values: InterstitialScriptValues) => void)(values);
  return run;
};

// How often the script called location.reload.
const reloads = (run: Run): number => run.location.reload.mock.calls.length;

// This page's mark, kept for `domain` (left out: the host only).
const mark = (domain?: string): StoredCookie => ({ name: '_cq_it', value: MARK_VALUE, domain });

// The Domain of a cookie write, or undefined.
const domainOf = (write: string): string | undefined => /; Domain=([^;]*)/.exec(write)?.[1];

// The page element whose text starts with `text`, and the one whose attributes hold `attribute`.
const withText = (run: Run, text: string): FakeElement => Object.values(run.elements).find(e => e.textContent.startsWith(text))!;
const withAttribute = (run: Run, attribute: string): FakeElement => Object.values(run.elements).find(e => e.attributes.includes(attribute))!;

// What the live region says: its own text, and the text of each shown element put into it.
const spoken = (run: Run): string => {
  const live = withAttribute(run, 'role="status"');
  return live.textContent + live.children.filter(c => !c.hidden).map(c => c.textContent).join('');
};

// #endregion The fake browser for the script's tests

describe('INTERSTITIAL_SCRIPT, run in Node with a fake browser', () => {
  afterEach(() => {
    if (current !== undefined) {
      // Row 12, for every run: the page only reads the tag's cookies, and it does not leave the URL.
      expect(current.writes.filter(w => /^(_cq_pvid|_cq_duid|_cq_s)=/.test(w))).toEqual([]);
      expect(current.hrefs).toEqual([]);
      expect(current.location.replace).not.toHaveBeenCalled();
      expect(current.location.assign).not.toHaveBeenCalled();
    }
    current = undefined;
    vi.useRealTimers();
  });

  // #region When the page reloads (rows 1 to 6, 9 and 10)
  test('no _cq_pvid at the start, the tag writes one at 300 ms: the mark, then one reload, at the next check (row 1)', () => {
    // Arrange
    const run = start();

    // Act
    vi.advanceTimersByTime(300);
    const at300 = { reloads: reloads(run), marks: run.jar.find('_cq_it') };
    run.jar.store('_cq_pvid', 'new', 'shop.com');
    vi.advanceTimersByTime(49);
    const at349 = reloads(run);
    vi.advanceTimersByTime(1);

    // Assert
    expect(at300).toEqual({ reloads: 0, marks: [] });
    expect(at349).toBe(0);
    expect(reloads(run)).toBe(1);
    expect(run.marksAtReload).toEqual([mark('shop.com')]);
  });

  test('an old _cq_pvid that stays: no reload before maxWaitMs, then the mark and one reload (row 2)', () => {
    // Arrange
    const run = start({ cookies: [['_cq_pvid', 'old', 'shop.com']] });

    // Act
    vi.advanceTimersByTime(4999);
    const before = { reloads: reloads(run), marks: run.jar.find('_cq_it') };
    vi.advanceTimersByTime(1);
    const at5000 = reloads(run);
    vi.advanceTimersByTime(60000);

    // Assert
    expect(before).toEqual({ reloads: 0, marks: [] });
    expect(at5000).toBe(1);
    expect(reloads(run)).toBe(1);
    expect(run.marksAtReload).toEqual([mark('shop.com')]);
  });

  test('two old _cq_pvid values for two domains: one reload once a third value is there, none before (row 3)', () => {
    // Arrange
    const run = start({ cookies: [['_cq_pvid', 'a'], ['_cq_pvid', 'b', 'shop.com']] });

    // Act
    vi.advanceTimersByTime(1000);
    const before = reloads(run);
    run.jar.store('_cq_pvid', 'c', 'shop.com');
    vi.advanceTimersByTime(50);

    // Assert
    expect(before).toBe(0);
    expect(reloads(run)).toBe(1);
  });

  test('the tag replaces an old _cq_pvid with a new value: one reload (row 4)', () => {
    // Arrange
    const run = start({ cookies: [['_cq_pvid', 'old', 'shop.com']] });

    // Act
    vi.advanceTimersByTime(500);
    const before = reloads(run);
    run.jar.store('_cq_pvid', 'new', 'shop.com');
    vi.advanceTimersByTime(50);

    // Assert
    expect(before).toBe(0);
    expect(reloads(run)).toBe(1);
    expect(run.marksAtReload).toEqual([mark('shop.com')]);
  });

  test('the tag fails to load (onerror): the mark, then one reload, at once (row 5)', () => {
    // Arrange
    const run = start();

    // Act
    run.tag!.onerror!();
    const atOnce = { reloads: reloads(run), timers: vi.getTimerCount() };
    vi.advanceTimersByTime(60000);

    // Assert
    expect(atOnce).toEqual({ reloads: 1, timers: 0 });
    expect(reloads(run)).toBe(1);
    expect(run.marksAtReload).toEqual([mark('shop.com')]);
  });

  test('setAttribute throws: the mark, then one reload, at once (row 6)', () => {
    // Act
    const run = start({ setAttributeThrows: true });
    const atOnce = { reloads: reloads(run), timers: vi.getTimerCount() };
    vi.advanceTimersByTime(60000);

    // Assert
    expect(atOnce).toEqual({ reloads: 1, timers: 0 });
    expect(reloads(run)).toBe(1);
    expect(run.marksAtReload).toEqual([mark('shop.com')]);
    expect(run.head).toEqual([]);
  });

  test('adds the tag: a <script> element with each pair of values.tag through setAttribute, in order, in document.head (row 9)', () => {
    // Act
    const run = start();

    // Assert
    expect(run.tag?.name).toBe('script');
    expect(run.tag?.attributes).toEqual(settingsWith().tagAttributes);
    expect(run.head).toHaveLength(1);
    expect(run.head[0]).toBe(run.tag);
  });

  test('a new _cq_pvid, onerror and the end of maxWaitMs all happen: one mark and one reload in total (row 10)', () => {
    // Arrange
    const run = start({ cookies: [['_cq_pvid', 'old']] });

    // Act
    run.jar.store('_cq_pvid', 'new');
    vi.advanceTimersByTime(50);
    run.tag!.onerror!();
    vi.advanceTimersByTime(60000);

    // Assert
    expect(reloads(run)).toBe(1);
    expect(run.writes.filter(w => w.startsWith('_cq_it='))).toHaveLength(1);
  });
  // #endregion When the page reloads

  // #region When the page does not reload (rows 7, 8 and 18)
  test('the jar refuses every write: no reload, and the cookie text is shown and put in the live region (row 7)', () => {
    // Arrange
    const run = start({ jar: { refuseEveryWrite: true } });

    // Act
    vi.advanceTimersByTime(60000);

    // Assert
    expect(reloads(run)).toBe(0);
    expect(withText(run, 'Please allow cookies').hidden).toBe(false);
    expect(spoken(run)).toBe('Please allow cookies for this site, then reload the page.');
    expect(withText(run, 'We could not').hidden).toBe(true);
    expect(withAttribute(run, 'aria-hidden="true"').hidden).toBe(true);
    expect(run.writes.filter(w => w.startsWith('_cq_ref='))).toEqual([]);
  });

  test.each([
    ['for the host only', undefined],
    ['for Domain=shop.com', 'shop.com'],
  ])('a mark of this setup %s at the start: no tag, no reload, the fail text; Try again deletes it everywhere and reloads once (row 8)', (_, domain) => {
    // Arrange
    const run = start({ cookies: [['_cq_it', `${SETUP_ID}|x`, domain]] });
    const timers = vi.getTimerCount();
    vi.advanceTimersByTime(60000);
    const before = { timers, reloads: reloads(run), tag: run.tag, head: run.head.length, writes: [...run.writes] };
    const fail = withText(run, 'We could not');

    // Act
    fail.querySelector('button')!.onclick!();

    // Assert
    expect(before).toEqual({ timers: 0, reloads: 0, tag: undefined, head: 0, writes: [] });
    expect(fail.hidden).toBe(false);
    expect(spoken(run)).toBe('We could not check your browser. Try again');
    expect(withAttribute(run, 'aria-hidden="true"').hidden).toBe(true);
    expect(run.jar.find('_cq_it')).toEqual([]);
    expect(run.writes.every(w => w.startsWith('_cq_it=;') && w.includes('; Max-Age=0'))).toBe(true);
    expect(run.writes.map(domainOf)).toEqual([undefined, 'shop.com', 'www.shop.com']);
    expect(reloads(run)).toBe(1);
  });

  test('a mark of another setup for Domain=shop.com at the start: not the safety net, the own mark replaces it, one reload (row 18)', () => {
    // Arrange
    const run = start({ cookies: [['_cq_it', '0badc0de|x', 'shop.com']] });

    // Act
    vi.advanceTimersByTime(5000);

    // Assert
    expect(run.tag?.name).toBe('script');
    expect(run.jar.find('_cq_it')).toEqual([mark('shop.com')]);
    expect(reloads(run)).toBe(1);
    expect(withText(run, 'We could not').hidden).toBe(true);
  });
  // #endregion When the page does not reload

  // #region The mark's domain (rows 13 to 17)
  test.each([
    ['www.shop.com', {}, ['shop.com'], 'shop.com'],
    ['shop.com', {}, ['shop.com'], 'shop.com'],
    ['a.b.shop.co.uk', { refused: ['co.uk'] }, ['co.uk', 'shop.co.uk'], 'shop.co.uk'],
    ['localhost', {}, [undefined], undefined],
    ['127.0.0.1', {}, [undefined], undefined],
    ['[::1]', {}, [undefined], undefined],
    ['[::ffff:1.2.3.4]', {}, [undefined], undefined],
    ['www.shop.com', { refuseEveryDomain: true }, ['shop.com', 'www.shop.com', undefined], undefined],
  ])('host %s, jar %o: tries the domains %o, keeps the mark for %s, then one reload', (host, jar, tried, kept) => {
    // Arrange
    const run = start({ host, jar });

    // Act
    run.tag!.onerror!();

    // Assert
    expect(run.writes.map(domainOf)).toEqual(tried);
    expect(run.jar.find('_cq_it')).toEqual([mark(kept)]);
    expect(reloads(run)).toBe(1);
    expect(withText(run, 'Please allow cookies').hidden).toBe(true);
  });

  test('host a.b.shop.co.uk, the jar refuses co.uk, and a mark of another setup for the host only at the start: the own mark is kept for Domain=shop.co.uk beside it, then one reload (rows 15 and 18)', () => {
    // Arrange: the other setup's mark is read back after each write, so only the exact own mark may count
    const run = start({ host: 'a.b.shop.co.uk', jar: { refused: ['co.uk'] }, cookies: [['_cq_it', '0badc0de|x']] });

    // Act
    run.tag!.onerror!();

    // Assert
    expect(run.writes.map(domainOf)).toEqual(['co.uk', 'shop.co.uk']);
    expect(run.jar.find('_cq_it')).toEqual([{ name: '_cq_it', value: '0badc0de|x' }, mark('shop.co.uk')]);
    expect(run.marksAtReload).toEqual([{ name: '_cq_it', value: '0badc0de|x' }, mark('shop.co.uk')]);
    expect(reloads(run)).toBe(1);
    expect(withText(run, 'We could not').hidden).toBe(true);
  });
  // #endregion The mark's domain

  // #region The original Referer in "cookie" mode (row 11)
  test('writes _cq_ref after the mark, for its domain, as the CAPTCHA does, with Max-Age=60 and the attributes (row 11)', () => {
    // Arrange
    const run = start({
      values: { referer: 'https://www.google.com/', cookieAttributes: '; Path=/; SameSite=Lax; Secure' },
      path: '/sofas',
      search: '?gclid=abc',
      hash: '#top',
    });
    const value = new RTIStatelessUtils().originalRefererCookieValue('/sofas?gclid=abc#top', 'https://www.google.com/');

    // Act
    run.tag!.onerror!();

    // Assert
    expect(run.writes).toEqual([
      `_cq_it=${MARK_VALUE}; Max-Age=60; Path=/; SameSite=Lax; Secure; Domain=shop.com`,
      `_cq_ref=${value}; Max-Age=60; Path=/; SameSite=Lax; Secure; Domain=shop.com`,
    ]);
    expect(run.jar.find('_cq_ref')).toEqual([{ name: '_cq_ref', value, domain: 'shop.com' }]);
    expect(reloads(run)).toBe(1);
  });

  test('without referer: no _cq_ref (row 11)', () => {
    // Arrange
    const run = start();

    // Act
    run.tag!.onerror!();

    // Assert
    expect(run.writes.filter(w => w.startsWith('_cq_ref='))).toEqual([]);
    expect(reloads(run)).toBe(1);
  });
  // #endregion The original Referer in "cookie" mode
});
