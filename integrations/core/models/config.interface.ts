import { RouteToEventType } from "./route-to-event-type.model";
import { Mode } from "./mode.model";
import { RTIResponse } from "./rti-response.model";
import { ActionStrategy } from "./action-strategy.model";

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
   * Timeout in milliseconds before cancelling RTI request - Default is 150 ms.
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
}
