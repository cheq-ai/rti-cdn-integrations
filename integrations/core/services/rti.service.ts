// Standard RTI caller using the Fetch API — suitable for runtimes that support it
// (Cloudflare Workers, CloudFront@Edge, Node.js, browsers).
// Akamai EdgeWorkers do NOT have fetch() — see integrations/akamai/src/rti-service.ts
// for the Akamai-specific implementation that uses httpRequest instead.
import { IRTIService } from "../models/rti-service.interface";
import { RTIRequest } from "../models/rti-request.model";
import { RTIResponse } from "../models/rti-response.model";
import { Config } from "../models/config.interface";

export class RTIService implements IRTIService {
    private readonly rtiTimeout: number;
    private readonly url: string;
    private readonly config: Config;

    constructor(config: Config) {
        this.config = config;
        this.rtiTimeout = this.config.timeout ?? 150;
        this.url = this.config.rtiServiceURI || "https://rti-global.cheqzone.com/defend/4.1/traffic";
    }
        
    public async callRTI(payload: RTIRequest): Promise<RTIResponse> {
        const options = {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            // @ts-ignore
            signal: AbortSignal.timeout(this.rtiTimeout),
        };

        try {
            const response = await fetch(this.url, options);
            
            if (response.status >= 400) {
                const body = await response.text();
                throw new Error(`Invalid RTI request, response code: ${response.status}, body: ${body}`);
            }
            
            const rtiResponse: RTIResponse = await response.json();
            return rtiResponse;
        } catch (e) {
            const err: Error = e as Error;
            throw new Error(`request error: ${err.message}`);
        }
    }
}
