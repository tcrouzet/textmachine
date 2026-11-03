import { t } from './i18n';
import {isPdf} from './articles';
import {lookup} from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';

export interface Page {status: number; url: string; html: string; contentType?: string}
export type PageLoader = (url: string, signal: AbortSignal | undefined, isBlocked: (url: string)=>boolean)=>Promise<Page>;
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

async function publicUrl(value: string) {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || (url.port && !['80','443'].includes(url.port))) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    try {
        const addresses = isIP(host) ? [{address:host}] : await lookup(host, {all:true});
        return addresses.length > 0 && addresses.every(({address}) => publicAddress(address));
    } catch { return false; }
}

async function loadPage(url: string, signal: AbortSignal | undefined, isBlocked: (url: string)=>boolean, BrowserWindow: BrowserWindowConstructor): Promise<Page> {
    if (signal?.aborted) throw new Error(t('pluginDisabled'));
    const pdfPage = (target: string) => ({status:415,url:target,html:'',contentType:'application/pdf'});
    if (isPdf(url)) return pdfPage(url);
    if (!await publicUrl(url)) return {status:404, url, html:''};
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
    let status = 200, pdfUrl = '';
    session.webRequest.onHeadersReceived((details,callback) => {
        const header = (name: string) => Object.entries(details.responseHeaders || {}).find(([key])=>key.toLowerCase() === name)?.[1].join(';') || '';
        const pdf = isPdf(details.url,header('content-type'),header('content-disposition'));
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
    const timer = window.setTimeout(close, 25000);
    try {
        const userAgent = web.getUserAgent().replace(/\s(?:Electron|obsidian)\/\S+/gi, '');
        await win.loadURL(url, {userAgent});
        if (pdfUrl) return pdfPage(pdfUrl);
        if (status >= 400) return {status, url:web.getURL(), html:''};
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
        return {status, url:web.getURL(), html};
    } catch {
        if (signal?.aborted) throw new Error(t('pluginDisabled'));
        return pdfUrl ? pdfPage(pdfUrl) : {status:status >= 400 ? status : 404, url, html:''};
    } finally {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', close);
        close();
    }
}

export {loadPage, publicAddress, publicUrl};
