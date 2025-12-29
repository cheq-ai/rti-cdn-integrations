import { RouteToEventType } from "./route-to-event-type.model";
import { Mode } from "./mode.model";

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
   * List of {@link RTIResponse.threatTypeCode| threat type codes} that will be blocked.
   */
  blockCodes: number[];

  /**
   * List of {@link RTIResponse.threatTypeCode| threat type codes} that will be redirected.
   */
  redirectCodes?: number[];

  /**
   * Location to redirect.
   */
  redirectLocation?: string;

  /**
   * List of {@link RTIResponse.threatTypeCode| threat type codes} that will invoke integration challenge function if configured.
   */
  challengeCodes?: number[];

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
   * Trusted IP header to be used as client IP. Overwrites {@link RTIRequest.ip} if header value exists.
   */
  trustedIPHeader?: string;

  /**
   * Timeout in milliseconds before cancelling RTI request.
   */
  timeout?: number;

  /**
   * Override the RTI Logger URI - default is: 'https://rtilogger.production.cheq-platform.com'.
   */
  rtiLoggerURI?: string;

  /**
   * Override the RTI Service URI - default is: 'https://rti-global.cheqzone.com/defend/4.0/traffic'.
   */
  rtiServiceURI?: string;
}
