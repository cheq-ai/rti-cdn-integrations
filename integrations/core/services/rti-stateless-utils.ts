// cspell:ignore nums CHEQ duid pvid
import { RTIResponse } from "../models/rti-response.model";
import { RTIParams } from "../models/rti-params.model";
import { HeadersMap } from "../models/headers-map.model";
import { ActionStrategy } from "../models/action-strategy.model";
import { RequestHeaders, RTIRequest } from "../models/rti-request.model";

/**
 * The RTI helpers that need no configuration: cookie and header parsing, comma-separated list
 * parsing, the `x-cheq-rti-result` header, the challenge-reply check, the challenge return-path
 * check, host normalization, debug-log redaction and safe error messages.
 *
 * Every method works only on its arguments. The class takes no constructor arguments, holds no
 * instance state and imports nothing but models, so it can be used on its own wherever no config
 * is available yet (for example while the config itself is being built).
 *
 * `RTIHelperService` extends this class and adds the decisions that do depend on config (ignore
 * paths, event types, actions and strategies, config validation). The integrations call these
 * helpers through that service, so they reach both halves through one object.
 *
 * Keep it stateless: a helper that needs config belongs in `RTIHelperService` instead.
 * `rti-stateless-utils.spec.ts` enforces this - it fails if a constructor parameter, an
 * instance field, or an import outside `../models/` (or of the config) is added here.
 */
export class RTIStatelessUtils {
  /**
   * Whether a reply to a challenge page goes to the challenge callback: when RTI allows it (no strategy) or asks for
   * a CAPTCHA. Blocks, 404s and redirects are always enforced. Listed positively, so a new strategy is enforced
   * unless it is added here: a solved token must never bypass it by default.
   * @param actionStrategy the strategy from `RTIHelperService.getActionStrategy`, or null when the action is ALLOW
   */
  isChallengeReplyAllowed(actionStrategy: ActionStrategy | null): boolean {
    return actionStrategy === null || actionStrategy === ActionStrategy.CAPTCHA;
  }

  /**
   * The message of anything thrown, for logging in a catch. Never throws itself: code can throw undefined, null or any
   * object, and reading `.message` on those (or `String()` on a null-prototype object) would throw inside the catch and
   * break the fail-open. An `Error` gives its message, anything else `String(e)`; if that throws,
   * `Object.prototype.toString` (e.g. `[object Object]`); if even that throws (a hostile Proxy), `"unknown error"`.
   * The message goes through `String()` too: code can set it to anything, and a Symbol there would make the
   * caller's template literal throw.
   * @param e the value caught
   */
  errorMessage(e: unknown): string {
    try {
      return String(e instanceof Error ? e.message : e);
    } catch {
      try {
        return Object.prototype.toString.call(e);
      } catch {
        return "unknown error";
      }
    }
  }

  /**
   * Parses a raw Cookie header string and extracts the three CHEQ RTI cookies.
   * Uses substring (not split) so base64-padded values with `=` are preserved intact.
   *
   * Edge cases:
   * - Empty string or no matching cookies → all three fields are `undefined`
   * - Cookie present but with an empty value (e.g. `_cq_s=`) → field is `undefined`
   * - `_cq_se` (challenge session cookie) does NOT match `_cq_s` — prefix is exact
   * - Duplicate cookie names → first occurrence wins
   *
   * @param cookieHeader raw Cookie header value (e.g. `"_cq_duid=abc; _cq_s=xyz=="`)
   * @returns object with `duidCookie`, `pvidCookie`, `sCookie` — each `undefined` when absent
   */
  parseCookies(cookieHeader: string): { duidCookie?: string; pvidCookie?: string; sCookie?: string } {
    if (!cookieHeader) {
      return {};
    }

    // NOTE: does not normalize spaces around '=' (e.g. "name = value") — RFC 6265 forbids it so compliant servers won't send it
    const cookies = cookieHeader.split(";").map(c => c.trim());
    
    // duidCookie and pvidCookie are v4.0 cookies, sCookie is a v4.1 cookie
    return {
      duidCookie: this.getCookieValue(cookies, "_cq_duid="),
      pvidCookie: this.getCookieValue(cookies, "_cq_pvid="),
      sCookie:    this.getCookieValue(cookies, "_cq_s="),
    };
  }

