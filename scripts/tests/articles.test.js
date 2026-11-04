require('../../plugin/i18n').setLocale('fr');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPdf, articleUrl, sourceOf, extractLinks, isExcluded, messageArticles, feedArticles, parseData, withIds, mergeArticles } = require('../../plugin/articles');
const message = (from, extra = []) => ({id: '123', internalDate: '1700000000000', payload: {headers: [{name: 'From', value: from}, ...extra]}, bodies: []});

test('classifies sender addresses, not spoofed display names, and retains uncertainty', () => {
    assert.equal(sourceOf(message('Google <googlealerts-noreply@google.com>')), 'Google Alerts');
    assert.equal(sourceOf(message('scholaralerts-noreply@google.com')), 'Google Scholar');
    assert.equal(sourceOf(message('Google Alerts <reader@example.com>')), 'Utilisateur (présumé)');
    assert.equal(sourceOf(message('Editor <editor@example.com>', [{name: 'List-Id', value: 'Daily'}])), 'Autre service (présumé)');
});

test('unwraps Google article redirects, removes tracking and excludes utility or unsafe links', () => {
    assert.equal(articleUrl('https://www.google.com/url?url=https%3A%2F%2Fexample.com%2Farticle%3Futm_source%3Dmail%26id%3D42'), 'https://example.com/article?id=42');
    assert.equal(articleUrl('https://scholar.google.com/scholar_url?url=https%3A%2F%2Fexample.com%2Fpaper'), 'https://example.com/paper');
    for (const url of ['javascript:alert(1)', 'mailto:a@b.com', 'https://u:p@example.com', 'https://example.com/unsubscribe/1', 'https://www.google.com/alerts/remove']) assert.equal(articleUrl(url), null);
    assert.equal(articleUrl('https://example.com/token', 'Se désabonner'), null);
    assert.equal(articleUrl('https://example.com/article?q=a%26b'), 'https://example.com/article?q=a%26b');
});

test('plain text handles punctuation, duplicates and balanced URL parentheses', () => {
    const m = message('reader@example.com');
    m.bodies = [{type: 'text/plain', text: '(https://example.com/article). https://example.com/article?utm_source=email https://example.com/wiki/Title_(book)'}];
    assert.deepEqual(extractLinks(m).map(l => l.url), ['https://example.com/article', 'https://example.com/wiki/Title_(book)']);
});

test('stores structured articles with empty status and no Markdown escaping', () => {
    const m = message('reader@example.com');
    assert.deepEqual(messageArticles(m), []);
    m.bodies = [{type:'text/plain', text:'https://example.com/article'}];
    const entry = messageArticles(m);
    assert.deepEqual(entry[0], {date:'2023-11-14',title:'article',url:'https://example.com/article',source:'Utilisateur (présumé)',status:'',usedAt:'',publish:'',content:'',image:''});
    const first = mergeArticles('{"version":1,"articles":[]}', entry);
    assert.equal(first.count, 1);
    assert.equal(parseData(first.text).articles.length, 1);
    assert.equal(mergeArticles(first.text, entry).count, 0);
});

test('RSS links become article records without trusting feed summaries as crawled content',()=>{
    const records = feedArticles([
        {title:'A story',url:'/story?utm_source=feed',publish:'2026-11-01T10:00:00.000Z',content:'Unverified summary'},
        {title:'Research PDF',url:'/report.pdf'},
        {title:'Invalid',url:'javascript:alert(1)'},{title:'Homepage',url:'https://publisher.example/'},{title:'Missing URL'},
    ],'https://publisher.example/rss.xml','2026-11-03');
    assert.equal(records.length,2);
    assert.equal(records[0].url,'https://publisher.example/story');
    assert.equal(records[0].source,'RSS: publisher.example');
    assert.equal(records[0].date,'2026-11-01');
    assert.equal(records[0].content,'');
    assert.equal(records[1].status,'forbidden');
    assert.equal(records[1].date,'2026-11-03');
});

test('rejects French Google navigation, social sites, images and home pages', () => {
    for (const url of ['https://www.google.fr/alerts/feedback?ffu=https://example.com/article',
        'https://www.google.co.uk/alerts/edit', 'http://news.google.com/news/story?ncl=x',
        'https://www.facebook.com/page/posts/123', 'https://www.youtube.com/watch?v=123',
        'https://example.com/', 'https://example.com/fr/', 'https://example.com/privacy',
        'https://example.com/image.jpg', 'https://example.com/apps/tool']) assert.equal(articleUrl(url), null, url);
    assert.equal(articleUrl('https://www.google.fr/url?url=https%3A%2F%2Fexample.com%2Farticle'), 'https://example.com/article');
});

