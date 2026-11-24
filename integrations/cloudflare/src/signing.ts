// The HMAC and the client binding that the Worker's signed cookies use. The Turnstile example imports them, and also
// exports sessionBindingKey and SessionBinding.

/** See {@link sessionBindingKey}. */
export interface SessionBinding {
    /** `"exact"`: the client's address. `"none"`: not bound to the IP. */
    ip: "exact" | "none";
    /** Bind to the exact User-Agent. */
    userAgent: boolean;
}

const encoder = new TextEncoder();

/**
 * HMAC-SHA256 of `message`, keyed with `secret`, as its first 32 lower-case hex characters: the value CloudFront gets
 * from createHmac("sha256", secret).update(message).digest("hex").slice(0, 32). The key is imported for each call and
 * not kept in module state.
 */
export async function hmacHex32(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
    return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** The client's address as Cloudflare reports it, or null (e.g. in a local run). */
export const clientIp = (request: Request): string | null => request.headers.get("cf-connecting-ip");

/**
 * What a session is bound to: the client's IP ({@link clientIp}, per `sessionBinding.ip`) and User-Agent
 * (`sessionBinding.userAgent`; several User-Agent headers arrive joined with ", "), as one unambiguous string for the HMAC
 * input (`JSON.stringify([ip, userAgent])`, "" for a part that is not bound). Without CF-Connecting-IP (a local run) the
 * IP part is null, so it never matches an IP or an unbound one. Recomputed from each request, never stored: the cookie
 * carries neither the IP nor the User-Agent.
 */
export function sessionBindingKey(settings: { sessionBinding: SessionBinding }, request: Request): string {
    const { ip, userAgent } = settings.sessionBinding;
    return JSON.stringify([sessionBindingIp(ip, clientIp(request)), userAgent ? request.headers.get("user-agent") ?? "" : ""]);
}

/**
 * The client IP as bound into the session. An IPv6 address in the URL parser's spelling (`2001:0DB8:0:0:0:0:0:1` →
 * `2001:db8::1`), so every spelling of an address is the same client; anything else as given. Three spellings differ
 * from CloudFront's. An IPv4-mapped or IPv4-compatible address is written in hex (`::ffff:102:304`, `::102:304`), and a
 * zone id is not removed (Cloudflare never sends one).
 */
function sessionBindingIp(mode: SessionBinding["ip"], ip: string | null): string | null {
    if (mode === "none") {
        return "";
    }
    // Only hex digits, ":" and "." can spell an IPv6 address. Nothing else is put into the URL that is parsed.
    if (ip && ip.includes(":") && /^[0-9a-f:.]+$/i.test(ip)) {
        try {
            return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
        } catch {
            // not an IPv6 address: bound as given
        }
    }
    return ip;
}
