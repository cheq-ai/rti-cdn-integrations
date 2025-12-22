import { IRTILogger } from "../models/rti-logger.interface";
import { Config } from "../models/config.interface";

export class RTILoggerService implements IRTILogger {
  application: string;
  config: Config;

  constructor(application: string, config: Config) {
    this.application = application;
    this.config = config;
  }

  async log(level: 'audit' | 'error' | 'info' | 'warn', message: string, action?: string): Promise<void> {
    try {
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          level,
          message,
          action,
          application: this.application,
          apiKey: this.config.apiKey,
          tagHash: this.config.tagHash,
        }),
      };
      return fetch(this.config.rtiLoggerURI || 'https://rtilogger.production.cheq-platform.com', options).then();
    } catch (e) {
      const err: Error = e as Error;
      console.error(`${this.application} request error: ${err.message}`);
    }
  }

  async error(message: string, action?: string): Promise<void> {
    return this.log('error', message, action);
  }

  async info(message: string, action?: string): Promise<void> {
    return this.log('info', message, action);
  }
}
