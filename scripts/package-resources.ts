import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as process from 'node:process';

export const resourcePacks = ['text-machine'];
export async function packageResources(output: string) {
    if (!output) throw new Error('Indiquez le dossier de destination des ressources.');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const destination = resolve(output);
    await mkdir(destination, {recursive:true});
    const prompts = (await readdir(resolve(root,'prompts'))).filter(name=>name.endsWith('.md')).sort().map(name=>'prompts/'+name);
    const sources = [...prompts,'models/newsletter.md','models/newsletter.json','scripts/vendor/public_suffix_list.dat','scripts/vendor/MPL-2.0.txt','scripts/vendor/readability/LICENSE.md','scripts/vendor/readability/LICENSE-2.0.txt'];
    const files = [];
    for (const path of sources) {
        const source = resolve(root,path), bytes = await readFile(source);
        const asset = path.replaceAll('/','-');
        await copyFile(source,resolve(destination,asset));
        files.push({path,asset,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    await writeFile(resolve(destination,'text-machine-resources.json'),JSON.stringify({version:1,files})+'\n');
    process.stdout.write(`${basename(destination)}: ${files.length} ressources publiques\n`);
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) void packageResources(process.argv[2]).catch((error:unknown)=>{console.error(error);process.exit(1);});
