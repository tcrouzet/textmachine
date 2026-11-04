import {t} from './i18n';
import {parseData, isExcluded, isPdf} from './articles';
import selectionSchema from '../models/selection.json';
import writerSchema from '../models/writer.json';
import publisherSchema from '../models/publisher.json';
import summarySchema from '../models/resume.json';
import briefSchema from '../models/bref.json';
import {Article, FeedEntry, record, array} from './types';
import {parseHTML} from './html';
import {domainOf} from './domains';

interface SourceSummary {id: number; title?: string; summary: string}
export interface SourceGroup {title: string; articles: SourceSummary[]}
interface Editorial {title: string; chapeau: string; paragraphs: string[]}
interface RawNewsletter extends Editorial {lead: number | null; image: null; groups: SourceGroup[]; discard: number[]}
interface Newsletter extends Editorial {
    lead: string | null;
    image: {url: string; source: string; caption: string; verified: boolean; generated?: boolean} | null;
    groups: {title: string; articles: {url: string; title?: string; summary: string}[]}[];
    used: string[];
    discard: string[];
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item: unknown)=>typeof item==='string');

function referenceInstructions(articles: Article[], sources: string) {
    const domains=new Set(sources.split(/[\s,;]+/).filter(Boolean).flatMap(source=>{
        try {const domain=domainOf(source);return domain.includes('.') ? [domain] : [];}
        catch {return [];}
    }));
    if (!domains.size) return '';
    const ids=articles.filter(article=>{
        try {return domains.has(domainOf(article.url));} catch {return false;}
    }).map(article=>article.id);
    return ids.length ? '\n\n'+t('referenceSourcesContract',{ids:ids.join(', ')}) : '';
}

