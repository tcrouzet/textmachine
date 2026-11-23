const path=require('node:path');
const {homedir}=require('node:os');
const source=path.resolve(process.env.OBSIDIAN_TOOLBOX || path.join(homedir(),'Documents/python/obsidian-toolbox'));
require(path.join(source,'scripts/build.cjs')).syncToolbox(path.resolve(__dirname,'..'));
