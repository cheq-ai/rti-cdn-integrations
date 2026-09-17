// Akamai EdgeWorker built-in module type declarations.
// These modules are provided by the Akamai edge runtime — they are NOT npm packages
// and cannot be installed. Declarations here exist solely so TypeScript knows their
// shape at compile time. Rollup leaves their import statements as-is (see external
// in rollup.config.mjs) so they resolve correctly at runtime on the edge.

declare module 'http-request' {
    export interface HttpRequestOptions {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        timeout?: number;
    }

    export interface HttpResponse {
        status: number;
        ok: boolean;
        // Returns undefined (NOT an empty array) when the header is absent - never index unguarded.
        getHeader(name: string): string[] | undefined;
        getHeaders(): Record<string, string[]>;
        text(): Promise<string>;
        json(): Promise<unknown>;
    }

    export function httpRequest(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

declare module 'log' {
    // Akamai's built-in log module exports `logger` (not `log`).
    export const logger: {
        log(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}

declare module 'cookies' {
    export class Cookies {
        constructor(header: string[] | null | undefined, options?: object);
        get(name: string): string | undefined;
        toHeader(): string;
    }

    export class SetCookie {
        name: string;
        value: string;
        path?: string;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: string;
        maxAge?: number;
        constructor(header?: string);
        toHeader(): string;
    }
}

// Akamai EdgeWorker request object
interface EWRequest {
    host: string;
    path: string;
    url: string;
    method: string;
    scheme: string;
    clientIp: string;
    userLocation?: {
        region?: string;
        country?: string;
        city?: string;
        zipCode?: string;
        latitude?: string;
        longitude?: string;
        continent?: string;
        timezone?: string;
    };

    // Returns undefined (NOT an empty array) when the header is absent - never index unguarded.
    getHeader(name: string): string[] | undefined;
    getHeaders(): Record<string, string[]>;
    setHeader(name: string, value: string): void;
    addHeader(name: string, value: string): void;
    removeHeader(name: string): void;

    getVariable(name: string): string | undefined;
    setVariable(name: string, value: string): void;

    respondWith(status: number, headers: Record<string, string>, body: string): void;
}

// Akamai EdgeWorker response object
interface EWResponse {
    status: number;
    // Returns undefined (NOT an empty array) when the header is absent - never index unguarded.
    getHeader(name: string): string[] | undefined;
    setHeader(name: string, value: string): void;
    addHeader(name: string, value: string): void;
    removeHeader(name: string): void;
}

// Akamai exposes Web Crypto as a MODULE export, never as a global. Used bare, `crypto.subtle`
// still compiles - tsconfig includes the "dom" lib, so the compiler believes every browser
// global exists - and then throws ReferenceError on the edge. Declaring it here means the
// import is the only spelling that type-checks.
declare module 'crypto' {
    export const crypto: {
        subtle: {
            digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
        };
        getRandomValues<T extends ArrayBufferView>(array: T): T;
    };
}

// TextEncoder/TextDecoder are module exports too. Note this is the `encoding` module - 
// `text-encode-transform` provides only the TextEncoderStream/TextDecoderStream variants.
declare module 'encoding' {
    export class TextEncoder {
        encode(input?: string): Uint8Array;
    }
    export class TextDecoder {
        constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
        decode(input?: ArrayBufferView | ArrayBuffer): string;
    }
}

// Default export, not a named one: `import URLSearchParams from 'url-search-params'`.
declare module 'url-search-params' {
    export default class URLSearchParams {
        constructor(init?: string | Record<string, string> | string[][]);
        get(name: string): string | null;
        set(name: string, value: string): void;
        append(name: string, value: string): void;
        has(name: string): boolean;
        delete(name: string): void;
        toString(): string;
    }
}
