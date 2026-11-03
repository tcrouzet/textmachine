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
        addSettingTab(tab) {this.settingsTab=tab;}
        registerEvent() {}
        register() {}
    }
    let secret = JSON.stringify({email:'reader@example.com',clientId:'123-test.apps.googleusercontent.com',refreshToken:'old',scope:'https://www.googleapis.com/auth/gmail.readonly'});
    const obsidian = {TFile:class {},TFolder:class {},addIcon:()=>{},Plugin,PluginSettingTab:class {},Modal:class {},Notice:class {},getLanguage:()=> 'en'};
    const context = {module:{exports:{}},AbortController,URL,setTimeout,clearTimeout,structuredClone,window:{setTimeout,clearTimeout},
        MutationObserver:class {observe() {} disconnect() {}},
        document:{body:{},querySelectorAll:()=>[]},CSS:{escape:value=>value},
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

test('the former supplementary feed becomes the author feed without losing settings',async()=>{
    const {p} = await fixture();
    p.savedSettings = {...p.settings,newsletterFeed:'https://legacy.substack.com'};
    delete p.savedSettings.authorFeeds;
    delete p.savedSettings.includeFeeds;
    await p.onload();
    assert.equal(p.settings.authorFeeds,'https://legacy.substack.com');
    assert.equal(p.settings.includeFeeds,'');
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
            const file = Object.assign(new obsidian.TFile(),{path,name:path.split('/').pop(),stat:{mtime:Date.now()}});
            files.set(path,file);contents.set(path,text);folder.children.push(file);return file;
        },
        process:async (file,action)=>{
            const before = contents.get(file.path), after = action(before);
            if (failSave && after !== before) throw new Error('JSON write failed');
            contents.set(file.path,after);
        },
        adapter:{exists:async()=>true,read:async path=>path.endsWith('/models/newsletter.md') ? require('node:fs').readFileSync(require('node:path').join(root,'models/newsletter.md'),'utf8')
            : path.endsWith('/prompts/image.md') ? 'Image caption in {{language}}'
                : path.endsWith('/prompts/rewriter.md') ? 'Runtime rewriter {{language}}'
                    : path.endsWith('/prompts/bref.md') ? 'Runtime brief {{language}}'
                        : path.endsWith('/prompts/sélection.md') ? '{"instructions":"Runtime selection","language":"{{language}}","articles":{{articles}}}'
                            : path.endsWith('/prompts/resume.md') ? '{"instructions":"Runtime summaries","language":"{{language}}","articles":{{articles}}}'
                : '{"instructions":"My runtime prompt","language":"{{language}}","articles":{{articles}},"previousNewsletters":{{previousNewsletters}},"recentPosts":{{recentPosts}}}'},
    };
    p.app.workspace.getLeaf = ()=>({openFile:async()=>{}});
    p.createIllustration = async()=>({name:'illustration-0000000000000000.png',data:new ArrayBuffer(8)});
    p.generateIllustration = async()=>new ArrayBuffer(8);
    p.request = async()=>({status:200,text:'<rss/>'});
    p.getAIConnection = ()=>({provider:'openai',model:'fixture',apiKey:'fixture'});
    const seen = [];
    p.generate = async (_connection,system,input)=>{
        if (system.startsWith('Runtime rewriter')) return input;
        if (system.startsWith('Runtime brief')) return JSON.stringify({titles:JSON.parse(input)});
        const context = JSON.parse(input);
        if (context.instructions==='Runtime selection') return JSON.stringify({selected:context.articles.filter(article=>article.title!=='discard').map(article=>article.id),discard:context.articles.filter(article=>article.title==='discard').map(article=>article.id)});
        if (context.instructions==='Runtime summaries') return JSON.stringify({groups:[{title:'Books',articles:context.articles.map(article=>({id:article.id,title:article.title,summary:'Article summary.'}))}]});
        assert.ok(input.includes('My runtime prompt'));
        assert.ok(!system.includes('My runtime prompt'));
        seen.push(context);
        return JSON.stringify({title:'A new newsletter',chapeau:'Books meet AI.',paragraphs:['First paragraph.','Second paragraph.']});
    };
    return {p,contents,files,entries,seen,failCreate:()=>{failCreate=true;},failSave:()=>{failSave=true;}};
}

