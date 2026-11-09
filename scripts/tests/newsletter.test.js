const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../../plugin/i18n').setLocale('en');
const {day,availableArticles,briefArticles,briefRequest,parseBrief,renderPrompt,writerRequest,selectionRequest,selectArticles,parseSelection,isAuthorSource,assertNoAuthorSources,parseEditorial,parseWriter,publicationCount,publisherRequest,parsePublisher,renderNewsletter,applyStatuses,feedUrl,feedUrls} = require('../../plugin/newsletter');
const illustrated = result=>({...result,image:{url:'illustrations/text-machine-2026-11-03.png',source:'',caption:'Original caption',verified:true,generated:true}});
const {generate} = require('../../plugin/ai/generate');
const template = fs.readFileSync(path.join(__dirname,'../../models/newsletter.md'),'utf8');
const article = (slug, extra = {}) => ({date:'2026-11-03',title:slug,url:'https://example.com/'+slug,source:'User',authors:[],status:'',usedAt:'',publish:'2026-11-01',content:'An article about AI and books.',image:'',...extra});
const articles = [article('a',{id:1,image:'https://example.com/image.jpg',imageCaption:'Original caption'}),article('b',{id:2})];
const data = JSON.stringify({version:1,notes:'Keep notes',articles});
const prompt = '{"instructions":"Editorial instructions","language":"{{language}}","articles":{{articles}},"previousNewsletters":{{previousNewsletters}},"recentPosts":{{recentPosts}}}';
const result = {title:'A new angle',chapeau:'Books and AI.',paragraphs:['First paragraph.','Second paragraph. [Source](https://example.com/a)','Last paragraph.'],
    image:null,used:[articles[0].url],discard:[articles[1].url]};
const empty = {title:'',chapeau:'',paragraphs:[],image:null,used:[],discard:articles.map(article=>article.url)};

test('arXiv brief links open the abstract without changing stored articles or source eligibility',()=>{
    const links=[
        ['https://arxiv.org/pdf/2610.37916','https://arxiv.org/abs/2610.37916'],
        ['https://arxiv.org/pdf/2610.37916v2.pdf','https://arxiv.org/abs/2610.37916v2'],
        ['https://export.arxiv.org/pdf/hep-th/9901001v1.pdf','https://export.arxiv.org/abs/hep-th/9901001v1'],
        ['https://arxiv.org/abs/2610.37916','https://arxiv.org/abs/2610.37916'],
        ['https://arxiv.org.evil.example/pdf/2610.37916','https://arxiv.org.evil.example/pdf/2610.37916'],
        ['https://example.com/report.pdf','https://example.com/report.pdf'],
    ];
    const text=JSON.stringify({version:1,articles:links.map(([url],index)=>article('Paper '+index,{id:index+1,url,status:'forbidden',content:''}))});
    const brief=briefArticles(text,'','2026-11-03');
    const original=structuredClone(brief);
    const markdown=renderNewsletter(template,result,brief);
    for (const [index,[,url]] of links.entries()) assert.ok(markdown.includes(`[Paper ${index}](${url})`),url);
    assert.deepEqual(brief,original);
    assert.deepEqual(availableArticles(text,'','2026-11-03'),[]);
    const saved=JSON.parse(applyStatuses(text,[],result,'2026-11-03',brief));
    assert.deepEqual(saved.articles.map(row=>row.url),links.map(([url])=>url));
    assert.ok(saved.articles.every(row=>row.usedAt==='2026-11-03' && row.status==='forbidden'));
});

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

