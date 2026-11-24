// cspell:ignore CHEQ noopener noreferrer
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CHEQ_LOGO, PAGE_FOOTER, PAGE_STYLE } from './page-look';

// CHEQ's logo file at the root of the repository: the source of CHEQ_LOGO.
const file = readFileSync(new URL('../../../assets/cheq-logo.svg', import.meta.url), 'utf8');

// The d of the first <path> of an svg, the numbers in it, and its commands (the letters, one space between them).
const pathOf = (svg: string) => /<path d="([^"]+)"/.exec(svg)![1];
const numbers = (d: string) => (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
const commands = (d: string) => d.replace(/[-\d.\s,]+/g, ' ').trim();

// A rounded -0 counts as 0, on both sides of the compare.
const withoutMinusZero = (n: number): number => (n === 0 ? 0 : n);

describe('CHEQ_LOGO', () => {
  test('is the logo file with each number of its path rounded to 2 decimals', () => {
    // Arrange
    const rounded = numbers(pathOf(file)).map(n => withoutMinusZero(Number(n.toFixed(2))));

    // Act
    const d = pathOf(CHEQ_LOGO);

    // Assert
    expect(commands(d)).toBe(commands(pathOf(file)));
    expect(numbers(d).map(withoutMinusZero)).toEqual(rounded);
    for (const part of ['width="144"', 'height="37"', 'viewBox="0 0 144 37"', 'fill="#FE0072"', 'aria-hidden="true"']) {
      expect(CHEQ_LOGO).toContain(part);
    }
    expect(CHEQ_LOGO).toMatch(/^<svg [^>]*aria-hidden="true"[^>]*><path [^>]*\/><\/svg>$/);
    expect(CHEQ_LOGO).not.toMatch(/[\r\n]/);
    expect(CHEQ_LOGO.length).toBeLessThan(2700);
  });
});

describe('PAGE_FOOTER', () => {
  test('links Cheq.ai in a new tab, without a referrer', () => {
    // Act & Assert
    expect(PAGE_FOOTER).toBe('<small>Protected by <a href="https://cheq.ai" target="_blank" rel="noopener noreferrer">Cheq.ai</a></small>');
  });
});

describe('PAGE_STYLE', () => {
  test('is white and holds no green', () => {
    // Act & Assert
    expect(PAGE_STYLE).toContain('background:#fff');
    expect(PAGE_STYLE.toLowerCase()).not.toContain('00d4aa');
  });

  test('gives main the full width up to 488px, a text area of 440px, so the id boxes do not follow the longest line', () => {
    // Act & Assert
    expect(PAGE_STYLE).toContain('main{width:100%;max-width:488px;padding:24px;box-sizing:border-box}');
  });
});
