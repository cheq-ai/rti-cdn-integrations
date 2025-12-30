import { IRTIService } from "../models/rti-service.interface";
import { RTIRequest } from "../models/rti-request.model";
import { RTIResponse } from "../models/rti-response.model";
import { Config } from "../models/config.interface";

export class RTIService implements IRTIService {
    private readonly rtiTimeout = 150;
    private config: Config;

    constructor(config: Config) {
        this.config = config;
    }
        
    public async callRTI(payload: RTIRequest): Promise<RTIResponse> {
        const url = this.config.rtiServiceURI || "https://rti-global.cheqzone.com/defend/4.0/traffic";
        const options = {
        method: "POST",
        headers: { 
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        // @ts-ignore
        signal: AbortSignal.timeout(this.config.timeout ?? rtiTimeout),
        };
        try {
        const response = await fetch(url, options);
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
