const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
require('../../plugin/i18n').setLocale('en');
const {parseStream,requestStream} = require('../../plugin/ai/stream');
const {generate} = require('../../plugin/ai/generate');
const {preview} = require('../../plugin/newsletter');
const frame = value => 'data: '+JSON.stringify(value)+'\r\n\r\n';
const output = text => ({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]});

test('streaming decodes fragmented provider events and reports text before completion',()=>{
    for (const [connection,events] of [
        [{provider:'openai'},[{type:'response.output_text.delta',delta:'Bonjour '},{type:'response.output_text.delta',delta:'été'},{type:'response.completed',response:output('Bonjour été')}]],
        [{provider:'anthropic'},[{type:'content_block_delta',delta:{type:'text_delta',text:'Bonjour '}},{type:'content_block_delta',delta:{text:'été'}},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}]],
        [{baseUrl:'http://localhost/v1'},[{choices:[{delta:{content:'Bonjour '}}]},{choices:[{delta:{content:'été'},finish_reason:'stop'}]}]],
    ]) {
        const chunks = [];
        const stream = parseStream(connection,(text,partial)=>{assert.equal(partial,true);chunks.push(text);});
        const data = events.map(frame).join('');
        for (let index=0;index<data.length;index+=3) stream.push(data.slice(index,index+3));
        assert.deepEqual(chunks,['Bonjour ','été']);
        const response = stream.finish();
        assert.ok(JSON.stringify(response).includes('Bonjour été'));
    }
});

test('unfinished or failed streams cannot become a saved newsletter',()=>{
    for (const events of [
        [{type:'response.output_text.delta',delta:'Partial response'}],
        [{type:'response.failed',response:{error:'private-value'}}],
        [{type:'error',error:{message:'private-value'}},{type:'response.completed'}],
    ]) {
        const stream = parseStream({provider:'openai'});
        stream.push(events.map(frame).join(''));
        assert.throws(()=>stream.finish(),error=>error.message.includes('incomplete')&&!error.message.includes('private-value'));
    }
    const doneWithoutCompletion = parseStream({provider:'openai'});
    doneWithoutCompletion.push(frame({type:'response.output_text.delta',delta:'Truncated'})+'data: [DONE]\n\n');
    assert.throws(()=>doneWithoutCompletion.finish(),/incomplete/);
    const stream = parseStream({provider:'openai'});
    assert.throws(()=>stream.push('data: broken\n\n'),/Invalid AI response/);
});

test('preview extracts readable Markdown while the JSON envelope is still arriving',()=>{
    assert.equal(preview('{"markdown":"# Titre\\n\\nL’écriture'), '# Titre\n\nL’écriture');
    assert.equal(preview('{"markdown":"# Un \\"titre\\""'), '# Un "titre"');
    assert.equal(preview('{"used":['),'');
    assert.equal(preview('```json\n{"markdown":"# Titre"'), '# Titre');
    assert.equal(preview('{"title":"Titre","chapeau":"Introduction","paragraphs":["Premier [lien](https://example.com)","Texte en cours'), '# Titre\n\n*Introduction*\n\nPremier [lien](https://example.com)\n\nTexte en cours');
});

async function server(t,handle) {
    const instance = http.createServer(handle);
    instance.listen(0,'127.0.0.1');
    await once(instance,'listening');
    t.after(()=>{instance.closeAllConnections();instance.close();});
    return 'http://127.0.0.1:'+instance.address().port+'/v1';
}

test('real HTTP transport displays a first fragment before the server finishes',{timeout:5000},async t=>{
    let finish;
    const baseUrl = await server(t,(request,response)=>{
        let body = '';
        request.on('data',chunk=>{body+=chunk;});
        request.on('end',()=>{
            assert.equal(JSON.parse(body).stream,true);
            assert.equal(request.headers.authorization,undefined);
            response.writeHead(200,{'Content-Type':'Text/Event-Stream'});
            response.write(frame({choices:[{delta:{content:'First '}}]}));
            finish = ()=>response.end(frame({choices:[{delta:{content:'part'},finish_reason:'stop'}]}));
        });
    });
    const chunks = [];
    let first;
    const arrived = new Promise(resolve=>{first=resolve;});
    const pending = generate({provider:'openai',model:'fixture',baseUrl},'Writer','Articles',requestStream,undefined,text=>{chunks.push(text);first();});
    await arrived;
    assert.deepEqual(chunks,['First ']);
    finish();
    assert.equal(await pending,'First part');
    assert.deepEqual(chunks,['First ','part']);
});

test('cancelling a streamed request closes its network connection',{timeout:5000},async t=>{
    let closed;
    const disconnected = new Promise(resolve=>{closed=resolve;});
    const baseUrl = await server(t,(_request,response)=>{
        response.once('close',closed);
        response.writeHead(200,{'Content-Type':'Text/Event-Stream'});
        response.write(frame({choices:[{delta:{content:'Started'}}]}));
    });
    let first;
    const arrived = new Promise(resolve=>{first=resolve;});
    const controller = new AbortController();
    const pending = generate({provider:'openai',model:'fixture',baseUrl},'','',requestStream,controller.signal,()=>first());
    await arrived;
    controller.abort();
    await assert.rejects(pending,/cancelled/);
    await disconnected;
});


test('a local server returning JSON instead of SSE still produces its complete response', {timeout:5000},async t=>{
    const baseUrl = await server(t,(_request,response)=>{
        response.writeHead(200,{'Content-Type':'application/json'});
        response.end(JSON.stringify({choices:[{message:{content:'Complete JSON response'},finish_reason:'stop'}]}));
    });
    assert.equal(await generate({provider:'openai',model:'fixture',baseUrl},'','',requestStream),'Complete JSON response');
});
