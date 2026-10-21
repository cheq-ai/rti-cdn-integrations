// Standard RTI caller using the Fetch API — suitable for runtimes that support it
// (Cloudflare Workers, Node.js, browsers).
// CloudFront uses rti-https.service.ts instead: loading fetch (undici) on a cold 128 MB Lambda@Edge
// is slow enough to hit the RTI timeout. See "Memory, CPU and Cold Starts" in integrations/cloudfront/README.md.
// Akamai EdgeWorkers do NOT have fetch() — see integrations/akamai/src/rti-service.ts
// for the Akamai-specific implementation that uses httpRequest instead.
import { Config } from "../models/config.interface";
import { RTIRawResponse, RTIServiceBase } from "./rti-service.base";

export class RTIService extends RTIServiceBase {
    constructor(config: Config, defaultTimeout: number = 150) {
        super(config, defaultTimeout);
    }

    protected async send(body: string): Promise<RTIRawResponse> {
        const response = await fetch(this.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body,
            // @ts-ignore
            signal: AbortSignal.timeout(this.rtiTimeout),
        });

        return { status: response.status, body: await response.text() };
    }
}
