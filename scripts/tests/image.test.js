const {test} = require('node:test');
const assert = require('node:assert/strict');
require('../../plugin/i18n').setLocale('en');
const prompt = require('node:fs').readFileSync(require('node:path').join(__dirname,'../../prompts/image.md'),'utf8');
const imageCheck = require('../../plugin/ai/image');
const {generate} = require('../../plugin/ai/generate');
const picture = 'https://example.com/photo.jpg';
const candidate = () => ({title:'Books and AI',paragraphs:['First','Second'],image:{url:picture,source:'https://example.com/article',caption:'Candidate'}});

test('only an explicit visual acceptance with a nonempty caption enables an image',()=>{
    const result = imageCheck.apply(candidate(),'{"accepted":true,"caption":"A typewriter on a desk."}');
    assert.equal(result.image.verified,true);
    assert.equal(result.image.url,picture);
    assert.equal(result.image.caption,'A typewriter on a desk.');
    for (const response of ['{"accepted":false,"caption":"A face"}','{"accepted":true,"caption":""}',
        '{"accepted":"true","caption":"Caption"}','{"accepted":true,"caption":"Caption","extra":1}','broken']) {
        assert.equal(imageCheck.apply(candidate(),response).image,null);
    }
    const request = imageCheck.request(candidate(),{title:'Original article'},prompt);
    assert.ok(request.system.includes('visage humain'));
    assert.ok(!request.system.includes('textmachine.json'));
    assert.equal(JSON.parse(request.input).title,'Original article');
});

test('OpenAI, Anthropic and the local server receive an actual image input for verification',async()=>{
    for (const connection of [
        {provider:'openai',model:'fixture',apiKey:'fixture'},
        {provider:'anthropic',model:'fixture',apiKey:'fixture'},
        {provider:'openai',model:'local',baseUrl:'http://localhost:11434/v1'},
    ]) {
        const request = imageCheck.request(candidate(),{title:'Article'},prompt);
        const text = await generate(connection,request.system,request.input,async options=>{
            const body = JSON.parse(options.body);
            const content = connection.provider==='anthropic' ? body.messages[0].content
                : connection.baseUrl ? body.messages[1].content : body.input[0].content;
            const image = content.find(part=>['image','image_url','input_image'].includes(part.type));
            assert.equal(image.source?.url || image.image_url?.url || image.image_url,picture);
            const answer = '{"accepted":false,"caption":""}';
            return {status:200,json:connection.provider==='anthropic' ? {content:[{type:'text',text:answer}]}
                : connection.baseUrl ? {choices:[{message:{content:answer}}]}
                    : {output:[{type:'message',content:[{type:'output_text',text:answer}]}]}};
        },undefined,undefined,picture);
        assert.equal(imageCheck.apply(candidate(),text).image,null);
    }
});
