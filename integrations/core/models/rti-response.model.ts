/**
 * Rules engine integration response payload
 */
export interface RTIResponse {
  /**
   * Response metadata (timestamp, version, tag info, etc.)
   */
  metadata: Metadata;

  /**
   * Decision outcome returned by the rules engine (verdict, rule, score)
   */
  decision: Decision;

  /**
   * Final classification for the request/device
   */
  classification: Classification;

  /**
   * Identifiers associated with the request/session/user
   */
  ids: Ids;

  /**
   * Device attributes detected/observed for the request
   */
  device: Device;

  /**
   * Network attributes detected/observed for the request
   */
  network: Network;

  /**
   * Fingerprint signals collected for the request
   */
  fingerprints: Fingerprints;

  /**
   * CHEQ detection details and reasons behind the classification
   */
  cheqDetection: CheqDetection;
}

/**
 * Response metadata container
 */
export interface Metadata {
  /**
   * ISO timestamp when the response was generated
   */
  timestamp: string;

  /**
   * Response schema / engine version
   */
  version: string;

  /**
   * Human-readable tag name for the integration or configuration
   */
  tagName: string;

  /**
   * Indicates whether a session was found (null when unknown/not available)
   */
  sessionFound: boolean | null;
}

/**
 * Rules engine decision details
 */
export interface Decision {
  /**
   * Decision verdict (e.g., benign, suspicious, malicious)
   */
  verdict: string;

  /**
   * Name of the rule that produced the verdict (null if none matched)
   */
  ruleName: string | null;

  /**
   * Risk score as a string representation (e.g., "0.00")
   */
  riskScore: string;
}

/**
 * Classification details for the request/device
 */
export interface Classification {
  /**
   * Numeric classification code
   */
  code: number;

  /**
   * Classification name (empty string if not set)
   */
  name: string;

  /**
   * Classification group/category (empty string if not set)
   */
  group: string;
}

/**
 * Identifiers included in the response
 */
export interface Ids {
  /**
   * Ray/request identifier (trace id)
   */
  rayId: string;

  /**
   * Page view identifier (null if not available)
   */
  pageViewId: string | null;

  /**
   * Device unique identifier (null if not available)
   */
  duid: string | null;

  /**
   * Unique visit identifier (null if not available)
   */
  uniqueVisitId: string | null;

  /**
   * Custom parameter 1
   */
  customParam1: string | null;

  /**
   * Custom parameter 2
   */
  customParam2: string | null;

  /**
   * Custom parameter 3
   */
  customParam3: string | null;

  /**
   * Custom parameter 4
   */
  customParam4: string | null;
}

/**
 * Device attributes observed/detected
 */
export interface Device {
  /**
   * Device type (e.g., Desktop, Mobile)
   */
  type: string;

  /**
   * Operating system identifier
   */
  os: string;

  /**
   * Browser identifier
   */
  browser: string;

  /**
   * Browser timezone (null if not available)
   */
  browserTimezone: string | null;

  /**
   * Device model (null if not available)
   */
  model: string | null;

  /**
   * Device vendor/manufacturer (null if not available)
   */
  vendor: string | null;

  /**
   * Full user-agent string
   */
  userAgent: string;

  /**
   * Brave mode indicator (null if not available)
   */
  braveMode: string | null;

  /**
   * Screen orientation (null if not available)
   */
  screenOrientation: string | null;

  /**
   * Number of logical CPU cores available to the browser (null if not available)
   */
  hardwareConcurrency: string | null;

  /**
   * Whether cookies are disabled in the client
   */
  cookiesOff: boolean;

  /**
   * Whether JavaScript is disabled in the client
   */
  jsOff: boolean;

  /**
   * Battery percentage (null if not available)
   */
  batteryPercentage: number | null;

  /**
   * Battery charging state (null if not available)
   */
  batteryState: string | null;
}

/**
 * Network information observed/detected
 */
export interface Network {
  /**
   * Client IP address
   */
  ip: string;

