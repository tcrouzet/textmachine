const {t} = require('./i18n');
const {parseData, isExcluded, isPdf} = require('./articles');
const schema = require('../models/newsletter.json');

function day(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function availableArticles(text, exclusions = '', date = day(), todayNotes = []) {
    return parseData(text).articles.filter(article => article.content.trim() && !isPdf(article.url) && !isExcluded(article,exclusions)
        && (article.status === '' || (article.status === 'used' && (article.usedAt === date
            || (!article.usedAt && todayNotes.some(note=>note.includes(']('+article.url+')') || note.includes(']('+article.url+' ')))))));
}

function briefArticles(text, exclusions = '', date = day()) {
    return parseData(text).articles.filter(article=>article.status === 'forbidden' && (!article.usedAt || article.usedAt === date)
        && !isExcluded(article,exclusions));
}

function writerRequest(prompt, articles, previous, feed) {
    if (!prompt.trim()) throw new Error(t('writerPromptEmpty'));
    return {
        system:prompt + '\n\n' + t('writerContract'),
        input:JSON.stringify({articles:articles.map(article=>({id:article.id,title:article.title,url:article.url,source:article.source,
            publish:article.publish,content:article.content,hasImage:!!article.image})), previousNewsletters:previous, recentPosts:feed, jsonSchema:schema}),
    };
}

function parseNewsletter(text, articles) {
    let result;
    try { result = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); }
    catch { throw new Error(t('newsletterInvalid')); }
    const invalid = () => {throw new Error(t('newsletterInvalid'));};
    const string = value => typeof value === 'string';
    const nonempty = value => string(value) && value.trim();
    const shape = (value,fields) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === fields.length && fields.every(field=>Object.hasOwn(value,field));
    const references = new Map(articles.map(article=>[article.id,article]));
    const known = id => Number.isSafeInteger(id) && references.has(id);
    if (!shape(result,['title','chapeau','paragraphs','lead','image','groups','discard']) || !string(result.title) || !string(result.chapeau)
        || !Array.isArray(result.paragraphs) || result.paragraphs.some(paragraph=>!nonempty(paragraph))
        || !Array.isArray(result.groups) || !Array.isArray(result.discard)) invalid();
    for (const group of result.groups) {
        if (!shape(group,['title','articles']) || !nonempty(group.title) || !Array.isArray(group.articles) || !group.articles.length
            || group.articles.some(article=>!shape(article,['id','summary']) || !known(article.id) || !nonempty(article.summary))) invalid();
    }
    const usedIds = result.groups.flatMap(group=>group.articles.map(article=>article.id));
    const classified = [...usedIds,...result.discard];
    if (new Set(articles.map(article=>article.url)).size !== articles.length || classified.length !== articles.length
        || new Set(classified).size !== classified.length || classified.some(id=>!known(id))) invalid();
    if (usedIds.length ? !nonempty(result.title) || !nonempty(result.chapeau) || result.paragraphs.length < 2
        : result.title || result.chapeau || result.paragraphs.length || result.image !== null) invalid();
    if (usedIds.length ? !usedIds.includes(result.lead) : result.lead !== null) invalid();
    if (result.image !== null && (!shape(result.image,['caption']) || !string(result.image.caption)
        || !references.get(result.lead)?.image)) invalid();
    if ([...result.paragraphs,...result.groups.flatMap(group=>group.articles.map(article=>article.summary))]
        .some(text=>/!\[|<img\b/i.test(text))) invalid();
    return {...result,
        groups:result.groups.map(group=>({...group,articles:group.articles.map(article=>({url:references.get(article.id).url,summary:article.summary}))})),
        lead:result.lead === null ? null : references.get(result.lead).url,
        image:result.image && result.paragraphs.some(paragraph=>paragraph.includes(']('+references.get(result.lead).url+')') || paragraph.includes(']('+references.get(result.lead).url+' '))
            ? {url:references.get(result.lead).image,source:references.get(result.lead).url,caption:result.image.caption} : null,
        used:usedIds.map(id=>references.get(id).url),discard:result.discard.map(id=>references.get(id).url),
    };
}

function renderNewsletter(template, result, articles, brief = []) {
    if (!template.trim()) throw new Error(t('newsletterTemplateInvalid'));
    const escape = value => value.replace(/[\r\n]+/g,' ').replace(/[\\`*_[\]<>]/g,'\\$&');
    const link = url => new URL(url).href.replace(/[()]/g,char=>char === '(' ? '%28' : '%29');
    const domain = url => new URL(url).hostname.replace(/^www\./,'');
    const source = new Map(articles.map(article=>[article.url,article]));
    const image = result.image?.verified === true && result.image.caption.trim() ? result.image : null;
    const values = {
        title:escape(result.title || t('newsletterBriefTitle')),chapeau:escape(result.chapeau),
        paragraphs_before_image:result.paragraphs.slice(0,2).join('\n\n'),
        image:image ? `[![${escape(image.caption)}](${link(image.url)})](${link(image.source)})\n\n*${escape(image.caption)}*` : '',
        paragraphs_after_image:result.paragraphs.slice(2).join('\n\n'),
        groups:result.groups.map(group=>({title:escape(group.title),articles:group.articles.map(article=>({
            title:escape(source.get(article.url).title),summary:article.summary,domain:domain(article.url),url:link(article.url),
        }))})),
    };
    const briefRows = brief.map(article=>({title:escape(article.title),url:link(article.url)}));
    values.articles = briefRows;
    values.editorial = result.used.length ? [{...values}] : [];
    values.brief = brief.length ? [{heading:result.used.length ? '### '+t('newsletterBriefTitle') : '',articles:briefRows}] : [];
    const render = (text,context) => {
        const tokens = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}|\{\{(\w+)\}\}/g;
        if (text.replace(tokens,'').includes('{{')) throw new Error(t('newsletterTemplateInvalid'));
        return text.replace(tokens,(_match,section,block,key)=>{
            if (!Object.hasOwn(context,section || key) || (section ? !Array.isArray(context[section]) : typeof context[key] !== 'string')) {
                throw new Error(t('newsletterTemplateInvalid'));
            }
            return section ? context[section].map(item=>render(block,item)).join('\n\n') : context[key];
        });
    };
    const markdown = render(template,values).replace(/\n{3,}/g,'\n\n').trim();
    if (!/^#\s+\S/.test(markdown)) throw new Error(t('newsletterTemplateInvalid'));
    return markdown+'\n';
}

function applyStatuses(text, snapshot, result, date = day(), brief = []) {
    const data = parseData(text);
    const original = new Map([...snapshot,...brief].map(article => [article.id,article]));
    const used = new Set(result.used), discarded = new Set(result.discard);
    for (const article of data.articles) {
        const before = original.get(article.id);
        if (!before || article.url !== before.url || article.status !== before.status || article.usedAt !== before.usedAt
            || article.content !== before.content || article.title !== before.title) continue;
        if (before.status === 'forbidden') {article.usedAt = date;continue;}
        if (used.has(article.url)) {article.status = 'used';article.usedAt = date;}
        else if (discarded.has(article.url)) {article.status = 'discard';delete article.usedAt;}
    }
    return JSON.stringify(data,null,2) + '\n';
}

function preview(text) {
    if (!/^\s*(?:\{|```)/.test(text)) return text;
    const parts = [];
    let field = '', paragraphs = false, end = 0;
    for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)(?:"|$)/g)) {
        if (text.slice(end,match.index).includes(']')) paragraphs = false;
        end = match.index+match[0].length;
        let value;
        try {value = JSON.parse('"'+match[1]+'"');} catch {continue;}
        if (text.slice(end).trimStart().startsWith(':')) {field = value;paragraphs = field === 'paragraphs';continue;}
        if (paragraphs || ['title','chapeau','summary','caption','markdown'].includes(field)) {
            parts.push(field === 'title' ? (parts.length ? '### ' : '# ')+value : field === 'chapeau' ? '*'+value+'*' : value);
        }
        field = '';
    }
    return parts.join('\n\n');
}

function readFeed(xml) {
    const doc = new DOMParser().parseFromString(xml,'text/xml');
    if (doc.querySelector('parsererror') || !doc.querySelector('rss, feed')) throw new Error(t('newsletterFeedFailed'));
    return [...doc.querySelectorAll('item, entry')].slice(0,5).map(item => {
        const content = item.getElementsByTagName('content:encoded')[0]?.textContent
            || item.querySelector('description, content, summary')?.textContent || '';
        const template = document.createElement('template');
        template.innerHTML = content;
        template.content.querySelectorAll('script,style').forEach(node => node.remove());
        return {title:item.querySelector('title')?.textContent || '',
            url:item.querySelector('link')?.getAttribute('href') || item.querySelector('link')?.textContent || '',
            content:template.content.textContent.trim()};
    });
}

module.exports = {schema, day, availableArticles, briefArticles, writerRequest, parseNewsletter, renderNewsletter, applyStatuses, readFeed, preview};
