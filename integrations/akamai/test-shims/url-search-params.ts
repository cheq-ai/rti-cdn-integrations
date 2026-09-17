// Stands in for Akamai's built-in `url-search-params` module on Node.
// Akamai exposes it as a DEFAULT export, unlike the named exports of the other modules.
export default globalThis.URLSearchParams;
