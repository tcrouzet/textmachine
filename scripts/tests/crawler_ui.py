import json, pathlib, shutil, socket, subprocess, tempfile, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
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
(profile / 'obsidian.json').write_text(json.dumps({'vaults': {'0123456789abcdef': {'path': str(vault), 'ts': int(time.time()*1000), 'open': True}}}))
(vault / '.obsidian/community-plugins.json').write_text('["text-machine"]')
(vault / '.obsidian/core-plugins.json').write_text('[]')
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
requests, blocked_requests = [], []
class FixtureProxy(BaseHTTPRequestHandler):
    def do_GET(self):
        denied = urlsplit(self.path).hostname == '9.9.9.9'
        (blocked_requests if denied else requests).append(self.path)
        content = ('<title>Access denied</title>' if denied else html).encode()
        self.send_response(403 if denied else 200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)
    def log_message(self, *_args):
        pass
proxy = ThreadingHTTPServer(('127.0.0.1', 0), FixtureProxy)
threading.Thread(target=proxy.serve_forever, daemon=True).start()
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
        page.evaluate("""port => {
            const p = app.plugins.plugins['text-machine'];
            const NativeWindow = require('@electron/remote').BrowserWindow;
            class ProxyWindow {
                constructor(options) {
                    const window = new NativeWindow(options);
                    const ready = window.webContents.session.setProxy({proxyRules:'127.0.0.1:'+port});
                    this.webContents = window.webContents;
                    this.loadURL = async (...args) => {await ready;return window.loadURL(...args);};
                    this.isDestroyed = () => window.isDestroyed();
                    this.destroy = () => window.destroy();
                }
            }
            p.loadPage = (url,signal,blocked) => p.browser.loadPage(url,signal,blocked,ProxyWindow);
        }""", proxy.server_port)

        page.evaluate("() => { const p = app.plugins.plugins['text-machine']; p.codex = {...p.codex, findCodex:async () => null}; }")
        html = """<!doctype html><html><head><title>Rendered article</title><meta property="article:published_time" content="2026-11-02T08:00:00Z"><meta property="og:image" content="/cover.jpg"></head><body><main id="article"></main>
        <script>setTimeout(() => {
            document.getElementById('article').innerHTML = '<h1>Rendered article</h1><p>' + 'This article was rendered by JavaScript. '.repeat(20) + '</p>';
            document.body.dataset.node = typeof require;
        }, 100);</script></body></html>"""
        initial_windows = page.evaluate("require('@electron/remote').BrowserWindow.getAllWindows().length")
        result = page.evaluate("""async () => {
            const p = app.plugins.plugins['text-machine'];
            return await p.loadPage('http://8.8.8.8/article', new AbortController().signal, () => false);
        }""")
        assert result['status'] == 200, result
        assert 'data-node="undefined"' in result['html'], result
        assert '<h1>Rendered article</h1>' in result['html'], result
        assert requests == ['http://8.8.8.8/article'], requests
        assert page.evaluate("require('@electron/remote').BrowserWindow.getAllWindows().length") == initial_windows
        extracted = page.evaluate("""html => app.plugins.plugins['text-machine'].crawler.extractPage(html, 'http://8.8.8.8/article')""", result['html'])
        assert 'This article was rendered by JavaScript.' in extracted['content'], extracted
        assert 'setTimeout' not in extracted['content'], extracted
        assert extracted['publish'] == '2026-11-02T08:00:00Z', extracted
        assert extracted['image'] == 'http://8.8.8.8/cover.jpg', extracted
        assert page.evaluate("""() => {
            const crawler = app.plugins.plugins['text-machine'].crawler;
            return crawler.extractPage('<title>Just a moment...</title><main>Checking your browser</main>', 'https://example.com/article').blocked;
        }""")
        assert page.evaluate("""() => {
            const crawler = app.plugins.plugins['text-machine'].crawler;
            return crawler.extractPage('<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script><article>Subscriber preview</article>', 'https://example.com/article').blocked;
        }""")
        inert_requests = []
        page.on('request', lambda request: inert_requests.append(request.url) if 'tracker.invalid' in request.url else None)
        structured = page.evaluate("""() => {
            const crawler = app.plugins.plugins['text-machine'].crawler;
            return crawler.extractPage('<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","datePublished":"2026-11-01","image":{"url":"/photo.jpg"}}]}</script>'
                + '<nav>UNWANTED NAVIGATION</nav><article><h1>Useful content</h1><p>' + 'An article about books and science, with meaningful text. '.repeat(30)
                + '</p><img src="https://tracker.invalid/pixel"><script>window.articleScriptRan = true</script></article>', 'https://example.com/story');
        }""")
        assert structured['publish'] == '2026-11-01', structured
        assert structured['image'] == 'https://example.com/photo.jpg', structured
        assert 'UNWANTED NAVIGATION' not in structured['content'], structured
        assert not page.evaluate('!!window.articleScriptRan')
        assert not inert_requests, inert_requests
        for metadata, expected in [
            ('<time datetime="2026-10-12T12:00:00Z"></time>', '2026-10-12T12:00:00Z'),
            ('<meta name="parsely-pub-date" content="2026-09-04">', '2026-09-04'),
            ('<article><span class="published-date">Publié le 3 novembre 2026</span></article>', '2026-11-03'),
            ('<meta name="date" content="invalid"><time datetime="2026-08-04"></time>', '2026-08-04'),
            ('<script type="application/ld+json">{"@type":"https://schema.org/AnalysisNewsArticle","datePublished":"2026-07-01"}</script>', '2026-07-01'),
            ('<meta property="article:modified_time" content="2026-11-01"><time itemprop="dateModified" datetime="2026-11-01"></time>', ''),
        ]:
            dated = page.evaluate("""metadata => app.plugins.plugins['text-machine'].crawler.extractPage(metadata
                + '<article><p>' + 'A meaningful article about publishing books and reading. '.repeat(30) + '</p></article>', 'https://example.com/dated')""", metadata)
            assert dated['publish'] == expected, (metadata, dated)
        denied = page.evaluate("""async () => app.plugins.plugins['text-machine'].loadPage('http://127.0.0.1/article', new AbortController().signal, () => false)""")
        assert denied['status'] == 404
        imported = page.evaluate("""async () => {
            const p = app.plugins.plugins['text-machine'];
            p.settings.outputFolder = 'Data';
            p.settings.labelId = 'Label_1';
            await p.ensureData('Data');
            p.account = {email:'reader@example.com', scope:p.gmail.SCOPE};
            p.client = {
                unreadMessages:async function* () {yield 'message-1';},
                message:async () => ({id:'message-1', internalDate:'1700000000000', labelIds:['UNREAD','Label_1'],payload:{headers:[]},
                    bodies:[{type:'text/plain',text:'http://8.8.8.8/article http://9.9.9.9/denied http://9.9.9.9/another'}]}),
                markRead:async id => {
                    const data = JSON.parse(await app.vault.read(app.vault.getAbstractFileByPath(p.dataPath)));
                    if (data.articles.length !== 3) throw new Error('Messages must be saved before marking read');
                    if (data.articles.some(article => article.content)) throw new Error('Mark read must precede crawling');
                    window.markedMessage = id;
                },
            };
            await p.importUnread();
            return JSON.parse(await app.vault.read(app.vault.getAbstractFileByPath(p.dataPath)));
        }""")
        assert page.evaluate('window.markedMessage') == 'message-1'
        assert len(imported['articles']) == 3, imported
        assert imported['articles'][0]['content'] and imported['articles'][0]['status'] == '', imported
        assert all(article['status'] == '404' for article in imported['articles'][1:]), imported
        assert all('used' not in article for article in imported['articles']), imported
        assert blocked_requests == ['http://9.9.9.9/denied'], blocked_requests
        saved_blocks = json.loads((vault / 'Data/blocked.json').read_text())
        assert saved_blocks == ['9.9.9.9'], saved_blocks
        before_requests = list(requests), list(blocked_requests)
        page.evaluate("""async () => {
            const p = app.plugins.plugins['text-machine'];
            p.client.unreadMessages = async function* () {};
            await p.importUnread();
        }""")
        assert (requests, blocked_requests) == before_requests
        page.evaluate("""async () => {
            const p = app.plugins.plugins['text-machine'];
            await app.vault.process(app.vault.getAbstractFileByPath(p.dataPath), text => {
                const data = JSON.parse(text);
                data.articles[0].publish = '';
                data.articles[0].content = 'My existing article text';
                return JSON.stringify(data);
            });
            await p.importUnread();
        }""")
        retried = json.loads((vault / 'Data/textmachine.json').read_text())['articles'][0]
        assert retried['publish'] == '2026-11-02T08:00:00Z', retried
        assert retried['content'] == 'My existing article text', retried
        assert len(requests) == len(before_requests[0]) + 1
        assert blocked_requests == before_requests[1]

        print('Import persisted articles before marking mail read, crawled content, stored 404 and skipped blocked hosts on repeated runs.', flush=True)
        print('Readability extracted rendered article text, date and image; detected challenge and paywall; inert parsing verified.', flush=True)
        print('Chromium rendered JavaScript, denied Node access and local URLs, and closed the article window.', flush=True)
        browser.close()
finally:
    proxy.shutdown()
    proxy.server_close()
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    print('Isolated runtime:', temporary, flush=True)
