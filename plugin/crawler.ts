import { t } from './i18n';
import {isPdf} from './articles';

import {domainOf} from './domains';
import {Article, record} from './types';
import {parseHTML} from './html';
import {authorNames} from './authors';
import Readability from '../scripts/vendor/readability/Readability';
import type {PageLoader} from './browser';

function parseBlocked(text: string): string[] {
    try {
        const value: unknown = JSON.parse(text), data=record(value);
        const entries: unknown[] | null = Array.isArray(value) ? value : data.version === 1 && Array.isArray(data.blocked)
            ? (data.blocked as unknown[]).map(entry => record(entry).url) : null;
        if (!entries || !entries.every((entry): entry is string => typeof entry === 'string' && !!entry.trim())) throw new Error();
        return [...new Set(entries.map(domainOf))];
    } catch { throw new Error(t('invalidBlockedFile')); }
}

function isBlocked(url: string, data: string[]) {
    try { return data.includes(domainOf(url)); } catch { return false; }
}

function block(data: string[], url: string) {
    const domain = domainOf(url);
    if (!data.includes(domain)) data.push(domain);
}

function publicationDate(input: unknown) {
    if (typeof input !== 'string') return '';
    const value = input.trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value);
    const valid = (year: string | number, month: string | number, day: string | number) => {
        const date = new Date(Date.UTC(+year, +month - 1, +day));
        return date.getUTCFullYear() === +year && date.getUTCMonth() === +month - 1 && date.getUTCDate() === +day;
    };
    if (iso) return valid(iso[1],iso[2],iso[3]) && Number.isFinite(Date.parse(value)) ? value : '';
    const months = ['janvier janv january jan', 'fevrier fevr february feb', 'mars march mar', 'avril april apr', 'mai may', 'juin june jun',
        'juillet juil july jul', 'aout august aug', 'septembre september sep sept', 'octobre october oct', 'novembre november nov', 'decembre december dec'];
    const normalized = value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    let parts: string[] | null = /\b(\d{1,2})(?:er|st|nd|rd|th)?\s+([a-z]+)\.?\s+(\d{4})\b/.exec(normalized);
    if (!parts) {
        const english = /\b([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/.exec(normalized);
        if (english) parts = [english[0], english[2], english[1], english[3]];
    }
    if (!parts) return '';
    const month = months.findIndex(names => names.split(' ').includes(parts[2])) + 1;
    return month && valid(parts[3], month, parts[1]) ? `${parts[3]}-${String(month).padStart(2,'0')}-${parts[1].padStart(2,'0')}` : '';
}

function dateFromDocument(doc: Document, structured?: Record<string,unknown>) {
    const candidates = [structured?.datePublished];
    const names = new Set(['article:published_time','og:published_time','datepublished','date','pubdate','publishdate',
        'publish-date','publication_date','dc.date','dc.date.issued','dcterms.issued','dcterms.created',
        'parsely-pub-date','sailthru.date','citation_publication_date']);
    for (const node of doc.querySelectorAll('meta')) {
        const name = (node.getAttribute('property') || node.getAttribute('name') || node.getAttribute('itemprop') || '').toLowerCase();
        if (names.has(name)) candidates.push(node.getAttribute('content'));
    }
    for (const node of doc.querySelectorAll('[itemprop="datePublished"], time')) {
        if (node.matches('[itemprop="dateModified"]') || node.closest('footer, nav, [class*="comment"], [class*="updated"], [class*="modified"]')) continue;
        candidates.push(node.getAttribute('datetime'), node.getAttribute('content'), node.textContent);
    }
    for (const node of doc.querySelectorAll('article [class*="publish"], article [class*="date"], article [class*="dateline"], main [class*="publish"]')) {
        if (!/modif|updat/i.test(node.className)) candidates.push(node.textContent);
    }
    return candidates.map(publicationDate).find(Boolean) || '';
}

function pageDocument(html: string, url: string) {
    const doc = parseHTML(html);
    doc.querySelectorAll('base').forEach(node => node.remove());
    (doc.head || doc.documentElement).createEl('base',{attr:{href:url},prepend:true});
    return doc;
}

function imageKey(value: unknown, base: string) {
    if (typeof value!=='string' || !value.trim()) return '';
    try {
        let url = new URL(value,base);
        let path = url.pathname;
        try { path = decodeURIComponent(path); } catch { /* Preserve the publisher URL. */ }
        const embedded = path.match(/https?:\/\/.+$/)?.[0];
        if (embedded) url = new URL(embedded);
        if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return '';
        for (const key of ['w','width','h','height','q','quality','fit','auto']) url.searchParams.delete(key);
        url.searchParams.sort();
        url.hash = '';
        return url.href;
    } catch { return ''; }
}

function captionFromDocument(doc: Document, image: string, url: string, structured?: Record<string,unknown>) {
    const key = imageKey(image,url);
    if (!key) return '';
    const text = (node: Node | null) => node?.textContent?.replace(/\s+/g,' ').trim() || '';
    const combine = (parts: string[]) => parts.filter((part,index)=>part && !parts.some((other,i)=>i!==index && other && other.includes(part) && (other!==part || i<index))).join(' ');
    for (const img of doc.querySelectorAll('img')) {
        const candidates = ['src','data-src','data-original','data-lazy-src'].map(name=>img.getAttribute(name)).filter(Boolean);
        candidates.push(...(img.getAttribute('srcset') || '').split(/\s+/).filter(value=>!/^\d+(?:\.\d+)?[wx],?$/.test(value)).map(value=>value.replace(/,$/,'')));
        if (!candidates.some(value=>imageKey(value,url)===key)) continue;
        const scope = img.closest('figure, [itemprop="image"], .image-container, .article-image, .photo')
            || img.closest('picture')?.parentElement || img.parentElement;
        const described = (img.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean).map(id=>text(doc.getElementById(id)));
        const captions = scope && !/^(?:ARTICLE|MAIN|BODY|HTML)$/.test(scope.tagName)
            && (scope.tagName==='FIGURE' || scope.querySelectorAll('img').length===1)
            ? [...scope.querySelectorAll('figcaption, [itemprop="caption"], [class*="caption"], [class*="credit"]')].map(text) : [];
        const caption = combine([...captions,...described]);
        if (caption) return caption;
    }
    for (const entry of [structured?.image].flat()) {
        const value=record(entry);
        if (imageKey(value.url || value.contentUrl,url)!==key) continue;
        if (typeof value.caption === 'string' && value.caption.trim()) {
            return combine([value.caption,value.creditText,value.copyrightNotice].filter((value): value is string=>typeof value==='string').map(value=>value.trim()));
        }
    }
    return '';
}

function extractImageCaption(html: string, url: string, image: string) {
    const doc = pageDocument(html,url), images: Record<string,unknown>[] = [];
    const visit = (input: unknown): void => {
        if (Array.isArray(input)) {input.forEach(visit);return;}
        const value=record(input);
        if (!value || typeof value!=='object') return;
        if (typeof value.caption==='string') images.push(value);
        Object.values(value).forEach(visit);
    };
    for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try { visit(JSON.parse(node.textContent || '')); } catch { /* Ignore malformed publisher metadata. */ }
    }
    return captionFromDocument(doc,image,url,{image:images});
}

