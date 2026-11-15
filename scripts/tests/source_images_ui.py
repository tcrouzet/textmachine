import base64, json, pathlib, shutil, socket, subprocess, tempfile, time
from playwright.sync_api import sync_playwright, expect

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
(plugin / 'prompts/writer.md').write_text('{"instructions":"Runtime writer","language":"{{language}}","commentedArticles":{{commentedArticles}},"articles":{{articles}},"previousNewsletters":{{previousNewsletters}},"recentPosts":{{AuthorFeed}}}')
(plugin / 'prompts/publisher.md').write_text('Runtime publisher in {{language}}.\n{{article}}')
(plugin / 'prompts/rewriter.md').write_text('Runtime revision in {{language}}. Simplify jargon and preserve links, images and credits.')
(plugin / 'prompts/bref.md').write_text('Runtime brief in {{language}}.')
(plugin / 'prompts/image.md').write_text('Runtime image generation in {{language}}. Black and white humorous cartoon without text, landscape 4/3.')
(plugin / 'prompts/sélection.md').write_text('{"instructions":"Runtime selection","language":"{{language}}","commentedArticles":{{commentedArticles}},"articles":{{articles}},"previousPosts":{{AuthorFeed}}}')
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
        source_images = page.evaluate(r"""async () => {
            const p=app.plugins.plugins['text-machine'];
            p.settings.outputFolder='Images';
            p.settings.authorFeeds='';p.settings.referenceSources='';p.settings.debug=true;
            p.settings.newsletterLanguage='English';
            await p.ensureData('Images');
            const articles=[1,2,3].map(id=>({id,date:p.newsletter.day(),title:'Source '+id,
                url:'https://source'+id+'.example/article',content:'Article about writing and AI.',source:'User',authors:[],
                status:'',usedAt:'',publish:'',image:'https://irrelevant.example/body-image.jpg'}));
            const file=app.vault.getAbstractFileByPath(p.dataPath);
            await app.vault.modify(file,JSON.stringify({version:1,nextId:4,articles}));
            const before=await app.vault.read(file),fetched=[],inputs=[];
            const paragraphs=['First [article]('+articles[0].url+').','Second [article]('+articles[1].url+').',
                'Again [first]('+articles[0].url+').'];
            const check=(ok,message)=>{if(!ok)throw new Error(message);};
            p.getAIConnection=()=>({provider:'openai',model:'fixture',apiKey:'fixture'});
            p.generate=async(_connection,system,input)=>{
                inputs.push(input);
                if(input.startsWith('Runtime publisher'))return JSON.stringify({title:'Review',chapeau:'Introduction'});
                if(system.startsWith('Runtime revision'))return JSON.stringify({paragraphs:input.split('\n\n')});
                if(system.startsWith('Runtime brief'))return JSON.stringify({titles:JSON.parse(input).map(({id,title})=>({id,title,category:'Writing'}))});
                const context=JSON.parse(input);
                check(context.commentedArticles===p.settings.commentedArticles,'Writing target must reach the runtime prompts');
                check(system.includes(p.i18n.t('commentedArticlesContract',{count:p.settings.commentedArticles})),'The requested target must also guide customized prompts');
                if(context.instructions==='Runtime selection')return JSON.stringify({selected:[1,2],brief:[3],discard:[]});
                return JSON.stringify({paragraphs,used:[1,2]});
            };
            p.generateIllustration=async()=>{throw new Error('Extracted images must not call an image model');};
            const readPrompt=p.readPrompt.bind(p);
            p.readPrompt=async file=>{check(file!=='image.md','Extracted images must not read the image prompt');return readPrompt(file);};
            p.loadPage=async(url,signal)=>{
                check(!signal.aborted,'Unexpected cancellation');fetched.push(url);
                const id=url.includes('source1') ? 1 : 2;
                return {status:200,url,html:'<meta '+(id===1 ? 'property="og:image"' : 'name="twitter:image"')+' content="/social.jpg">'
                    +'<figure><img src="/social.jpg"><figcaption>Original caption '+id+'. Photo: Author / Agency.</figcaption></figure>'};
            };
            p.settings.imageMode='extracted';
            const note=await p.writeNewsletter(),text=await app.vault.read(note);
            check(JSON.stringify(fetched)===JSON.stringify(articles.slice(0,2).map(article=>article.url)),'Fetch each narrated source once, no brief sources');
            check(text.includes(paragraphs[0]+'\n\n[![Original caption 1. Photo: Author / Agency.](https://source1.example/social.jpg)]('+articles[0].url+')'),'First thumbnail placement and complete caption');
            check(text.includes(paragraphs[1]+'\n\n[![Original caption 2. Photo: Author / Agency.](https://source2.example/social.jpg)]('+articles[1].url+')'),'Twitter thumbnail placement');
            check((text.match(/!\[/g)||[]).length===2,'No repeated thumbnails');
            check(!inputs.some(input=>input.includes('social.jpg') || input.includes('Original caption')),'Images never enter AI requests');
            check(await app.vault.read(file)===before,'Extraction must not alter article data');
            check(!p.crawler.extractSocialImage('<img src="/body.jpg">',articles[0].url),'No body image fallback');
            check(!p.crawler.extractSocialImage('<meta property="og:image" content="javascript:alert(1)">',articles[0].url),'Reject unsafe image URLs');
            check(p.crawler.extractSocialImage('<meta property="og:image" content="javascript:x"><meta name="twitter:image" content="//cdn.example/social.jpg">',articles[0].url).image==='https://cdn.example/social.jpg','Use safe fallback metadata');
            fetched.length=0;p.settings.imageMode='none';
            await p.writeNewsletter();
            check(fetched.length===0 && !(await app.vault.read(note)).includes('!['),'No image mode must skip retrieval');
            p.settings.imageMode='extracted';
            p.loadPage=async()=>{throw new Error('Page unavailable');};
            await p.writeNewsletter();
            const withoutImages=await app.vault.read(note);
            check(!withoutImages.includes('!['),'Missing thumbnails must not invent images or prevent saving');
            p.loadPage=async()=>{p.aiController.abort();throw new Error('Cancelled');};
            let cancelled=false;try{await p.writeNewsletter();}catch{cancelled=true;}
            check(cancelled && await app.vault.read(note)===withoutImages,'Cancelled retrieval must preserve the previous note');
            p.readPrompt=readPrompt;p.settings.imageMode='generated';
            let generations=0;
            p.generateIllustration=async()=>{generations++;return Uint8Array.from(atob(window.fixtureImage),char=>char.charCodeAt(0)).buffer;};
            const locations=['/','./','Media Test','./media','Media Test'];
            for(const [index,location] of locations.entries()) {
                const folder='AttachmentCase'+index;
                p.settings.outputFolder=folder;await p.ensureData(folder);
                await app.vault.modify(app.vault.getAbstractFileByPath(p.dataPath),before);
                app.vault.setConfig('attachmentFolderPath',location);
                app.vault.setConfig('useMarkdownLinks',index%2===0);
                app.vault.setConfig('newLinkFormat',index%2===0 ? 'relative' : 'absolute');
                const generated=await p.writeNewsletter(),markdown=await app.vault.read(generated);
                const expectedFolder=location==='/' ? '' : location==='./' ? folder : location==='./media' ? folder+'/media' : location;
                const image=app.vault.getFiles().find(file=>file.parent.path===(expectedFolder || '/') && file.name.startsWith('test-text-machine-')
                    && file.extension==='png' && markdown.includes(file.basename));
                check(!!image,'Use the configured attachment folder: '+JSON.stringify({location,expectedFolder,markdown,
                    files:app.vault.getFiles().filter(file=>file.extension==='png').map(file=>({path:file.path,parent:file.parent.path,basename:file.basename}))}));
                check(!app.vault.getAbstractFileByPath(folder+'/illustrations'),'No invented illustration folder');
                check(markdown.includes(index%2===0 ? '![' : '![['),'Use Obsidian link preferences');
                const count=app.vault.getFiles().filter(file=>file.extension==='png').length;
                await p.writeNewsletter();
                check(generations===index+1,'Reuse the image when regenerating');
                check(app.vault.getFiles().filter(file=>file.extension==='png').length===count,'No duplicate attachment on regeneration');
            }
            const current=app.vault.getAbstractFileByPath(p.dataPath),original=await app.vault.read(current);
            const reduced=JSON.parse(original);reduced.articles.pop();
            const reducedText=p.articles.withIds(JSON.stringify(reduced));
            await app.vault.modify(current,reducedText);p.settings.debug=false;
            let failure='';try{await p.writeNewsletter();}catch(error){failure=error.message;}
            check(failure===p.i18n.t('newsletterNotEnoughSources',{count:2,minimum:3}),'Three is a blocking threshold outside debug');
            check(await app.vault.read(current)===reducedText,'A blocked generation must preserve the collected articles');
            check(!app.vault.getAbstractFileByPath(p.settings.outputFolder+'/text-machine-'+p.newsletter.day()+'.md'),'A blocked generation must not create a newsletter');
            await app.vault.modify(current,original);p.settings.debug=true;
            return {fetched:2,images:2,missing:'saved',cancelled};
        }""")
        assert source_images == {'fetched': 2, 'images': 2, 'missing': 'saved', 'cancelled': True}, source_images
        print('Source images verified in Obsidian: Open Graph and Twitter metadata, full captions, paragraph placement, no duplicates or brief images, no AI image calls, missing images and cancellation.', flush=True)
        print('Generated attachments verified in Obsidian: vault root, note folder, specified folder, relative subfolder, filename collisions, Markdown and wiki embeds, and same-day image reuse.', flush=True)
        page.evaluate("""() => {
            const p=app.plugins.plugins['text-machine'];
            p.i18n.setLocale('en');
            const tab=app.setting.pluginTabs.find(tab=>tab.id==='text-machine');
            tab.aiDiscoveryStarted=true;tab.aiDiscoveryComplete=true;
            app.setting.open();app.setting.openTabById('text-machine');
        }""")
        panel=page.locator('.text-machine-newsletter')
        expect(panel).to_have_count(1)
        expect(panel.get_by_text('Newsletter: Text Machine',exact=True)).to_be_visible()
        for label in ['Gmail label','Newsletter language','Include feeds','Author feeds','Illustration']:
            expect(panel.get_by_label(label,exact=True)).to_have_count(1)
        target=panel.get_by_role('spinbutton',name='Commented articles in newsletter',exact=True)
        expect(target).to_have_value('3')
        writer=panel.locator('.setting-item').filter(has=page.get_by_text('Article writing',exact=True))
        assert writer.evaluate("el=>el.nextElementSibling.querySelector('input')?.getAttribute('aria-label')==='Commented articles in newsletter'")
        target.fill('5')
        page.wait_for_function("async ()=>(await app.plugins.plugins['text-machine'].loadData()).commentedArticles===5")
        selector=page.get_by_role('combobox',name='Newsletter',exact=True)
        assert selector.evaluate("el=>!el.closest('.text-machine-newsletter')")
        heading=page.locator('.setting-item').filter(has=page.get_by_text('Newsletters',exact=True))
        expect(heading.get_by_text('Each newsletter has its own folder, sources, language and prompts. Gmail and AI settings are shared.',exact=True)).to_be_visible()
        expect(page.locator('.setting-item').filter(has=selector).get_by_text('Newsletter',exact=True)).to_have_count(0)
        picker=page.locator('.text-machine-newsletter-picker')
        layout=picker.evaluate("""el=>{
            const controls=el.querySelector('.setting-item-control');
            const style=getComputedStyle(el);
            return {border:style.borderTopWidth,right:el.getBoundingClientRect().right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth),
                headingBorder:getComputedStyle(el.previousElementSibling).borderBottomWidth,
                controlsRight:controls.getBoundingClientRect().right,alignment:getComputedStyle(controls).justifyContent};
        }""")
        assert layout['border']=='0px' and layout['headingBorder']=='0px' and layout['alignment']=='flex-end', layout
        assert abs(layout['right']-layout['controlsRight'])<=1, layout
        headings=panel.locator('.setting-item-heading .setting-item-name').all_text_contents()
        assert headings[1:3]==['Data folder','Source label'], headings
        debug=page.locator('.setting-item').filter(has=page.get_by_text('Debug',exact=True))
        assert debug.evaluate("el=>!el.closest('.text-machine-newsletter')")
        for theme in ['theme-dark','theme-light']:
            page.evaluate("theme=>{document.body.classList.remove('theme-dark','theme-light');document.body.classList.add(theme);}",theme)
            colors=panel.evaluate("""el=>{
                const probe=el.createDiv();probe.style.backgroundColor='var(--background-secondary)';
                const expected=getComputedStyle(probe).backgroundColor;probe.remove();
                return {actual:getComputedStyle(el).backgroundColor,expected};
            }""")
            assert colors['actual']==colors['expected'], colors
        page.get_by_role('button',name='New newsletter',exact=True).click()
        page.get_by_role('textbox',name='Newsletter name',exact=True).fill('Second newsletter')
        page.get_by_role('button',name='Create newsletter',exact=True).click()
        expect(panel.get_by_text('Newsletter: Second newsletter',exact=True)).to_be_visible()
        expect(target).to_have_value('3')
        expect(panel.get_by_text('Choose an empty folder',exact=True)).to_be_visible()
        first=page.evaluate("app.plugins.plugins['text-machine'].newsletters[0].id")
        selector.select_option(first)
        expect(panel.get_by_text('Newsletter: Text Machine',exact=True)).to_be_visible()
        expect(target).to_have_value('5')
        expect(panel.get_by_text('AttachmentCase4',exact=True)).to_be_visible()
        page.evaluate("app.setting.pluginTabs.find(tab=>tab.id==='text-machine').renderLegacy()")
        expect(panel.get_by_text('Newsletter: Text Machine',exact=True)).to_be_visible()
        assert selector.evaluate("el=>!el.closest('.text-machine-newsletter')")
        assert debug.evaluate("el=>!el.closest('.text-machine-newsletter')")
        print('Newsletter settings verified in Obsidian: named grey panel, all newsletter controls inside, selector and global debug outside, light/dark theme tokens, creation and switching.',flush=True)
        browser.close()
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    shutil.rmtree(temporary)