test('without folder history selection includes only new articles and today’s used articles',()=>{
    const text = JSON.stringify({version:1,articles:[...articles,article('today',{status:'used',usedAt:'2026-11-03'}),
        article('yesterday',{status:'used',usedAt:'2026-11-02'}),article('legacy',{status:'used'}),
        article('blocked',{status:'404'}),article('report.pdf'),article('no-content',{content:''})]});
    assert.deepEqual(availableArticles(text,'','2026-11-03').map(article=>article.title),['a','b','today']);
    assert.deepEqual(availableArticles(text,'example.com','2026-11-03'),[]);
    assert.equal(day(new Date(2026,10,3,23,59)),'2026-11-03');
});
test('missing consecutive editions reopen dated articles only after the last surviving edition',()=>{
    const entries=[article('new'),article('today',{usedAt:'2026-01-02'}),article('yesterday',{usedAt:'2026-01-01'}),
        article('year-end',{usedAt:'2025-12-31'}),article('last-edition',{usedAt:'2025-12-30'}),
        article('older',{usedAt:'2025-12-29'}),article('unknown',{usedAt:'unknown'}),article('future',{usedAt:'2026-01-03'}),
        article('pdf.pdf',{usedAt:'2026-01-01'}),article('empty',{usedAt:'2026-01-01',content:''}),
        article('blocked',{usedAt:'2026-01-01',status:'forbidden'}),article('old-blocked',{usedAt:'2025-12-30',status:'forbidden'})];
    const text=JSON.stringify({version:1,articles:entries});
    assert.deepEqual(availableArticles(text,'','2026-01-02',[],'2025-12-30').map(row=>row.title),['new','today','yesterday','year-end']);
    assert.deepEqual(briefArticles(text,'','2026-01-02','2025-12-30').map(row=>row.title),['blocked']);
    assert.deepEqual(availableArticles(text,'','2026-01-02',[],'2026-01-01').map(row=>row.title),['new','today']);
    assert.deepEqual(availableArticles(text,'','2026-01-02',[],'').map(row=>row.title),['new','today','yesterday','year-end','last-edition','older']);
    assert.deepEqual(briefArticles(text,'','2026-01-02','').map(row=>row.title),['blocked','old-blocked']);
    assert.deepEqual(availableArticles(text,'example.com','2026-01-02',[],'2025-12-30'),[]);
    assert.equal(JSON.parse(text).articles[2].usedAt,'2026-01-01');
});
test('legacy used articles are recovered only when explicitly linked from today’s newsletter',()=>{
    const text = JSON.stringify({version:1,articles:[article('legacy',{status:'used'}),article('other',{status:'used'})]});
    assert.deepEqual(availableArticles(text,'','2026-11-03',['[Source](https://example.com/legacy)']).map(article=>article.title),['legacy']);
    assert.deepEqual(availableArticles(text,'','2026-11-03',['[Source](https://example.com/legacy-extra)']),[]);
});
test('usedAt consumes the complete available pool while allowing same-day regeneration',()=>{
    const pending=[...articles,article('third',{id:3})];
    const blocked=article('blocked',{id:4,status:'forbidden',content:''});
    const incoming=article('arrived-during-generation',{id:5});
    const original=JSON.stringify({version:1,articles:[...pending,blocked,incoming]});
    const saved=applyStatuses(original,pending,{used:[pending[0].url],discard:[pending[1].url]},'2026-11-03',[blocked]);
    const rows=JSON.parse(saved).articles;
    assert.ok(rows.every(row=>!Object.hasOwn(row,'used')));
    assert.equal(rows[4].usedAt,'');
    assert.deepEqual(rows.map(row=>row.status),['','','','forbidden','']);
    assert.deepEqual(rows.slice(0,4).map(row=>row.usedAt),Array(4).fill('2026-11-03'));
    assert.deepEqual(availableArticles(saved,'','2026-11-03').map(row=>row.id),[1,2,3,5]);
    assert.deepEqual(availableArticles(saved,'','2026-11-04').map(row=>row.id),[5]);
    assert.deepEqual(briefArticles(saved,'','2026-11-04'),[]);
});
test('concurrent usage changes are preserved instead of reassigned to the current edition',()=>{
    const changed={...articles[0],usedAt:'2026-11-02'};
    const saved=JSON.parse(applyStatuses(JSON.stringify({version:1,articles:[changed]}),articles,
        {used:[changed.url],discard:[]},'2026-11-03'));
    assert.deepEqual(saved.articles[0],changed);
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
    assert.equal(request.schema.$schema,require('../../models/writer.json').$schema);
    const photos = JSON.parse(writerRequest(prompt,[articles[0],{...articles[0],id:3,imageCaption:''},{...articles[0],id:4,imageCaption:undefined},articles[1]],[],[]).input).articles;
    assert.ok(photos.every(article=>!Object.hasOwn(article,'hasImage') && !Object.hasOwn(article,'imageCaption')));
    assert.equal(context.previousNewsletters[0].content,'Earlier angle');
    assert.equal(context.recentPosts[0].title,'Latest blog post');
    assert.throws(()=>writerRequest('',articles,[],[]),/writer.md/);
});
test('selection classifies every article once and rejects invented sources or extra fields',()=>{
    const answer={brief:[], selected:[1],discard:[2]};
    const normalized=parseSelection(JSON.stringify(answer),articles);
    assert.deepEqual(normalized.selected,[articles[0]]);
    assert.deepEqual(normalized.discard,[2]);
    for (const changed of [
        {...answer,discard:[]},{...answer,selected:[1,1]},{...answer,discard:[3]},
        {...answer,discard:['2']},{...answer,discard:[1.5]},{...answer,selected:[99]},
        {...answer,selected:[2]},{...answer,image:{url:'https://example.com/invented.jpg'}},
        {...answer,selected:[0]},{...answer,status:'used'},
        {markdown:'# Old output',used:[articles[0].url],discard:[articles[1].url]},
    ]) assert.throws(()=>parseSelection(JSON.stringify(changed),articles),/Invalid AI response/);
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
test('translated brief titles are rendered without changing original article titles',()=>{
    const translated=parseBrief(JSON.stringify({titles:[{id:1,title:'Título traducido',category:'Escritura'}]}),[articles[0]]);
    const markdown=renderNewsletter(template,result,translated);
    assert.ok(markdown.includes('* [Título traducido](https://example.com/a) - [example.com](https://example.com/)'));
    const subdomain=renderNewsletter(template,result,[{title:'Research [results]',url:'https://news.example.co.uk/article?q=1#section',source:'Google Alerts'}]);
    assert.ok(subdomain.includes('* [Research \\[results\\]](https://news.example.co.uk/article?q=1#section) - [example.co.uk](https://example.co.uk/)'));
    assert.ok(!subdomain.includes('Google Alerts'));
    assert.equal(articles[0].title,'a');
    for (const title of ['',{},false,0]) {
        assert.throws(()=>parseBrief(JSON.stringify({titles:[{id:1,title,category:'Écriture'}]}),[articles[0]]),/Translation.*incomplete or invalid/);
    }
});

test('brief categories preserve every retained link and group related items in the proposed order',()=>{
    const sources=[...articles,{...articles[0],id:3},{...articles[0],id:4}].map(article=>({...article,url:'https://example.com/brief-'+article.id}));
    const before=JSON.stringify(sources);
    const translated=parseBrief(JSON.stringify({titles:[
        {id:2,title:'Un outil pour écrire',category:'Outils'},
        {id:1,title:'Un roman',category:'Création'},
        {id:4,title:'Une étude',category:'Recherche'},
        {id:3,title:'Un autre roman',category:'Création'},
    ]}),sources,sources);
    assert.deepEqual(translated.map(article=>article.id),[2,1,4,3]);
    const markdown=renderNewsletter(template,result,translated);
    assert.equal((markdown.match(/#### Création/g) || []).length,1);
    assert.ok(markdown.indexOf('#### Outils')<markdown.indexOf('#### Création'));
    assert.ok(markdown.indexOf('[Un autre roman]')<markdown.indexOf('#### Recherche'));
    for (const source of sources) assert.equal(markdown.split(']('+source.url+')').length-1,1);
    assert.equal(JSON.stringify(sources),before);
    const briefOnly=renderNewsletter(template,{title:'',chapeau:'',paragraphs:[],image:null,used:[],discard:[]},translated);
    assert.ok(briefOnly.includes('## Outils'));
    assert.ok(!briefOnly.includes('#### Outils'));
});

test('brief categories are mandatory for retained titles and null only for rejected titles',()=>{
    for (const row of [
        {id:1,title:'Titre'}, {id:1,title:'Titre',category:''}, {id:1,title:'Titre',category:'   '},
        {id:1,title:'Titre',category:null}, {id:1,title:'Titre',category:12},
        {id:1,title:null,category:'Recherche'},
    ]) assert.throws(()=>parseBrief(JSON.stringify({titles:[row]}),[articles[0]]),/incomplete or invalid/);
    assert.deepEqual(parseBrief(JSON.stringify({titles:[{id:1,title:null,category:null}]}),[articles[0]]),[]);
});

test('Markdown comes from the template, with its image after paragraph two and no separate summaries',()=>{
    const template='# {{title}}\n\n*{{chapeau}}*\n\n{{paragraphs_before_image}}\n\n{{image}}\n\n{{paragraphs_after_image}}';
    const parsed = illustrated(result);
    const markdown = renderNewsletter(template,parsed);
    assert.ok(markdown.startsWith('# A new angle\n\n*Books and AI.*'));
    assert.ok(markdown.indexOf('Second paragraph.') < markdown.indexOf('![Original caption]'));
    assert.ok(markdown.indexOf('![Original caption]') < markdown.indexOf('Last paragraph.'));
    assert.ok(!markdown.includes('## Revue de presse'));
    assert.ok(!markdown.includes('Source :'));
    assert.ok(markdown.includes('[Source](https://example.com/a)'));
    assert.equal((markdown.match(/!\[/g)||[]).length,1);
    assert.ok(!markdown.includes('{{'));
    const withoutImage = renderNewsletter(template,{...parsed,image:null});
    assert.ok(!withoutImage.includes('!['));
    assert.ok(!renderNewsletter(template,{...parsed,image:{...parsed.image,caption:''}}).includes('!['));
    assert.equal(markdown.split('Original caption').length-1,1);
    assert.ok(!markdown.includes('\n\n*Original caption*'));
    assert.ok(!renderNewsletter(template,result).includes('!['));
    for (const bad of ['# {{unknown}}','# {{title}}\n{{#title}}bad{{/title}}','# {{title}}\n{{#groups}}']) {
        assert.throws(()=>renderNewsletter(bad,parsed),/template/);
    }
    assert.ok(renderNewsletter(template,{...parsed,paragraphs:['Literal {{title}}','Second paragraph']}).includes('Literal {{title}}'));
});
test('status updates timestamp today and preserve annotations and concurrent edits',()=>{
    const changed = JSON.parse(data);
    changed.articles[0].custom = 'Keep annotation';
    changed.articles[1].content = 'Edited in the meantime';
    const parsed = result;
    const saved = JSON.parse(applyStatuses(JSON.stringify(changed),articles,parsed,'2026-11-03'));
    assert.equal(saved.notes,'Keep notes');
    assert.equal(saved.articles[0].status,'');
    assert.ok(!Object.hasOwn(saved.articles[0],'used'));
    assert.equal(saved.articles[0].usedAt,'2026-11-03');
    assert.equal(saved.articles[0].custom,'Keep annotation');
    assert.equal(saved.articles[1].status,'');
    changed.articles[0].status = 'discard';
    assert.equal(JSON.parse(applyStatuses(JSON.stringify(changed),articles,parsed,'2026-11-03')).articles[0].status,'discard');
});
test('all irrelevant articles can be discarded without generating a note',()=>{
    const classified = empty;
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
    assert.deepEqual(Object.keys(input.articles[0]),['id','title','url','source','authors','publish','content']);
    assert.equal(input.articles[0].id,1);
    assert.ok(!Object.hasOwn(input.articles[0],'hasImage'));
    assert.equal(JSON.stringify(original),before);
    assert.ok(JSON.stringify(input.articles).length < before.length);
    assert.ok(!JSON.stringify(input).includes('Do not send'));
});

test('stored AI IDs resolve through the original snapshot even if the article file is reordered',()=>{
    const normalized = result;
    const current = {version:1,articles:[{...articles[1],privateNotes:'Keep B'},{...articles[0],privateNotes:'Keep A'}]};
    const saved = JSON.parse(applyStatuses(JSON.stringify(current),articles,normalized,'2026-11-03'));
    assert.equal(saved.articles[0].url,articles[1].url);
    assert.equal(saved.articles[0].status,'');
    assert.ok(!Object.hasOwn(saved.articles[0],'used'));
    assert.equal(saved.articles[0].privateNotes,'Keep B');
    assert.equal(saved.articles[1].url,articles[0].url);
    assert.equal(saved.articles[1].status,'');
    assert.ok(!Object.hasOwn(saved.articles[1],'used'));
    assert.equal(saved.articles[1].usedAt,'2026-11-03');
    assert.equal(saved.articles[1].privateNotes,'Keep A');
    assert.deepEqual(saved.articles.map(article=>article.id),[2,1]);
});


test('unverified brief sources supply only titles and IDs with the configured language and a strict output schema',()=>{
    const sources=[{...articles[0],status:'forbidden'},{...articles[1],status:'forbidden'}];
    const request=briefRequest('Runtime brief in {{ language }}.',sources,'français');
    assert.deepEqual(JSON.parse(request.input),sources.map(({id,title})=>({id,title})));
    assert.ok(request.system.startsWith('Runtime brief in français.'));
    assert.ok(!request.system.includes('{{ language }}'));
    assert.deepEqual(JSON.parse(request.system.split('\n\n').at(-1)).jsonSchema,request.schema);
    assert.deepEqual(request.schema.required,['titles']);
    assert.deepEqual(request.schema.properties.titles.items.required,['id','title','category']);
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

test('brief translation receives bounded context only from readable articles without exposing article state',()=>{
    const readable={...articles[0],title:'Making documentation pages agent friendly',content:'Agents need readable documentation. '.repeat(100),privateNotes:'Private annotation'};
    const blocked={...articles[1],status:'forbidden',content:'Unverified content must never be used'};
    const before=JSON.stringify([readable,blocked]);
    const request=briefRequest('Brief in {{language}}',[readable,blocked],'français',[readable]);
    assert.deepEqual(JSON.parse(request.input),[
        {id:readable.id,title:readable.title,context:readable.content.slice(0,2000)},
        {id:blocked.id,title:blocked.title},
    ]);
    assert.ok(!request.input.includes('Private annotation'));
    assert.ok(!request.input.includes('Unverified content'));
    assert.equal(JSON.stringify([readable,blocked]),before);
    assert.deepEqual(request.schema.properties.titles.items.required,['id','title','category']);
    assert.throws(()=>parseBrief(JSON.stringify({titles:[{id:readable.id,title:'Titre',category:'Écriture',context:'Unexpected output'}]}),[readable]),/incomplete or invalid/);
});

test('brief translations resolve stable IDs in the proposed order and preserve URLs and original article data',()=>{
    const sources=[{...articles[0],id:41,status:'forbidden'},{...articles[1],id:7,status:'forbidden'}];
    const before=JSON.stringify(sources);
    const translated=parseBrief(JSON.stringify({titles:[{id:7,title:'Second titre',category:'Écriture'},{id:41,title:'Premier titre',category:'Écriture'}]}),sources);
    assert.deepEqual(translated.map(article=>article.title),['Second titre','Premier titre']);
    assert.deepEqual(translated.map(article=>article.url),[sources[1].url,sources[0].url]);
    assert.ok(translated.every(article=>article.status==='forbidden'));
    assert.equal(JSON.stringify(sources),before);
    for (const response of [null,{},[],{titles:[]},{titles:[{id:41,title:'Only one'}]},
        {titles:[{id:41,title:'First'},{id:41,title:'Duplicate'}]},
        {titles:[{id:41,title:'First'},{id:99,title:'Unknown'}]},
        {titles:[{id:41,title:'First'},{id:7,title:'   '}]},
        {titles:[{id:41,title:'First'},{id:7,title:'Second',url:'https://other.com'}]},
        {titles:[{id:41,title:'First'},{id:'7',title:'Second'}]}]) {
        const categorized=response && Array.isArray(response.titles)
            ? {...response,titles:response.titles.map(row=>({category:'Écriture',...row}))} : response;
        assert.throws(()=>parseBrief(JSON.stringify(categorized),sources),/Translation.*incomplete or invalid/);
    }
});

test('forbidden articles appear only as translated linked titles in the brief section and stay forbidden',()=>{
    const forbidden = article('Blocked title',{status:'forbidden',content:'Unverified private content',image:'https://example.com/wrong.jpg'});
    const text = JSON.stringify({version:1,articles:[...articles,forbidden,article('old-forbidden',{status:'forbidden',used:1,usedAt:'2026-11-02'})]});
    const brief = briefArticles(text,'','2026-11-03');
    assert.deepEqual(brief.map(article=>article.title),['Blocked title']);
    assert.deepEqual(availableArticles(text,'','2026-11-03').map(article=>article.title),['a','b']);
    const parsed = illustrated(result);
    const translated=brief.map(article=>({...article,title:'Titre traduit'}));
    const markdown = renderNewsletter(template,parsed,translated);
    assert.ok(markdown.includes('### In brief\n\n* [Titre traduit](https://example.com/Blocked%20title)'));
    assert.ok(!markdown.includes('Unverified private content'));
    assert.ok(!markdown.includes('wrong.jpg'));
    assert.ok(markdown.indexOf('### In brief') > markdown.indexOf('Last paragraph.'));
    const saved = JSON.parse(applyStatuses(text,articles,parsed,'2026-11-03',brief));
    assert.equal(saved.articles[2].status,'forbidden');
    assert.equal(saved.articles[2].usedAt,'2026-11-03');
    assert.equal(saved.articles[2].content,'Unverified private content');
});

test('source photo availability does not change the selected source or provide the illustration',()=>{
    const parsed=parseSelection(JSON.stringify({brief:[], selected:[2,1],discard:[]}),articles);
    assert.deepEqual(parsed.selected.map(article=>article.url),articles.map(article=>article.url));
    const input=JSON.parse(writerRequest(prompt,parsed.selected,[],[]).input);
    assert.ok(input.articles.every(article=>!Object.hasOwn(article,'image')));
    assert.ok(!renderNewsletter(template,result).includes('!['));
});

test('the writer identifies supplied sources actually used without returning state or illustration data',()=>{
    const request=writerRequest(prompt,articles,[],[]);
    assert.deepEqual(Object.keys(request.schema.properties),['paragraphs','used']);
    assert.deepEqual(request.schema.required,['paragraphs','used']);
    assert.equal(request.schema.additionalProperties,false);
    const definition=require('../../models/writer.json');
    const expected=structuredClone(definition);expected.properties.used.items.enum=[1,2];
    assert.deepEqual(request.schema,expected);
    assert.ok(!Object.hasOwn(definition.properties.used.items,'enum'));
    request.schema.properties.paragraphs.description='Changed request only';
    assert.deepEqual(writerRequest(prompt,articles,[],[]).schema,expected);
    const sources=[articles[0],{...articles[1],url:'https://other.example/b'}];
    const paragraphs=['A major finding in [one publication](https://example.com/a).','A different fact in [another publication](https://other.example/b).'];
    assert.deepEqual(parseWriter(JSON.stringify({paragraphs,used:[1,2]}),sources),{paragraphs,used:sources});
    assert.deepEqual(parseWriter(JSON.stringify({paragraphs:[],used:[]}),articles),{paragraphs:[],used:[]});
    assert.throws(()=>parseWriter(JSON.stringify({paragraphs,used:[1]}),sources),error=>error.code==='RP_TOO_FEW_SOURCES');
    assert.throws(()=>parseWriter(JSON.stringify({paragraphs,used:[1,2]}),articles),error=>error.code==='RP_TOO_FEW_SOURCES');
    for (const invalid of [{paragraphs},{paragraphs,used:[99]},{paragraphs,used:[1,1]},{paragraphs,used:['1']},
        {paragraphs,used:[]},{paragraphs:[],used:[1]},{paragraphs,used:[1],status:'used'}])
        assert.throws(()=>parseWriter(JSON.stringify(invalid),articles),/Invalid AI response/);
});

test('stored article IDs stay the same in the AI input and resolve independently of their position',()=>{
    const sources = [{...articles[0],id:41},{...articles[1],id:7}];
    const input = JSON.parse(writerRequest(prompt,sources,[],[]).input);
    assert.deepEqual(input.articles.map(article=>article.id),[41,7]);
    const response = {brief:[], selected:[41],discard:[7]};
    assert.deepEqual(parseSelection(JSON.stringify(response),sources).selected.map(article=>article.url),[sources[0].url]);
    assert.throws(()=>parseSelection(JSON.stringify({...response,selected:[1]}),sources),/Invalid AI response/);
});

test('several posts and subdomains of one publication still count as one voice',()=>{
    const sources=[{...articles[0],url:'https://idratherbewriting.com/blog/docs-at-scale-with-andrew-etter'},
        {...articles[1],url:'https://www.idratherbewriting.com/blog/review-maniac-labatut-rationality-end-of-play'}];
    assert.equal(publicationCount(sources),1);
    assert.throws(()=>parseWriter(JSON.stringify({paragraphs:['First post.','Second post.'],used:[1,2]}),sources),
        error=>error.code==='RP_TOO_FEW_SOURCES');
    assert.equal(publicationCount([...sources,{...articles[0],url:'https://another.example/article'}]),2);
    assert.equal(publicationCount([{...articles[0],url:'https://news.example.co.uk/a'},{...articles[1],url:'https://blog.example.co.uk/b'}]),1);
});

test('article JSON cannot override the generated illustration with source-image metadata',()=>{
    assert.throws(()=>parseEditorial(JSON.stringify({paragraphs:result.paragraphs,image:{caption:'Source photo'}})),/Invalid AI response/);
    const parsed=result;
    assert.equal(parsed.image,null);
    assert.ok(!renderNewsletter(template,parsed).includes('!['));
});

test('editorial parsing rejects summaries, classifications and illustration fields',()=>{
    const article={paragraphs:['First','Second']};
    assert.deepEqual(parseEditorial(JSON.stringify(article)),article);
    for (const paragraphs of [[],['Only one paragraph'],['![Extra image](https://example.com/image.jpg)','Second paragraph']]) {
        assert.throws(()=>parseEditorial(JSON.stringify({paragraphs})),/Invalid AI response/);
    }
    for (const extra of [{title:'Premature title'},{chapeau:'Premature introduction'},{groups:[]},{discard:[]},{image:null},{lead:1}]) assert.throws(()=>parseEditorial(JSON.stringify({...article,...extra})),/Invalid AI response/);
});
test('publisher receives only the final body and returns a separate title and introduction',()=>{
    const paragraphs=['A concrete result. {{language}}','Another finding. [Source](https://example.com/article)'];
    const request=publisherRequest('Présente en {{language}} :\n{{article}}',paragraphs,'français');
    assert.equal(request.input,'Présente en français :\n'+paragraphs.join('\n\n'));
    assert.deepEqual(request.schema,require('../../models/publisher.json'));
    assert.deepEqual(request.schema.required,['title','chapeau']);
    assert.deepEqual(Object.keys(request.schema.properties),['title','chapeau']);
    assert.equal(request.schema.additionalProperties,false);
    assert.ok(!request.system.includes(paragraphs[1]));
    const publication={title:'A concrete title',chapeau:'A short introduction.'};
    assert.deepEqual(parsePublisher(JSON.stringify(publication)),publication);
    assert.equal(parsePublisher(JSON.stringify({...publication,title:'IA : Correcteurs et bulletins scolaires'})).title,'Correcteurs et bulletins scolaires');
    for (const invalid of ['{broken','null','[]',JSON.stringify({...publication,paragraphs}),JSON.stringify({title:'',chapeau:'Intro'}),JSON.stringify({title:'Title'})]) {
        assert.throws(()=>parsePublisher(invalid),/Invalid AI response/);
    }
    assert.throws(()=>publisherRequest('',paragraphs,'français'),/publisher.md/);
    assert.throws(()=>publisherRequest('Write a title',paragraphs,'français'),/\{\{article\}\}/);
});

test('selection keeps relevant secondary news separate from the RP and rejects overlaps or omissions',()=>{
    const sources=[articles[0],articles[1],article('Off topic',{id:3})];
    const choice={selected:[1],brief:[2],discard:[3]};
    assert.deepEqual(parseSelection(JSON.stringify(choice),sources),{selected:[sources[0]],brief:[sources[1]],discard:[3]});
    for (const invalid of [{selected:[1],discard:[2,3]},{...choice,brief:[]},{...choice,brief:[1,2]},
        {...choice,brief:[99]},{...choice,brief:[2,2]},{...choice,brief:['2']}])
        assert.throws(()=>parseSelection(JSON.stringify(invalid),sources),/Invalid AI response/);
});

test('selection batching retains secondary articles from every batch and the final comparison',async()=>{
    const sources=Array.from({length:4},(_,index)=>article('Source '+index,{id:index+1,content:'x'.repeat(400000)}));
    let calls=0;
    const result=await selectArticles(sources,rows=>selectionRequest('{{articles}}',rows,'français'),async request=>{
        calls++;
        assert.ok(request.input.length<=1000000);
        const rows=JSON.parse(request.input);
        assert.ok(rows.every(row=>row.content.length===400000));
        return JSON.stringify({selected:[rows[0].id],brief:rows.slice(1).map(row=>row.id),discard:[]});
    });
    assert.equal(calls,3);
    assert.deepEqual(result.selected.map(row=>row.id),[1]);
    assert.deepEqual(result.brief.map(row=>row.id),[2,4,3]);
    assert.deepEqual(result.discard,[]);
});

test('confirmed relevant brief articles must all survive translation while blocked off-topic titles may be rejected',()=>{
    const blocked=article('Blocked',{id:3,status:'forbidden',content:''});
    const pool=[...articles,blocked],request=briefRequest('Brief {{language}}',pool,'français',articles);
    assert.ok(request.system.includes('1, 2'));
    const answer={titles:[{id:1,title:'Premier titre',category:'Écriture'},{id:2,title:'Autre nouvelle',category:'Écriture'},{id:3,title:null,category:null}]};
    assert.deepEqual(parseBrief(JSON.stringify(answer),pool,articles).map(row=>row.id),[1,2]);
    answer.titles[1].title=null;
    answer.titles[1].category=null;
    assert.throws(()=>parseBrief(JSON.stringify(answer),pool,articles),/incomplete or invalid/);
});

test('the introduction has a mandatory 35-word maximum, including French nonbreaking spaces',()=>{
    const chapeau=Array.from({length:35},(_,index)=>'mot'+index).join('\u00a0');
    assert.equal(parsePublisher(JSON.stringify({title:'Titre',chapeau})).chapeau,chapeau);
    assert.throws(()=>parsePublisher(JSON.stringify({title:'Titre',chapeau:chapeau+' mot36'})),
        error=>error.code==='CHAPEAU_TOO_LONG' && error.message.includes('36'));
    assert.throws(()=>parsePublisher(JSON.stringify({title:'Titre',chapeau:chapeau+':mot36'})),
        error=>error.code==='CHAPEAU_TOO_LONG' && error.message.includes('36'));
});
test('author feeds identify their publications without excluding other publications on the same platform',()=>{
    const feeds='https://writer.substack.com/feed https://example.com/blog/feed';
    for (const url of ['https://writer.substack.com/p/post','https://www.writer.substack.com/p/post?utm_source=mail','https://example.com/blog/post']) {
        assert.equal(isAuthorSource(url,feeds),true,url);
        assert.throws(()=>assertNoAuthorSources(['A reference [Post]('+url+')'],feeds,[]),/author-feed/);
    }
    for (const url of ['https://another.substack.com/p/post','https://writer.substack.com.evil.example/p/post','https://example.com/other/post']) {
        assert.equal(isAuthorSource(url,feeds),false,url);
    }
    const posts=[{url:'https://custom-author.example/story',title:'Existing topic',content:'Already published'}];
    assert.equal(isAuthorSource('https://custom-author.example/story?utm_source=newsletter','https://feeds.example/author.xml',posts),true);
    const prompt='{"articles":{{articles}},"history":{{AuthorFeed}}}';
    const context=JSON.parse(selectionRequest(prompt,articles,'français','',[],posts).input);
    assert.deepEqual(context.history,posts);
    assert.deepEqual(context.articles.map(article=>article.id),[1,2]);
});

test('selection classifies all stable IDs once and ignores source image availability',()=>{
    const request=selectionRequest('Select sources in {{language}}: {{articles}}',articles,'français');
    assert.ok(request.system.includes('selected'));
    assert.deepEqual(request.schema.required,['selected','brief','discard']);
    assert.ok(request.input.includes('français'));
    assert.ok(!request.input.includes('hasImage'));
    assert.ok(!request.input.includes('imageCaption'));
    const definition=require('../../models/selection.json');
    const expected=JSON.parse(JSON.stringify(definition));
    for (const key of ['selected','brief','discard']) expected.properties[key].items.enum=[1,2];
    assert.deepEqual(request.schema,expected);
    assert.deepEqual(JSON.parse(request.system.split('\n\n').at(-1)).jsonSchema,expected);
    selectionRequest('{{articles}}',[{...articles[0],id:41}],'français');
    assert.deepEqual(request.schema.properties.selected.items.enum,[1,2]);
    assert.ok(!Object.hasOwn(definition.properties.selected.items,'enum'));
    const result=parseSelection(JSON.stringify({brief:[], selected:[2],discard:[1]}),articles);
    assert.deepEqual(result.selected,[articles[1]]);
    assert.deepEqual(result.discard,[1]);
    for (const response of [{brief:[], selected:[1],discard:[]},{brief:[], selected:[1],discard:[1]},{brief:[], selected:[99],discard:[2]},
        {brief:[], selected:['1'],discard:[2]},{brief:[], selected:[1],discard:[2],status:'used'},null]) {
        assert.throws(()=>parseSelection(JSON.stringify(response),articles),/Invalid AI response/);
    }
});
test('selection expands previous newsletters as data without changing the output schema',()=>{
    const prompt='{"language":"{{language}}","previousNewsletters":{{ previousNewsletters }},"articles":{{articles}}}';
    const previous=[{name:'text-machine-2026-11-03.md',content:'An earlier report on the Orélien affair. {{articles}}'}];
    const request=selectionRequest(prompt,articles,'français','',previous);
    const input=JSON.parse(request.input);
    assert.deepEqual(input.previousNewsletters,previous);
    assert.deepEqual(input.articles.map(article=>article.id),[1,2]);
    assert.ok(!request.system.includes(previous[0].content));
    assert.deepEqual(request.schema.required,['selected','brief','discard']);
    assert.deepEqual(JSON.parse(selectionRequest(prompt,articles,'français').input).previousNewsletters,[]);
});

test('reference domains identify preferred sources in selection and writing without filtering articles',()=>{
    const candidates=[
        article('Guardian',{id:41,url:'https://books.theguardian.com/story'}),
        article('BBC',{id:42,url:'https://news.bbc.co.uk/story'}),
        article('Lookalike',{id:43,url:'https://theguardian.com.evil.example/story'}),
        article('Other Guardian',{id:44,url:'https://eviltheguardian.com/story'}),
        article('Other UK',{id:45,url:'https://other.co.uk/story'}),
    ];
    const before=JSON.stringify(candidates);
    const domains='WWW.THEGUARDIAN.COM, https://news.bbc.co.uk/culture\nwww.theguardian.com; not-a-domain javascript:alert(1)';
    const contract=require('../../plugin/i18n').t('referenceSourcesContract',{ids:'41, 42'});
    for (const makeRequest of [sources=>selectionRequest('{{articles}}',candidates,'English',sources),
        sources=>writerRequest('{{articles}}',candidates,[],[],'English',sources)]) {
        const request=makeRequest(domains);
        assert.ok(request.system.includes(contract));
        assert.deepEqual(JSON.parse(request.input).map(article=>article.id),[41,42,43,44,45]);
        assert.deepEqual(request.schema,makeRequest('').schema);
        assert.deepEqual(JSON.parse(request.system.split('\n\n').at(-1)).jsonSchema,request.schema);
        for (const unmatched of ['', 'unknown.example', 'javascript:alert(1) invalid https://reader:fixture@theguardian.com']) {
            assert.equal(makeRequest(unmatched).system,makeRequest('').system);
        }
    }
    assert.equal(JSON.stringify(candidates),before);
});

test('event chronology belongs to selection and is not passed to writing',t=>{
    const instant=Date.parse('2026-11-03T14:00:00Z');
    t.mock.timers.enable({apis:['Date'],now:instant});
    const sources=[{...articles[0],title:'Le prix sera remis mardi',publish:'2026-11-02T18:00:00Z'}];
    const prompt='{"now":"{{now}}","articles":{{articles}}}';
    const input=JSON.parse(selectionRequest(prompt,sources,'français').input);
    assert.equal(Date.parse(input.now),instant);
    assert.ok(input.now.includes('GMT'));
    assert.equal(input.articles[0].publish,'2026-11-02T18:00:00Z');
    assert.equal(input.articles[0].title,'Le prix sera remis mardi');
    assert.throws(()=>writerRequest(prompt,sources,[],[],'français'),/Unknown prompt variable: \{\{now\}\}/);
});


test('the original illustration is rendered even by a template that omits the image slot or has only brief items',()=>{
    const generated={url:'illustrations/illustration-0000000000000000.png',source:'',caption:'Original TextMachine illustration',verified:true,generated:true};
    const parsed={...result,image:generated};
    const custom=renderNewsletter('# {{title}}\n\n{{chapeau}}',parsed);
    assert.ok(custom.includes('](illustrations/illustration-0000000000000000.png)'));
    assert.ok(custom.includes('![Original TextMachine illustration]('));
    assert.equal(custom.split('Original TextMachine illustration').length-1,1);
    const brief=renderNewsletter(template,{title:'',chapeau:'',paragraphs:[],image:generated,used:[],discard:[]},[{title:'Brief item',url:'https://example.com/brief'}]);
    assert.ok(brief.includes('](illustrations/illustration-0000000000000000.png)'));
});

test('article prose is independent of the availability of source photos',()=>{
    const response = {paragraphs:['First paragraph','Second paragraph with no citation']};
    assert.deepEqual(parseEditorial(JSON.stringify(response)).paragraphs,response.paragraphs);
});


test('brief selection accepts explicit rejection but never silent omissions or unknown IDs',()=>{
    const sources=[{...articles[0],title:'Midterms 2026: Wall Street',status:'forbidden'},
        {...articles[1],title:'Novelists discuss AI writing',status:'forbidden'}];
    const before=JSON.stringify(sources);
    const selected=parseBrief(JSON.stringify({titles:[{id:1,title:null,category:null},{id:2,title:'Les romanciers face à l’écriture avec l’IA',category:'Création'}]}),sources);
    assert.equal(selected.length,1);
    assert.equal(selected[0].id,2);
    assert.equal(selected[0].url,sources[1].url);
    assert.equal(JSON.stringify(sources),before);
    assert.deepEqual(parseBrief(JSON.stringify({titles:[{id:1,title:null,category:null},{id:2,title:null,category:null}]}),sources),[]);
    for(const titles of [[{id:1,title:null}],[{id:1,title:null},{id:1,title:null}],[{id:1,title:null},{id:99,title:null}]])
        assert.throws(()=>parseBrief(JSON.stringify({titles:titles.map(row=>({...row,category:null}))}),sources),/incomplete or invalid/);
});

test('cached RSS entries are rejected before their bodies or titles are decoded',()=>{
    const {readFeed}=require('../../plugin/newsletter');
    const Original=global.DOMParser;
    const link={getAttribute:name=>name==='href' ? 'https://example.com/already-read' : null,textContent:''};
    global.DOMParser=class {
        parseFromString(){return {
            querySelector:selector=>selector==='parsererror' ? null : {},
            querySelectorAll:()=>[{
                querySelectorAll:selector=>{assert.equal(selector,'link');return [link];},
                querySelector:selector=>{
                    assert.equal(selector,'pubDate, published','No title or body may be decoded');
                    return {textContent:'Thu, 05 Nov 2026 10:00:00 GMT'};
                },
                getElementsByTagName:()=>{throw new Error('A cached body must not be decoded');},
            }],
        };}
    };
    try {
        let checked=0;
        assert.deepEqual(readFeed('RSS',Infinity,'https://example.com/feed',entry=>{
            assert.equal(entry.url,'https://example.com/already-read');checked++;return false;
        }),[]);
        assert.equal(checked,1);
    } finally {global.DOMParser=Original;}
});


test('selection gives direct editorial email links high priority across languages, without promoting alerts or feeds',()=>{
    const candidates=[{...articles[0],id:41,source:'Utilisateur (présumé)'},
        {...articles[0],id:42,source:'User (inferred)'},
        {...articles[0],id:43,source:'Google Alerts'},
        {...articles[0],id:44,source:'Google Scholar'},
        {...articles[0],id:45,source:'RSS: example.com'},
        {...articles[0],id:46,source:'Other service (inferred)'}];
    const before=JSON.stringify(candidates);
    const request=selectionRequest('{{articles}}',candidates,'français');
    const expected=require('../../plugin/i18n').t('editorialSourcesContract',{ids:'41, 42'});
    assert.ok(request.system.includes(expected));
    assert.equal(selectionRequest('{{articles}}',candidates.slice(2),'français').system.includes(expected.split('41, 42')[0]),false);
    assert.deepEqual(request.schema.properties.selected.items.enum,[41,42,43,44,45,46]);
    assert.equal(JSON.stringify(candidates),before);
});

test('stored opaque URL identifiers are removed from AI inputs and the final brief without modifying sources',()=>{
    const id='XVRNMOQLNZEMBM3ZWIZYWR7VXE';
    const clean='Étienne Gernelle sur RTL : quand l’IA veut tuer la littérature';
    const source={...articles[0],title:clean+' '+id,url:'https://www.lepoint.fr/video/edito-etienne-gernelle/etienne-gernelle-sur-rtl-quand-lia-veut-tuer-la-litterature-'+id+'/'};
    const before=JSON.stringify(source);
    assert.equal(JSON.parse(briefRequest('Brief in {{language}}',[source],'français').input)[0].title,clean);
    assert.equal(JSON.parse(selectionRequest('{{articles}}',[source],'français').input)[0].title,clean);
    const markdown=renderNewsletter(template,result,[source]);
    assert.ok(markdown.includes('* ['+clean+']('+source.url+')'));
    assert.ok(!markdown.includes('littérature '+id+']'));
    assert.equal(JSON.stringify(source),before);
});
