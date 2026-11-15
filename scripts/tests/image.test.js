const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../../plugin/i18n').setLocale('en');
const image = require('../../plugin/ai/image');
const {generate} = require('../../plugin/ai/generate');
const png=fs.readFileSync(path.join(__dirname,'fixtures/illustration.png'));
const connection={provider:'openai',model:'user-chosen-model',apiKey:'fixture'};
const response=()=>({status:200,json:{status:'completed',output:[{type:'image_generation_call',status:'completed',result:png.toString('base64')}]}});

test('image generation uses the configured OpenAI model and its native image tool without choosing another model',async()=>{
    const data=await image.generate(connection,'Black and white humorous cartoon without text. Final article.',async options=>{
        assert.equal(options.url,'https://api.openai.com/v1/responses');
        assert.equal(options.headers.Authorization,'Bearer fixture');
        const body=JSON.parse(options.body);
        assert.equal(body.model,connection.model);
        assert.deepEqual(body.tools,[{type:'image_generation',output_format:'png'}]);
        assert.deepEqual(body.tool_choice,{type:'image_generation'});
        assert.equal(body.input,'Black and white humorous cartoon without text. Final article.');
        return response();
    });
    assert.deepEqual(Buffer.from(data),png);
});

test('missing credentials, invalid images, provider failures and cancellation cannot produce an illustration',async()=>{
    await assert.rejects(image.generate({...connection,apiKey:''},'Image',()=>{throw new Error('Must not call API');}),/OpenAI API key/);
    await assert.rejects(image.generate(connection,'',()=>{throw new Error('Must not call API');}),/image.md.*empty/);
    const wrongSize=Buffer.from(png);wrongSize.writeUInt32BE(0,20);
    for (const value of ['', 'not base64',Buffer.from('<svg onload="alert(1)"/>').toString('base64'),wrongSize.toString('base64')]) {
        await assert.rejects(image.generate(connection,'Image',async()=>({status:200,json:{output:[{type:'image_generation_call',status:'completed',result:value}]}})),/Unable to create/);
    }
    await assert.rejects(image.generate(connection,'Image',async()=>({status:403,json:{error:{message:'private-fixture-value'}}})),error=>{
        assert.ok(error.message.includes('403'));
        assert.ok(!error.message.includes('private-fixture-value'));
        return true;
    });
    const controller=new AbortController();
    await assert.rejects(image.generate(connection,'Image',async()=>{controller.abort();return response();},controller.signal),/cancelled/);
    for (const selected of [{...connection,provider:'anthropic'},{...connection,baseUrl:'http://localhost/v1'}])
        await assert.rejects(image.generate(selected,'Image',()=>assert.fail('No provider fallback')),/does not expose/);
});

test('OpenAI, Anthropic and the local server retain their image-input transport',async()=>{
    const picture='https://example.com/photo.jpg';
    for (const connection of [{provider:'openai',model:'fixture',apiKey:'fixture'},
        {provider:'anthropic',model:'fixture',apiKey:'fixture'},
        {provider:'openai',model:'local',baseUrl:'http://localhost:11434/v1'}]) {
        const text=await generate(connection,'Examine the supplied image','Context',async options=>{
            const body=JSON.parse(options.body);
            const content=connection.provider==='anthropic' ? body.messages[0].content : connection.baseUrl ? body.messages[1].content : body.input[0].content;
            const image=content.find(part=>['image','image_url','input_image'].includes(part.type));
            assert.equal(image.source?.url || image.image_url?.url || image.image_url,picture);
            return {status:200,json:connection.provider==='anthropic' ? {content:[{type:'text',text:'Image description'}]}
                : connection.baseUrl ? {choices:[{message:{content:'Image description'}}]}
                    : {output:[{type:'message',content:[{type:'output_text',text:'Image description'}]}]}};
        },undefined,undefined,picture);
        assert.equal(text,'Image description');
    }
});
