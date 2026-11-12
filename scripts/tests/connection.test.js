const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const rewriteResponse = text=>JSON.stringify({paragraphs:text.trim().split(/\r?\n[ \t]*\r?\n+/)});
const writerResponse=(paragraphs,articles)=>JSON.stringify({paragraphs:paragraphs.map((text,index)=>index===paragraphs.length-1
    ? text+' '+articles.map(article=>'[Source '+article.id+']('+article.url+')').join(' ') : text),used:articles.map(article=>article.id)});

async function fixture(initialSecrets = {}) {
    const secrets = new Map(Object.entries(initialSecrets));
    const events=new Map();
    let layoutReady;
    class Plugin {
        async loadData() { return this.savedSettings || {secretKey:'test',labelId:'Label_1'}; }
        async saveData(settings) { this.savedSettings = {...settings}; }
        addSettingTab(tab) {this.settingsTab=tab;}
        registerEvent() {}
        register() {}
    }
    let secret = JSON.stringify({email:'reader@example.com',clientId:'123-test.apps.googleusercontent.com',refreshToken:'old',scope:'https://www.googleapis.com/auth/gmail.readonly'});
    const obsidian = {TFile:class {},TFolder:class {},addIcon:()=>{},setIcon:()=>{},Plugin,PluginSettingTab:class {},Modal:class {open() {}},Notice:class {},getLanguage:()=> 'en',requireApiVersion:()=>false};
    const context = {module:{exports:{}},AbortController,URL,URLSearchParams,Date,performance,setTimeout,clearTimeout,structuredClone,window:{setTimeout,clearTimeout,setInterval,clearInterval},
        MutationObserver:class {observe() {} disconnect() {}},
        document:{body:{},querySelectorAll:()=>[]},CSS:{escape:value=>value},
        require:name=> name==='obsidian' ? obsidian : name==='electron' ? {shell:{}} : name==='@electron/remote' ? {BrowserWindow:class {}} : require(name)};
    vm.runInNewContext(require('esbuild').buildSync({entryPoints:[path.join(root,'plugin/main.ts')],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian','electron','@electron/remote'],loader:{'.dat':'text','.svg':'text','.md':'text'}}).outputFiles[0].text,context);
    const p = new context.module.exports.default();
    p.manifest = {dir:'.'};
    p.app = {workspace:{on:(name,callback)=>{events.set(name,callback);return {};},onLayoutReady:callback=>{layoutReady=callback;}},vault:{adapter:{getBasePath:()=>root,read:async()=>JSON.stringify({installed:{client_id:'123-test.apps.googleusercontent.com',client_secret:'fixture'}})}},secretStorage:{getSecret:key=>key === 'test' ? secret : secrets.get(key),setSecret:(key,value)=>{if (key === 'test') secret=value; else secrets.set(key,value);}}};
    await p.onload();
    const original = p.gmail;
    const profile = {emailAddress:'reader@example.com'};
    const responses = async options => ({status:200,json:options.url.endsWith('/profile') ? profile : {labels:[{id:'Label_1',name:'Newsletter'}]}});
    p.gmail = {...original,authorize:async()=>({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,scope:original.SCOPE}),GmailClient:class extends original.GmailClient {
        constructor(credentials,request,save) {super(credentials,responses,save);}
    }};
    p.client.request = responses;
    return {p,context,profile,stored:()=>JSON.parse(secret),obsidian,events,layoutReady:()=>layoutReady()};
}

test('prompt editing reads bundled defaults without writing and saves each stage independently',async()=>{
    const {p}=await fixture();
    const files=new Map(),folders=new Set();
    p.app.vault.adapter={exists:async path=>files.has(path) || folders.has(path),read:async path=>files.get(path),
        mkdir:async path=>folders.add(path),write:async(path,text)=>files.set(path,text)};
    for (const file of ['sélection.md','writer.md','bref.md','rewriter.md','publisher.md','image.md']) {
        const original=await p.readPrompt(file);
        assert.equal(original,require('node:fs').readFileSync(path.join(root,'prompts',file),'utf8'));
        assert.ok(!files.has('./prompts/'+file));
        const custom=original+'\nConsigne personnelle pour '+file+'\n';
        await p.savePrompt(file,custom,original);
        assert.equal(await p.readPrompt(file),custom);
        assert.equal(files.get('./prompts/'+file),custom);
    }
    assert.equal(files.size,6);
    assert.deepEqual([...folders],['./prompts']);
});

test('invalid prompt variables and missing required inputs cannot overwrite a saved prompt',async()=>{
    const {p}=await fixture();
    const files=new Map();
    p.app.vault.adapter={exists:async path=>files.has(path),read:async path=>files.get(path),
        mkdir:async()=>{},write:async(path,text)=>files.set(path,text)};
    for (const file of ['sélection.md','writer.md','bref.md','rewriter.md','publisher.md','image.md']) {
        const original=await p.readPrompt(file);
        files.set('./prompts/'+file,original);
        const invalidPrompts=[['   ',p.i18n.t('newsletterPromptEmpty',{file})],
            [original+'\n{{wrongVariable}}',p.i18n.t('promptUnknownVariable',{variable:'{{wrongVariable}}'})]];
        if (['sélection.md','writer.md','publisher.md'].includes(file)) invalidPrompts.push(['No article input.',
            p.i18n.t(file==='publisher.md' ? 'publisherArticleMissing' : 'writerArticlesMissing',
                {variable:file==='publisher.md' ? '{{article}}' : '{{articles}}'})]);
        for (const [invalid,message] of invalidPrompts) {
            await assert.rejects(p.savePrompt(file,invalid,original),error=>error.message===message);
            assert.equal(files.get('./prompts/'+file),original);
        }
    }
});

test('prompt saves preserve concurrent changes and report busy and write failures',async()=>{
    const {p}=await fixture();
    const original=require('node:fs').readFileSync(path.join(root,'prompts/image.md'),'utf8');
    let text='Changed in another editor';
    p.app.vault.adapter={exists:async()=>true,read:async()=>text,write:async()=>{throw new Error('Disk write failed');}};
    await assert.rejects(p.savePrompt('image.md','My illustration',original),/changed/);
    assert.equal(text,'Changed in another editor');
    text=original;
    p.busy=true;
    await assert.rejects(p.savePrompt('image.md','My illustration',original),/running/);
    p.busy=false;
    await assert.rejects(p.savePrompt('image.md','My illustration',original),/Disk write failed/);
    assert.equal(text,original);
});

test('a prompt saved by the editor is used by the next newsletter generation',async()=>{
    const {p,seen}=await newsletterFixture();
    const adapter=p.app.vault.adapter,read=adapter.read,exists=adapter.exists,files=new Map();
    adapter.read=async path=>files.has(path) ? files.get(path) : read(path);
    adapter.exists=async path=>files.has(path) || exists(path);
    adapter.write=async(path,text)=>files.set(path,text);
    const original=await p.readPrompt('writer.md');
    const custom=original.replace('"instructions":"My runtime prompt"','"instructions":"My runtime prompt","tone":"My editorial choice"');
    await p.savePrompt('writer.md',custom,original);
    await p.writeNewsletter();
    assert.equal(seen.length,1);
    assert.equal(seen[0].tone,'My editorial choice');
});

test('newsletter model editing preserves the default and rejects invalid templates without writes',async()=>{
    const {p}=await fixture();
    const files=new Map(),folders=new Set();
    p.app.vault.adapter={exists:async path=>files.has(path) || folders.has(path),read:async path=>files.get(path),
        mkdir:async path=>folders.add(path),write:async(path,text)=>files.set(path,text)};
    const original=await p.readPrompt('newsletter.md');
    assert.equal(original,require('node:fs').readFileSync(path.join(root,'models/newsletter.md'),'utf8'));
    assert.equal(files.size,0);
    const custom=original+'\nMy newsletter footer\n';
    await p.savePrompt('newsletter.md',custom,original);
    assert.equal(await p.readPrompt('newsletter.md'),custom);
    assert.deepEqual([...folders],['./models']);
    assert.equal(files.get('./models/newsletter.md'),custom);
    assert.equal(files.size,1);
    const invalid=[' ', '# {{unknown}}', '# {{title}}\n{{#editorial}}{{unknown}}{{/editorial}}',
        '# {{title}}\n{{#brief}}{{#articles}}{{unknown}}{{/articles}}{{/brief}}',
        '# {{title}}\n{{#articles}}{{title}}', 'Missing heading'];
    for (const text of invalid) {
        await assert.rejects(p.savePrompt('newsletter.md',text,custom),/template.*invalid/);
        assert.equal(files.get('./models/newsletter.md'),custom);
    }
    files.set('./models/newsletter.md',custom+'External change');
    await assert.rejects(p.savePrompt('newsletter.md',original,custom),/changed/);
    assert.equal(files.get('./models/newsletter.md'),custom+'External change');
    files.set('./models/newsletter.md',custom);
    p.busy=true;
    await assert.rejects(p.savePrompt('newsletter.md',original,custom),/running/);
    p.busy=false;
    p.app.vault.adapter.write=async()=>{throw new Error('Disk write failed');};
    await assert.rejects(p.savePrompt('newsletter.md',original,custom),/Disk write failed/);
    assert.equal(files.get('./models/newsletter.md'),custom);
    assert.ok(p.settingsTab.getSettingDefinitions().flatMap(item=>item.items || [item]).some(row=>row.name==='Newsletter template'));
});

test('the edited newsletter model assembles the next edition without entering AI requests',async()=>{
    const {p,contents}=await newsletterFixture();
    const adapter=p.app.vault.adapter,read=adapter.read,files=new Map();
    adapter.read=async path=>files.has(path) ? files.get(path) : read(path);
    adapter.write=async(path,text)=>files.set(path,text);
    const original=await p.readPrompt('newsletter.md');
    const marker='My personal newsletter signature';
    await p.savePrompt('newsletter.md',original+'\n'+marker,original);
    const generate=p.generate;
    p.generate=async(connection,system,input,...rest)=>{
        assert.ok(!system.includes(marker) && !input.includes(marker));
        return generate(connection,system,input,...rest);
    };
    const note=await p.writeNewsletter();
    assert.ok(contents.get(note.path).includes(marker));
});

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
    assert.deepEqual(data.articles[0],{...article,status:'',publish:'',image:'',id:1,authors:[]});
    const migrated = saved;
    await layoutReady();
    assert.equal(saved,migrated);
});

test('the former supplementary feed becomes the author feed without losing settings',async()=>{
    const {p} = await fixture();
    p.savedSettings = {...p.settings,newsletterFeed:'https://legacy.substack.com'};
    delete p.savedSettings.authorFeeds;
    delete p.savedSettings.includeFeeds;
    await p.onload();
    assert.equal(p.settings.authorFeeds,'https://legacy.substack.com');
    assert.equal(p.settings.includeFeeds,'');
    assert.equal(p.settings.referenceSources,'');
    assert.equal(p.settings.labelId,'Label_1');
    assert.ok(!Object.hasOwn(p.savedSettings,'newsletterFeed'));
    assert.equal(p.savedSettings.authorFeeds,'https://legacy.substack.com');
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
    const {p,obsidian,events} = await fixture();
    p.settings.commentedArticles=2;
    const article = (name,extra={}) => ({date:'2026-11-03',title:name,url:'https://example.com/'+name,source:'User',authors:[],status:'',usedAt:'',publish:'2026-11-01',content:'Article about AI and books.',image:'',...extra});
    const entries = [article('used',{id:1}),article('another',{id:2,url:'https://other.example/another'}),article('old',{id:3,url:'https://older.example/old',usedAt:'unknown'})];
    const contents = new Map([['Data/textmachine.json',JSON.stringify({version:1,nextId:4,notes:'Keep notes',articles:entries})]]);
    const files = new Map();
    const folder = Object.assign(new obsidian.TFolder(),{path:'Data',children:[]});
    const log = Object.assign(new obsidian.TFile(),{path:'Data/textmachine.json',name:'textmachine.json'});
    files.set('Data',folder);files.set(log.path,log);
    let failCreate = false, failSave = false;
    p.settings.outputFolder = 'Data';
    p.settings.authorFeeds = 'https://example.substack.com';
    p.newsletter = {...p.newsletter,readFeed:()=>[{title:'Recent blog post',url:'https://tcrouzet.substack.com/post',content:'Recent idea'}]};
    p.app.vault = {
        createFolder:async path=>{
            if (failCreate) throw new Error('Disk full');
            const directory=Object.assign(new obsidian.TFolder(),{path,children:[]});
            files.set(path,directory);return directory;
        },
        createBinary:async(path,data)=>{
            assert.ok(data instanceof ArrayBuffer);
            return p.app.vault.create(path,'PNG fixture');
        },
        modify:async(file,text)=>{if (failCreate) throw new Error('Disk full');contents.set(file.path,text);},
        getAbstractFileByPath:path=>files.get(path),
        read:async file=>contents.get(file.path),
        create:async (path,text)=>{
            if (failCreate) throw new Error('Disk full');
            if (files.has(path)) throw new Error('File exists');
            const file = Object.assign(new obsidian.TFile(),{path,name:path.split('/').pop(),extension:path.split('.').pop(),stat:{mtime:Date.now()}});
            files.set(path,file);contents.set(path,text);
            files.get(path.split('/').slice(0,-1).join('/'))?.children.push(file);
            return file;
        },
        process:async (file,action)=>{
            const before = contents.get(file.path), after = action(before);
            if (failSave && after !== before) throw new Error('JSON write failed');
            contents.set(file.path,after);
        },
        adapter:{exists:async()=>true,read:async path=>path.endsWith('/models/newsletter.md') ? require('node:fs').readFileSync(require('node:path').join(root,'models/newsletter.md'),'utf8')
            : path.endsWith('/prompts/publisher.md') ? 'Runtime publisher in {{language}}.\n{{article}}'
            : path.endsWith('/prompts/verifier.md') ? '{"instructions":"Runtime verifier","newsletter":{{newsletter}},"articles":{{articles}},"language":"{{language}}"}'
            : path.endsWith('/prompts/image.md') ? 'Image caption in {{language}}'
                : path.endsWith('/prompts/rewriter.md') ? 'Runtime rewriter {{language}}'
                    : path.endsWith('/prompts/bref.md') ? 'Runtime brief {{language}}'
                        : path.endsWith('/prompts/sélection.md') ? '{"instructions":"Runtime selection","language":"{{language}}","commentedArticles":{{commentedArticles}},"articles":{{articles}}}'
                : '{"instructions":"My runtime prompt","language":"{{language}}","commentedArticles":{{commentedArticles}},"articles":{{articles}},"previousNewsletters":{{previousNewsletters}},"recentPosts":{{recentPosts}}}'},
    };
    p.app.fileManager={getAvailablePathForAttachment:async(name,source)=>{
        assert.ok(source.startsWith(p.settings.outputFolder+'/'));
        assert.ok(files.has(source),'Obsidian needs an existing source file to resolve relative attachment folders');
        if (!files.has('Attachments')) await p.app.vault.createFolder('Attachments');
        let destination='Attachments/'+name,index=1;
        while (files.has(destination)) {
            destination='Attachments/'+name.replace(/\.png$/, ' '+index+'.png');
            index++;
        }
        return destination;
    },generateMarkdownLink:(file,_source,_subpath,alias)=>'['+alias+']('+file.path+')'};
    p.app.metadataCache={getFirstLinkpathDest:(link,source)=>files.get(link) || files.get(path.posix.normalize(path.posix.join(path.posix.dirname(source),link))) || null};
    p.app.workspace.getLeaf = ()=>({openFile:async()=>{}});
    p.createIllustration = async()=>({name:'illustration-0000000000000000.png',data:new ArrayBuffer(8)});
    p.generateIllustration = async()=>new ArrayBuffer(8);
    p.codex={...p.codex,generateImage:async()=>new ArrayBuffer(8)};
    p.request = async()=>({status:200,text:'<rss/>'});
    p.getAIConnection = ()=>({provider:'openai',model:'fixture',apiKey:'fixture'});
    const seen = [],publisher={title:'A new newsletter',chapeau:'Books meet AI.'};
    p.generate = async (_connection,system,input)=>{
        if (input.startsWith('Runtime publisher')) return JSON.stringify(publisher);
        if (system.startsWith('Runtime rewriter')) return rewriteResponse(input);
        if (system.startsWith('Runtime brief')) return JSON.stringify({titles:JSON.parse(input).map(({id,title})=>({id,title,category:'Écriture'}))});
        const context = JSON.parse(input);
        if (context.instructions==='Runtime verifier') return JSON.stringify({issues:[]});
        if (context.instructions==='Runtime selection') return JSON.stringify({brief:[], selected:context.articles.filter(article=>article.title!=='discard').map(article=>article.id),discard:context.articles.filter(article=>article.title==='discard').map(article=>article.id)});
        assert.ok(input.includes('My runtime prompt'));
        assert.ok(!system.includes('My runtime prompt'));
        seen.push(context);
        return writerResponse(['First paragraph.','Second paragraph.'],context.articles);
    };
    return {p,obsidian,events,contents,files,entries,seen,publisher,failCreate:()=>{failCreate=true;},failSave:()=>{failSave=true;}};
}

test('commented articles defaults to three and restores only valid review targets',async()=>{
    const {p}=await fixture();
    assert.equal(p.settings.commentedArticles,3);
    for (const value of [1,3,12,0,-1,2.5,'10',null,undefined,Infinity,Number.MAX_SAFE_INTEGER+1]) {
        p.savedSettings={...p.settings,commentedArticles:value};
        await p.onload();
        assert.equal(p.settings.commentedArticles,Number.isSafeInteger(value) && value>=2 ? value : 3);
    }
});

test('the old collection minimum becomes a default writing target for every newsletter',async()=>{
    const {p}=await fixture();
    const {commentedArticles,...profile}=p.newsletters[0];
    assert.equal(commentedArticles,3);
    p.savedSettings={...p.settings,minimumSources:20,newsletters:[{...profile,minimumSources:20},
        {...profile,id:'other',name:'Other',minimumSources:15}]};
    delete p.savedSettings.commentedArticles;
    await p.onload();
    assert.equal(p.settings.commentedArticles,3);
    assert.deepEqual(Array.from(p.newsletters,row=>row.commentedArticles),[3,3]);
    assert.ok(!Object.hasOwn(p.settings,'minimumSources'));
    p.settings.commentedArticles=5;
    await p.saveData(p.settings);
    await p.selectNewsletter('other');
    assert.equal(p.settings.commentedArticles,3);
    await p.selectNewsletter(profile.id);
    assert.equal(p.settings.commentedArticles,5);
});

test('newsletter profiles preserve existing settings and independent prompts across selection and reload',async()=>{
    const {newsletterValues}=require('../../plugin/profiles');
    const {p}=await newsletterFixture();
    const first=p.settings.activeNewsletter;
    Object.assign(p.settings,{labelId:'Label_first',includeFeeds:'https://first.example/feed',authorFeeds:'https://author.example/feed',
        excludedSources:'ignored.example',referenceSources:'first.example',newsletterLanguage:'English',commentedArticles:3,imageMode:'none',
        aiModel:'__codex__',codexModel:'chosen-model',codexEffort:'high'});
    const originalSettings=newsletterValues(p.settings),original=await p.readPrompt('writer.md');
    const legacy={...p.settings};delete legacy.newsletters;delete legacy.activeNewsletter;
    p.savedSettings=legacy;
    await p.onload();
    assert.equal(p.savedSettings.newsletters.length,1);
    assert.deepEqual(newsletterValues(p.settings),originalSettings);
    const created=await p.createNewsletter('Second edition');
    assert.equal(p.newsletters.length,2);
    assert.equal(p.settings.activeNewsletter,created.id);
    assert.equal(p.settings.outputFolder,'');
    assert.equal(p.settings.includeFeeds,'');assert.equal(p.settings.labelId,'');
    assert.equal(await p.readPrompt('writer.md'),original);
    assert.equal(Object.keys(created.prompts).length,7);
    const custom=original.replace('My runtime prompt','My runtime prompt","tone":"Second edition');
    await p.savePrompt('writer.md',custom,original);
    const template=await p.readPrompt('newsletter.md');
    await p.savePrompt('newsletter.md',template+'\nSecond edition footer\n',template);
    Object.assign(p.settings,{outputFolder:'Second',labelId:'Label_second',includeFeeds:'https://second.example/feed',
        newsletterLanguage:'español',commentedArticles:7,referenceSources:'second.example',imageMode:'generated'});
    const secondSettings=newsletterValues(p.settings);
    await p.selectNewsletter(first);
    assert.deepEqual(newsletterValues(p.settings),originalSettings);
    assert.equal(await p.readPrompt('writer.md'),original);
    assert.equal(await p.readPrompt('newsletter.md'),template);
    await assert.rejects(p.savePrompt('writer.md',custom,original,created.id),/changed/);
    await p.selectNewsletter(created.id);
    assert.deepEqual(newsletterValues(p.settings),secondSettings);
    assert.equal(await p.readPrompt('writer.md'),custom);
    assert.ok((await p.readPrompt('newsletter.md')).includes('Second edition footer'));
    await p.onload();
    assert.equal(p.settings.activeNewsletter,created.id);
    assert.deepEqual(newsletterValues(p.settings),secondSettings);
    assert.equal(await p.readPrompt('writer.md'),custom);
    assert.equal(p.settings.aiModel,'__codex__');
    assert.equal(p.settings.codexModel,'chosen-model');assert.equal(p.settings.codexEffort,'high');
    await p.selectNewsletter(first);
    assert.deepEqual(newsletterValues(p.settings),originalSettings);
    const groups=p.settingsTab.getSettingDefinitions().filter(item=>item.type==='group');
    assert.deepEqual(Array.from(groups.slice(0,3),item=>item.heading),['Gmail account (optional)','Artificial intelligence','Newsletter: Data']);
});

test('each newsletter collects and generates in its own folder and context-menu opening selects that newsletter',async()=>{
    const {p,contents,files,events,seen,obsidian}=await newsletterFixture();
    const first=p.settings.activeNewsletter;
    Object.assign(p.settings,{labelId:'Label_1',authorFeeds:'',includeFeeds:'https://first.example/feed',imageMode:'none'});
    p.account.scope=p.gmail.SCOPE;
    const mailLabels=[];
    p.client.unreadMessages=label=>{mailLabels.push(label);return [];};
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[]}));
    const second=await p.createNewsletter('Other newsletter');
    p.app.vault.adapter.list=async()=>({files:[],folders:[]});
    await p.ensureData('Other');
    Object.assign(p.settings,{outputFolder:'Other',includeFeeds:'https://second.example/feed',commentedArticles:2,imageMode:'none'});
    const original=await p.readPrompt('writer.md');
    await p.savePrompt('writer.md',original.replace('My runtime prompt','My runtime prompt","tone":"Second newsletter'),original);
    const requests=[],crawled=[],publish=new Date(Date.now()-1000).toISOString();
    p.request=async options=>{requests.push(options.url);return {status:200,text:options.url};};
    p.newsletter.readFeed=url=>[{title:'Books and AI from '+new URL(url).hostname,url:url.replace('/feed','/article'),publish},
        {title:'Another view on '+new URL(url).hostname,url:'https://companion.example/'+new URL(url).hostname,publish}];
    p.crawler={...p.crawler,crawl:async article=>{crawled.push(article.url);return {...article,content:'Full article about books and AI.'};}};
    const marked=new Map();
    p.folderIconDocuments.add({querySelectorAll:()=>['Data','Other','Unrelated'].map(path=>({getAttribute:()=>path,classList:{toggle:(_cls,value)=>marked.set(path,value)}}))});
    p.updateFolderIcon();
    assert.deepEqual([...marked],[['Data',true],['Other',true],['Unrelated',false]]);
    for (const folder of ['Data','Other','Unrelated']) {
        let offered=false;
        events.get('file-menu')({addItem:callback=>{offered=true;const item={setTitle(){return this;},setIcon(){return this;},setDisabled(){return this;},onClick(){return this;}};callback(item);}},
            files.get(folder) || Object.assign(new obsidian.TFolder(),{path:folder}));
        assert.equal(offered,folder!=='Unrelated');
    }
    await p.openTextMachine('Data');
    assert.equal(p.settings.activeNewsletter,first);
    p.runDialog.render=()=>{};
    await p.runDialog.advance();
    assert.equal(p.runDialog.error,'');
    const firstNote=p.runDialog.notePath,firstText=contents.get(firstNote),firstData=contents.get('Data/textmachine.json');
    assert.equal(firstNote,'Data/text-machine-'+p.newsletter.day()+'.md');
    p.runDialog.onClose();
    assert.equal(JSON.parse(contents.get('Other/textmachine.json')).articles.length,0);
    await p.openTextMachine('Other');
    assert.equal(p.settings.activeNewsletter,second.id);
    assert.equal(p.isConnected,true);
    assert.equal(p.settings.labelId,'');
    p.runDialog.render=()=>{};
    await p.runDialog.advance();
    assert.equal(p.runDialog.error,'');
    assert.equal(p.runDialog.notePath,'Other/text-machine-'+p.newsletter.day()+'.md');
    assert.equal(seen[1].tone,'Second newsletter');
    assert.deepEqual(seen.map(context=>context.articles.map(article=>article.url)),[
        ['https://first.example/article','https://companion.example/first.example'],['https://second.example/article','https://companion.example/second.example']]);
    assert.deepEqual(requests,['https://first.example/feed','https://second.example/feed']);
    assert.deepEqual(crawled,['https://first.example/article','https://companion.example/first.example','https://second.example/article','https://companion.example/second.example']);
    assert.deepEqual(mailLabels,['Label_1']);
    assert.equal(contents.get(firstNote),firstText);
    assert.equal(contents.get('Data/textmachine.json'),firstData);
    assert.equal(JSON.parse(contents.get('Other/textmachine.json')).articles[0].usedAt,p.newsletter.day());
    p.runDialog.onClose();
});

