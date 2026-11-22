/**
 * Headers for the answers our Worker sends itself, instead of passing the request on to the origin:
 * the block pages (403, 404), the CAPTCHA page and our redirects (302).
 * Written once here, so every one of those answers gets the same headers.
 */
export class ResponseHeaders {
    /**
     * Tells the browser, and any proxy between the visitor and Cloudflare, not to save this answer.
     * Cloudflare does not put an answer the Worker builds itself into its cache. But without this header a browser or
     * a shared proxy may keep one (a 404 may be cached even with no header at all), so a block page or CAPTCHA meant
     * for one bot could be shown again later, or to another visitor behind the same proxy. The browser could also
     * show a saved CAPTCHA page on Back instead of asking again.
     * Use it alone for answers with no page (redirects).
     */
    noStore(): Record<string, string> {
        return { 'Cache-Control': 'no-store, no-cache, must-revalidate' };
    }

    /**
     * For our own web pages (block pages, the CAPTCHA page): tells the browser the answer is an HTML page,
     * and that it must not be saved (see noStore).
     */
    html(): Record<string, string> {
        return { 'Content-Type': 'text/html;charset=UTF-8', ...this.noStore() };
    }
}
