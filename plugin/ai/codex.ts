import {t} from '../i18n';
import {version} from '../../manifest.json';
import {access, readdir, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
import {Model, Progress, record} from '../types';

interface Generation {system: string; input: string; model: string; progress?: Progress; schema?: object; imageUrl?: string}

async function findCodex() {
    const home = homedir(), name = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const candidates = [
        ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name)),
        ...[['.local','bin'],['.volta','bin'],['.npm-global','bin']].map(parts => path.join(home, ...parts, name)),
        '/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/Applications/Codex.app/Contents/Resources/codex',
    ];
    for (const parts of [['.codex','packages','standalone','releases'],['.nvm','versions','node']]) {
        const root = path.join(home, ...parts);
        const entries = await readdir(root, {withFileTypes:true}).catch(() => []);
        for (const entry of entries.filter(entry => entry.isDirectory()).sort((a,b) => b.name.localeCompare(a.name, undefined, {numeric:true}))) candidates.push(path.join(root, entry.name, 'bin', name));
    }
    for (const candidate of new Set(candidates)) {
        try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch { /* Try the next standard location. */ }
    }
    return null;
}

function generationError(value: unknown) {
    const error = record(value);
    if (typeof error.message==='string' && /invalid schema|invalid_json_schema/i.test(error.message)) return new Error(t('aiCodexSchema'));
    if (error?.codexErrorInfo === 'usageLimitExceeded') return new Error(t('aiCodexLimit'));
    if (error?.codexErrorInfo === 'contextWindowExceeded') return new Error(t('aiCodexContext'));
    if (error?.codexErrorInfo === 'unauthorized') return new Error(t('aiCodexLogin'));
    return new Error(t('aiCodexFailed'));
}

function run(executable: string | null, signal?: AbortSignal): Promise<Model[]>;
function run(executable: string | null, signal: AbortSignal | undefined, generation: Generation): Promise<string>;
async function run(executable: string | null, signal?: AbortSignal, generation?: Generation) {
    if (!executable) throw new Error(t('aiCodexUnavailable'));
    if (signal?.aborted) throw new Error(t('aiCodexCancelled'));
    const disabled = ['apps','plugins','hooks','multi_agent','multi_agent_v2','shell_tool','unified_exec','code_mode','code_mode_host','computer_use','browser_use','image_generation','view_image'];
    const child = spawn(executable, ['app-server','--listen','stdio://', ...disabled.flatMap(feature => ['--disable',feature])],
        {cwd:tmpdir(), stdio:['pipe','pipe','pipe'], windowsHide:true, detached:process.platform !== 'win32'});
    const pending = new Map<number,{resolve: (value: Record<string,unknown>)=>void; reject: (reason: Error)=>void}>(), phases = new Map<string,unknown>();
    let nextId = 0, buffer = '', stopped = false, failure: Error | undefined, threadId = '', answer = '', turnError: unknown;
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
        if (buffer.length > 4 * 1024 * 1024) { fail(new Error(t('aiCodexInvalid'))); return; }
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
                        if (typeof item.type!=='string' || !['agentMessage','userMessage','reasoning'].includes(item.type)) {fail(new Error(t('aiCodexToolsDenied')));return;}
                        if (message.method === 'item/started' && item.type === 'reasoning') generation.progress?.(t('aiThinking'));
                        if (message.method === 'item/completed' && item.type === 'agentMessage' && item.phase === 'commentary' && typeof item.text==='string') generation.progress?.(item.text);
                        if (message.method === 'item/completed' && item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string') answer = item.text;
                    } else if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string' && typeof params.itemId==='string' && phases.get(params.itemId) !== 'commentary') {
                        generation.progress?.(params.delta,true);
                    } else if (message.method === 'turn/completed') {
                        const turn = record(params.turn);
                        if (turn?.status === 'failed') fail(generationError(turn.error || turnError));
                        else if (turn?.status === 'interrupted') fail(new Error(t('aiCodexCancelled')));
                        else if (turn?.status !== 'completed') fail(new Error(t('aiCodexInvalid')));
                        else if (!answer.trim()) fail(new Error(t('aiCodexEmpty')));
                        else finish?.resolve(answer);
                    }
                }
                const request = typeof message.id==='number' ? pending.get(message.id) : undefined;
                if (!request) continue;
                pending.delete(Number(message.id));
                if (message.error) request.reject(generation ? generationError(message.error) : new Error(t('aiCodexInvalid')));
                else request.resolve(record(message.result));
            } catch { fail(new Error(t('aiCodexInvalid'))); }
        }
    });
    const request = (method: string, params: object) => new Promise<Record<string,unknown>>((resolve, reject) => {
        if (failure) { reject(failure); return; }
        const id = ++nextId;
        pending.set(id, {resolve,reject});
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
                developerInstructions:'Return only the requested response. Never use tools or access files.',
                config:{project_doc_max_bytes:0,web_search:'disabled',mcp_servers:Object.fromEntries(Object.keys(servers).map(name=>[name,{enabled:false}]))},
            });
            const details = record(thread.thread);
            if (typeof details.id !== 'string' || !details.id || record(thread.sandbox).type !== 'readOnly'
                || thread.approvalPolicy !== 'never' || details.ephemeral !== true) throw new Error(t('aiCodexToolsDenied'));
            threadId = details.id;
            await request('turn/start',{threadId,input:[{type:'text',text:generation.input,text_elements:[]},...(generation.imageUrl ? [{type:'image',url:generation.imageUrl}] : [])],sandboxPolicy:{type:'readOnly',networkAccess:false},...(generation.schema ? {outputSchema:generation.schema} : {})});
            return await completed;
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
                models.set(model.model, {value:model.model,label:model.displayName});
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
const generate = (executable: string | null, system: string, input: string, model: string, signal?: AbortSignal, progress?: Progress, schema?: object, imageUrl?: string) => run(executable,signal,{system,input,model,progress,schema,imageUrl});
export {findCodex, listModels, generate};