test('profile validation, busy work and failed saves preserve the active newsletter and its files',async()=>{
    const {p,contents}=await newsletterFixture();
    const first=p.settings.activeNewsletter,second=await p.createNewsletter('Second');
    p.settings.outputFolder='Second';
    await p.selectNewsletter(first);
    for (const name of ['', '  ', 'second', ' Second ']) await assert.rejects(p.createNewsletter(name),/non-empty name/);
    for (const folder of ['Second','Second/Child']) await assert.rejects(p.ensureData(folder),/separate folder/);
    const before=p.settings,beforeFiles=[...contents],save=p.saveData;
    p.saveData=async()=>{throw new Error('Disk full');};
    await assert.rejects(p.createNewsletter('Third'),/Disk full/);
    await assert.rejects(p.selectNewsletter(second.id),/Disk full/);
    assert.equal(p.settings,before);assert.equal(p.busy,false);
    assert.deepEqual([...contents],beforeFiles);
    p.saveData=save;
    await p.selectNewsletter(second.id);
    const original=await p.readPrompt('image.md');
    p.saveData=async()=>{throw new Error('Disk full');};
    await assert.rejects(p.savePrompt('image.md',original+'\nCustom illustration.',original),/Disk full/);
    assert.equal(await p.readPrompt('image.md'),original);
    p.saveData=save;
    await p.selectNewsletter(first);
    p.busy=true;
    await assert.rejects(p.createNewsletter('Third'),error=>error.message===p.i18n.t('promptBusy'));
    await assert.rejects(p.selectNewsletter(second.id),error=>error.message===p.i18n.t('promptBusy'));
    p.busy=false;
    let finish;
    p.saveData=async data=>{await new Promise(resolve=>{finish=resolve;});await save.call(p,data);};
    const switching=p.selectNewsletter(second.id);
    await assert.rejects(p.createNewsletter('Third'),error=>error.message===p.i18n.t('promptBusy'));
    assert.equal(p.settings.activeNewsletter,first);
    finish();await switching;
    assert.equal(p.settings.activeNewsletter,second.id);assert.equal(p.busy,false);
});

test('invalid saved profiles cannot replace settings and shared Gmail account changes clear every old label',async()=>{
    const {readProfiles,newsletterDefaults}=require('../../plugin/profiles');
    const valid={...newsletterDefaults,id:'first',name:'First',outputFolder:'First'};
    for (const invalid of [null,[],[valid,valid],[{...valid,commentedArticles:0}],[{...valid,includeFeeds:5}],
        [{...valid,prompts:[]}],[valid,{...valid,id:'second',outputFolder:'First/Child'}]])
        assert.throws(()=>readProfiles(invalid,newsletterDefaults),/configuration is invalid/);
    const {p,profile}=await fixture();
    p.app.vault.adapter.exists=async()=>false;
    const first=p.settings.activeNewsletter,second=await p.createNewsletter('Second');
    p.settings.labelId='Label_1';
    await p.selectNewsletter(first);
    assert.equal(p.newsletters.find(item=>item.id===second.id).labelId,'Label_1');
    profile.emailAddress='another@example.com';
    await p.connect();
    assert.ok(p.newsletters.every(item=>item.labelId===''));
    await p.selectNewsletter(second.id);
    assert.equal(p.settings.labelId,'');
    const invalid={...p.savedSettings,newsletters:[]};
    p.savedSettings=invalid;
    await assert.rejects(p.onload(),/configuration is invalid/);
    assert.equal(p.savedSettings,invalid);
});

test('the writing target blocks generation until enough readable sources exist and allows same-day regeneration',async()=>{
    const {p,contents,entries,seen}=await newsletterFixture();
    p.settings.commentedArticles=10;
    const data={version:1,nextId:10,notes:'Keep notes',articles:Array.from({length:9},(_,i)=>({...entries[0],id:i+1,title:'Source '+i,url:'https://publisher-'+(i%2)+'.example/source-'+i}))};
    contents.set(p.dataPath,JSON.stringify(data));
    const generate=p.generate;
    p.generate=()=>assert.fail('Do not call AI below the configured article threshold');
    await assert.rejects(p.writeNewsletter(),/9.*10/);
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)),data);
    assert.equal(contents.size,1);
    data.articles.push({...entries[0],id:10,title:'Tenth source',url:'https://example.com/tenth'});
    data.nextId=11;
    contents.set(p.dataPath,JSON.stringify(data));
    p.generate=generate;
    const note=await p.writeNewsletter();
    assert.equal(seen[0].articles.length,10);
    assert.equal(seen[0].commentedArticles,10);
    assert.ok(JSON.parse(contents.get(p.dataPath)).articles.every(article=>article.usedAt===p.newsletter.day()));
    assert.equal((await p.writeNewsletter()).path,note.path);
});

test('selection receives only readable eligible articles and the requested writing target',async()=>{
    const {p,contents,entries,seen}=await newsletterFixture();
    p.settings.commentedArticles=10;
    p.settings.excludedSources='excluded.example';
    await p.app.vault.create('Data/text-machine-2000-01-01.md','# Earlier edition');
    const readable=Array.from({length:9},(_,i)=>({...entries[0],id:i+1,title:'Source '+i,url:'https://publisher-'+(i%2)+'.example/source-'+i}));
    const other=[{content:' \n '},{status:'forbidden'},{url:'https://example.com/article.pdf'},
        {url:'https://excluded.example/article'},{usedAt:'2000-01-01'},
        {url:'https://example.substack.com/p/own-post'},{url:'https://tcrouzet.substack.com/post'}]
        .map((extra,i)=>({...entries[0],id:i+10,title:'Excluded '+i,url:'https://example.com/excluded-'+i,...extra}));
    const data={version:1,nextId:17,articles:[...readable,...other]};
    contents.set(p.dataPath,JSON.stringify(data));
    const generate=p.generate;
    p.generate=()=>assert.fail('Blocked, empty, excluded and author articles must not satisfy the threshold');
    await assert.rejects(p.writeNewsletter(),/9.*10/);
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)),data);
    p.settings.commentedArticles=4;
    p.generate=async(...args)=>{
        if (args[2].includes('Runtime selection')) {
            const context=JSON.parse(args[2]);
            assert.equal(context.articles.length,9);
            return JSON.stringify({brief:[], selected:[1,2],discard:context.articles.slice(2).map(article=>article.id)});
        }
        return generate(...args);
    };
    assert.ok(await p.writeNewsletter());
    assert.equal(seen[0].articles.length,2);
    assert.equal(seen[0].commentedArticles,4);
});

test('the default threshold blocks two texts before AI and preserves the existing newsletter',async()=>{
    const {p,contents}=await newsletterFixture();
    p.settings.commentedArticles=3;
    const name='Data/text-machine-'+p.newsletter.day()+'.md';
    await p.app.vault.create(name,'# Existing newsletter');
    const before=contents.get(p.dataPath);
    p.generate=()=>assert.fail('No AI call with only two readable texts');
    p.generateIllustration=()=>assert.fail('No illustration below the threshold');
    await assert.rejects(p.writeNewsletter(),/2.*3/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal(contents.get(name),'# Existing newsletter');
    assert.equal(p.aiController,null);
});

test('deleting consecutive newsletters recovers sources without crossing a surviving later edition',async()=>{
    const {p,contents,files,entries,seen}=await newsletterFixture();
    p.newsletter={...p.newsletter,day:()=> '2026-11-05'};
    p.settings.commentedArticles=10;
    const articles=Array.from({length:10},(_,i)=>({...entries[0],id:i+1,title:'Source '+i,url:'https://publisher-'+(i%2)+'.example/source-'+i,
        usedAt:i<5 ? '2026-11-04' : '2026-11-03'}));
    articles.push({...entries[2],id:11,usedAt:'2026-11-01'});
    const before={version:1,nextId:12,articles};
    contents.set(p.dataPath,JSON.stringify(before));
    const folder=files.get('Data');
    const remove=path=>{files.delete(path);contents.delete(path);folder.children=folder.children.filter(file=>file.path!==path);};
    const oldest=await p.app.vault.create('Data/text-machine-2026-11-02-2.md','# Surviving edition');
    const previous=await p.app.vault.create('Data/text-machine-2026-11-03.md','# Previous edition');
    const yesterday=await p.app.vault.create('Data/text-machine-2026-11-04.md','# Yesterday');
    await p.app.vault.create('Data/text-machine-2026-11-05.md','# Today to regenerate');
    await p.app.vault.create('Data/brouillon-2026-11-04.md','# Draft');
    await p.app.vault.create('Data/text-machine-2026-11-06.md','# Future edition');
    const generate=p.generate;
    p.generate=async()=>assert.fail('A missing edition must not cross a surviving later edition');
    remove(previous.path);
    assert.equal(await p.writeNewsletter(),null);
    await p.app.vault.create(previous.path,'# Previous edition');
    remove(yesterday.path);
    await assert.rejects(p.writeNewsletter(),/5.*10/);
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)),before);
    remove(previous.path);
    p.generate=generate;
    const note=await p.writeNewsletter();
    assert.equal(note.path,'Data/text-machine-2026-11-05.md');
    assert.deepEqual(seen[0].articles.map(article=>article.id),[1,2,3,4,5,6,7,8,9,10]);
    const saved=JSON.parse(contents.get(p.dataPath));
    assert.ok(saved.articles.slice(0,10).every(article=>article.usedAt==='2026-11-05'));
    assert.deepEqual(saved.articles[10],articles[10]);
    assert.equal(contents.get(oldest.path),'# Surviving edition');
    assert.equal((await p.writeNewsletter()).path,note.path);
    assert.equal(seen.at(-1).articles.length,10);
});

test('without any older newsletter all dated sources can return, and a failed run keeps their dates',async()=>{
    const {p,contents,entries,seen}=await newsletterFixture();
    p.newsletter={...p.newsletter,day:()=> '2026-11-05'};
    const before={version:1,nextId:4,articles:[{...entries[0],usedAt:'2026-11-04'},{...entries[2],usedAt:'2000-01-01'}]};
    contents.set(p.dataPath,JSON.stringify(before));
    const generate=p.generate;
    p.generate=async()=>{throw new Error('Provider unavailable');};
    await assert.rejects(p.writeNewsletter(),/Provider unavailable/);
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)),before);
    p.generate=generate;
    assert.ok(await p.writeNewsletter());
    assert.deepEqual(seen[0].articles.map(article=>article.id),[1,3]);
});

function withStages(p, writer) {
    const generate=p.generate;
    return async(...args)=>{
        let context;
        try {context=JSON.parse(args[2]);} catch { /* Revisions contain plain prose. */ }
        if (args[2].startsWith('Runtime publisher') || ['Runtime selection','Runtime verifier'].includes(context?.instructions)) return generate(...args);
        const response=await writer(...args);
        if (context?.instructions==='My runtime prompt') {
            try {
                const result=JSON.parse(response);
                const complete=JSON.parse(writerResponse(result.paragraphs || [],context.articles));
                return JSON.stringify({...complete,...result,paragraphs:complete.paragraphs});
            } catch {return response;}
        }
        return response;
    };
}

test('today’s note is regenerated from used articles and new articles without duplicating files',async()=>{
    const {p,contents,entries,seen} = await newsletterFixture();
    const first = await p.writeNewsletter();
    assert.match(first.path,/^Data\/text-machine-\d{4}-\d{2}-\d{2}\.md$/);
    assert.ok(contents.get(first.path).startsWith('# A new newsletter'));
    const saved = JSON.parse(contents.get(p.dataPath));
    assert.equal(saved.notes,'Keep notes');
    assert.deepEqual(saved.articles.map(article=>article.status),['','','']);
    assert.equal(saved.articles[0].usedAt,p.newsletter.day());
    saved.nextId = 5;
    saved.articles.push({...entries[0],id:4,title:'new',url:'https://example.com/new'});
    contents.set(p.dataPath,JSON.stringify(saved));
    const second = await p.writeNewsletter();
    assert.equal(second.path,first.path);
    assert.equal([...contents.keys()].filter(path=>/\/text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(path)).length,1);
    assert.deepEqual(seen[1].articles.map(article=>article.title),['used','another','new']);
    assert.equal(seen[1].previousNewsletters.length,0);
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles[3].usedAt,p.newsletter.day());
});
test('a saved edition consumes every available article and the next day starts with new arrivals only',async()=>{
    const {p,contents,entries,seen}=await newsletterFixture();
    const generate=p.generate,selections=[];
    p.newsletter={...p.newsletter,day:()=> '2026-11-04'};
    p.generate=async(connection,system,input,...rest)=>{
        let context;
        try {context=JSON.parse(input);} catch { /* Revisions contain plain prose. */ }
        if (context?.instructions==='Runtime selection') selections.push(context.articles.map(article=>article.id));
        return generate(connection,system,input,...rest);
    };
    const note=await p.writeNewsletter();
    const first=JSON.parse(contents.get(p.dataPath));
    assert.deepEqual(first.articles.map(article=>article.status),['','','']);
    assert.ok(first.articles.every(article=>!Object.hasOwn(article,'used')));
    assert.deepEqual(first.articles.slice(0,2).map(article=>article.usedAt),['2026-11-04','2026-11-04']);
    assert.equal((await p.writeNewsletter()).path,note.path);
    assert.deepEqual(selections,[[1,2],[1,2]]);
    p.newsletter={...p.newsletter,day:()=> '2026-11-05'};
    p.generate=async()=>{throw new Error('Consumed sources cannot start a new edition');};
    assert.equal(await p.writeNewsletter(),null);
    const next=JSON.parse(contents.get(p.dataPath));
    next.nextId=6;next.articles.push({...entries[0],id:4,title:'New arrival',url:'https://example.com/new-arrival'},
        {...entries[1],id:5,title:'Another new arrival',url:'https://other.example/new-arrival'});
    contents.set(p.dataPath,JSON.stringify(next));
    p.generate=generate;
    const nextNote=await p.writeNewsletter();
    assert.equal(nextNote.path,'Data/text-machine-2026-11-05.md');
    assert.deepEqual(seen.at(-1).articles.map(article=>article.id),[4,5]);
    const saved=JSON.parse(contents.get(p.dataPath));
    assert.ok(!Object.hasOwn(saved.articles[3],'used'));assert.equal(saved.articles[3].usedAt,'2026-11-05');
    assert.deepEqual(saved.articles.slice(0,3),first.articles);
});

test('large source collections are selected in bounded batches before one global selection',async()=>{
    const {p,contents,entries,seen}=await newsletterFixture();
    const articles=Array.from({length:263},(_,index)=>({...entries[0],id:index+1,title:'Source '+index,
        url:'https://publisher-'+(index%2)+'.example/source-'+index,content:'Full article '+index+' '+ 'x'.repeat(13000)}));
    const before={version:1,nextId:264,articles};
    contents.set(p.dataPath,JSON.stringify(before));
    p.getAIConnection=()=>({provider:'codex',model:'fixture',apiKey:'',effort:'high'});
    const generate=p.generate,visited=new Set(),calls=[];
    p.codex={...p.codex,findCodex:async()=> 'fixture',generate:async(_executable,system,input)=>{
        if (Array.from(input).length>1048576) throw new Error('turn/start: Input exceeds the maximum length of 1048576 characters. (-32602)');
        assert.equal(contents.get(p.dataPath),JSON.stringify(before));
        let context;
        try {context=JSON.parse(input);} catch { /* The revision contains the article body. */ }
        if (context?.instructions==='Runtime selection') {
            const rows=context.articles;
            calls.push(rows.map(row=>row.id));
            for (const row of rows) {
                assert.equal(row.content,articles[row.id-1].content);
                visited.add(row.id);
            }
            return JSON.stringify({brief:[], selected:rows.slice(0,2).map(row=>row.id),discard:rows.slice(2).map(row=>row.id)});
        }
        return generate({},system,input);
    }};
    const note=await p.writeNewsletter();
    assert.ok(note);
    assert.equal(visited.size,articles.length);
    assert.ok(calls.length>2);
    assert.deepEqual(calls.at(-1),calls.slice(0,-1).flatMap(ids=>ids.slice(0,2)));
    assert.equal(seen.length,1);
    assert.deepEqual(seen[0].articles.map(row=>row.id),[1,2]);
    const saved=JSON.parse(contents.get(p.dataPath));
    assert.deepEqual(saved.articles.map(row=>({...row,usedAt:''})),articles.map(row=>({...row,usedAt:''})));
    assert.ok(saved.articles.every(row=>row.usedAt===p.newsletter.day()));
});