function withStages(p, writer, summaries) {
    const generate=p.generate;
    return async(...args)=>{
        let context;
        try {context=JSON.parse(args[2]);} catch { /* Revisions contain plain prose. */ }
        if (context?.instructions==='Runtime selection') return generate(...args);
        if (context?.instructions==='Runtime summaries') return summaries ? JSON.stringify({groups:summaries(context.articles)}) : generate(...args);
        return writer(...args);
    };
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

test('selection, summaries, article, revision and illustration run separately before status changes',async()=>{
    const {p,contents}=await newsletterFixture();
    const before=contents.get(p.dataPath),generate=p.generate,stages=[];
    p.generate=async(connection,system,input,...rest)=>{
        assert.equal(contents.get(p.dataPath),before);
        if (system.startsWith('Runtime rewriter')) stages.push('revision');
        else {
            const context=JSON.parse(input);
            stages.push(context.instructions);
            if (context.instructions!=='Runtime selection') assert.deepEqual(context.articles.map(article=>article.id),[1]);
            if (context.instructions==='My runtime prompt') assert.ok(!Object.hasOwn(context,'summaries'));
        }
        return generate(connection,system,input,...rest);
    };
    p.generateIllustration=async()=>{assert.equal(contents.get(p.dataPath),before);stages.push('image');return new ArrayBuffer(8);};
    const note=await p.writeNewsletter();
    assert.deepEqual(stages,['Runtime selection','Runtime summaries','My runtime prompt','revision','image']);
    assert.ok(contents.get(note.path).includes('Article summary.'));
    assert.deepEqual(JSON.parse(contents.get(p.dataPath)).articles.map(article=>article.status),['used','discard','used']);
});

test('invalid selection and summary responses stop before writing or generating an image',async()=>{
    for (const stage of ['Runtime selection','Runtime summaries']) {
        const {p,contents}=await newsletterFixture();
        const before=contents.get(p.dataPath),generate=p.generate;
        const path='Data/text-machine-'+p.newsletter.day()+'.md';
        await p.app.vault.create(path,'# Existing edition');
        p.generate=async(connection,system,input,...rest)=>{
            if (JSON.parse(input).instructions===stage) return stage==='Runtime selection'
                ? JSON.stringify({selected:[1],discard:[]}) : JSON.stringify({groups:[]});
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
        const {p,contents,entries} = await newsletterFixture();
        p.settings.newsletterLanguage = language;
        p.generate = withStages(p, async(_connection,_system,input)=>_system.startsWith('Runtime rewriter') ? input : JSON.stringify({title:"L'IA: demain...",chapeau:"L'auteur s'interroge: vraiment?",
            paragraphs:["«Un livre!», dit l'auteur.","Un lien [L'IA?](https://example.com/used)."]}),
        ()=>[{title:'Livres',articles:[{id:1,title:'Un livre',summary:"L'auteur: 25 euros."}]}]);
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
            return input.replace('Une étude quasi expérimentale compare deux groupes existants.','Une étude compare deux groupes existants.');
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

test('only article paragraphs are revised; titles, chapeau, summaries and captions stay outside the request',async()=>{
    const {p,contents}=await newsletterFixture();
    p.settings.newsletterLanguage='English';
    const paragraphs=['The original article prose.','The second paragraph [Source](https://example.com/used).'];
    let revisions=0;
    p.generate=withStages(p, async(_connection,system,input)=>{
        if (system.startsWith('Runtime rewriter')) {
            revisions++;
            assert.equal(input,paragraphs.join('\n\n'));
            for (const absent of ['TITLE MUST STAY','CHAPEAU MUST STAY','SUMMARY MUST STAY','GROUP MUST STAY','![','illustrations/']) assert.ok(!input.includes(absent));
            return input.replace('original article prose','revised article prose');
        }
        return JSON.stringify({title:'TITLE MUST STAY',chapeau:'CHAPEAU MUST STAY',paragraphs});
    },()=>[{title:'GROUP MUST STAY',articles:[{id:1,title:'Source',summary:'SUMMARY MUST STAY'}]}]);
    const note=await p.writeNewsletter();
    const markdown=contents.get(note.path);
    assert.equal(revisions,1);
    assert.ok(markdown.startsWith('# TITLE MUST STAY'));
    assert.ok(markdown.includes('*CHAPEAU MUST STAY*'));
    assert.ok(markdown.includes('### GROUP MUST STAY'));
    assert.ok(markdown.includes('SUMMARY MUST STAY'));
    assert.ok(markdown.includes('The revised article prose.'));
    assert.ok(markdown.includes('](illustrations/'));
});

test('failed body revisions save the original article while cancellation still prevents saving',async()=>{
    for (const failure of ['error','truncated','link','empty','cancel']) {
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
            return failure==='truncated' ? input.slice(0,20) : input.replace('https://example.com/used','https://other.com/used');
        });
        if (failure==='cancel') {
            await assert.rejects(p.writeNewsletter(),/cancelled/);
            assert.equal(contents.get(p.dataPath),before);
            assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,0);
        } else {
            const progress=[];
            const note=await p.writeNewsletter((message,stream,reset)=>progress.push({message,stream,reset}));
            const markdown=contents.get(note.path);
            assert.ok(markdown.includes('First paragraph. [Source](https://example.com/used)'));
            assert.ok(!markdown.includes('https://other.com/used'));
            assert.ok(markdown.includes('](illustrations/'));
            assert.deepEqual(JSON.parse(contents.get(p.dataPath)).articles.map(article=>article.status),['used','discard','used']);
            assert.ok(progress.some(entry=>entry.message.includes('original article retained')));
            assert.ok(progress.some(entry=>entry.stream && entry.reset && entry.message.includes('First paragraph.')));
        }
    }
});

test('omitting optional context variables avoids reading old notes and fetching the blog feed',async()=>{
    const {p,contents,seen} = await newsletterFixture();
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

test('the configured Substack is fetched by the plugin and its posts are inserted in the prompt',async()=>{
    const {p,seen} = await newsletterFixture();
    const urls = [];
    p.request = async options=>{urls.push(options.url);return {status:200,text:'<rss/>'};};
    await p.writeNewsletter();
    assert.deepEqual(urls,['https://example.substack.com/feed']);
    assert.equal(seen[0].recentPosts[0].title,'Recent blog post');
    assert.equal(seen[0].recentPosts[0].content,'Recent idea');
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

test('include feeds share email deduplication, exclusions, forbidden statuses and article crawling',async()=>{
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
            ? [{title:'New story',url:'https://example.com/new-story?utm_source=rss',publish:'2026-11-01T10:00:00.000Z',content:'Unverified summary'},entries[0]]
            : [{title:'New story',url:'https://other.example/repost'}, {title:'PDF',url:'https://example.com/report.pdf'},
                {title:'Blocked',url:'https://blocked.example/article'}, {title:'Excluded',url:'https://ignored.example/article'}];
    };
    p.crawler = {...p.crawler,crawl:async article=>{crawled.push(article.url);return {...article,content:'Verified article text'};}};
    const result = await p.importUnread();
    assert.ok(result.includes('RSS articles added: 3'));
    const saved = JSON.parse(contents.get(p.dataPath)).articles;
    assert.equal(saved.length,6);
    const story = saved.find(article=>article.title==='New story');
    assert.equal(story.source,'RSS: first.example');
    assert.equal(story.publish,'2026-11-01T10:00:00.000Z');
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
    p.newsletter.readFeed = url=>[{title:url.includes('first.example') ? 'First story' : 'Second story',url:url+'/article'}];
    await assert.rejects(p.importFeeds(),/Unable to read/);
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles.length,4);
    fail = false;
    assert.equal(await p.importFeeds(),1);
    assert.equal(JSON.parse(contents.get(p.dataPath)).articles.length,5);
});

test('cancelling RSS collection keeps saved articles and releases the collection controller',async()=>{
    const {p,contents} = await newsletterFixture();
    p.settings.includeFeeds = 'https://first.example/rss';
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
        assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,0);
    }
});

test('generation errors and note save failures leave article statuses unchanged',async()=>{
    for (const failure of ['api','create','invalid']) {
        const {p,contents,failCreate} = await newsletterFixture();
        const before = contents.get(p.dataPath);
        if (failure==='api') p.generate = withStages(p, async()=>{throw new Error('Provider refused');});
        if (failure==='invalid') p.generate = withStages(p, async()=>'{broken');
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
    p.generate = withStages(p, async()=>{throw new Error('Must not call');});
    assert.equal(await p.writeNewsletter(),null);
});


test('closing the run during generation prevents a late note and status changes',async()=>{
    const {p,contents} = await newsletterFixture();
    const before = contents.get(p.dataPath);
    p.generate = withStages(p, async()=>{
        p.aiController.abort();
        return JSON.stringify({title:'Too late',chapeau:'Late.',paragraphs:['First','Second'],lead:1,image:null,groups:[{title:'Books',articles:[{id:1,summary:'Summary'}]}],discard:[2]});
    });
    await assert.rejects(p.writeNewsletter(),/cancelled/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,0);
});

test('irrelevant articles are discarded without creating a note',async()=>{
    const {p,contents} = await newsletterFixture();
    p.generate = async()=>JSON.stringify({selected:[],discard:[1,2]});
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
    p.generate = async(_connection,_system,input)=>JSON.stringify({selected:[],discard:JSON.parse(input).articles.map(article=>article.id)});
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
        p.generate = withStages(p, async()=>JSON.stringify({title:'A title',chapeau:'Introduction',paragraphs:['One','Two'],lead:1,image:null,
            groups:[{title:'Books',articles:[{id:1,summary:'Summary'}]}],discard:[2],...malicious}));
        await assert.rejects(p.writeNewsletter(),/Invalid AI response/);
        assert.equal(contents.get(p.dataPath),before);
        assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,0);
    }
});


test('a brief-only edition translates titles without reading forbidden content and persists the briefing date',async()=>{
    const {p,contents,entries} = await newsletterFixture();
    p.settings.newsletterLanguage='français';
    const original={...entries[0],title:'How AI changes writing',status:'forbidden',content:'Unverified content must never be sent to AI'};
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[original]}));
    let translations=0;
    p.generate = withStages(p, async(_connection,system,input)=>{
        translations++;
        assert.ok(system.includes('Runtime brief français'));
        assert.deepEqual(JSON.parse(input),[{id:1,title:original.title}]);
        return JSON.stringify({titles:[{id:1,title:'Comment l’IA transforme l’écriture'}]});
    });
    p.request = async()=>{throw new Error('No feed needed');};
    p.loadPage = async()=>{throw new Error('Forbidden sources must not be loaded');};
    const note = await p.writeNewsletter();
    const markdown = contents.get(note.path);
    assert.ok(markdown.startsWith('# In brief'));
    assert.ok(markdown.includes('* [Comment l’IA transforme l’écriture](https://example.com/used)'));
    assert.ok(!markdown.includes(original.title));
    assert.ok(!markdown.includes(original.content));
    assert.ok(!markdown.includes('## Revue de presse'));
    const saved = JSON.parse(contents.get(p.dataPath)).articles[0];
    assert.equal(saved.title,original.title);
    assert.equal(saved.content,original.content);
    assert.equal(saved.status,'forbidden');
    assert.equal(saved.usedAt,p.newsletter.day());
    assert.equal((await p.writeNewsletter()).path,note.path);
    assert.equal(translations,2);
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
        return JSON.stringify({titles:[{id:4,title:'Nouvelle étude sur l’écriture avec l’IA'}]});
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
        const before=JSON.stringify({version:1,nextId:2,articles:[{...entries[0],status:'forbidden'}]});
        contents.set(p.dataPath,before);
        const path='Data/text-machine-'+p.newsletter.day()+'.md';
        await p.app.vault.create(path,'# Existing edition');
        if (failure==='empty-prompt') {
            const read=p.app.vault.adapter.read;
            p.app.vault.adapter.read=async path=>path.endsWith('/prompts/bref.md') ? '' : read(path);
        }
        p.generate=withStages(p, async()=>{
            if (failure==='error') throw new Error('Translation unavailable');
            if (failure==='cancel') {p.aiController.abort();return JSON.stringify({titles:[{id:1,title:'Late title'}]});}
            return JSON.stringify({titles:failure==='incomplete' ? [] : [{id:99,title:'Unknown title'}]});
        });
        await assert.rejects(p.writeNewsletter(),/bref.md.*empty|incomplete or invalid|Translation unavailable|cancelled/);
        assert.equal(contents.get(path),'# Existing edition');
        assert.equal(contents.get(p.dataPath),before);
        assert.ok(![...contents.keys()].some(path=>path.endsWith('.png')));
    }
});

