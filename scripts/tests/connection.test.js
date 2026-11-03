const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

async function fixture(initialSecrets = {}) {
    const secrets = new Map(Object.entries(initialSecrets));
    let layoutReady;
    class Plugin {
        async loadData() { return this.savedSettings || {secretKey:'test',labelId:'Label_1'}; }
        async saveData(settings) { this.savedSettings = {...settings}; }
        addSettingTab() {}
        registerEvent() {}
        register() {}
    }
    let secret = JSON.stringify({email:'reader@example.com',clientId:'123-test.apps.googleusercontent.com',refreshToken:'old',scope:'https://www.googleapis.com/auth/gmail.readonly'});
    const obsidian = {TFile:class {},TFolder:class {},addIcon:()=>{},Plugin,PluginSettingTab:class {},Modal:class {},Notice:class {},getLanguage:()=> 'en'};
    const context = {module:{exports:{}},AbortController,URL,setTimeout,clearTimeout,
        document:{head:{createEl:()=>({remove(){}})}},CSS:{escape:value=>value},
        require:name=> name==='obsidian' ? obsidian : name==='electron' ? {shell:{}} : name==='@electron/remote' ? {BrowserWindow:class {}} : require(name)};
    vm.runInNewContext(require('esbuild').buildSync({entryPoints:[path.join(root,'plugin/main.ts')],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian','electron','@electron/remote'],loader:{'.dat':'text','.svg':'text','.md':'text'}}).outputFiles[0].text,context);
    const p = new context.module.exports.default();
    p.manifest = {dir:'.'};
    p.app = {workspace:{on:()=>({}),onLayoutReady:callback=>{layoutReady=callback;}},vault:{adapter:{getBasePath:()=>root,read:async()=>JSON.stringify({installed:{client_id:'123-test.apps.googleusercontent.com',client_secret:'fixture'}})}},secretStorage:{getSecret:key=>key === 'test' ? secret : secrets.get(key),setSecret:(key,value)=>{if (key === 'test') secret=value; else secrets.set(key,value);}}};
    await p.onload();
    const original = p.gmail;
    const profile = {emailAddress:'reader@example.com'};
    const responses = async options => ({status:200,json:options.url.endsWith('/profile') ? profile : {labels:[{id:'Label_1',name:'Newsletter'}]}});
    p.gmail = {...original,authorize:async()=>({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,scope:original.SCOPE}),GmailClient:class extends original.GmailClient {
        constructor(credentials,request,save) {super(credentials,responses,save);}
    }};
    p.client.request = responses;
    return {p,profile,stored:()=>JSON.parse(secret),obsidian,layoutReady:()=>layoutReady()};
}

test('plugin loading persists missing article IDs without Gmail or an AI run',async()=>{
    const {p,obsidian,layoutReady} = await fixture();
    const file = new obsidian.TFile(),folder = new obsidian.TFolder();
    const article = {date:'',title:'Existing article',url:'https://example.com/article',source:'User',content:'Preserved',status:'used',usedAt:'2026-11-03'};
    let saved = JSON.stringify({version:1,notes:'Keep notes',articles:[article]});
    p.settings.outputFolder = 'Data';
    p.app.vault.getAbstractFileByPath = path=>path==='Data' ? folder : path==='Data/textmachine.json' ? file : null;
    p.app.vault.process = async(target,action)=>{assert.equal(target,file);saved=action(saved);};
    await layoutReady();
    const data = JSON.parse(saved);
    assert.equal(data.articles[0].id,1);
    assert.equal(data.nextId,2);
    assert.equal(data.notes,'Keep notes');
    assert.deepEqual(data.articles[0],{...article,publish:'',image:'',id:1});
    const migrated = saved;
    await layoutReady();
    assert.equal(saved,migrated);
});

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

async function newsletterFixture() {
    const {p,obsidian} = await fixture();
    const article = (name,extra={}) => ({date:'2026-11-03',title:name,url:'https://example.com/'+name,source:'User',status:'',publish:'2026-11-01',content:'Article about AI and books.',image:'',...extra});
    const entries = [article('used',{id:1}),article('discard',{id:2}),article('old',{id:3,status:'used'})];
    const contents = new Map([['Data/textmachine.json',JSON.stringify({version:1,nextId:4,notes:'Keep notes',articles:entries})]]);
    const files = new Map();
    const folder = Object.assign(new obsidian.TFolder(),{path:'Data',children:[]});
    const log = Object.assign(new obsidian.TFile(),{path:'Data/textmachine.json',name:'textmachine.json'});
    files.set('Data',folder);files.set(log.path,log);
    let failCreate = false, failSave = false;
    p.settings.outputFolder = 'Data';
    p.newsletter = {...p.newsletter,readFeed:()=>[{title:'Recent blog post',url:'https://tcrouzet.substack.com/post',content:'Recent idea'}]};
    p.app.vault = {
        modify:async(file,text)=>{if (failCreate) throw new Error('Disk full');contents.set(file.path,text);},
        getAbstractFileByPath:path=>files.get(path),
        read:async file=>contents.get(file.path),
        create:async (path,text)=>{
            if (failCreate) throw new Error('Disk full');
            if (files.has(path)) throw new Error('File exists');
            const file = Object.assign(new obsidian.TFile(),{path,name:path.split('/').pop(),stat:{mtime:Date.now()}});
            files.set(path,file);contents.set(path,text);folder.children.push(file);return file;
        },
        process:async (file,action)=>{
            const before = contents.get(file.path), after = action(before);
            if (failSave && after !== before) throw new Error('JSON write failed');
            contents.set(file.path,after);
        },
        adapter:{exists:async()=>true,read:async path=>path.endsWith('/models/newsletter.md') ? require('node:fs').readFileSync(require('node:path').join(root,'models/newsletter.md'),'utf8') : 'My runtime prompt'},
    };
    p.app.workspace.getLeaf = ()=>({openFile:async()=>{}});
    p.request = async()=>({status:200,text:'<rss/>'});
    p.getAIConnection = ()=>({provider:'openai',model:'fixture',apiKey:'fixture'});
    const seen = [];
    p.generate = async (_connection,system,input)=>{
        assert.ok(system.includes('My runtime prompt'));
        const context = JSON.parse(input);
        seen.push(context);
        return JSON.stringify({title:'A new newsletter',chapeau:'Books meet AI.',paragraphs:['First paragraph.','Second paragraph.'],lead:1,image:null,
            groups:[{title:'Books',articles:context.articles.filter(article=>article.title!=='discard').map(article=>({id:article.id,summary:'Article summary.'}))}],
            discard:context.articles.filter(article=>article.title==='discard').map(article=>article.id)});
    };
    return {p,contents,files,entries,seen,failCreate:()=>{failCreate=true;},failSave:()=>{failSave=true;}};
}

test('today’s note is regenerated from used articles and new articles without duplicating files',async()=>{
    const {p,contents,entries,seen} = await newsletterFixture();
    const first = await p.writeNewsletter();
    assert.match(first.path,/^Data\/text-machine-\d{4}-\d{2}-\d{2}\.md$/);
    assert.ok(contents.get(first.path).startsWith('# A new newsletter'));
    const saved = JSON.parse(contents.get(p.dataPath));
    assert.equal(saved.notes,'Keep notes');
    assert.deepEqual(saved.articles.map(article=>article.status),['used','discard','used']);
    assert.equal(saved.articles[0].usedAt,p.newsletter.day());
    saved.nextId = 5;
    saved.articles.push({...entries[0],id:4,title:'new',url:'https://example.com/new'});
    contents.set(p.dataPath,JSON.stringify(saved));
    const second = await p.writeNewsletter();
    assert.equal(second.path,first.path);
    assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,1);
    assert.deepEqual(seen[1].articles.map(article=>article.title),['used','new']);
    assert.equal(seen[1].previousNewsletters.length,0);
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles[3].usedAt,p.newsletter.day());
});

test('generation errors and note save failures leave article statuses unchanged',async()=>{
    for (const failure of ['api','create','invalid']) {
        const {p,contents,failCreate} = await newsletterFixture();
        const before = contents.get(p.dataPath);
        if (failure==='api') p.generate = async()=>{throw new Error('Provider refused');};
        if (failure==='invalid') p.generate = async()=>'{broken';
        if (failure==='create') failCreate();
        await assert.rejects(p.writeNewsletter(),failure==='api' ? /Provider refused/ : failure==='create' ? /Disk full/ : /Invalid AI response/);
        assert.equal(contents.get(p.dataPath),before);
        assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,0);
    }
});

