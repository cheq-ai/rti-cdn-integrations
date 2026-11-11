import { Action } from "./action.model";
import { ActionStrategy } from "./action-strategy.model";

/**
 * The methods {@link ActionOnSuspicious} covers. GET and HEAD are not here: they always get the CAPTCHA page, since
 * they have no body to lose. CONNECT and TRACE are not here either: CloudFront does not forward them.
 * - POST: forms, logins, checkout, API calls
 * - PUT, PATCH, DELETE: mostly API calls (create, update, delete)
 * - OPTIONS: the browser's CORS preflight, sent before a cross-site API call. Blocking it breaks that call.
 */
export type BodyMethod = "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/** Methods that can get the CAPTCHA page in place: they have no body to lose. */
export const CHALLENGEABLE_METHODS: readonly string[] = ["GET", "HEAD"];

/** Every {@link BodyMethod}, for validation and loops. */
export const BODY_METHODS: readonly BodyMethod[] = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** What to do with a request: the answer of RTIHelperService.getStrategyForRequest. */
export interface RequestStrategy {
  /** The answer to send, or `null` to forward to the origin with the verdict. */
  strategy: ActionStrategy | null;
  /**
   * Set only when {@link ActionOnSuspicious} decided (a request with a body and a CAPTCHA verdict): the Action it gave.
   * For the debug log.
   */
  actionOnSuspicious?: Action;
}

/** One path rule of {@link ActionOnSuspicious}. */
export interface ActionOnSuspiciousRule {
  /** Regex matched against the request path, like {@link Config.ignorePaths}. */
  path: string;
  /** The methods this rule applies to. Leave it out for all of them. */
  methods?: BodyMethod[];
  /** What to do for a matching request. */
  action: Action;
}

/**
 * What to do when RTI says CHALLENGE (suspicious) for a request with a body. A CAPTCHA page can't carry the body
 * through, so these requests are not challenged in place. For each request the first matching rule wins, then the
 * method's default, then ALLOW.
 *
 * - ALLOW: forwarded to the origin with `x-cheq-rti-result`, so the origin can decide.
 * - CHALLENGE: the CAPTCHA page, built for the page the visitor came from (Referer, same site only; else the site's
 *   home page). After solving they are back on that page and can send the form again. The body itself is not kept.
 * - BLOCK: the `blockingStrategy` answer (403 by default, or 404).
 * - REDIRECT: a 302 to `redirectLocation`.
 */
export interface ActionOnSuspicious {
  /** The default per method. A method not listed is ALLOW. */
  methods?: Partial<Record<BodyMethod, Action>>;
  /** Per path (regex) and method. Checked in order; the first match wins. */
  rules?: ActionOnSuspiciousRule[];
}
