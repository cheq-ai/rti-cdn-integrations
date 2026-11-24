// cspell:ignore CHEQ adserver jsonp
import { ResolvedInterstitialSettings } from "../models/interstitial.model";
import { escapeHtml } from "./block-page-helpers";
import { CHEQ_LOGO, PAGE_FOOTER, PAGE_STYLE } from "./page-look";

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
 * The page's CSS, minified: {@link PAGE_STYLE}, which the block page shares, then the ring's and the button's. The ring
 * `#r` is gray: a darker part turns on a light track, and it stands still for prefers-reduced-motion.
 */
const STYLE = PAGE_STYLE
  + '#r{width:32px;height:32px;margin:24px auto;border:4px solid #e4e7eb;border-top-color:#7b8794;border-radius:50%;'
  + 'animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}'
  + '@media (prefers-reduced-motion:reduce){#r{animation:none}}button{font:inherit;margin-left:4px;cursor:pointer}';

/**
 * The interstitial page: our own HTML, answered at the URL the visitor asked for. It shows, in this order, the logo
 * ({@link CHEQ_LOGO} or the image of logoUrl), the ring, the headline, the message in a live region, the ray id of RTI
 * call 1 and the footer "Protected by Cheq.ai" ({@link PAGE_FOOTER}). The fail text and the cookie text are there and
 * hidden, for the script. Each setting and the ray id are HTML-escaped. The page ends with one `<script>` element:
 * {@link INTERSTITIAL_SCRIPT}, called with {@link scriptJson} of the values.
 * @param settings the checked settings
 * @param rayId the ray id of RTI call 1
 * @param values the values for the page's script, made for this request
 */
export function interstitialPage(settings: ResolvedInterstitialSettings, rayId: string, values: InterstitialScriptValues): string {
  const headline = escapeHtml(settings.headline);
  const logo = settings.logoUrl === undefined ? CHEQ_LOGO : `<img src="${escapeHtml(settings.logoUrl)}" alt="">`;
  return `<!DOCTYPE html><html lang="${escapeHtml(settings.lang)}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
    + `<title>${headline}</title><style>${STYLE}</style></head><body><main>${logo}`
    + '<div id="r" aria-hidden="true"></div>'
    + `<h1>${headline}</h1><div id="s" role="status" aria-live="polite">${escapeHtml(settings.message)}</div>`
    + '<p id="f" hidden>We could not check your browser. <button type="button">Try again</button></p>'
    + '<p id="k" hidden>Please allow cookies for this site, then reload the page.</p>'
    + '<noscript><p>Please turn on JavaScript, then reload the page.</p></noscript>'
    + `<small>Ray ID: ${escapeHtml(rayId)}</small>${PAGE_FOOTER}</main>`
    + `<script>${INTERSTITIAL_SCRIPT}(${scriptJson(values)})</script></body></html>`;
}
