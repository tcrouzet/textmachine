const fs = require('node:fs');
require.extensions['.dat'] = (module, filename) => { module.exports = fs.readFileSync(filename, 'utf8'); };
