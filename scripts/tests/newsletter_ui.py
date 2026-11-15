import base64, json, pathlib, shutil, socket, subprocess, tempfile, time
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parents[2]
temporary = pathlib.Path(tempfile.mkdtemp(prefix='textmachine-obsidian-'))
profile = temporary / 'profile'
vault = temporary / 'vault'
plugin = vault / '.obsidian/plugins/text-machine'
profile.mkdir()
plugin.mkdir(parents=True)
for name in ('main.js', 'manifest.json', 'styles.css'):
    shutil.copy2(root / name, plugin / name)
with (plugin / 'main.js').open('a') as fixture:
    fixture.write("\nwindow.TestMenu = require('obsidian').Menu;\n")
(plugin / 'oauth-client.json').write_text(json.dumps({'installed': {'client_id': '123-test.apps.googleusercontent.com', 'client_secret': 'test-only'}}))
(plugin / 'prompts').mkdir()
(plugin / 'prompts/writer.md').write_text('{"instructions":"Runtime writer","language":"{{language}}","articles":{{articles}},"previousNewsletters":{{previousNewsletters}},"recentPosts":{{AuthorFeed}}}')
(plugin / 'prompts/publisher.md').write_text('Runtime publisher in {{language}}.\n{{article}}')
(plugin / 'prompts/rewriter.md').write_text('Runtime revision in {{language}}. Simplify jargon and preserve links, images and credits.')
(plugin / 'prompts/bref.md').write_text('Runtime brief in {{language}}.')
(plugin / 'prompts/image.md').write_text('Runtime image generation in {{language}}. Black and white humorous cartoon without text, landscape 4/3.')
(plugin / 'prompts/sélection.md').write_text('{"instructions":"Runtime selection","language":"{{language}}","articles":{{articles}},"previousPosts":{{AuthorFeed}}}')
(plugin / 'models').mkdir()
(plugin / 'models/newsletter.md').write_text((root / 'models/newsletter.md').read_text()+'\nmodèle local\n')
(profile / 'obsidian.json').write_text(json.dumps({'vaults': {'0123456789abcdef': {'path': str(vault), 'ts': int(time.time()*1000), 'open': True}}}))
(vault / '.obsidian/community-plugins.json').write_text('["text-machine"]')
(vault / '.obsidian/core-plugins.json').write_text('["file-explorer"]')
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
process = subprocess.Popen(['/Applications/Obsidian.app/Contents/MacOS/Obsidian', f'--user-data-dir={profile}', f'--remote-debugging-port={port}', '--no-first-run'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    with sync_playwright() as p:
        deadline = time.monotonic() + 25
        while True:
            try:
                browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{port}', timeout=1000)
                break
            except Exception:
                if process.poll() is not None or time.monotonic() > deadline: raise
                time.sleep(.2)
        page = browser.contexts[0].pages[0]
        page.on('console', lambda msg: print('console:', msg.text[:1800], flush=True) if msg.type == 'error' else None)
        tracking_requests = []
        page.on('request', lambda request: tracking_requests.append(request.url) if 'tracker.invalid' in request.url else None)
        page.on('pageerror', lambda error: print('error:', str(error)[:1800], flush=True))
        page.wait_for_function('typeof app !== "undefined" && app.vault && app.workspace && app.workspace.layoutReady', timeout=25000)
        print('Vault:', page.evaluate('app.vault.adapter.getBasePath()'), flush=True)
        print('Plugin:', page.evaluate('JSON.stringify({loaded:!!app.plugins.plugins["text-machine"],secretStorage:!!app.secretStorage})'), flush=True)
        print('Load result:', page.evaluate('async () => { await app.plugins.setEnable(true); await app.plugins.loadManifests(); await app.plugins.loadPlugin("text-machine"); return !!app.plugins.plugins["text-machine"]; }'), flush=True)
        assert page.evaluate('!!app.plugins.plugins["text-machine"]')
        page.evaluate('data => window.fixtureImage = data', base64.b64encode((root / 'scripts/tests/fixtures/illustration.png').read_bytes()).decode())
        page.evaluate(r"""async () => {
            const p = app.plugins.plugins['text-machine'];
            app.vault.setConfig('attachmentFolderPath','Media Test');
            app.vault.setConfig('useMarkdownLinks',true);
            p.codex = {...p.codex,findCodex:async()=>null};
            p.account = {email:'reader@example.com',refreshToken:'fixture',scope:p.gmail.SCOPE,clientId:p.oauth.clientId};
            p.loaded = true;
            p.settings.labelId = 'Label_1';
            p.settings.newsletterLanguage = 'español';
            p.settings.debug = true;
            p.settings.referenceSources = 'news.example.com';
            p.settings.authorFeeds = 'https://tcrouzet.substack.com';
            p.client.unreadMessages = async function* () {};
            await p.ensureData('TextMachine');
            p.settings.outputFolder = 'TextMachine';
            p.updateFolderIcon();
            const article = (slug,extra={})=>({date:'2026-11-03',title:slug,url:'https://example.com/'+slug,source:'User',status:'',publish:'2026-11-01',content:'AI and books '+slug,image:'',...extra});
            const entries = [article('relevant',{status:'used',image:'https://example.com/cover.jpg'}),article('irrelevant'),article('old',{status:'used'}),article('blocked',{title:'New AI writing study',status:'forbidden',content:'Unverified content must never be sent'}),article('companion',{url:'https://another.example/companion'})];
            const file = app.vault.getAbstractFileByPath(p.dataPath);
            const now = new Date();
            const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
            const yesterday=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1);
            window.previousDay=p.newsletter.day(yesterday);
            entries[1].usedAt=window.previousDay;
            await app.vault.modify(file,JSON.stringify({version:1,annotation:'Keep this',articles:entries}));
            window.previousNote='TextMachine/text-machine-'+window.previousDay+'.md';
            await app.vault.create(window.previousNote,'# Yesterday');
            window.firstNote = 'TextMachine/text-machine-'+day+'.md';
            await app.vault.create(window.firstNote,'# Earlier edition\n\n[Source](https://example.com/relevant)');
            await app.vault.create('TextMachine/text-machine-2000-01-01.md','# Previous angle');
            p.request = async options=>{
                if (options.url!=='https://tcrouzet.substack.com/feed') throw new Error('Wrong additional feed');
                return {status:200,text:'<rss><channel><item><title>Latest post</title><link>https://tcrouzet.substack.com/p/latest</link><description><![CDATA[<p>Previous blog idea</p><img src="https://tracker.invalid/image"><script>window.feedExecuted=true</script>]]></description></item></channel></rss>'};
            };
            window.pipelineStages=[];
            window.imageCalls=0;
            window.unexpectedSourceLoads=0;
            p.loadPage=async()=>{window.unexpectedSourceLoads++;throw new Error('Source photos must not be loaded');};
            p.getAIConnection=()=>({provider:'openai',model:'fixture',apiKey:'fixture'});
            p.getAIKey=()=>{throw new Error('Images must use the configured connection, not a separate API key');};
            p.requestAI=async options=>{
                if(options.url!=='https://api.openai.com/v1/responses')throw new Error('Wrong image endpoint');
                const body=JSON.parse(options.body);
                if(body.model!=='fixture' || body.tools[0].type!=='image_generation' || Object.hasOwn(body.tools[0],'model') || body.tools[0].output_format!=='png')throw new Error('Images must use the configured model and its native tool');
                if(!body.input.includes('Runtime image generation in español') || !body.input.includes('A new angle.'))throw new Error('Image prompt must receive the final article and language');
                if(body.input.includes('cover.jpg') || body.input.includes('Selected article.'))throw new Error('Source photos and press review must not become image input');
                window.imageCalls++;window.pipelineStages.push('image');
                if(window.imageCalls>1)throw new Error('The illustration must be generated only once per date');
                return {status:200,json:{status:'completed',output:[{type:'image_generation_call',status:'completed',result:window.fixtureImage}]}};
            };
            window.rewriteResponse=text=>JSON.stringify({paragraphs:text.trim().split(/\r?\n[ \t]*\r?\n+/)});
            window.publication={title:'Books and AI',chapeau:'Introduction.'};
            window.answerPublisher=input=>{
                if(!input.startsWith('Runtime publisher'))return null;
                if(input.includes('illustrations/') || input.includes('Previous blog idea'))throw new Error('Publisher must receive the article body only');
                window.pipelineStages.push('publisher');
                return JSON.stringify(window.publication);
            };
            window.answerStages=input=>{
                let context;try{context=JSON.parse(input);}catch{return null;}
                if(context?.instructions==='Runtime verifier'){
                    throw new Error('The retired verifier must not run');
                }
                if(context?.instructions==='Runtime selection'){
                    if(context.previousPosts[0]?.url!=='https://tcrouzet.substack.com/p/latest')throw new Error('Author history missing from selection');
                    window.pipelineStages.push('selection');
                    if(context.articles.some(article=>['status','image','hasImage','imageCaption'].some(key=>Object.hasOwn(article,key))))throw new Error('Selection must not depend on photo metadata');
                    return JSON.stringify({selected:context.articles.filter(article=>article.title!=='irrelevant').map(article=>article.id),brief:[],discard:context.articles.filter(article=>article.title==='irrelevant').map(article=>article.id)});
                }
                return null;
            };
            window.translateBrief = (system,input)=>{
                if (!system.startsWith('Runtime brief')) return null;
                const titles=JSON.parse(input);
                if (titles.length!==1 || titles[0].id!==4 || titles[0].title!=='New AI writing study'
                    || Object.keys(titles[0]).sort().join(',')!=='id,title') throw new Error('Brief translation must receive only original titles and IDs');
                window.briefTranslationUsed=true;window.pipelineStages.push('bref');
                return JSON.stringify({titles:[{id:4,title:system.includes('français') ? 'Nouvelle étude sur l’écriture avec l’IA' : 'Nueva investigación sobre escritura con IA',category:system.includes('français') ? 'Recherche' : 'Investigación'}]});
            };
            p.generate = async (_connection,system,input,_request,_signal,progress,imageUrl)=>{
                let context;try {context=JSON.parse(input);} catch { /* Revisions receive plain prose. */ }
                if (['Runtime selection','Runtime writer'].includes(context?.instructions)
                    && !system.includes(p.i18n.t('referenceSourcesContract',{ids:context.articles.map(article=>article.id).join(', ')}))) throw new Error('Reference sources missing from selection or writing');
                const publication=window.answerPublisher(input);if(publication)return publication;
                const staged=window.answerStages(input);if(staged)return staged;
                const brief=window.translateBrief(system,input);
                if (brief) return brief;
                if(imageUrl)throw new Error('Source image verification must not run');
                if (system.startsWith('Runtime revision')) {
                    if (input.includes('# Books and AI') || input.includes('Revue de presse') || input.includes('Photograph:') || input.includes('![') || input.includes('illustrations/')) throw new Error('Non-article content sent to revision');
                    const schema=JSON.parse(system.split('\n\n').at(-1)).jsonSchema;
                    if (Object.keys(schema.properties).join()!=='paragraphs' || schema.additionalProperties!==false) throw new Error('Missing revision schema');
                    window.rewriterUsed=true;window.pipelineStages.push('revision');return window.rewriteResponse(input);
                }
                context = JSON.parse(input);
                if (context.instructions!=='Runtime writer') throw new Error('Runtime prompt not loaded');
                if (context.language!=='español' || input.includes('{{language}}')) throw new Error('Prompt variables not expanded');
                if (system.includes('newsletter.md') || system.includes('modèle local') || input.includes('{{#groups}}')) throw new Error('Markdown template sent to AI');
                if (context.articles.length!==2) throw new Error('Writer must receive both selected publications');
                if(Object.hasOwn(context,'summaries'))throw new Error('Removed summaries must not be sent to the writer');
                if (context.articles[0].id!==1 || Object.hasOwn(context.articles[0],'hasImage') || Object.hasOwn(context.articles[0],'status') || Object.hasOwn(context.articles[0],'image')) throw new Error('AI input not optimized');
                if (context.previousNewsletters[0].content!=='# Previous angle') throw new Error('History missing');
                if (context.recentPosts[0].content!=='Previous blog idea') throw new Error('Feed text not inert');
                if (context.recentPosts[0].url!=='https://tcrouzet.substack.com/p/latest') throw new Error('Feed URL missing');
                window.generated = true;window.pipelineStages.push('writer');
                const result = JSON.stringify({paragraphs:['First paragraph.','Second paragraph. [Source](https://example.com/relevant) [Companion](https://another.example/companion)','A new angle.'],used:context.articles.map(article=>article.id)});
                window.fixtureProgress = progress;
                for (let index=0;index<40;index++) progress('Étape '+index);
                progress('<img src="https://tracker.invalid/progress">');
                progress(result.slice(0,80),true);
                await new Promise(resolve=>{window.finishGeneration=resolve;});
                progress(result.slice(80),true);
                return result;
            };
            const menu = new window.TestMenu();
            menu.setUseNativeMenu(false);
            app.workspace.trigger('file-menu',menu,app.vault.getAbstractFileByPath('TextMachine'),'file-explorer');
            menu.showAtPosition({x:120,y:120});
        }""")
        page.evaluate('async () => { await app.vault.delete(app.vault.getAbstractFileByPath(window.previousNote)); }')
        page.locator('.menu-item').filter(has_text='Text Machine').click()
        page.locator('.text-machine-live-output').filter(has_text='First paragraph.').wait_for()
        spinner = page.locator('.text-machine-spinner')
        model = page.locator('.text-machine-run-model')
        assert model.inner_text() == 'Modèle du texte : OpenAI · fixture'
        assert model.is_visible()
        assert spinner.is_visible()
        assert spinner.evaluate("el => getComputedStyle(el).animationName") == 'text-machine-spin'
        page.emulate_media(reduced_motion='reduce')
        assert spinner.evaluate("el => getComputedStyle(el).animationName") == 'none'
        page.emulate_media(reduced_motion='no-preference')
        activity = page.get_by_role('log', name='Journal du traitement')
        assert activity.locator('img').count() == 0
        assert activity.evaluate('el => el.scrollTop > 0 && el.scrollHeight-el.scrollTop-el.clientHeight <= 1')
        assert json.loads((vault / 'TextMachine/textmachine.json').read_text())['articles'][0]['status'] == ''
        assert json.loads((vault / 'TextMachine/textmachine.json').read_text())['articles'][0]['usedAt'] == 'unknown'
        assert len(list((vault / 'TextMachine').glob('text-machine-*.md'))) == 2
        activity.evaluate('el => {el.scrollTop=0;}')
        page.evaluate("window.fixtureProgress('Nouvelle étape')")
        assert activity.evaluate('el => el.scrollTop') == 0
        page.locator('.modal').last.screenshot(path=str(temporary / 'live-progress.png'))
        page.evaluate('window.finishGeneration()')
        page.get_by_role('status').filter(has_text='Newsletter enregistrée').wait_for()
        assert spinner.count() == 0
        assert model.inner_text() == 'Modèle du texte : OpenAI · fixture'
        assert model.is_visible()
        print('Live progress verified before completion: animated spinner, reduced motion, streamed text, inert logs, automatic scrolling, manual scroll preserved and no premature writes.', flush=True)
        assert page.evaluate('window.generated === true && !window.feedExecuted')
        first = page.evaluate('window.firstNote')
        generated = first
        assert (vault / 'TextMachine/text-machine-2000-01-01.md').read_text() == '# Previous angle'
        markdown = (vault / generated).read_text()
        draft_path = vault / 'TextMachine' / pathlib.Path(generated).name.replace('text-machine-', 'brouillon-')
        revision_path = vault / 'TextMachine' / pathlib.Path(generated).name.replace('text-machine-', 'revision-')
        assert draft_path.read_text().startswith('First paragraph.')
        assert draft_path.read_text() == revision_path.read_text()
        assert '# Books and AI' not in draft_path.read_text()
        assert markdown.startswith('# Books and AI')
        assert 'modèle local' in markdown
        assert '## Revue de presse' not in markdown
        assert '* [Nueva investigación sobre escritura con IA](https://example.com/blocked)' in markdown
        assert page.evaluate('window.briefTranslationUsed === true')
        assert 'New AI writing study' not in markdown
        assert 'Unverified content must never be sent' not in markdown
        assert 'AI and books blocked' not in markdown
        assert page.evaluate('window.imageCalls === 1 && window.unexpectedSourceLoads === 0')
        assert page.evaluate('window.rewriterUsed === true')
        assert page.evaluate('JSON.stringify(window.pipelineStages)') == json.dumps(['selection','writer','bref','revision','publisher','image'],separators=(',',':'))
        image_path = vault / 'Media Test' / pathlib.Path(generated).with_suffix('.png').name
        assert image_path.exists()
        assert markdown.count('![Books and AI](') == 1
        assert markdown.index('Second paragraph.') < markdown.index('![Books and AI](') < markdown.index('A new angle.')
        first_image = image_path.read_bytes()
        data = json.loads((vault / 'TextMachine/textmachine.json').read_text())
        assert data['annotation'] == 'Keep this'
        assert [article['id'] for article in data['articles']] == [1,2,3,4,5]
        assert data['nextId'] == 6
        assert [article['status'] for article in data['articles']] == ['','','','forbidden','']
        assert all('used' not in article and article['usedAt'] for article in data['articles'])
        assert data['articles'][3]['title'] == 'New AI writing study'
        assert data['articles'][0]['usedAt'] == page.evaluate("app.plugins.plugins['text-machine'].newsletter.day()")
        assert page.evaluate('app.workspace.getActiveFile().path') == generated
        assert not tracking_requests
        page.evaluate(r"""() => {
            const p = app.plugins.plugins['text-machine'];
            p.runDialog.close();
            p.client.unreadMessages = async function* () {yield 'new-message';};
            p.client.message = async()=>({id:'new-message',internalDate:'1700000000000',labelIds:['UNREAD','Label_1'],payload:{headers:[]},bodies:[{type:'text/plain',text:'https://example.com/new'}]});
            p.client.markRead = async()=>{window.newMessageRead=true;};
            p.crawler = {...p.crawler,crawl:async article=>{
                if (article.url!=='https://example.com/new') throw new Error('Existing article crawled again');
                return {...article,content:'New article about AI and books.',publish:'2026-11-03'};
            }};
            window.publication={title:'Regenerated edition',chapeau:'Updated introduction.'};
            p.generate = async (_connection,_system,input,_request,_signal,_progress,imageUrl)=>{
                const publication=window.answerPublisher(input);if(publication)return publication;
                const staged=window.answerStages(input);if(staged)return staged;
                const brief=window.translateBrief(_system,input);
                if (brief) return brief;
                if(imageUrl)throw new Error('Source image verification must not run');
                if (_system.startsWith('Runtime revision')) return input;
                const context = JSON.parse(input);
                const urls = context.articles.map(article=>article.url).sort();
                if (JSON.stringify(urls)!==JSON.stringify(['https://another.example/companion','https://example.com/new','https://example.com/relevant'])) throw new Error('Today’s selection missing');
                if (context.previousNewsletters.length!==1 || context.previousNewsletters[0].content!=='# Previous angle') throw new Error('Today was included in history');
                window.regenerated = true;
                return JSON.stringify({paragraphs:['New first paragraph. [Source](https://example.com/relevant)','New second paragraph. [Source](https://example.com/new) [Companion](https://another.example/companion)'],used:context.articles.map(article=>article.id)});
            };
            const menu = new window.TestMenu();
            menu.setUseNativeMenu(false);
            app.workspace.trigger('file-menu',menu,app.vault.getAbstractFileByPath('TextMachine'),'file-explorer');
            menu.showAtPosition({x:120,y:120});
        }""")
        page.locator('.menu-item').filter(has_text='Text Machine').click()
        page.get_by_role('status').filter(has_text='Newsletter enregistrée').wait_for()
        assert page.evaluate('window.regenerated && window.newMessageRead')
        assert (vault / generated).read_text().startswith('# Regenerated edition')
        assert len(list((vault / 'TextMachine').glob('text-machine-*.md'))) == 2
        assert (vault / 'TextMachine/text-machine-2000-01-01.md').read_text() == '# Previous angle'
        saved = json.loads((vault / 'TextMachine/textmachine.json').read_text())
        assert saved['articles'][-1]['status'] == ''
        assert 'used' not in saved['articles'][-1]
        assert saved['articles'][-1]['usedAt'] == saved['articles'][0]['usedAt']
        print('Same-day regeneration verified through the folder command: legacy recovery, local Markdown template, new Gmail article, usedAt timestamps, one updated note and previous-day notes unchanged.', flush=True)
        page.evaluate("""async () => {
            const p = app.plugins.plugins['text-machine'];
            p.settings.newsletterLanguage = 'français';
            window.publication={title:"L'IA: demain...",chapeau:"L'auteur s'interroge: vraiment?"};
            p.generate = async (_connection,_system,input) => {
                const publication=window.answerPublisher(input);if(publication)return publication;
                const staged=window.answerStages(input);if(staged)return staged;
                const brief=window.translateBrief(_system,input);
                if (brief) return brief;
                if (_system.startsWith('Runtime revision')) {
                    if (!_system.includes('Runtime revision in français') || _system.includes('{{language}}')) throw new Error('Runtime rewriter prompt missing');
                    return window.rewriteResponse(input.replace('Une étude quasi expérimentale compare deux groupes existants.','Une étude compare deux groupes existants. Les participants ne sont pas répartis au hasard.'));
                }
                const articles = JSON.parse(input).articles;
                return JSON.stringify({paragraphs:["«Un livre!», dit l'auteur. Une étude quasi expérimentale compare deux groupes existants.",'Prix: 25 euros. Source [article](https://example.com/relevant). [Companion](https://another.example/companion).'],used:articles.map(article=>article.id)});
            };
            await p.writeNewsletter();
        }""")
        french_note = (vault / generated).read_text()
        assert 'Une étude quasi expérimentale' in draft_path.read_text()
        assert 'Une étude compare deux groupes existants.' in revision_path.read_text()
        assert 'Une étude quasi expérimentale' not in revision_path.read_text()
        assert french_note.startswith('# L’IA\u00a0: demain…')
        assert '*L’auteur s’interroge\u00a0: vraiment\u00a0?*' in french_note
        assert '«\u00a0Un livre\u00a0!\u00a0», dit l’auteur.' in french_note
        assert 'Prix\u00a0: 25\u00a0euros.' in french_note
        assert '[article](https://example.com/relevant)' in french_note
        assert 'étude quasi expérimentale' not in french_note
        assert 'Une étude compare deux groupes existants.' in french_note
        assert '* [Nouvelle étude sur l’écriture avec l’IA](https://example.com/blocked)' in french_note
        assert 'New AI writing study' not in french_note
        print('Brief titles translated separately into Spanish and French, with original URLs and JSON titles preserved and no forbidden article content sent.', flush=True)
        for failure, reason in [('truncated', 'texte réduit de plus de 10 %'), ('link', 'liens de l’article modifiés'), ('error', 'Rewriter unavailable')]:
            reported = page.evaluate("""async failure => {
                const p = app.plugins.plugins['text-machine'];
                const generate = p.generate;
                const log = [];
                p.generate = async (connection,system,input,...rest) => {
                    if (!system.startsWith('Runtime revision')) return generate(connection,system,input,...rest);
                    if (failure === 'error') throw new Error('Rewriter unavailable');
                    return failure === 'truncated' ? JSON.stringify({paragraphs:[input.slice(0,20),'Too short.']})
                        : window.rewriteResponse(input.replace('https://example.com/relevant','https://other.com/relevant'));
                };
                try {
                    await p.writeNewsletter((message,stream,reset) => log.push({message,stream,reset}));
                    return log;
                } finally {p.generate = generate;}
            }""", failure)
            fallback = (vault / generated).read_text()
            assert fallback.startswith('# L’IA\u00a0: demain…')
            assert 'Une étude quasi expérimentale compare deux groupes existants.' in fallback
            assert '[article](https://example.com/relevant)' in fallback
            assert 'https://other.com/relevant' not in fallback
            assert 'Prix\u00a0: 25\u00a0euros.' in fallback
            assert any('article initial conservé' in entry['message'] and reason in entry['message'] for entry in reported)
            assert any(entry.get('reset') and 'étude quasi expérimentale' in entry['message'] for entry in reported)
        print('Body-only revision and fallback verified in Obsidian for truncated text, changed links and provider errors; original prose saved with titles preserved.', flush=True)
        page.evaluate("""async () => {
            const p=app.plugins.plugins['text-machine'];
            p.getAIKey=()=>{throw new Error('Cached images must not read an image API key');};
            p.generateIllustration=async()=>{throw new Error('Cached images must not be generated again');};
            p.createIllustration=async()=>{throw new Error('Cached images must not be normalized again');};
            await p.writeNewsletter();
            const leaf=app.workspace.getLeavesOfType('markdown').find(leaf=>leaf.view.file?.path===window.firstNote);
            await leaf.setViewState({type:'markdown',state:{file:window.firstNote,mode:'preview'}});
        }""")
        assert image_path.read_bytes() == first_image
        assert page.evaluate('window.imageCalls === 1 && window.unexpectedSourceLoads === 0')
        images=list((vault / 'Media Test').glob('*.png'))
        assert len(images) == 1 and images[0].name == pathlib.Path(generated).with_suffix('.png').name
        page.wait_for_function("Array.from(document.querySelectorAll('.markdown-preview-view img')).some(image=>decodeURIComponent(image.src).includes('/Media Test/') && image.naturalWidth===1600 && image.naturalHeight===1200)")
        dimensions=page.evaluate("""async encoded=>{
            const image=new Image();image.src='data:image/png;base64,'+encoded;await image.decode();
            const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
            const context=canvas.getContext('2d');context.drawImage(image,0,0);
            return {width:image.naturalWidth,height:image.naturalHeight,pixel:Array.from(context.getImageData(100,100,1,1).data)};
        }""",base64.b64encode(first_image).decode())
        assert dimensions['width'] == 1600 and dimensions['height'] == 1200
        red,green,blue,alpha=dimensions['pixel']
        assert red == green == blue and 0 < red < 255 and alpha == 255
        print('Writer body, revision and publisher title/intro verified as separate calls with body-only streaming before the title exists.',flush=True)
        print('Daily illustration verified: final-article input, 4/3 PNG, monochrome pixels, note-based filename and reuse across regenerations without any extra image API call.',flush=True)
        print('French punctuation verified on the saved Obsidian note: title, chapeau, body and protected source links.', flush=True)
        author_guard = page.evaluate("""async () => {
            const p=app.plugins.plugins['text-machine'];
            const file=app.vault.getAbstractFileByPath(p.dataPath),note=app.vault.getAbstractFileByPath(window.firstNote);
            const beforeData=await app.vault.read(file),beforeNote=await app.vault.read(note),generate=p.generate;
            p.generate=async(connection,system,input,...rest)=>{
                let context;try{context=JSON.parse(input);}catch{}
                if(context?.instructions==='Runtime writer')return JSON.stringify({paragraphs:['Un billet [de l’auteur](https://tcrouzet.substack.com/p/latest).','Une autre phrase. [Source](https://example.com/relevant) [Companion](https://another.example/companion).'],used:context.articles.map(article=>article.id)});
                return generate(connection,system,input,...rest);
            };
            let failure='';
            try{await p.writeNewsletter();}catch(error){failure=error.message;}finally{p.generate=generate;}
            return {failure,unchangedData:beforeData===await app.vault.read(file),unchangedNote:beforeNote===await app.vault.read(note)};
        }""")
        assert 'flux d’auteur' in author_guard['failure'], author_guard
        assert author_guard['unchangedData'] and author_guard['unchangedNote'], author_guard
        print('Author-feed history reached selection; an attempted author-post reference was blocked without changing the published note or article usage.', flush=True)
        page.evaluate("""async () => {
            const leaf = app.workspace.getLeavesOfType('file-explorer')[0] || app.workspace.getLeftLeaf(false);
            await leaf.setViewState({type:'file-explorer',active:true});
            await app.workspace.revealLeaf(leaf);
            app.workspace.leftSplit.expand();
        }""")
        folder_label = page.locator('.nav-folder-title[data-path="TextMachine"] > .nav-folder-title-content').first
        folder_label.wait_for()
        for theme in ['theme-light','theme-dark']:
            assert folder_label.evaluate("""(el,theme) => {
                document.body.classList.remove('theme-light','theme-dark');
                document.body.classList.add(theme);
                const icon = getComputedStyle(el,'::after');
                return icon.content === '\"\"' && icon.maskImage.includes('data:image/svg+xml,')
                    && parseFloat(icon.width) > 0 && icon.backgroundColor === getComputedStyle(el).color;
            }""", theme)
        folder_label.screenshot(path=str(temporary / 'folder-icon.png'))
        page.evaluate("""async () => {
            const p = app.plugins.plugins['text-machine'];
            await app.vault.createFolder('Other');
            p.settings.outputFolder = 'Other';
            p.updateFolderIcon();
        }""")
        assert folder_label.evaluate("el => getComputedStyle(el,'::after').content") == 'none'
        other_label = page.locator('.nav-folder-title[data-path="Other"] > .nav-folder-title-content').first
        assert other_label.evaluate("el => getComputedStyle(el,'::after').maskImage.includes('data:image/svg+xml,')")
        page.evaluate("""() => {
            const p = app.plugins.plugins['text-machine'];
            p.settings.outputFolder = '';
            p.updateFolderIcon();
        }""")
        assert other_label.evaluate("el => getComputedStyle(el,'::after').content") == 'none'
        page.evaluate("() => { const p = app.plugins.plugins['text-machine']; p.settings.outputFolder = 'Other'; p.updateFolderIcon(); }")
        assert other_label.evaluate("el => getComputedStyle(el,'::after').maskImage.includes('data:image/svg+xml,')")
        print('Explorer folder icon verified after the folder name, in light and dark themes, and moved/removed when configuration changes.', flush=True)
        print('Newsletter command verified: runtime prompt, eligible articles, previous notes, inert RSS context, same-day note replacement, opened note, preserved annotations, usage dates and unchanged access statuses.', flush=True)
        page.evaluate('async () => { await app.plugins.disablePlugin("text-machine"); }')
        assert other_label.evaluate("el => getComputedStyle(el,'::after').content") == 'none'
        browser.close()
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    print('Isolated runtime:', temporary, flush=True)
