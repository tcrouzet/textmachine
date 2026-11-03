const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../../plugin/i18n').setLocale('en');
const {schema,day,availableArticles,briefArticles,writerRequest,parseNewsletter,renderNewsletter,applyStatuses} = require('../../plugin/newsletter');
const imageCheck = require('../../plugin/ai/image');
const {generate} = require('../../plugin/ai/generate');
const template = fs.readFileSync(path.join(__dirname,'../../models/newsletter.md'),'utf8');
const article = (slug, extra = {}) => ({date:'2026-11-03',title:slug,url:'https://example.com/'+slug,source:'User',status:'',publish:'2026-11-01',content:'An article about AI and books.',image:'',...extra});
const articles = [article('a',{id:1,image:'https://example.com/image.jpg'}),article('b',{id:2})];
const data = JSON.stringify({version:1,notes:'Keep notes',articles});
const result = {title:'A new angle',chapeau:'Books and AI.',paragraphs:['First paragraph.','Second paragraph. [Source](https://example.com/a)','Last paragraph.'],
    lead:1,image:{caption:'Original caption'},
    groups:[{title:'Literature',articles:[{id:1,summary:'Summary of the article.'}]}],discard:[2]};
const empty = {title:'',chapeau:'',paragraphs:[],lead:null,image:null,groups:[],discard:articles.map((_article,index)=>index+1)};

