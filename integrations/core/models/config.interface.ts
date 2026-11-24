import { RouteToEventType } from "./route-to-event-type.model";
import { Mode } from "./mode.model";
import { RTIResponse } from "./rti-response.model";
import { ActionStrategy } from "./action-strategy.model";
import { ActionOnSuspicious } from "./action-on-suspicious.model";
import { InterstitialSettings } from "./interstitial.model";

export interface Config {
  /**
   * {@link Mode.MONITORING| Monitoring Mode} will send requests to RTI but will not perform any actions like blocking.
   *
   * {@link Mode.BLOCKING| Blocking Mode} will send requests to RTI and take the appropriate action.
   */
  mode: Mode;

  /**
   * Your API Key, available on the Paradome platform
   */
  apiKey: string;

  /**
   * Your Tag Hash, available on the Paradome platform
   */
  tagHash: string;

  /**
   * List of {@link RTIResponse.classification.code| threat type codes} that will be blocked.
   * Know as malicious traffic
   */
  blockTTCodes?: number[];

  /**
   * List of {@link RTIResponse.cheqDetection.reasons| reason codes} that will be blocked.
   * Know as malicious traffic
   */
  blockReasons?: number[];

  /**
   * List of {@link RTIResponse.classification.code| threat type codes} that will invoke integration challenge function if configured.
   * Know as suspicious traffic
   */
  challengeTTCodes?: number[];
  
  /**
   * List of {@link RTIResponse.cheqDetection.reasons| reason codes} that will invoke integration challenge function if configured.
   * Know as suspicious traffic
   */
  challengeReasons?: number[];

  /**
   * List of {@link RTIResponse.classification.code| threat type codes} that will be redirected.
   * When the traffic is considered benign but you prefer to redirect rather allow it.
   */
  redirectTTCodes?: number[];

  /**
   * List of {@link RTIResponse.cheqDetection.reasons| reason codes} that will be redirected.
   * When the traffic is considered benign but you prefer to redirect rather allow it.
   */
  redirectReasons?: number[];

  /**
   * Location to redirect when decision is made to redirect the traffic - default is: 'https://www.cheq.ai/'.
   */
  redirectLocation?: string;

  /**
   * Define the action strategy for malicious traffic, the default is {@link ActionStrategy.ACCESS_DENIED| Access Denied}.
   * 
   * {@link ActionStrategy.ACCESS_DENIED| Access Denied} will return HTTP status 403.
   *
   * {@link ActionStrategy.NOT_FOUND| Not Found} will return HTTP status 404.
   * 
   * {@link ActionStrategy.REDIRECT| Redirect} will return HTTP status 302 and redirect to {@link Config.redirectLocation | Redirect Location}.
   * 
   * {@link ActionStrategy.CAPTCHA| Captcha} will trigger captcha function if configured.
   */
  blockingStrategy?: ActionStrategy;

  /**
   * Define the action strategy for suspicious traffic, the default is {@link ActionStrategy.CAPTCHA| Captcha}.
   * 
   * {@link ActionStrategy.ACCESS_DENIED| Access Denied} will return HTTP status 403.
   *
   * {@link ActionStrategy.NOT_FOUND| Not Found} will return HTTP status 404.
   * 
   * {@link ActionStrategy.REDIRECT| Redirect} will return HTTP status 302 and redirect to {@link Config.redirectLocation | Redirect Location}.
   * 
   * {@link ActionStrategy.CAPTCHA| Captcha} will trigger captcha function if configured.
   *
   * While the interstitial is on ({@link Config.interstitial}, Cloudflare only for now), it is not used for a GET page
   * load that RTI wants challenged. A rule of {@link Config.actionOnSuspicious} that covers such a request still
   * decides, and its `Action.CHALLENGE` means the interstitial. Otherwise the interstitial decides (see
   * {@link InterstitialSettings}), and `Action.CHALLENGE` in its `onSecondVerdict` or `onSessionNotFound` means the
   * CAPTCHA. Every other request (a POST, a HEAD, a script's fetch) gets the answer it gets with the interstitial off,
   * this setting included. When it is set while the interstitial is on, a warning at cold start says so.
   */
  challengingStrategy?: ActionStrategy;

  /**
   * Paths that are ignored.
   *
   * @example
   * ```typescript
   * ['/images', '/api/test', '\\.css$', '\\.js$']
   * ```
   */
  ignorePaths?: string[];

  /**
   * What to do when RTI says CHALLENGE and the request is not a page load: a request with a body (POST, PUT, PATCH,
   * DELETE, OPTIONS), or another GET or HEAD. A page load gets the CAPTCHA page, unless a rule covers it. Every default
   * is ALLOW: forwarded with `x-cheq-rti-result`.
   * `methods: { GET: Action.CHALLENGE, HEAD: Action.CHALLENGE }` gives a GET or HEAD that no rule covers the CAPTCHA
   * page, as before. See {@link ActionOnSuspicious}.
   * @example
   * ```ts
   * {
   *   methods: { POST: Action.ALLOW, PUT: Action.BLOCK },
   *   rules: [
   *     { path: '^/login$', methods: ['POST'], action: Action.CHALLENGE },
   *     { path: '^/api/', methods: ['GET'], action: Action.ALLOW },
   *   ],
   * }
   * ```
   */
  actionOnSuspicious?: ActionOnSuspicious;

  /**
   * The passive interstitial: a page load that RTI wants challenged first gets a short CHEQ page, which runs the
   * customer's CHEQ tag and reloads, and RTI then decides a second time with the tag's data. Left out: no interstitial.
   * See {@link InterstitialSettings}.
   * Cloudflare only for now: the other CDNs do not read it.
   */
  interstitial?: InterstitialSettings;

  /**
   * List of {@link RouteToEventType} mappings
   *
   * @example
   * ```typescript
   * [
   *   {
   *     path: '/api/cart',
   *     method: 'POST|PUT',
   *     event_type: EventType.ADD_TO_CART,
   *   },
   *   {
   *     path: '/api/search*',
   *     method: 'PUT',
   *     event_type: EventType.SEARCH,
   *   },
   *   {
   *     path: '/api/payment$',
   *     method: 'POST',
   *     event_type: EventType.ADD_PAYMENT,
   *   },
   * ]
   * ```
   */
  routeToEventType?: RouteToEventType[];

  /**
   * Timeout in milliseconds before cancelling RTI request.
   * Default: 2000 ms for CloudFront (RTIHttpsService), 150 ms for the fetch-based RTIService used by the other CDNs.
   */
  timeout?: number;

  /**
   * Override the RTI Logger URI - default is: 'https://rtilogger.production.cheq-platform.com'.
   */
  rtiLoggerURI?: string;

  /**
   * Override the RTI Service URI - default is: 'https://rti-global.cheqzone.com/defend/4.1/traffic'.
   */
  rtiServiceURI?: string;

  /**
   * Enables local debug logging
   */
  debug?: boolean;

  /**
   * Enable telemetry logging. This will send logs regarding the RTI call duration to the RTI Logger service (via HTTP).
   * The logs will be tagged with `rti_duration` and will include the duration of the RTI call in milliseconds. 
   * This is useful for monitoring the performance of the RTI calls in production.
   * 
   * In Future, we may expand the telemetry functionality to include more log types and more detailed information about the RTI calls.
   */
  telemetry: boolean;

  /**
   * Enable error logging. When an error is caught while handling a request, it will be sent to the RTI Logger service (via HTTP).
   * Errors are always written to the console regardless of this setting.
   *
   * Defaults to `true` — only an explicit `false` disables it.
   */
  logErrors?: boolean;
}
