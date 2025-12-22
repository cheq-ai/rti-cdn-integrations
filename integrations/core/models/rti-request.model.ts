import { EventType } from "./event-type.model";
import { HeadersMap } from "./headers-map.model";

export interface RTIRequest {
  /**
   * Event type
   */
  eventType: EventType;

  /**
   * Request URL
   */
  url: string;

  /**
   * Client IP
   */
  ip: string;

  /**
   * Request Method
   */
  method: string;

  /**
   * Request Headers
   */
  headers: HeadersMap;

  /**
   * JA3 Fingerprint
   */
  ja3?: string;

  /**
   * Channel for {@link EventType.CUSTOM} event type
   */
  channel?: string;

  /**
   * Response Content-Type
   */
  resourceType?: string;
}