test('deduplicates URL or title and preserves status and custom fields', () => {
    const base = {date:'2026-11-03',title:'École : la suite',url:'https://example.com/article',source:'Google Alerts',status:'newsletter-1',summary:'My summary'};
    const content = JSON.stringify({version:1,project:'Notes',articles:[base]});
    const result = mergeArticles(content, [
        {...base,title:' ECOLE — LA SUITE ',url:'https://other.com/different',status:'',summary:'Do not overwrite'},
        {...base,title:'New title',url:'https://www.example.com/article/?utm_source=email',status:''},
        {...base,title:'Another article',url:'https://example.com/another',status:''},
        {...base,title:'Another article',url:'https://other.com/another',status:''},
    ]);
    const saved = parseData(result.text);
    assert.equal(result.count, 1);
    assert.equal(saved.articles.length, 2);
    assert.equal(saved.project, 'Notes');
    assert.equal(saved.articles[0].status, 'newsletter-1');
    assert.equal(saved.articles[0].summary, 'My summary');
    assert.equal(saved.articles[1].status, '');
    assert.equal(mergeArticles(result.text, []).text, result.text);
});

test('deduplication never attaches a caption to a different image',()=>{
    const original = {date:'',title:'Same news',url:'https://example.com/article',source:'User',image:'https://example.com/original.jpg'};
    const base = JSON.stringify({version:1,articles:[original]});
    const mismatched = mergeArticles(base,[{...original,image:'https://example.com/other.jpg',imageCaption:'Other photographer.'}]).text;
    assert.equal(JSON.parse(mismatched).articles[0].imageCaption,undefined);
    const matched = mergeArticles(mismatched,[{...original,imageCaption:'Original photographer.'}]).text;
    assert.equal(JSON.parse(matched).articles[0].imageCaption,'Original photographer.');
});

test('refuses broken or unsupported JSON instead of replacing it', () => {
    for (const text of ['broken', 'null', '{}', '{"version":2,"articles":[]}', '{"version":1,"articles":[{"url":"javascript:bad"}]}']) {
        assert.throws(() => mergeArticles(text, []), /invalide/);
    }
});

test('excludes source names and domains with subdomains, without matching lookalike hosts', () => {
    const article = {url:'https://news.example.com/article',source:'Google Alerts'};
    assert.equal(isExcluded(article, 'EXAMPLE.com'), true);
    assert.equal(isExcluded(article, 'https://www.example.com/'), true);
    assert.equal(isExcluded(article, 'other.com\n google alerts '), true);
    assert.equal(isExcluded(article, 'other.com, example.com'), true);
    assert.equal(isExcluded(article, ''), false);
    assert.equal(isExcluded({...article,url:'https://notexample.com/article'}, 'example.com'), false);
    assert.equal(isExcluded({...article,url:'https://example.com.evil.test/article'}, 'example.com'), false);
    assert.equal(isExcluded(article, 'Google'), false);
});

test('bare domain names match extensions and YouTube short domains', () => {
    for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube.be', 'youtube.fr', 'youtu.be', 'www.youtu.be']) {
        assert.equal(isExcluded({url:`https://${host}/video`,source:'User'}, 'YouTube'), true, host);
    }
    for (const url of ['https://notyoutube.com/video', 'https://youtube-news.com/video', 'https://example.com/youtube', 'https://example.com/?url=youtube.com']) {
        assert.equal(isExcluded({url,source:'User'}, 'youtube'), false, url);
    }
    assert.equal(isExcluded({url:'https://news.publisher.fr/article',source:'User'}, 'publisher'), true);
});

