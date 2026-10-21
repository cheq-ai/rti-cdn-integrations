// RTI caller using Node's built-in http/https modules — for Node runtimes only (CloudFront Lambda@Edge).
// Same request flow as rti.service.ts (shared in RTIServiceBase) but avoids the cold-start CPU cost
// of loading fetch (undici) on low-CPU Lambdas. Differences: the fallback timeout is 2000ms (fetch: 150ms),
// and network errors keep Node's message (e.g. `connect ECONNREFUSED ...`) where fetch says `fetch failed`.
// See "Memory, CPU and Cold Starts" in integrations/cloudfront/README.md.
import { Config } from "../models/config.interface";
import { HttpsClient } from "./https-client";
import { RTIRawResponse, RTIServiceBase } from "./rti-service.base";

export class RTIHttpsService extends RTIServiceBase {
    private readonly client: HttpsClient;

    /**
     * @param config integration config; `config.timeout` takes precedence over `defaultTimeout`
     * @param defaultTimeout RTI timeout in ms used when `config.timeout` is not set
     * @param idleSocketTimeoutMs how long an idle pooled connection is kept. The RTI endpoint closes idle
     *   connections after 60s, so ours are closed first.
     */
    constructor(config: Config, defaultTimeout?: number, idleSocketTimeoutMs: number = 50000) {
        super(config, defaultTimeout);
        this.client = new HttpsClient(this.url, idleSocketTimeoutMs);
    }

    protected send(body: string): Promise<RTIRawResponse> {
        return this.client.post(body, this.rtiTimeout);
    }
}