test('saved newsletter survives a JSON status write failure with a precise message',async()=>{
    const {p,contents,failSave} = await newsletterFixture();
    const before = contents.get(p.dataPath);failSave();
    await assert.rejects(p.writeNewsletter(),/was saved, but updating statuses failed/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,1);
});

test('no pending articles do not call an AI or create a note',async()=>{
    const {p,contents} = await newsletterFixture();
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[]}));
    p.generate = async()=>{throw new Error('Must not call');};
    assert.equal(await p.writeNewsletter(),null);
});


test('closing the run during generation prevents a late note and status changes',async()=>{
    const {p,contents} = await newsletterFixture();
    const before = contents.get(p.dataPath);
    p.generate = async()=>{
        p.aiController.abort();
        return JSON.stringify({title:'Too late',chapeau:'Late.',paragraphs:['First','Second'],lead:1,image:null,groups:[{title:'Books',articles:[{id:1,summary:'Summary'}]}],discard:[2]});
    };
    await assert.rejects(p.writeNewsletter(),/cancelled/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,0);
});

test('irrelevant articles are discarded without creating a note',async()=>{
    const {p,contents} = await newsletterFixture();
    p.generate = async()=>JSON.stringify({title:'',chapeau:'',paragraphs:[],lead:null,image:null,groups:[],discard:[1,2]});
    assert.equal(await p.writeNewsletter(),null);
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)).articles.map(article=>article.status),['discard','discard','used']);
    assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,0);
});

