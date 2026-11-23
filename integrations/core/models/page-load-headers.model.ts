/**
 * Four request headers. `Sec-Fetch-Dest` and `Accept` tell a page load from another request
 * (RTIStatelessUtils.isPageLoad). `Sec-Purpose` and `Purpose` tell a prefetch (RTIStatelessUtils.isPrefetch).
 * A missing header is undefined or null. A header sent more than once is passed as one value, its values joined
 * with ", ".
 */
export interface PageLoadHeaders {
  /** The `Sec-Fetch-Dest` header, read by isPageLoad. */
  secFetchDest?: string | null;
  /** The `Accept` header, read by isPageLoad. */
  accept?: string | null;
  /** The `Sec-Purpose` header, read by isPrefetch. */
  secPurpose?: string | null;
  /** The `Purpose` header, read by isPrefetch. */
  purpose?: string | null;
}