test('Codex receives a separate constrained schema for brief titles without calling the writer',async()=>{
    const {p,contents,entries}=await newsletterFixture();
    contents.set(p.dataPath,JSON.stringify({version:1,articles:[{...entries[0],status:'forbidden'}]}));
    p.settings.newsletterLanguage='English';
    p.getAIConnection=()=>({provider:'codex',model:'fixture'});
    let calls=0;
    p.codex={...p.codex,findCodex:async()=>'/test/codex',generate:async(executable,system,input,model,signal,_progress,schema)=>{
        calls++;
        assert.equal(executable,'/test/codex');
        assert.equal(model,'fixture');
        assert.ok(!signal.aborted);
        assert.ok(system.includes('Runtime brief English'));
        assert.deepEqual(JSON.parse(input),[{id:1,title:'used'}]);
        assert.ok(schema.properties.titles);
        assert.equal(schema.additionalProperties,false);
        return JSON.stringify({titles:[{id:1,title:'Translated title'}]});
    }};
    p.generate=withStages(p, async()=>{throw new Error('Cloud API must not be called');});
    const note=await p.writeNewsletter();
    assert.equal(calls,1);
    assert.ok(contents.get(note.path).includes('* [Translated title](https://example.com/used)'));
});

test('the illustration is generated from the revised article without loading source photographs',async()=>{
    const {p,contents}=await newsletterFixture();
    p.settings.newsletterLanguage='English';
    const data=JSON.parse(contents.get(p.dataPath));
    data.articles[0].image='https://example.com/source.jpg';
    data.articles[0].imageCaption='Original source caption';
    contents.set(p.dataPath,JSON.stringify(data));
    p.loadPage=async()=>{throw new Error('Source photographs must not be loaded');};
    p.generate=withStages(p,async(_connection,system,input)=>system.startsWith('Runtime rewriter')
        ? input.replace('Original first paragraph.','Revised first paragraph.')
        : JSON.stringify({title:'A synthesis',chapeau:'Several ideas.',paragraphs:['Original first paragraph.','A second paragraph.']}));
    let images=0;
    p.generateIllustration=async(_key,prompt,_request,signal)=>{
        images++;
        assert.ok(!signal.aborted);
        assert.ok(prompt.includes('Revised first paragraph.'));
        assert.ok(!prompt.includes('Original first paragraph.'));
        assert.ok(!prompt.includes('source.jpg'));
        assert.ok(!prompt.includes('Original source caption'));
        assert.ok(prompt.includes('English'));
        return new ArrayBuffer(8);
    };
    const note=await p.writeNewsletter();
    const image='illustrations/'+note.name.replace(/\.md$/,'.png');
    assert.equal(images,1);
    assert.ok(contents.get(note.path).includes('![A synthesis]('+image+')'));
    assert.ok(contents.has('Data/'+image));
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
    assert.ok(markdown.includes('](illustrations/'+note.name.replace(/\.md$/,'.png')+')'));
    assert.ok(!markdown.includes('Source caption'));
    assert.ok(!markdown.includes('source.jpg'));
});

