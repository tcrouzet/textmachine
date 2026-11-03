import json, pathlib, shutil, socket, subprocess, tempfile, time
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
(plugin / 'prompts/writer.md').write_text('Runtime writer')
(plugin / 'models').mkdir()
(plugin / 'models/newsletter.md').write_text((root / 'models/newsletter.md').read_text().replace('## Revue de presse','## Revue de presse (modèle local)'))
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
        page.evaluate(r"""async () => {
            const p = app.plugins.plugins['text-machine'];
            p.codex = {...p.codex,findCodex:async()=>null};
            p.account = {email:'reader@example.com',refreshToken:'fixture',scope:p.gmail.SCOPE,clientId:p.oauth.clientId};
            p.loaded = true;
            p.settings.labelId = 'Label_1';
            p.client.unreadMessages = async function* () {};
            await p.ensureData('TextMachine');
            p.settings.outputFolder = 'TextMachine';
            p.updateFolderIcon();
            const article = (slug,extra={})=>({date:'2026-11-03',title:slug,url:'https://example.com/'+slug,source:'User',status:'',publish:'2026-11-01',content:'AI and books '+slug,image:'',...extra});
            const entries = [article('relevant',{status:'used',image:'https://example.com/cover.jpg'}),article('irrelevant'),article('old',{status:'used'}),article('blocked',{status:'404'})];
            const file = app.vault.getAbstractFileByPath(p.dataPath);
            await app.vault.modify(file,JSON.stringify({version:1,annotation:'Keep this',articles:entries}));
            const now = new Date();
            const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
            window.firstNote = 'TextMachine/text-machine-'+day+'.md';
            await app.vault.create(window.firstNote,'# Earlier edition\n\n[Source](https://example.com/relevant)');
            await app.vault.create('TextMachine/text-machine-2000-01-01.md','# Previous angle');
            p.request = async()=>({status:200,text:'<rss><channel><item><title>Latest post</title><link>https://tcrouzet.substack.com/p/latest</link><description><![CDATA[<p>Previous blog idea</p><img src="https://tracker.invalid/image"><script>window.feedExecuted=true</script>]]></description></item></channel></rss>'});
            p.browser = {...p.browser,publicUrl:async url=>url==='https://example.com/cover.jpg'};
            p.getAIConnection = ()=>({provider:'openai',model:'fixture',apiKey:'fixture'});
            p.generate = async (_connection,system,input,_request,_signal,progress,imageUrl)=>{
                if (imageUrl) {
                    if (imageUrl!=='https://example.com/cover.jpg') throw new Error('Wrong visual input');
                    window.imageChecked = true;
                    return JSON.stringify({accepted:true,caption:'A typewriter on a desk.'});
                }
                const context = JSON.parse(input);
                if (!system.includes('Runtime writer')) throw new Error('Runtime prompt not loaded');
                if (system.includes('newsletter.md') || system.includes('modèle local') || input.includes('{{#groups}}')) throw new Error('Markdown template sent to AI');
                if (context.articles.length!==2) throw new Error('Wrong articles');
                if (context.articles[0].id!==1 || !context.articles[0].hasImage || Object.hasOwn(context.articles[0],'status') || Object.hasOwn(context.articles[0],'image')) throw new Error('AI input not optimized');
                if (context.previousNewsletters[0].content!=='# Previous angle') throw new Error('History missing');
                if (context.recentPosts[0].content!=='Previous blog idea') throw new Error('Feed text not inert');
                if (context.recentPosts[0].url!=='https://tcrouzet.substack.com/p/latest') throw new Error('Feed URL missing');
                window.generated = true;
                const result = JSON.stringify({title:'Books and AI',chapeau:'Introduction.',paragraphs:['First paragraph.','Second paragraph. [Source](https://example.com/relevant)','A new angle.'],
                    lead:1,image:{caption:'Original caption'},
                    groups:[{title:'Books',articles:[{id:1,summary:'Selected article.'}]}],discard:[2]});
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
        page.locator('.menu-item').filter(has_text='Text Machine').click()
        page.locator('.text-machine-live-output').filter(has_text='# Books and AI').wait_for()
        spinner = page.locator('.text-machine-spinner')
        assert spinner.is_visible()
        assert spinner.evaluate("el => getComputedStyle(el).animationName") == 'text-machine-spin'
        page.emulate_media(reduced_motion='reduce')
        assert spinner.evaluate("el => getComputedStyle(el).animationName") == 'none'
        page.emulate_media(reduced_motion='no-preference')
        activity = page.get_by_role('log', name='Journal du traitement')
        assert activity.locator('img').count() == 0
        assert activity.evaluate('el => el.scrollTop > 0 && el.scrollHeight-el.scrollTop-el.clientHeight <= 1')
        assert json.loads((vault / 'TextMachine/textmachine.json').read_text())['articles'][0]['status'] == 'used'
        assert not json.loads((vault / 'TextMachine/textmachine.json').read_text())['articles'][0].get('usedAt')
        assert len(list((vault / 'TextMachine').glob('*.md'))) == 2
        activity.evaluate('el => {el.scrollTop=0;}')
        page.evaluate("window.fixtureProgress('Nouvelle étape')")
        assert activity.evaluate('el => el.scrollTop') == 0
        page.locator('.modal').last.screenshot(path=str(temporary / 'live-progress.png'))
        page.evaluate('window.finishGeneration()')
        page.get_by_role('status').filter(has_text='Newsletter enregistrée').wait_for()
        assert spinner.count() == 0
        print('Live progress verified before completion: animated spinner, reduced motion, streamed text, inert logs, automatic scrolling, manual scroll preserved and no premature writes.', flush=True)
        assert page.evaluate('window.generated === true && !window.feedExecuted')
        first = page.evaluate('window.firstNote')
        generated = first
        assert (vault / 'TextMachine/text-machine-2000-01-01.md').read_text() == '# Previous angle'
        markdown = (vault / generated).read_text()
        assert markdown.startswith('# Books and AI')
        assert '## Revue de presse (modèle local)' in markdown
        assert '* [blocked](https://example.com/blocked)' in markdown
        assert 'AI and books blocked' not in markdown
        assert page.evaluate('window.imageChecked === true')
        assert '\n\n*A typewriter on a desk.*' in markdown
        assert markdown.index('Second paragraph.') < markdown.index('[![A typewriter on a desk.]') < markdown.index('A new angle.')
        data = json.loads((vault / 'TextMachine/textmachine.json').read_text())
        assert data['annotation'] == 'Keep this'
        assert [article['id'] for article in data['articles']] == [1,2,3,4]
        assert data['nextId'] == 5
        assert [article['status'] for article in data['articles']] == ['used','discard','used','forbidden']
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
            p.generate = async (_connection,_system,input)=>{
                const context = JSON.parse(input);
                const urls = context.articles.map(article=>article.url).sort();
                if (JSON.stringify(urls)!==JSON.stringify(['https://example.com/new','https://example.com/relevant'])) throw new Error('Today’s selection missing');
                if (context.previousNewsletters.length!==1 || context.previousNewsletters[0].content!=='# Previous angle') throw new Error('Today was included in history');
                window.regenerated = true;
                return JSON.stringify({title:'Regenerated edition',chapeau:'Updated introduction.',paragraphs:['New first paragraph.','New second paragraph.'],lead:context.articles[0].id,image:null,
                    groups:[{title:'AI and books',articles:context.articles.map(article=>({id:article.id,summary:'Updated summary.'}))}],discard:[]});
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
        assert len(list((vault / 'TextMachine').glob('*.md'))) == 2
        assert (vault / 'TextMachine/text-machine-2000-01-01.md').read_text() == '# Previous angle'
        saved = json.loads((vault / 'TextMachine/textmachine.json').read_text())
        assert saved['articles'][-1]['status'] == 'used'
        assert saved['articles'][-1]['usedAt'] == saved['articles'][0]['usedAt']
        print('Same-day regeneration verified through the folder command: legacy recovery, local Markdown template, new Gmail article, usedAt timestamps, one updated note and previous-day notes unchanged.', flush=True)
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
        print('Newsletter command verified: runtime prompt, eligible articles, previous notes, inert RSS context, same-day note replacement, opened note, preserved annotations and used/discard statuses.', flush=True)
        page.evaluate('async () => { await app.plugins.disablePlugin("text-machine"); }')
        assert other_label.evaluate("el => getComputedStyle(el,'::after').content") == 'none'
        browser.close()
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    print('Isolated runtime:', temporary, flush=True)
