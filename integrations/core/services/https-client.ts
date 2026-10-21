// JSON POST client on Node's built-in http/https modules — for Node runtimes only (CloudFront Lambda@Edge).
// Shared by RTIHttpsService and RTIHttpsLoggerService. It avoids the cold-start CPU cost of loading
// fetch (undici) on low-CPU Lambdas. See "Memory, CPU and Cold Starts" in integrations/cloudfront/README.md.
// It does less than fetch: it sets its own User-Agent, does not follow redirects and does not strip a BOM.
// See "Differences from the previous `fetch` client" in integrations/cloudfront/README.md.
import http from "node:http";
import https from "node:https";

// Node sends no User-Agent by default (fetch sent `node`), and some firewalls reject requests without one.
// It also makes the RTI and logger calls easy to find in the endpoints' logs.
const USER_AGENT = "cheq-rti-cloudfront";

export interface HttpsResponse {
    status: number;
    statusText: string;
    body: string;
}

export class HttpsClient {
    // The URL is fixed per instance, so the protocol is too: one agent and one request function.
    // The agent is reused across calls, so warm invocations reuse the open TLS connection
    // (integrations create their services at module load).
    private readonly agent: http.Agent;
    private readonly request: typeof http.request;

    // When the last call ended (0 = no call yet), for the wall-clock idle check in post().
    private lastUsedAt = 0;

    /**
     * @param url endpoint every call posts to
     * @param idleSocketTimeoutMs how long an idle pooled connection is kept. Keep it below the server's
     *   idle timeout, so connections are closed by us before the server drops them: by the agent's timer
     *   while the process runs, and by a clock check in post() after a Lambda freeze. The server's close can
     *   still cross our next request on the wire, which is why post() also retries once on a dropped
     *   pooled connection.
     */
    constructor(private readonly url: string, private readonly idleSocketTimeoutMs: number) {
        // Integrations construct their services at module load, so a malformed URL must not throw here:
        // that would fail the Lambda init and every request, instead of failing open per call.
        // request() rejects the malformed URL inside post() instead.
        const client = this.protocolOf(url) === "https:" ? https : http;
        this.agent = new client.Agent({ keepAlive: true, timeout: idleSocketTimeoutMs });
        this.request = client.request;
    }

    // Resolves once the whole response body is read. The timeout covers connecting,
    // sending and reading the body (including a retry), like AbortSignal.timeout does for fetch.
    // Any status resolves, including a 3xx: a redirect is returned as the answer, not followed (fetch
    // followed it), so callers must be given the final URL. See README "Differences from the previous `fetch` client".
    post(body: string, timeoutMs: number): Promise<HttpsResponse> {
        // The agent closes idle connections with a timer, and a frozen Lambda runs no timers. After a thaw the
        // handler can get here before that overdue timer fires, and would send on a connection the server closed
        // long ago (a wasted send plus the retry, or a hang if the close never arrived). Date.now() keeps moving
        // during a freeze, so check the idle time by the clock and close the stale connections first.
        if (this.lastUsedAt && Date.now() - this.lastUsedAt >= this.idleSocketTimeoutMs) {
            this.closeIdleSockets();
        }
        return this.attempt(body, Date.now() + timeoutMs, false).finally(() => (this.lastUsedAt = Date.now()));
    }

    // Destroys the pooled connections that are not in use. The agent skips destroyed sockets, so the next
    // request opens a new connection.
    private closeIdleSockets(): void {
        for (const sockets of Object.values(this.agent.freeSockets)) {
            sockets?.forEach((socket) => socket.destroy());
        }
    }

    private attempt(body: string, deadline: number, isRetry: boolean): Promise<HttpsResponse> {
        return new Promise((resolve, reject) => {
            let responded = false;
            const req = this.request(this.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                    "User-Agent": USER_AGENT,
                },
                agent: this.agent,
            }, (res) => {
                responded = true;
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => {
                    clearTimeout(timer);
                    // statusCode and statusMessage are always set on a client response; they are only optional in the shared IncomingMessage type.
                    // A leading BOM (U+FEFF) is kept, unlike fetch's text(): JSON.parse then fails on it. The RTI
                    // endpoint sends none. See README "Differences from the previous `fetch` client".
                    resolve({ status: res.statusCode!, statusText: res.statusMessage!, body: Buffer.concat(chunks).toString("utf8") });
                });
                res.on("error", fail);
            });

            const timer = setTimeout(() => req.destroy(this.timeoutError()), Math.max(0, deadline - Date.now()));

            function fail(err: Error) {
                clearTimeout(timer);
                reject(err);
            }

            req.on("error", (err: NodeJS.ErrnoException) => {
                // A pooled connection can be closed by the server just as we send on it: the idle close and the
                // next request cross on the wire, or the Lambda thaws and handles the new request before it
                // processes the close. The request then fails with ECONNRESET ("socket hang up") or EPIPE, usually
                // before the server read it. Retry once on a new connection, as the Node docs recommend (see
                // `request.reusedSocket`). Not retried: a new connection that fails (a real error), any other
                // error, a failure after a response has started, and a second failure.
                // The server may, rarely, have processed a request whose connection was then reset without an
                // answer; that request is sent twice. Both callers (an RTI evaluation, a log line) tolerate that.
                if (!isRetry && !responded && req.reusedSocket && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
                    clearTimeout(timer);
                    // On a CPU-starved Lambda the error can be handled after the deadline; don't open a new connection then.
                    if (Date.now() >= deadline) {
                        reject(this.timeoutError());
                        return;
                    }
                    resolve(this.attempt(body, deadline, true));
                    return;
                }
                fail(err);
            });
            req.end(body);
        });
    }

    private timeoutError(): Error {
        return new Error("The operation was aborted due to timeout");
    }

    // The URL's protocol, or undefined for a malformed URL.
    private protocolOf(url: string): string | undefined {
        try {
            return new URL(url).protocol;
        } catch {
            return undefined; // malformed: just pick http, don't throw
        }
    }
}
