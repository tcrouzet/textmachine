"""Compare the plugin on current blocked domains without changing vault data."""
import json, pathlib, shutil, socket, subprocess, sys, tempfile, time
from datetime import datetime, timezone
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parents[2]
phase = sys.argv[1]
if phase not in ('baseline', 'improved'):
    raise ValueError('Expected baseline or improved')
settings = json.loads((root / 'data.json').read_text())
source = root.parents[2] / settings['outputFolder']
blocked = json.loads((source / 'blocked.json').read_text())
articles = json.loads((source / 'textmachine.json').read_text())['articles']
targets = []
for domain in blocked:
    if sys.argv[2:] and domain not in sys.argv[2:]:
        continue
    for article in articles:
        host = (urlsplit(article['url']).hostname or '').lower()
        if article.get('status') == 'forbidden' and (host == domain or host.endswith('.' + domain)):
            targets.append({'domain': domain, 'id': article['id'], 'url': article['url']})
            break
report_path = root / 'doc' / ('crawler-' + phase + '-2026-11-04.json')
report = json.loads(report_path.read_text()) if report_path.exists() else {'phase': phase, 'results': []}
report['testedAt'] = datetime.now(timezone.utc).isoformat()
report_path.parent.mkdir(exist_ok=True)
temporary = pathlib.Path(tempfile.mkdtemp(prefix='textmachine-crawler-live-'))
profile, vault = temporary / 'profile', temporary / 'vault'
plugin = vault / '.obsidian/plugins/text-machine'
profile.mkdir()
plugin.mkdir(parents=True)
for name in ('main.js', 'manifest.json', 'styles.css'):
    shutil.copy2(root / name, plugin / name)
(profile / 'obsidian.json').write_text(json.dumps({'vaults': {'0123456789abcdef': {'path': str(vault), 'ts': int(time.time()*1000), 'open': True}}}))
(vault / '.obsidian/community-plugins.json').write_text('["text-machine"]')
(vault / '.obsidian/core-plugins.json').write_text('[]')
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
process = subprocess.Popen(['/Applications/Obsidian.app/Contents/MacOS/Obsidian', f'--user-data-dir={profile}', f'--remote-debugging-port={port}', '--no-first-run'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    with sync_playwright() as playwright:
        deadline = time.monotonic() + 25
        while True:
            try:
                browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}', timeout=1000)
                break
            except Exception:
                if process.poll() is not None or time.monotonic() > deadline:
                    raise
                time.sleep(.2)
        page = browser.contexts[0].pages[0]
        page.wait_for_function('typeof app !== "undefined" && app.vault && app.workspace && app.workspace.layoutReady', timeout=25000)
        page.evaluate('async () => { await app.plugins.setEnable(true); await app.plugins.loadManifests(); if (!app.plugins.plugins["text-machine"]) await app.plugins.loadPlugin("text-machine"); }')

        def record(result):
            html = result.pop('html', '')
            content = result.pop('content', '')
            if html:
                (temporary / (str(result['id']) + '.html')).write_text(html)
            if content:
                (temporary / (str(result['id']) + '.txt')).write_text(content)
            report['results'] = [entry for entry in report['results'] if entry['id'] != result['id']] + [result]
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(result, ensure_ascii=False), flush=True)

        page.expose_function('recordProbe', record)
        page.evaluate("""async targets => {
            const plugin=app.plugins.plugins['text-machine'];
            const NativeWindow=require('@electron/remote').BrowserWindow;
            const failures=new Map();
            class ObservedWindow {
                constructor(options) {
                    const win=new NativeWindow(options);
                    this.webContents=win.webContents;
                    this.isDestroyed=()=>win.isDestroyed();
                    this.destroy=()=>win.destroy();
                    this.loadURL=async(...args)=>{
                        try {await win.loadURL(...args);}
                        catch(error) {failures.set(args[0],String(error.message).slice(0,250));throw error;}
                    };
                }
            }
            const queue=[...targets];
            await Promise.all(Array.from({length:3},async()=>{
                while(queue.length) {
                    const target=queue.shift(),start=Date.now();
                    let result={...target};
                    try {
                        const load=plugin.browser.retrievePage || plugin.browser.loadPage;
                        const page=await load(target.url,new AbortController().signal,()=>false,ObservedWindow);
                        const pdf=plugin.articles.isPdf(page.url,page.contentType) || page.status===415;
                        const article=!pdf && page.status>=200 && page.status<300 && page.html ? plugin.crawler.extractPage(page.html,page.url) : {};
                        result={...result,status:page.status,finalUrl:page.url,html:page.html,htmlLength:page.html.length,
                            title:page.html ? new DOMParser().parseFromString(page.html,'text/html').title.slice(0,120) : '',
                            content:article.content || '',contentLength:article.content?.length || 0,publish:article.publish || '',
                            outcome:pdf ? 'pdf' : article.content ? 'readable' : article.blocked ? 'restricted' : 'failed',
                            networkError:failures.get(target.url) || ''};
                    } catch(error) {result.error=String(error.message).slice(0,250);result.outcome='error';}
                    result.elapsedMs=Date.now()-start;
                    await window.recordProbe(result);
                }
            }));
        }""", targets)
        browser.close()
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    print('Saved diagnostic HTML:', temporary, flush=True)
    print('Report:', report_path, flush=True)
