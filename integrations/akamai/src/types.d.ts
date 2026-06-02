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
        getHeader(name: string): string[];
        getHeaders(): Record<string, string[]>;
        text(): Promise<string>;
        json(): Promise<unknown>;
    }

    export function httpRequest(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

declare module 'log' {
    export const log: {
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

    getHeader(name: string): string[];
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
    getHeader(name: string): string[];
    setHeader(name: string, value: string): void;
    addHeader(name: string, value: string): void;
    removeHeader(name: string): void;
}
