const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const code = require('esbuild').buildSync({entryPoints:[path.join(__dirname,'../../plugin/ai/rewrite.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const context = {module:{exports:{}}};
vm.runInNewContext(code,context);
const {validateRewrite} = context.module.exports;
const original = 'Une étude quasi expérimentale compare deux groupes existants. '+ 'Le texte décrit la méthode et ses limites. '.repeat(10)
    + '\n\n[Source](https://example.com/article)\n';

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
