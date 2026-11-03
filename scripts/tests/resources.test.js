const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {tmpdir} = require('node:os');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');

test('public resources include the newsletter template and matching JSON schema',t=>{
    const output = fs.mkdtempSync(path.join(tmpdir(),'textmachine-models-'));
    t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
    const root = path.resolve(__dirname,'../..');
    const result = spawnSync('npm',['run','resources','--',output],{cwd:root,encoding:'utf8',timeout:20000});
    assert.ifError(result.error);
    assert.equal(result.status,0,result.stderr);
    const catalog = JSON.parse(fs.readFileSync(path.join(output,'text-machine-resources.json'),'utf8'));
    for (const name of ['models/newsletter.md','models/newsletter.json','models/selection.json','models/writer.json','models/bref.json','models/resume.json','prompts/sélection.md','prompts/resume.md','prompts/writer.md','prompts/bref.md','prompts/image.md']) {
        const resource = catalog.files.find(file=>file.path===name);
        assert.ok(resource,name);
        const bytes = fs.readFileSync(path.join(output,resource.asset));
        assert.deepEqual(bytes,fs.readFileSync(path.join(root,name)));
        assert.equal(resource.bytes,bytes.length);
        assert.equal(resource.sha256,createHash('sha256').update(bytes).digest('hex'));
    }
});