test('an illustration failure prevents saving a newsletter without an image',async()=>{
    const {p,contents}=await newsletterFixture();
    const before=contents.get(p.dataPath);
    p.createIllustration=async()=>{throw new Error('Illustration unavailable');};
    await assert.rejects(p.writeNewsletter(),/Illustration unavailable/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal([...contents.keys()].filter(path=>path.endsWith('.md')).length,0);
});

test('the existing daily illustration is reused without image generation, decoding or an image API key',async()=>{
    const {p,contents}=await newsletterFixture();
    let images=0;
    p.generateIllustration=async()=>{images++;return new ArrayBuffer(8);};
    const note=await p.writeNewsletter();
    const image='Data/illustrations/'+note.name.replace(/\.md$/,'.png');
    const before=contents.get(image);
    p.getAIKey=()=>{throw new Error('No image key should be read for a cached illustration');};
    p.createIllustration=async()=>{throw new Error('A cached image must not be rendered again');};
    const next=await p.writeNewsletter();
    assert.equal(next.path,note.path);
    assert.equal(images,1);
    assert.equal(contents.get(image),before);
    assert.equal([...contents.keys()].filter(path=>path.endsWith('.png')).length,1);
});

test('cancelling image generation prevents any late note or status write',async()=>{
    const {p,contents}=await newsletterFixture();
    const before=contents.get(p.dataPath);
    p.generateIllustration=async()=>{p.aiController.abort();return new ArrayBuffer(8);};
    await assert.rejects(p.writeNewsletter(),/cancelled/);
    assert.equal(contents.get(p.dataPath),before);
    assert.equal([...contents.keys()].filter(path=>path.endsWith('.md') || path.endsWith('.png')).length,0);
});

test('settings definitions are searchable without IO and redraw uses the declarative API when available',async()=>{
    const {p}=await fixture();
    p.codex={...p.codex,findCodex:()=>assert.fail('Definitions must not discover Codex')};
    p.request=()=>assert.fail('Definitions must not request a network resource');
    const tab=p.settingsTab;
    const definitions=tab.getSettingDefinitions();
    const rows=definitions.flatMap(item=>item.items || [item]);
    for (const key of ['newsletterLanguage','includeFeeds','authorFeeds','aiDefaultModel','aiAnthropicKey','aiOpenaiKey']) {
        assert.ok(rows.some(row=>row.name===p.i18n.t(key) && row.searchable!==false),key);
    }
    let updates=0;
    tab.update=()=>{updates++;};
    tab.renderLegacy=()=>assert.fail('Modern settings must use update()');
    tab.redraw();
    assert.equal(updates,1);
});