test('oversized individual sources and a selection that never reduces preserve notes and articles',async()=>{
    for (const count of [1,5]) {
        const {p,contents,entries}=await newsletterFixture();
        const articles=Array.from({length:count},(_,index)=>({...entries[0],id:index+1,title:'Source '+index,
            url:'https://example.com/source-'+index,content:'x'.repeat(count===1 ? 1100000 : 300000)}));
        if (count===1) articles.push({...entries[1],id:2});
        const before={version:1,nextId:articles.length+1,articles};
        contents.set(p.dataPath,JSON.stringify(before));
        let calls=0;
        p.generate=async(_connection,_system,input)=>{
            calls++;
            assert.ok(input.length<=1000000);
            const context=JSON.parse(input);
            return JSON.stringify({brief:[], selected:context.articles.map(row=>row.id),discard:[]});
        };
        await assert.rejects(p.writeNewsletter(),/maximum AI input size/);
        assert.equal(calls,count===1 ? 0 : 2);
        assert.deepEqual(JSON.parse(contents.get(p.dataPath)),before);
        assert.equal(contents.size,1);
    }
});

test('a failed or invalid selection batch stops before saving or consuming any sources',async()=>{
    for (const failure of ['provider','invalid']) {
        const {p,contents,entries}=await newsletterFixture();
        const articles=Array.from({length:8},(_,index)=>({...entries[0],id:index+1,title:'Source '+index,
            url:'https://example.com/source-'+index,content:'x'.repeat(300000)}));
        const before={version:1,nextId:9,articles};
        contents.set(p.dataPath,JSON.stringify(before));
        let calls=0;
        p.generate=async(_connection,_system,input)=>{
            calls++;
            assert.ok(input.length<=1000000);
            if (calls===2) {
                if (failure==='provider') throw new Error('Provider unavailable');
                return JSON.stringify({brief:[], selected:[],discard:[]});
            }
            const rows=JSON.parse(input).articles;
            return JSON.stringify({brief:[], selected:[rows[0].id],discard:rows.slice(1).map(row=>row.id)});
        };
        await assert.rejects(p.writeNewsletter(),failure==='provider' ? /Provider unavailable/ : /source selection/);
        assert.equal(calls,2);
        assert.deepEqual(JSON.parse(contents.get(p.dataPath)),before);
        assert.equal(contents.size,1);
    }
});

test('selection goes straight to writing without summaries before revision and publication',async()=>{
    const {p,contents}=await newsletterFixture();
    const before=contents.get(p.dataPath),generate=p.generate,stages=[];
    p.generate=async(connection,system,input,...rest)=>{
        assert.equal(contents.get(p.dataPath),before);
        if (input.startsWith('Runtime publisher')) stages.push('publisher');
        else if (system.startsWith('Runtime rewriter')) stages.push('revision');
        else {
            const context=JSON.parse(input);
            stages.push(context.instructions);
            assert.notEqual(context.instructions,'Runtime summaries');
            if (context.instructions!=='Runtime selection') assert.deepEqual(context.articles.map(article=>article.id),[1,2]);
            if (context.instructions==='My runtime prompt') assert.ok(!Object.hasOwn(context,'summaries'));
        }
        return generate(connection,system,input,...rest);
    };
    p.generateIllustration=async()=>{assert.equal(contents.get(p.dataPath),before);stages.push('image');return new ArrayBuffer(8);};
    const note=await p.writeNewsletter();
    assert.deepEqual(stages,['Runtime selection','My runtime prompt','revision','publisher','image']);
    assert.ok(contents.get(note.path).includes('First paragraph.'));
    assert.ok(!contents.get(note.path).includes('## Revue de presse'));
    assert.ok(!contents.get(note.path).includes('Article summary.'));
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)).articles.map(article=>article.status),['','','']);
});
test('the selected full articles go directly to the writer without a separate review section',async()=>{
    const {p,contents,entries,seen}=await newsletterFixture();
    const data=JSON.parse(contents.get(p.dataPath));data.nextId=5;
    data.articles.push({...entries[0],id:4,title:'Another selected source',url:'https://example.com/another',content:'A separate account with different facts.'});
    contents.set(p.dataPath,JSON.stringify(data));
    const read=p.app.vault.adapter.read;
    p.app.vault.adapter.read=async path=>{
        assert.ok(!path.endsWith('/resume.md') && !path.endsWith('/resume.json'));
        return read(path);
    };
    const note=await p.writeNewsletter();
    assert.equal(seen.length,1);
    assert.deepEqual(seen[0].articles.map(({id,title,content})=>({id,title,content})),
        [data.articles[0],data.articles[1],data.articles[3]].map(({id,title,content})=>({id,title,content})));
    const markdown=contents.get(note.path);
    assert.ok(markdown.includes('First paragraph.'));
    assert.ok(!markdown.includes('## Revue de presse'));
    assert.ok(!/^#### /m.test(markdown));
    const saved=JSON.parse(contents.get(p.dataPath)).articles;
    assert.deepEqual(saved.map(article=>({...article,usedAt:''})),data.articles.map(article=>({...article,usedAt:''})));
    assert.deepEqual([saved[0].usedAt,saved[3].usedAt],[p.newsletter.day(),p.newsletter.day()]);
});

test('failed, invalid or cancelled writing cannot save a partial edition or consume articles',async()=>{
    for (const failure of ['error','extra-field','empty','cancel']) {
        const {p,contents,entries}=await newsletterFixture();
        const data=JSON.parse(contents.get(p.dataPath));data.nextId=5;
        data.articles.push({...entries[0],id:4,title:'Second selected source',url:'https://example.com/second'});
        const before=JSON.stringify(data);contents.set(p.dataPath,before);
        const path='Data/text-machine-'+p.newsletter.day()+'.md';
        await p.app.vault.create(path,'# Existing edition');
        const generate=p.generate,stages=[];
        p.generate=async(connection,system,input,...rest)=>{
            const context=JSON.parse(input);stages.push(context.instructions);
            if (context.instructions==='My runtime prompt') {
                assert.deepEqual(context.articles.map(article=>article.id),[1,2,4]);
                if (failure==='error') throw new Error('Writer unavailable');
                if (failure==='cancel') p.aiController.abort();
                return JSON.stringify({paragraphs:failure==='empty' ? [] : ['First paragraph.','Second paragraph.'],
                    ...(failure==='extra-field' ? {status:'used'} : {})});
            }
            return generate(connection,system,input,...rest);
        };
        await assert.rejects(p.writeNewsletter(),/Writer unavailable|Invalid AI response|cancelled/);
        assert.deepEqual(stages,['Runtime selection','My runtime prompt']);
        assert.equal(contents.get(path),'# Existing edition');
        assert.equal(contents.get(p.dataPath),before);
        assert.ok(![...contents.keys()].some(path=>path.endsWith('.png')));
    }
});

test('publisher titles the revised body before image generation and cannot change the article',async()=>{
    const {p,contents}=await newsletterFixture();
    const generate=p.generate,before=contents.get(p.dataPath),stages=[];
    p.generate=async(connection,system,input,...rest)=>{
        if (system.startsWith('Runtime rewriter')) {
            stages.push('revision');
            return rewriteResponse(input.replace('First paragraph.','Revised first paragraph.'));
        }
        if (input.startsWith('Runtime publisher')) {
            stages.push('publisher');
            assert.equal(contents.get(p.dataPath),before);
            assert.ok(input.includes('Revised first paragraph.\n\nSecond paragraph.'));
            assert.ok(!input.includes('Article summary.'));
            assert.ok(!input.includes('A new newsletter'));
            assert.deepEqual(JSON.parse(system.split('\n\n').at(-1)).jsonSchema,require('../../models/publisher.json'));
            return JSON.stringify({title:'Title from the finished article',chapeau:'An introduction written afterwards.'});
        }
        return generate(connection,system,input,...rest);
    };
    const note=await p.writeNewsletter(),text=contents.get(note.path);
    assert.deepEqual(stages,['revision','publisher']);
    assert.ok(text.startsWith('# Title from the finished article'));
    assert.ok(text.includes('*An introduction written afterwards.*'));
    assert.ok(text.includes('Revised first paragraph.'));
});
test('debug off still revises the newsletter without creating or overwriting comparison files',async()=>{
    const {p,contents}=await newsletterFixture();
    assert.equal(p.settings.debug,false);
    const generate=p.generate,day=p.newsletter.day();
    let revisions=0;
    p.generate=async(connection,system,input,...rest)=>{
        if (system.startsWith('Runtime rewriter')) {
            revisions++;
            return rewriteResponse(input.replace('First paragraph.','Revised first paragraph.'));
        }
        return generate(connection,system,input,...rest);
    };
    const note=await p.writeNewsletter();
    assert.equal(revisions,1);
    assert.ok(contents.get(note.path).includes('Revised first paragraph.'));
    const draft='Data/brouillon-'+day+'.md',revision='Data/revision-'+day+'.md';
    assert.equal(contents.has(draft),false);
    assert.equal(contents.has(revision),false);
    await p.app.vault.create(draft,'Previous draft');
    await p.app.vault.create(revision,'Previous revision');
    await p.writeNewsletter();
    assert.equal(revisions,2);
    assert.equal(contents.get(draft),'Previous draft');
    assert.equal(contents.get(revision),'Previous revision');
});
test('daily draft and revision snapshots preserve both bodies and are replaced on regeneration',async()=>{
    const {p,contents,seen,entries}=await newsletterFixture();
    p.settings.debug=true;
    const before=contents.get(p.dataPath),generate=p.generate,day=p.newsletter.day();
    const draft='Data/brouillon-'+day+'.md',revision='Data/revision-'+day+'.md';
    let replacement='Revised first paragraph.';
    p.generate=async(connection,system,input,...rest)=>{
        if (system.startsWith('Runtime rewriter')) {
            assert.equal(contents.get(draft),input+'\n');
            assert.ok(contents.get(revision).includes('not completed'));
            assert.equal(contents.get(p.dataPath),before);
            return rewriteResponse(input.replace('First paragraph.',replacement));
        }
        return generate(connection,system,input,...rest);
    };
    await p.writeNewsletter();
    const original=JSON.parse(writerResponse(['First paragraph.','Second paragraph.'],entries.slice(0,2))).paragraphs.join('\n\n')+'\n';
    assert.equal(contents.get(draft),original);
    assert.equal(contents.get(revision),original.replace('First paragraph.','Revised first paragraph.'));
    assert.ok(!contents.get(draft).includes('A new newsletter'));
    const after=contents.get(p.dataPath);
    p.generate=async(connection,system,input,...rest)=>system.startsWith('Runtime rewriter')
        ? rewriteResponse(input.replace('First paragraph.','Another revised first paragraph.')) : generate(connection,system,input,...rest);
    replacement='Another revised first paragraph.';
    await p.writeNewsletter();
    assert.ok(contents.get(revision).startsWith(replacement));
    assert.equal([...contents.keys()].filter(path=>/\/(?:brouillon|revision)-/.test(path)).length,2);
    assert.equal(contents.get(p.dataPath),after);
    assert.deepEqual(seen[1].previousNewsletters,[]);
});
test('a rejected revision remains available for comparison while the newsletter keeps the original text',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    p.settings.debug=true;
    const generate=p.generate,day=p.newsletter.day();
    p.generate=async(connection,system,input,...rest)=>system.startsWith('Runtime rewriter')
        ? JSON.stringify({paragraphs:['Short.','Truncated.']}) : generate(connection,system,input,...rest);
    const note=await p.writeNewsletter();
    assert.equal(contents.get('Data/brouillon-'+day+'.md'),JSON.parse(writerResponse(['First paragraph.','Second paragraph.'],entries.slice(0,2))).paragraphs.join('\n\n')+'\n');
    const revision=contents.get('Data/revision-'+day+'.md');
    assert.ok(revision.includes('original article retained'));
    assert.ok(revision.includes('```\nShort.\n\nTruncated.\n```'));
    assert.ok(contents.get(note.path).includes('First paragraph.'));
});
test('snapshot write failures stop generation without replacing an existing newsletter or article usage',async()=>{
    const {p,contents}=await newsletterFixture();
    p.settings.debug=true;
    const before=contents.get(p.dataPath),path='Data/text-machine-'+p.newsletter.day()+'.md';
    await p.app.vault.create(path,'# Existing newsletter');
    const create=p.app.vault.create;
    p.app.vault.create=async(path,text)=>{
        if (path.includes('/brouillon-')) throw new Error('Disk full');
        return create(path,text);
    };
    await assert.rejects(p.writeNewsletter(),/comparison text.*brouillon-/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal(contents.get(path),'# Existing newsletter');
});
test('publisher errors, invalid output and cancellation preserve the saved note and article usage',async()=>{
    for (const failure of ['empty-prompt','error','invalid','extra-body','cancel']) {
        const {p,contents}=await newsletterFixture();
        const before=contents.get(p.dataPath),generate=p.generate,path='Data/text-machine-'+p.newsletter.day()+'.md';
        await p.app.vault.create(path,'# Existing edition');
        if (failure==='empty-prompt') {
            const read=p.app.vault.adapter.read;
            p.app.vault.adapter.read=async path=>path.endsWith('/prompts/publisher.md') ? '' : read(path);
        }
        p.generate=async(connection,system,input,...rest)=>{
            if (!input.startsWith('Runtime publisher')) return generate(connection,system,input,...rest);
            if (failure==='error') throw new Error('Publisher unavailable');
            if (failure==='cancel') p.aiController.abort();
            return JSON.stringify({title:'Too late',chapeau:'An intro',...(failure==='extra-body' ? {paragraphs:['Changed body']} : failure==='invalid' ? {chapeau:''} : {})});
        };
        await assert.rejects(p.writeNewsletter(),/publisher.md.*empty|Publisher unavailable|Invalid AI response|cancelled/);
        assert.equal(contents.get(path),'# Existing edition');
        assert.equal(contents.get(p.dataPath),before);
        assert.ok(![...contents.keys()].some(path=>path.endsWith('.png')));
    }
});

test('a one-publication selection is reconsidered before writing a multi-publication press review',async()=>{
    const {p,contents}=await newsletterFixture();
    const generate=p.generate;
    let selections=0;
    p.generate=async(connection,system,input,...rest)=>{
        let context;try {context=JSON.parse(input);} catch { /* Publisher receives prose. */ }
        if (context?.instructions==='Runtime selection') {
            selections++;
            if (selections===1) return JSON.stringify({selected:[1],brief:[2],discard:[]});
            assert.ok(system.includes(p.i18n.t('selectionMultiplePublications')));
        }
        return generate(connection,system,input,...rest);
    };
    const progress=[],note=await p.writeNewsletter(message=>progress.push(message));
    assert.equal(selections,2);
    assert.ok(progress.includes(p.i18n.t('newsletterReselectingSources')));
    assert.ok(contents.get(note.path).includes('First paragraph.'));
    assert.ok(!contents.get(note.path).includes('### In brief'));
});

test('a writer using only one publication is asked to rewrite before any note is saved',async()=>{
    const {p,contents}=await newsletterFixture();
    const generate=p.generate,before=contents.get(p.dataPath);
    let attempts=0;
    p.generate=async(connection,system,input,...rest)=>{
        let context;try {context=JSON.parse(input);} catch { /* Publisher receives prose. */ }
        if (context?.instructions==='My runtime prompt') {
            attempts++;
            assert.equal(contents.get(p.dataPath),before);
            if (attempts===1) return JSON.stringify({paragraphs:['One author describes a practice.','Another post by the same author develops it.'],used:[1]});
            assert.ok(system.includes(p.i18n.t('writerMultiplePublications')));
        }
        return generate(connection,system,input,...rest);
    };
    const progress=[],note=await p.writeNewsletter(message=>progress.push(message));
    assert.equal(attempts,2);
    assert.ok(progress.includes(p.i18n.t('newsletterExpandingReview')));
    assert.ok(contents.get(note.path).includes('First paragraph.'));
});

test('a press review from one publication cannot replace the saved edition or consume articles',async()=>{
    for (const failure of ['same-publication','selection','writer','writer-citations']) {
        const {p,contents}=await newsletterFixture();
        const data=JSON.parse(contents.get(p.dataPath));
        if (failure==='same-publication') data.articles[1].url='https://www.example.com/another-post';
        const before=JSON.stringify(data);contents.set(p.dataPath,before);
        const path='Data/text-machine-'+p.newsletter.day()+'.md';
        await p.app.vault.create(path,'# Previous edition');
        const generate=p.generate;
        let selections=0,writers=0;
        p.generate=async(connection,system,input,...rest)=>{
            let context;try {context=JSON.parse(input);} catch { /* Publisher receives prose. */ }
            if (context?.instructions==='Runtime selection') {
                selections++;
                if (failure==='selection') return JSON.stringify({selected:[1],brief:[2],discard:[]});
            }
            if (context?.instructions==='My runtime prompt') {
                writers++;
                if (failure==='writer') return JSON.stringify({paragraphs:['A single author.', 'The same author again.'],used:[1]});
                if (failure==='writer-citations') return JSON.stringify({paragraphs:['A [single author](https://example.com/used).','The same author again.'],used:[1,2]});
                assert.fail('Do not write a RP when the selection has only one publication');
            }
            return generate(connection,system,input,...rest);
        };
        p.generateIllustration=()=>assert.fail('Do not illustrate a rejected RP');
        await assert.rejects(p.writeNewsletter(),error=>error.message===p.i18n.t('newsletterMultiplePublications'));
        assert.equal(contents.get(path),'# Previous edition');
        assert.equal(contents.get(p.dataPath),before);
        assert.equal(selections,failure==='selection' ? 2 : 1);
        assert.equal(writers,failure.startsWith('writer') ? 2 : 0);
    }
});

test('the brief includes blocked sources, secondary selections and every selected article omitted by the writer',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    p.settings.imageMode='none';
    const source=(id,title,extra={})=>({...entries[0],id,title,url:'https://example.com/story-'+id,...extra});
    const rows=[source(11,'Major literary development'),source(12,'Another publication',{url:'https://other.example/story-12'}),source(13,'Minor scandal in India'),
        source(14,'Unrelated politics'),source(15,'Blocked literary article',{status:'forbidden',content:''}),
        source(16,'Blocked football article',{status:'forbidden',content:''}),source(17,'Useful secondary perspective')];
    contents.set(p.dataPath,JSON.stringify({version:1,nextId:18,articles:rows}));
    const generate=p.generate;let translated=[];
    p.generate=async(connection,system,input,...rest)=>{
        let context;try {context=JSON.parse(input);} catch { /* Publisher receives prose. */ }
        if (context?.instructions==='Runtime selection') return JSON.stringify({selected:[11,12,17],brief:[13],discard:[14]});
        if (context?.instructions==='My runtime prompt') return JSON.stringify({paragraphs:[
            'A major literary development changes publishing practices. The [source](https://example.com/story-11) reports the facts.',
            'The [other publication](https://other.example/story-12) adds another finding.'],used:[11,12]});
        if (system.startsWith('Runtime brief')) {
            translated=context;
            assert.ok(system.includes(p.i18n.t('briefSelectedContract',{ids:'13, 17'})));
            return JSON.stringify({titles:context.map(row=>({id:row.id,title:row.id===16 ? null : 'Translated '+row.title,
                category:row.id===16 ? null : row.id===17 ? 'Pratiques d’écriture' : 'Vie littéraire'}))});
        }
        if (context?.instructions==='Runtime verifier') assert.deepEqual(context.articles.map(row=>row.id),[11,12]);
        return generate(connection,system,input,...rest);
    };
    const note=await p.writeNewsletter(),markdown=contents.get(note.path);
    assert.deepEqual(translated.map(row=>row.id),[15,16,13,17]);
    assert.equal(translated.find(row=>row.id===13).context,rows.find(row=>row.id===13).content);
    assert.equal(translated.find(row=>row.id===17).context,rows.find(row=>row.id===17).content);
    assert.ok(translated.filter(row=>[15,16].includes(row.id)).every(row=>!Object.hasOwn(row,'context')));
    const [body,brief]=markdown.split('### In brief');
    assert.ok(brief.includes('#### Vie littéraire'));
    assert.ok(brief.includes('#### Pratiques d’écriture'));
    assert.ok(brief.indexOf('https://example.com/story-13')<brief.indexOf('#### Pratiques d’écriture'));
    assert.ok(body.includes('https://example.com/story-11'));
    assert.ok(!body.includes('Minor scandal in India'));
    for (const id of [13,15,17]) assert.ok(brief.includes('https://example.com/story-'+id));
    assert.ok(body.includes('https://other.example/story-12'));
    assert.ok(!brief.includes('https://other.example/story-12'));
    for (const id of [11,14,16]) assert.ok(!brief.includes('https://example.com/story-'+id));
    const saved=JSON.parse(contents.get(p.dataPath)).articles;
    assert.deepEqual(saved.map(row=>row.title),rows.map(row=>row.title));
    assert.ok(saved.every(row=>row.usedAt===p.newsletter.day()));
    assert.equal(saved.find(row=>row.id===15).status,'forbidden');
});

