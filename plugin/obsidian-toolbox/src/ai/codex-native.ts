import {access, open, readdir, realpath, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
async function nativeExecutable(candidate: string) {
    let file;
    try {
        await access(candidate,constants.X_OK);
        if (!(await stat(candidate)).isFile()) return null;
        file=await open(candidate,'r');
        const header=Buffer.alloc(4);
        if ((await file.read(header,0,4,0)).bytesRead!==4) return null;
        const magic=header.toString('hex');
        if (magic==='7f454c46' || ['feedface','feedfacf','cefaedfe','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic)
            || header[0]===0x4d && header[1]===0x5a) return await realpath(candidate);
    } catch { /* Try the next installed executable. */ }
    finally {await file?.close();}
    return null;
}

async function findCodex() {
    const home = homedir(), name = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const names=process.platform==='win32' ? [name,'codex.cmd','codex'] : [name];
    const candidates = [
        ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(directory => names.map(name=>path.join(directory,name))),
        ...[['.local','bin'],['.volta','bin'],['.npm-global','bin']].map(parts => path.join(home, ...parts, name)),
        '/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/Applications/Codex.app/Contents/Resources/codex',
    ];
    for (const parts of [['.codex','packages','standalone','releases'],['.nvm','versions','node']]) {
        const root = path.join(home, ...parts);
        const entries = await readdir(root, {withFileTypes:true}).catch(() => []);
        for (const entry of entries.filter(entry => entry.isDirectory()).sort((a,b) => b.name.localeCompare(a.name, undefined, {numeric:true}))) candidates.push(path.join(root, entry.name, 'bin', name));
    }
    const target: Record<string,string>={'darwin:arm64':'aarch64-apple-darwin','darwin:x64':'x86_64-apple-darwin',
        'linux:arm64':'aarch64-unknown-linux-musl','linux:x64':'x86_64-unknown-linux-musl',
        'win32:arm64':'aarch64-pc-windows-msvc','win32:x64':'x86_64-pc-windows-msvc'};
    const triple=target[process.platform+':'+process.arch];
    for (const candidate of new Set(candidates)) {
        const native=await nativeExecutable(candidate);
        if (native) return native;
        const resolved=await realpath(candidate).catch(()=>null);
        if (!resolved || !triple) continue;
        const root=/codex\.js$/.test(resolved) ? path.dirname(path.dirname(resolved))
            : path.join(path.dirname(resolved),'node_modules','@openai','codex');
        const platformPackage='codex-'+process.platform+'-'+process.arch;
        for (const directory of [root,path.join(root,'node_modules','@openai',platformPackage),path.join(path.dirname(root),platformPackage)]) {
            const binary=await nativeExecutable(path.join(directory,'vendor',triple,'codex',name));
            if (binary) return binary;
        }
    }
    return null;
}
export {findCodex as findNativeCodex};
