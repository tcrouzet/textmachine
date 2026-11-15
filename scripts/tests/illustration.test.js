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

test('native image output is normalized to a black and white 4:3 PNG',async()=>{
    const canvas={},drawing={fillRect(){},drawImage(...args){this.arguments=args;}};
    const context={module:{exports:{}},Blob,URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},
        Image:class {width=1536;height=1024;async decode(){}},
        createEl:tag=>{assert.equal(tag,'canvas');return Object.assign(canvas,{getContext:()=>drawing,toBlob:(done,type)=>{assert.equal(type,'image/png');done(new Blob(['fixture']));}});}};
    vm.runInNewContext(code,context);
    await context.module.exports.createIllustration(new ArrayBuffer(8));
    assert.equal(canvas.width,1600);assert.equal(canvas.height,1200);
    assert.equal(drawing.filter,'grayscale(1)');
    assert.deepEqual(drawing.arguments.slice(1),[0,0,1600,1200]);
});