test('secondary-only editions are saved without forcing a main article or losing a source declined by the writer',async()=>{
    for (const decline of [false,true]) {
        const {p,contents}=await newsletterFixture();
        p.settings.imageMode='none';
        const generate=p.generate;
        let writing=0;
        p.generate=async(connection,system,input,...rest)=>{
            let context;try {context=JSON.parse(input);} catch { /* Publisher receives prose. */ }
            if (context?.instructions==='Runtime selection') return JSON.stringify({selected:decline ? [1,2] : [],brief:decline ? [] : [1,2],discard:[]});
            if (context?.instructions==='My runtime prompt') {writing++;return JSON.stringify({paragraphs:[],used:[]});}
            if (input.startsWith('Runtime publisher') || context?.instructions==='Runtime verifier') assert.fail('No main article to publish or verify');
            return generate(connection,system,input,...rest);
        };
        const note=await p.writeNewsletter(),text=contents.get(note.path);
        assert.equal(writing,decline ? 1 : 0);
        assert.ok(text.includes('[used](https://example.com/used)'));
        assert.ok(!text.includes('First paragraph.'));
        assert.equal(JSON.parse(contents.get(p.dataPath)).articles[0].usedAt,p.newsletter.day());
    }
});

test('translation cannot silently remove an article already selected for the brief',async()=>{
    const {p,contents}=await newsletterFixture();
    const before=contents.get(p.dataPath),generate=p.generate;
    p.generate=async(connection,system,input,...rest)=>{
        let context;try {context=JSON.parse(input);} catch { /* Publisher receives prose. */ }
        if (context?.instructions==='Runtime selection') return JSON.stringify({selected:[],brief:[1,2],discard:[]});
        if (system.startsWith('Runtime brief')) return JSON.stringify({titles:[{id:1,title:'A title',category:'Écriture'},{id:2,title:null,category:null}]});
        return generate(connection,system,input,...rest);
    };
    p.generateIllustration=()=>assert.fail('Do not generate an image after a missing brief title');
    await assert.rejects(p.writeNewsletter(),/Translation.*incomplete or invalid/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal(contents.size,1);
});

test('overlong introductions are retried only at publication and the retired verifier is never called',async()=>{
    for (const phase of ['publisher','verifier']) {
        const {p,contents}=await newsletterFixture();
        p.settings.imageMode='none';
        const generate=p.generate,long=Array.from({length:36},(_,index)=>'word'+index).join(' ');
        const short='Publishers confront a concrete change in literary practice.';
        let calls=0;
        p.generate=async(connection,system,input,...rest)=>{
            let context;try {context=JSON.parse(input);} catch { /* Publisher receives prose. */ }
            if (phase==='publisher' ? input.startsWith('Runtime publisher') : context?.instructions==='Runtime verifier') {
                calls++;
                if (calls===2) assert.ok(system.includes(p.i18n.t('publicationShorten')));
                return JSON.stringify(phase==='publisher' ? {title:'A concrete change',chapeau:calls===1 ? long : short}
                    : {...context.newsletter,chapeau:calls===1 ? long : short,issues:[]});
            }
            return generate(connection,system,input,...rest);
        };
        const progress=[];
        if (phase==='verifier') {
            const note=await p.writeNewsletter(message=>progress.push(message));
            assert.equal(calls,0);
            assert.ok(contents.get(note.path).includes('Books meet AI.'));
            assert.ok(!contents.get(note.path).includes(long));
            assert.ok(!progress.includes(p.i18n.t('newsletterShorteningChapeau')));
            continue;
        }
        const note=await p.writeNewsletter(message=>progress.push(message));
        assert.equal(calls,2);
        assert.ok(contents.get(note.path).includes(short));
        assert.ok(!contents.get(note.path).includes(long));
        assert.ok(progress.includes(p.i18n.t('newsletterShorteningChapeau')));
    }
});

test('a repeatedly overlong introduction preserves the saved edition and article usage',async()=>{
    for (const phase of ['publisher','verifier']) {
        const {p,contents}=await newsletterFixture();
        const before=contents.get(p.dataPath),generate=p.generate,path='Data/text-machine-'+p.newsletter.day()+'.md';
        await p.app.vault.create(path,'# Saved edition');
        let calls=0;
        p.generate=async(connection,system,input,...rest)=>{
            let context;try {context=JSON.parse(input);} catch { /* Publisher receives prose. */ }
            if (phase==='publisher' ? input.startsWith('Runtime publisher') : context?.instructions==='Runtime verifier') {
                calls++;
                const chapeau=Array.from({length:36},()=> 'word').join(' ');
                return JSON.stringify(phase==='publisher' ? {title:'Title',chapeau} : {...context.newsletter,chapeau,issues:[]});
            }
            return generate(connection,system,input,...rest);
        };
        if (phase==='verifier') {
            const note=await p.writeNewsletter();
            assert.equal(calls,0);
            assert.ok(contents.get(note.path).includes('Books meet AI.'));
            continue;
        }
        p.generateIllustration=()=>assert.fail('Do not generate an image with an overlong introduction');
        await assert.rejects(p.writeNewsletter(),error=>error.code==='CHAPEAU_TOO_LONG');
        assert.equal(calls,2);
        assert.equal(contents.get(path),'# Saved edition');
        assert.equal(contents.get(p.dataPath),before);
    }
});

test('publication saves the writer and publisher output without calling a final verifier',async()=>{
    const {p,contents,publisher}=await newsletterFixture();
    const data=JSON.parse(contents.get(p.dataPath));
    data.articles[0].authors=['Anne R. Allen'];
    data.articles[0].content='Anne R. Allen received two emails from scammers claiming to run an AI detection service. Their identities are unknown.';
    contents.set(p.dataPath,JSON.stringify(data));
    publisher.chapeau='Deux courriels accusent Anne R. Allen et lui réclament de l’argent.';
    const original=['Deux courriels accusent la romancière Anne R. Allen et lui réclament de l’argent pour nettoyer ses textes.',
        'Elle raconte cette tentative d’extorsion sur [son blog](https://example.com/used). Une [autre publication](https://other.example/another) rapporte une autre analyse.'];
    const generate=p.generate;
    let verifications=0,imageInput='';
    p.generate=async(connection,system,input,...rest)=>{
        let context;try {context=JSON.parse(input);} catch { /* Article body in revision. */ }
        if (context?.instructions==='My runtime prompt') return JSON.stringify({paragraphs:original,used:context.articles.map(article=>article.id)});
        if (context?.instructions==='Runtime verifier') {
            verifications++;
            assert.fail('The retired verifier must not run');
        }
        return generate(connection,system,input,...rest);
    };
    p.generateIllustration=async(_key,prompt)=>{imageInput=prompt;return new ArrayBuffer(8);};
    const note=await p.writeNewsletter();
    assert.equal(verifications,0);
    assert.ok(contents.get(note.path).includes(publisher.title));
    assert.ok(contents.get(note.path).includes(publisher.chapeau));
    assert.ok(contents.get(note.path).includes(original[0]));
    assert.ok(!contents.get(note.path).includes('Des escrocs se présentant'));
    assert.ok(imageInput.includes(publisher.title));
    assert.ok(imageInput.includes(original[0]));
});

test('missing or failing retired verifier resources cannot block newsletter generation',async()=>{
    for (const failure of ['empty-prompt','provider','invalid','unresolved','links','cancel']) {
        const {p,contents}=await newsletterFixture();
        const generate=p.generate,path='Data/text-machine-'+p.newsletter.day()+'.md';
        await p.app.vault.create(path,'# Existing edition');
        if (failure==='empty-prompt') {
            const read=p.app.vault.adapter.read;
            p.app.vault.adapter.read=async path=>path.endsWith('/prompts/verifier.md') ? '' : read(path);
        }
        let verifications=0,images=0;
        p.generate=async(connection,system,input,...rest)=>{
            let context;try {context=JSON.parse(input);} catch { /* Article body in revision. */ }
            if (context?.instructions!=='Runtime verifier') return generate(connection,system,input,...rest);
            verifications++;
            if (failure==='provider') throw new Error('Verifier unavailable');
            if (failure==='invalid') return '{broken';
            if (failure==='cancel') p.aiController.abort();
            return JSON.stringify({issues:failure==='unresolved' ? ['Cannot identify the sender from the source.'] : [],
                ...(failure==='links' ? {paragraphs:[...context.newsletter.paragraphs,'See [invented source](https://other.test/article).']} : {})});
        };
        p.generateIllustration=async()=>{images++;return new ArrayBuffer(8);};
        const note=await p.writeNewsletter();
        assert.equal(note.path,path);
        assert.equal(verifications,0);
        assert.equal(images,1);
        assert.ok(contents.get(path).includes('A new newsletter'));
        assert.ok(!contents.get(path).includes('invented source'));
        assert.ok([...contents.keys()].some(path=>path.endsWith('.png')));
    }
});

test('saved reference sources are passed to selection and writing without overriding relevance',async()=>{
    const {p,contents}=await newsletterFixture();
    p.settings.referenceSources='news.example.com';
    await p.saveData(p.settings);
    await p.onload();
    assert.equal(p.settings.referenceSources,'news.example.com');
    const generate=p.generate,seen=[];
    p.generate=async(connection,system,input,...rest)=>{
        let context;
        try {context=JSON.parse(input);} catch { /* Revisions receive plain prose. */ }
        if (context?.instructions==='Runtime selection' || context?.instructions==='My runtime prompt') {
            const ids='1';
            assert.ok(system.includes(p.i18n.t('referenceSourcesContract',{ids})));
            seen.push(context.instructions);
        }
        return generate(connection,system,input,...rest);
    };
    const note=await p.writeNewsletter();
    assert.ok(contents.get(note.path).includes('A new newsletter'));
    assert.deepEqual(seen,['Runtime selection','My runtime prompt']);
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)).articles.map(article=>article.status),['','','']);
});

test('invalid selection and writer responses stop before writing or generating an image',async()=>{
    for (const stage of ['Runtime selection','My runtime prompt']) {
        const {p,contents}=await newsletterFixture();
        const before=contents.get(p.dataPath),generate=p.generate;
        const path='Data/text-machine-'+p.newsletter.day()+'.md';
        await p.app.vault.create(path,'# Existing edition');
        p.generate=async(connection,system,input,...rest)=>{
            if (JSON.parse(input).instructions===stage) return stage==='Runtime selection'
                ? JSON.stringify({brief:[], selected:[1],discard:[]}) : JSON.stringify({paragraphs:[]});
            return generate(connection,system,input,...rest);
        };
        p.generateIllustration=async()=>{throw new Error('An invalid stage cannot generate an image');};
        await assert.rejects(p.writeNewsletter(),/Invalid AI response/);
        assert.equal(contents.get(p.dataPath),before);
        assert.equal(contents.get(path),'# Existing edition');
        assert.ok(![...contents.keys()].some(path=>path.endsWith('.png')));
    }
});

test('newsletter saving applies French punctuation to the rendered note without rewriting source content',async()=>{
    for (const language of ['français','English']) {
        const {p,contents,entries,publisher} = await newsletterFixture();
        Object.assign(publisher,{title:"L'IA: demain...",chapeau:"L'auteur s'interroge: vraiment?"});
        p.settings.newsletterLanguage = language;
        p.generate = withStages(p, async(_connection,_system,input)=>_system.startsWith('Runtime rewriter') ? rewriteResponse(input) : JSON.stringify({paragraphs:["«Un livre!», dit l'auteur.","L'auteur: 25 euros. Un lien [L'IA?](https://example.com/used)."]}));
        const note = await p.writeNewsletter();
        const markdown = contents.get(note.path);
        assert.ok(markdown.startsWith(language==='français' ? '# L’IA\u00a0: demain…' : "# L'IA: demain..."));
        assert.ok(markdown.includes(language==='français' ? '*L’auteur s’interroge\u00a0: vraiment\u00a0?*' : "*L'auteur s'interroge: vraiment?*"));
        assert.ok(markdown.includes(language==='français' ? 'L’auteur\u00a0: 25\u00a0euros.' : "L'auteur: 25 euros."));
        assert.ok(markdown.includes("[L'IA?](https://example.com/used)"));
        assert.equal(JSON.parse(contents.get(p.dataPath)).articles[0].content,entries[0].content);
    }
});

test('the runtime rewriter prompt runs after writing and its revision is saved before typography',async()=>{
    const {p,contents} = await newsletterFixture();
    const read = p.app.vault.adapter.read;
    p.app.vault.adapter.read = async path=>path.endsWith('/prompts/rewriter.md')
        ? 'Runtime custom revision in {{language}}. Simplify jargon while preserving the facts.' : read(path);
    const generate = p.generate;
    let revisions = 0;
    p.generate = withStages(p, async(connection,system,input,...rest)=>{
        if (system.startsWith('Runtime custom revision')) {
            revisions++;
            assert.ok(system.includes('Runtime custom revision in français'));
            assert.ok(!system.includes('{{language}}'));
            return rewriteResponse(input.replace('Une étude quasi expérimentale compare deux groupes existants.','Une étude compare deux groupes existants.'));
        }
        const result = JSON.parse(await generate(connection,system,input,...rest));
        result.paragraphs[0] = 'Une étude quasi expérimentale compare deux groupes existants. '+ 'La méthode garde des limites explicites. '.repeat(10);
        return JSON.stringify(result);
    });
    const note = await p.writeNewsletter();
    assert.equal(revisions,1);
    assert.ok(!contents.get(note.path).includes('étude quasi expérimentale'));
    assert.ok(contents.get(note.path).includes('Une étude compare deux groupes existants.'));
});

test('only article paragraphs are revised; titles, chapeau and captions stay outside the request',async()=>{
    const {p,contents,publisher,entries}=await newsletterFixture();
    p.settings.newsletterLanguage='English';
    Object.assign(publisher,{title:'TITLE MUST STAY',chapeau:'CHAPEAU MUST STAY'});
    const paragraphs=['The original article prose.','The second paragraph [Source](https://example.com/used).'];
    let revisions=0;
    p.generate=withStages(p, async(_connection,system,input)=>{
        if (system.startsWith('Runtime rewriter')) {
            revisions++;
            assert.equal(input,JSON.parse(writerResponse(paragraphs,entries.slice(0,2))).paragraphs.join('\n\n'));
            assert.deepEqual(JSON.parse(system.split('\n\n').at(-1)).jsonSchema,require('../../models/rewriter.json'));
            for (const absent of ['TITLE MUST STAY','CHAPEAU MUST STAY','![','Attachments/']) assert.ok(!input.includes(absent));
            return rewriteResponse(input.replace('original article prose','revised article prose'));
        }
        return JSON.stringify({paragraphs});
    });
    const note=await p.writeNewsletter();
    const markdown=contents.get(note.path);
    assert.equal(revisions,1);
    assert.ok(markdown.startsWith('# TITLE MUST STAY'));
    assert.ok(markdown.includes('*CHAPEAU MUST STAY*'));
    assert.ok(markdown.includes('The revised article prose.'));
    assert.ok(markdown.includes('](Attachments/'));
});

test('Codex receives the revision schema with plain article paragraphs and no image input',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    p.settings.newsletterLanguage='English';
    p.settings.aiModel='__codex__';
    p.settings.codexModel='fixture';
    p.settings.codexEffort='high';
    delete p.getAIConnection;
    let revisions=0;
    p.codex={...p.codex,findCodex:async()=>'/test/codex',generate:async(_path,system,input,_model,signal,progress,schema,image,effort)=>{
        assert.equal(effort,'high');
        if (system.startsWith('Runtime rewriter')) {
            revisions++;
            assert.deepEqual(JSON.parse(JSON.stringify(schema)),require('../../models/rewriter.json'));
            assert.equal(input,JSON.parse(writerResponse(['First paragraph.','Second paragraph.'],entries.slice(0,2))).paragraphs.join('\n\n'));
            assert.equal(image,undefined);
            return rewriteResponse(input.replace('First paragraph.','Revised paragraph.'));
        }
        return p.generate({},system,input,p.requestAI,signal,progress);
    }};
    const note=await p.writeNewsletter();
    assert.equal(revisions,1);
    assert.ok(contents.get(note.path).includes('Revised paragraph.'));
    assert.ok(contents.get(note.path).includes('](Attachments/'));
});

test('failed body revisions save the original article while cancellation still prevents saving',async()=>{
    for (const failure of ['error','truncated','link','empty','malformed','image','cancel']) {
        const {p,contents} = await newsletterFixture();
        const before = contents.get(p.dataPath), generate = p.generate;
        p.generate = withStages(p, async(connection,system,input,...rest)=>{
            if (!system.startsWith('Runtime rewriter')) {
                const result=JSON.parse(await generate(connection,system,input,...rest));
                result.paragraphs[0]+=' [Source](https://example.com/used)';
                return JSON.stringify(result);
            }
            if (failure==='error') throw new Error('Rewriter unavailable');
            if (failure==='cancel') {p.aiController.abort();return input;}
            if (failure==='empty') return '';
            if (failure==='malformed') return '{broken';
            if (failure==='image') return rewriteResponse(input+'\n\n![Image](https://example.com/image.jpg)');
            return failure==='truncated' ? JSON.stringify({paragraphs:[input.slice(0,20),'Too short.']})
                : rewriteResponse(input.replace('https://example.com/used','https://other.com/used'));
        });
        if (failure==='cancel') {
            await assert.rejects(p.writeNewsletter(),/cancelled/);
            assert.equal(contents.get(p.dataPath),before);
            assert.equal([...contents.keys()].filter(path=>/\/text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(path)).length,0);
        } else {
            const progress=[];
            const note=await p.writeNewsletter((message,stream,reset)=>progress.push({message,stream,reset}));
            const markdown=contents.get(note.path);
            assert.ok(markdown.includes('First paragraph. [Source](https://example.com/used)'));
            assert.ok(!markdown.includes('https://other.com/used'));
            assert.ok(markdown.includes('](Attachments/'));
            assert.deepEqual(JSON.parse(contents.get(p.dataPath)).articles.map(article=>article.status),['','','']);
            assert.ok(progress.some(entry=>entry.message.includes('original article retained')));
            assert.ok(progress.some(entry=>entry.stream && entry.reset && entry.message.includes('First paragraph.')));
        }
    }
});

