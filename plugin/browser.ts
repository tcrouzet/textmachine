import { t } from './i18n';
import {isPdf} from './articles';
import {lookup} from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import {extractPage} from './crawler';
import {errorOf} from './types';

export interface Page {status: number; url: string; html: string; contentType?: string; failure?: string}
export type PageLoader = (url: string, signal: AbortSignal | undefined, isBlocked: (url: string)=>boolean)=>Promise<Page>;
export type PageObserver = (method: 'http' | 'browser', page: Page, elapsedMs: number)=>void;

export function failureCode(caught: unknown) {
    const error=errorOf(caught);
    return error.code && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code
        : /\bERR_[A-Z0-9_]+\b/.exec(error.message)?.[0] || 'request-error';
}
interface RequestDetails {url: string; resourceType: string; responseHeaders?: Record<string,string[]>}
interface WebContents {
    session: {
        setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (allowed: boolean)=>void)=>void): void;
        setPermissionCheckHandler(handler: ()=>boolean): void;
        on(event: 'will-download', handler: (event: {preventDefault(): void})=>void): void;
        webRequest: {
            onHeadersReceived(handler: (details: RequestDetails, callback: (response: {cancel: boolean})=>void)=>void): void;
            onBeforeRequest(handler: (details: RequestDetails, callback: (response: {cancel: boolean})=>void)=>void): void;
        };
    };
    setWindowOpenHandler(handler: ()=>{action: 'deny'}): void;
    on(event: 'did-navigate', handler: (event: unknown, url: string, code: number)=>void): void;
    isDestroyed(): boolean;
    getUserAgent(): string;
    getURL(): string;
    executeJavaScript(script: string): Promise<unknown>;
}
export interface BrowserWindowConstructor {
    new(options: {show: boolean; webPreferences: {partition: string; sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean; webSecurity: boolean; backgroundThrottling: boolean}}): {
        webContents: WebContents; isDestroyed(): boolean; destroy(): void; loadURL(url: string, options: {userAgent: string}): Promise<void>;
    };
}

function publicAddress(address: string) {
    if (isIP(address) === 4) {
        const [a,b] = address.split('.').map(Number);
        return a > 0 && a < 224 && ![10,127].includes(a)
            && !(a === 100 && b >= 64 && b <= 127)
            && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
            && !(a === 192 && [0,168].includes(b)) && !(a === 198 && [18,19,51].includes(b))
            && !(a === 203 && b === 0);
    }
    return isIP(address) === 6 && /^[23]/i.test(address) && !/^2002:|^2001:(?:0*:|db8:)/i.test(address);
}

async function publicTarget(value: string) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || (url.port && !['80','443'].includes(url.port))) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    try {
        const addresses = isIP(host) ? [{address:host}] : await lookup(host, {all:true});
        return addresses.length && addresses.every(({address}) => publicAddress(address)) ? {url,address:addresses[0].address} : null;
    } catch { return null; }
}

async function publicUrl(value: string) { return !!await publicTarget(value); }

type Transport = (url: URL, options: https.RequestOptions, callback: (response: http.IncomingMessage)=>void)=>http.ClientRequest;

async function fetchPage(url: string, signal?: AbortSignal, isBlocked: (url: string)=>boolean = ()=>false,
    transport: Transport = (url,options,callback)=>(url.protocol==='https:' ? https : http).request(url,options,callback)): Promise<Page> {
    const visited=new Set<string>(), deadline=Date.now()+10000;
    let current=url;
    const failed = (failure: string): Page=>({status:404,url:current,html:'',failure});
    try {
        for (let redirects=0;redirects<=5;redirects++) {
            if (signal?.aborted) throw new Error(t('pluginDisabled'));
            if (isPdf(current)) return {status:415,url:current,html:'',contentType:'application/pdf'};
            if (visited.has(current)) return failed('redirect-loop');
            if (isBlocked(current)) return failed('blocked-domain');
            if (Date.now()>=deadline) return failed('ETIMEDOUT');
            visited.add(current);
            const target=await publicTarget(current);
            if (!target || signal?.aborted) {if (signal?.aborted) throw new Error(t('pluginDisabled'));return failed('invalid-or-unreachable-address');}
            const response=await new Promise<Page & {location?: string}>((resolve,reject)=>{
                const request=transport(target.url,{
                    hostname:target.address,
                    ...(target.url.protocol==='https:' && !isIP(target.url.hostname.replace(/^\[|\]$/g,'')) ? {servername:target.url.hostname} : {}),
                    method:'GET',signal,agent:false,
                    headers:{Host:target.url.host,
                        'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
                        Accept:'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language':'fr-FR,fr;q=0.9,en;q=0.8','Accept-Encoding':'identity'},
                },response=>{
                    const status=response.statusCode || 0;
                    const contentType=response.headers['content-type'] || '';
                    if (isPdf(current,contentType,response.headers['content-disposition'] || '')) {
                        response.destroy();resolve({status:415,url:current,html:'',contentType:'application/pdf'});return;
                    }
                    if ([301,302,303,307,308].includes(status) && response.headers.location) {
                        response.destroy();resolve({status,url:current,html:'',location:response.headers.location});return;
                    }
                    if (status<200 || status>=300 || (contentType && !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType))) {
                        response.destroy();resolve({status,url:current,html:'',contentType});return;
                    }
                    const chunks: Buffer[]=[];
                    let size=0;
                    response.on('data',(chunk: Buffer)=>{
                        size+=chunk.length;
                        if (size>10000000) {request.destroy(Object.assign(new Error('Article response too large'),{code:'RESPONSE_TOO_LARGE'}));return;}
                        chunks.push(chunk);
                    });
                    response.on('error',reject);
                    response.on('end',()=>{
                        try {
                            const charset=/charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] || 'utf-8';
                            resolve({status,url:current,html:new TextDecoder(charset).decode(Buffer.concat(chunks)),contentType});
                        } catch (error) {reject(error);}
                    });
                });
                const timer=window.setTimeout(()=>request.destroy(Object.assign(new Error('Article request timed out'),{code:'ETIMEDOUT'})),Math.max(1,deadline-Date.now()));
                request.on('error',reject);
                request.once('close',()=>window.clearTimeout(timer));
                request.end();
            });
            if (!response.location) return response;
            current=new URL(response.location,current).href;
        }
    } catch (caught) {
        if (signal?.aborted) throw new Error(t('pluginDisabled'));
        return failed(failureCode(caught));
    }
    return failed('too-many-redirects');
}

