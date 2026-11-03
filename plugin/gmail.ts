import { t, getLocale } from './i18n';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import {HttpOptions, HttpRequest, Label, Message, array, record} from './types';

interface Credentials {clientId: string; clientSecret: string; refreshToken?: string}

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';

function parseCredentials(text: string) {
    let data: Record<string,unknown>;
    try { data = record(record(JSON.parse(text)).installed); } catch { data = {}; }
    if (!data || typeof data.client_id !== 'string'
        || !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(data.client_id)
        || typeof data.client_secret !== 'string' || !data.client_secret.trim()) {
        throw new Error(t('desktopCredentials'));
    }
    return { clientId: data.client_id, clientSecret: data.client_secret };
}

async function googleRequest(request: HttpRequest, options: HttpOptions) {
    let response;
    try { response = await request({ ...options, throw: false }); }
    catch { throw new Error(t('googleUnreachable')); }
    if (response.status < 200 || response.status >= 300) {
        const data=record(response.json);
        if (response.status === 401 || data.error === 'invalid_grant') {
            const error = Object.assign(new Error(t('authorizationExpired')),{code:'AUTH_REQUIRED'});
            throw error;
        }
        if (response.status === 403) {
            const details=record(data.error);
            const insufficient = array(details.errors).some(error => record(error).reason === 'insufficientPermissions')
                || array(details.details).some(detail => record(detail).reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
            const error: Error & {code?: string} = new Error(insufficient ? t('readPermissionMissing') : t('accessDenied'));
            if (insufficient) error.code = 'AUTH_REQUIRED';
            throw error;
        }
        if (response.status === 404) throw new Error(t('labelNotFound'));
        throw new Error(t('googleRequestFailed', { status: String(response.status) }));
    }
    return response.text === '' ? {} : record(response.json);
}

function tokenRequest(request: HttpRequest, credentials: Credentials, fields: Record<string,string>) {
    return googleRequest(request, {
        url: TOKEN_URL, method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: new URLSearchParams({
            client_id: credentials.clientId, client_secret: credentials.clientSecret, ...fields,
        }).toString(),
    });
}

async function authorize(credentials: Credentials, request: HttpRequest, openBrowser: (url: string)=>unknown, signal?: AbortSignal, email = '') {
    const state = randomBytes(32).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let redirect = '';
    const code = await new Promise<string>((resolve, reject) => {
        let finished = false;
        const finish = (error: Error | null, value = '') => {
            if (finished) return;
            finished = true;
            window.clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            server.close();
            if (error) reject(error); else resolve(value);
        };
        const abort = () => finish(new Error(t('connectionCancelled')));
        const server = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            let url;
            try { url = new URL(req.url || '', redirect); }
            catch { res.writeHead(400).end(t('invalidAddress')); return; }
            if (req.method !== 'GET' || url.pathname !== '/oauth/callback'
                || url.searchParams.get('state') !== state) {
                res.writeHead(400).end(t('invalidOAuthResponse'));
                return;
            }
            if (url.searchParams.has('error') || !url.searchParams.get('code')) {
                res.end(t('authorizationDeniedBrowser'));
                finish(new Error(t('authorizationDenied')));
                return;
            }
            res.end(t('authorizationReceived'));
            finish(null, url.searchParams.get('code') || '');
        });
        const timer = window.setTimeout(() => finish(new Error(t('connectionExpired'))), 180_000);
        server.on('error', () => finish(new Error(t('callbackUnavailable'))));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        server.listen(0, '127.0.0.1', () => {
            if (finished) { server.close(); return; }
            const address = server.address();
            if (!address || typeof address==='string') {finish(new Error(t('callbackUnavailable')));return;}
            redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
            const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            url.search = new URLSearchParams({
                client_id: credentials.clientId, redirect_uri: redirect,
                response_type: 'code', scope: SCOPE, access_type: 'offline',
                prompt: 'consent', state,
                code_challenge: challenge, code_challenge_method: 'S256',
            }).toString();
            if (email) url.searchParams.set('login_hint', email);
            Promise.resolve().then(() => openBrowser(url.toString()))
                .catch(() => finish(new Error(t('browserUnavailable'))));
        });
    });
    if (signal?.aborted) throw new Error(t('connectionCancelled'));
    const tokens = await tokenRequest(request, credentials, {
        code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code',
    });
    if (typeof tokens.refresh_token!=='string' || !tokens.refresh_token || typeof tokens.scope!=='string' || !tokens.scope.split(' ').includes(SCOPE)) {
        throw new Error(t('readPermissionMissing'));
    }
    return {...tokens,scope:tokens.scope};
}

class GmailClient {
    credentials: Credentials;
    request: HttpRequest;
    saveRefresh: (token: string)=>Promise<void>;
    accessToken: string | null;
    expiresAt: number;
    constructor(credentials: Credentials, request: HttpRequest, saveRefresh: (token: string)=>Promise<void>) {
        this.credentials = { ...credentials };
        this.request = request;
        this.saveRefresh = saveRefresh;
        this.accessToken = null;
        this.expiresAt = 0;
    }

