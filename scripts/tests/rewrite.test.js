const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const code = require('esbuild').buildSync({entryPoints:[path.join(__dirname,'../../plugin/ai/rewrite.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const context = {module:{exports:{}},structuredClone};
vm.runInNewContext(code,context);
const {validateRewrite,rewriteRequest,parseRewrite} = context.module.exports;
const original = 'Une étude quasi expérimentale compare deux groupes existants. '+ 'Le texte décrit la méthode et ses limites. '.repeat(10)
    + '\n\n[Source](https://example.com/article)\n';

test('revision requests use their own JSON schema and send only the article body',()=>{
    const request=rewriteRequest('Editorial instructions',original);
    assert.equal(request.input,original);
    assert.deepEqual(request.schema,require('../../models/rewriter.json'));
    assert.deepEqual(request.schema.required,['paragraphs']);
    assert.deepEqual(Object.keys(request.schema.properties),['paragraphs']);
    assert.equal(request.schema.additionalProperties,false);
    assert.ok(request.system.startsWith('Editorial instructions'));
    assert.deepEqual(JSON.parse(request.system.split('\n\n').at(-1)).jsonSchema,request.schema);
});

test('structured revisions are validated before replacing the original paragraphs',()=>{
    const paragraphs=original.trim().replace('Une étude quasi expérimentale','Une étude').split('\n\n');
    assert.deepEqual(Array.from(parseRewrite(original,JSON.stringify({paragraphs}))),paragraphs);
    for (const response of [original,'{broken',JSON.stringify({paragraphs:[]}),JSON.stringify({paragraphs:['Only one']}),
        JSON.stringify({paragraphs:[...paragraphs,' ']}),JSON.stringify({paragraphs:[...paragraphs,42]}),
        JSON.stringify({paragraphs,image:null}),JSON.stringify({paragraphs,title:'Added title'})]) {
        assert.throws(()=>parseRewrite(original,response),/response format/);
    }
    assert.throws(()=>parseRewrite(original,JSON.stringify({paragraphs:['Too short.','Second paragraph.']})),/shortened/);
    assert.throws(()=>parseRewrite(original,JSON.stringify({paragraphs:paragraphs.map(text=>text.replace('example.com','other.com'))})),/links changed/);
    assert.throws(()=>parseRewrite(original,JSON.stringify({paragraphs:[...paragraphs,'![Image](https://example.com/image.jpg)']})),/image/);
});

test('body rewriting accepts clearer prose and improved link labels while keeping source URLs',()=>{
    const revised = original.replace('Une étude quasi expérimentale','Une étude');
    assert.equal(validateRewrite(original,revised),revised);
    const relabeled=original.replace('[Source]','[La source]');
    assert.equal(validateRewrite(original,relabeled),relabeled);
});

test('unusable body revisions report the precise reason for rejection',()=>{
    for (const [text,reason] of [[original.slice(0,40),/shortened by more than 10%/],
        [original.replace('https://example.com/article','https://other.com/article'),/article links changed/],
        ['# An unwanted title\n\n'+original,/unexpected heading/],
        [JSON.stringify({article:original}),/response format/],[{},/empty or unusable/],[null,/empty or unusable/],['',/empty or unusable/]]) {
        assert.throws(()=>validateRewrite(original,text),reason);
    }
});

test('a body revision cannot introduce images or a Markdown document wrapper',()=>{
    const note = original+'\n![Image](https://example.com/image.jpg)\n';
    assert.throws(()=>validateRewrite(original,note),/unexpected heading, image/);
    assert.throws(()=>validateRewrite(original,'```markdown\n'+original+'```'),/response format/);
});