test('crawl skips existing content even without a publication date and fetches only empty articles',async()=>{
    const {p,contents,entries} = await newsletterFixture();
    const empty = {...entries[0],id:4,url:'https://example.com/empty',title:'Empty',content:'',publish:''};
    const existing = entries.map(article=>({...article,publish:''}));
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[...existing,empty]}));
    const crawled = [];
    p.crawler = {...p.crawler,crawl:async article=>{
        crawled.push(article.url);
        return {...article,content:'Newly fetched article'};
    }};
    await p.crawlArticles();
    assert.deepEqual(crawled,[empty.url]);
    const saved = JSON.parse(contents.get(p.dataPath)).articles;
    assert.deepEqual(saved.slice(0,3),existing);
    assert.equal(saved[3].content,'Newly fetched article');
});

test('crawl retains blocked and inaccessible articles as forbidden without retrying them',async()=>{
    const {p,contents,entries} = await newsletterFixture();
    let nextId = 2;
    const inaccessible = (url,status='')=>({...entries[0],id:nextId++,url,title:url,content:'',status});
    const articles = [entries[0],inaccessible('https://blocked.example/known'),inaccessible('https://legacy.example/old','404'),
        inaccessible('https://denied.example/first'),inaccessible('https://denied.example/second')];
    contents.set(p.dataPath,JSON.stringify({version:1,annotation:'Keep annotation',articles}));
    p.readBlocked = async()=>['blocked.example'];
    const crawled = [];
    p.crawler = {...p.crawler,crawl:async(article,blocked)=>{
        crawled.push(article.url);
        blocked.push('denied.example');
        return {...article,status:'forbidden'};
    }};
    await p.crawlArticles();
    assert.deepEqual(crawled,['https://denied.example/first']);
    const saved = JSON.parse(contents.get(p.dataPath));
    assert.equal(saved.articles.length,5);
    assert.equal(saved.articles[0].status,'');
    assert.ok(saved.articles.slice(1).every(article=>article.status==='forbidden'));
    assert.equal(saved.annotation,'Keep annotation');
    assert.deepEqual(JSON.parse(contents.get('Data/blocked.json')),['blocked.example','denied.example']);
});

