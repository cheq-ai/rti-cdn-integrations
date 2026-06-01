// Standard RTI logger using the Fetch API — suitable for runtimes that support it
// (Cloudflare Workers, CloudFront@Edge, Node.js, browsers).
// Akamai EdgeWorkers do NOT have fetch() — see integrations/akamai/src/rti-logger.ts
// for the Akamai-specific implementation that uses httpRequest instead.
import { IRTILogger } from "../models/rti-logger.interface";
import { Config } from "../models/config.interface";

export class RTILoggerService implements IRTILogger {
  private readonly application: string;
  private readonly config: Config;
  private readonly url: string;
  private readonly isDebugMode: boolean;

  constructor(application: string, config: Config) {
    this.application = application;
    this.config = config;
    this.url = this.config.rtiLoggerURI || 'https://rtilogger.production.cheq-platform.com';  
    this.isDebugMode = this.config.debug || false;
  }

  async log(level: 'audit' | 'error' | 'info' | 'warn', message: string, action?: string): Promise<void> {
    try {
      const request = {
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
      
      return fetch(this.url, request)
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
}
