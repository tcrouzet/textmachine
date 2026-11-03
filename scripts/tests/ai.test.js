const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
require('../../plugin/i18n').setLocale('en');
const {defaults, models, CODEX_MODEL, getConnection} = require('../../plugin/ai/config');
const {listModels} = require('../../plugin/ai/codex');

const settings = values => ({...defaults,...values});
test('same model catalog and provider priorities as Finition', () => {
    assert.equal(defaults.aiModel,models[0].value);
    const key = provider => provider + '-fixture';
    assert.equal(getConnection(settings({aiModel:'claude-example'}),key).provider,'anthropic');
    for (const model of ['gpt-example','o3-example','GPT-CUSTOM']) assert.equal(getConnection(settings({aiModel:model}),key).apiKey,'openai-fixture');
    assert.deepEqual(getConnection(settings({aiModel:CODEX_MODEL,codexModel:'chosen',localAIServer:'bad'}),()=>{throw new Error('No API key needed');}),{provider:'codex',model:'chosen',apiKey:''});
    assert.deepEqual(getConnection(settings({localAIServer:'http://localhost:11434',localAIModel:'local'}),()=>{throw new Error('No API key needed');}),{provider:'openai',model:'local',apiKey:'',baseUrl:'http://localhost:11434/v1'});
    assert.equal(getConnection(settings({localAIServer:'https://example.test/api/v1/',localAIModel:'local'}),key).baseUrl,'https://example.test/api/v1');
});

test('invalid local configuration fails without cloud fallback, and missing cloud keys fail', () => {
    for (const url of ['bad','file:///tmp/test','https://user:pass@example.com','http://localhost/?secret=1','http://localhost/#fragment']) {
        assert.throws(()=>getConnection(settings({localAIServer:url,localAIModel:'local'}),()=>{throw new Error('Must not read cloud key');}), /Local server/);
    }
    assert.throws(()=>getConnection(settings({localAIServer:'http://localhost'}),()=>''), /local model/);
    assert.throws(()=>getConnection(settings({}),()=>''), /Anthropic API key/);
});

async function fakeCodex(t, mode) {
    const dir = await fs.mkdtemp(path.join(tmpdir(),'textmachine-codex-'));
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const executable = path.join(dir,'codex');
    await fs.writeFile(executable, `#!${process.execPath}\nconst readline = require('node:readline');
        const mode = ${JSON.stringify(mode)};
        readline.createInterface({input:process.stdin}).on('line', line => {
            const message = JSON.parse(line);
            if (message.id === undefined) return;
            let result;
            if (message.method === 'initialize') result = {};
            else if (message.method === 'account/read') result = {requiresOpenaiAuth:true,account:mode === 'login' ? null : {type:'chatgpt'}};
            else if (message.method === 'model/list') {
                if (mode === 'cancel') return;
                result = message.params.cursor ? {data:[{model:'second',displayName:'Second'}],nextCursor:mode === 'cycle' ? 'next' : null}
                    : {data:[{model:'first',displayName:'First'},{hidden:true}],nextCursor:'next'};
            } else {process.exit(2);}
            const reply = JSON.stringify({id:message.id,result}) + '\\n';
            process.stdout.write(reply.slice(0,8)); process.stdout.write(reply.slice(8));
        });`, {mode:0o700});
    return executable;
}

test('Codex discovers all model pages using the existing account without starting a turn', async t => {
    const executable = await fakeCodex(t,'models');
    assert.deepEqual(await listModels(executable),[{value:'first',label:'First'},{value:'second',label:'Second'}]);
});

test('Codex detects a disconnected account and invalid model pagination', async t => {
    await assert.rejects(listModels(await fakeCodex(t,'login')), /codex login/);
    await assert.rejects(listModels(await fakeCodex(t,'cycle')), /Invalid Codex/);
});

test('Codex model discovery can be cancelled', async t => {
    const executable = await fakeCodex(t,'cancel');
    const controller = new AbortController();
    const pending = listModels(executable,controller.signal);
    setTimeout(()=>controller.abort(),50);
    await assert.rejects(pending,/cancelled/);
});