test('without author feeds or optional history variables no context is fetched',async()=>{
    const {p,contents,seen} = await newsletterFixture();
    p.settings.authorFeeds='';
    const old = await p.app.vault.create('Data/text-machine-2000-01-01.md','# Old newsletter');
    const read = p.app.vault.read;
    p.app.vault.read = async file=>{assert.notEqual(file,old);return read(file);};
    const readResource = p.app.vault.adapter.read;
    p.app.vault.adapter.read = async path=>path.endsWith('/prompts/writer.md')
        ? '{"instructions":"My runtime prompt","articles":{{ articles }},"language":"{{language}}"}' : readResource(path);
    p.request = async()=>{throw new Error('The feed must not be fetched');};
    p.settings.newsletterLanguage = 'español';
    const note = await p.writeNewsletter();
    assert.ok(contents.get(note.path).startsWith('# A new newsletter'));
    assert.equal(seen[0].language,'español');
    assert.ok(!Object.hasOwn(seen[0],'previousNewsletters'));
    assert.ok(!Object.hasOwn(seen[0],'recentPosts'));
});
test('selection receives history even when only its prompt requests it, excluding today’s edition',async()=>{
    const {p,contents,seen}=await newsletterFixture();
    const oldPath='Data/text-machine-2000-01-01.md';
    await p.app.vault.create(oldPath,'# Earlier coverage of the Orélien affair');
    const today='Data/text-machine-'+p.newsletter.day()+'.md';
    await p.app.vault.create(today,'# Current edition must stay outside history');
    const read=p.app.vault.adapter.read;
    p.app.vault.adapter.read=async path=>path.endsWith('/prompts/sélection.md')
        ? '{"instructions":"Runtime selection","previousNewsletters":{{previousNewsletters}},"articles":{{articles}}}'
        : path.endsWith('/prompts/writer.md') ? '{"instructions":"My runtime prompt","articles":{{articles}}}' : read(path);
    const generate=p.generate;
    let selections=0;
    p.generate=async(connection,system,input,...rest)=>{
        let context;
        try {context=JSON.parse(input);} catch { /* Revisions contain plain prose. */ }
        if (context?.instructions==='Runtime selection') {
            selections++;
            assert.deepEqual(context.previousNewsletters,[{name:'text-machine-2000-01-01.md',content:contents.get(oldPath)}]);
            return JSON.stringify({brief:[], selected:[1,2],discard:[]});
        }
        return generate(connection,system,input,...rest);
    };
    assert.equal((await p.writeNewsletter()).path,today);
    assert.equal(selections,1);
    assert.deepEqual(seen[0].articles.map(article=>article.id),[1,2]);
    assert.ok(!Object.hasOwn(seen[0],'previousNewsletters'));
    assert.equal(contents.get(oldPath),'# Earlier coverage of the Orélien affair');
});

test('the configured Substack is fetched by the plugin and its posts are inserted in the prompt',async()=>{
    const {p,seen} = await newsletterFixture();
    const urls = [];
    p.request = async options=>{urls.push(options.url);return {status:200,text:'<rss/>'};};
    await p.writeNewsletter();
    assert.deepEqual(urls,['https://example.substack.com/feed']);
    assert.equal(seen[0].recentPosts[0].title,'Recent blog post');
    assert.equal(seen[0].recentPosts[0].content,'Recent idea');
});
test('author publications are excluded before selection and supplied only as topic history',async()=>{
    const {p,contents,entries,seen}=await newsletterFixture();
    const own={...entries[0],id:4,title:'My post',url:'https://example.substack.com/p/my-post'};
    const ownBrief={...own,id:5,title:'My inaccessible post',url:'https://example.substack.com/p/unreadable',status:'forbidden'};
    const data=JSON.parse(contents.get(p.dataPath));data.nextId=6;data.articles.push(own,ownBrief);
    contents.set(p.dataPath,JSON.stringify(data));
    const posts=[{title:own.title,url:own.url,publish:'2026-11-03',content:'A topic already covered by the author.'}];
    p.newsletter.readFeed=()=>posts;
    const read=p.app.vault.adapter.read,generate=p.generate;
    p.app.vault.adapter.read=async path=>path.endsWith('/prompts/sélection.md')
        ? '{"instructions":"Runtime selection","articles":{{articles}},"history":{{AuthorFeed}}}'
        : path.endsWith('/prompts/writer.md') ? '{"instructions":"My runtime prompt","articles":{{articles}}}' : read(path);
    let selections=0;
    p.generate=async(connection,system,input,...rest)=>{
        let context;try {context=JSON.parse(input);} catch { /* Prose in later stages. */ }
        if (context?.instructions==='Runtime selection') {
            selections++;
            assert.deepEqual(context.articles.map(article=>article.id),[1,2]);
            assert.deepEqual(context.history,posts);
        }
        assert.ok(!system.startsWith('Runtime brief'));
        return generate(connection,system,input,...rest);
    };
    const note=await p.writeNewsletter();
    assert.equal(selections,1);
    assert.ok(!contents.get(note.path).includes(own.url));
    assert.deepEqual(seen[0].articles.map(article=>article.id),[1,2]);
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)).articles.slice(-2),[own,ownBrief]);
});
test('a writer or publisher reusing an author-feed link cannot replace the saved newsletter',async()=>{
    for (const stage of ['writer','publisher']) {
        const {p,contents}=await newsletterFixture();
        const before=contents.get(p.dataPath),generate=p.generate,path='Data/text-machine-'+p.newsletter.day()+'.md';
        await p.app.vault.create(path,'# Existing edition');
        const own='https://example.substack.com/p/own-post';
        p.generate=async(connection,system,input,...rest)=>{
            if (stage==='publisher' && input.startsWith('Runtime publisher')) return JSON.stringify({title:'My post',chapeau:'See '+own});
            let context;try {context=JSON.parse(input);} catch { /* Prose in later stages. */ }
            if (stage==='writer' && context?.instructions==='My runtime prompt') return writerResponse(['A reference [My post]('+own+').','Second paragraph.'],context.articles);
            return generate(connection,system,input,...rest);
        };
        await assert.rejects(p.writeNewsletter(),/author-feed link/);
        assert.equal(contents.get(path),'# Existing edition');
        assert.equal(contents.get(p.dataPath),before);
    }
});
test('a revision adding a plain author URL is retained only for comparison and the original article is published',async()=>{
    const {p,contents}=await newsletterFixture();
    p.settings.debug=true;
    const generate=p.generate;
    p.generate=async(connection,system,input,...rest)=>system.startsWith('Runtime rewriter')
        ? rewriteResponse(input+'\n\nhttps://example.substack.com/p/own-post') : generate(connection,system,input,...rest);
    const note=await p.writeNewsletter();
    assert.ok(!contents.get(note.path).includes('example.substack.com/p/own-post'));
    const revision=contents.get('Data/revision-'+p.newsletter.day()+'.md');
    assert.ok(revision.includes('original article retained'));
    assert.ok(revision.includes('example.substack.com/p/own-post'));
});
test('an author feed cannot also be imported as a source feed',async()=>{
    const {p}=await newsletterFixture();
    p.settings.includeFeeds=p.settings.authorFeeds;
    p.request=async()=>{throw new Error('Author feeds must not be collected');};
    assert.equal(await p.importFeeds(),0);
});
test('only author publications produce no edition and do not consume the saved articles',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    const before=JSON.stringify({version:1,nextId:2,articles:[{...entries[0],url:'https://example.substack.com/p/my-post'}]});
    contents.set(p.dataPath,before);
    p.generate=async()=>{throw new Error('Author publications must never reach generation');};
    assert.equal(await p.writeNewsletter(),null);
    assert.equal(contents.get(p.dataPath),before);
});

test('author feeds combine recent posts without duplicates and never add collected articles',async()=>{
    const {p,seen,contents} = await newsletterFixture();
    p.settings.authorFeeds = 'https://first.example/rss https://second.example/rss https://first.example/rss';
    const requests = [];
    p.request = async options=>{requests.push(options.url);return {status:200,text:options.url};};
    p.newsletter.readFeed = (url,limit)=>{
        assert.equal(limit,5);
        return [{title:'Shared post',url:'https://author.example/shared',content:'Shared angle'},
            {title:url,url:url+'/post',content:'A previous author article'}];
    };
    await p.writeNewsletter();
    assert.deepEqual(requests,['https://first.example/rss','https://second.example/rss']);
    assert.equal(seen[0].recentPosts.length,3);
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles.length,3);
});

test('AuthorFeed works in both prompts and author content is fetched only once',async()=>{
    for (const inWriter of [true,false]) {
        const {p,seen}=await newsletterFixture();
        const read=p.app.vault.adapter.read, generate=p.generate;
        p.app.vault.adapter.read=async path=>path.endsWith('/prompts/writer.md')
            ? '{"instructions":"My runtime prompt","articles":{{articles}},"posts":'+(inWriter ? '{{AuthorFeed}}' : '[]')+'}'
            : path.endsWith('/prompts/rewriter.md') ? 'Runtime rewriter {{language}} Author: {{AuthorFeed}}' : read(path);
        let requests=0, revisions=0;
        p.request=async()=>{requests++;return {status:200,text:'<rss/>'};};
        p.generate=withStages(p, async(connection,system,input,...rest)=>{
            if (system.startsWith('Runtime rewriter')) {
                revisions++;
                assert.ok(system.includes('Recent blog post'));
                assert.ok(system.includes('Recent idea'));
                assert.ok(!system.includes('{{AuthorFeed}}'));
            }
            return generate(connection,system,input,...rest);
        });
        await p.writeNewsletter();
        assert.equal(requests,1);
        assert.equal(revisions,1);
        assert.equal(seen[0].posts.length,inWriter ? 1 : 0);
    }
});

test('generation reconnects configured Gmail before collecting mail, including alongside RSS',async()=>{
    for (const feeds of ['', 'https://source.example/feed']) {
        const {p}=await newsletterFixture();
        p.settings.includeFeeds=feeds;
        p.authorizationRequired=true;
        const steps=[],connect=p.connect.bind(p);
        p.connect=async()=>{
            steps.push('connect');
            await connect();
            p.client.request=async options=>{
                assert.equal(new URL(options.url).searchParams.get('labelIds'),'Label_1');
                steps.push('mail');return {status:200,json:{messages:[]}};
            };
        };
        p.importFeeds=async()=>{steps.push('feeds');return 0;};
        p.crawlArticles=async()=>{};
        p.writeNewsletter=async()=>{steps.push('write');return {path:'Data/newsletter.md'};};
        await p.openTextMachine('Data');
        const dialog=p.runDialog;
        dialog.render=()=>{};
        await dialog.advance();
        assert.equal(dialog.error,'');
        assert.equal(dialog.notePath,'Data/newsletter.md');
        assert.deepEqual(steps,['connect','mail','feeds','write']);
        assert.equal(p.isConnected,true);
        dialog.onClose();
    }
});

test('Gmail authorization loss during collection reconnects once and resumes generation',async()=>{
    for (const failure of ['', 'AUTH_REQUIRED', 'NETWORK', 'cancelled']) {
        const {p}=await newsletterFixture();
        p.account.scope=p.gmail.SCOPE;
        let connects=0,reads=0,writes=0;
        p.client.request=async options=>{
            assert.equal(options.url,'https://oauth2.googleapis.com/token');
            reads++;return {status:400,json:{error:'invalid_grant'}};
        };
        const connect=p.connect.bind(p);
        p.connect=async()=>{
            connects++;
            if (failure==='cancelled') throw new Error('Connection cancelled');
            await connect();
            p.client.request=async()=>{
                reads++;return {status:failure==='AUTH_REQUIRED' ? 401 : failure ? 503 : 200,json:{messages:[]}};
            };
        };
        p.crawlArticles=async()=>{};
        p.writeNewsletter=async()=>{writes++;return {path:'Data/newsletter.md'};};
        await p.openTextMachine('Data');
        const dialog=p.runDialog;
        dialog.render=()=>{};
        await dialog.advance();
        assert.equal(connects,1);
        assert.equal(reads,failure==='cancelled' ? 1 : 2);
        assert.equal(writes,failure ? 0 : 1);
        assert.equal(Boolean(dialog.error),Boolean(failure));
        assert.equal(p.busy,false);
        dialog.onClose();
    }
});

test('cancelled automatic reconnection preserves the account and stops generation',async()=>{
    const {p}=await newsletterFixture();
    const account=p.account;
    let attempts=0;
    p.settings.includeFeeds='https://source.example/feed';
    p.gmail.authorize=async()=>{attempts++;throw new Error('Connection cancelled');};
    p.importFeeds=()=>assert.fail('Cancelled Gmail must not silently become RSS-only');
    p.writeNewsletter=()=>assert.fail('Cancelled Gmail must not generate');
    await p.openTextMachine('Data');
    const dialog=p.runDialog;
    dialog.render=()=>{};
    await dialog.advance();
    assert.equal(attempts,1);
    assert.equal(dialog.error,'Connection cancelled');
    assert.equal(p.account,account);
    assert.equal(p.settings.labelId,'Label_1');
    assert.equal(p.auth,null);
    assert.equal(p.busy,false);
    dialog.onClose();
});

test('collection does not reconnect for network errors or before data setup',async()=>{
    const {p}=await newsletterFixture();
    p.account.scope=p.gmail.SCOPE;
    p.connect=()=>assert.fail('No authorization failure to reconnect');
    p.client.get=async()=>{throw new Error('Network unavailable');};
    await assert.rejects(p.importUnread(),/Network unavailable/);
    p.settings.outputFolder='';
    p.authorizationRequired=true;
    await assert.rejects(p.importUnread(),/Create/);
});

test('RSS-only runs collect, crawl and write a newsletter without Gmail credentials or reconnection',async()=>{
    for (const stale of [false,true]) {
        const {p,contents,seen}=await newsletterFixture();
        p.settings.labelId='';
        p.settings.authorFeeds='';
        p.settings.includeFeeds='https://source.example/feed';
        contents.set(p.dataPath,JSON.stringify({version:1,articles:[]}));
        if (stale) {
            p.account.scope=p.gmail.SCOPE;
            p.authorizationRequired=true;
        } else {
            p.account=null;
            p.oauth=null;
        }
        assert.equal(p.isConnected,false);
        p.client={unreadMessages:()=>assert.fail('RSS must not list mail'),message:()=>assert.fail('RSS must not read mail'),
            markRead:()=>assert.fail('RSS must not mark mail read'),labels:()=>assert.fail('RSS must not list Gmail labels')};
        p.connect=()=>assert.fail('RSS must not request Gmail reconnection');
        const requests=[],crawled=[];
        p.request=async options=>{requests.push(options.url);return {status:200,text:'feed'};};
        const publish=new Date(Date.now()-1000).toISOString();
        p.newsletter.readFeed=()=>[{title:'Books and AI',url:'https://source.example/story',publish},
            {title:'Another literary perspective',url:'https://another.example/story',publish}];
        p.crawler={...p.crawler,crawl:async article=>{crawled.push(article.url);return {...article,content:'Full article about books and AI.'};}};
        p.openTextMachine('Data');
        const dialog=p.runDialog;
        dialog.render=()=>{};
        await dialog.advance();
        assert.equal(dialog.error,'');
        assert.ok(dialog.result.includes('RSS articles added: 2'),dialog.result);
        assert.equal(JSON.parse(contents.get(p.dataPath)).articles[0]?.content,'Full article about books and AI.');
        assert.equal(dialog.notePath,'Data/text-machine-'+p.newsletter.day()+'.md');
        assert.ok(contents.get(dialog.notePath).includes('First paragraph.'));
        assert.ok(dialog.result.includes('RSS articles added: 2'));
        assert.ok(!dialog.result.includes('Messages added'));
        assert.deepEqual(requests,['https://source.example/feed']);
        assert.deepEqual(crawled,['https://source.example/story','https://another.example/story']);
        assert.equal(seen[0].articles[0].url,'https://source.example/story');
        const saved=JSON.parse(contents.get(p.dataPath)).articles;
        assert.equal(saved.length,2);
        assert.equal(saved[0].content,'Full article about books and AI.');
        assert.equal(saved[0].usedAt,p.newsletter.day());
        assert.equal(p.isConnected,false);
        dialog.onClose();
    }
});

test('a connected account still collects unread mail and RSS together and requires its label',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    p.account.scope=p.gmail.SCOPE;
    p.settings.includeFeeds='https://source.example/feed';
    let marked=0,listed=0;
    p.client={unreadMessages:async function*(label){assert.equal(label,'Label_1');listed++;yield 'mail';},
        message:async()=>({labelIds:['UNREAD','Label_1']}),markRead:async id=>{assert.equal(id,'mail');marked++;}};
    p.articles={...p.articles,messageArticles:()=>[{...entries[0],title:'Editorial choice',url:'https://example.com/editorial'}]};
    p.request=async()=>({status:200,text:'feed'});
    const publish=new Date(Date.now()-1000).toISOString();
    p.newsletter.readFeed=()=>[{title:'RSS choice',url:'https://source.example/rss-choice',publish}];
    p.crawler={...p.crawler,crawl:async article=>({...article,content:'Full article.'})};
    assert.equal(p.isConnected,true);
    const result=await p.importUnread();
    assert.equal(listed,1);assert.equal(marked,1);
    assert.ok(result.includes('Messages added: 1'));
    assert.ok(result.includes('RSS articles added: 1'));
    const saved=JSON.parse(contents.get(p.dataPath)).articles;
    assert.ok(saved.some(article=>article.url==='https://example.com/editorial'));
    assert.ok(saved.some(article=>article.url==='https://source.example/rss-choice'));
    p.settings.labelId='';
    p.settings.includeFeeds='';
    await assert.rejects(p.importUnread(),/choose a label/);
    assert.equal(listed,1);
});

test('folder setup, source exclusions and data controls remain available without Gmail',async()=>{
    const {p,obsidian}=await newsletterFixture();
    p.account=null;
    p.oauth=null;
    p.settings.debug=true;
    p.configurationError=p.i18n.t('oauthNotConfigured');
    const buttonFor=row=>{
        const button={buttonEl:{addClass(){}},setButtonText(value){this.text=value;return this;},setDisabled(value){this.disabled=value;return this;},
            setCta(){this.cta=true;return this;},onClick(){return this;}};
        row.render({addButton:callback=>callback(button)});
        return button;
    };
    for (const busy of [false,true]) {
        p.busy=busy;
        const groups=p.settingsTab.getSettingDefinitions(),rows=groups.flatMap(row=>row.items || [row]);
        assert.ok(groups.find(group=>group.heading==='Gmail account (optional)').items.some(row=>row.name===p.configurationError));
        assert.ok(!groups.some(row=>row.name===p.configurationError));
        for (const name of ['Data','Reset JSON']) {
            const candidates=rows.filter(row=>row.name===name);
            for (const row of candidates) assert.equal(buttonFor(row).disabled,busy);
        }
        let disabled;
        rows.find(row=>row.name==='Excluded sources').render({addTextArea:callback=>callback({inputEl:{setAttribute(){}},
            setPlaceholder(){return this;},setValue(){return this;},setDisabled(value){disabled=value;return this;},onChange(){return this;}})});
        assert.equal(disabled,busy);
    }
    p.busy=false;
    p.settings.outputFolder='';
    const row=p.settingsTab.getSettingDefinitions().find(group=>group.cls==='text-machine-newsletter').items.find(row=>row.name==='Choose an empty folder');
    const create=buttonFor(row);
    assert.equal(create.text,'Create folder');assert.equal(create.disabled,false);assert.equal(create.cta,true);

    const messages=[],buttons=[];
    obsidian.Setting=class {
        setName(){return this;}
        addText(callback){callback({inputEl:{setAttribute(){}},setValue(){return this;},setPlaceholder(){return this;},onChange(){return this;}});return this;}
        addButton(callback){const button={setButtonText(text){buttons.push(text);return this;},setCta(){return this;},setDisabled(){return this;},onClick(){return this;}};callback(button);return this;}
    };
    p.openTextMachine('Data');
    const dialog=p.runDialog;
    dialog.contentEl={empty(){messages.length=0;buttons.length=0;},createEl(_tag,options){if(options?.text) messages.push(options.text);return {setText(){}};}};
    dialog.render();
    assert.ok(buttons.includes('Create folder'));
    assert.ok(!buttons.includes('Connect Gmail'));
    p.settings.outputFolder='Data';
    await assert.rejects(p.importUnread(),/Connect Gmail or configure RSS feeds/);
    await dialog.advance();
    assert.ok(messages.includes(p.i18n.t('connectToRun')));
    p.settings.includeFeeds='https://source.example/feed';
    dialog.render();
    assert.ok(!buttons.includes('Connect Gmail'));
    assert.ok(!messages.includes(p.i18n.t('connectToRun')));
    dialog.contentEl.createDiv=()=>({createSpan(options){if(options.text) messages.push(options.text);return {};}});
    dialog.working=true;
    dialog.render();
    assert.ok(messages.includes(p.i18n.t('readingFeeds')));
    p.settings.includeFeeds='';
    dialog.render();
    assert.ok(messages.includes(p.i18n.t('finishInBrowser')));
    dialog.working=false;
    dialog.onClose();
});

