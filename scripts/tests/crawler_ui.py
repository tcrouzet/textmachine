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
        path = urlsplit(self.path).path
        if path == '/redirect-pdf':
            self.send_response(302)
            self.send_header('Location', 'http://8.8.8.8/report.pdf')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        pdf = path in ['/by-mime', '/by-filename', '/hidden-pdf']
        content = b'%PDF-1.7\n%%EOF' if pdf else ('<title>Access denied</title>' if denied else html).encode()
        self.send_response(403 if denied else 200)
        self.send_header('Content-Type', 'application/octet-stream' if path == '/by-filename' else 'application/pdf' if pdf else 'text/html; charset=utf-8')
        if path == '/by-filename': self.send_header('Content-Disposition', "inline; filename*=UTF-8''report.pdf")
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
            p.loadPage = (url,signal,blocked) => p.browser.retrievePage(url,signal,blocked,ProxyWindow,
                async url => ({url,status:403,html:''}));
        }""", proxy.server_port)

        page.evaluate("() => { const p = app.plugins.plugins['text-machine']; p.codex = {...p.codex, findCodex:async () => null}; }")

        feed_checks = subprocess.check_output(['node', '-e', "process.stdout.write(require('esbuild').buildSync({entryPoints:['scripts/tests/feed-browser.js'],bundle:true,platform:'node',format:'iife',globalName:'feedChecks',write:false,loader:{'.dat':'text'}}).outputFiles[0].text)"], cwd=root, text=True)
        page.add_script_tag(content=feed_checks)
        assert page.evaluate('feedChecks.runFeedChecks().passed') == 16
        print('RSS browser checks: 16 passed.', flush=True)

        html = """<!doctype html><html><head><title>Rendered article</title><meta property="article:published_time" content="2026-11-02T08:00:00Z"><meta property="og:image" content="/cover.jpg"></head><body><main id="article"></main>
        <script>setTimeout(() => {
            document.getElementById('article').innerHTML = '<h1>Rendered article</h1><p>' + 'This article was rendered by JavaScript. '.repeat(20) + '</p>';
            document.body.dataset.node = typeof require;
        }, 100);</script></body></html>"""
        initial_windows = page.evaluate("require('@electron/remote').BrowserWindow.getAllWindows().length")
        direct = page.evaluate("""async () => {
            const p=app.plugins.plugins['text-machine'];
            class NoWindow {constructor(){throw new Error('Static articles must not open Chromium');}}
            const html='<article><h1>A public article</h1><p>'+'Useful writing about science and books. '.repeat(30)+'</p></article>';
            return p.browser.retrievePage('https://example.com/static',undefined,()=>false,NoWindow,
                async url=>({url,status:200,html}));
        }""")
        assert 'A public article' in direct['html'], direct
        assert requests == [] and blocked_requests == []
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
        captions = page.evaluate("""() => {
            const c = app.plugins.plugins['text-machine'].crawler;
            const html = '<figure><img src="/other.jpg"><figcaption>Wrong image.</figcaption></figure>'
                + '<figure><img src="/portrait.jpg?w=640"><figcaption>A writer at work. <span class="credit">Photo: Jane Example / Agency.</span></figcaption></figure>';
            return {
                original:c.extractImageCaption(html,'https://example.com/article','https://example.com/portrait.jpg?w=1200'),
                absent:c.extractImageCaption(html,'https://example.com/article','https://example.com/missing.jpg'),
                alt:c.extractImageCaption('<img src="/portrait.jpg" alt="Not an original caption">','https://example.com/article','https://example.com/portrait.jpg'),
                unrelated:c.extractImageCaption('<div><img src="/portrait.jpg"><figure><img src="/other.jpg"><figcaption>Unrelated caption.</figcaption></figure></div>','https://example.com/article','https://example.com/portrait.jpg'),
                structured:c.extractImageCaption('<script type="application/ld+json">{"image":{"@type":"ImageObject","url":"/portrait.jpg","caption":"A writer at work.","creditText":"Photo: Jane Example / Agency."}}</script>','https://example.com/article','https://example.com/portrait.jpg'),
            };
        }""")
        assert captions['original'] == 'A writer at work. Photo: Jane Example / Agency.'
        assert captions['structured'] == captions['original']
        assert captions['absent'] == '' and captions['alt'] == ''
        assert captions['unrelated'] == ''
        print('Original image captions and credits verified: matching image only, resized URLs, JSON-LD and no invented caption from alt text.', flush=True)
        feeds = page.evaluate("""() => {
            const p=app.plugins.plugins['text-machine'];
            const xml='<rss><channel>'+Array.from({length:6},(_,i)=>'<item><title>Story '+i+'</title><link>/story-'+i+'</link><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;An RSS summary.&lt;/p&gt;</description></item>').join('')+'</channel></rss>';
            const entries=p.newsletter.readFeed(xml,Infinity,'https://publisher.example/rss');
            const atom=p.newsletter.readFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">An &lt;b&gt;Atom&lt;/b&gt; story</title><link rel="self" href="/api/entry"/><link rel="alternate" href="/real-story"/><published>2026-11-03T11:00:00Z</published><content type="html">&lt;p&gt;An Atom summary.&lt;/p&gt;</content></entry></feed>',Infinity,'https://publisher.example/atom');
            return {entries,author:p.newsletter.readFeed(xml),records:p.articles.feedArticles(entries,'https://publisher.example/rss','2026-11-03'),atom};
        }""")
        assert len(feeds['entries']) == 6 and len(feeds['author']) == 5
        assert feeds['entries'][0]['url'] == 'https://publisher.example/story-0'
        assert feeds['entries'][0]['publish'] == '2026-11-03T10:00:00.000Z'
        assert feeds['entries'][0]['content'] == 'An RSS summary.'
        assert all(article['content'] == '' for article in feeds['records'])
        assert feeds['atom'][0]['title'] == 'An Atom story'
        assert feeds['atom'][0]['url'] == 'https://publisher.example/real-story'
        assert feeds['atom'][0]['content'] == 'An Atom summary.'
        print('RSS and Atom verified: all include entries, five author entries, relative article URLs, publication dates, inert text and summaries excluded from verified content.', flush=True)
        assert page.evaluate("""() => {
            const crawler = app.plugins.plugins['text-machine'].crawler;
            return crawler.extractPage('<title>Just a moment...</title><main>Checking your browser</main>', 'https://example.com/article').blocked;
        }""")
        assert page.evaluate("""() => {
            const crawler = app.plugins.plugins['text-machine'].crawler;
            return crawler.extractPage('<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script><article>Subscriber preview</article>', 'https://example.com/article').blocked;
        }""")
        access = page.evaluate("""() => {
            const c=app.plugins.plugins['text-machine'].crawler;
            const metadata='<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false,"hasPart":{"cssSelector":".subscriber-body"}}</script>';
            const text='<p>'+'An investigation into publishing and science, with independently verified sources. '.repeat(30)+'</p>';
            const extract=body=>c.extractPage(metadata+'<article>'+body+'</article>','https://example.com/metered');
            return {full:extract('<div class="subscriber-body">'+text+text+'</div>'),
                empty:extract(text+'<div class="subscriber-body"></div>'),
                preview:extract('<p>'+'This is a subscriber preview. '.repeat(12)+'</p><p>'+'The rest of the story is unavailable. '.repeat(8)+'</p>'),
                truncated:extract(text+'<p>You have 66.84% of this article left to read. The rest is for subscribers only.</p>'),
                french:extract(text+'<p>Cet article est réservé aux abonnés.</p>')};
        }""")
        assert len(access['full']['content']) > 3000, access['full']
        assert all(access[key].get('blocked') and not access[key].get('content') for key in ('empty','preview','truncated','french')), access
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
            ('<script type="application/ld+json">{"@type":"NewsArticle","author":[{"@type":"Person","name":"Jane Doe"},{"@type":"Person","name":"Jean Dupont"}]}</script>', ['Jane Doe','Jean Dupont']),
            ('<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","author":{"@id":"#writer"}},{"@type":"Person","@id":"#writer","name":"Jane Doe"}]}</script>', ['Jane Doe']),
            ('<meta name="author" content="Jane Doe"><meta name="citation_author" content="Jean Dupont"><meta name="author" content="Jane Doe"><meta property="article:author" content="https://example.com/authors/jane">', ['Jane Doe','Jean Dupont']),
            ('<a rel="author">Par Jane Doe</a><blockquote><span class="author-name">Interview subject</span></blockquote><footer><span class="author-name">Footer editor</span></footer>', ['Jane Doe']),
            ('<span itemprop="author"><span itemprop="name">Jane Doe</span></span>', ['Jane Doe']),
            ('<meta property="article:author" content="https://example.com/profile">', []),
        ]:
            authored = page.evaluate("""metadata => app.plugins.plugins['text-machine'].crawler.extractPage(metadata
                + '<article><p>' + 'A meaningful article about publishing books and reading. '.repeat(30) + '</p></article>', 'https://example.com/authored')""", metadata)
            assert authored['authors'] == expected, (metadata, authored)
        print('Article authors verified: JSON-LD people and references, multiple metadata names, visible signatures, no profile URLs or quoted speakers.', flush=True)
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
        before_pdf = list(requests)
        direct_pdf = page.evaluate("""async () => app.plugins.plugins['text-machine'].loadPage('http://8.8.8.8/report.pdf', new AbortController().signal, () => false)""")
        assert direct_pdf['contentType'] == 'application/pdf'
        assert requests == before_pdf
        for route in ['by-mime','by-filename','redirect-pdf']:
            excluded = page.evaluate("""async route => {
                const p = app.plugins.plugins['text-machine'];
                const blocked = [];
                const result = await p.crawler.crawl({url:'http://8.8.8.8/'+route,content:''},blocked,new AbortController().signal,p.loadPage);
                return {result,blocked,windows:require('@electron/remote').BrowserWindow.getAllWindows().length};
            }""", route)
            assert excluded['result']['status'] == 'forbidden', (route, excluded)
            assert excluded['blocked'] == [], (route, excluded)
            assert excluded['windows'] == initial_windows, (route, excluded)
        assert 'http://8.8.8.8/report.pdf' not in requests
        imported = page.evaluate("""async () => {
            const p = app.plugins.plugins['text-machine'];
            p.settings.outputFolder = 'Data';
            p.settings.labelId = 'Label_1';
            await p.ensureData('Data');
            p.account = {email:'reader@example.com', scope:p.gmail.SCOPE};
            p.client = {
                unreadMessages:async function* () {yield 'message-1';},
                message:async () => ({id:'message-1', internalDate:'1700000000000', labelIds:['UNREAD','Label_1'],payload:{headers:[]},
                    bodies:[{type:'text/plain',text:'http://8.8.8.8/article http://9.9.9.9/denied http://9.9.9.9/another http://8.8.8.8/report.pdf http://8.8.8.8/hidden-pdf'}]}),
                markRead:async id => {
                    const data = JSON.parse(await app.vault.read(app.vault.getAbstractFileByPath(p.dataPath)));
                    if (data.articles.length !== 5) throw new Error('Messages must be saved before marking read');
                    if (data.articles.some(article => article.content)) throw new Error('Mark read must precede crawling');
                    window.markedMessage = id;
                },
            };
            await p.importUnread();
            return JSON.parse(await app.vault.read(app.vault.getAbstractFileByPath(p.dataPath)));
        }""")
        assert page.evaluate('window.markedMessage') == 'message-1'
        assert len(imported['articles']) == 5, imported
        assert imported['articles'][0]['content'] and imported['articles'][0]['status'] == '', imported
        assert all(article['status']=='forbidden' for article in imported['articles'][1:]), imported
        assert all('used' not in article and article['usedAt'] == '' for article in imported['articles']), imported
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
        assert retried['publish'] == '', retried
        assert retried['content'] == 'My existing article text', retried
        assert requests == before_requests[0]
        assert blocked_requests == before_requests[1]

        print('Import persisted articles before marking mail read, crawled content, retained inaccessible articles as forbidden and skipped blocked hosts on repeated runs.', flush=True)
        print('PDF exclusion verified: URL, MIME, download filename and redirection; PDF metadata retained as forbidden, no PDF domain blocked and no browser window leaked.', flush=True)
        print('Readability extracted rendered article text, date and image; detected challenge and paywall; inert parsing verified.', flush=True)
        print('Chromium rendered JavaScript, denied Node access and local URLs, and closed the article window.', flush=True)
        print('HTTP-first retrieval avoided Chromium for public static content; refused empty subscriber sections, short previews and explicit truncation notices.', flush=True)
        browser.close()
finally:
    proxy.shutdown()
    proxy.server_close()
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    print('Isolated runtime:', temporary, flush=True)