  /**
   * X-Forwarded-For value (null if not available)
   */
  xForwardedFor: string | null;

  /**
   * GeoIP-derived location details
   */
  geoIp: GeoIp;

  /**
   * Autonomous system details
   */
  as: ASNData;
}

/**
 * GeoIP location details
 */
export interface GeoIp {
  /**
   * Country code (e.g., "LV")
   */
  country: string;

  /**
   * City name
   */
  city: string;

  /**
   * State/region name (may be empty)
   */
  state: string;

  /**
   * ZIP/postal code
   */
  zip: string;

  /**
   * Timezone derived from geolocation
   */
  geoTimezone: string;
}

/**
 * Autonomous system (AS) details for the IP
 */
export interface ASNData {
  /**
   * ASN number
   */
  asNumber: number;

  /**
   * ASN organization name
   */
  asName: string;
}

/**
 * Fingerprinting signals container
 */
export interface Fingerprints {
  /**
   * HTTP/2 fingerprint data (null if not available)
   */
  http2: string | null;

  /**
   * CHEQ IP/TCP fingerprint (null if not available)
   */
  cheqIpTcp: string | null;

  /**
   * TLS fingerprint data (JA3/JA4)
   */
  tls: TlsFingerprints;

  /**
   * Canvas fingerprint value (null if not available)
   */
  canvas: string | null;

  /**
   * WebGL fingerprint value (null if not available)
   */
  webgl: string | null;

  /**
   * JS heap size limit (null if not available)
   */
  heapSizeLimit: number | null;

  /**
   * Screen fingerprint/metrics data (null if not available)
   */
  screenData: string | null;

  /**
   * Screen aspect ratio (null if not available)
   */
  aspectRatio: string | null;
}

/**
 * TLS fingerprint details
 */
export interface TlsFingerprints {
  /**
   * JA3 TLS fingerprint (null if not available)
   */
  ja3: string | null;

  /**
   * Sorted JA3 TLS fingerprint (null if not available)
   */
  ja3Sorted: string | null;

  /**
   * JA4 TLS fingerprint (null if not available)
   */
  ja4: string | null;
}

/**
 * CHEQ detection outcome and reasoning
 */
export interface CheqDetection {
  /**
   * Risk score detected by CHEQ as a string representation (e.g., "0.00")
   */
  detectedRiskScore: string;

  /**
   * Classification code detected by CHEQ
   */
  detectedClassificationCode: number;

  /**
   * Classification name detected by CHEQ (empty string if not set)
   */
  detectedClassificationName: string;

  /**
   * Classification group detected by CHEQ (empty string if not set)
   */
  detectedClassificationGroup: string;

  /**
   * Whether the request is considered automated
   */
  isAutomated: boolean;

  /**
   * Detected entity type/category (e.g., Unspecified)
   */
  entity: string;

  /**
   * Whether spoofing was detected
   */
  isSpoofed: boolean;

  /**
   * Whether an emulator environment was detected
   */
  isEmulator: boolean;

  /**
   * Whether proxy usage was detected
   */
  isProxy: boolean;

  /**
   * List of detected proxy types (empty when none)
   */
  proxyTypes: string[];

  /**
   * Rate-limit detection details
   */
  rateLimit: RateLimitDetection;

  /**
   * Whether programmatic (synthetic) user interaction was detected
   */
  progUserInteraction: boolean;

  /**
   * Whether expected user interaction signals are missing
   */
  missingUserInteraction: boolean;

  /**
   * Numeric reason codes contributing to the detection
   */
  reasons: number[];

  /**
   * Reason codes that were disabled/ignored
   */
  disabledReasons: number[];
}

/**
 * Rate-limit detection details
 */
export interface RateLimitDetection {
  /**
   * Whether the rate limit was hit
   */
  hit: boolean;

  /**
   * Identifiers involved in the rate-limit decision (empty when none)
   */
  ids: string[];
}
