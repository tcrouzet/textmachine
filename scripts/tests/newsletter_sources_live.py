"""Retest every article linked in one edition without changing vault data."""
import hashlib
import json
import pathlib
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parents[2]
date = sys.argv[1] if len(sys.argv) > 1 else datetime.now().date().isoformat()
datetime.strptime(date, '%Y-%m-%d')
settings = json.loads((root / 'data.json').read_text())
settings = settings.get('settings', settings)
profile = next((p for p in settings.get('newsletters', []) if p['id'] == settings.get('activeNewsletter')), {})
folder = root.parents[2] / profile.get('outputFolder', settings['outputFolder'])
note = folder / ('text-machine-' + date + '.md')
database = folder / 'textmachine.json'
originals = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in (note, database)}
urls = list(dict.fromkeys(url for url in re.findall(r'\]\((https?://[^\s)]+)\)', note.read_text())
                         if urlsplit(url).path not in ('', '/')))
if not urls:
    raise ValueError('No article links in ' + note.name)
report = {'date': date, 'note': note.name, 'startedAt': datetime.now(timezone.utc).isoformat(),
          'total': len(urls), 'results': []}
report_path = root / 'doc' / ('source-check-' + date + '-' + datetime.now(timezone.utc).strftime('%H%M%S') + '.json')
report_path.parent.mkdir(exist_ok=True)
report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print('REPORT ' + str(report_path), flush=True)


def record(result):
    for entry in [result, *result.get('attempts', [])]:
        if entry.get('finalUrl'):
            entry['finalUrl'] = urlsplit(entry['finalUrl'])._replace(query='', fragment='').geturl()
    report['results'].append(result)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'done': len(report['results']), **result}, ensure_ascii=False), flush=True)


def stop(_signum, _frame):
    raise SystemExit(143)


signal.signal(signal.SIGTERM, stop)
with tempfile.TemporaryDirectory(prefix='textmachine-source-check-') as temporary:
    temporary = pathlib.Path(temporary)
    runtime_profile, vault = temporary / 'profile', temporary / 'vault'
    plugin = vault / '.obsidian/plugins/text-machine'
    runtime_profile.mkdir()
    plugin.mkdir(parents=True)
    for name in ('main.js', 'manifest.json', 'styles.css'):
        shutil.copy2(root / name, plugin / name)
    (runtime_profile / 'obsidian.json').write_text(json.dumps({'vaults': {'0123456789abcdef': {
        'path': str(vault), 'ts': int(time.time() * 1000), 'open': True}}}))
    (vault / '.obsidian/community-plugins.json').write_text('["text-machine"]')
    (vault / '.obsidian/core-plugins.json').write_text('[]')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    process = subprocess.Popen(['/Applications/Obsidian.app/Contents/MacOS/Obsidian',
                                f'--user-data-dir={runtime_profile}', f'--remote-debugging-port={port}', '--no-first-run'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        with sync_playwright() as playwright:
            deadline = time.monotonic() + 30
            while True:
                try:
                    browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}', timeout=1000)
                    break
                except Exception:
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise
                    time.sleep(.2)
            page = browser.contexts[0].pages[0]
            page.wait_for_function('typeof app !== "undefined" && app.vault && app.workspace && app.workspace.layoutReady', timeout=30000)
            page.evaluate('''async () => {
                await app.plugins.setEnable(true);
                await app.plugins.loadManifests();
                if (!app.plugins.plugins['text-machine']) await app.plugins.loadPlugin('text-machine');
                if (!app.plugins.plugins['text-machine']) throw new Error('Plugin did not load');
            }''')
            page.expose_function('recordProbe', record)
            page.evaluate('''async urls => {
                const plugin=app.plugins.plugins['text-machine'];
                const NativeWindow=require('@electron/remote').BrowserWindow;
                const queue=[...urls];
                await Promise.all(Array.from({length:3},async()=>{
                    while(queue.length) {
                        const url=queue.shift(),start=Date.now(),attempts=[];
                        let result={url};
                        try {
                            const page=await plugin.browser.retrievePage(url,undefined,()=>false,NativeWindow,plugin.browser.fetchPage,
                                (method,page,elapsedMs)=>{
                                    const extracted=!page.failure && page.status>=200 && page.status<300 && page.html
                                        ? plugin.crawler.extractPage(page.html,page.url) : {};
                                    attempts.push({method,httpStatus:page.failure || page.status===415 ? null : page.status,
                                        failure:page.failure || '',finalUrl:page.url,contentLength:extracted.content?.length || 0,elapsedMs});
                                });
                            const pdf=plugin.articles.isPdf(page.url,page.contentType) || page.status===415;
                            const extracted=!pdf && !page.failure && page.status>=200 && page.status<300 && page.html
                                ? plugin.crawler.extractPage(page.html,page.url) : {};
                            result={...result,attempts,httpStatus:page.failure || pdf ? null : page.status,finalUrl:page.url,
                                outcome:pdf ? 'pdf' : page.failure ? 'network-error' : page.status===404 ? 'missing'
                                    : extracted.content ? 'readable' : extracted.blocked || [401,402,403,451].includes(page.status)
                                        ? 'restricted' : 'unreadable',
                                failure:page.failure || '',contentLength:extracted.content?.length || 0};
                        } catch(error) {result={...result,attempts,outcome:'error',error:String(error.message).slice(0,250)};}
                        await window.recordProbe({...result,elapsedMs:Date.now()-start});
                    }
                }));
            }''', urls)
            browser.close()
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        report['unchanged'] = all(hashlib.sha256(path.read_bytes()).hexdigest() == digest for path, digest in originals.items())
        report['counts'] = dict(Counter(result['outcome'] for result in report['results']))
        report['complete'] = len(report['results']) == len(urls)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({key: report[key] for key in ('complete', 'counts', 'unchanged')}, ensure_ascii=False), flush=True)
        print('REPORT ' + str(report_path), flush=True)
