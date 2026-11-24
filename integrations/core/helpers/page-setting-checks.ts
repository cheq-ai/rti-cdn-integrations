/**
 * The checks of the settings that the interstitial page and the block page both have (logoUrl, headline, message and
 * lang), and the https:// check that readTagLine also uses for the tag's src. They came from interstitial.service.ts
 * as they were, so that InterstitialService and readBlockPageSettings check with the same rules.
 */

/** Whether `value` starts with `https://` and `new URL` can read it. */
export function isHttpsUrl(value: string): boolean {
  if (!value.startsWith("https://")) {
    return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Text of 1 to `max` characters. */
export const isTextUpTo = (max: number) => (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;

/** A language tag such as "en" or "en-US": 2 or 3 letters, then parts of 1 to 8 letters or digits. At most 35 characters. */
export const isLanguageTag = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 35 && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(value);

/**
 * An https:// URL of at most 200 characters, as written and as `new URL(value).href`, the text the page gets. The href
 * can be longer: an `é` is 1 character as written and 6 in the href (`%C3%A9`).
 */
export const isLogoUrl = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 200 && isHttpsUrl(value) && new URL(value).href.length <= 200;
