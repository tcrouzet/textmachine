const { t } = require('./i18n');

function header(message, name) {
    return message.payload.headers?.find(h => h.name.toLowerCase() === name)?.value || '';
}

function sourceOf(message) {
    const from = header(message, 'from');
    const address = (from.match(/<([^<>]+)>/)?.[1] || from).trim().toLowerCase();
    const body = (message.bodies || []).map(part => part.text).join('\n');
    if (address === 'googlealerts-noreply@google.com' || /googlealerts-noreply@google\.com|https?:\/\/(?:www\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2})\/alerts[/?]/i.test(body)) return 'Google Alerts';
    if (address === 'scholaralerts-noreply@google.com' || /scholaralerts-noreply@google\.com|scholar\.google\.com\/scholar_alerts/i.test(body)) return 'Google Scholar';
    if (header(message, 'list-id') || header(message, 'list-unsubscribe')
        || /^(bulk|list)$/i.test(header(message, 'precedence'))
        || /^(auto-generated|auto-replied)$/i.test(header(message, 'auto-submitted'))
        || /(?:no-?reply|notifications?|alerts?)@/.test(address)) {
        return t('serviceSource');
    }
    return t('userSource');
}

function isPdf(value, contentType = '', disposition = '') {
    if (/^application\/(?:x-)?pdf(?:\s*;|\s*$)/i.test(contentType.trim())) return true;
    try {disposition = decodeURIComponent(disposition);} catch { /* Keep the original filename. */ }
    if (/filename\*?\s*=\s*(?:utf-8''|")?[^;]*\.pdf(?:"|;|$)/i.test(disposition.trim())) return true;
    try {
        const url = new URL(value);
        let path = url.pathname;
        try {path = decodeURIComponent(path);} catch { /* Keep the original path. */ }
        return /\.pdf$/i.test(path) || [...url.searchParams].some(([key,value])=>
            /^(?:format|output)$/i.test(key) && /^pdf$/i.test(value)
            || /^(?:file|filename|document|attachment)$/i.test(key) && /\.pdf$/i.test(value));
    } catch {return false;}
}

