// cspell:ignore CHEQ
import { Config } from "../models/config.interface";
import { EventType } from "../models/event-type.model";
import { RTIResponse } from "../models/rti-response.model";
import { Action } from "../models/action.model";
import { Mode } from "../models/mode.model";
import { ActionStrategy } from "../models/action-strategy.model";
import { RTIStatelessUtils } from "./rti-stateless-utils";

/**
 * The RTI decisions that depend on the integration's {@link Config}: whether a path is ignored,
 * which event type a request maps to, which {@link Action} and {@link ActionStrategy} an RTI
 * response leads to, and whether the config itself is valid.
 *
 * The config-free helpers (cookies, headers, list parsing, the `x-cheq-rti-result` header, the
 * challenge-reply check and error messages) live in {@link RTIStatelessUtils}, which this class
 * extends. The integrations only ever create this service and call everything through it, so the
 * split is invisible to them: `rtiHelperService.parseCookies(...)` and
 * `RTIHelperService.parseNumberList(...)` keep working through inheritance.
 *
 * Put a new method here only if it reads `this.config`; otherwise it belongs in
 * {@link RTIStatelessUtils}. The inheritance test in `rti-helper.service.spec.ts` guards the
 * `extends` link, because the helpers' own tests check the base class directly and would not
 * notice if this service lost them.
 */
export class RTIHelperService extends RTIStatelessUtils {
  config: Config;
  constructor(config: Config) {
    super();
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
      if (rtiResponse.decision.verdict === "malicious" || this.config.blockTTCodes?.includes(rtiResponse.classification.code) || this.config.blockReasons?.some(br => rtiResponse.cheqDetection.reasons.includes(br))) {
        return Action.BLOCK;
      } else if (rtiResponse.decision.verdict === "suspicious" || this.config.challengeTTCodes?.includes(rtiResponse.classification.code) || this.config.challengeReasons?.some(cr => rtiResponse.cheqDetection.reasons.includes(cr))) {
        return Action.CHALLENGE;
      } else if (this.config.redirectTTCodes?.includes(rtiResponse.classification.code) || this.config.redirectReasons?.some(rr => rtiResponse.cheqDetection.reasons.includes(rr))) {
        return Action.REDIRECT;
      }
    }
    return Action.ALLOW;
  }

  /**
   * Returns the {@link ActionStrategy} based on configuration and {@link Action}
   * @param action
   */
  getActionStrategy(action: Action): ActionStrategy | null {
    if (action === Action.BLOCK) {
      return this.config.blockingStrategy ?? ActionStrategy.ACCESS_DENIED;
    } else if (action === Action.CHALLENGE) {
      return this.config.challengingStrategy ?? ActionStrategy.CAPTCHA;
    } else if (action === Action.REDIRECT) {
      return ActionStrategy.REDIRECT;
    }
    return null;
  }

  /**
   * Validates configuration, returns list of errors found
   * @param config
   */
  validateConfig(): string[] {
    const errors: string[] = [];
    if ((this.config.redirectReasons && this.config.redirectReasons.length > 0 && !this.config.redirectLocation) ||
        (this.config.redirectLocation && !this.config.redirectReasons)) {
          errors.push("For redirecting as an Action you must define both redirectCodes and redirectLocation");
    }
    return errors;
  }
}
