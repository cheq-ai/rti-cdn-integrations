// cspell:ignore CHEQ bodyless
import { Config } from "../models/config.interface";
import { EventType } from "../models/event-type.model";
import { RTIResponse } from "../models/rti-response.model";
import { Action } from "../models/action.model";
import { Mode } from "../models/mode.model";
import { ActionStrategy } from "../models/action-strategy.model";
import { BODY_METHODS, BodyMethod, RequestStrategy } from "../models/action-on-suspicious.model";
import { RTIStatelessUtils } from "./rti-stateless-utils";

/**
 * The RTI decisions that depend on the integration's {@link Config}: whether a path is ignored,
 * which event type a request maps to, which {@link Action} and {@link ActionStrategy} an RTI
 * response leads to, and whether the config itself is valid.
 *
 * The config-free helpers (cookies, headers, list parsing, the `x-cheq-rti-result` header, the
 * challenge-reply check, the bodyless-method and Action checks, safe path matching and error
 * messages) live in {@link RTIStatelessUtils}, which this class
 * extends. The integrations only ever create this service and call everything through it, so the
 * split is invisible to them: `rtiHelperService.parseCookies(...)` and
 * `RTIHelperService.parseNumberList(...)` keep working through inheritance.
 *
 * Put a new method here only if it reads `this.config` (directly, or through another method of
 * this class); otherwise it belongs in {@link RTIStatelessUtils}. The inheritance tests in
 * `rti-helper.service.spec.ts` enforce this, and guard the `extends` link, because the helpers'
 * own tests check the base class directly and would not notice if this service lost them.
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
   * What to do with this request: RTI's {@link Action} mapped to a strategy ({@link getActionStrategy}).
   * A CAPTCHA page can't carry a request body through (login, payment, the bank's 3DS return), so a POST, PUT, PATCH,
   * DELETE or OPTIONS is never challenged in place: when the strategy is CAPTCHA, {@link getActionOnSuspicious} decides
   * instead, mapped the same way. `strategy: null` means forward to the origin with the verdict.
   * @param action RTI's action for this request ({@link getAction})
   * @param method the request method
   * @param path the request path, for actionOnSuspicious rules
   */
  getStrategyForRequest(action: Action, method: string, path: string): RequestStrategy {
    const strategy = action !== Action.ALLOW ? this.getActionStrategy(action) : null;
    if (strategy !== ActionStrategy.CAPTCHA || this.isBodylessMethod(method)) {
      return { strategy };
    }
    const bodyAction = this.getActionOnSuspicious(method, path);
    return {
      strategy: bodyAction === Action.ALLOW ? null : this.getActionStrategy(bodyAction),
      actionOnSuspicious: bodyAction,
    };
  }

  /**
   * What to do with a request with a body when RTI says CHALLENGE ({@link Config.actionOnSuspicious}): the first
   * matching rule, else the method's default, else {@link Action.ALLOW}. A method that is not a {@link BodyMethod}
   * (GET, HEAD, anything else) is ALLOW: GET and HEAD get the CAPTCHA page through the usual flow.
   * A value that is not an {@link Action} counts as ALLOW, so a typo never blocks.
   * Expects the documented shape, which is not checked here: a rule without a string `path` matches every path, and
   * some other shapes throw (see the known limit on {@link ActionOnSuspicious}).
   * @param method the request method, any case
   * @param path the request path, matched against each rule's regex
   */
  getActionOnSuspicious(method: string, path: string): Action {
    const upperMethod = method.toUpperCase() as BodyMethod;
    if (!BODY_METHODS.includes(upperMethod)) {
      return Action.ALLOW;
    }
    const settings = this.config.actionOnSuspicious;
    const rule = settings?.rules?.find(r => (!r.methods || r.methods.includes(upperMethod)) && this.pathMatches(path, r.path));
    const action = rule ? rule.action : settings?.methods?.[upperMethod];
    return this.isAction(action) ? action : Action.ALLOW;
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
    errors.push(...this.validateActionOnSuspicious());
    return errors;
  }

  /**
   * Problems in {@link Config.actionOnSuspicious}, one message each. Wrong values are ALLOW at run time
   * (see {@link getActionOnSuspicious}); this says what to fix. Integrations log it once per cold start.
   * Known limit: it expects the documented shape. A missing or non-string `path` is not reported (it matches every
   * path), and `rules`, a rule or `methods` of another shape, or a value JSON can't write, can make it throw. CloudFront
   * calls it at module load, so that throw stops the Lambda from starting (see {@link ActionOnSuspicious}).
   */
  validateActionOnSuspicious(): string[] {
    const errors: string[] = [];
    const settings = this.config.actionOnSuspicious;
    for (const [method, action] of Object.entries(settings?.methods ?? {})) {
      if (!BODY_METHODS.includes(method as BodyMethod)) {
        errors.push(`actionOnSuspicious.methods: '${method}' is not one of ${BODY_METHODS.join(", ")}`);
      }
      if (!this.isAction(action)) {
        errors.push(`actionOnSuspicious.methods.${method}: ${JSON.stringify(action)} is not an Action`);
      }
    }
    (settings?.rules ?? []).forEach((rule, i) => {
      try {
        new RegExp(rule.path);
      } catch {
        errors.push(`actionOnSuspicious.rules[${i}].path: '${rule.path}' is not a valid regex`);
      }
      for (const method of rule.methods ?? []) {
        if (!BODY_METHODS.includes(method)) {
          errors.push(`actionOnSuspicious.rules[${i}].methods: '${method}' is not one of ${BODY_METHODS.join(", ")}`);
        }
      }
      if (!this.isAction(rule.action)) {
        errors.push(`actionOnSuspicious.rules[${i}].action: ${JSON.stringify(rule.action)} is not an Action`);
      }
    });
    return errors;
  }
}
