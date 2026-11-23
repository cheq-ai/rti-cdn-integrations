import { Action } from "./action.model";
import { ActionStrategy } from "./action-strategy.model";

/**
 * The methods with a body. A CAPTCHA page can't carry the body through, so these requests are not challenged in place.
 * - POST: forms, logins, checkout, API calls
 * - PUT, PATCH, DELETE: mostly API calls (create, update, delete)
 * - OPTIONS: the browser's CORS preflight, sent before a cross-site API call. Blocking it breaks that call.
 */
export type BodyMethod = "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/** The methods without a body. They can get the CAPTCHA page in place. */
export type BodylessMethod = "GET" | "HEAD";

/**
 * The seven methods {@link ActionOnSuspicious} covers. A request with another method is ALLOW, and no rule or default is
 * used for it. CONNECT and TRACE are not here: CloudFront does not forward them (AWS docs, "Allowed HTTP methods" of a
 * cache behavior).
 */
export type ActionOnSuspiciousMethod = BodylessMethod | BodyMethod;

/** Methods that can get the CAPTCHA page in place: they have no body to lose. */
export const CHALLENGEABLE_METHODS: readonly string[] = ["GET", "HEAD"];

/** Every {@link BodyMethod}: the methods that a rule without `methods` covers. */
export const BODY_METHODS: readonly BodyMethod[] = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** Every {@link ActionOnSuspiciousMethod}, for validation and loops. */
export const ACTION_ON_SUSPICIOUS_METHODS: readonly ActionOnSuspiciousMethod[] =
  ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** What to do with a request: the answer of RTIHelperService.getStrategyForRequest. */
export interface RequestStrategy {
  /** The answer to send, or `null` to forward to the origin with the verdict. */
  strategy: ActionStrategy | null;
  /**
   * Set only when {@link ActionOnSuspicious} decided (see RTIHelperService.getStrategyForRequest): the Action it gave,
   * ALLOW when no rule or default applies. Not set when the CAPTCHA page is the answer without it: for a page load that
   * no rule covers, or for a GET or HEAD when the caller does not pass `isPageLoad` or RTI wants it blocked with
   * `blockingStrategy: CAPTCHA`. For the debug log.
   */
  actionOnSuspicious?: Action;
}

/** One path rule of {@link ActionOnSuspicious}. */
export interface ActionOnSuspiciousRule {
  /**
   * Regex matched against the request path, like {@link Config.ignorePaths}, written as a string: `"^/login$"`, not
   * `/^\/login$/`. Required, and not checked at run time: `String.prototype.match` turns any other value into a regex,
   * so a rule without a path matches EVERY path (`{ methods: ["POST"], action: Action.BLOCK }` blocks every suspicious
   * POST), and `null` matches paths containing "null". RTIHelperService.validateActionOnSuspicious does not report it.
   */
  path: string;
  /**
   * The methods this rule covers. Without it the rule covers the five methods with a body ({@link BODY_METHODS}), not
   * GET or HEAD, so a rule written before GET and HEAD could be named keeps its meaning.
   */
  methods?: ActionOnSuspiciousMethod[];
  /** What to do for a matching request. */
  action: Action;
}

/**
 * What to do when RTI says CHALLENGE (suspicious) with the CAPTCHA strategy and the request is not a page load: a
 * request with a body (the CAPTCHA page can't carry the body through), or another GET or HEAD. A rule can also decide
 * for a page load. RTIHelperService.getStrategyForRequest asks three questions, in this order:
 * 1. Does a rule match the path and cover the method? The first such rule decides.
 * 2. Is the request a page load (RTIStatelessUtils.isPageLoad)? It gets the CAPTCHA page.
 * 3. Otherwise the method's default decides, else ALLOW.
 * isPageLoad is false for a request with a body, so for it this is: the first matching rule, then the default, then
 * ALLOW. A method outside the seven ({@link ActionOnSuspiciousMethod}) is ALLOW: no rule or default is used for it.
 *
 * - ALLOW: forwarded to the origin with `x-cheq-rti-result`, so the origin can decide.
 * - CHALLENGE: the CAPTCHA page. A GET or HEAD gets it in place. A request with a body gets it built for the page the
 *   visitor came from (Referer, same site only; else the site's home page). After solving they are back on that page
 *   and can send the form again. The body itself is not kept.
 * - BLOCK: the `blockingStrategy` answer (403 by default, or 404).
 * - REDIRECT: a 302 to `redirectLocation`.
 *
 * A caller that does not pass `isPageLoad` to RTIHelperService.getStrategyForRequest, and a block verdict shown as a
 * CAPTCHA (`blockingStrategy: CAPTCHA`), keep the behavior from before `isPageLoad` existed: a GET or HEAD gets the
 * CAPTCHA page, and the GET and HEAD settings are not used.
 *
 * Known limit: the shape is not checked at run time; TypeScript enforces it in config.ts. A value forced past it (a
 * cast, or a config built in plain JS) is used as it is:
 * - a rule without a `path`, or one that is not a string: see {@link ActionOnSuspiciousRule.path} (matches every path)
 * - `rules` that are not a list, a rule that is not an object (`null`, a hole in the list), `methods` that are not a
 *   list, or a value JSON can't write (a bigint, a circular object, a Symbol): can throw. In
 *   RTIHelperService.validateActionOnSuspicious, which CloudFront runs at module load, the Lambda then does not start;
 *   in RTIHelperService.getStrategyForRequest and getActionOnSuspicious, each request it applies to fails open
 *   (forwarded without a verdict)
 * - `methods: "POST"` as a string: matched as a substring, not as a list
 */
export interface ActionOnSuspicious {
  /** The default per method, GET and HEAD included. A method not listed is ALLOW. */
  methods?: Partial<Record<ActionOnSuspiciousMethod, Action>>;
  /** Per path (regex) and method. Checked in order; the first match wins. */
  rules?: ActionOnSuspiciousRule[];
}