test('selection includes new articles and today’s used articles, never those used on another day',()=>{
    const text = JSON.stringify({version:1,articles:[...articles,article('today',{status:'used',usedAt:'2026-11-03'}),
        article('yesterday',{status:'used',usedAt:'2026-11-02'}),article('legacy',{status:'used'}),
        article('blocked',{status:'404'}),article('report.pdf'),article('no-content',{content:''})]});
    assert.deepEqual(availableArticles(text,'','2026-11-03').map(article=>article.title),['a','b','today']);
    assert.deepEqual(availableArticles(text,'example.com','2026-11-03'),[]);
    assert.equal(day(new Date(2026,10,3,23,59)),'2026-11-03');
});
test('legacy used articles are recovered only when explicitly linked from today’s newsletter',()=>{
    const text = JSON.stringify({version:1,articles:[article('legacy',{status:'used'}),article('other',{status:'used'})]});
    assert.deepEqual(availableArticles(text,'','2026-11-03',['[Source](https://example.com/legacy)']).map(article=>article.title),['legacy']);
    assert.deepEqual(availableArticles(text,'','2026-11-03',['[Source](https://example.com/legacy-extra)']),[]);
});
test('writer gets JSON requirements and editorial context without the Markdown template',()=>{
    const request = writerRequest('Editorial instructions',articles,[{content:'Earlier angle'}],[{title:'Latest blog post'}]);
    assert.ok(request.system.startsWith('Editorial instructions'));
    assert.ok(!request.system.includes('newsletter.md'));
    assert.ok(!request.system.includes('textmachine.json'));
    assert.ok(!request.system.includes('"$schema"'));
    assert.deepEqual(JSON.parse(request.input).articles.map(article=>article.id),[1,2]);
    assert.ok(!request.system.includes('{{#groups}}'));
    assert.ok(!request.input.includes('{{#groups}}'));
    assert.ok(!Object.hasOwn(JSON.parse(request.input),'template'));
    assert.deepEqual(JSON.parse(request.input).jsonSchema,schema);
    assert.equal(JSON.parse(request.input).previousNewsletters[0].content,'Earlier angle');
    assert.equal(JSON.parse(request.input).recentPosts[0].title,'Latest blog post');
    assert.throws(()=>writerRequest('',articles,[],[]),/writer.md/);
});
test('structured output classifies every article once and rejects invented images or source URLs',()=>{
    const normalized = parseNewsletter(JSON.stringify(result),articles);
    assert.deepEqual(normalized.used,[articles[0].url]);
    assert.deepEqual(normalized.discard,[articles[1].url]);
    assert.equal(normalized.groups[0].articles[0].url,articles[0].url);
    assert.deepEqual(normalized.image,{url:articles[0].image,source:articles[0].url,caption:'Original caption'});
    for (const changed of [
        {...result,discard:[]},
        {...result,groups:[...result.groups,...result.groups]},
        {...result,discard:[3]},
        {...result,discard:['2']},
        {...result,discard:[1.5]},
        {...result,lead:99},
        {...result,lead:2},
        {...result,image:{...result.image,url:'https://example.com/invented.jpg'}},
        {...result,groups:[{title:'Books',articles:[{id:0,summary:'Summary'}]}]},
        {...result,groups:[{title:'Books',articles:[{id:1,status:'used',summary:'Summary'}]}]},
        {...result,status:'used'},
        {...result,paragraphs:['Only one paragraph']},
        {...result,paragraphs:['![Extra image](https://example.com/image.jpg)','Second paragraph']},
        {...result,title:''},
        {markdown:'# Old output',used:[articles[0].url],discard:[articles[1].url]},
    ]) assert.throws(()=>parseNewsletter(JSON.stringify(changed),articles),/Invalid AI response/);
});
test('Markdown comes from the template, with its image after paragraph two and grouped sources',()=>{
    const parsed = imageCheck.apply(parseNewsletter(JSON.stringify(result),articles),JSON.stringify({accepted:true,caption:'Original caption'}));
    const markdown = renderNewsletter(template,parsed,articles);
    assert.ok(markdown.startsWith('# A new angle\n\n*Books and AI.*'));
    assert.ok(markdown.indexOf('Second paragraph.') < markdown.indexOf('[![Original caption]'));
    assert.ok(markdown.indexOf('[![Original caption]') < markdown.indexOf('Last paragraph.'));
    assert.ok(markdown.includes('## Revue de presse\n\n### Literature\n\n#### a'));
    assert.ok(markdown.includes('Source : [example.com](https://example.com/a)'));
    assert.equal((markdown.match(/!\[/g)||[]).length,1);
    assert.ok(!markdown.includes('{{'));
    const withoutImage = renderNewsletter(template,{...parsed,image:null},articles);
    assert.ok(!withoutImage.includes('!['));
    assert.ok(!renderNewsletter(template,{...parsed,image:{...parsed.image,caption:''}},articles).includes('!['));
    assert.ok(markdown.includes('\n\n*Original caption*'));
    assert.ok(!renderNewsletter(template,parseNewsletter(JSON.stringify(result),articles),articles).includes('!['));
    for (const bad of ['# {{unknown}}','# {{title}}\n{{#title}}bad{{/title}}','# {{title}}\n{{#groups}}']) {
        assert.throws(()=>renderNewsletter(bad,parsed,articles),/template/);
    }
    assert.ok(renderNewsletter(template,{...parsed,paragraphs:['Literal {{title}}','Second paragraph']},articles).includes('Literal {{title}}'));
});
test('status updates timestamp today and preserve annotations and concurrent edits',()=>{
    const changed = JSON.parse(data);
    changed.articles[0].custom = 'Keep annotation';
    changed.articles[1].content = 'Edited in the meantime';
    const parsed = parseNewsletter(JSON.stringify(result),articles);
    const saved = JSON.parse(applyStatuses(JSON.stringify(changed),articles,parsed,'2026-11-03'));
    assert.equal(saved.notes,'Keep notes');
    assert.equal(saved.articles[0].status,'used');
    assert.equal(saved.articles[0].usedAt,'2026-11-03');
    assert.equal(saved.articles[0].custom,'Keep annotation');
    assert.equal(saved.articles[1].status,'');
    changed.articles[0].status = 'discard';
    assert.equal(JSON.parse(applyStatuses(JSON.stringify(changed),articles,parsed,'2026-11-03')).articles[0].status,'discard');
});
test('all irrelevant articles can be discarded without generating a note',()=>{
    const classified = parseNewsletter(JSON.stringify(empty),articles);
    assert.ok(JSON.parse(applyStatuses(data,articles,classified)).articles.every(article=>article.status==='discard'));
});
test('OpenAI responses are collected across output blocks; local and Claude use their own protocols',async()=>{
    for (const connection of [
        {provider:'openai',model:'fixture',apiKey:'secret-fixture'},
        {provider:'openai',model:'local',apiKey:'',baseUrl:'http://localhost:11434/v1'},
        {provider:'anthropic',model:'fixture',apiKey:'secret-fixture'},
    ]) {
        const text = await generate(connection,'System writer','Articles',async options=>{
            const body = JSON.parse(options.body);
            assert.equal(body.model,connection.model);
            if (connection.baseUrl) {
                assert.equal(options.url,'http://localhost:11434/v1/chat/completions');
                assert.equal(options.headers.Authorization,undefined);
                return {status:200,json:{choices:[{message:{content:'Local text'},finish_reason:'stop'}]}};
            }
            if (connection.provider==='anthropic') {
                assert.equal(body.system,'System writer');
                assert.equal(options.headers['x-api-key'],'secret-fixture');
                return {status:200,json:{content:[{type:'text',text:'Claude text'}],stop_reason:'end_turn'}};
            }
            assert.equal(options.url,'https://api.openai.com/v1/responses');
            assert.equal(body.store,false);
            return {status:200,json:{output:[{type:'reasoning'},{type:'message',content:[{type:'output_text',text:'OpenAI '},{type:'output_text',text:'text'}]}]}};
        });
        assert.ok(text.endsWith('text'));
    }
});
test('provider errors and truncated responses never leak keys or accept partial output',async()=>{
    const connection = {provider:'openai',model:'fixture',apiKey:'private-value'};
    await assert.rejects(generate(connection,'','',async()=>({status:401,json:{error:'private-value'}})),error=>error.message.includes('401')&&!error.message.includes('private-value'));
    await assert.rejects(generate(connection,'','',async()=>{throw new Error('private-value');}),error=>!error.message.includes('private-value'));
    await assert.rejects(generate(connection,'','',async()=>({status:200,json:{status:'incomplete',output:[]}})),/incomplete/);
});
test('cancelled generation does not accept a late server response',async()=>{
    const controller = new AbortController();
    const pending = generate({provider:'openai',model:'fixture',apiKey:'fixture'},'','',async()=>{
        controller.abort();return new Promise(()=>{});
    },controller.signal);
    await assert.rejects(pending,/cancelled/);
});

test('cloud and local generation accept a response beyond two minutes',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    for (const connection of [
        {provider:'openai',model:'fixture',apiKey:'fixture'},
        {provider:'anthropic',model:'fixture',apiKey:'fixture'},
        {provider:'openai',model:'local',baseUrl:'http://localhost:11434/v1'},
    ]) {
        let finish;
        const pending = generate(connection,'Writer','Articles',()=>new Promise(resolve=>{finish=resolve;}));
        t.mock.timers.tick(180000);
        finish({status:200,json:connection.baseUrl ? {choices:[{message:{content:'Late response'}}]}
            : connection.provider==='anthropic' ? {content:[{type:'text',text:'Late response'}]}
                : {output:[{type:'message',content:[{type:'output_text',text:'Late response'}]}]}});
        assert.equal(await pending,'Late response');
    }
});


