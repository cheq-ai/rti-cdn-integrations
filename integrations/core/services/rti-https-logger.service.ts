// RTI logger using Node's built-in http/https modules — for Node runtimes only (CloudFront Lambda@Edge).
// Same payload and error handling as rti-logger.service.ts, but it avoids loading fetch (undici) on a
// cold start and gives up after a timeout, because the handler awaits the log before answering the viewer.
// See "Memory, CPU and Cold Starts" in integrations/cloudfront/README.md.
import { Config } from "../models/config.interface";
import { HttpsClient } from "./https-client";
import { RTILoggerRawResponse, RTILoggerServiceBase } from "./rti-logger.service.base";

export class RTIHttpsLoggerService extends RTILoggerServiceBase {
  private readonly client: HttpsClient;
  private readonly timeout: number;

  /**
   * @param application name reported with every log
   * @param config integration config
   * @param timeout ms before a log call is abandoned (logged to console, never thrown)
   * @param idleSocketTimeoutMs how long an idle pooled connection to the logger is kept
   */
  constructor(application: string, config: Config, timeout: number = 1000, idleSocketTimeoutMs: number = 50000) {
    super(application, config);
    this.timeout = timeout;
    this.client = new HttpsClient(this.url, idleSocketTimeoutMs);
  }

  protected send(body: string): Promise<RTILoggerRawResponse> {
    return this.client.post(body, this.timeout);
  }
}