test('include feeds share email deduplication, exclusions, forbidden statuses and article crawling',async()=>{
    const publish=new Date().toISOString();
    const {p,contents,entries} = await newsletterFixture();
    p.settings.includeFeeds = 'https://first.example/rss https://second.example/rss';
    p.settings.excludedSources = 'ignored.example';
    p.account.scope = p.gmail.SCOPE;
    p.client.unreadMessages = async function* () {};
    p.client.markRead = async()=>{throw new Error('RSS entries must not mark mail read');};
    await p.app.vault.create(p.blockedPath,JSON.stringify(['blocked.example']));
    const requests = [], crawled = [];
    p.request = async options=>{requests.push(options.url);return {status:200,text:options.url};};
    p.newsletter.readFeed = (url,limit)=>{
        assert.equal(limit,Infinity);
        return url.includes('first.example')
            ? [{title:'New story',url:'https://example.com/new-story?utm_source=rss',publish,content:'Unverified summary'}, {...entries[0],publish}]
            : [{title:'New story',url:'https://other.example/repost',publish}, {title:'PDF',url:'https://example.com/report.pdf',publish},
                {title:'Blocked',url:'https://blocked.example/article',publish}, {title:'Excluded',url:'https://ignored.example/article',publish}];
    };
    p.crawler = {...p.crawler,crawl:async article=>{crawled.push(article.url);return {...article,content:'Verified article text'};}};
    const result = await p.importUnread();
    assert.ok(result.includes('RSS articles added: 3'));
    const saved = JSON.parse(contents.get(p.dataPath)).articles;
    assert.equal(saved.length,6);
    const story = saved.find(article=>article.title==='New story');
    assert.equal(story.source,'RSS: first.example');
    assert.equal(story.publish,publish);
    assert.equal(story.content,'Verified article text');
    assert.equal(saved.find(article=>article.title==='PDF').status,'forbidden');
    assert.equal(saved.find(article=>article.title==='Blocked').status,'forbidden');
    assert.deepEqual(crawled,['https://example.com/new-story']);
    assert.equal(requests.length,2);
    assert.ok((await p.importUnread()).includes('RSS articles added: 0'));
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles.length,6);
    assert.deepEqual(crawled,['https://example.com/new-story']);
});

test('a failed include feed preserves previously collected entries and resumes without duplicates',async()=>{
    const {p,contents} = await newsletterFixture();
    p.settings.includeFeeds = 'https://first.example/rss https://second.example/rss';
    let fail = true;
    p.request = async options=>({status:fail && options.url.includes('second.example') ? 503 : 200,text:options.url});
    p.newsletter.readFeed = url=>[{title:url.includes('first.example') ? 'First story' : 'Second story',url:url+'/article',publish:new Date(Date.now()-1000).toISOString()}];
    const progress=[];
    assert.equal(await p.importFeeds(message=>progress.push(message)),1);
    assert.ok(progress.some(message=>message.includes('second.example') && message.includes('Unable to read')));
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles.length,4);
    fail = false;
    assert.equal(await p.importFeeds(),1);
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles.length,5);
});

test('cancelling RSS collection keeps saved articles and releases the collection controller',async()=>{
    const {p,contents} = await newsletterFixture();
    p.settings.includeFeeds = 'https://first.example/rss';
    p.request=async()=>({status:200,text:'feed'});
    p.newsletter.readFeed=()=>[{title:'Recent blog post',url:'https://tcrouzet.substack.com/post',publish:new Date(Date.now()-1000).toISOString()}];
    const process = p.app.vault.process;
    p.app.vault.process = async(file,action)=>{await process(file,action);p.crawlController.abort();};
    await assert.rejects(p.importFeeds(),/cancelled/);
    assert.equal(p.crawlController,null);
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles.length,4);
});

test('an empty additional feed sends an empty recentPosts list without a request',async()=>{
    const {p,seen} = await newsletterFixture();
    p.settings.authorFeeds = '';
    p.request = async()=>{throw new Error('No feed should be fetched');};
    await p.writeNewsletter();
    assert.deepEqual(seen[0].recentPosts,[]);
});

test('invalid or unavailable additional feeds do not call AI or change notes and statuses',async()=>{
    for (const unavailable of [false,true]) {
        const {p,contents} = await newsletterFixture();
        const before = contents.get(p.dataPath);
        p.settings.authorFeeds = unavailable ? 'https://example.com/feed.xml' : 'file:///private/feed.xml';
        let requests = 0;
        p.request = async()=>{requests++;return {status:503,text:''};};
        p.generate = withStages(p, async()=>{throw new Error('AI must not be called');});
        await assert.rejects(p.writeNewsletter(),unavailable ? /Unable to read/ : /valid HTTP or HTTPS/);
        assert.equal(requests,unavailable ? 1 : 0);
        assert.equal(contents.get(p.dataPath),before);
        assert.equal([...contents.keys()].filter(path=>/\/text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(path)).length,0);
    }
});

test('generation errors and note save failures leave article statuses unchanged',async()=>{
    for (const failure of ['api','create','invalid']) {
        const {p,contents,failCreate} = await newsletterFixture();
        p.settings.debug=true;
        const before = contents.get(p.dataPath);
        if (failure==='api') p.generate = withStages(p, async()=>{throw new Error('Provider refused');});
        if (failure==='invalid') p.generate = withStages(p, async()=>'{broken');
        if (failure==='create') failCreate();
        await assert.rejects(p.writeNewsletter(),failure==='api' ? /Provider refused/ : failure==='create' ? /comparison text/ : /Invalid AI response/);
        assert.equal(contents.get(p.dataPath),before);
        assert.equal([...contents.keys()].filter(path=>/\/text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(path)).length,0);
    }
});

test('saved newsletter survives a JSON status write failure with a precise message',async()=>{
    const {p,contents,failSave} = await newsletterFixture();
    const before = contents.get(p.dataPath);failSave();
    await assert.rejects(p.writeNewsletter(),/was saved, but updating statuses failed/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal([...contents.keys()].filter(path=>/\/text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(path)).length,1);
});

test('no pending articles do not call an AI or create a note',async()=>{
    const {p,contents} = await newsletterFixture();
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[]}));
    p.generate = withStages(p, async()=>{throw new Error('Must not call');});
    assert.equal(await p.writeNewsletter(),null);
});


test('closing the run during generation prevents a late note and status changes',async()=>{
    const {p,contents} = await newsletterFixture();
    const before = contents.get(p.dataPath);
    p.generate = withStages(p, async()=>{
        p.aiController.abort();
        return JSON.stringify({paragraphs:['First','Second']});
    });
    await assert.rejects(p.writeNewsletter(),/cancelled/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal([...contents.keys()].filter(path=>/\/text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(path)).length,0);
});

test('irrelevant articles are discarded without creating a note',async()=>{
    const {p,contents} = await newsletterFixture();
    p.generate = async()=>JSON.stringify({brief:[], selected:[],discard:[1,2]});
    assert.equal(await p.writeNewsletter(),null);
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)).articles.map(article=>article.status),['discard','discard','']);
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)).articles.map(article=>article.usedAt),['','','unknown']);
    assert.equal([...contents.keys()].filter(path=>/\/text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(path)).length,0);
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
test('blocked source diagnostics test one non-PDF article per domain offline and preserve articles and the blocklist',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    p.manifest.version='0.0.5';
    p.account=null;
    const urls=['https://nature.com/readable?article=1','https://news.nature.com/restricted','https://failed.example/article',
        'https://nature.com/report.pdf','https://unblocked.example/article','https://restricted.example/article'];
    const articles=urls.map((url,index)=>({...entries[0],id:index+1,url,title:url,status:'forbidden',usedAt:'2026-11-03',content:''}));
    articles.unshift(articles.splice(3,1)[0]);
    articles.push({...articles[1],id:7});
    contents.set(p.dataPath,JSON.stringify({version:1,nextId:8,articles}));
    await p.app.vault.create(p.blockedPath,JSON.stringify(['nature.com','failed.example','restricted.example','orphan.example']));
    const beforeArticles=contents.get(p.dataPath),beforeBlocked=contents.get(p.blockedPath),called=[],progress=[];
    p.crawler={...p.crawler,extractPage:html=>html==='complete' ? {content:'Full article text',publish:'2026-11-05'} : {blocked:true}};
    p.browser={...p.browser,retrievePage:async(url,signal,blocked,_window,_fetch,observe)=>{
        assert.ok(signal && !signal.aborted);
        assert.equal(blocked(url),false);
        called.push(url);
        if (url.includes('failed.example')) throw Object.assign(new Error('Private error with token=do-not-save'),{code:'ECONNRESET'});
        observe('http',{status:404,url,html:'',failure:'redirect-loop'},10);
        const page={status:200,url:url.split('?')[0]+'?code=do-not-save',html:url.includes('/readable') ? 'complete' : 'preview',contentType:'text/html'};
        observe('browser',page,20);
        return page;
    }};
    const file=await p.testBlockedSources(message=>progress.push(message));
    const report=JSON.parse(contents.get(file.path));
    assert.match(file.path,/^Data\/blocked-report-.*\.json$/);
    assert.deepEqual(called,[urls[0],urls[2],urls[5]]);
    assert.equal(report.pluginVersion,'0.0.5');
    assert.ok(report.finishedAt);
    assert.equal(report.cancelled,false);
    const [nature,failed,restricted,orphan]=report.sources;
    assert.equal(nature.skippedPdfs,1);
    assert.deepEqual(nature.articles.map(article=>article.outcome),['readable']);
    assert.deepEqual(restricted.articles.map(article=>article.outcome),['restricted']);
    assert.equal(nature.articles[0].attempts[0].httpStatus,null);
    assert.equal(nature.articles[0].attempts[0].failure,'redirect-loop');
    assert.equal(nature.articles[0].attempts[1].httpStatus,200);
    assert.equal(nature.articles[0].attempts[1].contentLength,'Full article text'.length);
    assert.equal(nature.articles[0].attempts[1].publish,'2026-11-05');
    assert.equal(nature.articles[0].attempts[1].elapsedMs,20);
    assert.equal(failed.articles[0].failure,'ECONNRESET');
    assert.equal(failed.articles[0].outcome,'error');
    assert.deepEqual(orphan.articles,[]);
    assert.equal(orphan.reason,'no-article-url');
    assert.ok(progress.some(message=>message.includes('3/3')));
    assert.equal(contents.get(file.path).includes('do-not-save'),false);
    assert.equal(contents.get(file.path).includes('Full article text'),false);
    assert.equal(contents.get(p.dataPath),beforeArticles);
    assert.equal(contents.get(p.blockedPath),beforeBlocked);
    assert.equal(p.crawlController,null);
    assert.ok(!p.settingsTab.getSettingDefinitions().flatMap(item=>item.items || [item]).some(item=>item.name==='Test blocked sources'));
    p.settings.debug=true;
    const rows=p.settingsTab.getSettingDefinitions().flatMap(item=>item.type==='group' ? item.items : [item]);
    const row=rows.find(item=>item.name==='Test blocked sources');
    let disabled;
    const button={setButtonText:()=>button,setDisabled:value=>{disabled=value;return button;},onClick:()=>button};
    row.render({addButton:callback=>callback(button)});
    assert.equal(disabled,false);
    p.busy=true;
    row.render({addButton:callback=>callback(button)});
    assert.equal(disabled,true);
    p.crawlController=new AbortController();
    const buttons=[];
    row.render({descEl:{createDiv:()=>({createSpan:()=>({})})},addButton:callback=>{
        const button={setButtonText:value=>{button.text=value;return button;},setDisabled:()=>button,onClick:callback=>{button.click=callback;return button;}};
        callback(button);buttons.push(button);
    }});
    buttons.find(button=>button.text==='Cancel').click();
    assert.equal(p.crawlController.signal.aborted,true);
});

test('debug edits save blocked domains only on blur and preserve articles, failed writes and concurrent changes',async()=>{
    const {p,contents,failSave}=await newsletterFixture();
    const articlesBefore=contents.get(p.dataPath);
    p.account=null;
    p.settingsTab.app=p.app;
    const render=async()=>{
        const row=p.settingsTab.getSettingDefinitions().flatMap(item=>item.items || [item]).find(item=>item.name==='Blocked sites');
        const attributes=new Map(),events=new Map();
        const error={hidden:false,message:'',setText(value){this.message=value;}};
        const field={inputEl:{setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key),addEventListener:(event,callback)=>events.set(event,callback)},
            value:'',setPlaceholder(){return this;},setValue(value){this.value=value;return this;},getValue(){return this.value;}};
        row.render({descEl:{createEl:()=>error},addTextArea:callback=>callback(field)});
        assert.equal(field.inputEl.readOnly,true);
        await new Promise(resolve=>setImmediate(resolve));
        return {field,error,attributes,blur:()=>events.get('blur')()};
    };
    const locked=await render();
    assert.equal(locked.field.inputEl.readOnly,true);
    locked.field.value='nature.com';await locked.blur();
    assert.ok(!contents.has(p.blockedPath));
    p.settings.debug=true;
    const editable=await render();
    assert.equal(editable.field.inputEl.readOnly,false);
    editable.field.value='www.nature.com, NEWS.example.co.uk\nexample.co.uk';
    assert.ok(!contents.has(p.blockedPath));
    await editable.blur();
    assert.deepEqual(JSON.parse(contents.get(p.blockedPath)),['nature.com','example.co.uk']);
    assert.equal(editable.field.value,'nature.com, example.co.uk');
    editable.field.value='example.co.uk';await editable.blur();
    assert.deepEqual(JSON.parse(contents.get(p.blockedPath)),['example.co.uk']);
    for (const invalid of ['not a domain','file:///tmp/local','https://user:pass@example.com','com']) {
        editable.field.value=invalid;await editable.blur();
        assert.equal(editable.attributes.get('aria-invalid'),'true');
        assert.match(editable.error.message,/valid domains/);
        assert.deepEqual(JSON.parse(contents.get(p.blockedPath)),['example.co.uk']);
    }
    editable.field.value='';await editable.blur();
    assert.deepEqual(JSON.parse(contents.get(p.blockedPath)),[]);
    assert.equal(editable.error.hidden,true);
    for (const [key,value] of [['busy',true],['crawlController',new AbortController()],['aiController',new AbortController()],['disposed',true]]) {
        const original=p[key];p[key]=value;
        const busy=await render();
        assert.equal(busy.field.inputEl.readOnly,true);
        busy.field.value='nature.com';await busy.blur();
        assert.deepEqual(JSON.parse(contents.get(p.blockedPath)),[]);
        p[key]=original;
    }
    contents.set(p.blockedPath,JSON.stringify(['new.example']));
    editable.field.value='nature.com';await editable.blur();
    assert.match(editable.error.message,/changed elsewhere/);
    assert.deepEqual(JSON.parse(contents.get(p.blockedPath)),['new.example']);
    const failing=await render();failSave();
    failing.field.value='';await failing.blur();
    assert.match(failing.error.message,/JSON write failed/);
    assert.deepEqual(JSON.parse(contents.get(p.blockedPath)),['new.example']);
    p.settings.debug=false;
    assert.equal((await render()).field.inputEl.readOnly,true);
    assert.equal(contents.get(p.dataPath),articlesBefore);
});

test('cancelling a blocked-source test keeps partial results and does not request remaining articles',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    const domains=['first.example','second.example','third.example'];
    contents.set(p.dataPath,JSON.stringify({version:1,articles:entries.map((article,index)=>({...article,url:'https://'+domains[index]+'/article'}))}));
    await p.app.vault.create(p.blockedPath,JSON.stringify(domains));
    const before=contents.get(p.dataPath),calls=[];
    p.browser={...p.browser,retrievePage:async(url,signal,_blocked,_window,_fetch,observe)=>{
        calls.push(url);
        if (calls.length===2) {
            const partial=JSON.parse([...contents].find(([name])=>name.includes('/blocked-report-'))[1]);
            assert.equal(partial.sources[0].articles[0].outcome,'http-error');
            p.crawlController.abort();
            assert.equal(signal.aborted,true);
            throw new Error('Cancelled');
        }
        const page={status:403,url,html:''};
        observe('http',page,5);return page;
    }};
    const file=await p.testBlockedSources();
    const report=JSON.parse(contents.get(file.path));
    assert.equal(calls.length,2);
    assert.equal(report.cancelled,true);
    assert.ok(report.finishedAt);
    assert.deepEqual(report.sources.flatMap(source=>source.articles.map(article=>article.outcome)),['http-error','cancelled','pending']);
    assert.equal(report.sources[0].articles[0].attempts[0].httpStatus,403);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal(contents.get(p.blockedPath),JSON.stringify(domains));
    assert.equal(p.crawlController,null);
});

test('blocked-source diagnostics report empty domains, exclude PDFs, and stop when the report cannot be saved',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    await p.app.vault.create(p.blockedPath,'["example.com"]');
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[{...entries[0],url:'https://example.com/file.pdf'}]}));
    p.browser={...p.browser,retrievePage:async()=>assert.fail('PDFs must not be requested')};
    const file=await p.testBlockedSources();
    const report=JSON.parse(contents.get(file.path));
    assert.deepEqual(report.sources,[{domain:'example.com',skippedPdfs:1,reason:'pdf-only',articles:[]}]);
    contents.set(p.dataPath,JSON.stringify({version:1,articles:entries}));
    p.app.vault.create=async()=>{throw new Error('Disk full');};
    await assert.rejects(p.testBlockedSources(),/Disk full/);
    assert.equal(p.crawlController,null);
    const controller=p.crawlController=new AbortController();
    await assert.rejects(p.testBlockedSources(),/already running/);
    assert.equal(p.crawlController,controller);
});

test('crawled authors are saved and passed to the writer for source attribution',async()=>{
    const {p,contents,entries,seen}=await newsletterFixture();
    contents.set(p.dataPath,JSON.stringify({version:1,nextId:3,articles:[{...entries[0],content:''},entries[1]]}));
    p.crawler={...p.crawler,crawl:async article=>({...article,content:'A complete source article.',authors:['Jane Doe','Jean Dupont']})};
    await p.crawlArticles();
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)).articles[0].authors,['Jane Doe','Jean Dupont']);
    await p.writeNewsletter();
    assert.deepEqual(seen[0].articles[0].authors,['Jane Doe','Jean Dupont']);
});
test('an explicit signature in cached content reaches the writer without crawling the source again',async()=>{
    const {p,contents,entries,seen}=await newsletterFixture();
    contents.set(p.dataPath,JSON.stringify({version:1,nextId:3,articles:[{...entries[0],content:'By Emmanuel Bernet\n\nA complete source article.'},entries[1]]}));
    p.loadPage=async()=>{throw new Error('Cached articles must not be fetched again');};
    await p.writeNewsletter();
    assert.deepEqual(seen[0].articles[0].authors,['Emmanuel Bernet']);
});

test('HTTP 404 pages are excluded from the newsletter while paywalls remain in brief',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    const extra=(id,url,status='')=>({...entries[0],id,url,title:url,content:'',status});
    const missing=extra(4,'https://missing.example/article');
    const paywall=extra(5,'https://paywall.example/article');
    const legacy=extra(6,'https://paywall.example/deleted','404');
    contents.set(p.dataPath,JSON.stringify({version:1,nextId:7,articles:[...entries,missing,paywall,legacy]}));
    const calls=[];
    p.loadPage=async url=>{calls.push(url);return {url,status:url===missing.url ? 404 : 403,html:''};};
    await p.crawlArticles();
    await p.crawlArticles();
    assert.deepEqual(calls,[missing.url,paywall.url]);
    const saved=JSON.parse(contents.get(p.dataPath)).articles;
    assert.equal(saved.find(article=>article.id===4).status,'404');
    assert.equal(saved.find(article=>article.id===5).status,'forbidden');
    assert.equal(saved.find(article=>article.id===6).status,'404');
    assert.deepEqual(JSON.parse(contents.get('Data/blocked.json')),['paywall.example']);
    const generate=p.generate;
    let brief;
    p.generate=async(connection,system,input,...rest)=>{
        if (system.startsWith('Runtime brief')) brief=JSON.parse(input);
        return generate(connection,system,input,...rest);
    };
    const file=await p.writeNewsletter();
    assert.deepEqual(brief.map(article=>article.id),[5]);
    const note=contents.get(file.path);
    assert.ok(note.includes(paywall.url));
    assert.ok(!note.includes(missing.url));
    assert.ok(!note.includes(legacy.url));
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
    assert.deepEqual(saved.articles.slice(1).map(article=>article.status),['forbidden','404','forbidden','forbidden']);
    assert.equal(saved.annotation,'Keep annotation');
    assert.deepEqual(JSON.parse(contents.get('Data/blocked.json')),['blocked.example','denied.example']);
});

test('mail from blocked domains is retained as forbidden metadata and marked read',async()=>{
    const {p,contents,entries} = await newsletterFixture();
    p.account.scope = p.gmail.SCOPE;
    p.readBlocked = async()=>['example.com','other.example','older.example'];
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
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[{...entries[0],status:'used'},entries[1],entries[2]]}));
    const today = 'Data/text-machine-'+p.newsletter.day()+'.md';
    await p.app.vault.create(today,'# Old edition\n\n[Source]('+entries[0].url+')');
    await p.app.vault.create('Data/text-machine-2000-01-01.md','# Older angle');
    assert.equal((await p.writeNewsletter()).path,today);
    assert.deepEqual(seen[0].articles.map(article=>article.url),[entries[0].url,entries[1].url]);
    assert.equal(seen[0].previousNewsletters[0].content,'# Older angle');
    assert.equal(contents.get('Data/text-machine-2000-01-01.md'),'# Older angle');
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles[0].usedAt,p.newsletter.day());
});

