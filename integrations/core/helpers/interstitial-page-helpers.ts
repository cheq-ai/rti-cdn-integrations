// cspell:ignore CHEQ adserver jsonp
import { ResolvedInterstitialSettings } from "../models/interstitial.model";
import { escapeHtml } from "./block-page-helpers";

/** The values the interstitial page hands its script, as one JSON object. They are made per request. */
export interface InterstitialScriptValues {
  /** The mark's cookie name: `_cq_it`. */
  markName: string;
  /** The signed value, `<setupId>|…`. The script reads the cookie back and looks for exactly this value. */
  markValue: string;
  /** This setup's id. The safety net looks only at a mark that starts with `<setupId>|`. */
  setupId: string;
  /** `; Path=/; SameSite=Lax`, plus `; Secure` on https. The script adds `Max-Age` and `Domain`. */
  cookieAttributes: string;
  /** How long the browser keeps the mark, in seconds: 60. */
  maxAgeSeconds: number;
  /** `"cookie"` mode only: the original Referer, for `_cq_ref`. */
  referer?: string;
  /** The tag line's attributes: ResolvedInterstitialSettings.tagAttributes. */
  tag: [string, string][];
  /** How long the page waits for the tag, in milliseconds, before it writes the mark and reloads anyway. */
  maxWaitMs: number;
}

/**
 * The page's script: the source of one function expression, `(function (c) { … })`, called with the values (`c`).
 * It is written in ES5 syntax, and it holds no `</` and no `<!--`, so it cannot end the page's `<script>` element.
 * It uses these elements of the page: `s` (the live region with the message), `r` (the ring), `f` (the fail text with
 * its button) and `k` (the cookie text). What it does, in order (the design, "The interstitial page"):
 * 1. The safety net: a mark of this setup is already there.
 * 2. It remembers each `_cq_pvid` value there is now.
 * 3. It starts the `maxWaitMs` deadline and the check every 50 ms.
 * 4. It adds the tag. A tag that fails to load, or a throw while it is added, finishes at once.
 * 5. `finish`, once: it writes the mark, and `_cq_ref` in `"cookie"` mode, and calls `location.reload()`.
 */
