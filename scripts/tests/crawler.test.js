const {test} = require('node:test');
const assert = require('node:assert/strict');
require('../../plugin/i18n').setLocale('en');
const {publicationDate, parseBlocked, isBlocked, crawl} = require('../../plugin/crawler');
const {isPdf} = require('../../plugin/articles');
const {publicAddress, publicUrl} = require('../../plugin/browser');
const article = {url:'https://example.com/article', title:'Article', date:'', source:'User', status:'', publish:'', content:'', image:''};

test('site refusals are persisted and suppress future pages on that host', async () => {
    const data = [];
    let calls = 0;
    const load = async url => {calls++; return {url, status:403, html:''};};
    assert.equal((await crawl(article, data, undefined, load)).status, 'forbidden');
    assert.deepEqual(data, ['example.com']);
    assert.equal((await crawl({...article,url:'https://www.example.com/another'}, data, undefined, load)).status, 'forbidden');
    assert.equal(calls, 1);
    assert.equal(isBlocked('https://example.com.evil.test/article',data), false);
    assert.equal(isBlocked('https://notexample.com/article',data), false);
});

test('HTTP 404 pages remain missing rather than paywalled and are not fetched again',async()=>{
    const blocked=[];
    let calls=0;
    const load=async url=>{calls++;return {url,status:404,html:''};};
    const missing=await crawl(article,blocked,undefined,load);
    assert.equal(missing.status,'404');
    assert.deepEqual(blocked,[]);
    assert.equal((await crawl(missing,blocked,undefined,load)).status,'404');
    assert.equal(calls,1);
    const failed=await crawl(article,blocked,undefined,async url=>({url,status:404,html:'',failure:'ETIMEDOUT'}));
    assert.equal(failed.status,'forbidden','A transport failure is not evidence of an HTTP 404');
});

test('page failures preserve missing pages separately from access failures without blocking unrelated articles', async () => {
    for (const status of [200,404,410,429,500,502,503,504]) {
        const blocked=[];
        let calls=0;
        const load=async url=>{calls++;return {url,status,html:''};};
        const result=await crawl(article,blocked,undefined,load);
        assert.equal(result.status,status===404 ? '404' : 'forbidden');
        assert.deepEqual(blocked,[],String(status));
        await crawl(result,blocked,undefined,load);
        assert.equal(calls,1,'The failed article must not be retried');
        await crawl({...article,url:'https://news.example.com/another'},blocked,undefined,load);
        assert.equal(calls,2,'Other articles on that domain remain eligible');
    }
});

test('explicit access refusals block domains while network failures do not',async()=>{
    for (const status of [401,402,403,451]) {
        const blocked=[];
        await crawl(article,blocked,undefined,async url=>({url,status,html:''}));
        assert.deepEqual(blocked,['example.com']);
    }
    const blocked=[];
    await crawl(article,blocked,undefined,async url=>({url,status:404,html:'',failure:'ETIMEDOUT'}));
    assert.deepEqual(blocked,[]);
});

test('normalizes registrable domains, suffix exceptions, legacy lists and duplicates', () => {
    assert.deepEqual(parseBlocked(JSON.stringify(['www.thetimes.com','news.thetimes.com','sport.bbc.co.uk','www.city.kawasaki.jp','foo.blogspot.com'])),
        ['thetimes.com','bbc.co.uk','city.kawasaki.jp','foo.blogspot.com']);
    assert.deepEqual(parseBlocked(JSON.stringify({version:1,blocked:[{url:'https://www.thetimes.com/article',scope:'site',reason:'403'}]})), ['thetimes.com']);
    assert.equal(isBlocked('https://thetimes.com.evil.test/article',['thetimes.com']), false);
});

test('parses published dates in ISO, French and English without inventing dates', () => {
    for (const [text, expected] of [['2026-11-03T08:15:00+01:00','2026-11-03T08:15:00+01:00'],
        ['Publié le 3 novembre 2026','2026-11-03'],['November 3, 2026','2026-11-03'], ['3 févr. 2024','2024-02-03'],
        ['2026-02-30',''],['31 février 2026',''],['Updated today',''],['03/11/26','']]) assert.equal(publicationDate(text), expected);
});

test('broken blocklists cannot silently discard exclusions', () => {
    for (const text of ['broken','null','{}','{"version":1,"blocked":[{"url":"file:///tmp/test","scope":"site","reason":"403"}]}']) {
        assert.throws(() => parseBlocked(text), /blocked.json/);
    }
});

test('cancellation is propagated without poisoning the blocklist', async () => {
    const data = [];
    const controller = new AbortController();
    await assert.rejects(crawl(article, data, controller.signal, async () => {
        controller.abort(); return {status:404,url:article.url,html:''};
    }));
    assert.deepEqual(data, []);
});

test('browser rejects local addresses and non-web URLs before opening a page', async () => {
    for (const ip of ['127.0.0.1','0.0.0.0','10.1.1.1','172.16.0.1','192.168.0.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','fd00::1','2001:db8::1']) {
        assert.equal(publicAddress(ip), false, ip);
    }
    for (const ip of ['8.8.8.8','2606:4700::1111','2001:4860:4860::8888']) assert.equal(publicAddress(ip), true, ip);
    for (const url of ['file:///tmp/test','javascript:alert(1)','http://127.1/','http://[::1]/','https://user:pass@example.com/','http://8.8.8.8:1234/']) {
        assert.equal(await publicUrl(url), false, url);
    }
});

test('PDFs never enter article extraction or block their hosting domain',async()=>{
    let calls = 0;
    const blocked = [];
    const load = async()=>{calls++;throw new Error('PDF must not be requested');};
    assert.equal((await crawl({...article,url:'https://example.com/report.pdf'},blocked,undefined,load)).status,'forbidden');
    assert.equal((await crawl({...article,url:'https://arxiv.org/pdf/2610.37916'},blocked,undefined,load)).status,'forbidden');
    assert.equal(calls,0);
    for (const page of [
        {status:200,url:'https://example.com/hidden',contentType:'application/pdf',html:''},
        {status:415,url:'https://example.com/final.pdf',html:''},
        {status:200,url:'https://example.com/hidden',html:'%PDF-1.7 binary document'},
    ]) {
        assert.equal((await crawl(article,blocked,undefined,async()=>page)).status,'forbidden');
        assert.deepEqual(blocked,[]);
    }
});


test('PDF MIME types and download filenames are recognized without excluding HTML about PDF',()=>{
    assert.equal(isPdf('https://arxiv.org/pdf/2610.37916'),true);
    assert.equal(isPdf('https://export.arxiv.org/pdf/hep-th/9901001'),true);
    assert.equal(isPdf('https://arxiv.org/abs/2610.37916'),false);
    assert.equal(isPdf('https://arxiv.org.evil.example/pdf/2610.37916'),false);
    assert.equal(isPdf('https://example.com/download','Application/PDF; charset=binary'),true);
    assert.equal(isPdf('https://example.com/download','application/octet-stream','attachment; filename="paper.pdf"'),true);
    assert.equal(isPdf('https://example.com/download','application/octet-stream',"inline; filename*=UTF-8''paper%2Epdf"),true);
    assert.equal(isPdf('https://example.com/articles/pdf-readers','text/html'),false);
    assert.equal(isPdf('https://example.com/download','text/html','inline; filename="paper.pdf.html"'),false);
});
