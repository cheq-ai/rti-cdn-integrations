// Shared request flow for the RTI callers. Subclasses only implement how the request is sent
// (fetch in rti.service.ts, node:http/https in rti-https.service.ts).
import { IRTIService } from "../models/rti-service.interface";
import { RTIRequest } from "../models/rti-request.model";
import { RTIResponse } from "../models/rti-response.model";
import { Config } from "../models/config.interface";

export interface RTIRawResponse {
    status: number;
    body: string;
}

export abstract class RTIServiceBase implements IRTIService {
    protected readonly rtiTimeout: number;
    protected readonly url: string;
    protected readonly config: Config;

    /**
     * @param config integration config; `config.timeout` takes precedence when set
     * @param defaultTimeout RTI timeout in ms used when `config.timeout` is not set
     */
    constructor(config: Config, defaultTimeout: number = 2000) {
        this.config = config;
        this.rtiTimeout = this.config.timeout ?? defaultTimeout;
        this.url = this.config.rtiServiceURI || "https://rti-global.cheqzone.com/defend/4.1/traffic";
    }

    public async callRTI(payload: RTIRequest): Promise<RTIResponse> {
        try {
            const { status, body } = await this.send(JSON.stringify(payload));

            if (status >= 400) {
                throw new Error(`Invalid RTI request, response code: ${status}, body: ${body}`);
            }

            return JSON.parse(body) as RTIResponse;
        } catch (e) {
            throw new Error(`request error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * POST the serialized payload to {@link url} as JSON and resolve with the status and full body text.
     * Must reject if the whole call (connect, send, read body) takes longer than {@link rtiTimeout}.
     */
    protected abstract send(body: string): Promise<RTIRawResponse>;
}
