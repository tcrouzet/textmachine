const {t} = require('../i18n');
const {version} = require('../../manifest.json');
const {access, readdir, stat} = require('node:fs/promises');
const {constants} = require('node:fs');
const {homedir, tmpdir} = require('node:os');
const path = require('node:path');
const process = require('node:process');
const {spawn} = require('node:child_process');

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

async function run(executable, signal, generation) {
    if (!executable) throw new Error(t('aiCodexUnavailable'));
    if (signal?.aborted) throw new Error(t('aiCodexCancelled'));
    const disabled = ['apps','plugins','hooks','multi_agent','multi_agent_v2','shell_tool','unified_exec','code_mode','code_mode_host','computer_use','browser_use','image_generation','view_image'];
    const child = spawn(executable, ['app-server','--listen','stdio://', ...disabled.flatMap(feature => ['--disable',feature])],
        {cwd:tmpdir(), stdio:['pipe','pipe','pipe'], windowsHide:true, detached:process.platform !== 'win32'});
    const pending = new Map(), phases = new Map();
    let nextId = 0, buffer = '', stopped = false, failure, threadId = '', answer = '';
    let finish;
    const completed = generation ? new Promise((resolve,reject) => {finish = {resolve,reject};}) : null;
    completed?.catch(()=>{});
    const fail = error => {
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
    child.stdout.setEncoding('utf8').on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) { fail(new Error(t('aiCodexInvalid'))); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
            if (!line.trim()) continue;
            try {
                const message = JSON.parse(line);
                if (message.method && message.id !== undefined) { fail(new Error(t('aiCodexInvalid'))); return; }
                if (generation && message.method && threadId && message.params?.threadId === threadId) {
                    if (message.method === 'item/started' || message.method === 'item/completed') {
                        const item = message.params.item;
                        if (item?.id) phases.set(item.id,item.phase);
                        if (!['agentMessage','userMessage','reasoning'].includes(item?.type)) {fail(new Error(t('aiCodexToolsDenied')));return;}
                        if (message.method === 'item/started' && item.type === 'reasoning') generation.progress?.(t('aiThinking'));
                        if (message.method === 'item/completed' && item.type === 'agentMessage' && item.phase === 'commentary') generation.progress?.(item.text);
                        if (message.method === 'item/completed' && item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string') answer = item.text;
                    } else if (message.method === 'item/agentMessage/delta' && typeof message.params.delta === 'string' && phases.get(message.params.itemId) !== 'commentary') {
                        generation.progress?.(message.params.delta,true);
                    } else if (message.method === 'turn/completed') {
                        if (message.params.turn?.status !== 'completed' || !answer.trim()) fail(new Error(t('newsletterIncomplete')));
                        else finish.resolve(answer);
                    }
                }
                const request = pending.get(message.id);
                if (!request) continue;
                pending.delete(message.id);
                if (message.error) request.reject(new Error(t('aiCodexInvalid')));
                else request.resolve(message.result);
            } catch { fail(new Error(t('aiCodexInvalid'))); }
        }
    });
    const request = (method, params) => new Promise((resolve, reject) => {
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
            if (!config?.config || typeof config.config !== 'object') throw new Error(t('aiCodexInvalid'));
            const servers = config.config.mcp_servers || {};
            const thread = await request('thread/start',{
                ...(generation.model ? {model:generation.model} : {}),
                cwd:tmpdir(), ephemeral:true, approvalPolicy:'never', sandbox:'read-only',
                baseInstructions:generation.system,
                developerInstructions:'Return only the requested response. Never use tools or access files.',
                config:{project_doc_max_bytes:0,web_search:'disabled',mcp_servers:Object.fromEntries(Object.keys(servers).map(name=>[name,{enabled:false}]))},
            });
            threadId = thread?.thread?.id;
            if (typeof threadId !== 'string' || !threadId || thread?.sandbox?.type !== 'readOnly'
                || thread.approvalPolicy !== 'never' || thread.thread.ephemeral !== true) throw new Error(t('aiCodexToolsDenied'));
            await request('turn/start',{threadId,input:[{type:'text',text:generation.input,text_elements:[]},...(generation.imageUrl ? [{type:'image',url:generation.imageUrl}] : [])],sandboxPolicy:{type:'readOnly',networkAccess:false},...(generation.schema ? {outputSchema:generation.schema} : {})});
            return await completed;
        }
        const models = new Map(), cursors = new Set();
        let cursor = null;
        do {
            if (cursor && cursors.has(cursor)) throw new Error(t('aiCodexInvalid'));
            if (cursor) cursors.add(cursor);
            const page = await request('model/list', {limit:100,includeHidden:false,cursor});
            if (!Array.isArray(page?.data) || (page.nextCursor != null && typeof page.nextCursor !== 'string')) throw new Error(t('aiCodexInvalid'));
            for (const model of page.data) {
                if (model?.hidden === true) continue;
                if (typeof model?.model !== 'string' || !model.model.trim() || model.model.length > 200
                    || typeof model.displayName !== 'string' || !model.displayName.trim() || model.displayName.length > 200) throw new Error(t('aiCodexInvalid'));
                models.set(model.model, {value:model.model,label:model.displayName});
            }
            cursor = page.nextCursor || null;
        } while (cursor);
        return [...models.values()];
    } finally {
        stopped = true;
        signal?.removeEventListener('abort', abort);
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null) {
            const kill = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already stopped. */ } };
            const fallback = setTimeout(() => kill('SIGKILL'), 1500);
            child.once('close', () => clearTimeout(fallback));
            kill('SIGTERM');
        }
    }
}

const listModels = (executable, signal) => run(executable, signal);
const generate = (executable, system, input, model, signal, progress, schema, imageUrl) => run(executable,signal,{system,input,model,progress,schema,imageUrl});
module.exports = {findCodex, listModels, generate};