test('AI input uses stored IDs and excludes persistent state, images and private annotations',()=>{
    const image = 'https://example.com/image.jpg?'+ 'x'.repeat(500);
    const original = [{...articles[0],image,status:'used',usedAt:'2026-11-03',privateNotes:'Do not send'}];
    const before = JSON.stringify(original);
    const input = JSON.parse(writerRequest('Write',original,[],[]).input);
    assert.deepEqual(Object.keys(input.articles[0]),['id','title','url','source','publish','content','hasImage']);
    assert.equal(input.articles[0].id,1);
    assert.equal(input.articles[0].hasImage,true);
    assert.equal(JSON.stringify(original),before);
    assert.ok(JSON.stringify(input.articles).length < before.length);
    assert.ok(!JSON.stringify(input).includes('Do not send'));
});

test('stored AI IDs resolve through the original snapshot even if the article file is reordered',()=>{
    const normalized = parseNewsletter(JSON.stringify(result),articles);
    const current = {version:1,articles:[{...articles[1],privateNotes:'Keep B'},{...articles[0],privateNotes:'Keep A'}]};
    const saved = JSON.parse(applyStatuses(JSON.stringify(current),articles,normalized,'2026-11-03'));
    assert.equal(saved.articles[0].url,articles[1].url);
    assert.equal(saved.articles[0].status,'discard');
    assert.equal(saved.articles[0].privateNotes,'Keep B');
    assert.equal(saved.articles[1].url,articles[0].url);
    assert.equal(saved.articles[1].status,'used');
    assert.equal(saved.articles[1].usedAt,'2026-11-03');
    assert.equal(saved.articles[1].privateNotes,'Keep A');
    assert.deepEqual(saved.articles.map(article=>article.id),[2,1]);
});


