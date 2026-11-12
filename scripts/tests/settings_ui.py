import json, pathlib, shutil, socket, subprocess, tempfile, time
from playwright.sync_api import sync_playwright, expect

def assert_full_width(field):
    layout = field.evaluate("""el => {
        const row=el.closest('.setting-item'), style=getComputedStyle(row), box=el.getBoundingClientRect();
        return {width:box.width, available:row.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),
            below:box.top>=row.querySelector('.setting-item-info').getBoundingClientRect().bottom};
    }""")
    assert abs(layout['width']-layout['available']) <= 2 and layout['below'], layout

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
(profile / 'obsidian.json').write_text(json.dumps({'vaults': {'0123456789abcdef': {'path': str(vault), 'ts': int(time.time()*1000), 'open': True}}}))
(vault / '.obsidian/community-plugins.json').write_text('["text-machine"]')
(vault / '.obsidian/core-plugins.json').write_text('[]')
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
        page.evaluate("() => { const p = app.plugins.plugins['text-machine']; p.codex = {...p.codex, findCodex:async () => null}; p.writeNewsletter = async () => null; }")
        page.evaluate('() => { app.setting.open(); app.setting.openTabById("text-machine"); }')
        page.get_by_role('button', name='Connecter', exact=True).wait_for()
        icon = page.locator('.vertical-tab-nav-item[data-setting-id="text-machine"] .vertical-tab-nav-item-icon')
        assert icon.is_visible()
        assert icon.locator('svg path').count() == 3
        for theme in ['theme-light', 'theme-dark']:
            assert icon.evaluate("""(el, theme) => {
                const original = document.body.className;
                document.body.classList.remove('theme-light','theme-dark');
                document.body.classList.add(theme);
                const style = getComputedStyle(el);
                const bounds = el.getBoundingClientRect();
                const visible = style.display !== 'none' && bounds.width > 0 && bounds.height > 0;
                const paths = [...el.querySelectorAll('path')];
                const themed = paths.every(path => getComputedStyle(path).stroke === style.color);
                document.body.className = original;
                return visible && themed;
            }""", theme)

        icon.locator('..').screenshot(path=str(temporary / 'settings-icon.png'))
        for index, (filename, label) in enumerate([
            ('sélection.md', 'Sélection des sources'), ('writer.md', 'Rédaction de l’article'),
            ('bref.md', 'En bref'), ('rewriter.md', 'Révision du texte'),
            ('publisher.md', 'Titre et chapeau'), ('image.md', 'Illustration'),
            ('newsletter.md', 'Modèle de newsletter')]):
            directory = 'models' if filename == 'newsletter.md' else 'prompts'
            row=page.locator('.setting-item').filter(has=page.get_by_text(label, exact=True))
            row.get_by_role('button', name='Modifier', exact=True).click()
            editor=page.locator('.text-machine-prompt-editor')
            field=editor.get_by_role('textbox', name='Modèle Markdown' if filename == 'newsletter.md' else 'Consignes du prompt', exact=True)
            original=(root / directory / filename).read_text()
            expect(field).to_have_value(original)
            layout=field.evaluate("""el => {
                const parent=el.parentElement, style=getComputedStyle(parent), box=el.getBoundingClientRect();
                return {width:box.width, parent:parent.clientWidth, height:box.height,
                    paddingLeft:parseFloat(style.paddingLeft),paddingRight:parseFloat(style.paddingRight)};
            }""")
            editor.screenshot(path=str(temporary / 'prompt-editor.png'))
            assert layout['width'] >= layout['parent'] - 4 and layout['height'] >= 200, layout
            if index == 0:
                field.fill('Do not save this draft')
                editor.get_by_role('button', name='Annuler', exact=True).click()
                expect(editor).not_to_be_visible()
                assert not (plugin / 'prompts').exists()
                row.get_by_role('button', name='Modifier', exact=True).click()
                expect(field).to_have_value(original)
            if filename == 'writer.md':
                for invalid, reason in [(' ', 'est vide'), ('No article variable', '{{articles}}'), (original+'\n{{unknown}}', '{{unknown}}')]:
                    field.fill(invalid)
                    editor.get_by_role('button', name='Enregistrer', exact=True).click()
                    expect(editor.get_by_role('alert')).to_contain_text(reason)
                    expect(field).to_have_value(invalid)
                    assert not (plugin / 'prompts' / filename).exists()
            if filename == 'newsletter.md':
                field.fill(original+'\n{{unknown}}')
                editor.get_by_role('button', name='Enregistrer', exact=True).click()
                expect(editor.get_by_role('alert')).to_contain_text('variables invalides')
                assert not (plugin / directory / filename).exists()
            custom=original+'\nConsigne personnalisée pour '+filename+'\n'
            field.fill(custom)
            editor.get_by_role('button', name='Enregistrer', exact=True).click()
            expect(editor).not_to_be_visible()
            assert (plugin / directory / filename).read_text() == custom
            row.get_by_role('button', name='Modifier', exact=True).click()
            expect(field).to_have_value(custom)
            if filename == 'image.md':
                external=custom+'Modification dans un autre éditeur.\n'
                (plugin / 'prompts' / filename).write_text(external)
                field.fill(custom+'My unsaved changes')
                editor.get_by_role('button', name='Enregistrer', exact=True).click()
                expect(editor.get_by_role('alert')).to_contain_text('modifié ailleurs')
                assert (plugin / 'prompts' / filename).read_text() == external
            editor.get_by_role('button', name='Annuler', exact=True).click()
        print('Prompt and template editors verified without Gmail: defaults, full-width fields, cancellation without writes, validation, file persistence, reopening and concurrent-edit protection.', flush=True)
        page.locator('.setting-item-heading .setting-item-name').filter(has_text='Intelligence artificielle').wait_for()
        debug = page.locator('.setting-item').filter(has=page.get_by_text('Debug', exact=True)).locator('.checkbox-container')
        assert not page.evaluate("app.plugins.plugins['text-machine'].settings.debug")
        assert page.evaluate("app.setting.pluginTabs.find(tab => tab.id === 'text-machine').getSettingDefinitions().at(-1).name") == 'Debug'
        debug.click()
        page.wait_for_function("async () => (await app.plugins.plugins['text-machine'].loadData()).debug === true")
        debug.click()
        page.wait_for_function("async () => (await app.plugins.plugins['text-machine'].loadData()).debug === false")
        assert page.evaluate("() => app.setting.pluginTabs.find(tab => tab.id === 'text-machine').getSettingDefinitions().flatMap(item => item.items || [item]).some(row => row.name === 'Langue de la newsletter')")
        language = page.get_by_role('textbox', name='Langue de la newsletter', exact=True)
        assert language.input_value() == 'français'
        assert '{{language}}' in page.locator('.setting-item').filter(has_text='Langue de la newsletter').inner_text()
        language.fill('español')
        page.wait_for_function("async () => (await app.plugins.plugins['text-machine'].loadData()).newsletterLanguage === 'español'")
        minimum = page.get_by_role('spinbutton', name='Articles commentés dans la newsletter', exact=True)
        assert minimum.input_value() == '3'
        minimum.fill('12')
        page.wait_for_function("async () => (await app.plugins.plugins['text-machine'].loadData()).commentedArticles === 12")
        for invalid in ('0', '1', '-1', '2.5', ''):
            minimum.fill(invalid)
            expect(minimum).to_have_attribute('aria-invalid', 'true')
            assert page.evaluate("app.plugins.plugins['text-machine'].settings.commentedArticles") == 12
            minimum.press('Tab')
            expect(minimum).to_have_value('12')
        references = page.get_by_role('textbox', name='Sources de référence', exact=True)
        assert_full_width(references)
        assert references.input_value() == ''
        references.fill('theguardian.com\nbbc.co.uk')
        page.wait_for_function(r"async () => (await app.plugins.plugins['text-machine'].loadData()).referenceSources === 'theguardian.com\nbbc.co.uk'")
        feed = page.get_by_role('textbox', name='Author feeds', exact=True)
        assert_full_width(feed)
        assert feed.input_value() == ''
        assert '{{AuthorFeed}}' in page.locator('.setting-item').filter(has_text='Author feeds').inner_text()
        feed.fill('https://example.substack.com\nhttps://other.example/feed')
        page.wait_for_function(r"async () => (await app.plugins.plugins['text-machine'].loadData()).authorFeeds === 'https://example.substack.com\nhttps://other.example/feed'")
        include = page.get_by_role('textbox', name='Include feeds', exact=True)
        assert_full_width(include)
        assert include.input_value() == ''
        include.fill('https://one.example/feed\nhttps://two.example/rss.xml')
        page.wait_for_function(r"async () => (await app.plugins.plugins['text-machine'].loadData()).includeFeeds === 'https://one.example/feed\nhttps://two.example/rss.xml'")
        include.fill('')
        page.wait_for_function("async () => (await app.plugins.plugins['text-machine'].loadData()).includeFeeds === ''")
        assert page.get_by_role('combobox', name='Modèle par défaut', exact=True).is_enabled()
        assert page.get_by_role('textbox', name='Serveur local', exact=True).is_enabled()
        page.evaluate("""() => {
            app.secretStorage.setSecret('fixture-anthropic','fixture-anthropic-only');
            app.secretStorage.setSecret('fixture-openai','fixture-openai-only');
        }""")
        for label, secret_id in [('Clé API Anthropic','fixture-anthropic'),('Clé API OpenAI','fixture-openai')]:
            row = page.locator('.setting-item').filter(has_text=label)
            assert row.locator('input[type=password]').count() == 0
            row.get_by_role('button', name='Lier...', exact=True).click()
            picker = page.locator('.modal-container').last
            picker.get_by_text(secret_id, exact=True).click()
            picker.get_by_role('button', name='Sauvegarder', exact=True).click()
            reference = row.get_by_text(secret_id, exact=True)
            expect(reference).to_be_visible()
            reference.click()
            assert 'fixture-anthropic-only' not in row.inner_text()
            assert 'fixture-openai-only' not in row.inner_text()
            assert row.locator('.setting-password').count() == 0
            row.locator('.setting-hotkey-icon').click()
            expect(reference).to_have_count(0)
            row.get_by_role('button', name='Lier...', exact=True).click()
            picker = page.locator('.modal-container').last
            picker.get_by_text(secret_id, exact=True).click()
            picker.get_by_role('button', name='Sauvegarder', exact=True).click()
            expect(reference).to_be_visible()
        page.wait_for_function("async () => (await app.plugins.plugins['text-machine'].loadData()).openaiSecretId === 'fixture-openai'")
        assert page.evaluate("app.plugins.plugins['text-machine'].getAIConnection().apiKey === 'fixture-anthropic-only'")
        assert 'fixture-anthropic-only' not in (plugin / 'data.json').read_text()
        assert 'fixture-openai-only' not in (plugin / 'data.json').read_text()
        page.get_by_role('combobox', name='Modèle par défaut', exact=True).select_option('gpt-6.1-sol')
        assert page.evaluate("app.plugins.plugins['text-machine'].getAIConnection().apiKey === 'fixture-openai-only'")
        page.get_by_role('combobox', name='Modèle par défaut', exact=True).select_option('__custom__')
        page.get_by_role('textbox', name='Identifiant du modèle personnalisé', exact=True).fill('gpt-fixture-custom')
        page.get_by_role('textbox', name='Serveur local', exact=True).fill('http://localhost:11434')
        page.get_by_role('textbox', name='Modèle local', exact=True).fill('local-fixture')
        page.wait_for_function("async () => (await app.plugins.plugins['text-machine'].loadData()).localAIModel === 'local-fixture'")
        assert page.evaluate("app.plugins.plugins['text-machine'].getAIConnection().baseUrl") == 'http://localhost:11434/v1'
        page.evaluate("""() => {
            const p = app.plugins.plugins['text-machine'];
            p.settings.codexModel = 'codex-fixture';
            p.codex = {...p.codex, findCodex:async () => '/fixture/codex', listModels:() => new Promise(resolve=>{window.resolveModels=resolve;})};
            const tab = app.setting.pluginTabs.find(tab => tab.id === 'text-machine');
            tab.aiDiscoveryStarted = false;
            tab.display();
        }""")
        page.get_by_role('combobox', name='Codex : modèle', exact=True).wait_for()
        codex_model = page.get_by_role('combobox', name='Codex : modèle', exact=True)
        expect(codex_model).to_have_value('codex-fixture')
        expect(codex_model.locator('option:checked')).to_have_text('codex-fixture')
        expect(codex_model).to_be_disabled()
        effort = page.get_by_role('combobox', name='Codex : effort de raisonnement', exact=True)
        expect(effort).to_be_disabled()
        expect(effort).to_have_value('low')
        page.evaluate("window.resolveModels([{value:'codex-fixture',label:'Codex fixture',efforts:['low','high','ultra']},{value:'restricted-fixture',label:'Restricted fixture',efforts:['medium']}])")
        expect(codex_model).to_be_enabled()
        expect(effort).to_be_enabled()
        assert effort.locator('option').evaluate_all('options => options.map(option=>option.value)') == ['low','high','ultra']
        effort.select_option('high')
        page.wait_for_function("async () => (await app.plugins.plugins['text-machine'].loadData()).codexEffort === 'high'")
        codex_model.select_option('restricted-fixture')
        expect(effort).to_have_value('medium')
        assert effort.locator('option').evaluate_all('options => options.map(option=>option.value)') == ['medium']
        page.get_by_role('combobox', name='Codex : modèle', exact=True).select_option('codex-fixture')
        expect(effort).to_have_value('low')
        effort.select_option('high')
        page.get_by_role('combobox', name='Modèle par défaut', exact=True).select_option('__codex__')
        assert page.evaluate("app.plugins.plugins['text-machine'].getAIConnection().provider") == 'codex'
        assert page.evaluate("app.plugins.plugins['text-machine'].getAIConnection().model") == 'codex-fixture'
        page.evaluate("() => {app.plugins.plugins['text-machine'].codex.listModels=async()=>[{value:'codex-fixture',label:'Codex fixture'}];}")
        page.get_by_role('button', name='Recharger', exact=True).click()
        page.wait_for_function("app.plugins.plugins['text-machine'].aiController === null")
        page.evaluate("() => {app.setting.close();app.setting.open();app.setting.openTabById('text-machine');}")
        expect(codex_model).to_have_value('codex-fixture')
        expect(codex_model.locator('option:checked')).to_have_text('Codex fixture')
        expect(effort).to_have_value('high')
        assert page.evaluate("app.plugins.plugins['text-machine'].getAIConnection().effort") == 'high'
        for secret_id in ('fixture-anthropic','fixture-openai'):
            expect(page.locator('.setting-item-control').get_by_text(secret_id, exact=True)).to_be_visible()
        assert page.locator('.setting-password').count() == 0
        page.evaluate("() => {app.plugins.plugins['text-machine'].codex.listModels=async()=>{throw new Error('Fixture catalog unavailable');};}")
        page.get_by_role('button', name='Recharger', exact=True).click()
        page.get_by_role('alert').filter(has_text='Fixture catalog unavailable').wait_for()
        page.evaluate("() => {app.setting.close();app.setting.open();app.setting.openTabById('text-machine');}")
        expect(codex_model).to_have_value('codex-fixture')
        expect(codex_model.locator('option:checked')).to_have_text('Codex fixture')
        expect(codex_model).to_be_enabled()
        assert page.evaluate("app.plugins.plugins['text-machine'].getAIConnection().model") == 'codex-fixture'
        page.evaluate("() => {app.plugins.plugins['text-machine'].codex.listModels=async()=>[];}")
        page.get_by_role('button', name='Recharger', exact=True).click()
        expect(codex_model.locator('option:checked')).to_have_text('codex-fixture (absent de la liste)')
        assert not codex_model.locator('option:checked').evaluate('el => el.disabled')
        assert page.evaluate("app.plugins.plugins['text-machine'].getAIConnection().model") == 'codex-fixture'
        print('Codex choice verified while loading, after reopening, after catalog failure and when omitted by the catalog.', flush=True)

        assert page.get_by_role('button', name='Importer le JSON', exact=True).count() == 0
        assert page.get_by_text('Première connexion : configurer Google', exact=True).count() == 0
        email = page.locator('input[type=email]')
        assert email.count() == 1
        email.fill('reader@example.com')
        assert page.evaluate('!!app.plugins.plugins["text-machine"].oauth && !!app.plugins.plugins["text-machine"].client')
        assert page.get_by_role('button', name='Connecter', exact=True).is_enabled()
        assert page.evaluate('app.plugins.plugins["text-machine"].email') == 'reader@example.com'
        data = json.loads((plugin / 'data.json').read_text())
        assert not data.get('refreshToken')
        assert page.get_by_role('combobox', name='Libellé Gmail').is_disabled()
        assert page.get_by_role('button', name='Créer le dossier', exact=True).is_disabled()
        assert page.get_by_role('button', name='Connecter', exact=True).evaluate("el => el.classList.contains('mod-cta')")
        assert page.get_by_role('button', name='Déconnecter', exact=True).count() == 0
        page.evaluate(r"""() => {
            const p = app.plugins.plugins['text-machine'];
            p.account = {email: 'reader@example.com', refreshToken: 'fixture', scope: p.gmail.SCOPE, clientId: p.oauth.clientId};
            p.crawler = {...p.crawler, crawl:async article => ({...article, content:'Fixture article content', publish:'2023-11-13', image:'https://example.com/cover.jpg'})};
            p.loaded = true;
            p.labels = [{id: 'Label_1', name: 'Newsletter'}];
            p.client.label = async id => ({id, name: 'Newsletter', messagesTotal: 12});
            p.client.markRead = async id => {
                JSON.parse(await app.vault.read(app.vault.getAbstractFileByPath(p.dataPath)));
                (window.markedRead ||= []).push(id);
            };
            app.setting.openTabById('text-machine');
        }""")
        def context_menu(folder='Research/Veille'):
            page.evaluate("""folder => {
                app.setting.close();
                const menu = new window.TestMenu();
                menu.setUseNativeMenu(false);
                app.workspace.trigger('file-menu', menu, app.vault.getAbstractFileByPath(folder), 'file-explorer');
                menu.showAtPosition({x:250,y:250});
            }""", folder)
            page.locator('.menu-item').filter(has_text='Text Machine').click()

        def settings():
            page.keyboard.press('Escape')
            page.evaluate('() => { app.setting.open(); app.setting.openTabById("text-machine"); }')

        assert page.get_by_role('button', name='Déconnecter', exact=True).count() == 1
        assert page.get_by_role('button', name='Connecter', exact=True).count() == 0
        page.get_by_role('combobox', name='Libellé Gmail').select_option('Label_1')
        page.get_by_text('Source enregistrée', exact=True).wait_for()
        page.get_by_role('button', name='Vérifier l’accès').click()
        page.get_by_text('« Newsletter » accessible. Messages : 12.', exact=True).wait_for()
        page.evaluate(r"""() => {
            app.plugins.plugins['text-machine'].client.label = async () => {throw new Error('Accès refusé. Reconnectez Gmail.');};
        }""")
        page.get_by_role('button', name='Vérifier l’accès').click()
        page.get_by_role('alert').filter(has_text='Accès refusé').wait_for()
        assert page.get_by_text('« Newsletter » accessible. Messages : 12.', exact=True).count() == 0
        page.screenshot(path=str(temporary / 'settings.png'))
        data = json.loads((plugin / 'data.json').read_text())
        assert data['labelId'] == 'Label_1'
        assert not data.get('refreshToken')
        page.evaluate(r"""async () => {
            await app.vault.createFolder('Research');
        }""")
        assert page.get_by_role('button', name='Enregistrer le nom', exact=True).count() == 0
        assert page.get_by_role('button', name='Créer le journal', exact=True).count() == 0
        assert page.get_by_role('button', name='Extraire les liens', exact=True).count() == 0
        assert page.get_by_role('button', name='Visualiser le JSON', exact=True).count() == 0
        assert page.evaluate(r"""async () => {
            try { await app.plugins.plugins['text-machine'].importUnread(); return false; }
            catch (error) { return error.message.includes('Créez le dossier'); }
        }""")
        page.get_by_role('button', name='Créer le dossier', exact=True).click()
        folder_rows = page.locator('.text-machine-folders')
        assert folder_rows.locator('button.is-selected').inner_text() == 'Racine du coffre'
        research = folder_rows.get_by_role('button', name='Ouvrir le dossier Research', exact=True)
        assert folder_rows.locator('button.is-selected').evaluate(r"""el => {
            const reference = document.createElement('div');
            reference.className = 'tree-item-self is-selected';
            el.parentElement.append(reference);
            const actual = getComputedStyle(el), native = getComputedStyle(reference);
            const matches = actual.backgroundColor === native.backgroundColor && actual.color === native.color;
            reference.remove();
            return matches;
        }""")
        research.hover()
        assert folder_rows.locator('button.is-selected').inner_text() == 'Racine du coffre'
        root_row = folder_rows.get_by_role('button', name='Racine du coffre', exact=True)
        root_row.focus()
        assert folder_rows.locator('button.is-selected').inner_text() == 'Racine du coffre'
        root_row.press('ArrowDown')
        assert folder_rows.locator('button.is-selected').inner_text() == 'Racine du coffre'

        page.get_by_role('button', name='Ouvrir le dossier Research', exact=True).click()
        assert folder_rows.locator('button.is-selected').inner_text() == 'Research'
        page.get_by_role('button', name='Choisir ce dossier', exact=True).click()
        page.get_by_text('Fichier prêt : Research/textmachine.json.', exact=True).wait_for()
        assert (vault / 'Research/textmachine.json').exists()
        expect(page.get_by_role('textbox', name='Sites bloqués', exact=True)).to_have_value('')
        expect(page.get_by_role('textbox', name='Sites bloqués', exact=True)).to_have_attribute('placeholder', 'Aucun site bloqué.')
        page.get_by_role('button', name='Déplacer…', exact=True).click()
        assert page.get_by_role('textbox', name='Nom du nouveau dossier', exact=True).count() == 0
        page.get_by_role('button', name='Annuler', exact=True).click()
        # Exercise initial creation again with a configured path that does not yet exist.
        page.evaluate('() => { app.plugins.plugins["text-machine"].settings.outputFolder = "Research/Veille"; app.setting.openTabById("text-machine"); }')
        page.get_by_role('button', name='Créer le dossier', exact=True).click()
        page.get_by_role('button', name='Ouvrir le dossier Research', exact=True).click()
        assert page.get_by_role('button', name='Nouveau dossier', exact=True).count() == 0
        assert page.get_by_role('textbox', name='Nom du nouveau dossier', exact=True).input_value() == 'TextMachine'
        page.get_by_role('textbox', name='Nom du nouveau dossier', exact=True).fill('../invalid')
        page.get_by_role('button', name='Créer ici', exact=True).click()
        page.get_by_role('alert').filter(has_text='Saisissez un nom').wait_for()
        assert page.evaluate('app.plugins.plugins["text-machine"].settings.outputFolder') == 'Research/Veille'
        page.get_by_role('textbox', name='Nom du nouveau dossier', exact=True).fill('Veille')
        page.get_by_role('button', name='Créer ici', exact=True).click()
        page.get_by_text('Fichier prêt : Research/Veille/textmachine.json.', exact=True).wait_for()
        page.evaluate(r"""async () => {
            const p = app.plugins.plugins['text-machine'];
            await app.vault.process(app.vault.getAbstractFileByPath('Research/Veille/textmachine.json'), text => JSON.stringify({...JSON.parse(text), notes:'My existing notes'}, null, 2) + '\n');
            p.client.unreadMessages = async function* () { yield 'mail1'; yield 'mail2'; yield 'mail3'; };
            p.client.message = async id => {
                if (id === 'mail3' && !window.retryImport) throw new Error('Interruption simulée.');
                return {id, internalDate: '1700000000000', labelIds: ['UNREAD', 'Label_1'],
                    payload: {headers: [{name:'From', value:'Google <googlealerts-noreply@google.com>'}, {name:'Subject', value:'Articles'}]},
                    bodies: [{type:'text/html', text:'<img src="https://tracker.invalid/pixel"><script>window.mailScriptRan=true</script><a href="https://www.google.com/url?url=https%3A%2F%2Fexample.com%2Farticle%3Futm_source%3Dmail">Article &amp; science</a><a href="https://example.com/unsubscribe">Se désabonner</a><a href="https://example.com/related">Related</a><a href="https://www.google.fr/alerts/feedback?ffu=https://example.com/article">Signaler comme non pertinent</a><footer><a href="https://example.com/footer-special">Footer</a></footer>'}]};
            };
        }""")
        context_menu()
        page.get_by_role('alert').filter(has_text='Messages déjà enregistrés : 1').wait_for()
        settings()
        assert page.evaluate('window.markedRead') == ['mail1', 'mail2']
        page.evaluate('() => { window.retryImport = true; }')
        context_menu()
        page.get_by_text('Messages ajoutés : 0 · Liens : 0 · Messages déjà présents : 3 · Fichier : Research/Veille/textmachine.json.', exact=True).wait_for()
        settings()
        context_menu()
        page.get_by_text('Messages ajoutés : 0 · Liens : 0 · Messages déjà présents : 3 · Fichier : Research/Veille/textmachine.json.', exact=True).wait_for()
        settings()
        log = (vault / 'Research/Veille/textmachine.json').read_text()
        assert '<!--' not in log
        saved = json.loads(log)
        page.evaluate("""async () => {
            const p = app.plugins.plugins['text-machine'];
            await app.vault.process(app.vault.getAbstractFileByPath(p.dataPath), text => {
                const data = JSON.parse(text);
                delete data.nextId;
                for (const article of data.articles) delete article.id;
                return JSON.stringify(data, null, 2) + '\\n';
            });
        }""")
        assert all('id' not in article for article in json.loads((vault / 'Research/Veille/textmachine.json').read_text())['articles'])
        page.get_by_role('button', name='Visualiser le JSON', exact=True).click()
        viewer = page.locator('.text-machine-json')
        viewer.wait_for()
        assert json.loads(viewer.inner_text()) == saved
        page.keyboard.press('Escape')
        assert (vault / 'Research/Veille/textmachine.json').read_text() == log
        assert saved['version'] == 1
        assert len(saved['articles']) == 1
        assert saved['nextId'] == 2
        assert saved['articles'][0] == {'id':1,'date':'2023-11-14','title':'Article & science','url':'https://example.com/article','source':'Google Alerts','authors':[],'status':'','usedAt':'','publish':'2023-11-13','content':'Fixture article content','image':'https://example.com/cover.jpg'}
        assert 'My existing notes' in log
        assert 'unsubscribe' not in log and 'tracker.invalid' not in log and 'footer-special' not in log and '/related' not in log
        assert not page.evaluate('!!window.mailScriptRan')
        assert not tracking_requests
        page.evaluate("""async () => {
            const p = app.plugins.plugins['text-machine'];
            await app.vault.create(p.blockedPath, JSON.stringify({version:1,blocked:[{url:'https://blocked.example',scope:'site',reason:'403'},{url:'https://restricted.example',scope:'site',reason:'403'}]}));
        }""")
        blocked_before = (vault / 'Research/Veille/blocked.json').read_text()
        settings()
        blocked = page.get_by_role('textbox', name='Sites bloqués', exact=True)
        expect(blocked).to_have_value('blocked.example, restricted.example')
        assert not blocked.is_editable()
        assert blocked.is_enabled()
        assert_full_width(blocked)
        assert (vault / 'Research/Veille/blocked.json').read_text() == blocked_before
        assert 'Le plugin ne peut pas lire ces sites.' in page.locator('.setting-item').filter(has=blocked).inner_text()
        assert 'connexion à un compte' in page.locator('.setting-item').filter(has=blocked).inner_text()
        assert 'abonnement' in page.locator('.setting-item').filter(has=blocked).inner_text()
        assert 'filtrage' in page.locator('.setting-item').filter(has=blocked).inner_text()
        expect(page.get_by_role('button',name='Tester les sources bloquées',exact=True)).to_have_count(0)
        debug.click()
        expect(blocked).to_be_editable()
        page.evaluate("() => { const p=app.plugins.plugins['text-machine']; window.diagnosticAccount=p.account; p.account=null; }")
        settings()
        diagnostic_button=page.get_by_role('button',name='Tester les sources bloquées',exact=True)
        assert diagnostic_button.is_enabled()
        diagnostic_button.click()
        report_view=page.locator('.text-machine-json')
        report_view.wait_for()
        diagnostic=json.loads(report_view.inner_text())
        assert diagnostic['finishedAt'] and not diagnostic['cancelled']
        assert diagnostic['sources']==[
            {'domain':'blocked.example','skippedPdfs':0,'reason':'no-article-url','articles':[]},
            {'domain':'restricted.example','skippedPdfs':0,'reason':'no-article-url','articles':[]},
        ]
        reports=list((vault/'Research/Veille').glob('blocked-report-*.json'))
        assert len(reports)==1 and json.loads(reports[0].read_text())==diagnostic
        assert (vault/'Research/Veille/textmachine.json').read_text()==log
        assert (vault/'Research/Veille/blocked.json').read_text()==blocked_before
        page.keyboard.press('Escape')
        blocked.fill('restricted.example')
        blocked.press('Tab')
        page.wait_for_function("async () => JSON.stringify(await app.plugins.plugins['text-machine'].readBlocked()) === '[\"restricted.example\"]'")
        assert (vault/'Research/Veille/textmachine.json').read_text()==log
        blocked.fill('blocked.example, restricted.example')
        blocked.press('Tab')
        page.wait_for_function("async () => (await app.plugins.plugins['text-machine'].readBlocked()).length === 2")
        debug.click()
        expect(blocked).not_to_be_editable()
        expect(page.get_by_role('button',name='Tester les sources bloquées',exact=True)).to_have_count(0)
        page.evaluate("() => { app.plugins.plugins['text-machine'].account=window.diagnosticAccount; delete window.diagnosticAccount; }")
        settings()
        exclusions = page.get_by_role('textbox', name='Sources exclues', exact=True)
        newsletter = page.locator('.text-machine-newsletter')
        expected_headings = page.evaluate("""() => {
            const p=app.plugins.plugins['text-machine'];
            return [p.i18n.t('selectedNewsletterHeading',{name:p.newsletters.find(row=>row.id===p.settings.activeNewsletter).name}),
                p.i18n.t('journalFolder'),p.i18n.t('sourceHeading'),p.i18n.t('newsletterSourcesHeading'),p.i18n.t('newsletterPromptsHeading')];
        }""")
        assert newsletter.locator('.setting-item-heading .setting-item-name').all_text_contents() == expected_headings
        assert newsletter.get_by_role('textbox', name='Sources exclues', exact=True).count() == 1
        assert newsletter.get_by_role('textbox', name='Sites bloqués', exact=True).count() == 1
        assert newsletter.get_by_role('textbox', name='Include feeds', exact=True).count() == 1
        assert newsletter.get_by_role('textbox', name='Author feeds', exact=True).count() == 1
        assert_full_width(exclusions)
        exclusions.fill('example.com')
        page.wait_for_function("async () => (await app.plugins.plugins['text-machine'].loadData()).excludedSources === 'example.com'")
        expect(page.get_by_role('button', name='Réinitialiser le JSON', exact=True)).to_have_count(0)
        debug.click()
        page.get_by_role('button', name='Réinitialiser le JSON', exact=True).click()
        page.get_by_role('button', name='Annuler', exact=True).click()
        assert (vault / 'Research/Veille/textmachine.json').read_text() == log
        page.get_by_role('button', name='Réinitialiser le JSON', exact=True).click()
        page.get_by_role('button', name='Vider le fichier', exact=True).click()
        page.get_by_text('JSON réinitialisé. Vous pouvez relancer l’extraction.', exact=True).wait_for()
        assert json.loads((vault / 'Research/Veille/textmachine.json').read_text()) == {'version':1,'articles':[]}
        assert page.get_by_role('textbox', name='Sources exclues', exact=True).input_value() == 'example.com'
        debug.click()
        context_menu()
        page.get_by_text('Messages ajoutés : 0 · Liens : 0 · Messages déjà présents : 3 · Fichier : Research/Veille/textmachine.json.', exact=True).wait_for()
        settings()
        assert json.loads((vault / 'Research/Veille/textmachine.json').read_text())['articles'] == []
        page.get_by_role('textbox', name='Sources exclues', exact=True).fill('Google Alerts')
        context_menu()
        page.get_by_text('Messages ajoutés : 0 · Liens : 0 · Messages déjà présents : 3 · Fichier : Research/Veille/textmachine.json.', exact=True).wait_for()
        settings()
        assert json.loads((vault / 'Research/Veille/textmachine.json').read_text())['articles'] == []
        page.get_by_role('textbox', name='Sources exclues', exact=True).fill('')
        context_menu()
        page.get_by_text('Messages ajoutés : 1 · Liens : 1 · Messages déjà présents : 2 · Fichier : Research/Veille/textmachine.json.', exact=True).wait_for()
        settings()
        log = (vault / 'Research/Veille/textmachine.json').read_text()
        assert len(json.loads(log)['articles']) == 1
        assert page.evaluate(r"""async () => {
            const p = app.plugins.plugins['text-machine'];
            p.client.unreadMessages = async function* () { yield 'read'; yield 'moved'; };
            p.client.message = async id => ({id, labelIds: id === 'read' ? ['Label_1'] : ['UNREAD']});
            await p.importUnread();
            const before = await app.vault.read(app.vault.getAbstractFileByPath('Research/Veille/textmachine.json'));
            p.settings.outputFolder = '../outside';
            try { await p.ensureData(); return false; } catch (error) {
                if (!error.message.includes('Choisissez')) throw error;
            } finally { p.settings.outputFolder = 'Research/Veille'; }
            return before === await app.vault.read(app.vault.getAbstractFileByPath('Research/Veille/textmachine.json'));
        }""")
        assert (vault / 'Research/Veille/textmachine.json').read_text() == log
        page.get_by_role('button', name='Déplacer…', exact=True).click()
        page.locator('.text-machine-folders').get_by_role('button', name='Racine du coffre', exact=True).click()
        page.get_by_role('button', name='Annuler', exact=True).click()
        assert page.evaluate('app.plugins.plugins["text-machine"].settings.outputFolder') == 'Research/Veille'
        page.get_by_role('button', name='Déplacer…', exact=True).click()
        page.locator('.text-machine-folders').get_by_role('button', name='Racine du coffre', exact=True).click()
        page.get_by_role('button', name='Déplacer ici', exact=True).click()
        page.wait_for_function('app.plugins.plugins["text-machine"].settings.outputFolder === "Veille"')
        assert (vault / 'Veille/textmachine.json').read_text() == log
        assert not (vault / 'Research/Veille').exists()
        page.get_by_role('button', name='Déplacer…', exact=True).click()
        page.get_by_role('button', name='Ouvrir le dossier Research', exact=True).click()
        page.get_by_role('button', name='Déplacer ici', exact=True).click()
        page.wait_for_function('app.plugins.plugins["text-machine"].settings.outputFolder === "Research/Veille"')
        assert not (vault / 'textmachine.json').exists()
        assert (vault / 'Research/Veille/textmachine.json').read_text() == log
        assert page.evaluate(r"""async () => {
            const p = app.plugins.plugins['text-machine'];
            try { await p.ensureData('Research'); return false; }
            catch (error) { return error.message.includes('dossier vide'); }
        }""")
        assert page.evaluate("""() => {
            const Menu = window.TestMenu;
            return ['Research', 'Research/Veille/textmachine.json'].every(path => {
                const menu = new Menu();
                app.workspace.trigger('file-menu', menu, app.vault.getAbstractFileByPath(path), 'file-explorer');
                return !menu.items.some(item => item.title === 'Text Machine');
            });
        }""")
        page.evaluate("""() => {
            const p = app.plugins.plugins['text-machine'];
            p.client.unreadMessages = async function* () {
                const error = new Error('Session expirée'); error.code = 'AUTH_REQUIRED'; throw error;
            };
        }""")
        context_menu()
        page.get_by_role('alert').filter(has_text='Session expirée').wait_for()
        page.get_by_role('button', name='Connecter', exact=True).wait_for()
        settings()
        assert page.get_by_role('button', name='Connecter', exact=True).count() == 1
        assert page.get_by_role('button', name='Déconnecter', exact=True).count() == 0
        assert page.get_by_role('button', name='Visualiser le JSON', exact=True).is_disabled()
        context_menu()
        page.get_by_role('button', name='Connecter', exact=True).wait_for()
        page.evaluate("""() => {
            const p = app.plugins.plugins['text-machine'];
            p.connect = async () => {p.authorizationRequired = false;};
            p.client.unreadMessages = async function* () {};
        }""")
        page.get_by_role('button', name='Connecter', exact=True).click()
        page.get_by_role('status').filter(has_text='Messages ajoutés : 0').wait_for()
        settings()
        page.evaluate("() => { app.plugins.plugins['text-machine'].settings.labelId = ''; }")
        context_menu()
        page.get_by_role('combobox', name='Libellé Gmail').select_option('Label_1')
        page.get_by_role('status').filter(has_text='Messages ajoutés : 0').wait_for()
        settings()
        page.evaluate(r"""() => {
            app.plugins.plugins['text-machine'].settings.outputFolder = 'Missing';
            app.setting.openTabById('text-machine');
        }""")
        assert page.get_by_role('button', name='Créer le dossier', exact=True).is_enabled()
        assert page.get_by_role('button', name='Extraire les liens', exact=True).count() == 0
        context_menu('Research')
        page.get_by_role('button', name='Créer le dossier', exact=True).click()
        page.get_by_role('textbox', name='Nom du nouveau dossier', exact=True).fill('CommandData')
        page.get_by_role('button', name='Créer ici', exact=True).click()
        page.get_by_role('status').filter(has_text='Research/CommandData/textmachine.json').wait_for()
        assert json.loads((vault / 'Research/CommandData/textmachine.json').read_text()) == {'version':1,'articles':[]}
        settings()
        page.evaluate("() => { app.plugins.plugins['text-machine'].settings.outputFolder = 'Missing'; }")
        page.evaluate(r"""() => {
            const p = app.plugins.plugins['text-machine'];
            const i18n = p.i18n;
            i18n.setLocale('en-US');
            app.setting.openTabById('text-machine');
        }""")
        page.locator('.setting-item-heading .setting-item-name').filter(has_text='Choose where to store your data').wait_for()
        assert page.get_by_role('textbox', name='Reference sources', exact=True).input_value() == 'theguardian.com\nbbc.co.uk'
        page.locator('.setting-item').filter(has=page.get_by_text('Article writing', exact=True)).get_by_role('button', name='Edit', exact=True).click()
        editor=page.locator('.text-machine-prompt-editor')
        expect(editor.get_by_role('textbox', name='Prompt instructions', exact=True)).to_have_value((plugin / 'prompts/writer.md').read_text())
        assert editor.get_by_role('button', name='Save', exact=True).is_enabled()
        editor.get_by_role('button', name='Cancel', exact=True).click()
        page.get_by_role('button', name='Create folder', exact=True).click()
        page.get_by_role('heading', name='Data folder', exact=True).wait_for()
        assert page.get_by_role('textbox', name='New folder name', exact=True).input_value() == 'TextMachine'
        page.get_by_role('button', name='Cancel', exact=True).click()
        assert page.evaluate(r"""() => {
            const p = app.plugins.plugins['text-machine'];
            const entry = p.articles.messageArticles({id:'english', payload:{headers:[]}, bodies:[]});
            return entry.length === 0;
        }""")
        assert (vault / 'Research/Veille/textmachine.json').read_text() == log
        assert page.evaluate(r"""async () => {
            const p = app.plugins.plugins['text-machine'];
            const file = app.vault.getAbstractFileByPath('Research/Veille/textmachine.json');
            p.settings.outputFolder = 'Research/Veille';
            p.client.unreadMessages = async function* () { yield 'failure'; };
            p.client.message = async () => ({id:'failure',labelIds:['UNREAD','Label_1'],internalDate:'1700000000000',payload:{headers:[]},bodies:[{type:'text/plain',text:'https://example.com/failure'}]});
            let marked = 0;
            p.client.markRead = async () => { marked++; };
            const scope = p.account.scope;
            p.account.scope = 'https://www.googleapis.com/auth/gmail.readonly';
            try { await p.importUnread(); return false; } catch {} finally { p.account.scope = scope; }
            if (marked !== 0) return false;
            const process = app.vault.process;
            app.vault.process = async () => { throw new Error('Disk full'); };
            try { await p.importUnread(); return false; } catch {} finally { app.vault.process = process; }
            if (marked !== 0) return false;
            p.client.markRead = async () => { throw new Error('Google unavailable'); };
            try { await p.importUnread(); return false; } catch {}
            if (!JSON.parse(await app.vault.read(file)).articles.some(a => a.url === 'https://example.com/failure')) return false;
            p.client.markRead = async () => { marked++; };
            await p.importUnread();
            if (marked !== 1 || JSON.parse(await app.vault.read(file)).articles.filter(a => a.url === 'https://example.com/failure').length !== 1) return false;
            await app.vault.modify(file, '{broken');
            p.settings.outputFolder = 'Research/Veille';
            p.client.unreadMessages = async function* () { yield 'bad'; };
            p.client.message = async () => ({id:'bad',labelIds:['UNREAD','Label_1'],payload:{headers:[]},bodies:[]});
            let rejected = false;
            try { await p.importUnread(); } catch { rejected = true; }
            if (!rejected || await app.vault.read(file) !== '{broken') return false;
            await app.vault.createFolder('Legacy');
            await app.vault.create('Legacy/log.md', '# Old journal');
            p.settings.outputFolder = 'Legacy';
            await p.saveData(p.settings);
            await app.plugins.disablePlugin('text-machine');
            await app.plugins.loadPlugin('text-machine');
            return !app.plugins.plugins['text-machine'].dataReady
                && !app.vault.getAbstractFileByPath('Legacy/textmachine.json')
                && await app.vault.read(app.vault.getAbstractFileByPath('Legacy/log.md')) === '# Old journal';
        }""")
        assert page.evaluate("""() => {
            const p = app.plugins.plugins['text-machine'];
            return p.settings.commentedArticles === 12 && p.settings.newsletterLanguage === 'español' && p.settings.referenceSources === ['theguardian.com','bbc.co.uk'].join(String.fromCharCode(10))
                && p.settings.aiModel === '__codex__' && p.settings.codexModel === 'codex-fixture' && p.settings.codexEffort === 'high'
                && p.settings.authorFeeds === ['https://example.substack.com','https://other.example/feed'].join(String.fromCharCode(10))
                && p.settings.includeFeeds === ''
                && p.settings.localAIServer === 'http://localhost:11434' && p.settings.localAIModel === 'local-fixture'
                && p.getAIKey('anthropic') === 'fixture-anthropic-only' && p.getAIKey('openai') === 'fixture-openai-only';
        }""")
        print('AI settings verified: native Obsidian secret picker and persisted references without key values, local server, custom model, Codex discovery and reload, persisted settings after plugin reload.', flush=True)
        print('Folder context menu, expired session, reconnection, missing label and folder creation verified.', flush=True)
        print('French and English settings, folder picker and new journal entries verified; existing notes unchanged.', flush=True)
        print('Journal verified: folder picker, creation, inert HTML, classified links, partial failure recovery, deduplication, preserved notes.', flush=True)
        print('Settings verified: disconnected, connected, saved label, access result, inline error; no tokens persisted.', flush=True)
        page.evaluate('async () => { await app.plugins.disablePlugin("text-machine"); }')
        browser.close()
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    print('Isolated runtime:', temporary, flush=True)