test('migrates legacy usage strings without losing their status or custom article fields', () => {
    const legacy = {date:'', title:'Article', url:'https://example.com/article', source:'User', used:'newsletter-1', note:'Keep'};
    const saved = JSON.parse(mergeArticles(JSON.stringify({version:1, articles:[legacy]}), []).text);
    assert.equal(saved.articles[0].status, 'newsletter-1');
    assert.equal(saved.articles[0].note, 'Keep');
    assert.equal(saved.articles[0].usedAt, 'unknown');
    assert.ok(!Object.hasOwn(saved.articles[0],'used'));
    for (const field of ['publish','content','image']) assert.equal(saved.articles[0][field], '');
});
test('usedAt alone records usage and legacy flags are removed without losing dates',()=>{
    const article={id:1,date:'',title:'Article',url:'https://example.com/article',source:'User',status:'used',usedAt:'2026-11-03',note:'Keep'};
    const input=JSON.stringify({version:1,nextId:2,articles:[article]});
    const migrated=withIds(input),row=JSON.parse(migrated).articles[0];
    assert.equal(row.status,'');assert.ok(!Object.hasOwn(row,'used'));assert.equal(row.usedAt,article.usedAt);assert.equal(row.note,'Keep');
    assert.equal(withIds(migrated),migrated);
    for (const used of [0,1]) {
        const row=parseData(JSON.stringify({version:1,articles:[{...article,status:'',used}]})).articles[0];
        assert.equal(row.usedAt,'2026-11-03');assert.ok(!Object.hasOwn(row,'used'));
    }
    for (const used of [2,-1,true,{}]) {
        assert.throws(()=>parseData(JSON.stringify({version:1,articles:[{...article,status:'',used}]})),/invalide/);
    }
    for (const status of ['forbidden','404','discard']) {
        const row=parseData(JSON.stringify({version:1,articles:[{...article,status:undefined,usedAt:undefined,used:status}]})).articles[0];
        assert.equal(row.status,status);assert.equal(row.usedAt,'');assert.ok(!Object.hasOwn(row,'used'));
    }
});
test('mail deduplication never resets an already used article or its edition date',()=>{
    const article={date:'',title:'Article',url:'https://example.com/article',source:'User',status:'',used:1,usedAt:'2026-11-03'};
    const saved=parseData(mergeArticles(JSON.stringify({version:1,articles:[article]}),[{...article,used:0,usedAt:''}]).text);
    assert.equal(saved.articles.length,1);assert.ok(!Object.hasOwn(saved.articles[0],'used'));assert.equal(saved.articles[0].usedAt,'2026-11-03');
});

test('PDF links are retained as forbidden metadata without loading their content',()=>{
    for (const url of ['https://example.com/report.pdf','https://example.com/report.PDF?download=1',
        'https://example.com/report%2Epdf#page=2','https://example.com/download?filename=report.pdf',
        'https://example.com/download?format=pdf',
        'https://www.google.com/url?url=https%3A%2F%2Fexample.com%2Freport.pdf']) {
        assert.ok(isPdf(articleUrl(url)),url);
    }
    assert.equal(articleUrl('https://example.com/articles/about-pdf'),'https://example.com/articles/about-pdf');
    const m = message('reader@example.com');
    m.bodies = [{type:'text/plain',text:'https://example.com/report.pdf https://example.com/article'}];
    assert.deepEqual(messageArticles(m).map(article=>({url:article.url,status:article.status,content:article.content})),[
        {url:'https://example.com/report.pdf',status:'forbidden',content:''},{url:'https://example.com/article',status:'',content:''},
    ]);
});


test('IDs are persisted once, preserved by deduplication and never reused after removal',()=>{
    const original = {version:1,notes:'Keep',articles:[{date:'',title:'First',url:'https://example.com/first',source:'User',custom:'Keep'}]};
    const firstText = withIds(JSON.stringify(original));
    const first = JSON.parse(firstText);
    assert.equal(first.articles[0].id,1);
    assert.equal(first.articles[0].custom,'Keep');
    assert.equal(first.nextId,2);
    assert.equal(withIds(firstText),firstText);
    const merged = JSON.parse(mergeArticles(firstText,[{...original.articles[0],id:99},{date:'',title:'Second',url:'https://example.com/second',source:'User'}]).text);
    assert.equal(merged.articles[0].id,1);
    assert.ok(merged.articles[1].id > 1);
    const previousMax = Math.max(...merged.articles.map(article=>article.id));
    merged.articles = [merged.articles[0]];
    const final = JSON.parse(mergeArticles(JSON.stringify(merged),[{date:'',title:'Third',url:'https://example.com/third',source:'User'}]).text);
    assert.ok(final.articles[1].id > previousMax);
    assert.equal(final.notes,'Keep');
    for (const id of ['1',-1,0,null]) assert.throws(()=>withIds(JSON.stringify({...original,articles:[{...original.articles[0],id}]})),/textmachine.json/);
    assert.throws(()=>withIds(JSON.stringify({...original,articles:[{...original.articles[0],id:1},{...original.articles[0],id:1}]})),/textmachine.json/);
});