test('mail from blocked domains is retained as forbidden metadata and marked read',async()=>{
    const {p,contents,entries} = await newsletterFixture();
    p.account.scope = p.gmail.SCOPE;
    p.readBlocked = async()=>['example.com'];
    p.articles = {...p.articles,messageArticles:()=>[{...entries[0],url:'https://news.example.com/new-article',title:'New article'}]};
    let marked = 0;
    p.client = {unreadMessages:async function*(){yield 'message';},message:async()=>({id:'message',labelIds:['UNREAD','Label_1']}),markRead:async()=>{marked++;}};
    p.crawler = {...p.crawler,crawl:async()=>{throw new Error('Must not crawl');}};
    await p.importUnread();
    const saved = JSON.parse(contents.get(p.dataPath));
    assert.equal(saved.articles.length,4);
    assert.ok(saved.articles.every(article=>article.status==='forbidden'));
    assert.ok(saved.articles.some(article=>article.url==='https://news.example.com/new-article'));
    assert.equal(marked,1);
});


test('legacy links recover used articles from today’s note while older notes supply history',async()=>{
    const {p,contents,entries,seen} = await newsletterFixture();
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[{...entries[0],status:'used'},entries[2]]}));
    const today = 'Data/text-machine-'+p.newsletter.day()+'.md';
    await p.app.vault.create(today,'# Old edition\n\n[Source]('+entries[0].url+')');
    await p.app.vault.create('Data/text-machine-2000-01-01.md','# Older angle');
    assert.equal((await p.writeNewsletter()).path,today);
    assert.deepEqual(seen[0].articles.map(article=>article.url),[entries[0].url]);
    assert.equal(seen[0].previousNewsletters[0].content,'# Older angle');
    assert.equal(contents.get('Data/text-machine-2000-01-01.md'),'# Older angle');
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles[0].usedAt,p.newsletter.day());
});

test('failed regeneration preserves today’s saved note and its used statuses',async()=>{
    const {p,contents,failCreate} = await newsletterFixture();
    const note = await p.writeNewsletter();
    const beforeNote = contents.get(note.path), beforeData = contents.get(p.dataPath);
    failCreate();
    await assert.rejects(p.writeNewsletter(),/Disk full/);
    assert.equal(contents.get(note.path),beforeNote);
    assert.equal(contents.get(p.dataPath),beforeData);
});

test('an empty regeneration keeps the saved edition and used articles while discarding only new irrelevant ones',async()=>{
    const {p,contents,entries} = await newsletterFixture();
    const note = await p.writeNewsletter();
    const before = contents.get(note.path);
    const data = JSON.parse(contents.get(p.dataPath));
    data.nextId = 5;
    data.articles.push({...entries[0],id:4,url:'https://example.com/irrelevant-new',title:'irrelevant-new'});
    contents.set(p.dataPath,JSON.stringify(data));
    p.generate = async(_connection,_system,input)=>JSON.stringify({title:'',chapeau:'',paragraphs:[],lead:null,image:null,groups:[],discard:JSON.parse(input).articles.map(article=>article.id)});
    assert.equal(await p.writeNewsletter(),null);
    assert.equal(contents.get(note.path),before);
    const saved = JSON.parse(contents.get(p.dataPath));
    assert.equal(saved.articles[0].status,'used');
    assert.equal(saved.articles[0].usedAt,p.newsletter.day());
    assert.equal(saved.articles[3].status,'discard');
});


