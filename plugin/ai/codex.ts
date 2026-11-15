import {t} from '../i18n';
import {version} from '../../manifest.json';
import {access, open, readdir, realpath, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
import {Model, Progress, record} from '../types';
import {decodeImage} from './image';

interface Generation {system: string; input: string; model: string; progress?: Progress; schema?: object; imageUrl?: string; effort?: string; imageGeneration?: boolean}

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

function generationError(value: unknown) {
    const error = record(value);
    const inputLimit=typeof error.message==='string' ? /^Input exceeds the maximum length of (\d{1,9}) characters\./.exec(error.message) : null;
    if (inputLimit) return new Error(t('aiCodexInputTooLong',{limit:inputLimit[1]}));
    if (typeof error.message==='string' && /invalid (?:output )?schema|invalid_json_schema/i.test(error.message)) return new Error(t('aiCodexSchema'));
    if (error?.codexErrorInfo === 'usageLimitExceeded') return new Error(t('aiCodexLimit'));
    if (error?.codexErrorInfo === 'contextWindowExceeded') return new Error(t('aiCodexContext'));
    if (error?.codexErrorInfo === 'unauthorized') return new Error(t('aiCodexLogin'));
    const info = error.codexErrorInfo;
    const code = typeof info === 'string' ? info : Object.keys(record(info))[0];
    const known = ['sessionBudgetExceeded','rateLimitExceeded','flexUnavailable','serverOverloaded','modelNotFound',
        'policyCapacityUnavailable','cyberPolicy','misalignmentPolicyViolation','tooManyDenials','internalServerError',
        'badRequest','threadRollbackFailed','sandboxError','other','httpConnectionFailed','responseStreamConnectionFailed',
        'responseStreamDisconnected','responseTooManyFailedAttempts','activeTurnNotSteerable'];
    const detail = known.includes(code) ? code
        : typeof error.code === 'number' && Number.isSafeInteger(error.code) && error.code >= -32768 && error.code <= -32000 ? String(error.code) : '';
    return new Error(t('aiCodexFailed') + (detail ? ' (' + detail + ')' : ''));
}

function run(executable: string | null, signal?: AbortSignal): Promise<Model[]>;
function run(executable: string | null, signal: AbortSignal | undefined, generation: Generation): Promise<string>;
async function run(executable: string | null, signal?: AbortSignal, generation?: Generation) {
    if (!executable) throw new Error(t('aiCodexUnavailable'));
    if (signal?.aborted) throw new Error(t('aiCodexCancelled'));
    const disabled = ['apps','plugins','hooks','multi_agent','multi_agent_v2','shell_tool','unified_exec','code_mode','code_mode_host','computer_use','browser_use','image_generation','view_image'];
    const imageGeneration=generation?.imageGeneration===true;
    const child = spawn(executable, ['app-server','--listen','stdio://', ...disabled.filter(feature=>!imageGeneration || feature!=='image_generation').flatMap(feature => ['--disable',feature]),...(imageGeneration ? ['--enable','image_generation'] : [])],
        {cwd:tmpdir(), stdio:['pipe','pipe','pipe'], windowsHide:true, detached:process.platform !== 'win32'});
    const pending = new Map<number,{method: string; fields: string[]; resolve: (value: Record<string,unknown>)=>void; reject: (reason: Error)=>void}>(), phases = new Map<string,unknown>();
    let nextId = 0, buffer = '', stopped = false, failure: Error | undefined, threadId = '', answer = '', turnError: unknown;
    let imagePath='';
    let finish: {resolve: (value: string)=>void; reject: (reason: Error)=>void} | undefined;
    const completed = generation ? new Promise<string>((resolve,reject) => {finish = {resolve,reject};}) : null;
    completed?.catch(()=>{});
    const fail = (error: Error) => {
        failure ||= error;
        for (const request of pending.values()) request.reject(failure);
        pending.clear();
        finish?.reject(failure);
    };
    const abort = () => fail(new Error(t('aiCodexCancelled')));
    signal?.addEventListener('abort', abort, {once:true});
    child.once('error', () => fail(new Error(t('aiCodexUnavailable'))));
    child.once('close', () => { if (!stopped) fail(new Error(t('aiCodexClosed'))); });
    child.stdin.on('error', () => fail(new Error(t('aiCodexClosed'))));
    child.stderr.resume();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > (imageGeneration ? 32 : 4) * 1024 * 1024) { fail(new Error(t('aiCodexInvalid'))); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
            if (!line.trim()) continue;
            try {
                const message = record(JSON.parse(line));
                const params = record(message.params);
                if (message.method && message.id !== undefined) { fail(new Error(t('aiCodexInvalid'))); return; }
                if (generation && message.method && threadId && params.threadId === threadId) {
                    if (message.method === 'error' && params.willRetry !== true) {
                        turnError = params.error;
                    } else if (message.method === 'item/started' || message.method === 'item/completed') {
                        const item = record(params.item);
                        if (typeof item.id==='string') phases.set(item.id,item.phase);
                        if (typeof item.type!=='string' || !['agentMessage','userMessage','reasoning',...(imageGeneration ? ['imageGeneration'] : [])].includes(item.type)) {fail(new Error(t('aiCodexToolsDenied')));return;}
                        if (item.type==='imageGeneration' && message.method==='item/completed') {
                            if (item.failure || item.status!=='completed') {fail(new Error(t('newsletterIllustrationFailed')));return;}
                            if (typeof item.result==='string' && item.result.trim()) answer=item.result;
                            else if (typeof item.savedPath==='string' && path.isAbsolute(item.savedPath) && /\.png$/i.test(item.savedPath)) imagePath=item.savedPath;
                            else {fail(new Error(t('newsletterIllustrationFailed')));return;}
                        }
                        if (message.method === 'item/started' && item.type === 'reasoning') generation.progress?.(t('aiThinking'));
                        if (message.method === 'item/completed' && item.type === 'agentMessage' && item.phase === 'commentary' && typeof item.text==='string') generation.progress?.(item.text);
                        if (!imageGeneration && message.method === 'item/completed' && item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string') answer = item.text;
                    } else if (!imageGeneration && message.method === 'item/agentMessage/delta' && typeof params.delta === 'string' && typeof params.itemId==='string' && phases.get(params.itemId) !== 'commentary') {
                        generation.progress?.(params.delta,true);
                    } else if (message.method === 'turn/completed') {
                        const turn = record(params.turn);
                        if (turn?.status === 'failed') fail(generationError(turn.error || turnError));
                        else if (turn?.status === 'interrupted') fail(new Error(t('aiCodexCancelled')));
                        else if (turn?.status !== 'completed') fail(new Error(t('aiCodexInvalid')));
                        else if (!answer.trim() && !imagePath) fail(new Error(imageGeneration ? t('newsletterIllustrationFailed') : t('aiCodexEmpty')));
                        else finish?.resolve(answer);
                    }
                }
                const request = typeof message.id==='number' ? pending.get(message.id) : undefined;
                if (!request) continue;
                pending.delete(Number(message.id));
                if (message.error) {
                    const rpcError = record(message.error);
                    const rpcMessage = rpcError.message;
                    const fields = rpcError.code === -32602 && typeof rpcMessage === 'string'
                        ? request.fields.filter(field => rpcMessage.includes(field)) : [];
                    const error = generationError(message.error);
                    request.reject(new Error(request.method + ': ' + error.message + (fields.length ? ' [' + fields.join(', ') + ']' : '')));
                } else request.resolve(record(message.result));
            } catch { fail(new Error(t('aiCodexInvalid'))); }
        }
    });
    const request = (method: string, params: object) => new Promise<Record<string,unknown>>((resolve, reject) => {
        if (failure) { reject(failure); return; }
        const id = ++nextId;
        pending.set(id, {method, fields:[...new Set([...Object.keys(params),...Object.keys(record(record(params).config)),...Object.keys(record(record(params).sandboxPolicy)), 'experimentalApi'])], resolve,reject});
        child.stdin.write(JSON.stringify({id,method,params}) + '\n');
    });
    try {
        await request('initialize', {clientInfo:{name:'text-machine',title:'Text Machine',version}});
        child.stdin.write(JSON.stringify({method:'initialized'}) + '\n');
        const account = await request('account/read', {refreshToken:false});
        if (account?.requiresOpenaiAuth === true && !account.account) throw new Error(t('aiCodexLogin'));
        if (generation) {
            const config = await request('config/read',{cwd:tmpdir(),includeLayers:false});
            if (!config.config || typeof config.config !== 'object') throw new Error(t('aiCodexInvalid'));
            const servers = record(record(config.config).mcp_servers);
            const thread = await request('thread/start',{
                ...(generation.model ? {model:generation.model} : {}),
                cwd:tmpdir(), ephemeral:true, approvalPolicy:'never', sandbox:'read-only',
                baseInstructions:generation.system,
                developerInstructions:imageGeneration ? 'Generate one PNG illustration using only image_generation. Do not use other tools or read files. Return the generated image, not a description or a link.' : 'Return only the requested response. Never use tools or access files.',
                config:{project_doc_max_bytes:0,web_search:'disabled',...(generation.effort ? {model_reasoning_effort:generation.effort} : {}),mcp_servers:Object.fromEntries(Object.keys(servers).map(name=>[name,{enabled:false}]))},
            });
            const details = record(thread.thread);
            if (typeof details.id !== 'string' || !details.id || record(thread.sandbox).type !== 'readOnly'
                || thread.approvalPolicy !== 'never' || details.ephemeral !== true) throw new Error(t('aiCodexToolsDenied'));
            threadId = details.id;
            if (typeof thread.model === 'string' && thread.model.trim() && thread.model.length <= 200) generation.progress?.('',false,false,'Codex · '+thread.model);
            await request('turn/start',{threadId,input:[{type:'text',text:generation.input,text_elements:[]},...(generation.imageUrl ? [{type:'image',url:generation.imageUrl}] : [])],...(generation.effort ? {effort:generation.effort} : {}),sandboxPolicy:{type:'readOnly',networkAccess:false},...(generation.schema ? {outputSchema:generation.schema} : {})});
            const result=await completed;
            if (imageGeneration && imagePath) {
                const file=await request('fs/readFile',{path:imagePath});
                if (typeof file.dataBase64!=='string') throw new Error(t('newsletterIllustrationFailed'));
                return file.dataBase64;
            }
            return result;
        }
        const models = new Map<string,Model>(), cursors = new Set<string>();
        let cursor: string | null = null;
        do {
            if (cursor && cursors.has(cursor)) throw new Error(t('aiCodexInvalid'));
            if (cursor) cursors.add(cursor);
            const page = await request('model/list', {limit:100,includeHidden:false,cursor});
            if (!Array.isArray(page?.data) || (page.nextCursor != null && typeof page.nextCursor !== 'string')) throw new Error(t('aiCodexInvalid'));
            for (const value of page.data as unknown[]) {
                const model=record(value);
                if (model?.hidden === true) continue;
                if (typeof model?.model !== 'string' || !model.model.trim() || model.model.length > 200
                    || typeof model.displayName !== 'string' || !model.displayName.trim() || model.displayName.length > 200) throw new Error(t('aiCodexInvalid'));
                const supported=model.supportedReasoningEfforts;
                if (supported!==undefined && !Array.isArray(supported)) throw new Error(t('aiCodexInvalid'));
                const efforts=Array.isArray(supported) ? supported.map((entry: unknown)=>{
                    const effort=record(entry).reasoningEffort;
                    if (typeof effort!=='string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort)) throw new Error(t('aiCodexInvalid'));
                    return effort;
                }) : [];
                models.set(model.model, {value:model.model,label:model.displayName,...(efforts.length ? {efforts:[...new Set(efforts)]} : {})});
            }
            cursor = typeof page.nextCursor==='string' ? page.nextCursor || null : null;
        } while (cursor);
        return [...models.values()];
    } finally {
        stopped = true;
        signal?.removeEventListener('abort', abort);
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null) {
            const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already stopped. */ } };
            const fallback = window.setTimeout(() => kill('SIGKILL'), 1500);
            child.once('close', () => window.clearTimeout(fallback));
            kill('SIGTERM');
        }
    }
}

const listModels = (executable: string | null, signal?: AbortSignal) => run(executable, signal);
const generate = (executable: string | null, system: string, input: string, model: string, signal?: AbortSignal, progress?: Progress, schema?: object, imageUrl?: string, effort?: string) => run(executable,signal,{system,input,model,progress,schema,imageUrl,effort});
const generateImage = async (executable: string | null, system: string, input: string, model: string, signal?: AbortSignal, progress?: Progress, effort?: string) => decodeImage(await run(executable,signal,{system,input,model,progress,effort,imageGeneration:true}));
export {findCodex, listModels, generate, generateImage};
