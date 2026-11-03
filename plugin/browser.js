const { t } = require('./i18n');
const { lookup } = require('node:dns').promises;
const { isIP } = require('node:net');
const { randomUUID } = require('node:crypto');

function publicAddress(address) {
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

async function publicUrl(value) {
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

async function loadPage(url, signal, isBlocked, BrowserWindow) {
    if (signal?.aborted) throw new Error(t('pluginDisabled'));
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
    let status = 200;
    session.webRequest.onBeforeRequest((details, callback) => {
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
    const timer = setTimeout(close, 25000);
    try {
        const userAgent = web.getUserAgent().replace(/\s(?:Electron|obsidian)\/\S+/gi, '');
        await win.loadURL(url, {userAgent});
        if (status >= 400) return {status, url:web.getURL(), html:''};
        await web.executeJavaScript(`new Promise(resolve => {
            let quiet;
            const finish = () => { clearTimeout(quiet); clearTimeout(limit); observer.disconnect(); resolve(); };
            const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(finish, 750); });
            const limit = setTimeout(finish, 5000);
            observer.observe(document.documentElement, {childList:true, subtree:true, characterData:true});
            quiet = setTimeout(finish, 750);
        })`);
        const html = await web.executeJavaScript('document.documentElement.outerHTML.slice(0, 10000000)');
        return {status, url:web.getURL(), html};
    } catch {
        if (signal?.aborted) throw new Error(t('pluginDisabled'));
        return {status:status >= 400 ? status : 404, url, html:''};
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', close);
        close();
    }
}

module.exports = {loadPage, publicAddress, publicUrl};
