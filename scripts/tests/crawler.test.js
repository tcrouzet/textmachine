const {test} = require('node:test');
const assert = require('node:assert/strict');
require('../../plugin/i18n').setLocale('en');
const {publicationDate, parseBlocked, isBlocked, crawl} = require('../../plugin/crawler');
const {publicAddress, publicUrl} = require('../../plugin/browser');
const article = {url:'https://example.com/article', title:'Article', date:'', source:'User', status:'', publish:'', content:'', image:''};

test('site refusals are persisted and suppress future pages on that host', async () => {
    const data = [];
    let calls = 0;
    const load = async url => {calls++; return {url, status:403, html:''};};
    assert.equal((await crawl(article, data, undefined, load)).status, '404');
    assert.deepEqual(data, ['example.com']);
    assert.equal((await crawl({...article,url:'https://www.example.com/another'}, data, undefined, load)).status, '404');
    assert.equal(calls, 1);
    assert.equal(isBlocked('https://example.com.evil.test/article',data), false);
    assert.equal(isBlocked('https://notexample.com/article',data), false);
});

test('failed pages store only their domain and prevent requests to its subdomains', async () => {
    const data = [];
    await crawl(article, data, undefined, async url => ({url,status:404,html:''}));
    assert.deepEqual(data, ['example.com']);
    assert.equal(isBlocked('https://news.example.com/another',data), true);
    await crawl(article, parseBlocked(JSON.stringify(data)), undefined, () => {throw new Error('Must not request');});
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
