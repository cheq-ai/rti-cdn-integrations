// cspell:ignore CHEQ noopener noreferrer
/**
 * The look that the interstitial page and the block page share: CHEQ's logo, the CSS and the footer. Constants only,
 * with no import, so that both page helpers can import this file.
 */

/**
 * CHEQ's logo, inline, so that a page needs no second request: the pink wordmark of `assets/cheq-logo.svg` at the root
 * of the repository, as one line, with each number of its path rounded to 2 decimals. page-look.spec.ts compares it
 * with the file. It is not the logo of the CAPTCHA page (`turnstile-challenge-example.ts`), which keeps its own green
 * one. `aria-hidden`: the logo says nothing that the page does not say, as the `alt=""` of a logo from logoUrl.
 */
export const CHEQ_LOGO = '<svg width="144" height="37" viewBox="0 0 144 37" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
  + '<path d="M27.12 13.11C26.53 12.26 25.71 11.6 24.75 11.21C23.7 10.78 22.57 10.57 21.44 10.59C20.25 10.58 19.07 10.84 18 11.36C16.98 11.86 16.08 12.56 15.35 13.43C14.61 14.33 14.03 15.36 13.65 16.47C13.25 17.67 13.05 18.92 13.06 20.18C13.06 21.89 13.6 23.34 14.68 24.53C15.76 25.72 17.38 26.31 19.54 26.31C20.76 26.32 21.97 26.05 23.08 25.52C24.12 25.03 25.08 24.38 25.92 23.59L31.6 32C30.83 32.65 30.03 33.25 29.18 33.81C28.21 34.45 27.16 34.99 26.07 35.42C24.8 35.91 23.49 36.29 22.15 36.55C20.57 36.86 18.96 37.01 17.34 37C14.68 37 12.32 36.64 10.24 35.91C8.28 35.25 6.47 34.19 4.95 32.8C3.5 31.43 2.37 29.75 1.65 27.9C0.88 25.99 0.5 23.86 0.5 21.52C0.48 18.64 1.01 15.79 2.07 13.11C3.07 10.57 4.57 8.24 6.48 6.28C8.39 4.32 10.68 2.76 13.21 1.68C15.8 0.56 18.64 0 21.74 0C24.8 0 27.49 0.47 29.81 1.41C32.14 2.35 33.92 3.51 35.15 4.89L27.12 13.11Z'
  + 'M66.61 36.01H55.1L57.49 22.55H47.42L45.03 36.01H33.51L39.74 0.99H51.21L49.06 13.01H59.14L61.28 0.99H72.85L66.61 36.01Z'
  + 'M100.92 10.54H88.7L88.1 13.91H99.77L98.17 22.81H86.5L85.86 26.47H99.52L97.82 36.02H73.3L79.52 0.99H102.61L100.91 10.54L100.92 10.54Z'
  + 'M141.18 22.78C140.72 23.74 140.14 24.64 139.48 25.48C138.99 26.12 138.41 26.68 137.76 27.16L137.71 27.36L143.49 27.02L141.9 36.01H121.51C118.84 36.01 116.44 35.68 114.3 35C112.16 34.32 110.32 33.34 108.79 32.06C107.27 30.78 106.06 29.19 105.25 27.38C104.42 25.55 104 23.48 104 21.18C103.98 18.36 104.52 15.58 105.57 12.97C106.57 10.46 108.06 8.18 109.96 6.26C111.89 4.33 114.19 2.8 116.72 1.76C119.34 0.65 122.25 0.1 125.45 0.1C128.14 0.1 130.57 0.46 132.73 1.17C134.89 1.88 136.73 2.88 138.24 4.18C139.75 5.48 140.95 7.09 141.76 8.91C142.59 10.75 143.01 12.81 143.01 15.09C143.02 16.5 142.84 17.9 142.48 19.27C142.17 20.48 141.73 21.65 141.18 22.78Z'
  + 'M130.56 14.24C130.29 13.5 129.86 12.83 129.31 12.27C128.73 11.68 128.03 11.23 127.26 10.93C126.38 10.59 125.44 10.42 124.5 10.44C123.28 10.42 122.07 10.69 120.98 11.23C119.96 11.74 119.05 12.46 118.31 13.33C117.57 14.22 117 15.23 116.61 16.32C116.22 17.43 116.01 18.61 116.02 19.78C116.01 20.62 116.15 21.44 116.42 22.23C116.67 22.99 117.09 23.68 117.64 24.26C118.22 24.86 118.91 25.33 119.69 25.65C120.6 26.01 121.57 26.19 122.55 26.17C123.79 26.19 125.02 25.9 126.12 25.34C127.15 24.81 128.06 24.08 128.79 23.19C129.53 22.29 130.08 21.26 130.43 20.15C130.8 19.03 130.98 17.85 130.98 16.67C130.99 15.84 130.84 15.02 130.56 14.24L130.56 14.24Z" fill="#FE0072"/></svg>';

/**
 * The CSS that both pages share, minified: the white background, the dark text, the width of `main`, the size of a
 * logo from logoUrl, the heading, the small gray lines, and the footer's link in the color of its text. Each page adds
 * its own CSS after it. `body` is a flex box, and a flex item without a width is only as wide as its longest line. So
 * `main` has `width:100%`, `max-width:488px` and `box-sizing:border-box`: both pages get the same text area, at most
 * 440px wide (488px less a padding of 24px on each side), and the block page's default sentence fits on one line. In
 * Chrome on 2026-11-24, without `width:100%` the block page's `main` was 213px wide with a short message, and the
 * default sentence was 411px wide.
 */
export const PAGE_STYLE = 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'background:#fff;color:#1f2933;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
  + 'text-align:center}main{width:100%;max-width:488px;padding:24px;box-sizing:border-box}'
  + 'img{max-width:200px;max-height:60px}h1{font-size:24px;margin:24px 0 8px}'
  + 'small{display:block;margin-top:16px;color:#616e7c}small a{color:inherit}';

/**
 * The footer of both pages: "Protected by Cheq.ai", with "Cheq.ai" a link to https://cheq.ai. The design says that the
 * link opens in a new tab and tells cheq.ai nothing about the page it came from (`target="_blank"`,
 * `rel="noopener noreferrer"`), so that a click does not take the visitor away from an interstitial that is about to
 * reload.
 */
export const PAGE_FOOTER =
  '<small>Protected by <a href="https://cheq.ai" target="_blank" rel="noopener noreferrer">Cheq.ai</a></small>';