export const INTERSTITIAL_SCRIPT =
  '(function (c) {'
  + 'var d = document, done = false, domains = domainsOf(location.hostname), marks = read(c.markName), seen, timer, deadline, i;'
  + 'function el(id) { return d.getElementById(id); }'
  // The values of the cookies named `name` that this page sees. document.cookie is a list of name=value pairs with
  // ";" between them, and a pair may have spaces or tabs around it (MDN, "Document: cookie property", read on
  // 2026-11-23), so each pair is trimmed.
  + 'function read(name) {'
  + 'var all = d.cookie.split(";"), out = [], part, j;'
  + 'for (j = 0; j < all.length; j++) {'
  + 'part = all[j].trim();'
  + 'if (part.indexOf(name + "=") === 0) out.push(part.slice(name.length + 1));'
  + '}'
  + 'return out;'
  + '}'
  // The Domain parts to try for the mark: the host name's endings from two labels upward ("shop.com", then
  // "www.shop.com"). None for an IP address (only digits and dots, or a ":" or "[") or a host with one label.
  + 'function domainsOf(host) {'
  + 'var labels = host.split("."), out = [], j;'
  + 'if (/^[0-9.]+$|[:[]/.test(host)) return out;'
  + 'for (j = labels.length - 2; j >= 0; j--) out.push("; Domain=" + labels.slice(j).join("."));'
  + 'return out;'
  + '}'
  // Writes the mark with this Domain part ("" for the host only). True when the new value can be read back.
  + 'function write(domain) {'
  + 'd.cookie = c.markName + "=" + c.markValue + "; Max-Age=" + c.maxAgeSeconds + c.cookieAttributes + domain;'
  + 'return read(c.markName).indexOf(c.markValue) >= 0;'
  + '}'
  // Moves the text of element `id` into the live region, in place of the message, and shows it. The ring goes away.
  + 'function show(id) {'
  + 'var live = el("s"), text = el(id);'
  + 'el("r").hidden = true;'
  + 'live.textContent = "";'
  + 'live.appendChild(text);'
  + 'text.hidden = false;'
  + '}'
  // Once: the mark for the first domain whose value can be read back, else for the host only. Then _cq_ref in
  // "cookie" mode, for the same domain, and the reload. A mark that cannot be read back means cookies are blocked:
  // the page shows the cookie text and does not reload, because the reload would show this page again.
  + 'function finish() {'
  + 'var at = null, j;'
  + 'if (done) return;'
  + 'done = true;'
  + 'clearInterval(timer);'
  + 'clearTimeout(deadline);'
  + 'for (j = 0; j < domains.length && at === null; j++) if (write(domains[j])) at = domains[j];'
  + 'if (at === null && write("")) at = "";'
  + 'if (at === null) return show("k");'
  + 'if (c.referer) d.cookie = "_cq_ref=" + encodeURIComponent(location.pathname + location.search + location.hash) + "|"'
  + ' + encodeURIComponent(c.referer) + "; Max-Age=" + c.maxAgeSeconds + c.cookieAttributes + at;'
  + 'location.reload();'
  + '}'
  // 1. The safety net: a mark of this setup is already there, so the Worker did not accept it, and a reload would
  //    loop. The page stops and shows the fail text. Its button deletes the mark for the host and for each domain,
  //    because document.cookie gives names and values only, not the domain of a cookie (MDN, read on 2026-11-23).
  //    Then it reloads. A mark of another setup is ignored here. This page writes its own mark later, which replaces
  //    the other one only when both have the same domain (a host-only mark and a Domain mark are kept side by side).
  + 'for (i = 0; i < marks.length; i++) if (marks[i].indexOf(c.setupId + "|") === 0) {'
  + 'show("f");'
  + 'el("f").querySelector("button").onclick = function () {'
  + 'var all = [""].concat(domains), j;'
  + 'for (j = 0; j < all.length; j++) d.cookie = c.markName + "=; Max-Age=0" + c.cookieAttributes + all[j];'
  + 'location.reload();'
  + '};'
  + 'return;'
  + '}'
  // 2. Each _cq_pvid value there is now. The design says two can be there, when the tag once wrote the cookie for the
  //    main domain and once for the host. The page only reads the tag's cookies. It does not change or delete them.
  + 'seen = read("_cq_pvid");'
  // 3. The deadline: after maxWaitMs the page writes the mark and reloads anyway. Then the check every 50 ms.
  + 'deadline = setTimeout(finish, c.maxWaitMs);'
  // The check: a _cq_pvid value that was not there at the start means the tag is done. The tag writes a new value on
  // each run, it writes _cq_pvid only with its option ck4, and it calls its callback (data-jsonp) before it writes the
  // cookie, so the callback cannot say that the tag is done (all three read in adserver on 2026-11-17).
  // An idea that was not built: delete the old _cq_pvid when the page starts, and wait until a _cq_pvid exists. A
  // delete must name the exact domain the tag wrote the cookie for. A delete that misses leaves the old cookie, and
  // the page would reload before the tag ran. The compare needs none of that.
  + 'timer = setInterval(function () {'
  + 'var now = read("_cq_pvid"), j;'
  + 'for (j = 0; j < now.length; j++) if (seen.indexOf(now[j]) < 0) return finish();'
  + '}, 50);'
  // 4. The tag: a <script> element with the tag line's attributes, one by one, so that nothing in the line becomes
  //    markup or code of this page.
  + 'try {'
  + 'var tag = d.createElement("script");'
  + 'for (i = 0; i < c.tag.length; i++) tag.setAttribute(c.tag[i][0], c.tag[i][1]);'
  + 'tag.onerror = finish;'
  + 'd.head.appendChild(tag);'
  + '} catch (e) {'
  + 'finish();'
  + '}'
  + '})';

/** A backslash, built from its code. */
const BACKSLASH = String.fromCharCode(92);

