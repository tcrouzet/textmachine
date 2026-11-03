require('../../plugin/i18n').setLocale('fr');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const http = require('node:http');
const { SCOPE, parseCredentials, authorize, GmailClient } = require('../../plugin/gmail');

const credentials = { clientId: '123-example.apps.googleusercontent.com', clientSecret: 'test-secret' };
const ok = json => ({ status: 200, json });
const tokens = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, scope: SCOPE };

test('accepts only desktop credentials and ignores supplied endpoints', () => {
    assert.deepEqual(parseCredentials(JSON.stringify({ installed: {
        client_id: credentials.clientId, client_secret: credentials.clientSecret, token_uri: 'https://untrusted.example',
    } })), credentials);
    for (const input of ['invalid', '{}', 'null', '{"web":{}}', '{"installed":{"client_id":"evil"}}']) {
        assert.throws(() => parseCredentials(input), /Application de bureau/);
    }
});

test('OAuth binds to loopback, validates state and exchanges a PKCE code', async () => {
    let authorization;
    let callback;
    const request = async options => {
        assert.equal(options.url, 'https://oauth2.googleapis.com/token');
        const body = new URLSearchParams(options.body);
        assert.equal(body.get('code'), 'test-code');
        assert.equal(body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
        assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),
            authorization.searchParams.get('code_challenge'));
        return ok(tokens);
    };
    const result = await authorize(credentials, request, async address => {
        authorization = new URL(address);
        assert.equal(authorization.origin, 'https://accounts.google.com');
        assert.equal(authorization.searchParams.get('scope'), SCOPE);
        assert.equal(authorization.searchParams.get('login_hint'), 'reader+news@example.com');
        assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
        callback = new URL(authorization.searchParams.get('redirect_uri'));
        assert.equal(callback.hostname, '127.0.0.1');
        const malformed = await new Promise((resolve, reject) => {
            http.get({ hostname: callback.hostname, port: callback.port, path: '//[' }, response => {
                response.resume();
                resolve(response.statusCode);
            }).on('error', reject);
        });
        assert.equal(malformed, 400);
        callback.search = new URLSearchParams({ code: 'test-code', state: 'wrong' });
        assert.equal((await fetch(callback)).status, 400);
        callback.searchParams.set('state', authorization.searchParams.get('state'));
        assert.equal((await fetch(callback)).status, 200);
    }, undefined, 'reader+news@example.com');
    assert.equal(result.refresh_token, 'test-refresh');
    await assert.rejects(fetch(callback));
});

test('refusal, cancellation and browser failure never exchange a code', async () => {
    const request = async () => assert.fail('No token request expected');
    await assert.rejects(authorize(credentials, request, async address => {
        const authorization = new URL(address);
        const callback = new URL(authorization.searchParams.get('redirect_uri'));
        callback.search = new URLSearchParams({ error: 'access_denied', state: authorization.searchParams.get('state') });
        await fetch(callback);
    }), /refusée/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(authorize(credentials, request, () => assert.fail(), controller.signal), /annulée/);
    await assert.rejects(authorize(credentials, request, () => { throw new Error('Browser'); }), /navigateur/);
});

test('rejects a consent without Gmail read scope', async () => {
    await assert.rejects(authorize(credentials, async () => ok({ ...tokens, scope: 'openid' }), async address => {
        const auth = new URL(address);
        const callback = new URL(auth.searchParams.get('redirect_uri'));
        callback.search = new URLSearchParams({ code: 'test', state: auth.searchParams.get('state') });
        await fetch(callback);
    }), /autorisez la modification/);
});

test('refreshes once, sorts labels, addresses selected label by exact ID', async () => {
    const calls = [];
    const saved = [];
    const client = new GmailClient({ ...credentials, refreshToken: 'old-refresh' }, async options => {
        calls.push(options);
        if (options.url.endsWith('/token')) return ok(tokens);
        if (options.url.endsWith('/labels')) return ok({ labels: [
            { id: 'b', name: 'Zulu' }, { id: 'a', name: 'Actualités' },
        ] });
        return ok({ id: 'Label_42', name: 'Newsletter', messagesTotal: 3 });
    }, token => saved.push(token));
    assert.deepEqual((await client.labels()).map(label => label.id), ['a', 'b']);
    assert.equal((await client.label('Label_42')).messagesTotal, 3);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].url, 'https://gmail.googleapis.com/gmail/v1/users/me/labels/Label_42');
    assert.equal(calls[2].headers.Authorization, 'Bearer test-access');
    assert.deepEqual(saved, ['test-refresh']);
    assert.throws(() => client.label(''), /Sélectionnez/);
    client.expiresAt = 0;
    await client.label('Label_42');
    assert.equal(calls.filter(call => call.url.endsWith('/token')).length, 2);
});

test('does not disguise revoked permissions or missing labels, and never exposes tokens in errors', async () => {
    for (const [status, error, expected] of [
        [400, 'invalid_grant', /Reconnectez/], [401, '', /Reconnectez/],
        [403, '', /Accès refusé/], [404, '', /Libellé introuvable/], [500, '', /HTTP 500/],
    ]) {
        const client = new GmailClient(credentials, async () => ({ status, json: { error, access_token: 'private-value' } }), () => {});
        await client.setTokens(tokens);
        await assert.rejects(client.labels(), err => {
            assert.match(err.message, expected);
            assert.ok(!err.message.includes('private-value'));
            return true;
        });
    }
});