    async setTokens(value: unknown) {
        const tokens=record(value);
        if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token
            || typeof tokens.expires_in!=='number' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0
            || (tokens.refresh_token!==undefined && typeof tokens.refresh_token!=='string')) {
            throw new Error(t('invalidTokenResponse'));
        }
        if (tokens.refresh_token) {
            await this.saveRefresh(tokens.refresh_token);
            this.credentials.refreshToken = tokens.refresh_token;
        }
        this.accessToken = tokens.access_token;
        this.expiresAt = Date.now() + tokens.expires_in * 1000 - 60_000;
    }

    async get(path: string, options: Partial<HttpOptions> = {}) {
        if (!this.accessToken || Date.now() >= this.expiresAt) {
            if (!this.credentials.refreshToken) throw new Error(t('connectToContinue'));
            await this.setTokens(await tokenRequest(this.request, this.credentials, {
                grant_type: 'refresh_token', refresh_token: this.credentials.refreshToken,
            }));
        }
        return googleRequest(this.request, {
            url: API + path, method: 'GET', ...options, headers: { Authorization: `Bearer ${this.accessToken}` },
        });
    }

    async labels() {
        const result = await this.get('labels');
        if (!Array.isArray(result?.labels)
            || result.labels.some((value: unknown) => {const label=record(value);return typeof label.id !== 'string' || typeof label.name !== 'string';})) {
            throw new Error(t('invalidLabels'));
        }
        return (result.labels as Label[]).sort((a, b) => a.name.localeCompare(b.name, getLocale()));
    }

    label(id: string) {
        if (typeof id !== 'string' || !id) throw new Error(t('selectGmailLabel'));
        return this.get('labels/' + encodeURIComponent(id)).then(label=>{
            if (typeof label.id!=='string' || typeof label.name!=='string' || (label.messagesTotal!==undefined && typeof label.messagesTotal!=='number')) throw new Error(t('invalidLabels'));
            return {id:label.id,name:label.name,messagesTotal:label.messagesTotal};
        });
    }

    async *unreadMessages(labelId: string) {
        if (!labelId) throw new Error(t('selectGmailLabel'));
        let pageToken = '';
        const pages = new Set<string>();
        const ids = new Set<string>();
        do {
            const query = new URLSearchParams({ labelIds: labelId, q: 'is:unread', maxResults: '500' });
            if (pageToken) query.set('pageToken', pageToken);
            const page = await this.get('messages?' + query);
            if (!page || (page.messages !== undefined && !Array.isArray(page.messages))) {
                throw new Error(t('invalidMessages'));
            }
            for (const value of array(page.messages)) {
                const message=record(value);
                if (typeof message?.id !== 'string' || !message.id) throw new Error(t('invalidMessage'));
                ids.add(message.id);
            }
            const next = page.nextPageToken || '';
            if (typeof next !== 'string' || (next && pages.has(next))) {
                throw new Error(t('invalidPagination'));
            }
            pageToken = next;
            pages.add(pageToken);
        } while (pageToken);
        // Snapshot IDs before removing UNREAD, so pagination cannot skip messages.
        yield* ids;
    }

    async message(id: string): Promise<Message> {
        const message = await this.get('messages/' + encodeURIComponent(id) + '?format=full');
        if (message.id !== id || !message.payload || !Array.isArray(message.labelIds) || message.labelIds.some((id: unknown)=>typeof id!=='string')) {
            throw new Error(t('invalidMessageContent'));
        }
        const bodies: Message['bodies'] = [];
        const headers = (value: unknown): {name: string; value: string}[] => {
            if (value===undefined) return [];
            if (!Array.isArray(value) || value.some((item: unknown)=>{const h=record(item);return typeof h.name!=='string' || typeof h.value!=='string';})) throw new Error(t('invalidMessageContent'));
            return value as {name: string; value: string}[];
        };
        const visit = async (value: unknown): Promise<void> => {
            const part=record(value);
            if (part.filename) return;
            if (typeof part.mimeType==='string' && ['text/plain', 'text/html'].includes(part.mimeType)) {
                let body = record(part.body);
                if (typeof body.attachmentId==='string' && body.attachmentId) body = await this.get('messages/' + encodeURIComponent(id)
                    + '/attachments/' + encodeURIComponent(body.attachmentId));
                if (typeof body.data==='string' && body.data) {
                    const contentType = headers(part.headers).find(h => h.name.toLowerCase() === 'content-type')?.value || '';
                    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] || 'utf-8';
                    bodies.push({ type: part.mimeType, text: new TextDecoder(charset).decode(Buffer.from(body.data, 'base64url')) });
                }
            } else if (typeof part.mimeType==='string' && part.mimeType.startsWith('multipart/')) {
                for (const child of array(part.parts)) await visit(child);
            }
        };
        await visit(message.payload);
        return { ...message, bodies, labelIds:message.labelIds as string[],internalDate:typeof message.internalDate==='string' ? message.internalDate : '',payload:{...record(message.payload),headers:headers(record(message.payload).headers)} };
    }

    async markRead(id: string) {
        if (typeof id !== 'string' || !id) throw new Error(t('invalidMessage'));
        const result = await this.get('messages/' + encodeURIComponent(id) + '/modify', {
            method: 'POST', contentType: 'application/json', body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
        });
        if (result?.id !== id || !Array.isArray(result.labelIds) || result.labelIds.includes('UNREAD')) {
            throw new Error(t('markReadFailed'));
        }
    }

    async disconnect() {
        if (this.credentials.refreshToken) {
            await googleRequest(this.request, {
                url: 'https://oauth2.googleapis.com/revoke', method: 'POST',
                contentType: 'application/x-www-form-urlencoded',
                body: new URLSearchParams({ token: this.credentials.refreshToken }).toString(),
            });
        }
        this.accessToken = null;
        this.credentials.refreshToken = '';
    }
}

export { SCOPE, parseCredentials, authorize, GmailClient };
