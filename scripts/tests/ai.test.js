const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
require('../../plugin/i18n').setLocale('en');
const {defaults, models, CODEX_MODEL, getConnection} = require('../../plugin/ai/config');
const {listModels,generate} = require('../../plugin/ai/codex');

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
            else if (message.method === 'config/read') result = {config:{mcp_servers:{fixture:{enabled:true}}}};
            else if (message.method === 'thread/start') {
                if (message.params.sandbox !== 'read-only' || message.params.config.mcp_servers.fixture.enabled !== false) process.exit(3);
                result = {thread:{id:'thread-1',ephemeral:true},sandbox:{type:mode === 'unsafe' ? 'workspaceWrite' : 'readOnly'},approvalPolicy:'never'};
            } else if (message.method === 'turn/start') {
                if (message.params.sandboxPolicy.networkAccess !== false) process.exit(4);
                if (mode === 'image' && !message.params.input.some(item=>item.type==='image' && item.url==='https://example.com/image.jpg')) process.exit(6);
                if (mode === 'schema' && !message.params.outputSchema?.properties?.groups) process.exit(5);
                process.stdout.write(JSON.stringify({method:'item/started',params:{threadId:'thread-1',item:{id:'thinking',type:'reasoning'}}})+'\\n');
                process.stdout.write(JSON.stringify({method:'item/started',params:{threadId:'thread-1',item:{id:'commentary',type:'agentMessage',phase:'commentary'}}})+'\\n');
                process.stdout.write(JSON.stringify({method:'item/agentMessage/delta',params:{threadId:'thread-1',itemId:'commentary',delta:'Preparing newsletter'}})+'\\n');
                process.stdout.write(JSON.stringify({method:'item/completed',params:{threadId:'thread-1',item:{id:'commentary',type:'agentMessage',phase:'commentary',text:'Preparing newsletter'}}})+'\\n');
                process.stdout.write(JSON.stringify({method:'item/agentMessage/delta',params:{threadId:'thread-1',itemId:'answer',delta:'Generated newsletter'}})+'\\n');
                const complete = ()=>{
                    process.stdout.write(JSON.stringify({method:'item/completed',params:{threadId:'thread-1',item:{type:mode === 'tools' ? 'commandExecution' : 'agentMessage',text:'Generated newsletter'}}})+'\\n');
                    process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'thread-1',turn:{status:'completed'}}})+'\\n');
                };
                if (mode === 'slow') {
                    require('node:fs').writeFileSync(__filename+'.ready','ready');
                    const waiting = setInterval(()=>{
                        if (require('node:fs').existsSync(__filename+'.continue')) {clearInterval(waiting);complete();}
                    },10);
                } else setTimeout(complete,10);
                result = {};
            } else if (message.method === 'model/list') {
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

test('Codex generation uses an ephemeral read-only thread without file or network tools',async t=>{
    const feedback = [];
    assert.equal(await generate(await fakeCodex(t,'generation'),'Writer prompt','Collected articles','fixture-model',undefined,(text,partial)=>feedback.push({text,partial})), 'Generated newsletter');
    assert.deepEqual(feedback,[{text:'The AI is preparing its response…',partial:undefined},{text:'Preparing newsletter',partial:undefined},{text:'Generated newsletter',partial:true}]);
    await assert.rejects(generate(await fakeCodex(t,'tools'),'Writer','Articles','fixture-model'),/without tools/);
    await assert.rejects(generate(await fakeCodex(t,'unsafe'),'Writer','Articles','fixture-model'),/without tools/);
});


test('Codex generation can finish beyond two minutes', {timeout:5000}, async t=>{
    const executable = await fakeCodex(t,'slow');
    t.mock.timers.enable({apis:['setTimeout']});
    const pending = generate(executable,'Writer','Articles','fixture');
    while (!(await fs.stat(executable+'.ready').catch(()=>null))) await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(180000);
    await fs.writeFile(executable+'.continue','continue');
    assert.equal(await pending,'Generated newsletter');
});


test('Codex generation receives the newsletter JSON schema as its output constraint',async t=>{
    const schema = require('../../models/newsletter.json');
    assert.equal(await generate(await fakeCodex(t,'schema'),'Writer','Articles','fixture',undefined,undefined,schema),'Generated newsletter');
});


test('Codex receives the actual image URL as an image input for visual verification',async t=>{
    assert.equal(await generate(await fakeCodex(t,'image'),'Inspect image','Context','fixture',undefined,undefined,require('../../plugin/ai/image').schema,'https://example.com/image.jpg'),'Generated newsletter');
});