test('rejects invalid token and label responses', async () => {
    const client = new GmailClient(credentials, async () => ok({ labels: [{ id: 'a' }] }), () => {});
    await assert.rejects(client.setTokens({ access_token: '', expires_in: 3600 }), /invalide/);
    await client.setTokens(tokens);
    await assert.rejects(client.labels(), /invalide/);
});

test('disconnect revokes at Google and removes the in-memory session', async () => {
    const client = new GmailClient({ ...credentials, refreshToken: 'test-refresh' }, async options => {
        assert.equal(options.url, 'https://oauth2.googleapis.com/revoke');
        assert.equal(new URLSearchParams(options.body).get('token'), 'test-refresh');
        return { status: 200, text: '' };
    }, () => {});
    await client.disconnect();
    assert.equal(client.credentials.refreshToken, '');
    await assert.rejects(client.labels(), /Connectez Gmail/);
});

test('unread listing paginates within the chosen label and accepts empty mailboxes', async () => {
    const client = new GmailClient(credentials, () => {}, () => {});
    let pages = 0;
    client.get = async path => {
        const url = new URL(path, 'https://example.com/');
        assert.equal(url.pathname, '/messages');
        assert.equal(url.searchParams.get('q'), 'is:unread');
        assert.equal(url.searchParams.get('labelIds'), 'Label_1');
        if (++pages === 1) return {messages: [{id: 'a'}], nextPageToken: 'next'};
        assert.equal(url.searchParams.get('pageToken'), 'next');
        return {messages: [{id: 'b'}]};
    };
    const ids = [];
    for await (const id of client.unreadMessages('Label_1')) ids.push(id);
    assert.deepEqual(ids, ['a', 'b']);
    client.get = async () => ({});
    for await (const id of client.unreadMessages('Label_1')) assert.fail(id);
    client.get = async () => ({nextPageToken: 'loop'});
    await assert.rejects(async () => { for await (const id of client.unreadMessages('Label_1')) assert.fail(id); }, /Pagination/);
});

test('decodes nested MIME bodies and external text bodies, ignores file attachments', async () => {
    const client = new GmailClient(credentials, () => {}, () => {});
    const encode = text => Buffer.from(text).toString('base64url');
    client.get = async path => {
        if (path === 'messages/a/attachments/body') return {data: encode('<a href="https://example.com">Article</a>')};
        assert.equal(path, 'messages/a?format=full');
        return {id: 'a', labelIds: ['UNREAD', 'Label_1'], payload: {mimeType: 'multipart/mixed', parts: [
            {mimeType: 'multipart/alternative', parts: [
                {mimeType: 'text/plain', body: {data: encode('été https://example.com')}},
                {mimeType: 'text/html', body: {attachmentId: 'body'}},
            ]},
            {filename: 'attachment.txt', mimeType: 'text/plain', body: {attachmentId: 'skip'}},
        ]}};
    };
    const result = await client.message('a');
    assert.equal(result.bodies.length, 2);
    assert.equal(result.bodies[0].text, 'été https://example.com');
    assert.match(result.bodies[1].text, /<a href/);
    client.get = async () => ({id:'wrong'});
    await assert.rejects(client.message('a'), /invalide/);
});

test('marks only the selected message read, refreshing credentials before POST', async () => {
    const client = new GmailClient({...credentials,refreshToken:'old-refresh'}, async options => {
        if (options.url.endsWith('/token')) return ok(tokens);
        assert.equal(options.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/mail%2F1/modify');
        assert.equal(options.method, 'POST');
        assert.equal(options.contentType, 'application/json');
        assert.deepEqual(JSON.parse(options.body), {removeLabelIds:['UNREAD']});
        assert.equal(options.headers.Authorization, 'Bearer test-access');
        return ok({id:'mail/1',labelIds:['INBOX','Label_1']});
    }, () => {});
    await client.markRead('mail/1');
    client.get = async () => ({id:'mail/1',labelIds:['UNREAD']});
    await assert.rejects(client.markRead('mail/1'), /marquage/);
});

test('collects all unread pages before any message can be marked read', async () => {
    const client = new GmailClient(credentials, () => {}, () => {});
    let pages = 0;
    client.get = async () => ++pages === 1
        ? {messages:[{id:'a'}],nextPageToken:'next'} : {messages:[{id:'b'}]};
    const ids = [];
    for await (const id of client.unreadMessages('Label_1')) {
        assert.equal(pages, 2);
        ids.push(id);
    }
    assert.deepEqual(ids, ['a','b']);
});

test('insufficient Gmail modification scope requests reconnection', async () => {
    const client = new GmailClient({refreshToken:'fixture'}, async () => ({status:403,json:{error:{errors:[{reason:'insufficientPermissions'}]}}}));
    client.accessToken = 'fixture';
    client.expiresAt = Date.now() + 60000;
    await assert.rejects(client.markRead('message-1'), error => error.code === 'AUTH_REQUIRED');
});
