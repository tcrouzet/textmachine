export type Progress = (message: string, stream?: boolean, reset?: boolean, model?: string) => void;
export interface HttpOptions {url: string; method?: string; contentType?: string; headers?: Record<string,string>; body?: string; throw?: boolean}
export interface HttpResponse {status: number; text?: string; json?: unknown}
export type HttpRequest = (options: HttpOptions) => Promise<HttpResponse>;
export type StreamRequest = (options: HttpOptions, onChunk?: (chunk: string) => void, signal?: AbortSignal, maxResponseBytes?: number) => Promise<HttpResponse>;
export interface Connection {provider: 'openai' | 'anthropic' | 'codex'; apiKey: string; model: string; baseUrl?: string; effort?: string}
export interface Model {value: string; label: string; efforts?: string[]}
export type Translate = (key: string, parameters?: Record<string,string|number>) => string;
