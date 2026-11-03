const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

async function fixture(initialSecrets = {}) {
    const secrets = new Map(Object.entries(initialSecrets));
    class Plugin {
        async loadData() { return this.savedSettings || {secretKey:'test',labelId:'Label_1'}; }
        async saveData(settings) { this.savedSettings = {...settings}; }
        addSettingTab() {}
        registerEvent() {}
    }
    let secret = JSON.stringify({email:'reader@example.com',clientId:'123-test.apps.googleusercontent.com',refreshToken:'old',scope:'https://www.googleapis.com/auth/gmail.readonly'});
    const obsidian = {addIcon:()=>{},Plugin,PluginSettingTab:class {},Modal:class {},Notice:class {},getLanguage:()=> 'en'};
    const context = {module:{exports:{}},AbortController,require:name=> name==='obsidian' ? obsidian : name==='electron' ? {shell:{}} : name==='@electron/remote' ? {BrowserWindow:class {}} : require(name)};
    vm.runInNewContext(require('esbuild').buildSync({entryPoints:[path.join(root,'plugin/main.ts')],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian','electron','@electron/remote'],loader:{'.dat':'text','.svg':'text'}}).outputFiles[0].text,context);
    const p = new context.module.exports.default();
    p.manifest = {dir:'.'};
    p.app = {workspace:{on:()=>({})},vault:{adapter:{getBasePath:()=>root,read:async()=>JSON.stringify({installed:{client_id:'123-test.apps.googleusercontent.com',client_secret:'fixture'}})}},secretStorage:{getSecret:key=>key === 'test' ? secret : secrets.get(key),setSecret:(key,value)=>{if (key === 'test') secret=value; else secrets.set(key,value);}}};
    await p.onload();
    const original = p.gmail;
    const profile = {emailAddress:'reader@example.com'};
    const responses = async options => ({status:200,json:options.url.endsWith('/profile') ? profile : {labels:[{id:'Label_1',name:'Newsletter'}]}});
    p.gmail = {...original,authorize:async()=>({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,scope:original.SCOPE}),GmailClient:class extends original.GmailClient {
        constructor(credentials,request,save) {super(credentials,responses,save);}
    }};
    p.client.request = responses;
    return {p,profile,stored:()=>JSON.parse(secret)};
}

test('reconnection preserves the selected label and installs the new grant and client', async () => {
    const {p,stored} = await fixture();
    const previous = p.client;
    await p.connect();
    assert.equal(p.settings.labelId,'Label_1');
    assert.notEqual(p.client,previous);
    assert.equal(p.client.credentials.refreshToken,'new-refresh');
    assert.equal(stored().scope,'https://www.googleapis.com/auth/gmail.modify');
    assert.equal(stored().email,'reader@example.com');
});

test('failed profile validation leaves the previous session and label intact', async () => {
    const {p,profile,stored} = await fixture();
    const previous = p.client;
    delete profile.emailAddress;
    await assert.rejects(p.connect());
    assert.equal(p.client,previous);
    assert.equal(p.settings.labelId,'Label_1');
    assert.equal(stored().refreshToken,'old');
});

test('switching accounts clears a label belonging to the previous account', async () => {
    const {p,profile} = await fixture();
    profile.emailAddress = 'other@example.com';
    await p.connect();
    assert.equal(p.settings.labelId,'');
});

test('reload discards a cached readonly Gmail module and restores the saved grant', async () => {
    require('../../plugin/gmail').SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
    const {p} = await fixture();
    assert.equal(p.gmail.SCOPE,'https://www.googleapis.com/auth/gmail.modify');
    await p.connect();
    await p.onload();
    assert.equal(p.account.scope,'https://www.googleapis.com/auth/gmail.modify');
    assert.equal(p.client.credentials.refreshToken,'new-refresh');
    assert.equal(typeof p.client.markRead,'function');
    assert.equal(p.settings.labelId,'Label_1');
});

test('native secret references reuse existing keys and never copy values into settings', async () => {
    const {p} = await fixture({'test-ai-anthropic':'legacy-fixture-key','shared-anthropic':'shared-fixture-key','shared-openai':'openai-fixture-key'});
    assert.equal(p.settings.anthropicSecretId, 'test-ai-anthropic');
    assert.equal(p.getAIKey('anthropic'), 'legacy-fixture-key');
    await p.setAISecret('anthropic','shared-anthropic');
    await p.setAISecret('openai','shared-openai');
    await p.onload();
    assert.equal(p.getAIKey('anthropic'), 'shared-fixture-key');
    assert.equal(p.getAIKey('openai'), 'openai-fixture-key');
    assert.equal(JSON.stringify(p.savedSettings).includes('fixture-key'), false);
    await p.setAISecret('anthropic', null);
    assert.equal(p.getAIKey('anthropic'), '');
    assert.equal(p.getAIKey('openai'), 'openai-fixture-key');
});
