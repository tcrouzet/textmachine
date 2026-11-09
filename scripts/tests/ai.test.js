const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
require('../../plugin/i18n').setLocale('en');
const {defaults, models, CODEX_MODEL, getConnection} = require('../../plugin/ai/config');
const {listModels,generate,generateImage} = require('../../plugin/ai/codex');

const settings = values => ({...defaults,...values});
test('Codex discovery bypasses npm launchers and executes the native binary without node on PATH',async t=>{
    const execute=promisify(execFile),root=await fs.mkdtemp(path.join(tmpdir(),'textmachine-native-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const targets={'darwin:arm64':'aarch64-apple-darwin','darwin:x64':'x86_64-apple-darwin',
        'linux:arm64':'aarch64-unknown-linux-musl','linux:x64':'x86_64-unknown-linux-musl',
        'win32:arm64':'aarch64-pc-windows-msvc','win32:x64':'x86_64-pc-windows-msvc'};
    const triple=targets[process.platform+':'+process.arch];
    assert.ok(triple,'Supported native test platform');
    for (const layout of ['bundled','nested','hoisted','standalone']) {
        const home=path.join(root,layout),bin=path.join(home,'bin');
        const packageRoot=process.platform==='win32' ? path.join(bin,'node_modules','@openai','codex') : path.join(home,'lib','node_modules','@openai','codex');
        const script=path.join(packageRoot,'bin','codex.js');
        await fs.mkdir(path.dirname(script),{recursive:true});
        await fs.mkdir(bin,{recursive:true});
        await fs.writeFile(script,'#!/usr/bin/env node\nthrow new Error("A Node.js launcher must not run");\n',{mode:0o755});
        const wrapper=path.join(bin,process.platform==='win32' ? 'codex.cmd' : 'codex');
        if (process.platform==='win32') await fs.writeFile(wrapper,'@node wrapper.js');
        else await fs.symlink(script,wrapper);
        const platformPackage='codex-'+process.platform+'-'+process.arch;
        const nativeRoot=layout==='nested' ? path.join(packageRoot,'node_modules','@openai',platformPackage)
            : layout==='hoisted' ? path.join(path.dirname(packageRoot),platformPackage) : packageRoot;
        const native=layout==='standalone' ? path.join(home,'native',process.platform==='win32' ? 'codex.exe' : 'codex')
            : path.join(nativeRoot,'vendor',triple,'codex',process.platform==='win32' ? 'codex.exe' : 'codex');
        await fs.mkdir(path.dirname(native),{recursive:true});
        if (process.platform==='win32') await fs.copyFile(process.execPath,native);
        else await fs.symlink(process.execPath,native);
        const env={...process.env,HOME:home,USERPROFILE:home,PATH:bin+(layout==='standalone' ? path.delimiter+path.dirname(native) : '')};
        if (process.platform!=='win32') await assert.rejects(execute(wrapper,['--version'],{env}),error=>error.stderr.includes('node'));
        const register=path.join(__dirname,'register.cjs');
        const module=path.join(__dirname,'../../plugin/ai/codex.ts');
        const code='require('+JSON.stringify(module)+').findCodex().then(value=>process.stdout.write(JSON.stringify(value)))';
        const found=JSON.parse((await execute(process.execPath,['--require',register,'-e',code],{env})).stdout);
        assert.equal(found,await fs.realpath(native),layout);
        assert.equal((await execute(found,['--version'],{env})).stdout.trim(),process.version);
    }
});

test('same model catalog and provider priorities as Finition', () => {
    assert.equal(defaults.aiModel,models[0].value);
    const key = provider => provider + '-fixture';
    assert.equal(getConnection(settings({aiModel:'claude-example'}),key).provider,'anthropic');
    for (const model of ['gpt-example','o3-example','GPT-CUSTOM']) assert.equal(getConnection(settings({aiModel:model}),key).apiKey,'openai-fixture');
    assert.deepEqual(getConnection(settings({aiModel:CODEX_MODEL,codexModel:'chosen',localAIServer:'bad'}),()=>{throw new Error('No API key needed');}),{provider:'codex',model:'chosen',apiKey:'',effort:'low'});
    assert.deepEqual(getConnection(settings({localAIServer:'http://localhost:11434',localAIModel:'local'}),()=>{throw new Error('No API key needed');}),{provider:'openai',model:'local',apiKey:'',baseUrl:'http://localhost:11434/v1'});
    assert.equal(getConnection(settings({localAIServer:'https://example.test/api/v1/',localAIModel:'local'}),key).baseUrl,'https://example.test/api/v1');
});

test('Codex keeps the chosen effort and rejects invalid values without reading API keys',()=>{
    const secret=()=>assert.fail('Codex must not read API keys');
    assert.equal(defaults.codexEffort,'low');
    assert.equal(getConnection(settings({aiModel:CODEX_MODEL,codexEffort:' high '}),secret).effort,'high');
    for (const effort of ['', 'high effort', 'HIGH', 'x'.repeat(33)])
        assert.throws(()=>getConnection(settings({aiModel:CODEX_MODEL,codexEffort:effort}),secret),/reasoning effort/);
    assert.equal(getConnection(settings({aiModel:'gpt-example',codexEffort:'high'}),()=> 'fixture').effort,undefined);
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
    const png = await fs.readFile(path.join(__dirname,'fixtures/illustration.png'));
    await fs.writeFile(executable, `#!${process.execPath}\nconst readline = require('node:readline');
        const mode = ${JSON.stringify(mode)};
        let turnCount = 0;
        const imageData = ${JSON.stringify(png.toString('base64'))};
        const invalidSchema = value => value && typeof value === 'object' && (
            value.type === 'object' && (value.additionalProperties !== false
                || !Array.isArray(value.required) || Object.keys(value.properties || {}).some(key=>!value.required.includes(key)))
            || Object.values(value).some(invalidSchema));
        readline.createInterface({input:process.stdin}).on('line', line => {
            const message = JSON.parse(line);
            if (message.id === undefined) return;
            let result;
            if (message.method === 'initialize') result = {};
            else if (message.method === 'account/read') result = {requiresOpenaiAuth:true,account:mode === 'login' ? null : {type:'chatgpt'}};
            else if (message.method === 'config/read') result = {config:{mcp_servers:{fixture:{enabled:true}}}};
            else if (message.method === 'thread/start') {
                const flag=(name,value)=>process.argv.some((arg,index)=>arg===name && process.argv[index+1]===value);
                if (mode.startsWith('image-generation') ? !flag('--enable','image_generation') || flag('--disable','image_generation') : !flag('--disable','image_generation')) process.exit(11);
                if (mode === 'rpc-config') {
                    process.stdout.write(JSON.stringify({id:message.id,error:{code:-32602,message:'Invalid project_doc_max_bytes: private-fixture-value'}})+'\\n');
                    return;
                }
                if (mode === 'effort' && message.params.config.model_reasoning_effort !== 'high') process.exit(8);
                if (message.params.sandbox !== 'read-only' || message.params.config.mcp_servers.fixture.enabled !== false) process.exit(3);
                result = {model:message.params.model || 'resolved-default',thread:{id:'thread-1',ephemeral:true},sandbox:{type:mode === 'unsafe' ? 'workspaceWrite' : 'readOnly'},approvalPolicy:'never'};
            } else if (message.method === 'turn/start') {
                turnCount++;
                if (mode.startsWith('image-generation') && mode!=='image-generation-empty') {
                    process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n');
                    const item={id:'illustration',type:mode==='image-generation-tool' ? 'commandExecution' : 'imageGeneration',
                        status:mode==='image-generation-failed' ? 'failed' : 'completed',
                        ...(mode==='image-generation-saved' ? {savedPath:'/tmp/generated-fixture.png'} : {result:imageData})};
                    process.stdout.write(JSON.stringify({method:'item/completed',params:{threadId:'thread-1',item}})+'\\n');
                    process.stdout.write(JSON.stringify({method:'item/completed',params:{threadId:'thread-1',item:{id:'final',type:'agentMessage',text:'The illustration is ready.'}}})+'\\n');
                    process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'thread-1',turn:{status:'completed'}}})+'\\n');
                    return;
                }
                if (mode.startsWith('rpc-output')) {
                    require('node:fs').writeFileSync(__filename+'.attempts',String(turnCount));
                    if (message.params.outputSchema || mode === 'rpc-output-repeat') {
                        if (mode === 'rpc-output-late') process.stdout.write(JSON.stringify({method:'item/started',params:{threadId:'thread-1',item:{id:'thinking',type:'reasoning'}}})+'\\n');
                        process.stdout.write(JSON.stringify({id:message.id,error:{code:-32602,message:'Unsupported parameter outputSchema: private-fixture-value'}})+'\\n');
                        return;
                    }
                }
                if (mode === 'effort' && message.params.effort !== 'high') process.exit(9);
                if (message.params.sandboxPolicy.networkAccess !== false) process.exit(4);
                if (mode === 'image' && !message.params.input.some(item=>item.type==='image' && item.url==='https://example.com/image.jpg')) process.exit(6);
                if (mode === 'schema' && !message.params.outputSchema?.properties?.paragraphs) process.exit(5);
                const failure = message.params.outputSchema && invalidSchema(message.params.outputSchema)
                    ? {message:"Invalid schema for response_format: required is missing title",codexErrorInfo:'badRequest'}
                    : mode === 'quota' ? {message:'private-fixture-value',codexErrorInfo:'usageLimitExceeded'}
                        : mode === 'context' ? {message:'private-fixture-value',codexErrorInfo:'contextWindowExceeded'}
                            : mode === 'unauthorized' ? {message:'private-fixture-value',codexErrorInfo:'unauthorized'}
                            : mode === 'unknown' ? {message:'private-fixture-value',codexErrorInfo:null}
                                : mode.startsWith('info:') ? {message:'private-fixture-value',codexErrorInfo:JSON.parse(mode.slice(5))} : null;
                if (mode === 'rpc-schema') {
                    process.stdout.write(JSON.stringify({id:message.id,error:{code:-32602,message:'Invalid schema: private-fixture-value'}})+'\\n');
                    return;
                }
                if (mode === 'rpc-invalid') {
                    process.stdout.write(JSON.stringify({id:message.id,error:{code:-32602,message:'private-fixture-value'}})+'\\n');
                    return;
                }
                if (mode === 'rpc-input-too-long') {
                    process.stdout.write(JSON.stringify({id:message.id,error:{code:-32602,message:'Input exceeds the maximum length of 1048576 characters. private-fixture-value'}})+'\\n');
                    return;
                }
                if (failure) {
                    process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n');
                    if (mode !== 'context') process.stdout.write(JSON.stringify({method:'error',params:{threadId:'thread-1',error:failure,willRetry:false}})+'\\n');
                    process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'thread-1',turn:{status:'failed',...(mode === 'context' ? {error:failure} : {})}}})+'\\n');
                    return;
                }
                if (mode === 'transient') process.stdout.write(JSON.stringify({method:'error',params:{threadId:'thread-1',error:{message:'Temporary issue'},willRetry:true}})+'\\n');
                if (mode === 'empty' || mode === 'interrupted') {
                    process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n');
                    process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'thread-1',turn:{status:mode==='empty' ? 'completed' : 'interrupted'}}})+'\\n');
                    return;
                }
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
            } else if (message.method === 'fs/readFile' && mode==='image-generation-saved') {
                if (message.params.path!=='/tmp/generated-fixture.png') process.exit(12);
                result={dataBase64:imageData};
            } else if (message.method === 'model/list') {
                if (mode === 'cancel') return;
                result = mode.startsWith('efforts') ? {data:[{model:'first',displayName:'First',supportedReasoningEfforts:
                    mode==='efforts-invalid' ? [{reasoningEffort:'invalid effort'}] : mode==='efforts-malformed' ? 'high'
                        : [{reasoningEffort:'low'},{reasoningEffort:'high'},{reasoningEffort:'low'},{reasoningEffort:'ultra'}]}],nextCursor:null}
                    : message.params.cursor ? {data:[{model:'second',displayName:'Second'}],nextCursor:mode === 'cycle' ? 'next' : null}
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

test('Codex discovers supported efforts and validates the returned catalog',async t=>{
    assert.deepEqual(await listModels(await fakeCodex(t,'efforts')),[{value:'first',label:'First',efforts:['low','high','ultra']}]);
    for (const mode of ['efforts-invalid','efforts-malformed']) await assert.rejects(listModels(await fakeCodex(t,mode)),/Invalid Codex/);
});

test('Codex sends the chosen effort to both the thread and its turn',async t=>{
    assert.equal(await generate(await fakeCodex(t,'effort'),'Writer','Articles','fixture',undefined,undefined,undefined,undefined,'high'),'Generated newsletter');
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
    assert.equal(await generate(await fakeCodex(t,'generation'),'Writer prompt','Collected articles','fixture-model',undefined,(text,partial,_reset,model)=>feedback.push(model ? {model} : {text,partial})), 'Generated newsletter');
    assert.deepEqual(feedback,[{model:'Codex · fixture-model'},{text:'The AI is preparing its response…',partial:undefined},{text:'Preparing newsletter',partial:undefined},{text:'Generated newsletter',partial:true}]);
    await assert.rejects(generate(await fakeCodex(t,'tools'),'Writer','Articles','fixture-model'),/without tools/);
    await assert.rejects(generate(await fakeCodex(t,'unsafe'),'Writer','Articles','fixture-model'),/without tools/);
});

test('Codex reports the selected model and resolves the configured default model',async t=>{
    for (const selected of ['fixture-model','']) {
        const reported=[];
        await generate(await fakeCodex(t,'generation'),'Writer','Articles',selected,undefined,(_message,_stream,_reset,model)=>{if(model)reported.push(model);});
        assert.deepEqual(reported,['Codex · '+(selected || 'resolved-default')]);
    }
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


test('Codex generation receives the writer JSON schema as its output constraint',async t=>{
    const schema = require('../../models/writer.json');
    assert.equal(await generate(await fakeCodex(t,'schema'),'Writer','Articles','fixture',undefined,undefined,schema),'Generated newsletter');
});


test('Codex accepts separate strict schemas for selection, article writing, revision and publication',async t=>{
    const newsletter=require('../../plugin/newsletter');
    const articles=[{id:41,title:'AI and books',url:'https://example.com/article',source:'User',publish:'',content:'An article about books and AI.'}];
    const requests=[newsletter.selectionRequest('{{articles}}',articles,'français'),
        newsletter.writerRequest('{{articles}}',articles,[],[],'français'),
        newsletter.publisherRequest('{{article}}',['First paragraph.','Second paragraph.'],'français'),
        newsletter.verificationRequest('{{newsletter}}\n{{articles}}',{title:'Title',chapeau:'Introduction',paragraphs:['First paragraph.','Second paragraph.']},articles,'français'),
        require('../../plugin/ai/rewrite').rewriteRequest('Revise the article','First paragraph.\n\nSecond paragraph.')];
    for (const request of requests) {
        assert.equal(await generate(await fakeCodex(t,'generation'),request.system,request.input,'fixture',undefined,undefined,request.schema),'Generated newsletter');
    }
});

test('Codex receives the actual image URL as an image input for visual verification',async t=>{
    assert.equal(await generate(await fakeCodex(t,'image'),'Inspect image','Context','fixture',undefined,undefined,undefined,'https://example.com/image.jpg'),'Generated newsletter');
});

test('Codex generates images with its native tool and the configured model without enabling other tools',async t=>{
    const png=await fs.readFile(path.join(__dirname,'fixtures/illustration.png'));
    for (const mode of ['image-generation','image-generation-saved']) {
        const models=[];
        const image=await generateImage(await fakeCodex(t,mode),'Draw the illustration','Article','chosen-model',undefined,(_text,_stream,_reset,model)=>{if(model)models.push(model);},'high');
        assert.deepEqual(Buffer.from(image),png);
        assert.deepEqual(models,['Codex · chosen-model']);
    }
    for (const mode of ['image-generation-failed','image-generation-tool','image-generation-empty'])
        await assert.rejects(generateImage(await fakeCodex(t,mode),'Draw','Article','chosen-model'),/Unable to create|without tools/);
});

test('Codex reports schema, quota and context failures without exposing raw server messages',async t=>{
    for (const [mode,expected] of [['rpc-schema',/JSON schema/],['rpc-input-too-long',/1048576 characters/],['quota',/usage limit/],['context',/context window/],['unauthorized',/codex login/],['unknown',/failed/]]) {
        await assert.rejects(generate(await fakeCodex(t,mode),'Writer','Articles','fixture'),error=>{
            assert.match(error.message,expected);
            assert.ok(!error.message.includes('private-fixture-value'));
            assert.ok(!error.message.includes('incomplete'));
            return true;
        });
    }
});

test('Codex preserves safe diagnostic codes from updated app servers',async t=>{
    for (const info of ['modelNotFound','badRequest','rateLimitExceeded','serverOverloaded','sessionBudgetExceeded',
        {responseStreamDisconnected:{httpStatusCode:503}}]) {
        const code = typeof info === 'string' ? info : Object.keys(info)[0];
        await assert.rejects(generate(await fakeCodex(t,'info:'+JSON.stringify(info)),'Writer','Articles','fixture'),error=>{
            assert.ok(error.message.includes('('+code+')'),error.message);
            assert.ok(!error.message.includes('private-fixture-value'));
            return true;
        });
    }
    await assert.rejects(generate(await fakeCodex(t,'rpc-invalid'),'Writer','Articles','fixture'),error=>{
        assert.match(error.message,/^turn\/start: .*\(-32602\)/);
        assert.ok(!error.message.includes('private-fixture-value'));
        return true;
    });
    await assert.rejects(generate(await fakeCodex(t,'rpc-config'),'Writer','Articles','fixture'),error=>{
        assert.match(error.message,/^thread\/start: .*\(-32602\).*project_doc_max_bytes/);
        assert.ok(!error.message.includes('private-fixture-value'));
        return true;
    });
    for (const info of ['private-fixture-value',{'private-fixture-value':{httpStatusCode:503}}]) {
        await assert.rejects(generate(await fakeCodex(t,'info:'+JSON.stringify(info)),'Writer','Articles','fixture'),error=>{
            assert.ok(!error.message.includes('private-fixture-value'));
            return true;
        });
    }
});

test('Codex preserves the native output schema and never retries invalid parameters',async t=>{
    const schema = require('../../models/selection.json');
    for (const mode of ['rpc-output','rpc-output-repeat','rpc-output-late']) {
        const failing = await fakeCodex(t,mode);
        await assert.rejects(generate(failing,'Return JSON','Articles','fixture',undefined,undefined,schema),/\(-32602\)/);
        assert.equal(await fs.readFile(failing+'.attempts','utf8'),'1');
    }
});

test('a nested optional field is rejected as a schema failure before generation',async t=>{
    const schema = structuredClone(require('../../models/bref.json'));
    const review = schema.properties.titles.items;
    review.required = review.required.filter(key=>key !== 'title');
    await assert.rejects(generate(await fakeCodex(t,'generation'),'Writer','Articles','fixture',undefined,undefined,schema),/JSON schema/);
});

test('Codex distinguishes empty and interrupted turns and waits through recoverable errors',async t=>{
    await assert.rejects(generate(await fakeCodex(t,'empty'),'Writer','Articles','fixture'),/without a final response/);
    await assert.rejects(generate(await fakeCodex(t,'interrupted'),'Writer','Articles','fixture'),/cancelled/);
    assert.equal(await generate(await fakeCodex(t,'transient'),'Writer','Articles','fixture'),'Generated newsletter');
});
