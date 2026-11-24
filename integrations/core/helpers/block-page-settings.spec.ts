// cspell:ignore CHEQ
import { describe, test, expect } from 'vitest';
import { readBlockPageSettings } from './block-page-settings';
import type { Config } from '../models/config.interface';
import type { BlockPageSettings } from '../models/block-page.model';

// A block with all four settings valid, and what the reader gives for it: logoUrl as new URL(logoUrl).href.
const VALID = { logoUrl: 'https://cdn.example/é.svg', headline: 'Stop', message: 'Not for you.', lang: 'de-AT' };
const CHECKED: BlockPageSettings = {
  logoUrl: 'https://cdn.example/%C3%A9.svg', headline: 'Stop', message: 'Not for you.', lang: 'de-AT',
};

// The problem text of a wrong value of each setting.
const PROBLEM: Record<keyof BlockPageSettings, (value: unknown) => string> = {
  logoUrl: value => `blockPage.logoUrl: ${JSON.stringify(value)} is not an https:// URL of at most 200 characters, using CHEQ's logo`,
  headline: value => `blockPage.headline: ${JSON.stringify(value)} is not text of 1 to 60 characters, using the title of the block`,
  message: value => `blockPage.message: ${JSON.stringify(value)} is not text of 1 to 160 characters, using the default message`,
  lang: value => `blockPage.lang: ${JSON.stringify(value)} is not a language tag such as "en" or "en-US", using "en"`,
};

// One row of the table: a description, the config, the settings and the problem texts the reader gives for it.
type Row = [string, unknown, BlockPageSettings, string[]];

// The row of VALID with one wrong setting: the reader keeps the other three, and writes one text.
const wrong = (name: keyof BlockPageSettings, value: unknown, label = JSON.stringify(value)): Row => [
  `with ${name} ${label}`,
  { blockPage: { ...VALID, [name]: value } },
  Object.fromEntries(Object.entries(CHECKED).filter(([key]) => key !== name)),
  [PROBLEM[name](value)],
];

// A block whose headline throws when it is read.
const THROWING_HEADLINE = { ...VALID, get headline(): never { throw new Error('boom'); } };

describe('readBlockPageSettings', () => {
  test.each<Row>([
    ['left out', {}, {}, []],
    ['undefined', { blockPage: undefined }, {}, []],
    ['null', { blockPage: null }, {}, []],
    ['{}', { blockPage: {} }, {}, []],
    ['with all four valid', { blockPage: VALID }, CHECKED, []],
    ['"x"', { blockPage: 'x' }, {}, ['blockPage: "x" is not a settings block, using the defaults']],
    ['5', { blockPage: 5 }, {}, ['blockPage: 5 is not a settings block, using the defaults']],
    ['true', { blockPage: true }, {}, ['blockPage: true is not a settings block, using the defaults']],
    ['[]', { blockPage: [] }, {}, ['blockPage: [] is not a settings block, using the defaults']],
    wrong('logoUrl', 'http://x/l.svg'),
    wrong('logoUrl', 'javascript:alert(1)'),
    wrong('logoUrl', 'x'),
    wrong('logoUrl', 5),
    wrong('logoUrl', 'https://cdn.example/' + 'a'.repeat(181), 'of 201 characters'),
    wrong('headline', ''),
    wrong('headline', 'x'.repeat(61), 'of 61 characters'),
    wrong('headline', 5),
    wrong('message', ''),
    wrong('message', 'x'.repeat(161), 'of 161 characters'),
    wrong('lang', 'english'),
    wrong('lang', 'e'),
    wrong('lang', 5),
    ['with a wrong lang written before a wrong logoUrl',
      { blockPage: { lang: 'english', headline: 'Stop', message: 'Not for you.', logoUrl: 'x' } },
      { headline: 'Stop', message: 'Not for you.' },
      [PROBLEM.logoUrl('x'), PROBLEM.lang('english')]],
    ['whose headline throws', { blockPage: THROWING_HEADLINE }, {}, ['blockPage settings could not be read (boom), using the defaults']],
  ])('blockPage %s: gives these settings and problem texts', (_, config, settings, problems) => {
    // Act
    const answer = readBlockPageSettings(config as Config);

    // Assert
    expect(answer).toStrictEqual({ settings, problems });
  });

  test.each([
    ['left out', {}],
    ['with all four valid', { blockPage: VALID }],
    ['"x"', { blockPage: 'x' }],
    ['with a wrong lang', { blockPage: { ...VALID, lang: 'english' } }],
    ['whose headline throws', { blockPage: THROWING_HEADLINE }],
  ])('freezes the settings and the problems for blockPage %s', (_, config) => {
    // Act
    const answer = readBlockPageSettings(config as unknown as Config);

    // Assert
    expect(Object.isFrozen(answer.settings)).toBe(true);
    expect(Object.isFrozen(answer.problems)).toBe(true);
  });

  test('gives settings that share no object with the config', () => {
    // Arrange
    const blockPage = { ...VALID };

    // Act
    const { settings } = readBlockPageSettings({ blockPage } as unknown as Config);
    blockPage.headline = 'Changed';

    // Assert
    expect(settings).not.toBe(blockPage);
    expect(settings).toStrictEqual(CHECKED);
  });
});
