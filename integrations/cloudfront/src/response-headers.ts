import { CloudFrontHeaders } from 'aws-lambda';

/**
 * Headers for the answers our Lambda sends itself, instead of passing the request on to the origin:
 * the block pages (403, 404), the CAPTCHA page and our redirects (302).
 * Written once here, so every one of those answers gets the same headers.
 */
export class ResponseHeaders {
    /**
     * Tells CloudFront and the browser not to save this answer.
     * Without it, CloudFront can cache what the Lambda returns (on origin-request), so a block page or CAPTCHA
     * meant for one bot could be served to real visitors of the same URL. The browser could also show a saved
     * CAPTCHA page on Back instead of asking again.
     * Use it alone for answers with no page (redirects).
     */
    noStore(): CloudFrontHeaders {
        return { 'cache-control': [{ key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' }] };
    }

    /**
     * For our own web pages (block pages, the CAPTCHA page): tells the browser the answer is an HTML page,
     * and that it must not be saved (see noStore).
     */
    html(): CloudFrontHeaders {
        return { 'content-type': [{ key: 'Content-Type', value: 'text/html;charset=UTF-8' }], ...this.noStore() };
    }
}