test('AI cannot return article status changes or unknown IDs to alter the saved JSON',async()=>{
    for (const malicious of [{status:'used'},{groups:[{title:'Books',articles:[{id:99,summary:'Unknown source'}]}]}]) {
        const {p,contents} = await newsletterFixture();
        const before = contents.get(p.dataPath);
        p.generate = async()=>JSON.stringify({title:'A title',chapeau:'Introduction',paragraphs:['One','Two'],lead:1,image:null,
            groups:[{title:'Books',articles:[{id:1,summary:'Summary'}]}],discard:[2],...malicious});
        await assert.rejects(p.writeNewsletter(),/Invalid AI response/);
        assert.equal(contents.get(p.dataPath),before);
        assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,0);
    }
});


test('an edition containing only forbidden titles needs no AI and persists the briefing date',async()=>{
    const {p,contents,entries} = await newsletterFixture();
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[{...entries[0],status:'forbidden',content:''}]}));
    p.getAIConnection = ()=>{throw new Error('No AI needed');};
    p.generate = async()=>{throw new Error('Must not generate forbidden content');};
    p.request = async()=>{throw new Error('No feed needed');};
    const note = await p.writeNewsletter();
    const markdown = contents.get(note.path);
    assert.ok(markdown.startsWith('# In brief'));
    assert.ok(markdown.includes('* [used](https://example.com/used)'));
    assert.ok(!markdown.includes('## Revue de presse'));
    const saved = JSON.parse(contents.get(p.dataPath)).articles[0];
    assert.equal(saved.status,'forbidden');
    assert.equal(saved.usedAt,p.newsletter.day());
    assert.equal((await p.writeNewsletter()).path,note.path);
});

test('a rejected, unsupported or unverifiable image is omitted while the newsletter is saved',async()=>{
    for (const failure of ['face','unsupported','malformed','private']) {
        const {p,contents} = await newsletterFixture();
        const data = JSON.parse(contents.get(p.dataPath));
        data.articles[0].image = 'https://example.com/picture.jpg';
        contents.set(p.dataPath,JSON.stringify(data));
        p.browser = {...p.browser,publicUrl:async()=>failure!=='private'};
        let checks = 0;
        p.generate = async(_connection,_system,_input,_request,_signal,_progress,imageUrl)=>{
            if (imageUrl) {
                checks++;
                if (failure==='unsupported') throw new Error('Vision unavailable');
                return failure==='malformed' ? 'broken' : '{"accepted":false,"caption":"A portrait"}';
            }
            return JSON.stringify({title:'A newsletter',chapeau:'Introduction',paragraphs:['First','Second [Source](https://example.com/used)'],lead:1,image:{caption:''},
                groups:[{title:'Books',articles:[{id:1,summary:'Summary'}]}],discard:[2]});
        };
        const note = await p.writeNewsletter();
        assert.ok(contents.get(note.path).startsWith('# A newsletter'));
        assert.ok(!contents.get(note.path).includes('!['));
        assert.equal(checks,failure==='private' ? 0 : 1);
        assert.equal(JSON.parse(contents.get(p.dataPath)).articles[0].status,'used');
    }
});

test('cancelling the image verification prevents any note or status write',async()=>{
    const {p,contents} = await newsletterFixture();
    const data = JSON.parse(contents.get(p.dataPath));
    data.articles[0].image = 'https://example.com/picture.jpg';
    contents.set(p.dataPath,JSON.stringify(data));
    const before = contents.get(p.dataPath);
    p.browser = {...p.browser,publicUrl:async()=>true};
    p.generate = async(_connection,_system,_input,_request,_signal,_progress,imageUrl)=>{
        if (imageUrl) {p.aiController.abort();throw new Error('Cancelled');}
        return JSON.stringify({title:'A newsletter',chapeau:'Introduction',paragraphs:['First','Second [Source](https://example.com/used)'],lead:1,image:{caption:''},
            groups:[{title:'Books',articles:[{id:1,summary:'Summary'}]}],discard:[2]});
    };
    await assert.rejects(p.writeNewsletter(),/cancelled/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,0);
});
