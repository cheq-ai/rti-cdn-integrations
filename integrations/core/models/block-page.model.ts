// cspell:ignore CHEQ
/**
 * `config.blockPage`, as the customer writes it: the settings of the block page, the page of a 403 or 404 block
 * (generateDefaultBlockPage). Each setting is optional: one that is left out keeps its default. readBlockPageSettings
 * checks them. See Config.blockPage.
 */
export interface BlockPageSettings {
  /** The logo, in place of CHEQ's: the https:// address of an image, at most 200 characters. */
  logoUrl?: string;
  /**
   * The heading and the `<title>`, in place of the title of the block ("Access Denied" or "Not Found"): 1 to 60
   * characters.
   */
  headline?: string;
  /**
   * The sentence under the heading, in place of "Access to this resource has been denied by security policy.": 1 to 160
   * characters.
   */
  message?: string;
  /** The page's language (`<html lang>`), in place of "en": a tag such as "en" or "en-US", at most 35 characters. */
  lang?: string;
}
