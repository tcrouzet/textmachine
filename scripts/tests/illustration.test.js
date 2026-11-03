const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const code=require('esbuild').buildSync({entryPoints:[path.join(__dirname,'../../plugin/illustration.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;

test('failed image decoding releases its object URL and never returns placeholder artwork',async()=>{
    const released=[];
    const context={module:{exports:{}},Blob,URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL:url=>released.push(url)},
        Image:class {async decode(){throw new Error('Invalid PNG');}}};
    vm.runInNewContext(code,context);
    await assert.rejects(context.module.exports.createIllustration(new ArrayBuffer(8)),/Unable to create/);
    assert.deepEqual(released,['blob:fixture']);
});
