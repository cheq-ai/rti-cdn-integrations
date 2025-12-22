import { EventType } from "./event-type.model";

export interface RouteToEventType {
  /**
   * Path pattern
   */
  path: string;
  /**
   * Method pattern
   */
  method: string;
  /**
   * Event type
   */
  event_type: EventType;
}
