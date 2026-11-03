export type AIProvider = 'anthropic' | 'openai';
export interface Settings {
    secretKey: string;
    labelId: string;
    outputFolder: string;
    excludedSources: string;
    aiModel: string;
    codexModel: string;
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
export type Progress = (message: string) => void;
export type Action = () => unknown | Promise<unknown>;
export function errorOf(value: unknown): Error & {code?: string} {
    if (value && typeof value === 'object' && 'message' in value) return value as Error & {code?: string};
    return new Error(String(value));
}
