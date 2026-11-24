// cspell:ignore CHEQ jsonp clicktrue lordofthesuperfrogs
/**
 * The CHEQ tag line of the design ("The tag line"), as the CHEQ console shows it, and the hash in its `src`.
 * Shared by the specs that need a tag line that can be read (`config.interstitial.tag`), the way
 * `rti-response.fixture.ts` shares `buildRTIResponse`: a spec file is never imported by another.
 */
export const CONSOLE_LINE =
    '<script async src="https://rocky.lordofthesuperfrogs.com/i/89f6be46721c93dcde41c82e1e56ac78.js" data-ch="v41tag" class="ct_clicktrue_98468" data-jsonp="onCheqResponse"></script>';

/** The hash in the `src` of {@link CONSOLE_LINE}: the `tagHash` of the same tag. */
export const CONSOLE_TAG_HASH = '89f6be46721c93dcde41c82e1e56ac78';