function extractPage(html: string, url: string): {blocked?: boolean; content?: string; publish?: string; authors?: string[]; image?: string; imageCaption?: string} {
    const doc = pageDocument(html,url);
    const meta = (name: string) => doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') || '';
    const title = doc.querySelector('title')?.textContent || '';
    if (/^(?:just a moment|access denied|attention required|verify (?:you|your)|verifying device|security check|checking your browser|accès refusé)/i.test(title.trim())
        || doc.querySelector('#challenge-running, #challenge-form, form[action*="captcha"]')) {
        return {blocked:true};
    }
    let structured: Record<string,unknown> | undefined;
    const references=new Map<string,Record<string,unknown>>();
    const visit = (input: unknown): void => {
        if (Array.isArray(input)) {input.forEach(visit);return;}
        const value=record(input);
        if (!value || typeof value !== 'object') return;
        if (typeof value['@id']==='string') references.set(value['@id'],value);
        if ([value['@type']].flat().some(type => typeof type === 'string' && /(?:^|[/#])(?:\w*Article|BlogPosting|Report)$/.test(type))) {
            structured ||= value;
            if (!structured.datePublished && value.datePublished) structured = {...structured, datePublished:value.datePublished};
            return;
        }
        for (const child of Object.values(value)) {
            if (Array.isArray(child)) child.forEach(visit);
            else if (child && typeof child === 'object') visit(child);
        }
    };
    for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try { visit(JSON.parse(node.textContent || '')); } catch { /* Ignore malformed publisher metadata. */ }
    }
    const restricted=structured?.isAccessibleForFree===false || /^false$/i.test(String(structured?.isAccessibleForFree));
    const published = dateFromDocument(doc, structured);
    let rawImage: unknown = meta('og:image') || meta('twitter:image') || structured?.image || '';
    if (Array.isArray(rawImage)) rawImage = (rawImage as unknown[])[0];
    if (rawImage && typeof rawImage === 'object') rawImage = record(rawImage).url || record(rawImage).contentUrl;
    let image=typeof rawImage==='string' ? rawImage : '';
    const article = new Readability(doc.cloneNode(true) as Document).parse();
    if (!article || article.textContent.trim().length < 120) return {blocked:restricted, content:''};
    const content = parseHTML(article.content).body;
    const prose=(content.textContent || '').replace(/\s+/g,' ');
    const accessNotice=/you have [\d.,]+% (?:of this article )?left to read|the rest is for subscribers|(?:subscribe|sign in|log in) to (?:continue reading|read (?:the )?(?:full|rest of))|(?:article|contenu) (?:est )?réservé aux abonnés|pour (?:lire la suite|continuer (?:la lecture|à lire))[^.]{0,80}abonn/i;
    // Metering metadata can accompany public text; short previews still remain forbidden.
    const missingSection=restricted && [structured?.hasPart].flat().some(part=>{
        const selector=record(part).cssSelector;
        if (typeof selector!=='string') return false;
        try {
            const nodes=[...doc.querySelectorAll(selector)];
            return nodes.length>0 && nodes.every(node=>!node.textContent?.trim());
        } catch {return false;}
    });
    if (accessNotice.test(prose) || missingSection || (restricted && prose.length<1500)) return {blocked:true};
    const authors=authorNames([structured?.author].flat().map(value=>{
        if (typeof value==='string' && references.has(value)) return references.get(value);
        const data=record(value);
        return !data.name && typeof data['@id']==='string' ? references.get(data['@id']) : value;
    }));
    if (!authors.length) {
        for (const node of doc.querySelectorAll('meta')) {
            const name=(node.getAttribute('name') || node.getAttribute('property') || '').toLowerCase();
            if (['author','article:author','citation_author','dc.creator','dcterms.creator','parsely-author','sailthru.author','byl'].includes(name)) {
                authors.push(...authorNames(node.getAttribute('content')));
            }
        }
    }
    if (!authors.length) {
        for (const node of doc.querySelectorAll('[rel="author"], [itemprop="author"], .author-name, .byline__name, .byline-name')) {
            if (node.closest('footer, nav, aside, blockquote, [class*="comment"]')) continue;
            authors.push(...authorNames(node.querySelector('[itemprop="name"]')?.textContent || node.textContent));
        }
    }
    if (!authors.length) authors.push(...authorNames(article.byline));
    image ||= content.querySelector('img[src]')?.getAttribute('src') || '';
    try {
        const target = new URL(image, url);
        image = image && ['http:','https:'].includes(target.protocol) && !target.username && !target.password ? target.href : '';
    } catch { image = ''; }
    for (const node of content.querySelectorAll('p, h1, h2, h3, h4, li, blockquote, br')) node.append('\n\n');
    return {
        content:(content.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n(?:\s*\n)+/g, '\n\n').trim(),
        publish:published || publicationDate(article.publishedTime),
        authors:authorNames(authors),
        image,
        imageCaption:captionFromDocument(doc,image,url,structured),
    };
}

async function crawl(article: Article, blocked: string[], signal: AbortSignal | undefined, load: PageLoader): Promise<Article> {
    if (article.status === 'forbidden' || isPdf(article.url)) return {...article,status:'forbidden'};
    if (isBlocked(article.url, blocked)) return {...article, status:'forbidden'};
    const page = await load(article.url, signal, url => isBlocked(url, blocked));
    if (signal?.aborted) throw new Error(t('pluginDisabled'));
    if (isPdf(page.url,page.contentType) || page.html?.trimStart().startsWith('%PDF-')) return {...article,status:'forbidden'};
    const extracted = page.status >= 200 && page.status < 300 && page.html ? extractPage(page.html, page.url) : null;
    if (extracted?.content) return {...article, ...extracted, status:article.status === '404' ? '' : article.status};
    block(blocked, article.url);
    if (page.url !== article.url) block(blocked, page.url);
    return {...article, status:'forbidden'};
}

export {publicationDate, parseBlocked, isBlocked, block, extractPage, extractImageCaption, crawl};
