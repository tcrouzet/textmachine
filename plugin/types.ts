import type {Setting, SettingDefinitionEmpty, SettingDefinitionRender} from 'obsidian';

export type AIProvider = 'anthropic' | 'openai';
export interface NewsletterSettings {
    labelId: string;
    outputFolder: string;
    excludedSources: string;
    newsletterLanguage: string;
    minimumSources: number;
    referenceSources: string;
    includeFeeds: string;
    authorFeeds: string;
    generateImages: boolean;
}
export interface NewsletterProfile extends NewsletterSettings {
    id: string;
    name: string;
    prompts?: Record<string,string>;
}
export interface Settings extends NewsletterSettings {
    secretKey: string;
    debug: boolean;
    activeNewsletter: string;
    newsletters: NewsletterProfile[];
    aiModel: string;
    codexModel: string;
    codexEffort: string;
    localAIServer: string;
    localAIModel: string;
    anthropicSecretId?: string;
    openaiSecretId?: string;
}
export interface Account {
    clientId: string;
    scope?: string;
    refreshToken?: string;
    email: string;
}
export interface Label {id: string; name: string}
export type Progress = (message: string, stream?: boolean, reset?: boolean, model?: string) => void;
export type Action = () => unknown;
export function errorOf(value: unknown): Error & {code?: string} {
    if (value instanceof Error) return value;
    const data = record(value);
    return Object.assign(new Error(typeof data.message === 'string' ? data.message : String(value)),
        typeof data.code === 'string' ? {code:data.code} : {});
}

export function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

export interface HttpOptions {url: string; method?: string; contentType?: string; headers?: Record<string,string>; body?: string; throw?: boolean}
export interface HttpResponse {status: number; text?: string; json?: unknown}
export type HttpRequest = (options: HttpOptions) => Promise<HttpResponse>;
export type StreamRequest = (options: HttpOptions, onChunk?: (chunk: string) => void, signal?: AbortSignal, maxResponseBytes?: number) => Promise<HttpResponse>;
export interface Connection {provider: 'openai' | 'anthropic' | 'codex'; apiKey: string; model: string; baseUrl?: string; effort?: string}
export interface Model {value: string; label: string; efforts?: string[]}
export interface FeedEntry {title: string; url: string; publish: string; content: string; html?: string; authors?: string[]}
export interface Message {payload: {headers?: {name: string; value: string}[]}; bodies: {type: string; text: string}[]; internalDate?: string; labelIds: string[]}
export interface Database {version: number; nextId?: number; articles: Article[]; [key: string]: unknown}

export interface Article {
    id: number;
    date: string;
    title: string;
    url: string;
    source: string;
    authors?: string[];
    status: string;
    usedAt?: string;
    publish: string;
    content: string;
    image: string;
    imageCaption?: string;
}
export type SettingRow = SettingDefinitionEmpty | (Omit<SettingDefinitionRender,'render'> & {render: (setting: Setting)=>void});
export interface SettingsGroup {type: 'group'; heading: string; cls: string; items: SettingRow[]}