test('forbidden articles appear only as linked titles in the brief section and stay forbidden',()=>{
    const forbidden = article('Blocked title',{status:'forbidden',content:'Unverified private content',image:'https://example.com/wrong.jpg'});
    const text = JSON.stringify({version:1,articles:[...articles,forbidden,article('old-forbidden',{status:'forbidden',usedAt:'2026-11-02'})]});
    const brief = briefArticles(text,'','2026-11-03');
    assert.deepEqual(brief.map(article=>article.title),['Blocked title']);
    assert.deepEqual(availableArticles(text,'','2026-11-03').map(article=>article.title),['a','b']);
    const parsed = imageCheck.apply(parseNewsletter(JSON.stringify(result),articles),JSON.stringify({accepted:true,caption:'Original caption'}));
    const markdown = renderNewsletter(template,parsed,articles,brief);
    assert.ok(markdown.includes('### In brief\n\n* [Blocked title](https://example.com/Blocked%20title)'));
    assert.ok(!markdown.includes('Unverified private content'));
    assert.ok(!markdown.includes('wrong.jpg'));
    assert.ok(markdown.indexOf('### In brief') > markdown.indexOf('Source :'));
    const saved = JSON.parse(applyStatuses(text,articles,parsed,'2026-11-03',brief));
    assert.equal(saved.articles[2].status,'forbidden');
    assert.equal(saved.articles[2].usedAt,'2026-11-03');
    assert.equal(saved.articles[2].content,'Unverified private content');
});

test('illustration always comes from the selected lead article and links to it',()=>{
    const sources = [articles[0],{...articles[1],image:'https://example.com/prestigious.jpg'}];
    const answer = {...result,paragraphs:['First paragraph','Second paragraph [Source](https://example.com/b)'],lead:2,groups:[{title:'Books',articles:[{id:1,summary:'First'},{id:2,summary:'Second'}]}],discard:[]};
    const parsed = imageCheck.apply(parseNewsletter(JSON.stringify(answer),sources),JSON.stringify({accepted:true,caption:'Original caption'}));
    assert.equal(parsed.image.source,sources[1].url);
    assert.equal(parsed.image.url,sources[1].image);
    const markdown = renderNewsletter(template,parsed,sources);
    assert.ok(markdown.includes('[![Original caption](https://example.com/prestigious.jpg)](https://example.com/b)'));
    assert.ok(!markdown.includes(sources[0].image));
    assert.throws(()=>parseNewsletter(JSON.stringify(answer),articles),/Invalid AI response/);
    assert.equal(parseNewsletter(JSON.stringify({...answer,image:null}),articles).image,null);
});


test('stored article IDs stay the same in the AI input and resolve independently of their position',()=>{
    const sources = [{...articles[0],id:41},{...articles[1],id:7}];
    const input = JSON.parse(writerRequest('Write',sources,[],[]).input);
    assert.deepEqual(input.articles.map(article=>article.id),[41,7]);
    const response = {...result,lead:41,groups:[{title:'Books',articles:[{id:41,summary:'Summary'}]}],discard:[7]};
    assert.deepEqual(parseNewsletter(JSON.stringify(response),sources).used,[sources[0].url]);
    assert.throws(()=>parseNewsletter(JSON.stringify({...response,lead:1}),sources),/Invalid AI response/);
});

test('an image from a review-only source is omitted when that article is not cited in the body',()=>{
    const response = {...result,paragraphs:['First paragraph','Second paragraph with no citation']};
    assert.equal(parseNewsletter(JSON.stringify(response),articles).image,null);
});
