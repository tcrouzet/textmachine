const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../../plugin/i18n').setLocale('en');
const {schema,day,availableArticles,briefArticles,briefRequest,parseBrief,renderPrompt,writerRequest,parseNewsletter,selectionRequest,parseSelection,summaryRequest,parseSummaries,parseEditorial,renderNewsletter,applyStatuses,feedUrl,feedUrls} = require('../../plugin/newsletter');
const illustrated = result=>({...result,image:{url:'illustrations/text-machine-2026-11-03.png',source:'',caption:'Original caption',verified:true,generated:true}});
const {generate} = require('../../plugin/ai/generate');
const template = fs.readFileSync(path.join(__dirname,'../../models/newsletter.md'),'utf8');
const article = (slug, extra = {}) => ({date:'2026-11-03',title:slug,url:'https://example.com/'+slug,source:'User',status:'',publish:'2026-11-01',content:'An article about AI and books.',image:'',...extra});
const articles = [article('a',{id:1,image:'https://example.com/image.jpg',imageCaption:'Original caption'}),article('b',{id:2})];
const data = JSON.stringify({version:1,notes:'Keep notes',articles});
const prompt = '{"instructions":"Editorial instructions","language":"{{language}}","articles":{{articles}},"previousNewsletters":{{previousNewsletters}},"recentPosts":{{recentPosts}}}';
const result = {title:'A new angle',chapeau:'Books and AI.',paragraphs:['First paragraph.','Second paragraph. [Source](https://example.com/a)','Last paragraph.'],
    lead:1,image:null,
    groups:[{title:'Literature',articles:[{id:1,summary:'Summary of the article.'}]}],discard:[2]};
const empty = {title:'',chapeau:'',paragraphs:[],lead:null,image:null,groups:[],discard:articles.map((_article,index)=>index+1)};

