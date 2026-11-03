const { t, getLocale } = require('./i18n');
const http = require('node:http');
const { randomBytes, createHash } = require('node:crypto');

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';

function parseCredentials(text) {
    let data;
    try { data = JSON.parse(text)?.installed; } catch { data = null; }
    if (!data || typeof data.client_id !== 'string'
        || !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(data.client_id)
        || typeof data.client_secret !== 'string' || !data.client_secret.trim()) {
        throw new Error(t('desktopCredentials'));
    }
    return { clientId: data.client_id, clientSecret: data.client_secret };
}

async function googleRequest(request, options) {
    let response;
    try { response = await request({ ...options, throw: false }); }
    catch { throw new Error(t('googleUnreachable')); }
    if (response.status < 200 || response.status >= 300) {
        if (response.status === 401 || response.json?.error === 'invalid_grant') {
            const error = new Error(t('authorizationExpired'));
            error.code = 'AUTH_REQUIRED';
            throw error;
        }
        if (response.status === 403) {
            const insufficient = response.json?.error?.errors?.some(error => error.reason === 'insufficientPermissions')
                || response.json?.error?.details?.some(detail => detail.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
            const error = new Error(insufficient ? t('readPermissionMissing') : t('accessDenied'));
            if (insufficient) error.code = 'AUTH_REQUIRED';
            throw error;
        }
        if (response.status === 404) throw new Error(t('labelNotFound'));
        throw new Error(t('googleRequestFailed', { status: String(response.status) }));
    }
    return response.text === '' ? {} : response.json;
}

function tokenRequest(request, credentials, fields) {
    return googleRequest(request, {
        url: TOKEN_URL, method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: new URLSearchParams({
            client_id: credentials.clientId, client_secret: credentials.clientSecret, ...fields,
        }).toString(),
    });
}

async function authorize(credentials, request, openBrowser, signal, email = '') {
    const state = randomBytes(32).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let redirect;
    const code = await new Promise((resolve, reject) => {
        let finished = false;
        const finish = (error, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            server.close();
            if (error) reject(error); else resolve(value);
        };
        const abort = () => finish(new Error(t('connectionCancelled')));
        const server = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            let url;
            try { url = new URL(req.url, redirect); }
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
            finish(null, url.searchParams.get('code'));
        });
        const timer = setTimeout(() => finish(new Error(t('connectionExpired'))), 180_000);
        server.on('error', () => finish(new Error(t('callbackUnavailable'))));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        server.listen(0, '127.0.0.1', () => {
            if (finished) { server.close(); return; }
            redirect = `http://127.0.0.1:${server.address().port}/oauth/callback`;
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
    if (!tokens.refresh_token || !tokens.scope?.split(' ').includes(SCOPE)) {
        throw new Error(t('readPermissionMissing'));
    }
    return tokens;
}

class GmailClient {
    constructor(credentials, request, saveRefresh) {
        this.credentials = { ...credentials };
        this.request = request;
        this.saveRefresh = saveRefresh;
        this.accessToken = null;
        this.expiresAt = 0;
    }

    async setTokens(tokens) {
        if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token
            || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
            throw new Error(t('invalidTokenResponse'));
        }
        if (tokens.refresh_token) {
            await this.saveRefresh(tokens.refresh_token);
            this.credentials.refreshToken = tokens.refresh_token;
        }
        this.accessToken = tokens.access_token;
        this.expiresAt = Date.now() + tokens.expires_in * 1000 - 60_000;
    }

    async get(path, options = {}) {
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
            || result.labels.some(label => !label || typeof label.id !== 'string' || typeof label.name !== 'string')) {
            throw new Error(t('invalidLabels'));
        }
        return result.labels.sort((a, b) => a.name.localeCompare(b.name, getLocale()));
    }

    label(id) {
        if (typeof id !== 'string' || !id) throw new Error(t('selectGmailLabel'));
        return this.get('labels/' + encodeURIComponent(id));
    }

    async *unreadMessages(labelId) {
        if (!labelId) throw new Error(t('selectGmailLabel'));
        let pageToken = '';
        const pages = new Set();
        const ids = new Set();
        do {
            const query = new URLSearchParams({ labelIds: labelId, q: 'is:unread', maxResults: '500' });
            if (pageToken) query.set('pageToken', pageToken);
            const page = await this.get('messages?' + query);
            if (!page || (page.messages !== undefined && !Array.isArray(page.messages))) {
                throw new Error(t('invalidMessages'));
            }
            for (const message of page.messages || []) {
                if (typeof message?.id !== 'string' || !message.id) throw new Error(t('invalidMessage'));
                ids.add(message.id);
            }
            pageToken = page.nextPageToken || '';
            if (typeof pageToken !== 'string' || (pageToken && pages.has(pageToken))) {
                throw new Error(t('invalidPagination'));
            }
            pages.add(pageToken);
        } while (pageToken);
        // Snapshot IDs before removing UNREAD, so pagination cannot skip messages.
        yield* ids;
    }

    async message(id) {
        const message = await this.get('messages/' + encodeURIComponent(id) + '?format=full');
        if (message?.id !== id || !message.payload || !Array.isArray(message.labelIds)) {
            throw new Error(t('invalidMessageContent'));
        }
        const bodies = [];
        const visit = async part => {
            if (part.filename) return;
            if (['text/plain', 'text/html'].includes(part.mimeType)) {
                let body = part.body;
                if (body?.attachmentId) body = await this.get('messages/' + encodeURIComponent(id)
                    + '/attachments/' + encodeURIComponent(body.attachmentId));
                if (body?.data) {
                    const contentType = part.headers?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
                    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] || 'utf-8';
                    bodies.push({ type: part.mimeType, text: new TextDecoder(charset).decode(Buffer.from(body.data, 'base64url')) });
                }
            } else if (part.mimeType?.startsWith('multipart/')) {
                for (const child of part.parts || []) await visit(child);
            }
        };
        await visit(message.payload);
        return { ...message, bodies };
    }

    async markRead(id) {
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

module.exports = { SCOPE, parseCredentials, authorize, GmailClient };