async function retrievePage(url: string, signal: AbortSignal | undefined, isBlocked: (url: string)=>boolean, BrowserWindow: BrowserWindowConstructor, directFetch: PageLoader=fetchPage, observe?: PageObserver): Promise<Page> {
    if (signal?.aborted) throw new Error(t('pluginDisabled'));
    if (isPdf(url)) return {status:415,url,html:'',contentType:'application/pdf'};
    if (isBlocked(url)) return {status:404,url,html:''};
    const start=Date.now();
    const direct=await directFetch(url,signal,isBlocked);
    observe?.('http',direct,Date.now()-start);
    if (isPdf(direct.url,direct.contentType) || (direct.status>=200 && direct.status<300 && direct.html && extractPage(direct.html,direct.url).content)) return direct;
    const browserStart=Date.now();
    const page=await loadPage(url,signal,isBlocked,BrowserWindow);
    observe?.('browser',page,Date.now()-browserStart);
    return page;
}

async function loadPage(url: string, signal: AbortSignal | undefined, isBlocked: (url: string)=>boolean, BrowserWindow: BrowserWindowConstructor): Promise<Page> {
    if (signal?.aborted) throw new Error(t('pluginDisabled'));
    const pdfPage = (target: string) => ({status:415,url:target,html:'',contentType:'application/pdf'});
    if (isPdf(url)) return pdfPage(url);
    if (!await publicUrl(url)) return {status:404, url, html:'',failure:'invalid-or-unreachable-address'};
    if (signal?.aborted) throw new Error(t('pluginDisabled'));
    const win = new BrowserWindow({show:false, webPreferences:{
        partition:'text-machine-' + randomUUID(), sandbox:true, contextIsolation:true,
        nodeIntegration:false, webSecurity:true, backgroundThrottling:false,
    }});
    const web = win.webContents, session = web.session;
    web.setWindowOpenHandler(() => ({action:'deny'}));
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on('will-download', event => event.preventDefault());
    let status = 200, pdfUrl = '', contentType = '', timedOut = false;
    session.webRequest.onHeadersReceived((details,callback) => {
        const header = (name: string) => Object.entries(details.responseHeaders || {}).find(([key])=>key.toLowerCase() === name)?.[1].join(';') || '';
        const pdf = isPdf(details.url,header('content-type'),header('content-disposition'));
        if (details.resourceType === 'mainFrame') contentType=header('content-type');
        if (pdf && details.resourceType === 'mainFrame') pdfUrl = details.url;
        callback({cancel:pdf});
    });
    session.webRequest.onBeforeRequest((details, callback) => {
        if (isPdf(details.url)) {
            if (details.resourceType === 'mainFrame') pdfUrl = details.url;
            callback({cancel:true});return;
        }
        if (details.url === 'about:blank') { callback({cancel:false}); return; }
        if (isBlocked(details.url)) { callback({cancel:true}); return; }
        void publicUrl(details.url).then(allowed => {
            if (!web.isDestroyed()) callback({cancel:!allowed});
        });
    });
    web.on('did-navigate', (_event, _url, responseCode) => {
        if (responseCode > 0) status = responseCode;
    });
    const close = () => { if (!win.isDestroyed()) win.destroy(); };
    signal?.addEventListener('abort', close, {once:true});
    const timer = window.setTimeout(()=>{timedOut=true;close();}, 25000);
    try {
        const userAgent = web.getUserAgent().replace(/\s(?:Electron|obsidian)\/\S+/gi, '');
        await win.loadURL(url, {userAgent});
        if (pdfUrl) return pdfPage(pdfUrl);
        if (status >= 400) return {status, url:web.getURL(), html:'',contentType};
        await web.executeJavaScript(`new Promise(resolve => {
            let quiet;
            const finish = () => { window.clearTimeout(quiet); window.clearTimeout(limit); observer.disconnect(); resolve(); };
            const observer = new MutationObserver(() => { window.clearTimeout(quiet); quiet = window.setTimeout(finish, 750); });
            const limit = window.setTimeout(finish, 5000);
            observer.observe(document.documentElement, {childList:true, subtree:true, characterData:true});
            quiet = window.setTimeout(finish, 750);
        })`);
        const html = await web.executeJavaScript('document.documentElement.outerHTML.slice(0, 10000000)');
        if (typeof html!=='string') throw new Error(t('invalidMessageContent'));
        return {status, url:web.getURL(), html,contentType};
    } catch (caught) {
        if (signal?.aborted) throw new Error(t('pluginDisabled'));
        return pdfUrl ? pdfPage(pdfUrl) : {status:status >= 400 ? status : 404, url:web.isDestroyed() ? url : web.getURL() || url, html:'',contentType,
            failure:timedOut ? 'ETIMEDOUT' : failureCode(caught)};
    } finally {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', close);
        close();
    }
}

export {loadPage, fetchPage, retrievePage, publicAddress, publicUrl};