/** `<`, U+2028 and U+2029. The two separators are built from their codes, so that this file does not hold them. */
const UNSAFE_IN_SCRIPT = new RegExp(`[<${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, "g");

/**
 * `JSON.stringify(value)`, with each `<`, U+2028 and U+2029 written as its escape (a backslash, `u` and four hex
 * digits). So a value cannot end the page's `<script>` element, and the script holds no raw U+2028 or U+2029.
 * `JSON.parse` gives back the same value.
 * @param value a value that JSON.stringify can write
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(UNSAFE_IN_SCRIPT,
    character => `${BACKSLASH}u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * CHEQ's logo: the inline SVG of the CAPTCHA page (`turnstile-challenge-example.ts` in the Cloudflare folder), so that
 * the two pages look alike, and the page needs no second request. `aria-hidden`: the logo says nothing that the page
 * does not say, as the `alt=""` of a logo from logoUrl.
 */
const CHEQ_LOGO = '<svg width="120" height="40" viewBox="0 0 120 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
  + '<path d="M20 8C12.268 8 6 14.268 6 22s6.268 14 14 14 14-6.268 14-14S27.732 8 20 8zm0 24c-5.523 0-10-4.477-10-10s4.477-10 10-10 10 4.477 10 10-4.477 10-10 10z" fill="#00D4AA"/>'
  + '<path d="M20 14c-4.418 0-8 3.582-8 8s3.582 8 8 8 8-3.582 8-8-3.582-8-8-8zm3.707 6.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-2-2a1 1 0 111.414-1.414L19 23.586l3.293-3.293a1 1 0 011.414 0z" fill="#00D4AA"/>'
  + '<text x="42" y="28" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700" fill="#00D4AA">CHEQ</text>'
  + '</svg>';

/** The page's CSS, minified. White background. The ring `#r` turns, and stands still for prefers-reduced-motion. */
const STYLE = 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fff;'
  + 'color:#1f2933;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center}'
  + 'main{max-width:440px;padding:24px}img{max-width:200px;max-height:60px}h1{font-size:24px;margin:24px 0 8px}'
  + '#r{width:32px;height:32px;margin:16px auto;border:4px solid #e4e7eb;border-top-color:#00d4aa;border-radius:50%;'
  + 'animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}'
  + '@media (prefers-reduced-motion:reduce){#r{animation:none}}button{font:inherit;margin-left:4px;cursor:pointer}'
  + 'small{display:block;margin-top:16px;color:#616e7c}';

/**
 * The interstitial page: our own HTML, answered at the URL the visitor asked for. It shows the logo, the headline, the
 * message in a live region, a ring, the ray id of RTI call 1 and "Protected by Cheq.ai". The fail text and the cookie
 * text are there and hidden, for the script. Each setting and the ray id are HTML-escaped. The page ends with one
 * `<script>` element: {@link INTERSTITIAL_SCRIPT}, called with {@link scriptJson} of the values.
 * @param settings the checked settings
 * @param rayId the ray id of RTI call 1
 * @param values the values for the page's script, made for this request
 */
export function interstitialPage(settings: ResolvedInterstitialSettings, rayId: string, values: InterstitialScriptValues): string {
  const headline = escapeHtml(settings.headline);
  const logo = settings.logoUrl === undefined ? CHEQ_LOGO : `<img src="${escapeHtml(settings.logoUrl)}" alt="">`;
  return `<!DOCTYPE html><html lang="${escapeHtml(settings.lang)}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
    + `<title>${headline}</title><style>${STYLE}</style></head><body><main>${logo}<h1>${headline}</h1>`
    + '<div id="r" aria-hidden="true"></div>'
    + `<div id="s" role="status" aria-live="polite">${escapeHtml(settings.message)}</div>`
    + '<p id="f" hidden>We could not check your browser. <button type="button">Try again</button></p>'
    + '<p id="k" hidden>Please allow cookies for this site, then reload the page.</p>'
    + '<noscript><p>Please turn on JavaScript, then reload the page.</p></noscript>'
    + `<small>Ray ID: ${escapeHtml(rayId)}</small><small>Protected by Cheq.ai</small></main>`
    + `<script>${INTERSTITIAL_SCRIPT}(${scriptJson(values)})</script></body></html>`;
}