function articleUrl(value, title = '') {
    let url;
    try {
        url = new URL(value);
        for (let depth = 0; depth < 3; depth++) {
            if (/(^|\.)google\.(?:com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/i.test(url.hostname)
                && ['/url', '/scholar_url'].includes(url.pathname)) {
                const target = url.searchParams.get('url') || url.searchParams.get('q');
                if (!target) return null;
                url = new URL(target);
            } else break;
        }
    } catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (/unsubscribe|désabonn|desabonn|manage preferences|gérer.*abonnement|view in browser|voir dans.*navigateur|signaler comme|report as|modifier.*alerte|edit.*alert|afficher plus|view more|envoyer des commentaires|send feedback|toute l.actualité sur ce thème/i.test(title)
        || /(^|\.)google\.(?:com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/i.test(url.hostname)
        || /(^|\.)(?:facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|youtu\.be|reddit\.com|tiktok\.com|apps\.apple\.com|play\.google\.com)$/i.test(url.hostname)
        || /\/(?:unsubscribe|optout|preferences|settings|login|signin|signup|register|subscribe|contact|about|privacy|terms|search|tags?|category|categories|apps?|sharer|share|intent\/tweet)(?:[/.?]|$)/i.test(url.pathname)
        || /\.(?:png|jpe?g|gif|svg|webp|ico|css|js)$/i.test(url.pathname)
        || /^\/(?:[a-z]{2}\/?)?$/i.test(url.pathname)
        || /^\/(?:news|articles|culture|science|politics|technology|latest|home)\/?$/i.test(url.pathname)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
        if (/^utm_|^(?:gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href.replace(/\|/g, '%7C');
}

function alertTargets(urls) {
    let found = false;
    const targets = new Set();
    for (const value of urls) {
        let url;
        try { url = new URL(value); } catch { continue; }
        if (!/(^|\.)google\.(?:com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/i.test(url.hostname)
            || url.pathname !== '/alerts/feedback') continue;
        found = true;
        const target = articleUrl(url.searchParams.get('ffu') || '');
        if (target) targets.add(target);
    }
    return found ? targets : null;
}

function extractLinks(message) {
    const links = new Map();
    const rawUrls = [];
    const add = (raw, title = '') => {
        const url = articleUrl(raw, title);
        if (url && !links.has(url)) links.set(url, { url, title: title.trim() || url });
    };
    // HTML is parsed in an inert template: no scripts, images or tracking requests run.
    let hasHtmlLinks = false;
    for (const body of message.bodies.filter(body => body.type === 'text/html')) {
        const template = document.createElement('template');
        template.innerHTML = body.text;
        const anchors = template.content.querySelectorAll('a[href]');
        hasHtmlLinks ||= anchors.length > 0;
        for (const anchor of anchors) {
            rawUrls.push(anchor.getAttribute('href'));
            if (anchor.closest('footer, nav, [role=contentinfo], [role=navigation]')) continue;
            add(anchor.getAttribute('href'), anchor.textContent.replace(/\s+/g, ' '));
        }
    }
    for (const body of hasHtmlLinks ? [] : message.bodies.filter(body => body.type === 'text/plain')) {
        for (const match of body.text.matchAll(/https?:\/\/[^\s<>"[\]]+/gi)) {
            let url = match[0].replace(/[.,;:!?]+$/, '');
            while (url.endsWith(')') && (url.match(/\)/g)?.length || 0) > (url.match(/\(/g)?.length || 0)) url = url.slice(0, -1);
            rawUrls.push(url);
            add(url);
        }
    }
    const targets = alertTargets(rawUrls);
    return [...links.values()].filter(link => !targets || targets.has(link.url));
}

function articleTitle(link) {
    if (!/^https?:\/\//i.test(link.title)) return link.title;
    const url = new URL(link.url);
    let slug = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
    try { slug = decodeURIComponent(slug); } catch { /* Preserve the encoded slug when decoding fails. */ }
    const title = slug.replace(/\.(?:html?|php)$/i, '').replace(/_AN-\d+$/i, '').replace(/[-_]+/g, ' ');
    return /[a-zA-Z]{3}/.test(title) ? title : url.hostname;
}

function messageArticles(message) {
    const date = new Date(Number(message.internalDate));
    return extractLinks(message).map(link => ({
        date: Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10),
        title: articleTitle(link),
        url: link.url,
        source: sourceOf(message),
        status: isPdf(link.url) ? 'forbidden' : '',
        publish: '',
        content: '',
        image: '',
    }));
}

function isExcluded(article, exclusions) {
    const host = new URL(article.url).hostname.toLowerCase().replace(/^www\./, '');
    const source = article.source.trim().toLowerCase();
    return exclusions.split(/[\n,]/).some(value => {
        let rule = value.trim().toLowerCase();
        if (!rule) return false;
        if (rule === source) return true;
        if (/^[a-z0-9-]+$/.test(rule)) {
            return host.split('.').includes(rule)
                || (rule === 'youtube' && (host === 'youtu.be' || host.endsWith('.youtu.be')));
        }
        try { rule = new URL(rule.includes('://') ? rule : 'https://' + rule).hostname.replace(/^www\./, ''); }
        catch { return false; }
        return host === rule || host.endsWith('.' + rule);
    });
}

function assignIds(data) {
    if (!data.articles.length && data.nextId === undefined) return data;
    let next = data.nextId ?? 1;
    if (!Number.isSafeInteger(next) || next < 1) throw new Error(t('invalidDataFile'));
    const assigned = new Set();
    for (const article of data.articles) {
        if (article.id === undefined) continue;
        if (!Number.isSafeInteger(article.id) || article.id < 1 || assigned.has(article.id)) throw new Error(t('invalidDataFile'));
        assigned.add(article.id);
        next = Math.max(next,article.id+1);
    }
    for (const article of data.articles) {
        if (article.id === undefined) article.id = next++;
    }
    if (!Number.isSafeInteger(next)) throw new Error(t('invalidDataFile'));
    data.nextId = next;
    return data;
}

function parseData(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(t('invalidDataFile')); }
    if (!data || data.version !== 1 || !Array.isArray(data.articles)
        || data.articles.some(article => !article || ['date', 'title', 'url', 'source'].some(key => typeof article[key] !== 'string')
            || !article.title.trim() || !/^https?:\/\//i.test(article.url))) {
        throw new Error(t('invalidDataFile'));
    }
    for (const article of data.articles) {
        article.status ??= article.used ?? '';
        delete article.used;
        for (const key of ['status', 'publish', 'content', 'image']) {
            article[key] ??= '';
            if (typeof article[key] !== 'string') throw new Error(t('invalidDataFile'));
        }
        try { new URL(article.url); } catch { throw new Error(t('invalidDataFile')); }
    }
    return assignIds(data);
}

function withIds(text) {
    const data = parseData(text), before = JSON.parse(text);
    return data.nextId === before.nextId && data.articles.every((article,index)=>article.id === before.articles[index].id)
        ? text : JSON.stringify(data,null,2)+'\n';
}

function mergeArticles(text, incoming) {
    const data = parseData(text);
    const records = incoming.map(article=>{const copy = {...article};delete copy.id;return copy;});
    const newArticles = parseData(JSON.stringify({version:1,nextId:data.nextId,articles:records})).articles;
    const urls = new Map(), titles = new Map();
    const articles = [];
    let count = 0;
    for (const [index, article] of [...data.articles, ...newArticles].entries()) {
        const url = new URL(articleUrl(article.url) || article.url);
        url.searchParams.sort();
        const urlKey = url.host.replace(/^www\./, '') + url.pathname.replace(/\/$/, '') + url.search;
        const titleKey = article.title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const existing = urls.get(urlKey) ?? titles.get(titleKey);
        if (existing !== undefined) {
            const kept = articles[existing];
            for (const [key, value] of Object.entries(article)) {
                if (!Object.hasOwn(kept, key)) kept[key] = value;
            }
            for (const key of ['status', 'publish', 'content', 'image']) {
                if (!kept[key] && article[key]) kept[key] = article[key];
            }
            urls.set(urlKey, existing);
            titles.set(titleKey, existing);
            continue;
        }
        urls.set(urlKey, articles.length);
        titles.set(titleKey, articles.length);
        articles.push({ ...article });
        if (index >= data.articles.length) count++;
    }
    return { text: JSON.stringify(assignIds({ ...data, articles }), null, 2) + '\n', count, added: count > 0 };
}

module.exports = { isPdf, articleUrl, sourceOf, extractLinks, isExcluded, messageArticles, parseData, withIds, mergeArticles };