test('failed regeneration preserves today’s saved note and its used statuses',async()=>{
    const {p,contents,failCreate} = await newsletterFixture();
    p.settings.debug=true;
    const note = await p.writeNewsletter();
    const beforeNote = contents.get(note.path), beforeData = contents.get(p.dataPath);
    failCreate();
    await assert.rejects(p.writeNewsletter(),/comparison text/);
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
    p.generate = async(_connection,_system,input)=>JSON.stringify({brief:[], selected:[],discard:JSON.parse(input).articles.map(article=>article.id)});
    assert.equal(await p.writeNewsletter(),null);
    assert.equal(contents.get(note.path),before);
    const saved = JSON.parse(contents.get(p.dataPath));
    assert.equal(saved.articles[0].status,'');
    assert.ok(!Object.hasOwn(saved.articles[0],'used'));
    assert.equal(saved.articles[0].usedAt,p.newsletter.day());
    assert.equal(saved.articles[3].status,'discard');
});


test('AI cannot return article status changes or unknown IDs to alter the saved JSON',async()=>{
    for (const malicious of [{status:'used'},{used:[99]}]) {
        const {p,contents} = await newsletterFixture();
        const before = contents.get(p.dataPath);
        p.generate = withStages(p, async()=>JSON.stringify({paragraphs:['One','Two'],...malicious}));
        await assert.rejects(p.writeNewsletter(),/Invalid AI response/);
        assert.equal(contents.get(p.dataPath),before);
        assert.equal([...contents.keys()].filter(path=>/\/text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(path)).length,0);
    }
});


test('forbidden articles cannot satisfy the threshold and debug sends only their titles to AI',async()=>{
    const {p,contents,entries} = await newsletterFixture();
    p.settings.authorFeeds='';
    p.settings.newsletterLanguage='français';
    const original={...entries[0],title:'How AI changes writing',status:'forbidden',content:'Unverified content must never be sent to AI'};
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[original]}));
    p.settings.imageMode='none';
    p.generate=async(_connection,system,input)=>{
        assert.ok(system.startsWith('Runtime brief'));
        assert.deepEqual(JSON.parse(input),[{id:original.id,title:original.title}]);
        return JSON.stringify({titles:[{id:original.id,title:'L’IA transforme l’écriture',category:'Écriture'}]});
    };
    p.request = async()=>{throw new Error('No feed needed');};
    p.loadPage = async()=>{throw new Error('Forbidden sources must not be loaded');};
    await assert.rejects(p.writeNewsletter(),/0.*2/);
    assert.equal(contents.size,1);
    p.settings.debug=true;
    const note=await p.writeNewsletter();
    assert.ok(contents.get(note.path).includes('L’IA transforme l’écriture'));
    assert.ok(!contents.get(note.path).includes('Unverified content'));
    const saved = JSON.parse(contents.get(p.dataPath)).articles[0];
    assert.equal(saved.title,original.title);
    assert.equal(saved.content,original.content);
    assert.equal(saved.status,'forbidden');
    assert.equal(saved.usedAt,'');
});

test('mixed editions translate brief titles separately from the writer and preserve the original JSON titles',async()=>{
    const {p,contents,entries,seen}=await newsletterFixture();
    p.settings.newsletterLanguage='français';
    const blocked={...entries[0],id:4,title:'New AI writing study',url:'https://example.com/blocked',status:'forbidden',content:'Unverified content'};
    const data=JSON.parse(contents.get(p.dataPath));
    data.articles.push(blocked);data.nextId=5;
    contents.set(p.dataPath,JSON.stringify(data));
    const generate=p.generate,read=p.app.vault.adapter.read;
    p.app.vault.adapter.read=async path=>path.endsWith('/prompts/bref.md') ? 'Custom brief prompt in {{language}}' : read(path);
    let translated=false;
    p.generate=withStages(p, async(connection,system,input,...rest)=>{
        if (!system.startsWith('Custom brief prompt')) return generate(connection,system,input,...rest);
        translated=true;
        assert.ok(system.includes('Custom brief prompt in français'));
        assert.deepEqual(JSON.parse(input),[{id:4,title:blocked.title}]);
        return JSON.stringify({titles:[{id:4,title:'Nouvelle étude sur l’écriture avec l’IA',category:'Recherche'}]});
    });
    const note=await p.writeNewsletter();
    assert.ok(translated);
    assert.ok(contents.get(note.path).includes('* [Nouvelle étude sur l’écriture avec l’IA](https://example.com/blocked)'));
    assert.ok(!seen[0].articles.some(article=>article.id===4));
    const saved=JSON.parse(contents.get(p.dataPath)).articles.find(article=>article.id===4);
    assert.equal(saved.title,blocked.title);
    assert.equal(saved.status,'forbidden');
    assert.equal(saved.usedAt,p.newsletter.day());
});

test('brief translation failures and cancellation preserve the saved edition and article timestamps',async()=>{
    for (const failure of ['empty-prompt','incomplete','wrong-id','error','cancel']) {
        const {p,contents,entries}=await newsletterFixture();
        const before=JSON.stringify({version:1,nextId:5,articles:[{...entries[0],status:'forbidden'},entries[1],{...entries[0],id:4,title:'Readable',url:'https://example.com/readable'}]});
        contents.set(p.dataPath,before);
        const path='Data/text-machine-'+p.newsletter.day()+'.md';
        await p.app.vault.create(path,'# Existing edition');
        if (failure==='empty-prompt') {
            const read=p.app.vault.adapter.read;
            p.app.vault.adapter.read=async path=>path.endsWith('/prompts/bref.md') ? '' : read(path);
        }
        const generate=p.generate;
        p.generate=withStages(p, async(...args)=>{
            if (!args[1].startsWith('Runtime brief')) return generate(...args);
            if (failure==='error') throw new Error('Translation unavailable');
            if (failure==='cancel') {p.aiController.abort();return JSON.stringify({titles:[{id:1,title:'Late title',category:'Écriture'}]});}
            return JSON.stringify({titles:failure==='incomplete' ? [] : [{id:99,title:'Unknown title',category:'Écriture'}]});
        });
        await assert.rejects(p.writeNewsletter(),/bref.md.*empty|incomplete or invalid|Translation unavailable|cancelled/);
        assert.equal(contents.get(path),'# Existing edition');
        assert.equal(contents.get(p.dataPath),before);
        assert.ok(![...contents.keys()].some(path=>path.endsWith('.png')));
    }
});

test('debug uses a separate Codex schema for brief titles without calling the writer',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    p.settings.debug=true;
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[{...entries[0],status:'forbidden'},entries[1]]}));
    p.settings.newsletterLanguage='English';
    p.getAIConnection=()=>({provider:'codex',model:'fixture'});
    let calls=0;
    p.codex={...p.codex,findCodex:async()=>'/test/codex',generate:async(executable,system,input,model,signal,_progress,schema)=>{
        calls++;
        assert.equal(executable,'/test/codex');
        assert.equal(model,'fixture');
        assert.ok(!signal.aborted);
        if (input.includes('Runtime selection')) return JSON.stringify({brief:[], selected:[],discard:[2]});
        assert.ok(system.includes('Runtime brief English'));
        assert.deepEqual(JSON.parse(input),[{id:1,title:'used'}]);
        assert.ok(schema.properties.titles);
        assert.equal(schema.additionalProperties,false);
        return JSON.stringify({titles:[{id:1,title:'Translated title',category:'Writing'}]});
    }};
    p.generate=withStages(p, async()=>{throw new Error('Cloud API must not be called');});
    const note=await p.writeNewsletter();
    assert.equal(calls,2);
    assert.ok(contents.get(note.path).includes('* [Translated title](https://example.com/used)'));
});

test('disabled illustrations skip generation, keys, prompts and cached images',async()=>{
    for (const cached of [false,true]) {
        const {p,contents}=await newsletterFixture();
        p.settings.imageMode='none';
        const image='Attachments/text-machine-'+p.newsletter.day()+'.png';
        if (cached) await p.app.vault.create(image,'Existing illustration');
        p.getAIKey=()=>assert.fail('Disabled images must not read an image API key');
        p.generateIllustration=async()=>assert.fail('Disabled images must not generate');
        p.createIllustration=async()=>assert.fail('Disabled images must not decode');
        const read=p.app.vault.adapter.read;
        p.app.vault.adapter.read=async path=>{assert.ok(!path.endsWith('/prompts/image.md'));return read(path);};
        const note=await p.writeNewsletter();
        assert.ok(contents.get(note.path).includes('First paragraph.'));
        assert.ok(!contents.get(note.path).includes('!['));
        assert.equal(contents.get(image),cached ? 'Existing illustration' : undefined);
        assert.equal(JSON.parse(contents.get(p.dataPath)).articles[0].usedAt,p.newsletter.day());
    }
});

test('the image selector offers three modes, persists them and enables its prompt only for generation',async()=>{
    const {p}=await fixture();
    assert.equal(p.settings.imageMode,'generated');
    for (const value of ['none','extracted','generated']) {
        p.settingsTab.redraw=()=>{};
        const rows=p.settingsTab.getSettingDefinitions().flatMap(row=>row.items || [row]);
        const row=rows.find(row=>row.name===p.i18n.t('promptImage'));
        const order=[],options=[];let change,disabled;
        row.render({addDropdown:render=>{order.push('select');render({selectEl:{setAttribute(){}},
            addOption(value){options.push(value);return this;},setValue(){return this;},setDisabled(){return this;},onChange(callback){change=callback;return this;}});},
            addButton:render=>{order.push('edit');render({setButtonText(){return this;},setDisabled(value){disabled=value;return this;},onClick(){return this;}});}});
        assert.deepEqual(order,['select','edit']);
        assert.deepEqual(options,['none','extracted','generated']);
        assert.equal(disabled,p.settings.imageMode!=='generated');
        await change(value);
        assert.equal(p.savedSettings.imageMode,value);
        await p.onload();
        assert.equal(p.settings.imageMode,value);
    }
});

test('legacy image preferences migrate independently for each newsletter',async()=>{
    const {p}=await fixture();
    const profile=p.newsletters[0];
    const {imageMode,...legacy}=profile;
    assert.equal(imageMode,'generated');
    p.savedSettings={...p.settings,generateImages:false,newsletters:[{...legacy,generateImages:false},
        {...legacy,id:'second',name:'Second',generateImages:true}]};
    delete p.savedSettings.imageMode;
    await p.onload();
    assert.equal(p.settings.imageMode,'none');
    assert.deepEqual(Array.from(p.newsletters,row=>row.imageMode),['none','generated']);
    await p.selectNewsletter('second');
    assert.equal(p.settings.imageMode,'generated');
    for (const value of ['wrong',false,null]) {
        assert.throws(()=>require('../../plugin/profiles').readImageMode(value),/invalid/);
    }
});

test('Codex handles both text and images with the same configured model and effort without a separate image API',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    const connection={provider:'codex',model:'chosen-by-user',effort:'high',apiKey:''};
    p.getAIConnection=()=>connection;
    const generate=p.generate;let images=0;
    p.codex={...p.codex,findCodex:async()=>'/test/codex',
        generate:async(_path,system,input,model,_signal,_progress,_schema,_image,effort)=>{
            assert.equal(model,connection.model);assert.equal(effort,connection.effort);
            return generate(connection,system,input);
        },
        generateImage:async(executable,system,input,model,signal,_progress,effort)=>{
            images++;
            assert.equal(executable,'/test/codex');assert.equal(model,connection.model);assert.equal(effort,connection.effort);
            assert.ok(!signal.aborted);assert.ok(system.includes('Image caption'));
            assert.deepEqual(JSON.parse(input).paragraphs,JSON.parse(writerResponse(['First paragraph.','Second paragraph.'],entries.slice(0,2))).paragraphs);
            return new ArrayBuffer(8);
        }};
    p.getAIKey=()=>assert.fail('Codex must not read a separate image API key');
    p.generateIllustration=async()=>assert.fail('Codex images must not call the cloud image API');
    const note=await p.writeNewsletter();
    assert.equal(images,1);assert.ok(contents.get(note.path).includes('](Attachments/'));
});

test('the illustration is generated from the revised article without loading source photographs',async()=>{
    const {p,contents,publisher}=await newsletterFixture();
    Object.assign(publisher,{title:'A synthesis',chapeau:'Several ideas.'});
    p.settings.newsletterLanguage='English';
    const data=JSON.parse(contents.get(p.dataPath));
    data.articles[0].image='https://example.com/source.jpg';
    data.articles[0].imageCaption='Original source caption';
    contents.set(p.dataPath,JSON.stringify(data));
    p.loadPage=async()=>{throw new Error('Source photographs must not be loaded');};
    p.generate=withStages(p,async(_connection,system,input)=>system.startsWith('Runtime rewriter')
        ? rewriteResponse(input.replace('Original first paragraph.','Revised first paragraph.'))
        : JSON.stringify({paragraphs:['Original first paragraph.','A second paragraph.']}));
    let images=0;
    p.generateIllustration=async(connection,prompt,_request,signal)=>{
        images++;
        assert.equal(connection.model,'fixture');assert.equal(connection.provider,'openai');
        assert.ok(!signal.aborted);
        assert.ok(prompt.includes('Revised first paragraph.'));
        assert.ok(!prompt.includes('Original first paragraph.'));
        assert.ok(!prompt.includes('source.jpg'));
        assert.ok(!prompt.includes('Original source caption'));
        assert.ok(prompt.includes('English'));
        return new ArrayBuffer(8);
    };
    const note=await p.writeNewsletter();
    const image='Attachments/'+note.name.replace(/\.md$/,'.png');
    assert.equal(images,1);
    assert.ok(contents.get(note.path).includes('![A synthesis]('+image+')'));
    assert.ok(contents.has(image));
});

test('source photographs do not constrain the article or provide the illustration',async()=>{
    const {p,contents}=await newsletterFixture();
    const data=JSON.parse(contents.get(p.dataPath));
    data.articles[0].image='https://example.com/source.jpg';
    data.articles[0].imageCaption='Source caption';
    contents.set(p.dataPath,JSON.stringify(data));
    const note=await p.writeNewsletter();
    const markdown=contents.get(note.path);
    assert.ok(markdown.includes('First paragraph.'));
    assert.ok(markdown.includes('](Attachments/'+note.name.replace(/\.md$/,'.png')+')'));
    assert.ok(!markdown.includes('Source caption'));
    assert.ok(!markdown.includes('source.jpg'));
});