  /**
   * Extracts a cookie value from a pre-split cookie array by exact prefix match.
   * The `nameWithEqualSign` parameter must include the trailing `=` (e.g. `"_cq_s="`),
   * which prevents false-positive matches on similarly-named cookies (e.g. `_cq_se`).
   *
   * Edge cases:
   * - Cookie not found → `undefined`
   * - Cookie present but with an empty value (e.g. `_cq_s=`) → `undefined` (falsy)
   * - Values containing `=` (e.g. base64 padding) → preserved intact via `substring`
   * - Duplicate names → first occurrence wins
   *
   * @param cookies pre-split and trimmed cookie tokens (e.g. from `cookieHeader.split(";").map(c => c.trim())`)
   * @param nameWithEqualSign cookie name including `=` (e.g. `"_cq_duid="`)
   * @returns the cookie value, or `undefined` when absent or empty
   */
  getCookieValue(cookies: string[], nameWithEqualSign: string): string | undefined {
    // NOTE: does not strip surrounding quotes from values (e.g. name="value") — our cookies never use quoted values
    return cookies.find(c => c.startsWith(nameWithEqualSign))?.substring(nameWithEqualSign.length) || undefined;
  }

  /**
   * Returns CHEQ cookie value
   * @param cookie
   */
  getCheqCookie(cookie: string) {
    return !cookie
        ? undefined
        : (
            cookie
            .split(';')
            .map(c => c.trim())
            .find(c => c.includes(RTIParams.CHEQ_COOKIE_NAME)) || ''
        ).substring(RTIParams.CHEQ_COOKIE_NAME.length + 1);
  }

  /**
   * Returns capitalized string and substrings
   * @param str
   * @param splitter
   */
  capitalize(str = '', splitter = ' ') {
    return str
        .split(splitter)
        .map(s => `${s.charAt(0).toUpperCase()}${s.substring(1)}`)
        .join(splitter);
  }

  /**
   * Returns header ignoring case
   * @param headers
   * @param name
   * @param defaultValue
   */
  getHeaderByName(headers: HeadersMap, name = '', defaultValue: string | number | undefined = undefined) {
    return headers[name.toLowerCase()] || headers[this.capitalize(name, '-')] || defaultValue;
  }

  /**
   * Parses a comma-separated string of integers into a number array.
   * Non-numeric entries and empty segments are silently skipped.
   * Returns undefined when the input is absent or yields no valid numbers.
   * @param val comma-separated string (e.g. "4,5,6")
   */
  static parseNumberList(val: string | undefined): number[] | undefined {
    if (!val) {
      return undefined;
    }
    const nums = val.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    return nums.length > 0 ? nums : undefined;
  }

