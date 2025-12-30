import { Config } from "../models/config.interface";
import { EventType } from "../models/event-type.model";
import { RTIResponse } from "../models/rti-response.model";
import { Action } from "../models/action.model";
import { Mode } from "../models/mode.model";
import { RTIParams } from "../models/rti-params.model";
import { HeadersMap } from "../models/headers-map.model";

export class RTIHelperService {
  config: Config;
  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Returns if the path should be ignored
   * @param path
   */
  shouldIgnore(path: string): boolean {
    if (this.config.ignorePaths) {
      return this.config.ignorePaths.some(ignorePath => path.match(ignorePath));
    }
    return false;
  }

  /**
   * Returns event type for the given path and method, defaults to {@link EventType.PAGE_LOAD}
   * @param path
   * @param method
   */
  getEventType(path: string, method: string): EventType {
    if (this.config.routeToEventType) {
      const mapping = this.config.routeToEventType.find(
        mapping => path.match(mapping.path) && method.match(mapping.method),
      );
      if (mapping) {
        return mapping.event_type;
      }
    }
    return EventType.PAGE_LOAD;
  }

  /**
   * Returns the {@link Action} based on configuration and RTI response
   * @param rtiResponse
   */
  getAction(rtiResponse: RTIResponse): Action {
    if (this.config.mode === Mode.BLOCKING) {
      if (this.config.blockCodes.includes(rtiResponse.classification.code)) {
        return Action.BLOCK;
      } else if (this.config.redirectCodes?.includes(rtiResponse.classification.code)) {
        return Action.REDIRECT;
      } else if (this.config.challengeCodes?.includes(rtiResponse.classification.code) && this.config.redirectLocation) {
        return Action.CHALLENGE;
      }
    }
    return Action.ALLOW;
  }

  /**
   * Returns CHEQ cookie value
   * @param cookie
   */
  getCheqCookie(cookie: string) {
    return !cookie
        ? undefined
        : (
            cookie
            .split(';')
            .map(c => c.trim())
            .find(c => c.includes(RTIParams.CHEQ_COOKIE_NAME)) || ''
        ).substring(RTIParams.CHEQ_COOKIE_NAME.length + 1);
  }

  /**
   * Returns capitalized string and substrings
   * @param str
   * @param splitter
   */
  capitalize(str = '', splitter = ' ') {
    return str
        .split(splitter)
        .map(s => `${s.charAt(0).toUpperCase()}${s.substring(1)}`)
        .join(splitter);
  }

  /**
   * Returns header ignoring case
   * @param headers
   * @param name
   * @param defaultValue
   */
  getHeaderByName(headers: HeadersMap, name = '', defaultValue: string | number | undefined = undefined) {
    return headers[name.toLowerCase()] || headers[this.capitalize(name, '-')] || defaultValue;
  }

  /**
   * Validates configuration, returns list of errors found
   * @param config
   */
  validateConfig(): string[] {
    const errors: string[] = [];
    if ((this.config.redirectCodes && this.config.redirectCodes.length > 0 && !this.config.redirectLocation) ||
        (this.config.redirectLocation && !this.config.redirectCodes)) {
          errors.push("For redirecting as an Action you must define both redirectCodes and redirectLocation");
    }
    return errors;
  }
}