test('additional feeds accept Substack home pages and explicit RSS URLs',()=>{
    assert.equal(feedUrl(''),'');
    assert.equal(feedUrl('  '),'');
    assert.equal(feedUrl(' https://example.substack.com/ '),'https://example.substack.com/feed');
    assert.equal(feedUrl('https://example.substack.com/feed'),'https://example.substack.com/feed');
    assert.equal(feedUrl('https://example.com/rss.xml?category=books'),'https://example.com/rss.xml?category=books');
    assert.equal(feedUrl('https://notsubstack.com/'),'https://notsubstack.com/');
    for (const url of ['not a URL','file:///tmp/feed','javascript:alert(1)','https://user:pass@example.com/feed']) {
        assert.throws(()=>feedUrl(url),/valid HTTP or HTTPS/);
    }
    assert.deepEqual(feedUrls(' https://example.substack.com\nhttps://other.example/rss.xml\t https://example.substack.com/feed '),['https://example.substack.com/feed','https://other.example/rss.xml']);
    assert.deepEqual(feedUrls('  '),[]);
    assert.throws(()=>feedUrls('https://example.com/rss.xml file:///tmp/feed'),/valid HTTP or HTTPS/);
});

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
    const request = writerRequest(prompt,articles,[{content:'Earlier angle'}],[{title:'Latest blog post'}],'español');
    const context = JSON.parse(request.input);
    assert.equal(context.instructions,'Editorial instructions');
    assert.equal(context.language,'español');
    assert.ok(!request.system.includes('newsletter.md'));
    assert.ok(!request.system.includes('textmachine.json'));
    assert.ok(request.system.includes('"$schema"'));
    assert.deepEqual(context.articles.map(article=>article.id),[1,2]);
    assert.ok(!request.system.includes('{{#groups}}'));
    assert.ok(!request.input.includes('{{#groups}}'));
    assert.ok(!Object.hasOwn(JSON.parse(request.input),'template'));
    assert.deepEqual(JSON.parse(request.system.split('\n\n').at(-1)).jsonSchema,request.schema);
    assert.equal(request.schema.$schema,schema.$schema);
    const photos = JSON.parse(writerRequest(prompt,[articles[0],{...articles[0],id:3,imageCaption:''},{...articles[0],id:4,imageCaption:undefined},articles[1]],[],[]).input).articles;
    assert.ok(photos.every(article=>!Object.hasOwn(article,'hasImage') && !Object.hasOwn(article,'imageCaption')));
    assert.equal(context.previousNewsletters[0].content,'Earlier angle');
    assert.equal(context.recentPosts[0].title,'Latest blog post');
    assert.throws(()=>writerRequest('',articles,[],[]),/writer.md/);
});
test('structured output classifies every article once and rejects invented images or source URLs',()=>{
    const normalized = parseNewsletter(JSON.stringify(result),articles);
    assert.deepEqual(normalized.used,[articles[0].url]);
    assert.deepEqual(normalized.discard,[articles[1].url]);
    assert.equal(normalized.groups[0].articles[0].url,articles[0].url);
    assert.equal(normalized.image,null);
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
test('a custom writer prompt expands AuthorFeed, history and language without duplicating data',()=>{
    const source = 'Rédige en {{language}}.\n{{articles}}\nAnciennes notes : {{previousNewsletters}}\nPublications : {{AuthorFeed}}';
    const original = [{...articles[0],content:'Article body {{language}}'}];
    const previous = [{name:'text-machine-2000-01-01.md',content:'An earlier editorial angle'}];
    const recent = [{title:'Recent publication',url:'https://example.com/post',content:'New blog perspective'}];
    const request = writerRequest(source,original,previous,recent,'日本語');
    const input = request.input;
    assert.ok(input.includes('日本語'));
    for (const text of ['An earlier editorial angle','New blog perspective','Article body {{language}}']) {
        assert.equal(input.split(text).length-1,1);
    }
    assert.ok(!request.system.includes('An earlier editorial angle'));
    assert.ok(!input.includes('`previousNewsletters`'));
    assert.ok(!input.includes('`recentPosts`'));
    assert.ok(!input.includes('{{previousNewsletters}}'));
    assert.ok(!input.includes('{{recentPosts}}'));
    assert.ok(!input.includes('{{AuthorFeed}}'));
    assert.equal(JSON.parse(writerRequest(prompt,articles,[],[],' ').input).language,'français');
});
test('prompt substitution accepts spaces, preserves inserted text and rejects unknown variables',()=>{
    assert.equal(renderPrompt('{{ language }} / {{language}}',{language:'$& {{recentPosts}}'}),'$& {{recentPosts}} / $& {{recentPosts}}');
    assert.throws(()=>writerRequest('{{articles}} {{langauge}}',articles,[],[]),/\{\{langauge\}\}/);
    assert.throws(()=>writerRequest('Write the newsletter',articles,[],[]),/\{\{articles\}\}/);
    assert.throws(()=>writerRequest('{{articles}} {{summaries}}',articles,[],[]),/Unknown prompt variable: \{\{summaries\}\}/);
    assert.throws(()=>renderPrompt('{{toString}}',{}),/\{\{toString\}\}/);
    assert.throws(()=>renderPrompt('{{unknown-variable}}',{}),/\{\{unknown-variable\}\}/);
});
test('translated review titles are rendered without changing original article titles',()=>{
    const answer = {...result,groups:[{title:'Libros',articles:[{id:1,title:'Título traducido',summary:'Resumen.'}]}]};
    const normalized = parseNewsletter(JSON.stringify(answer),articles);
    const markdown = renderNewsletter(template,normalized,articles);
    assert.ok(markdown.includes('#### Título traducido'));
    assert.ok(markdown.includes('Source : [example.com](https://example.com/a)'));
    assert.equal(articles[0].title,'a');
    for (const title of ['',null,{}]) {
        assert.throws(()=>parseNewsletter(JSON.stringify({...answer,groups:[{title:'Libros',articles:[{id:1,title,summary:'Summary'}]}]}),articles),/Invalid AI response/);
    }
});
test('Markdown comes from the template, with its image after paragraph two and grouped sources',()=>{
    const parsed = illustrated(parseNewsletter(JSON.stringify(result),articles));
    const markdown = renderNewsletter(template,parsed,articles);
    assert.ok(markdown.startsWith('# A new angle\n\n*Books and AI.*'));
    assert.ok(markdown.indexOf('Second paragraph.') < markdown.indexOf('![Original caption]'));
    assert.ok(markdown.indexOf('![Original caption]') < markdown.indexOf('Last paragraph.'));
    assert.ok(markdown.includes('## Revue de presse\n\n### Literature\n\n#### a'));
    assert.ok(markdown.includes('Source : [example.com](https://example.com/a)'));
    assert.equal((markdown.match(/!\[/g)||[]).length,1);
    assert.ok(!markdown.includes('{{'));
    const withoutImage = renderNewsletter(template,{...parsed,image:null},articles);
    assert.ok(!withoutImage.includes('!['));
    assert.ok(!renderNewsletter(template,{...parsed,image:{...parsed.image,caption:''}},articles).includes('!['));
    assert.equal(markdown.split('Original caption').length-1,1);
    assert.ok(!markdown.includes('\n\n*Original caption*'));
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
    const input = JSON.parse(writerRequest(prompt,original,[],[]).input);
    assert.deepEqual(Object.keys(input.articles[0]),['id','title','url','source','publish','content']);
    assert.equal(input.articles[0].id,1);
    assert.ok(!Object.hasOwn(input.articles[0],'hasImage'));
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


test('the brief prompt receives only titles and IDs, in the configured language, with a strict output schema',()=>{
    const sources=[{...articles[0],status:'forbidden'},{...articles[1],status:'forbidden'}];
    const request=briefRequest('Runtime brief in {{ language }}.',sources,'français');
    assert.deepEqual(JSON.parse(request.input),sources.map(({id,title})=>({id,title})));
    assert.ok(request.system.startsWith('Runtime brief in français.'));
    assert.ok(!request.system.includes('{{ language }}'));
    assert.deepEqual(JSON.parse(request.system.split('\n\n').at(-1)).jsonSchema,request.schema);
    assert.deepEqual(request.schema.required,['titles']);
    assert.deepEqual(request.schema.properties.titles.items.required,['id','title']);
    assert.deepEqual(request.schema.properties.titles.items.properties.id.enum,[1,2]);
    const definition=require('../../models/bref.json');
    const expected=JSON.parse(JSON.stringify(definition));
    expected.properties.titles.minItems=expected.properties.titles.maxItems=2;
    expected.properties.titles.items.properties.id.enum=[1,2];
    assert.deepEqual(request.schema,expected);
    briefRequest('Translate into {{language}}',[{...sources[0],id:41}],'français');
    assert.deepEqual(request.schema.properties.titles.items.properties.id.enum,[1,2]);
    assert.ok(!Object.hasOwn(definition.properties.titles.items.properties.id,'enum'));
    assert.throws(()=>briefRequest('',sources,'français'),/bref.md.*empty/);
    assert.throws(()=>briefRequest('{{unknown}}',sources,'français'),/unknown/);
});

test('brief translations resolve stable IDs and preserve source order, URLs and original article data',()=>{
    const sources=[{...articles[0],id:41,status:'forbidden'},{...articles[1],id:7,status:'forbidden'}];
    const before=JSON.stringify(sources);
    const translated=parseBrief(JSON.stringify({titles:[{id:7,title:'Second titre'},{id:41,title:'Premier titre'}]}),sources);
    assert.deepEqual(translated.map(article=>article.title),['Premier titre','Second titre']);
    assert.deepEqual(translated.map(article=>article.url),sources.map(article=>article.url));
    assert.ok(translated.every(article=>article.status==='forbidden'));
    assert.equal(JSON.stringify(sources),before);
    for (const response of [null,{},[],{titles:[]},{titles:[{id:41,title:'Only one'}]},
        {titles:[{id:41,title:'First'},{id:41,title:'Duplicate'}]},
        {titles:[{id:41,title:'First'},{id:99,title:'Unknown'}]},
        {titles:[{id:41,title:'First'},{id:7,title:'   '}]},
        {titles:[{id:41,title:'First'},{id:7,title:'Second',url:'https://other.com'}]},
        {titles:[{id:41,title:'First'},{id:'7',title:'Second'}]}]) {
        assert.throws(()=>parseBrief(JSON.stringify(response),sources),/Translation.*incomplete or invalid/);
    }
});

test('forbidden articles appear only as translated linked titles in the brief section and stay forbidden',()=>{
    const forbidden = article('Blocked title',{status:'forbidden',content:'Unverified private content',image:'https://example.com/wrong.jpg'});
    const text = JSON.stringify({version:1,articles:[...articles,forbidden,article('old-forbidden',{status:'forbidden',usedAt:'2026-11-02'})]});
    const brief = briefArticles(text,'','2026-11-03');
    assert.deepEqual(brief.map(article=>article.title),['Blocked title']);
    assert.deepEqual(availableArticles(text,'','2026-11-03').map(article=>article.title),['a','b']);
    const parsed = illustrated(parseNewsletter(JSON.stringify(result),articles));
    const translated=brief.map(article=>({...article,title:'Titre traduit'}));
    const markdown = renderNewsletter(template,parsed,articles,translated);
    assert.ok(markdown.includes('### In brief\n\n* [Titre traduit](https://example.com/Blocked%20title)'));
    assert.ok(!markdown.includes('Unverified private content'));
    assert.ok(!markdown.includes('wrong.jpg'));
    assert.ok(markdown.indexOf('### In brief') > markdown.indexOf('Source :'));
    const saved = JSON.parse(applyStatuses(text,articles,parsed,'2026-11-03',brief));
    assert.equal(saved.articles[2].status,'forbidden');
    assert.equal(saved.articles[2].usedAt,'2026-11-03');
    assert.equal(saved.articles[2].content,'Unverified private content');
});

test('source photo availability does not change the selected source or provide the illustration',()=>{
    const answer={...result,lead:2,paragraphs:['First [B](https://example.com/b)','Second [A](https://example.com/a)'],
        groups:[{title:'Books',articles:[{id:1,summary:'First'},{id:2,summary:'Second'}]}],discard:[]};
    const parsed=parseNewsletter(JSON.stringify(answer),articles);
    assert.equal(parsed.lead,articles[1].url);
    assert.equal(parsed.image,null);
    assert.deepEqual(parsed.used,articles.map(article=>article.url));
});

test('the writer schema contains only article fields and no source or illustration selection',()=>{
    const request=writerRequest(prompt,articles,[],[]);
    assert.deepEqual(Object.keys(request.schema.properties),['title','chapeau','paragraphs']);
    assert.deepEqual(request.schema.required,['title','chapeau','paragraphs']);
    assert.equal(request.schema.additionalProperties,false);
    const definition=require('../../models/writer.json');
    assert.deepEqual(request.schema,definition);
    request.schema.properties.title.description='Changed request only';
    assert.deepEqual(writerRequest(prompt,articles,[],[]).schema,definition);
});

test('stored article IDs stay the same in the AI input and resolve independently of their position',()=>{
    const sources = [{...articles[0],id:41},{...articles[1],id:7}];
    const input = JSON.parse(writerRequest(prompt,sources,[],[]).input);
    assert.deepEqual(input.articles.map(article=>article.id),[41,7]);
    const response = {...result,lead:41,groups:[{title:'Books',articles:[{id:41,summary:'Summary'}]}],discard:[7]};
    assert.deepEqual(parseNewsletter(JSON.stringify(response),sources).used,[sources[0].url]);
    assert.throws(()=>parseNewsletter(JSON.stringify({...response,lead:1}),sources),/Invalid AI response/);
});

test('article JSON cannot override the generated illustration with source-image metadata',()=>{
    assert.throws(()=>parseNewsletter(JSON.stringify({...result,image:{caption:'Source photo'}}),articles),/Invalid AI response/);
    const parsed=parseNewsletter(JSON.stringify(result),articles);
    assert.equal(parsed.image,null);
    assert.ok(!renderNewsletter(template,parsed,articles).includes('!['));
});

test('editorial parsing rejects summaries, classifications and illustration fields',()=>{
    const article={title:'An angle',chapeau:'An introduction',paragraphs:['First','Second']};
    assert.deepEqual(parseEditorial(JSON.stringify(article)),article);
    for (const extra of [{groups:[]},{discard:[]},{image:null},{lead:1}]) assert.throws(()=>parseEditorial(JSON.stringify({...article,...extra})),/Invalid AI response/);
});

test('selection classifies all stable IDs once and ignores source image availability',()=>{
    const request=selectionRequest('Select sources in {{language}}: {{articles}}',articles,'français');
    assert.ok(request.system.includes('selected'));
    assert.deepEqual(request.schema.required,['selected','discard']);
    assert.ok(request.input.includes('français'));
    assert.ok(!request.input.includes('hasImage'));
    assert.ok(!request.input.includes('imageCaption'));
    const definition=require('../../models/selection.json');
    const expected=JSON.parse(JSON.stringify(definition));
    for (const key of ['selected','discard']) expected.properties[key].items.enum=[1,2];
    assert.deepEqual(request.schema,expected);
    assert.deepEqual(JSON.parse(request.system.split('\n\n').at(-1)).jsonSchema,expected);
    selectionRequest('{{articles}}',[{...articles[0],id:41}],'français');
    assert.deepEqual(request.schema.properties.selected.items.enum,[1,2]);
    assert.ok(!Object.hasOwn(definition.properties.selected.items,'enum'));
    const result=parseSelection(JSON.stringify({selected:[2],discard:[1]}),articles);
    assert.deepEqual(result.selected,[articles[1]]);
    assert.deepEqual(result.discard,[1]);
    for (const response of [{selected:[1],discard:[]},{selected:[1],discard:[1]},{selected:[99],discard:[2]},
        {selected:['1'],discard:[2]},{selected:[1],discard:[2],status:'used'},null]) {
        assert.throws(()=>parseSelection(JSON.stringify(response),articles),/Invalid AI response/);
    }
});

test('event chronology belongs to selection and is not passed to summaries or writing',t=>{
    const instant=Date.parse('2026-11-03T14:00:00Z');
    t.mock.timers.enable({apis:['Date'],now:instant});
    const sources=[{...articles[0],title:'Le prix sera remis mardi',publish:'2026-11-02T18:00:00Z'}];
    const prompt='{"now":"{{now}}","articles":{{articles}}}';
    const input=JSON.parse(selectionRequest(prompt,sources,'français').input);
    assert.equal(Date.parse(input.now),instant);
    assert.ok(input.now.includes('GMT'));
    assert.equal(input.articles[0].publish,'2026-11-02T18:00:00Z');
    assert.equal(input.articles[0].title,'Le prix sera remis mardi');
    assert.throws(()=>summaryRequest(prompt,sources,'français'),/Unknown prompt variable: \{\{now\}\}/);
    assert.throws(()=>writerRequest(prompt,sources,[],[],'français'),/Unknown prompt variable: \{\{now\}\}/);
});

test('summary output covers every selected source once and cannot select, discard or inject images',()=>{
    const request=summaryRequest('Summarize in {{language}}: {{articles}}',articles,'日本語');
    assert.deepEqual(request.schema.required,['groups']);
    assert.ok(!Object.hasOwn(request.schema.properties,'discard'));
    assert.ok(request.input.includes('日本語'));
    const definition=require('../../models/resume.json');
    const expected=JSON.parse(JSON.stringify(definition));
    expected.properties.groups.items.properties.articles.items.properties.id.enum=[1,2];
    assert.deepEqual(request.schema,expected);
    summaryRequest('{{articles}}',[{...articles[0],id:41}],'français');
    assert.deepEqual(request.schema.properties.groups.items.properties.articles.items.properties.id.enum,[1,2]);
    assert.ok(!Object.hasOwn(definition.properties.groups.items.properties.articles.items.properties.id,'enum'));
    const groups=[{title:'Livres',articles:articles.map(article=>({id:article.id,title:'Titre '+article.id,summary:'Résumé '+article.id}))}];
    assert.deepEqual(parseSummaries(JSON.stringify({groups}),articles),groups);
    for (const response of [{groups:[]},{groups,discard:[]},{groups:[...groups,...groups]},
        {groups:[{title:'Livres',articles:[{id:1,title:'Titre',summary:'Résumé'}]}]},
        {groups:[{title:'Livres',articles:[{id:1,title:'',summary:'Résumé'},{id:2,title:'Titre',summary:'Résumé'}]}]},
        {groups:[{title:'Livres',articles:[{id:1,title:'Titre',summary:'![Image](https://example.com/image.jpg)'},{id:2,title:'Titre',summary:'Résumé'}]}]}]) {
        assert.throws(()=>parseSummaries(JSON.stringify(response),articles),/Invalid AI response/);
    }
});

test('the original illustration is rendered even by a template that omits the image slot or has only brief items',()=>{
    const generated={url:'illustrations/illustration-0000000000000000.png',source:'',caption:'Original TextMachine illustration',verified:true,generated:true};
    const parsed={...parseNewsletter(JSON.stringify(result),articles),image:generated};
    const custom=renderNewsletter('# {{title}}\n\n{{chapeau}}',parsed,articles);
    assert.ok(custom.includes('](illustrations/illustration-0000000000000000.png)'));
    assert.ok(custom.includes('![Original TextMachine illustration]('));
    assert.equal(custom.split('Original TextMachine illustration').length-1,1);
    const brief=renderNewsletter(template,{title:'',chapeau:'',paragraphs:[],lead:null,image:generated,groups:[],used:[],discard:[]},[],[{title:'Brief item',url:'https://example.com/brief'}]);
    assert.ok(brief.includes('](illustrations/illustration-0000000000000000.png)'));
});

test('article prose is independent of the availability of source photos',()=>{
    const response = {...result,paragraphs:['First paragraph','Second paragraph with no citation']};
    assert.deepEqual(parseNewsletter(JSON.stringify(response),articles).paragraphs,response.paragraphs);
});
