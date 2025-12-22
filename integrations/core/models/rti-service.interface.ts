import { RTIRequest } from "./rti-request.model";
import { RTIResponse } from "./rti-response.model";
import { Config } from "./config.interface";

export interface IRTIService {
  /**
   * Send request to RTI
   * @param payload
   * @param config
   */
  callRTI(payload: RTIRequest, config: Config): Promise<RTIResponse>;
}
