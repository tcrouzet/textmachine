const fs = require('node:fs');
const {transformSync} = require('esbuild');
globalThis.window = globalThis;
require.extensions['.ts'] = (module, filename) => module._compile(transformSync(fs.readFileSync(filename,'utf8'), {loader:'ts',format:'cjs',target:'es2022'}).code,filename);
require.extensions['.dat'] = (module, filename) => { module.exports = fs.readFileSync(filename, 'utf8'); };
