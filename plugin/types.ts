export {record,array,errorOf} from './obsidian-toolbox/src/common';
export type {Connection,Model,HttpOptions,HttpResponse,StreamRequest,HttpRequest,Progress} from './obsidian-toolbox/src/ai/contracts';
import type {Setting, SettingDefinitionEmpty, SettingDefinitionRender} from 'obsidian';

export type AIProvider = 'anthropic' | 'openai';
export interface NewsletterSettings {
    labelId: string;
    outputFolder: string;
    excludedSources: string;
    newsletterLanguage: string;
    commentedArticles: number;
    referenceSources: string;
    includeFeeds: string;
    authorFeeds: string;
    imageMode: 'none' | 'extracted' | 'generated';
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
export type Action = () => unknown;
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