  /**
   * Parses a comma-separated string into a string array.
   * Empty and whitespace-only segments are filtered out.
   * Returns undefined when the input is absent, blank, or yields no non-empty strings.
   * @param val comma-separated string (e.g. "/health,/ping")
   */
  static parseStringList(val: string | undefined): string[] | undefined {
    if (!val) {
      return undefined;
    }
    const items = val.split(',').map(s => s.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  /**
   * Accepts a challenge page's `original_url` only when it is a same-site absolute path, so the redirect after a
   * passed challenge stays on this site.
   *
   * It arrives as a query parameter, so any link can carry any value. Reflected into `Location` it would turn a
   * PASSED challenge into an open redirect: a strong phishing tool, since the victim really did just prove they are
   * human on the genuine site. Rejected:
   * - anything not starting with `/` (`https://evil.com`, `evil.com`, `javascript:...`)
   * - `//host` and `/\host`: browsers read both as protocol-relative and leave the site despite the leading slash
   * - any ASCII control character, anywhere. Browsers delete tab, LF and CR from a URL before parsing it, so
   *   `/<TAB>/evil.com` passes the two checks above yet resolves to `//evil.com` - off-site whenever `Location` is
   *   relative (CloudFront without a Host header). CR/LF would also split the `Location` header. Rejecting, rather
   *   than stripping, avoids re-checking the result; other control characters are invalid in a header anyway.
   *
   * The value must already be decoded: a still-encoded `%09` is literal text to the browser and harmless.
   *
   * @param raw the decoded `original_url` value
   * @returns `raw` when safe, otherwise `undefined` so the caller falls back to the current request path
   */
  static safeReturnPath(raw: string | null | undefined): string | undefined {
    // [\x00-\x1F\x7F]: the 33 ASCII control characters (NUL..US, plus DEL) - tab, LF and CR among them
    if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || /[\x00-\x1F\x7F]/.test(raw)) {
      return undefined;
    }
    return raw;
  }

  /**
   * Reduces a host to its bare lowercase name, so two ways of writing one host compare equal - e.g. a request's `Host`
   * header and the `hostname` a CAPTCHA provider reports for a solved token. Neither should carry more than
   * `host[:port]`, but a client sends any text it likes, so both sides go through this. It fails closed: a value with
   * no host left (only a scheme, a port, userinfo...) becomes `''`, which callers must treat as no host. Strips:
   * - the case, and surrounding whitespace
   * - a scheme: `https://shop.com` → `shop.com`
   * - anything from the first `/`, `?` or `#`: `shop.com/page` → `shop.com`
   * - userinfo, up to the last `@`: `user:pass@shop.com` → `shop.com`
   * - the port and anything after it: `shop.com:443` → `shop.com`. An IPv6 literal keeps its brackets and loses
   *   only what follows them: `[2001:db8::1]:8443` → `[2001:db8::1]`
   * - trailing dots (the DNS root): `shop.com.` → `shop.com`
   *
   * Idempotent: `normalizeHost(normalizeHost(x)) === normalizeHost(x)`. The result never contains `/ ? # @`, has no
   * `:` outside IPv6 brackets, and does not start or end with whitespace or end with a dot.
   *
   * @param value the raw host, or `null` / `undefined` when absent
   * @returns the bare host, `''` when nothing is left
   */
  static normalizeHost(value: string | null | undefined): string {
    let host = (value ?? '')
      .toLowerCase()
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/^.*@/, '')
      .replace(/^\s+/, '');

    if (host.startsWith('[') && host.includes(']')) {
      host = host.slice(0, host.indexOf(']') + 1);
    } else {
      host = host.replace(/:.*$/, '');
    }

    return host.replace(/[\s.]+$/, '');
  }

  /** Logged in place of a secret value (see {@link redactHeaderValue}). */
  static readonly REDACTED = '[REDACTED]';

  /** Headers whose whole value is a secret: the challenge session token (`x-cheq-challenge`) and credentials. */
  private static readonly SECRET_HEADERS = new Set(['x-cheq-challenge', 'authorization', 'proxy-authorization']);

  /**
   * The names of the cookies in one or more Cookie header values, for logging: `"_ga, _cq_duid, _cq_se"`. Debug logs
   * must never show a value: the site's own login and session cookies, or the challenge session token.
   *
   * Split at `;` only. A cookie without `=` is all value (browsers read it as a cookie with an empty name), so it shows
   * as {@link REDACTED}. Two Cookie headers joined with `", "` (as some header maps do) hide the second header's first
   * name inside the first value: that name is not shown, and neither is any value.
   *
   * @param cookieHeaders one Cookie header value, several (a client can split cookies over several headers), or the
   *   already split cookies
   */
  cookieNames(cookieHeaders: string | string[]): string {
    return [cookieHeaders].flat().join(';').split(';')
      .map(cookie => cookie.trim())
      .filter(Boolean)
      .map(cookie => cookie.includes('=') ? cookie.substring(0, cookie.indexOf('=')).trim() : RTIStatelessUtils.REDACTED)
      .join(', ');
  }