test('an illustration failure prevents saving a newsletter without an image',async()=>{
    const {p,contents}=await newsletterFixture();
    const before=contents.get(p.dataPath);
    p.createIllustration=async()=>{throw new Error('Illustration unavailable');};
    await assert.rejects(p.writeNewsletter(),/Illustration unavailable/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal([...contents.keys()].filter(path=>/\/text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(path)).length,0);
});

test('the existing daily illustration is reused without image generation, decoding or an image API key',async()=>{
    const {p,contents}=await newsletterFixture();
    let images=0;
    p.generateIllustration=async()=>{images++;return new ArrayBuffer(8);};
    const note=await p.writeNewsletter();
    const image='Attachments/'+note.name.replace(/\.md$/,'.png');
    const before=contents.get(image);
    p.getAIKey=()=>{throw new Error('No image key should be read for a cached illustration');};
    p.createIllustration=async()=>{throw new Error('A cached image must not be rendered again');};
    const next=await p.writeNewsletter();
    assert.equal(next.path,note.path);
    assert.equal(images,1);
    assert.equal(contents.get(image),before);
    assert.equal([...contents.keys()].filter(path=>path.endsWith('.png')).length,1);
});

test('existing daily attachments remain reusable through Markdown and wiki embeds',async()=>{
    for (const wiki of [false,true]) {
        const {p,contents}=await newsletterFixture();
        const name='text-machine-'+p.newsletter.day(),image='Data/illustrations/'+name+'.png';
        await p.app.vault.create(image,'Existing daily image');
        await p.app.vault.create('Data/'+name+'.md','# Existing\n\n'+(wiki
            ? '![[illustrations/'+name+'.png|Caption]]' : '![Caption](illustrations/'+name+'.png)'));
        p.generateIllustration=()=>assert.fail('Reuse the existing daily image');
        p.app.fileManager.getAvailablePathForAttachment=()=>assert.fail('No new attachment is needed');
        const note=await p.writeNewsletter();
        assert.ok(contents.get(note.path).includes(']('+image+')'));
        assert.equal(contents.get(image),'Existing daily image');
        assert.equal([...contents.keys()].filter(path=>path.endsWith('.png')).length,1);
    }
});

test('cancelling image generation prevents any late note or status write',async()=>{
    const {p,contents}=await newsletterFixture();
    const before=contents.get(p.dataPath);
    p.generateIllustration=async()=>{p.aiController.abort();return new ArrayBuffer(8);};
    await assert.rejects(p.writeNewsletter(),/cancelled/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal([...contents.keys()].filter(path=>/\/text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(path) || path.endsWith('.png')).length,0);
});

test('Codex effort defaults to low and survives reload with validation',async()=>{
    const {p}=await fixture();
    assert.equal(p.settings.codexEffort,'low');
    for (const [value,expected] of [[' medium ','medium'],['ultra','ultra'],['','low'],['invalid effort','low'],[null,'low'],[12,'low']]) {
        p.savedSettings={...p.settings,codexEffort:value};
        await p.onload();
        assert.equal(p.settings.codexEffort,expected);
    }
});

test('the footer debug toggle defaults to off and persists both boolean values across reloads',async()=>{
    const {p}=await fixture();
    let redraws=0;
    p.settingsTab.redraw=()=>{redraws++;};
    const row=p.settingsTab.getSettingDefinitions().at(-1);
    assert.equal(row.name,'Debug');
    let initialValue,change;
    const toggle={setValue(value){initialValue=value;return this;},onChange(handler){change=handler;return this;}};
    row.render({addToggle:render=>render(toggle)});
    assert.equal(initialValue,false);
    for (const value of [true,false]) {
        await change(value);
        assert.equal(p.savedSettings.debug,value);
        await p.onload();
        assert.equal(p.settings.debug,value);
    }
    assert.equal(redraws,2);
    p.savedSettings.debug='true';
    await p.onload();
    assert.equal(p.settings.debug,false);
});

test('settings definitions are searchable without IO and redraw uses the declarative API when available',async()=>{
    const {p,obsidian}=await fixture();
    p.codex={...p.codex,findCodex:()=>assert.fail('Definitions must not discover Codex')};
    p.request=()=>assert.fail('Definitions must not request a network resource');
    const tab=p.settingsTab;
    const definitions=tab.getSettingDefinitions();
    const rows=definitions.flatMap(item=>item.items || [item]);
    for (const key of ['newsletterLanguage','commentedArticles','newsletterSourcesHeading','referenceSources','includeFeeds','authorFeeds','aiDefaultModel','aiAnthropicKey','aiOpenaiKey']) {
        assert.ok(rows.some(row=>row.name===p.i18n.t(key) && row.searchable!==false),key);
    }
    let updates=0;
    let legacyRenders=0;
    tab.update=()=>assert.fail('Obsidian before 1.13 must not use update()');
    tab.renderLegacy=()=>{legacyRenders++;};
    tab.redraw();
    assert.equal(legacyRenders,1);
    obsidian.requireApiVersion=version=>{assert.equal(version,'1.13.0');return true;};
    tab.update=()=>{updates++;};
    tab.renderLegacy=()=>assert.fail('Modern settings must use update()');
    tab.redraw();
    assert.equal(updates,1);
});


test('RSS collection and crawling accept old and undated articles while preserving cached text and deduplication',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    p.settings.includeFeeds='https://publisher.example/feed';
    p.request=async()=>({status:200,text:'feed'});
    const incoming=['2026-11-03T12:00:00Z','2010-01-01T12:00:00Z','','2099-01-01T12:00:00Z']
        .map((publish,i)=>({title:'Article '+i,url:'https://example.com/story-'+i,publish}));
    p.newsletter.readFeed=()=>incoming;
    assert.equal(await p.importFeeds(),incoming.length);
    const saved=JSON.parse(contents.get(p.dataPath));
    assert.deepEqual(saved.articles.slice(0,3),entries);
    assert.equal(saved.articles.length,entries.length+incoming.length);
    const nextId=saved.nextId;
    saved.articles.push({...entries[0],id:nextId,title:'Old pending RSS',url:'https://example.com/old-rss',source:'RSS: publisher.example',content:''},
        {...entries[0],id:nextId+1,title:'Old mail',url:'https://example.com/old-mail',content:''});
    saved.nextId=nextId+2;
    contents.set(p.dataPath,JSON.stringify(saved));
    const crawled=[];
    p.crawler={...p.crawler,crawl:async article=>{crawled.push(article.url);return {...article,content:'Full text'};}};
    await p.crawlArticles();
    const expected=[...incoming.map(article=>article.url),'https://example.com/old-rss','https://example.com/old-mail'];
    assert.deepEqual(crawled,expected);
    assert.equal(await p.importFeeds(),0);
    await p.crawlArticles();
    assert.deepEqual(crawled,expected);
});

test('complete RSS bodies are reused once, summaries crawled and forbidden sources preserved',async()=>{
    const {p,contents}=await newsletterFixture();
    const publish=new Date().toISOString();
    p.settings.includeFeeds='https://first.example/feed https://second.example/feed';
    p.request=async options=>({status:200,text:options.url});
    p.newsletter.readFeed=url=>url.includes('first') ? [
        {title:'Full body',url:'https://example.com/full?utm_source=rss',publish,html:'complete',authors:['An Author']},
        {title:'Summary',url:'https://example.com/summary',publish,content:'Summary only'},
        {title:'Restricted',url:'https://example.com/restricted',publish,html:'paywall'},
    ] : [{title:'Full body',url:'https://www.example.com/full/',publish,html:'complete'}];
    const extracted=[],crawled=[];
    p.crawler={...p.crawler,extractPage:(html,url)=>{extracted.push(url);return html==='complete' ? {content:'Readable full body'} : {blocked:true};},
        crawl:async article=>{crawled.push(article.url);return {...article,content:'Crawled full body'};}};
    assert.equal(await p.importFeeds(),3);
    await p.crawlArticles();
    const full=JSON.parse(contents.get(p.dataPath)).articles.find(a=>a.title==='Full body');
    assert.equal(full.content,'Readable full body');
    assert.deepEqual(full.authors,['An Author']);
    assert.deepEqual(extracted,['https://example.com/full','https://example.com/restricted']);
    assert.deepEqual(crawled,['https://example.com/summary','https://example.com/restricted']);
    assert.equal(await p.importFeeds(),0);
    await p.crawlArticles();
    assert.equal(extracted.length,2);
    assert.equal(crawled.length,2);
});

test('feed failure does not stop later feeds but disk failure does',async()=>{
    const {p}=await newsletterFixture();
    p.settings.includeFeeds='https://first.example/feed https://second.example/feed';
    const requests=[];
    p.request=async options=>{requests.push(options.url);if(options.url.includes('first')) throw new Error('Offline');return {status:200,text:'feed'};};
    p.newsletter.readFeed=()=>[{title:'Good feed',url:'https://example.com/good',publish:new Date(Date.now()-1000).toISOString()}];
    assert.equal(await p.importFeeds(),1);
    assert.equal(requests.length,2);
    p.request=async()=>({status:200,text:'feed'});
    p.app.vault.process=async()=>{throw new Error('Disk full');};
    p.newsletter.readFeed=()=>[{title:'Another',url:'https://example.com/another',publish:new Date(Date.now()-1000).toISOString()}];
    await assert.rejects(p.importFeeds(),/Disk full/);
    assert.equal(p.crawlController,null);
});


test('execution timer spans collection and AI, freezes on completion and cleans up on close or error',async()=>{
    for (const outcome of ['success','error','close']) {
        const {p,context}=await fixture();
        let now=0, tick, cleared=0;
        context.performance={now:()=>now};
        context.window.setInterval=callback=>{tick=callback;return 42;};
        context.window.clearInterval=id=>{assert.equal(id,42);cleared++;};
        p.openTextMachine('Data');
        const dialog=p.runDialog;
        dialog.render=()=>{};
        dialog.clockEl={setText(text){this.text=text;}};
        let finish;
        const pending=new Promise(resolve=>{finish=resolve;});
        const work=dialog.perform(async()=>{
            dialog.startClock();
            await pending;
            if(outcome==='error') throw new Error('Generation failed');
        },false);
        assert.equal(dialog.clockEl.text,'Elapsed time: 00:00');
        now=65000;tick();
        assert.equal(dialog.clockEl.text,'Elapsed time: 01:05');
        now=3661000;tick();
        assert.equal(dialog.clockEl.text,'Elapsed time: 01:01:01');
        if(outcome==='close') dialog.onClose();
        finish();await work;
        assert.equal(cleared,1);
        const frozen=dialog.clockEl.text;
        now+=10000;dialog.updateClock();
        assert.equal(dialog.clockEl.text,frozen);
        if(outcome==='error') assert.equal(dialog.error,'Generation failed');
        if(outcome!=='close') {
            dialog.startClock();
            assert.equal(dialog.clockEl.text,'Elapsed time: 00:00');
            dialog.onClose();
            assert.equal(cleared,2);
        }
    }
});


test('settings show the configured folder path and invite creation only when no data folder exists',async()=>{
    const {p}=await newsletterFixture();
    let groups=p.settingsTab.getSettingDefinitions();
    let group=groups.find(row=>row.cls==='text-machine-newsletter');
    assert.ok(group);
    const folderRow=group.items.find(row=>row.name==='Data');
    assert.ok(folderRow);
    assert.ok(group.items.some(row=>row.name==='Data folder'));
    assert.ok(!group.items.some(row=>row.name==='Choose an empty folder'));
    assert.ok(!group.items.some(row=>['Data','Reset JSON'].includes(row.name) && row!==folderRow));
    p.settings.debug=true;
    const debugGroup=p.settingsTab.getSettingDefinitions().find(row=>row.cls==='text-machine-newsletter');
    assert.equal(debugGroup.items.filter(row=>row.name==='Data').length,2);
    assert.ok(debugGroup.items.some(row=>row.name==='Reset JSON'));
    p.settings.debug=false;
    p.settings.outputFolder='';
    groups=p.settingsTab.getSettingDefinitions();
    group=groups.find(row=>row.cls==='text-machine-newsletter');
    assert.ok(group.items.some(row=>row.name==='Choose where to store your data'));
    assert.ok(group.items.some(row=>row.name==='Choose an empty folder'));
});

test('newsletter settings share one named panel below the selector while debug stays global',async()=>{
    const {p}=await newsletterFixture();
    const first=p.settings.activeNewsletter;
    await p.createNewsletter('Second newsletter');
    for (const id of [first,p.settings.activeNewsletter]) {
        await p.selectNewsletter(id);
        const definitions=p.settingsTab.getSettingDefinitions();
        const heading=definitions.findIndex(row=>row.name===p.i18n.t('newslettersHeading'));
        assert.equal(definitions[heading].desc,p.i18n.t('newsletterChoiceDescription'));
        assert.equal(definitions[heading+1].name,'');
        assert.equal(definitions[heading+1].desc,undefined);
        const panel=definitions[heading+2];
        assert.equal(panel.cls,'text-machine-newsletter');
        assert.equal(panel.heading,p.i18n.t('selectedNewsletterHeading',{name:p.newsletters.find(row=>row.id===id).name}));
        assert.equal(panel.items[0].name,p.i18n.t(p.dataReady ? 'journalFolder' : 'folderHeading'));
        const writer=panel.items.findIndex(row=>row.name===p.i18n.t('promptWriter'));
        assert.equal(panel.items[writer+1].name,p.i18n.t('commentedArticles'));
        assert.ok(panel.items[writer+1].desc.includes('{{commentedArticles}}'));
        for (const key of ['gmailLabel','newsletterLanguage','commentedArticles','referenceSources','includeFeeds','authorFeeds','promptSelection','promptWriter','promptBrief','promptRewriter','promptPublisher','promptImage','newsletterTemplate'])
            assert.ok(panel.items.some(row=>row.name===p.i18n.t(key)),key);
        for (const key of ['debug','activeNewsletter','emailAddress','aiDefaultModel'])
            assert.ok(!panel.items.some(row=>row.name===p.i18n.t(key)),key);
        assert.equal(definitions.at(-1).name,p.i18n.t('debug'));
        assert.ok(!('type' in definitions.at(-1)));
    }
});

test('moving the data folder uses Obsidian rename and preserves all files and their contents',async()=>{
    const {p,contents}=await newsletterFixture();
    const original=p.settings.outputFolder,folder=p.app.vault.getAbstractFileByPath(original);
    folder.name='Data';
    const parent=new folder.constructor();
    parent.path='Archives';
    const get=p.app.vault.getAbstractFileByPath;
    p.app.vault.getAbstractFileByPath=path=>path==='Archives' ? parent : get(path);
    const before=JSON.stringify([...contents]);
    const moves=[];
    p.app.fileManager={renameFile:async(file,destination)=>{assert.equal(file,folder);assert.equal(p.busy,true);moves.push(destination);}};
    p.ensureData=async()=>{throw new Error('Must not create an empty database');};
    await p.moveData('Archives');
    assert.deepEqual(moves,['Archives/Data']);
    assert.equal(p.settings.outputFolder,'Archives/Data');
    assert.equal(p.savedSettings.outputFolder,'Archives/Data');
    assert.equal(p.busy,false);
    assert.equal(JSON.stringify([...contents]),before);
});

test('folder moves reject collisions and descendants and preserve settings when rename fails',async()=>{
    const {p}=await newsletterFixture();
    const folder=p.app.vault.getAbstractFileByPath('Data');folder.name='Data';
    const parent=new folder.constructor();
    const get=p.app.vault.getAbstractFileByPath;
    p.app.vault.getAbstractFileByPath=path=>['Parent','Parent/Data','Data/Child'].includes(path) ? parent : get(path);
    let calls=0;
    p.app.fileManager={renameFile:async()=>{calls++;throw new Error('Rename failed');}};
    for(const path of ['Parent','Data','Data/Child','missing']) await assert.rejects(p.moveData(path));
    assert.equal(calls,0);
    p.app.vault.getRoot=()=>parent;
    // The current parent is a harmless no-op.
    await p.moveData('');
    assert.equal(calls,0);
    p.app.vault.getAbstractFileByPath=path=>path==='NewParent' ? parent : get(path);
    await assert.rejects(p.moveData('NewParent'),/Rename failed/);
    assert.equal(p.settings.outputFolder,'Data');
    assert.equal(p.busy,false);
    p.app.fileManager.renameFile=async()=>{};
    p.saveData=async()=>{throw new Error('Disk full');};
    await assert.rejects(p.moveData('NewParent'),/Folder moved to NewParent\/Data.*Disk full/);
    assert.equal(p.settings.outputFolder,'NewParent/Data');
    assert.equal(p.busy,false);
});


test('debug collection leaves mail unread, deduplicates repeated runs and normal mode marks it read',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    p.settings.debug=true;
    p.account.scope=p.gmail.SCOPE;
    let read=0;
    p.client={unreadMessages:async function*(){yield 'mail';},message:async()=>({labelIds:['UNREAD','Label_1']}),markRead:async()=>{read++;}};
    p.articles={...p.articles,messageArticles:()=>[{...entries[0],title:'New mail',url:'https://example.com/new-mail'}]};
    await p.importUnread();
    await p.importUnread();
    assert.equal(read,0);
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles.length,4);
    p.settings.debug=false;
    await p.importUnread();
    assert.equal(read,1);
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles.length,4);
});

test('debug newsletters preserve real editions, images and article usage while keeping the writing target',async()=>{
    const {p,contents,seen}=await newsletterFixture();
    p.settings.commentedArticles=10;
    p.settings.debug=true;
    const day=p.newsletter.day(),real='Data/text-machine-'+day+'.md';
    const realImage='Attachments/text-machine-'+day+'.png';
    await p.app.vault.create(real,'# Real newsletter');
    await p.app.vault.create(realImage,'Real illustration');
    const before=contents.get(p.dataPath);
    const note=await p.writeNewsletter();
    assert.equal(note.path,'Data/test-text-machine-'+day+'.md');
    assert.ok(contents.get(note.path).includes('Attachments/test-text-machine-'+day+'.png'));
    assert.equal(contents.get(real),'# Real newsletter');
    assert.equal(contents.get(realImage),'Real illustration');
    assert.equal(contents.get(p.dataPath),before);
    await p.writeNewsletter();
    assert.equal(contents.get(p.dataPath),before);
    assert.ok(seen.every(context=>context.previousNewsletters.every(note=>!note.name.startsWith('test-'))));
    p.settings.debug=false;
    await assert.rejects(p.writeNewsletter(),/2.*10/);
    assert.equal(contents.get(p.dataPath),before);
    p.settings.commentedArticles=2;
    assert.equal((await p.writeNewsletter()).path,real);
    assert.equal(seen.at(-1).commentedArticles,2);
    assert.notEqual(contents.get(p.dataPath),before);
});

test('debug selection discards remain repeatable without recording statuses',async()=>{
    const {p,contents}=await newsletterFixture();
    p.settings.debug=true;
    p.settings.commentedArticles=10;
    const before=contents.get(p.dataPath);
    p.generate=async(_connection,_system,input)=>JSON.stringify({brief:[], selected:[],discard:JSON.parse(input).articles.map(article=>article.id)});
    assert.equal(await p.writeNewsletter(),null);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal(await p.writeNewsletter(),null);
    assert.equal(contents.get(p.dataPath),before);
});


test('debug includes today’s real edition in both AI histories and excludes its sources without consuming articles',async()=>{
    const {p,contents,entries,seen}=await newsletterFixture();
    const readResource=p.app.vault.adapter.read;
    p.app.vault.adapter.read=async path=>path.endsWith('/prompts/sélection.md')
        ? '{"instructions":"Runtime selection","previousNewsletters":{{previousNewsletters}},"articles":{{articles}}}' : readResource(path);
    p.settings.debug=true;
    const day=p.newsletter.day();
    const today='Data/text-machine-'+day+'.md';
    const coverage='# Goncourt 2026: Jaenada already discussed\n[Already covered](https://www.example.com/used/?utm_source=publication)';
    await p.app.vault.create(today,coverage);
    await p.app.vault.create('Data/test-text-machine-'+day+'.md','# Previous test should be regenerated');
    const data=JSON.parse(contents.get(p.dataPath));
    data.articles.push({...entries[0],id:4,title:'New angle',url:'https://example.com/new-angle'});
    data.nextId=5;
    contents.set(p.dataPath,JSON.stringify(data));
    const before=contents.get(p.dataPath),generate=p.generate;
    let selections=0;
    p.generate=async(connection,system,input,...rest)=>{
        if(input.includes('Runtime selection')) {
            const request=JSON.parse(input);
            assert.ok(request.previousNewsletters.some(note=>note.content===coverage));
            assert.ok(!request.articles.some(article=>article.url==='https://example.com/used'));
            assert.ok(request.previousNewsletters.every(note=>!note.name.startsWith('test-')));
            selections++;
        }
        return generate(connection,system,input,...rest);
    };
    const note=await p.writeNewsletter();
    assert.equal(note.path,'Data/test-text-machine-'+day+'.md');
    assert.equal(selections,1);
    assert.ok(seen[0].previousNewsletters.some(note=>note.name==='text-machine-'+day+'.md' && note.content===coverage));
    assert.ok(!seen[0].articles.some(article=>article.url==='https://example.com/used'));
    assert.equal(contents.get(today),coverage);
    assert.equal(contents.get(p.dataPath),before);
});


test('brief titles explicitly rejected as off-topic never appear in test newsletters or consume articles',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    p.settings.debug=true;
    const unrelated='Midterms 2026: Wall Street celebrates the vote';
    const relevant='Novelists disclose their AI writing practices';
    const data=JSON.parse(contents.get(p.dataPath));
    data.articles.push({...entries[0],id:4,title:unrelated,url:'https://example.com/wall-street',status:'forbidden',content:''},
        {...entries[0],id:5,title:relevant,url:'https://example.com/novelists',status:'forbidden',content:''});
    data.nextId=6;contents.set(p.dataPath,JSON.stringify(data));
    const before=contents.get(p.dataPath),generate=p.generate;
    p.generate=async(connection,system,input,...rest)=>system.startsWith('Runtime brief')
        ? JSON.stringify({titles:JSON.parse(input).map(row=>({id:row.id,title:row.id===4 ? null : 'Les romanciers déclarent leurs usages de l’IA',category:row.id===4 ? null : 'Création'}))})
        : generate(connection,system,input,...rest);
    const note=await p.writeNewsletter();
    assert.ok(!contents.get(note.path).includes('wall-street'));
    assert.ok(!contents.get(note.path).includes('Midterms'));
    assert.ok(contents.get(note.path).includes('https://example.com/novelists'));
    assert.equal(contents.get(p.dataPath),before);
    data.articles=data.articles.slice(3);
    contents.set(p.dataPath,JSON.stringify(data));
    p.generateIllustration=async()=>{throw new Error('An empty edition must not generate an image');};
    p.generate=async()=>JSON.stringify({titles:[{id:4,title:null,category:null},{id:5,title:null,category:null}]});
    assert.equal(await p.writeNewsletter(),null);
    assert.equal(contents.get(p.dataPath),JSON.stringify(data));
});

test('RSS URL fingerprints survive reopening and retain rejected URLs and syndicated aliases',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    p.settings.includeFeeds='https://publisher.example/feed';
    p.settings.excludedSources='ignored.example';
    const data=JSON.parse(contents.get(p.dataPath));
    data.articles.push({...entries[0],id:4,title:'Discarded',url:'https://example.com/discarded',status:'discard',content:''},
        {...entries[0],id:5,title:'Consumed',url:'https://example.com/consumed',usedAt:'unknown',content:''});
    data.nextId=6;contents.set(p.dataPath,JSON.stringify(data));
    const publish='2010-01-01T12:00:00Z';
    const rows=[{title:'Used',url:'https://www.example.com/used/?utm_source=feed',publish},
        {title:'Discarded',url:'https://example.com/discarded',publish},
        {title:'Excluded',url:'https://ignored.example/post',publish},
        {title:'Fresh story',url:'https://example.com/fresh',publish},
        {title:'Fresh story',url:'https://other.example/reprint',publish},
        {title:'Consumed',url:'https://example.com/consumed',publish}];
    const wire=(plugin,items,decoded,crawled)=>{
        plugin.request=async()=>({status:200,text:'feed'});
        plugin.newsletter={...plugin.newsletter,readFeed:(_xml,_limit,_base,accept)=>items.filter(accept).map(entry=>{decoded.push(entry.url);return entry;})};
        plugin.crawler={...plugin.crawler,crawl:async article=>{crawled.push(article.url);return {...article,content:'Retrieved full article'};}};
    };
    const decoded=[],crawled=[];
    wire(p,rows,decoded,crawled);
    assert.equal(await p.importFeeds(),1);
    await p.crawlArticles();
    assert.equal(decoded.length,3);
    assert.deepEqual(crawled,['https://example.com/fresh']);
    const stored=JSON.parse(contents.get(p.dataPath));
    assert.ok(stored.rssSeen.urls.length>=5);
    assert.ok(stored.rssSeen.urls.every(value=>/^[a-f0-9]{64}$/.test(value)));
    assert.ok(!stored.articles.some(article=>article.url==='https://ignored.example/post'));
    const second=await newsletterFixture();
    second.contents.set(second.p.dataPath,contents.get(p.dataPath));
    second.p.settings.includeFeeds=p.settings.includeFeeds;
    second.p.settings.excludedSources=p.settings.excludedSources;
    const decodedAgain=[],crawledAgain=[];
    wire(second.p,rows.map(row=>row.url.includes('reprint') ? {...row,title:'Changed syndication title'} : row),decodedAgain,crawledAgain);
    assert.equal(await second.p.importFeeds(),0);
    await second.p.crawlArticles();
    assert.deepEqual(decodedAgain,[]);
    assert.deepEqual(crawledAgain,[]);
    second.p.settings.excludedSources='';
    wire(second.p,[rows[2]],decodedAgain,crawledAgain);
    assert.equal(await second.p.importFeeds(),1);
    assert.deepEqual(decodedAgain,['https://ignored.example/post']);
});

test('failed RSS writes never acknowledge URLs as processed',async()=>{
    const {p,contents}=await newsletterFixture();
    p.settings.includeFeeds='https://publisher.example/feed';
    const before=contents.get(p.dataPath),process=p.app.vault.process;
    p.request=async()=>({status:200,text:'feed'});
    p.newsletter={...p.newsletter,readFeed:(_xml,_limit,_base,accept)=>[
        {title:'Fresh',url:'https://example.com/new',publish:new Date(Date.now()-1000).toISOString()},
    ].filter(accept)};
    p.app.vault.process=async()=>{throw new Error('Disk full');};
    await assert.rejects(p.importFeeds(),/Disk full/);
    assert.equal(contents.get(p.dataPath),before);
    p.app.vault.process=process;
    assert.equal(await p.importFeeds(),1);
    assert.ok(JSON.parse(contents.get(p.dataPath)).rssSeen.urls.length>0);
});
