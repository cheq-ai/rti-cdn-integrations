// cspell:ignore CHEQ
import { BlockPageSettings } from "../models/block-page.model";
import { Config } from "../models/config.interface";
import { RTIStatelessUtils } from "../services/rti-stateless-utils";
import { isLanguageTag, isLogoUrl, isTextUpTo } from "./page-setting-checks";

/** For errorMessage. It holds no state. */
const utils = new RTIStatelessUtils();

/**
 * Reads `config.blockPage`, for the CDN glue to call once, at cold start: the checked settings of the block page, for
 * generateDefaultBlockPage, and one problem text per wrong value, for the cold-start warnings. It does not throw. The
 * answer's settings and problems are frozen, and their types are read-only.
 * - Left out, `undefined` or `null`: no settings and no problem.
 * - Not a settings block (a string, a number, `true`, an array): no settings, and one problem text.
 * - Each setting, in the order logoUrl, headline, message, lang: left out (`undefined`), it keeps its default and is no
 *   problem. A valid value is kept, logoUrl as `new URL(logoUrl).href`. Any other value keeps the default, and gets
 *   one problem text. The rules are the interstitial's for its settings of the same names (page-setting-checks.ts).
 * - Anything that throws while the block is read: no settings, and one problem text that says so.
 * The settings are a new object of strings, so they share no object with the config.
 * @param config the integration's config
 */
export function readBlockPageSettings(
  config: Config,
): { settings: Readonly<BlockPageSettings>; problems: readonly string[] } {
  let read: { settings: BlockPageSettings; problems: string[] };
  try {
    read = readSettings(config.blockPage);
  } catch (e) {
    read = { settings: {}, problems: [`blockPage settings could not be read (${utils.errorMessage(e)}), using the defaults`] };
  }
  Object.freeze(read.settings);
  Object.freeze(read.problems);
  return read;
}

/** The checked settings of `block`, the value of `config.blockPage`, and the problems. It can throw. */
function readSettings(block: unknown): { settings: BlockPageSettings; problems: string[] } {
  if (block === undefined || block === null) {
    return { settings: {}, problems: [] };
  }
  if (typeof block !== "object" || Array.isArray(block)) {
    return { settings: {}, problems: [`blockPage: ${JSON.stringify(block)} is not a settings block, using the defaults`] };
  }
  const settings: BlockPageSettings = {};
  const problems: string[] = [];
  // Keeps a valid value of the setting. Left out: nothing to keep. Any other value: a problem text.
  const keep = (name: keyof BlockPageSettings, isValid: (value: unknown) => value is string, allowed: string,
    fallback: string): void => {
    const value: unknown = (block as BlockPageSettings)[name];
    if (value === undefined) {
      return;
    }
    if (isValid(value)) {
      settings[name] = value;
    } else {
      problems.push(`blockPage.${name}: ${JSON.stringify(value)} is not ${allowed}, using ${fallback}`);
    }
  };
  // Read in the order of the settings, so that the problem texts come in that order too.
  keep("logoUrl", isLogoUrl, "an https:// URL of at most 200 characters", "CHEQ's logo");
  keep("headline", isTextUpTo(60), "text of 1 to 60 characters", "the title of the block");
  keep("message", isTextUpTo(160), "text of 1 to 160 characters", "the default message");
  keep("lang", isLanguageTag, 'a language tag such as "en" or "en-US"', '"en"');
  if (settings.logoUrl !== undefined) {
    // As the URL parser writes it, the text the page gets, as the interstitial keeps its logoUrl.
    settings.logoUrl = new URL(settings.logoUrl).href;
  }
  return { settings, problems };
}
