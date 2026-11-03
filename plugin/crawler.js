const { t } = require('./i18n');

const {domainOf} = require('./domains');

function parseBlocked(text) {
    try {
        const data = JSON.parse(text);
        const entries = Array.isArray(data) ? data : data?.version === 1 && Array.isArray(data.blocked)
            ? data.blocked.map(entry => entry.url) : null;
        if (!entries || entries.some(entry => typeof entry !== 'string' || !entry.trim())) throw new Error();
        return [...new Set(entries.map(domainOf))];
    } catch { throw new Error(t('invalidBlockedFile')); }
}

function isBlocked(url, data) {
    try { return data.includes(domainOf(url)); } catch { return false; }
}

function block(data, url) {
    const domain = domainOf(url);
    if (!data.includes(domain)) data.push(domain);
}

function publicationDate(value) {
    if (typeof value !== 'string') return '';
    value = value.trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value);
    const valid = (year, month, day) => {
        const date = new Date(Date.UTC(+year, +month - 1, +day));
        return date.getUTCFullYear() === +year && date.getUTCMonth() === +month - 1 && date.getUTCDate() === +day;
    };
    if (iso) return valid(...iso.slice(1,4)) && Number.isFinite(Date.parse(value)) ? value : '';
    const months = ['janvier janv january jan', 'fevrier fevr february feb', 'mars march mar', 'avril april apr', 'mai may', 'juin june jun',
        'juillet juil july jul', 'aout august aug', 'septembre september sep sept', 'octobre october oct', 'novembre november nov', 'decembre december dec'];
    const normalized = value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    let parts = /\b(\d{1,2})(?:er|st|nd|rd|th)?\s+([a-z]+)\.?\s+(\d{4})\b/.exec(normalized);
    if (!parts) {
        const english = /\b([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/.exec(normalized);
        if (english) parts = [english[0], english[2], english[1], english[3]];
    }
    if (!parts) return '';
    const month = months.findIndex(names => names.split(' ').includes(parts[2])) + 1;
    return month && valid(parts[3], month, parts[1]) ? `${parts[3]}-${String(month).padStart(2,'0')}-${parts[1].padStart(2,'0')}` : '';
}

function dateFromDocument(doc, structured) {
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

function extractPage(html, url) {
    const Readability = require('../scripts/vendor/readability/Readability');
    // Detached HTML documents do not execute scripts or load page resources.
    const template = document.createElement('template');
    template.innerHTML = html;
    const doc = document.implementation.createHTMLDocument('');
    doc.querySelector('title')?.remove();
    doc.body.replaceChildren(template.content.cloneNode(true));
    doc.querySelectorAll('base').forEach(node => node.remove());
    const base = doc.createElement('base');
    base.href = url;
    (doc.head || doc.documentElement).prepend(base);
    const meta = name => doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') || '';
    const title = doc.querySelector('title')?.textContent || '';
    if (/^(?:just a moment|access denied|attention required|verify (?:you|your)|security check|checking your browser|accès refusé)/i.test(title.trim())
        || doc.querySelector('#challenge-running, #challenge-form, form[action*="captcha"]')) {
        return {blocked:true};
    }
    let structured;
    const visit = value => {
        if (!value || typeof value !== 'object') return;
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
        try { visit(JSON.parse(node.textContent)); } catch { /* Ignore malformed publisher metadata. */ }
    }
    if (structured?.isAccessibleForFree === false || structured?.isAccessibleForFree === 'False') return {blocked:true};
    const published = dateFromDocument(doc, structured);
    let image = meta('og:image') || meta('twitter:image') || structured?.image || '';
    if (Array.isArray(image)) image = image[0];
    if (image && typeof image === 'object') image = image.url || image.contentUrl;
    const article = new Readability(doc).parse();
    if (!article || article.textContent.trim().length < 120) return {blocked:false, content:''};
    const content = document.createElement('template');
    content.innerHTML = article.content;
    image ||= content.content.querySelector('img[src]')?.getAttribute('src') || '';
    try {
        const target = new URL(image, url);
        image = image && ['http:','https:'].includes(target.protocol) && !target.username && !target.password ? target.href : '';
    } catch { image = ''; }
    for (const node of content.content.querySelectorAll('p, h1, h2, h3, h4, li, blockquote, br')) node.append('\n\n');
    return {
        content:content.content.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n(?:\s*\n)+/g, '\n\n').trim(),
        publish:published || publicationDate(article.publishedTime),
        image,
    };
}

async function crawl(article, blocked, signal, load) {
    if (isBlocked(article.url, blocked)) return {...article, status:'404'};
    const page = await load(article.url, signal, url => isBlocked(url, blocked));
    if (signal?.aborted) throw new Error(t('pluginDisabled'));
    const extracted = page.status >= 200 && page.status < 300 && page.html ? extractPage(page.html, page.url) : null;
    if (extracted?.content) return {...article, ...extracted, status:article.status === '404' ? '' : article.status};
    block(blocked, article.url);
    if (page.url !== article.url) block(blocked, page.url);
    return {...article, status:'404'};
}

module.exports = {publicationDate, parseBlocked, isBlocked, block, extractPage, crawl};
