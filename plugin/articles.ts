import { t } from './i18n';
import {Article, Database, FeedEntry, Message, record} from './types';
import {parseHTML} from './html';
import {authorNames,authorsFromText} from './authors';

function header(message: Message, name: string) {
    return message.payload.headers?.find(h => h.name.toLowerCase() === name)?.value || '';
}

function sourceOf(message: Message) {
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

function isEditorialSource(source: string) {
    // Persisted source labels can come from either interface language or older versions.
    return ['Utilisateur (présumé)','User (inferred)','User'].includes(source);
}

function isPdf(value: string, contentType = '', disposition = '') {
    if (/^application\/(?:x-)?pdf(?:\s*;|\s*$)/i.test(contentType.trim())) return true;
    try {disposition = decodeURIComponent(disposition);} catch { /* Keep the original filename. */ }
    if (/filename\*?\s*=\s*(?:utf-8''|")?[^;]*\.pdf(?:"|;|$)/i.test(disposition.trim())) return true;
    try {
        const url = new URL(value);
        let path = url.pathname;
        try {path = decodeURIComponent(path);} catch { /* Keep the original path. */ }
        return /\.pdf$/i.test(path) || ((url.hostname==='arxiv.org' || url.hostname.endsWith('.arxiv.org')) && path.startsWith('/pdf/'))
            || [...url.searchParams].some(([key,value])=>
            /^(?:format|output)$/i.test(key) && /^pdf$/i.test(value)
            || /^(?:file|filename|document|attachment)$/i.test(key) && /\.pdf$/i.test(value));
    } catch {return false;}
}

function articleUrl(value: string, title = '') {
    let url;
    try {
        url = new URL(value);
        for (let depth = 0; depth < 3; depth++) {
            if (/(^|\.)google\.(?:com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/i.test(url.hostname)
                && ['/url', '/scholar_url'].includes(url.pathname)) {
                const target: string | null = url.searchParams.get('url') || url.searchParams.get('q');
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

function alertTargets(urls: string[]) {
    let found = false;
    const targets = new Set<string>();
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

function extractLinks(message: Message) {
    const links = new Map<string,{url: string; title: string}>();
    const rawUrls: string[] = [];
    const add = (raw: string, title = '') => {
        const url = articleUrl(raw, title);
        if (url && !links.has(url)) links.set(url, { url, title: title.trim() || url });
    };
    let hasHtmlLinks = false;
    for (const body of message.bodies.filter(body => body.type === 'text/html')) {
        const anchors = parseHTML(body.text).querySelectorAll('a[href]');
        hasHtmlLinks ||= anchors.length > 0;
        for (const anchor of anchors) {
            rawUrls.push(anchor.getAttribute('href') || '');
            if (anchor.closest('footer, nav, [role=contentinfo], [role=navigation]')) continue;
            add(anchor.getAttribute('href') || '', (anchor.textContent || '').replace(/\s+/g, ' '));
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

function articleTitle(link: {url: string; title: string}) {
    const fromUrl=/^https?:\/\//i.test(link.title);
    const url = new URL(link.url);
    let slug = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
    try { slug = decodeURIComponent(slug); } catch { /* Preserve the encoded slug when decoding fails. */ }
    slug=slug.replace(/\.(?:html?|php)$/i, '').replace(/_AN-\d+$/i, '');
    const suffix=slug.match(/[-_]([a-zA-Z0-9]+)$/)?.[1] || '';
    // Remove only opaque suffixes actually present in this article's URL.
    const opaque=/^(?=.*[a-zA-Z])(?=.*\d)(?:[A-Z0-9]{20,}|[a-f0-9]{32,64})$/.test(suffix);
    if (opaque) slug=slug.slice(0,-suffix.length-1);
    const fallback=slug.replace(/[-_]+/g, ' ');
    const title=fromUrl ? fallback : opaque
        ? link.title.replace(new RegExp('(?:^|[\\s_-]+)'+suffix+'\\s*$'),'').trim() || fallback : link.title;
    return !fromUrl || /[a-zA-Z]{3}/.test(title) ? title : url.hostname;
}

function messageArticles(message: Message): Omit<Article,'id'>[] {
    const date = new Date(Number(message.internalDate));
    return extractLinks(message).map(link => ({
        date: Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10),
        title: articleTitle(link),
        url: link.url,
        source: sourceOf(message),
        authors: [],
        status: isPdf(link.url) ? 'forbidden' : '',
        usedAt: '',
        publish: '',
        content: '',
        image: '',
    }));
}

function feedArticles(entries: FeedEntry[], feed: string, date: string): Omit<Article,'id'>[] {
    return entries.flatMap(entry=>{
        let url;
        try { url = articleUrl(new URL(entry.url,feed).href,entry.title); } catch { return []; }
        if (!url || !entry.url) return [];
        return [{date:entry.publish?.slice(0,10) || date,title:articleTitle({url,title:entry.title || url}),url,
            source:'RSS: '+new URL(feed).hostname,authors:[],status:isPdf(url) ? 'forbidden' : '',usedAt:'',publish:entry.publish || '',content:'',image:''}];
    });
}

function isExcluded(article: Pick<Article,'url' | 'source'>, exclusions: string) {
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

function assignIds(data: Database) {
    if (!data.articles.length && data.nextId === undefined) return data;
    let next = data.nextId ?? 1;
    if (!Number.isSafeInteger(next) || next < 1) throw new Error(t('invalidDataFile'));
    const assigned = new Set<number>();
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

function parseData(text: string): Database {
    let data: Record<string,unknown>;
    try { data = record(JSON.parse(text)); } catch { throw new Error(t('invalidDataFile')); }
    if (!data || data.version !== 1 || !Array.isArray(data.articles)
        || data.articles.some((value: unknown) => {const article=record(value);return ['date', 'title', 'url', 'source'].some(key => typeof article[key] !== 'string')
            || typeof article.title!=='string' || !article.title.trim() || typeof article.url!=='string' || !/^https?:\/\//i.test(article.url);})) {
        throw new Error(t('invalidDataFile'));
    }
    for (const value of data.articles as unknown[]) {
        const article = record(value);
        const legacyUsed=typeof article.used==='string' ? article.used : '';
        article.status ??= legacyUsed;
        if (article.used!==undefined && article.used!==0 && article.used!==1 && typeof article.used!=='string') throw new Error(t('invalidDataFile'));
        const wasUsed=article.status==='used' || article.used===1 || !['','404','forbidden','discard'].includes(legacyUsed);
        // Preserve undated legacy usage without inventing a publication date.
        if (wasUsed && !article.usedAt) article.usedAt='unknown';
        if (article.status==='used') article.status='';
        delete article.used;
        for (const key of ['status', 'usedAt', 'publish', 'content', 'image']) {
            article[key] ??= '';
            if (typeof article[key] !== 'string') throw new Error(t('invalidDataFile'));
        }
        article.authors ??= [];
        if (!Array.isArray(article.authors) || !article.authors.every((name: unknown)=>typeof name==='string')) throw new Error(t('invalidDataFile'));
        const names=authorNames(article.authors);
        article.authors=names.length ? names : authorsFromText(String(article.content));
        if (article.imageCaption !== undefined && typeof article.imageCaption !== 'string') throw new Error(t('invalidDataFile'));
        try { new URL(String(article.url)); } catch { throw new Error(t('invalidDataFile')); }
    }
    return assignIds(data as unknown as Database);
}

function withIds(text: string) {
    const data = parseData(text), before = record(JSON.parse(text));
    const articles = before.articles as unknown[];
    return data.nextId === before.nextId && data.articles.every((article,index)=>{
        const stored=record(articles[index]);
        return article.id===stored.id && !Object.hasOwn(stored,'used') && article.usedAt===stored.usedAt && article.status===stored.status
            && JSON.stringify(article.authors)===JSON.stringify(stored.authors);
    })
        ? text : JSON.stringify(data,null,2)+'\n';
}

function articleKeys(article: Pick<Article,'url' | 'title'>) {
    const url = new URL(articleUrl(article.url) || article.url);
    url.searchParams.sort();
    const urlKey = url.host.replace(/^www\./, '') + url.pathname.replace(/\/$/, '') + url.search;
    const titleKey = article.title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return {urlKey,titleKey};
}

function mergeArticles(text: string, incoming: Omit<Article,'id'>[]) {
    const data = parseData(text);
    const records = incoming.map(article=>{const copy: Partial<Article> = {...article};delete copy.id;return copy;});
    const newArticles = parseData(JSON.stringify({version:1,nextId:data.nextId,articles:records})).articles;
    const urls = new Map<string,number>(), titles = new Map<string,number>();
    const articles: Article[] = [];
    let count = 0;
    for (const [index, article] of [...data.articles, ...newArticles].entries()) {
        const {urlKey,titleKey} = articleKeys(article);
        const existing = urls.get(urlKey) ?? titles.get(titleKey);
        if (existing !== undefined) {
            const kept = articles[existing];
            if (isEditorialSource(article.source)) kept.source=article.source;
            for (const [key, value] of Object.entries(record(article))) {
                if (key!=='imageCaption' && !Object.hasOwn(kept, key)) Object.assign(kept,{[key]:value});
            }
            for (const key of ['status', 'publish', 'content', 'image'] as const) {
                if (!kept[key] && article[key]) kept[key] = article[key];
            }
            if (!kept.imageCaption && kept.image===article.image && article.imageCaption) kept.imageCaption = article.imageCaption;
            if (!kept.authors?.length && article.authors?.length) kept.authors=[...article.authors];
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

export { articleTitle, isEditorialSource, articleKeys, isPdf, articleUrl, sourceOf, extractLinks, isExcluded, messageArticles, feedArticles, parseData, withIds, mergeArticles };
