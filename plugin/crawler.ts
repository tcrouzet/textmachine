import {publicationDate,extractPage,extractImageCaption,extractSocialImage} from './obsidian-toolbox/src/web/article';
import { t } from './i18n';
import {isPdf, isShortUrl, articleUrl, articleTitle} from './articles';

import {domainOf} from './domains';
import {Article, record} from './types';
import type {PageLoader} from './browser';
import {parseHTML} from './html';

function imageSourceCaption(title: string, url: string) {
    return t('newsletterImageSourceCaption',{title:articleTitle({title,url}),source:new URL(url).hostname.replace(/^www\./,'')});
}

function extractArticleImage(html: string, url: string, title = '') {
    const social=extractSocialImage(html,url);
    if (social) return social;
    const doc=parseHTML(html);
    const article=doc.querySelector('article') || doc.querySelector('main, [role="main"]') || doc;
    const fallbackCaption=imageSourceCaption(title || doc.querySelector('h1')?.textContent || doc.title,url);
    let fallback: {image: string; imageCaption: string} | null=null;
    for (const img of article.querySelectorAll('img')) {
        if (img.closest('aside, nav, footer')) continue;
        const values=['data-src','data-original','data-lazy-src','src'].map(name=>img.getAttribute(name)?.trim());
        values.push(...(img.getAttribute('srcset') || '').split(/\s+/).filter(value=>!/^\d+(?:\.\d+)?[wx],?$/.test(value)).map(value=>value.replace(/,$/,'')));
        for (const value of values) {
            if (!value) continue;
            try {
                const image=new URL(value,url);
                if (!['http:','https:'].includes(image.protocol) || image.username || image.password) continue;
                const imageCaption=extractImageCaption(html,url,image.href);
                if (imageCaption.trim()) return {image:image.href,imageCaption};
                if (!fallback && img.closest('figure, [itemprop="image"], .article-image, .featured-image'))
                    fallback={image:image.href,imageCaption:fallbackCaption};
            } catch { continue; }
        }
    }
    if (fallback) return fallback;
    for (const name of ['og:image:secure_url','og:image','twitter:image','twitter:image:src']) {
        for (const node of doc.querySelectorAll(`meta[property="${name}"], meta[name="${name}"]`)) {
            const value=node.getAttribute('content')?.trim();
            if (!value) continue;
            try {
                const image=new URL(value,url);
                if (['http:','https:'].includes(image.protocol) && !image.username && !image.password)
                    return {image:image.href,imageCaption:fallbackCaption};
            } catch { continue; }
        }
    }
    return null;
}

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

function hasPaywall(html: string) {
    if (!html) return false;
    const doc=parseHTML(html);
    for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try {
            const metadata=JSON.stringify(JSON.parse(node.textContent || ''));
            if (/"isAccessibleForFree"\s*:\s*(?:false|"false")\s*[,}]/i.test(metadata)) return true;
        } catch { /* Ignore malformed publisher metadata. */ }
    }
    doc.querySelectorAll('script, style, nav, aside, footer').forEach(node=>node.remove());
    const text=(doc.querySelector('article, main, [role="main"]') || doc.body).textContent || '';
    return /the rest is for subscribers|subscribe to (?:continue reading|read (?:the )?(?:full|rest of))|(?:article|contenu) (?:est )?réservé aux abonnés|pour (?:lire la suite|continuer (?:la lecture|à lire))[^.]{0,80}abonn/i.test(text.replace(/\s+/g,' '));
}

async function crawl(article: Article, blocked: string[], signal: AbortSignal | undefined, load: PageLoader): Promise<Article> {
    if (article.status === '404') return article;
    if ((article.status === 'forbidden' && !isShortUrl(article.url)) || isPdf(article.url)) return {...article,status:'forbidden'};
    if (isBlocked(article.url, blocked)) return {...article, status:'forbidden'};
    const page = await load(article.url, signal, url => isBlocked(url, blocked));
    if (signal?.aborted) throw new Error(t('pluginDisabled'));
    const url=articleUrl(page.url) || article.url;
    if (url!==article.url) {
        const fallback=article.title===article.url || article.title===articleTitle({url:article.url,title:article.url});
        article={...article,url,title:fallback ? articleTitle({url,title:url}) : article.title};
    }
    if (page.status === 404 && !page.failure) return {...article,status:'404'};
    if (isPdf(page.url,page.contentType) || page.html?.trimStart().startsWith('%PDF-')) return {...article,status:'forbidden'};
    const extracted = page.status >= 200 && page.status < 300 && page.html ? extractPage(page.html, page.url) : null;
    if (article.content) return {...article,title:extracted?.title || article.title};
    if (extracted?.content) return {...article, ...extracted};
    if (!page.failure && (page.status===402 || hasPaywall(page.html))) {
        block(blocked, article.url);
    }
    return {...article, status:'forbidden'};
}

export {publicationDate, parseBlocked, isBlocked, block, extractPage, extractImageCaption, extractSocialImage, extractArticleImage, imageSourceCaption, crawl};