  /**
   * A header value as it may be logged: cookie names only for `cookie` ({@link cookieNames}), {@link REDACTED} for
   * `x-cheq-challenge`, `authorization` and `proxy-authorization`, any other header unchanged. The name is matched
   * case-insensitively: CDNs and header maps spell it differently.
   */
  redactHeaderValue(name: string, value: string): string {
    const lower = name.toLowerCase();
    if (lower === 'cookie') {
      return this.cookieNames(value);
    }
    return RTIStatelessUtils.SECRET_HEADERS.has(lower) ? RTIStatelessUtils.REDACTED : value;
  }

  /**
   * `JSON.stringify(payload)` for a debug log, with `endUserParams.headers` redacted ({@link redactHeaderValue}).
   * Only the log changes: `payload` is neither changed nor copied deeply, and the real one is still sent to RTI.
   * `duidCookie`, `pvidCookie` and `sCookie` are kept: they are CHEQ's own ids, needed to debug RTI.
   *
   * @param payload the RTI request about to be sent
   */
  stringifyRedactedPayload(payload: RTIRequest): string {
    const headers = payload.endUserParams?.headers;
    if (!headers) {
      return JSON.stringify(payload);
    }
    const redacted: RequestHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      redacted[name] = typeof value === 'string' ? this.redactHeaderValue(name, value) : value;
    }
    return JSON.stringify({ ...payload, endUserParams: { ...payload.endUserParams, headers: redacted } });
  }

  /**
   * Maximum length of the `rule-name` field. Rule names are operator-defined free text
   * with no length bound, and the whole header shares the CDN's header size budget.
   */
  private static readonly RULE_NAME_MAX_LENGTH = 128;

  /**
   * Makes a rule name safe to carry inside a `;`-delimited header value.
   *
   * `decision.ruleName` is operator-defined free text, so it can contain anything:
   * - CR/LF is a header-injection vector. Cloudflare's `Headers.set` throws on it, but
   *   Akamai's `setHeader` and CloudFront's header array do not - dropped here along
   *   with every other control and non-ASCII character.
   * - a literal `;` would split the field and desync any parser - mapped to `,`.
   * - unbounded length - truncated to {@link RULE_NAME_MAX_LENGTH}.
   *
   * `=` is deliberately left alone: `rule-name` is the last field, and parsers split on
   * `;` first and then on the FIRST `=`, so an embedded `=` stays inside the value.
   *
   * @param ruleName raw {@link Decision.ruleName}, which is `null` when no rule matched
   * @returns printable-ASCII, delimiter-free, length-capped text (`''` when absent)
   */
  private static sanitizeRuleName(ruleName: string | null): string {
    if (!ruleName) {
      return '';
    }
    return ruleName
      // [^\x20-\x7E]: anything outside printable ASCII (space to '~') - controls, DEL and all non-ASCII
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/;/g, ',')
      .substring(0, RTIStatelessUtils.RULE_NAME_MAX_LENGTH);
  }

  /**
   * Builds the `x-cheq-rti-result` header value from an RTI response.
   *
   * Format: `version=X;verdict=Y;threat-type-code=Z;ids={...}`
   * With `includeDebugData`: `...;ids={...};reasons=N,N,N;rule-name=S`
   *
   * @param rtiResponse the RTI response object
   * @param includeDebugData appends the detection reason codes and the name of the rule
   *   that produced the verdict. Off by default, so every caller that omits it gets a
   *   byte-for-byte unchanged header. Only the Akamai integration opts in, per request
   *   via the `PMUSER_CHEQ_RTI_DEBUG_DATA` property variable.
   */
  buildRtiResultHeader(rtiResponse: RTIResponse, includeDebugData = false): string {
    const parts = [
      `version=${rtiResponse.metadata.version}`,
      `verdict=${rtiResponse.decision.verdict}`,
      `threat-type-code=${rtiResponse.classification.code}`,
      `ids=${JSON.stringify(rtiResponse.ids)}`,
    ];

    if (includeDebugData) {
      parts.push(`reasons=${rtiResponse.cheqDetection.reasons.join(',')}`);
      parts.push(`rule-name=${RTIStatelessUtils.sanitizeRuleName(rtiResponse.decision.ruleName)}`);
    }

    return parts.join(';');
  }
}
