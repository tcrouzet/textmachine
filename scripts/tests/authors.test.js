const {test}=require('node:test');
const assert=require('node:assert/strict');
const {authorNames,authorsFromText}=require('../../plugin/authors');
const {parseData,withIds,mergeArticles}=require('../../plugin/articles');
const article={id:1,date:'2026-11-04',title:'An article',url:'https://example.com/article',source:'User',status:'',usedAt:'2026-11-04',publish:'',content:'Article text',image:''};

test('author metadata supports people, organizations, multiple authors and published bylines without inventing names',()=>{
    assert.deepEqual(authorNames([{name:'Jane Doe'},{givenName:'Jean',familyName:'Dupont'},{name:'Agence France-Presse'},'By Jane Doe',null]),
        ['Jane Doe','Jean Dupont','Agence France-Presse']);
    assert.deepEqual(authorNames(['https://example.com/author','#person','jane@example.com','2026-11-04','',{}]),[]);
    assert.deepEqual(authorsFromText('By Emmanuel Bernet, Ph.D.\n\nArticle text'),['Emmanuel Bernet, Ph.D.']);
    assert.deepEqual(authorsFromText('Par Anne Martin\n\nArticle text'),['Anne Martin']);
    assert.deepEqual(authorsFromText('A quotation by Anne Martin in the article.'),[]);
});
test('cached signatures migrate without changing article content or usage and without requesting pages',()=>{
    const original={...article,content:'By Jane Doe\n\nPreserved article text.'};
    const saved=withIds(JSON.stringify({version:1,nextId:2,articles:[original]}));
    assert.deepEqual(JSON.parse(saved).articles[0],{...original,authors:['Jane Doe']});
    assert.equal(withIds(saved),saved);
    assert.deepEqual(parseData(JSON.stringify({version:1,articles:[article]})).articles[0].authors,[]);
    for (const authors of ['Jane Doe',[42]]) {
        assert.throws(()=>parseData(JSON.stringify({version:1,articles:[{...article,authors}]})),/JSON|invalide|invalid/i);
    }
});
test('mail deduplication fills missing authors and preserves previously recorded names',()=>{
    const initial=JSON.stringify({version:1,articles:[{...article,authors:[]}]});
    const first=mergeArticles(initial,[{...article,authors:['Jane Doe']}]).text;
    assert.deepEqual(JSON.parse(first).articles[0].authors,['Jane Doe']);
    const second=mergeArticles(first,[{...article,authors:['Another author']}]).text;
    assert.deepEqual(JSON.parse(second).articles[0].authors,['Jane Doe']);
});
