/**
 * Root payload for rate limit tagging request
 */
export interface RTIRequest {
  /**
   * Hash identifying the rate limit tag
   */
  tagHash: string;

  /**
   * API key associated with the rate limit tag
   */
  apiKey: string;

  /**
   * Unique identifier of the page view (optional)
   */
  pageViewId?: string;

  /**
   * Unique identifier of the client user (optional)
   */
  clientUserId?: string;

  /**
   * End-user related request parameters
   */
  endUserParams: EndUserParams;

  /**
   * Indicates whether the header names were received in a deterministic order
   */
  isHeaderNamesOrdered: boolean;

  /**
   * Logical channel or source identifier
   */
  channel?: string;

  /**
   * High-resolution timestamp (optional)
   */
  microTime?: string;

  /**
   * Custom identifier 1
   */
  customId1?: string;

  /**
   * Custom identifier 2
   */
  customId2?: string;

  /**
   * Custom identifier 3
   */
  customId3?: string;

  /**
   * Custom identifier 4
   */
  customId4?: string;

  /**
   * Device unique identifier cookie (optional)
   */
  duidCookie?: string;

  /**
   * Page view identifier cookie (optional)
   */
  pvidCookie?: string;
}

/**
 * Container for end-user request metadata
 */
export interface EndUserParams {
  /**
   * Client IP address as detected by the system
   */
  clientIp?: string;

  /**
   * Full request URL accessed by the client
   */
  requestUrl?: string;

  /**
   * Comma-separated list of HTTP header names
   */
  headerNames?: string;

  /**
   * HTTP request method (e.g., GET, POST)
   */
  method?: string;

  /**
   * Map of HTTP headers sent with the request
   */
  headers?: RequestHeaders;
}

/**
 * HTTP request headers collected from the client
 */
export interface RequestHeaders {
  /**
   * Allows indexing by any header name (normalized to lowercase in many systems).
   */
  [headerName: string]: string | undefined;
  
  /**
   * User-Agent header identifying the client software
   */
  "user-agent"?: string;

  /**
   * Host header specifying the requested domain
   */
  host?: string;

  /**
   * X-Forwarded-For header containing the original client IP
   */
  "x-forwarded-for"?: string;

  /**
   * Via header indicating intermediate proxies
   */
  via?: string;

  /**
   * Referer header indicating the navigation source
   */
  referer?: string;

  /**
   * Accept header specifying accepted media types
   */
  accept?: string;

  /**
   * Accept-Encoding header specifying supported encodings
   */
  "accept-encoding"?: string;

  /**
   * Accept-Language header specifying preferred languages
   */
  "accept-language"?: string;

  /**
   * Accept-Charset header specifying supported character sets
   */
  "accept-charset"?: string;

  /**
   * Origin header specifying the request origin
   */
  origin?: string;

  /**
   * X-Requested-With header, typically used for AJAX requests
   */
  "x-requested-with"?: string;

  /**
   * Connection header controlling connection behavior
   */
  connection?: string;

  /**
   * Pragma header used for backward compatibility with HTTP/1.0 caches
   */
  pragma?: string;

  /**
   * Cache-Control header specifying caching directives
   */
  "cache-control"?: string;

  /**
   * Content-Type header specifying the request payload type
   */
  "content-type"?: string;

  /**
   * From header identifying the request sender
   */
  from?: string;

  /**
   * X-Real-IP header specifying the client IP as seen by a proxy
   */
  "x-real-ip"?: string;

  /**
   * True-Client-IP header specifying the original client IP
   */
  "true-client-ip"?: string;

  /**
   * CHEQ JA3 TLS fingerprint
   */
  cheq_ja3?: string;

  /**
   * CHEQ JA4 TLS fingerprint
   */
  cheq_ja4?: string;

  /**
   * CHEQ TCP/IP fingerprint
   */
  cheq_ip_tcp?: string;

  /**
   * Sorted CHEQ JA3 fingerprint
   */
  cheq_ja3_sorted?: string;
}
