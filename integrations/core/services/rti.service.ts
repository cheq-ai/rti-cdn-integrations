import { IRTIService } from "../models/rti-service.interface";
import { RTIRequest } from "../models/rti-request.model";
import { RTIResponse } from "../models/rti-response.model";
import { Config } from "../models/config.interface";
import { RTIHelperService } from "./rti-helper.service";

export class RTIService implements IRTIService {
    private readonly rtiTimeout = 150;
    private config: Config;
    private rtiHelper: RTIHelperService;

    constructor(config: Config) {
        this.config = config;
        this.rtiHelper = new RTIHelperService(this.config);
    }
        
    public async callRTI(payload: RTIRequest): Promise<RTIResponse> {
        const body = this.rtiHelper.getBody(payload);
        const params = new URLSearchParams();
        Object.entries(body).forEach(([key, value]) => {
        if (value) {
            params.append(key, String(value));
        }
        });
        const url = this.config.rtiServiceURI || 'https://rti-global.cheqzone.com/defend/4.0/traffic';
        const options = {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        // @ts-ignore
        signal: AbortSignal.timeout(config.timeout ?? rtiTimeout),
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
