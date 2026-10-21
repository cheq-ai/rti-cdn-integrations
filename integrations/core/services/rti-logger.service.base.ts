// Shared logic of the RTI loggers: config defaults, payload and error handling.
// Subclasses only implement the HTTP POST (send). A logging failure never fails the caller.
import { IRTILogger } from "../models/rti-logger.interface";
import { Config } from "../models/config.interface";

export interface RTILoggerRawResponse {
  status: number;
  statusText: string;
}

export abstract class RTILoggerServiceBase implements IRTILogger {
  protected readonly application: string;
  protected readonly config: Config;
  protected readonly url: string;
  protected readonly isDebugMode: boolean;

  constructor(application: string, config: Config) {
    this.application = application;
    this.config = config;
    this.url = this.config.rtiLoggerURI || 'https://rtilogger.production.cheq-platform.com';
    this.isDebugMode = this.config.debug || false;
  }

  async log(level: 'audit' | 'error' | 'info' | 'warn', message: string, action?: string): Promise<void> {
    try {
      const body = JSON.stringify({
        level,
        message,
        action,
        application: this.application,
        apiKey: this.config.apiKey,
        tagHash: this.config.tagHash,
      });

      return this.send(body)
      .then(response => {
        if (this.isDebugMode) {
          console.info(`rti logger response: ${response.status} (${response.statusText}) for log level: ${level}, message: ${message}, action: ${action}`);
        }
      })
      .catch(e => console.error(`rti logger api error (continue running): ${e}`));
    } catch (e) {
      console.error(`rti logger error (continue running): ${e}`);
    }
  }

  async error(message: string, action?: string): Promise<void> {
    return this.log('error', message, action);
  }

  async info(message: string, action?: string): Promise<void> {
    return this.log('info', message, action);
  }

  /** POSTs the JSON body to `this.url`. */
  protected abstract send(body: string): Promise<RTILoggerRawResponse>;
}
