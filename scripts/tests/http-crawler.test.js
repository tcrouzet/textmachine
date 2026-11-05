const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {fetchPage,retrievePage,failureCode} = require('../../plugin/browser');
require('../../plugin/i18n').setLocale('en');

async function fixture(t,handler) {
    const server=http.createServer(handler);
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    const seen=[];
    const transport=(url,options,callback)=>{
        seen.push({url:url.href,hostname:options.hostname,headers:options.headers});
        return http.request({host:'127.0.0.1',port:server.address().port,path:url.pathname+url.search,
            method:options.method,headers:options.headers,signal:options.signal},callback);
    };
    return {transport,seen};
}

test('HTTP article retrieval pins validated addresses, follows safe redirects and decodes the publisher charset',async t=>{
    const {transport,seen}=await fixture(t,(request,response)=>{
        assert.equal(request.headers.cookie,undefined);
        assert.ok(request.headers['user-agent'].includes('Chrome/'));
        assert.ok(request.headers['accept-language'].includes('fr'));
        if (request.url==='/start') {response.writeHead(302,{Location:'http://9.9.9.9/article'}).end();return;}
        response.writeHead(200,{'Content-Type':'text/html; charset=windows-1252'}).end(Buffer.from('<article>\xc9criture</article>','latin1'));
    });
    const page=await fetchPage('http://8.8.8.8/start',undefined,()=>false,transport);
    assert.equal(page.status,200);
    assert.equal(page.url,'http://9.9.9.9/article');
    assert.equal(page.html,'<article>Écriture</article>');
    assert.deepEqual(seen.map(entry=>entry.hostname),['8.8.8.8','9.9.9.9']);
    assert.deepEqual(seen.map(entry=>entry.headers.Host),['8.8.8.8','9.9.9.9']);
});

test('HTTP redirects cannot reach local, credentialed or blocked URLs, and redirect loops stop',async t=>{
    let redirect='http://127.0.0.1/private';
    const {transport,seen}=await fixture(t,(_request,response)=>response.writeHead(302,{Location:redirect}).end());
    for (const target of ['http://127.0.0.1/private','http://169.254.169.254/metadata','file:///tmp/article','https://reader:fixture@9.9.9.9/article','http://9.9.9.9/blocked','http://8.8.8.8/start']) {
        redirect=target;
        const before=seen.length;
        const page=await fetchPage('http://8.8.8.8/start',undefined,url=>url==='http://9.9.9.9/blocked',transport);
        assert.equal(page.status,404);
        assert.equal(page.html,'');
        assert.equal(seen.length-before,1,target);
    }
    const before=seen.length;
    for (const target of ['http://127.0.0.1/','http://[::1]/','https://reader:fixture@8.8.8.8/']) {
        assert.equal((await fetchPage(target,undefined,()=>false,transport)).html,'');
    }
    assert.equal(seen.length,before);
});

test('PDF headers and oversized responses never become article HTML',async t=>{
    const {transport,seen}=await fixture(t,(request,response)=>{
        if (request.url==='/mime') response.writeHead(200,{'Content-Type':'application/pdf'}).end('%PDF-1.7');
        else if (request.url==='/download') response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="article.pdf"'}).end('%PDF-1.7');
        else response.writeHead(200,{'Content-Type':'text/html'}).end(Buffer.alloc(10000001,65));
    });
    for (const path of ['/mime','/download']) {
        const result=await fetchPage('http://8.8.8.8'+path,undefined,()=>false,transport);
        assert.equal(result.status,415);
        assert.equal(result.html,'');
    }
    assert.equal((await fetchPage('http://8.8.8.8/large',undefined,()=>false,transport)).html,'');
    const before=seen.length;
    await fetchPage('http://8.8.8.8/article.pdf',undefined,()=>false,transport);
    assert.equal(seen.length,before);
});

test('HTTP cancellation closes a pending request and propagates cancellation',async t=>{
    let received;
    const started=new Promise(resolve=>{received=resolve;});
    const {transport}=await fixture(t,()=>received());
    const controller=new AbortController();
    const request=fetchPage('http://8.8.8.8/article',controller.signal,()=>false,transport);
    await started;
    controller.abort();
    await assert.rejects(request,/disabled/);
});

test('blocked URLs and PDF results do not open a browser window',async()=>{
    class NoWindow {constructor(){assert.fail('A browser must not open');}}
    let requests=0;
    const pdf=async url=>{requests++;return {url,status:415,html:'',contentType:'application/pdf'};};
    await retrievePage('http://8.8.8.8/blocked',undefined,()=>true,NoWindow,pdf);
    assert.equal((await retrievePage('http://8.8.8.8/article.pdf',undefined,()=>false,NoWindow,pdf)).contentType,'application/pdf');
    assert.equal(requests,0);
    assert.equal((await retrievePage('http://8.8.8.8/article',undefined,()=>false,NoWindow,pdf)).status,415);
    assert.equal(requests,1);
});

test('network failures retain safe diagnostic codes instead of being reported as HTTP 404',async t=>{
    const {transport}=await fixture(t,(request,response)=>{
        if (request.url==='/missing') response.writeHead(404).end();
        else if (request.url==='/loop') response.writeHead(302,{Location:'http://8.8.8.8/loop'}).end();
        else request.socket.destroy();
    });
    const missing=await fetchPage('http://8.8.8.8/missing',undefined,()=>false,transport);
    assert.equal(missing.status,404);
    assert.equal(missing.failure,undefined);
    assert.equal((await fetchPage('http://8.8.8.8/reset',undefined,()=>false,transport)).failure,'ECONNRESET');
    assert.equal((await fetchPage('http://8.8.8.8/loop',undefined,()=>false,transport)).failure,'redirect-loop');
    assert.equal(failureCode(new Error('ERR_NAME_NOT_RESOLVED loading https://example.com/?token=secret')),'ERR_NAME_NOT_RESOLVED');
    assert.equal(failureCode(new Error('Private message with secret')),'request-error');
});

test('diagnostic observers see HTTP and browser attempts from the normal retrieval pipeline',async()=>{
    const attempts=[];
    let destroyed=false,navigate;
    class Window {
        constructor(){
            this.webContents={
                session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){},webRequest:{onHeadersReceived(){},onBeforeRequest(){}}},
                setWindowOpenHandler(){},on:(_event,handler)=>{navigate=handler;},getUserAgent:()=> 'Chrome/123 Electron/30 obsidian/1.8',
                getURL:()=> 'https://example.com/access',isDestroyed:()=>destroyed,
            };
        }
        isDestroyed(){return destroyed;}
        destroy(){destroyed=true;}
        async loadURL(){navigate(null,'https://example.com/access',403);}
    }
    const direct=async url=>({url,status:404,html:'',failure:'redirect-loop'});
    const page=await retrievePage('http://8.8.8.8/article',undefined,()=>false,Window,direct,(method,page,elapsedMs)=>attempts.push({method,page,elapsedMs}));
    assert.deepEqual(attempts.map(attempt=>attempt.method),['http','browser']);
    assert.equal(attempts[0].page.failure,'redirect-loop');
    assert.equal(attempts[1].page.status,403);
    assert.ok(attempts.every(attempt=>attempt.elapsedMs>=0));
    assert.equal(page.status,403);
    assert.equal(destroyed,true);
});
