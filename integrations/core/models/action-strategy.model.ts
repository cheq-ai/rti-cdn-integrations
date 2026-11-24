export enum ActionStrategy {
  ACCESS_DENIED,
  NOT_FOUND,
  REDIRECT,
  CAPTCHA,
  /** The passive interstitial page (see InterstitialService). Last, so that the numbers of the others stay. */
  INTERSTITIAL,
}
