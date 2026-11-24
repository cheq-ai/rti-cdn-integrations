// cspell:ignore CHEQ bodyless
import { Config } from "../models/config.interface";
import { EventType } from "../models/event-type.model";
import { RTIResponse } from "../models/rti-response.model";
import { Action } from "../models/action.model";
import { Mode } from "../models/mode.model";
import { ActionStrategy } from "../models/action-strategy.model";
import {
  ACTION_ON_SUSPICIOUS_METHODS,
  ActionOnSuspiciousMethod,
  ActionOnSuspiciousRule,
  BODY_METHODS,
  RequestStrategy,
} from "../models/action-on-suspicious.model";
import { RTIStatelessUtils } from "./rti-stateless-utils";

/**
 * The RTI decisions that depend on the integration's {@link Config}: whether a path is ignored,
 * which event type a request maps to, which {@link Action} and {@link ActionStrategy} an RTI
 * response leads to, and whether the config itself is valid.
 *
 * The config-free helpers (cookies, headers, list parsing, the `x-cheq-rti-result` header, the
 * challenge-reply check, the bodyless-method, page-load, prefetch and Action checks, safe path
 * matching and error messages) live in {@link RTIStatelessUtils}, which this class
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
   * Returns the {@link Action} based on configuration and RTI response: {@link getEnforcedAction} in BLOCKING mode,
   * ALLOW in any other mode.
   * @param rtiResponse
   */
  getAction(rtiResponse: RTIResponse): Action {
    return this.config.mode === Mode.BLOCKING ? this.getEnforcedAction(rtiResponse) : Action.ALLOW;
  }

  /**
   * The {@link Action} the config gives for this RTI response, in any mode: what {@link getAction} gives in BLOCKING
   * mode. In MONITORING mode it says what BLOCKING mode would do.
   * @param rtiResponse
   */
  getEnforcedAction(rtiResponse: RTIResponse): Action {
    if (rtiResponse.decision.verdict === "malicious" || this.config.blockTTCodes?.includes(rtiResponse.classification.code) || this.config.blockReasons?.some(br => rtiResponse.cheqDetection.reasons.includes(br))) {
      return Action.BLOCK;
    } else if (rtiResponse.decision.verdict === "suspicious" || this.config.challengeTTCodes?.includes(rtiResponse.classification.code) || this.config.challengeReasons?.some(cr => rtiResponse.cheqDetection.reasons.includes(cr))) {
      return Action.CHALLENGE;
    } else if (this.config.redirectTTCodes?.includes(rtiResponse.classification.code) || this.config.redirectReasons?.some(rr => rtiResponse.cheqDetection.reasons.includes(rr))) {
      return Action.REDIRECT;
    }
    return Action.ALLOW;
  }

  /**
   * Returns the {@link ActionStrategy} based on configuration and {@link Action}.
   * A configured INTERSTITIAL counts as not set, so the default applies: only {@link getStrategyForRequest} gives
   * INTERSTITIAL, and only to a caller that passes `interstitialOn: true`. Akamai looks blockingStrategy and
   * challengingStrategy up by name in ActionStrategy, so the name INTERSTITIAL can arrive here.
   * @param action
   */
  getActionStrategy(action: Action): ActionStrategy | null {
    const configured = (strategy?: ActionStrategy) => strategy === ActionStrategy.INTERSTITIAL ? undefined : strategy;
    if (action === Action.BLOCK) {
      return configured(this.config.blockingStrategy) ?? ActionStrategy.ACCESS_DENIED;
    } else if (action === Action.CHALLENGE) {
      return configured(this.config.challengingStrategy) ?? ActionStrategy.CAPTCHA;
    } else if (action === Action.REDIRECT) {
      return ActionStrategy.REDIRECT;
    }
    return null;
  }

  /**
   * What to do with this request: RTI's {@link Action} mapped to a strategy ({@link getActionStrategy}). When that
   * strategy is CAPTCHA, the CAPTCHA page is not always the answer:
   * - RTI says CHALLENGE and the caller passes `isPageLoad`: three questions, in this order. 1. A rule of
   *   actionOnSuspicious matches the path and covers the method: the first such rule decides. 2. A page load gets the
   *   page. Only a GET can be a page load: a `true` passed for another method is not used. 3. Otherwise the method's
   *   default decides, else ALLOW.
   * - `isPageLoad` not passed (`undefined` or `null`), or a block verdict shown as a CAPTCHA (`blockingStrategy:
   *   CAPTCHA`): as before. A GET or HEAD gets the page, and the GET and HEAD settings are not used. Any other method
   *   follows {@link getActionOnSuspicious}: a CAPTCHA page can't carry a request body through (login, payment, the
   *   bank's 3DS return).
   * - A method outside the seven ({@link ActionOnSuspiciousMethod}) is forwarded, whatever `isPageLoad` says.
   * When actionOnSuspicious decides, its Action is mapped the same way and returned in `actionOnSuspicious`.
   * `strategy: null` means forward to the origin with the verdict.
   *
   * The interstitial is in play only for a GET page load: RTI says CHALLENGE, `interstitialOn` is exactly `true`, the
   * method is GET (any case) and `isPageLoad` is exactly `true`. Then the strategy is CAPTCHA, whatever
   * challengingStrategy says, so the three questions are asked: the page of question 2 is the interstitial
   * (INTERSTITIAL), and `Action.CHALLENGE` from a rule also means the interstitial. Any other request (a login POST, a
   * HEAD, a GET API call) gets the answer it gets without `interstitialOn`: challengingStrategy keeps working for it,
   * and `Action.CHALLENGE` from a rule or a default is mapped by getActionStrategy, as before (the CAPTCHA, unless
   * challengingStrategy says otherwise). A caller that does not pass `interstitialOn` (CloudFront) gets the answers
   * from before it existed. A block verdict never gets INTERSTITIAL, and getActionStrategy never gives it: it comes
   * only from here, for a caller that passes `true`.
   * @param action RTI's action for this request ({@link getAction})
   * @param method the request method
   * @param path the request path, for actionOnSuspicious rules
   * @param isPageLoad whether the request is a page load ({@link isPageLoad}). Not passed (`undefined` or `null`): the
   *   behavior from before this argument existed.
   * @param interstitialOn whether the interstitial is on. Only `true` counts, and it changes the answer only for a GET
   *   page load. Not passed: the answers from before this argument existed.
   */
  getStrategyForRequest(
    action: Action, method: string, path: string, isPageLoad?: boolean | null, interstitialOn?: boolean,
  ): RequestStrategy {
    // RTI says CHALLENGE and the page-load fact is passed: the three questions decide, if the strategy is CAPTCHA.
    const questions = action === Action.CHALLENGE && isPageLoad !== undefined && isPageLoad !== null;
    // The interstitial is in play only for a GET page load while it is on: the strategy is then CAPTCHA, whatever
    // challengingStrategy says. Any other request gets the answer it gets without interstitialOn.
    const interstitial = questions && interstitialOn === true && method.toUpperCase() === 'GET' && isPageLoad === true;
    const strategy = interstitial ? ActionStrategy.CAPTCHA
      : action !== Action.ALLOW ? this.getActionStrategy(action) : null;
    if (strategy !== ActionStrategy.CAPTCHA) {
      return { strategy };
    }
    // Only a GET can be a page load: a `true` passed for another method is not used.
    const pageLoad = Boolean(isPageLoad) && method.toUpperCase() === 'GET';
    if (!questions) {
      // As before isPageLoad was passed: a GET or HEAD gets the page.
      if (this.isBodylessMethod(method)) {
        return { strategy };
      }
    } else if (pageLoad && !this.findActionOnSuspiciousRule(method, path)) {
      // Question 2, asked only for a GET: a page load that no rule covers gets the page. A GET is one of the seven, so
      // here the helper's answer only says whether a rule covers it (its made-up ALLOW is for a method outside them).
      return { strategy: interstitial ? ActionStrategy.INTERSTITIAL : strategy };
    }
    // Question 1 or 3, or a request with a body as before: actionOnSuspicious decides.
    const suspiciousAction = this.getActionOnSuspicious(method, path);
    if (interstitial && suspiciousAction === Action.CHALLENGE) {
      // A rule that covers this GET page load says CHALLENGE: the interstitial.
      return { strategy: ActionStrategy.INTERSTITIAL, actionOnSuspicious: suspiciousAction };
    }
    return {
      strategy: suspiciousAction === Action.ALLOW ? null : this.getActionStrategy(suspiciousAction),
      actionOnSuspicious: suspiciousAction,
    };
  }

  /**
   * The Action of {@link Config.actionOnSuspicious} for this request when RTI says CHALLENGE: the first rule that
   * matches the path and covers the method, else the method's default, else {@link Action.ALLOW}. It covers the seven
   * methods of {@link ActionOnSuspiciousMethod}. Any other method is ALLOW, and no rule or default is used for it.
   * Wrong settings: a method key in `methods` that is not one of the seven is not used, and a value that is not an
   * {@link Action} counts as ALLOW. In a rule, a bad regex never matches and a misspelled method is never matched, so
   * the next rule or the method's default applies, and that can be BLOCK.
   * Expects the documented shape, which is not checked here: a rule without a string `path` matches every path, and
   * some other shapes throw (see the known limit on {@link ActionOnSuspicious}).
   * @param method the request method, any case
   * @param path the request path, matched against each rule's regex
   */
  getActionOnSuspicious(method: string, path: string): Action {
    const rule = this.findActionOnSuspiciousRule(method, path);
    const action = rule
      ? rule.action
      : this.config.actionOnSuspicious?.methods?.[method.toUpperCase() as ActionOnSuspiciousMethod];
    return this.isAction(action) ? action : Action.ALLOW;
  }

  /**
   * The rule of {@link Config.actionOnSuspicious} that decides this request, if one does: the first that matches the
   * path and covers the method. A rule covers the methods its `methods` names. A rule without `methods` covers the
   * five methods with a body ({@link BODY_METHODS}), not GET or HEAD. A method outside the seven gets
   * `{ action: Action.ALLOW }`, so no rule or default is used for it.
   * @param method the request method, any case
   * @param path the request path, matched against each rule's regex
   */
  private findActionOnSuspiciousRule(method: string, path: string): Pick<ActionOnSuspiciousRule, "action"> | undefined {
    const upperMethod = method.toUpperCase() as ActionOnSuspiciousMethod;
    if (!ACTION_ON_SUSPICIOUS_METHODS.includes(upperMethod)) {
      return { action: Action.ALLOW };
    }
    return this.config.actionOnSuspicious?.rules?.find(rule => {
      const covered: readonly ActionOnSuspiciousMethod[] = rule.methods || BODY_METHODS;
      return covered.includes(upperMethod) && this.pathMatches(path, rule.path);
    });
  }

  /**
   * Validates configuration, returns list of errors found, in this order:
   * 1. redirectReasons with a code but no redirectLocation, or a redirectLocation with redirectReasons left out and no
   *    other setting that can redirect.
   * 2. No redirectLocation (left out or `""`), while another setting can redirect ({@link otherSettingCanRedirect}):
   *    the visitors it redirects would be sent to https://www.cheq.ai/.
   * 3. The problems of {@link validateActionOnSuspicious}.
   */
  validateConfig(): string[] {
    const errors: string[] = [];
    if ((this.config.redirectReasons && this.config.redirectReasons.length > 0 && !this.config.redirectLocation) ||
        (this.config.redirectLocation && !this.config.redirectReasons && !this.otherSettingCanRedirect())) {
          errors.push("For redirecting as an Action you must define both redirectCodes and redirectLocation");
    }
    if (!this.config.redirectLocation && this.otherSettingCanRedirect()) {
      errors.push("redirectLocation is not set, but a setting can redirect (blockingStrategy or challengingStrategy REDIRECT, "
        + "Action.REDIRECT in actionOnSuspicious or interstitial, or redirectTTCodes): those visitors would be sent to "
        + "https://www.cheq.ai/");
    }
    errors.push(...this.validateActionOnSuspicious());
    return errors;
  }

  /**
   * Whether a setting other than redirectReasons can send a request to redirectLocation: redirectTTCodes with a code
   * in it, REDIRECT as blockingStrategy or challengingStrategy, or Action.REDIRECT in actionOnSuspicious (a method's
   * default or a rule), in interstitial.onSecondVerdict or in interstitial.onSessionNotFound. A setting counts as
   * written: the mode and interstitial.enabled are not read.
   * validateConfig uses it twice: it reports a redirectLocation with redirectReasons left out and no such setting, and
   * it reports such a setting without a redirectLocation.
   */
  private otherSettingCanRedirect(): boolean {
    const { redirectTTCodes, blockingStrategy, challengingStrategy, actionOnSuspicious, interstitial } = this.config;
    return (redirectTTCodes?.length ?? 0) > 0
      || blockingStrategy === ActionStrategy.REDIRECT
      || challengingStrategy === ActionStrategy.REDIRECT
      || Object.values(actionOnSuspicious?.methods ?? {}).includes(Action.REDIRECT)
      || (actionOnSuspicious?.rules ?? []).some(rule => rule.action === Action.REDIRECT)
      || interstitial?.onSecondVerdict === Action.REDIRECT
      || interstitial?.onSessionNotFound === Action.REDIRECT;
  }

  /**
   * Problems in {@link Config.actionOnSuspicious}, one message each: this says what to fix. Integrations log it once
   * per cold start. At run time the wrong values work as {@link getActionOnSuspicious} says: a method key in `methods`
   * that is not one of the seven is not used, and a value that is not an Action counts as ALLOW. In a rule, a bad regex
   * never matches and a misspelled method is never matched, so the next rule or the method's default applies, and that
   * can be BLOCK.
   * Known limit: it expects the documented shape. A missing or non-string `path` is not reported (it matches every
   * path), and `rules`, a rule or `methods` of another shape, or a value JSON can't write, can make it throw. CloudFront
   * calls it at module load, so that throw stops the Lambda from starting (see {@link ActionOnSuspicious}).
   */
  validateActionOnSuspicious(): string[] {
    const errors: string[] = [];
    const settings = this.config.actionOnSuspicious;
    for (const [method, action] of Object.entries(settings?.methods ?? {})) {
      if (!ACTION_ON_SUSPICIOUS_METHODS.includes(method as ActionOnSuspiciousMethod)) {
        errors.push(`actionOnSuspicious.methods: '${method}' is not one of ${ACTION_ON_SUSPICIOUS_METHODS.join(", ")}`);
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
        if (!ACTION_ON_SUSPICIOUS_METHODS.includes(method)) {
          errors.push(`actionOnSuspicious.rules[${i}].methods: '${method}' is not one of ${ACTION_ON_SUSPICIOUS_METHODS.join(", ")}`);
        }
      }
      if (!this.isAction(rule.action)) {
        errors.push(`actionOnSuspicious.rules[${i}].action: ${JSON.stringify(rule.action)} is not an Action`);
      }
    });
    return errors;
  }
}
