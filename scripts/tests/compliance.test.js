const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {ESLint} = require('eslint');
const ts = require('typescript-eslint');

const root = path.resolve(__dirname,'../..');
const rules = Object.fromEntries(['no-unsafe-assignment','no-unsafe-member-access','no-unsafe-call','no-unsafe-return',
    'no-unsafe-argument','no-require-imports','no-redundant-type-constituents'].map(name=>['@typescript-eslint/'+name,'error']));

test('plugin modules pass the type-aware rules reported by the Obsidian review',async()=>{
    const eslint = new ESLint({cwd:root,overrideConfigFile:true,overrideConfig:[{
        files:['plugin/**/*.ts'],languageOptions:{parser:ts.parser,parserOptions:{project:'./tsconfig.plugin.json',tsconfigRootDir:root}},
        plugins:{'@typescript-eslint':ts.plugin},rules,
    }]});
    const results = await eslint.lintFiles(['plugin/**/*.ts']);
    assert.ok(results.length > 0);
    assert.equal(results.reduce((count,result)=>count+result.errorCount+result.warningCount,0),0,
        await (await eslint.loadFormatter('stylish')).format(results));
    const [unsafe] = await eslint.lintText('const data = JSON.parse("{}"); data.hidden();', {filePath:'plugin/types.ts'});
    assert.ok(unsafe.messages.some(message=>message.ruleId==='@typescript-eslint/no-unsafe-member-access'));
    assert.ok(unsafe.messages.some(message=>message.ruleId==='@typescript-eslint/no-unsafe-call'));
});
