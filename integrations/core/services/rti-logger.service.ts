// Standard RTI logger using the Fetch API — suitable for runtimes that support it
// (fetch-capable edge runtimes, Node.js, browsers).
// CloudFront uses rti-https-logger.service.ts instead (no fetch cold-start cost, with a timeout).
// Akamai EdgeWorkers do NOT have fetch() — see integrations/akamai/src/rti-logger.ts
// for the Akamai-specific implementation that uses httpRequest instead.
import { RTILoggerRawResponse, RTILoggerServiceBase } from "./rti-logger.service.base";

export class RTILoggerService extends RTILoggerServiceBase {
  protected send(body: string): Promise<RTILoggerRawResponse> {
    return fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
    });
  }
}