function day(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function availableArticles(text: string, exclusions = '', date = day(), todayNotes: string[] = []) {
    return parseData(text).articles.filter(article => article.content.trim() && !isPdf(article.url) && !isExcluded(article,exclusions)
        && article.status === '' && (!article.usedAt || article.usedAt === date
            || (article.usedAt==='unknown' && todayNotes.some(note=>note.includes(']('+article.url+')') || note.includes(']('+article.url+' ')))));
}

function briefArticles(text: string, exclusions = '', date = day()) {
    return parseData(text).articles.filter(article=>article.status === 'forbidden' && (!article.usedAt || article.usedAt === date)
        && !isExcluded(article,exclusions));
}

function briefRequest(prompt: string, articles: Article[], language: string) {
    if (!prompt.trim()) throw new Error(t('newsletterBriefPromptEmpty'));
    const schema = structuredClone(briefSchema);
    const titles = schema.properties.titles;
    Object.assign(titles,{minItems:articles.length,maxItems:articles.length});
    Object.assign(titles.items.properties.id,{enum:articles.map(article=>article.id)});
    return {system:renderPrompt(prompt,{language})+'\n\n'+JSON.stringify({jsonSchema:schema}),
        input:JSON.stringify(articles.map(({id,title})=>({id,title}))),schema};
}

function parseBrief(text: string, articles: Article[]): Article[] {
    const invalid = () => {throw new Error(t('newsletterBriefInvalid'));};
    let result: Record<string,unknown>;
    try {result=record(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')));} catch {return invalid();}
    if (!result || typeof result!=='object' || Array.isArray(result) || Object.keys(result).length!==1
        || !Array.isArray(result.titles) || result.titles.length!==articles.length) return invalid();
    const known = new Set(articles.map(article=>article.id)), titles = new Map<number,string>();
    for (const value of result.titles as unknown[]) {
        const row=record(value);
        if (Object.keys(row).length!==2 || typeof row.id!=='number' || !known.has(row.id)
            || titles.has(row.id) || typeof row.title!=='string' || !row.title.trim()) return invalid();
        titles.set(row.id,row.title.trim());
    }
    return articles.map(article=>({...article,title:titles.get(article.id)!}));
}

function renderPrompt(prompt: string, values: Record<string,string>) {
    return prompt.replace(/\{\{([^{}]*)\}\}/g, (_match: string,name: string)=>{
        name = name.trim();
        if (!Object.hasOwn(values,name)) throw new Error(t('promptUnknownVariable',{variable:'{{'+name+'}}'}));
        return values[name];
    });
}

function selectionRequest(prompt: string, articles: Article[], language: string, referenceSources = '', previous: {name: string; content: string}[] = []) {
    const schema = structuredClone(selectionSchema);
    const ids = articles.map(article=>article.id);
    for (const key of ['selected','discard'] as const) Object.assign(schema.properties[key].items,{enum:ids});
    return {input:articleInput(prompt,articles,language,{now:new Date().toString(),previousNewsletters:JSON.stringify(previous)}),system:t('selectionContract')+referenceInstructions(articles,referenceSources)+'\n\n'+JSON.stringify({jsonSchema:schema}),schema};
}

function parseSelection(text: string, articles: Article[]) {
    let result: Record<string,unknown>;
    try {result=record(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')));} catch {throw new Error(t('newsletterSelectionInvalid'));}
    const known=new Set(articles.map(article=>article.id));
    const classified=[...array(result.selected),...array(result.discard)];
    if (!result || Object.keys(result).length!==2 || !Array.isArray(result.selected) || !Array.isArray(result.discard)
        || result.selected.length+result.discard.length!==known.size
        || new Set(classified).size!==known.size
        || classified.some(id=>typeof id!=='number' || !known.has(id))) throw new Error(t('newsletterSelectionInvalid'));
    const selected=result.selected as number[];
    return {selected:articles.filter(article=>selected.includes(article.id)),discard:result.discard as number[]};
}

function summaryRequest(prompt: string, article: Pick<Article,'title' | 'content'>, language: string) {
    if (!/\{\{\s*article\s*\}\}/.test(prompt)) throw new Error(t('writerArticlesMissing',{variable:'{{article}}'}));
    const schema = structuredClone(summarySchema);
    return {input:renderPrompt(prompt,{language:language.trim() || 'français',article:JSON.stringify({title:article.title,content:article.content})}),
        system:t('summaryContract')+'\n\n'+JSON.stringify({jsonSchema:schema}),schema};
}

function parseSummary(text: string): string {
    let result: Record<string,unknown>;
    try {result=record(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')));} catch {throw new Error(t('newsletterSummariesInvalid'));}
    if (Object.keys(result).length!==1 || typeof result.summary!=='string' || !result.summary.trim()
        || result.summary.trim().split(/\s+/u).length>30 || /!\[|<img\b/i.test(result.summary)) throw new Error(t('newsletterSummariesInvalid'));
    return result.summary.trim();
}

function parseEditorial(text: string): Pick<Editorial,'paragraphs'> {
    let result: Record<string,unknown>;
    try {result=record(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')));} catch {throw new Error(t('newsletterInvalid'));}
    if (Object.keys(result).length!==1 || !strings(result.paragraphs) || result.paragraphs.length<2
        || result.paragraphs.some(paragraph=>!paragraph.trim() || /!\[|<img\b/i.test(paragraph))) throw new Error(t('newsletterInvalid'));
    return {paragraphs:result.paragraphs};
}

function publisherRequest(prompt: string, paragraphs: string[], language: string) {
    if (!prompt.trim()) throw new Error(t('newsletterPromptEmpty',{file:'publisher.md'}));
    if (!/\{\{\s*article\s*\}\}/.test(prompt)) throw new Error(t('publisherArticleMissing',{variable:'{{article}}'}));
    const schema=structuredClone(publisherSchema);
    return {system:t('publisherContract')+'\n\n'+JSON.stringify({jsonSchema:schema}),schema,
        input:renderPrompt(prompt,{language:language.trim() || 'français',article:paragraphs.join('\n\n')})};
}

function parsePublisher(text: string): Pick<Editorial,'title' | 'chapeau'> {
    let result: Record<string,unknown>;
    try {result=record(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')));} catch {throw new Error(t('newsletterInvalid'));}
    if (Object.keys(result).length!==2 || typeof result.title!=='string' || !result.title.trim()
        || typeof result.chapeau!=='string' || !result.chapeau.trim()) throw new Error(t('newsletterInvalid'));
    return {title:result.title,chapeau:result.chapeau};
}

function articleInput(prompt: string, articles: Article[], language: string, values: Record<string,string> = {}) {
    if (!/\{\{\s*articles\s*\}\}/.test(prompt)) throw new Error(t('writerArticlesMissing',{variable:'{{articles}}'}));
    return renderPrompt(prompt,{...values,
        language:language.trim() || 'français',
        articles:JSON.stringify(articles.map(article=>({id:article.id,title:article.title,url:article.url,source:article.source,
            publish:article.publish,content:article.content}))),
    });
}

function writerRequest(prompt: string, articles: Article[], previous: {name: string; content: string}[], feed: FeedEntry[], language = 'français', referenceSources = '') {
    if (!prompt.trim()) throw new Error(t('writerPromptEmpty'));
    const values = {
        previousNewsletters:JSON.stringify(previous),
        recentPosts:JSON.stringify(feed),
        AuthorFeed:JSON.stringify(feed),
    };
    const editorialSchema = structuredClone(writerSchema);
    return {
        system:t('writerContract') + referenceInstructions(articles,referenceSources) + '\n\n' + JSON.stringify({jsonSchema:editorialSchema}),schema:editorialSchema,
        input:articleInput(prompt,articles,language,values),
    };
}

function parseNewsletter(text: string, articles: Article[]): Newsletter {
    let value: unknown;
    try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); }
    catch { throw new Error(t('newsletterInvalid')); }
    const raw=record(value);
    const invalid = () => {throw new Error(t('newsletterInvalid'));};
    const string = (value: unknown): value is string => typeof value === 'string';
    const nonempty = (value: unknown) => string(value) && value.trim();
    const shape = (value: unknown,fields: string[]) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === fields.length && fields.every(field=>Object.hasOwn(value,field));
    const references = new Map(articles.map(article=>[article.id,article]));
    const known = (id: unknown) => typeof id==='number' && Number.isSafeInteger(id) && references.has(id);
    if (!shape(value,['title','chapeau','paragraphs','lead','image','groups','discard']) || !string(raw.title) || !string(raw.chapeau)
        || !strings(raw.paragraphs) || raw.paragraphs.some(paragraph=>!nonempty(paragraph))
        || !Array.isArray(raw.groups) || !Array.isArray(raw.discard)) invalid();
    for (const value of array(raw.groups)) {
        const group=record(value);
        if (!shape(group,['title','articles']) || !string(group.title) || !Array.isArray(group.articles) || !group.articles.length
            || group.articles.some((value: unknown)=>{const article=record(value);return (!shape(value,['id','summary']) && !shape(value,['id','title','summary']))
                || !known(article.id) || !nonempty(article.summary) || (Object.hasOwn(article,'title') && !nonempty(article.title));})) invalid();
    }
    const result = raw as unknown as RawNewsletter;
    const usedIds = result.groups.flatMap(group=>group.articles.map(article=>article.id));
    const classified = [...usedIds,...result.discard];
    if (new Set(articles.map(article=>article.url)).size !== articles.length || classified.length !== articles.length
        || new Set(classified).size !== classified.length || classified.some(id=>!known(id))) invalid();
    if (usedIds.length ? !nonempty(result.title) || !nonempty(result.chapeau) || result.paragraphs.length < 2
        : result.title || result.chapeau || result.paragraphs.length || result.image !== null) invalid();
    if (usedIds.length ? result.lead===null || !usedIds.includes(result.lead) : result.lead !== null) invalid();
    if (result.image !== null) invalid();
    if ([...result.paragraphs,...result.groups.flatMap(group=>group.articles.map(article=>article.summary))]
        .some(text=>/!\[|<img\b/i.test(text))) invalid();
    return {...result,
        groups:result.groups.map(group=>({...group,articles:group.articles.map(article=>({url:references.get(article.id)!.url,summary:article.summary,
            ...(article.title ? {title:article.title} : {})}))})),
        lead:result.lead === null ? null : references.get(result.lead)!.url,
        image:null,
        used:usedIds.map(id=>references.get(id)!.url),discard:result.discard.map(id=>references.get(id)!.url),
    };
}

function renderNewsletter(template: string, result: Newsletter, articles: Article[], brief: Pick<Article,'title' | 'url'>[] = []) {
    if (!template.trim()) throw new Error(t('newsletterTemplateInvalid'));
    const escape = (value: string) => value.replace(/[\r\n]+/g,' ').replace(/[\\`*_[\]<>]/g,'\\$&');
    const link = (url: string) => new URL(url).href.replace(/[()]/g,char=>char === '(' ? '%28' : '%29');
    const domain = (url: string) => new URL(url).hostname.replace(/^www\./,'');
    const source = new Map(articles.map(article=>[article.url,article]));
    const image = result.image?.verified === true && result.image.caption.trim() ? result.image : null;
    interface Context {[key: string]: string | Context[]}
    const values: Context = {
        title:escape(result.title || t('newsletterBriefTitle')),chapeau:escape(result.chapeau),
        paragraphs_before_image:result.paragraphs.slice(0,2).join('\n\n'),
        image:image ? (image.generated ? `![${escape(image.caption)}](${image.url})` : `[![${escape(image.caption)}](${link(image.url)})](${link(image.source)})`) : '',
        paragraphs_after_image:result.paragraphs.slice(2).join('\n\n'),
        groups:result.groups.map(group=>({title:escape(group.title),heading:group.title.trim() ? [{title:escape(group.title)}] : [],articles:group.articles.map(article=>({
            title:escape(article.title || source.get(article.url)!.title),summary:article.summary,domain:domain(article.url),url:link(article.url),
        }))})),
    };
    const briefRows = brief.map(article=>({title:escape(article.title),url:link(article.url)}));
    values.articles = briefRows;
    values.editorial = result.used.length ? [{...values}] : [];
    values.brief = brief.length ? [{heading:result.used.length ? '### '+t('newsletterBriefTitle') : '',articles:briefRows}] : [];
    const render = (text: string,context: Context): string => {
        const tokens = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}|\{\{(\w+)\}\}/g;
        if (text.replace(tokens,'').includes('{{')) throw new Error(t('newsletterTemplateInvalid'));
        return text.replace(tokens,(_match: string,section: string,block: string,key: string)=>{
            if (!Object.hasOwn(context,section || key) || (section ? !Array.isArray(context[section]) : typeof context[key] !== 'string')) {
                throw new Error(t('newsletterTemplateInvalid'));
            }
            const value=context[section || key];
            return Array.isArray(value) ? value.map(item=>render(block,item)).join('\n\n') : value;
        });
    };
    let markdown = render(template,values).replace(/\n{3,}/g,'\n\n').trim();
    if (!/^#\s+\S/.test(markdown)) throw new Error(t('newsletterTemplateInvalid'));
    const imageMarkdown=values.image;
    if (image && typeof imageMarkdown==='string' && !markdown.includes(imageMarkdown)) markdown = markdown.replace(/^(#[^\n]*)(?:\n|$)/,(_match: string,heading: string)=>heading+'\n\n'+imageMarkdown+'\n\n');
    return markdown+'\n';
}

function applyStatuses(text: string, snapshot: Article[], result: Pick<Newsletter,'used' | 'discard'>, date = day(), brief: Article[] = []) {
    const data = parseData(text);
    const original = new Map([...snapshot,...brief].map(article => [article.id,article]));
    const generated = result.used.length>0 || brief.length>0, discarded = new Set(result.discard);
    for (const article of data.articles) {
        const before = original.get(article.id);
        if (!before || article.url !== before.url || article.status !== before.status || article.usedAt !== before.usedAt
            || article.content !== before.content || article.title !== before.title) continue;
        if (generated) article.usedAt = date;
        else if (discarded.has(article.url) && !article.usedAt) article.status = 'discard';
    }
    return JSON.stringify(data,null,2) + '\n';
}

function preview(text: string) {
    if (!/^\s*(?:\{|```)/.test(text)) return text;
    const parts = [];
    let field = '', paragraphs = false, end = 0;
    for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)(?:"|$)/g)) {
        if (text.slice(end,match.index).includes(']')) paragraphs = false;
        end = match.index+match[0].length;
        let value: unknown;
        try {value = JSON.parse('"'+match[1]+'"');} catch {continue;}
        if (typeof value!=='string') continue;
        if (text.slice(end).trimStart().startsWith(':')) {field = value;paragraphs = field === 'paragraphs';continue;}
        if (paragraphs || ['title','chapeau','summary','caption','markdown'].includes(field)) {
            parts.push(field === 'title' ? (parts.length ? '### ' : '# ')+value : field === 'chapeau' ? '*'+value+'*' : value);
        }
        field = '';
    }
    return parts.join('\n\n');
}

function feedUrl(value = '') {
    if (!value.trim()) return '';
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error(t('newsletterFeedInvalid')); }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error(t('newsletterFeedInvalid'));
    if (url.hostname.endsWith('.substack.com') && url.pathname === '/') url.pathname = '/feed';
    url.hash = '';
    return url.href;
}

function feedUrls(value = '') {
    return [...new Set(value.trim().split(/\s+/).filter(Boolean).map(feedUrl))];
}

function readFeed(xml: string, limit = 5, base = ''): FeedEntry[] {
    const doc = new DOMParser().parseFromString(xml,'text/xml');
    if (doc.querySelector('parsererror') || !doc.querySelector('rss, feed')) throw new Error(t('newsletterFeedFailed'));
    return [...doc.querySelectorAll('item, entry')].slice(0,limit).map(item => {
        const content = item.getElementsByTagName('content:encoded')[0]?.textContent
            || item.querySelector('description, content, summary')?.textContent || '';
        const plain = (html: string) => {
            const doc=parseHTML(html);
            doc.querySelectorAll('script,style').forEach(node=>node.remove());
            return (doc.body.textContent || '').trim();
        };
        const body = plain(content);
        const title = plain(item.querySelector('title')?.textContent || '');
        const links = [...item.querySelectorAll('link')];
        const link = links.find(node=>!node.getAttribute('rel') || node.getAttribute('rel')==='alternate') || links[0];
        let url = link?.getAttribute('href') || link?.textContent?.trim() || '';
        if (url) {try {url = new URL(url,base || undefined).href;} catch {url='';}}
        const published = item.querySelector('pubDate, published')?.textContent?.trim() || '';
        const timestamp = Date.parse(published);
        return {title,
            url,publish:Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '',
            content:body};
    });
}

export {day, availableArticles, briefArticles, briefRequest, parseBrief, selectionRequest, parseSelection, summaryRequest, parseSummary, parseEditorial, publisherRequest, parsePublisher, renderPrompt, writerRequest, parseNewsletter, renderNewsletter, applyStatuses, feedUrl, feedUrls, readFeed, preview};
