import {t} from './i18n';
import {parseData, isExcluded, isPdf, articleUrl, articleTitle, isEditorialSource} from './articles';
import selectionSchema from '../models/selection.json';
import writerSchema from '../models/writer.json';
import publisherSchema from '../models/publisher.json';
import briefSchema from '../models/bref.json';
import verifierSchema from '../models/verifier.json';
import {Article, FeedEntry, Progress, record, array} from './types';
import {parseHTML} from './html';
import {authorNames} from './authors';
import {publicationDate} from './crawler';
import {domainOf} from './domains';

interface Editorial {title: string; chapeau: string; paragraphs: string[]}
export interface Newsletter extends Editorial {
    image: {url: string; source: string; caption: string; verified: boolean; generated?: boolean; markdown?: string} | null;
    paragraphImages?: {paragraph: number; url: string; source: string; caption: string}[];
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

function availableForEdition(article: Article, date: string, lastEdition: string) {
    return !article.usedAt || article.usedAt===date || (/^\d{4}-\d{2}-\d{2}$/.test(article.usedAt)
        && article.usedAt>lastEdition && article.usedAt<date);
}

function availableArticles(text: string, exclusions = '', date = day(), todayNotes: string[] = [], lastEdition = date) {
    return parseData(text).articles.filter(article => article.content.trim() && !isPdf(article.url) && !isExcluded(article,exclusions)
        && article.status === '' && (availableForEdition(article,date,lastEdition)
            || (article.usedAt==='unknown' && todayNotes.some(note=>note.includes(']('+article.url+')') || note.includes(']('+article.url+' ')))));
}

function briefArticles(text: string, exclusions = '', date = day(), lastEdition = date) {
    return parseData(text).articles.filter(article=>article.status === 'forbidden' && availableForEdition(article,date,lastEdition)
        && !isExcluded(article,exclusions));
}

function briefRequest(prompt: string, articles: Article[], language: string, selected: Article[] = []) {
    if (!prompt.trim()) throw new Error(t('newsletterBriefPromptEmpty'));
    const schema = structuredClone(briefSchema);
    const titles = schema.properties.titles;
    Object.assign(titles,{minItems:articles.length,maxItems:articles.length});
    Object.assign(titles.items.properties.id,{enum:articles.map(article=>article.id)});
    const required=selected.length ? '\n\n'+t('briefSelectedContract',{ids:selected.map(article=>article.id).join(', ')}) : '';
    return {system:renderPrompt(prompt,{language})+required+'\n\n'+JSON.stringify({jsonSchema:schema}),
        input:JSON.stringify(articles.map(({id,title,url,status,content})=>({id,title:articleTitle({url,title}),
            ...(status==='' && content.trim() ? {context:content.slice(0,2000)} : {})}))),schema};
}

function parseBrief(text: string, articles: Article[], selected: Article[] = []): (Article & {category:string})[] {
    const invalid = () => {throw new Error(t('newsletterBriefInvalid'));};
    let result: Record<string,unknown>;
    try {result=record(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')));} catch {return invalid();}
    if (!result || typeof result!=='object' || Array.isArray(result) || Object.keys(result).length!==1
        || !Array.isArray(result.titles) || result.titles.length!==articles.length) return invalid();
    const known = new Map(articles.map(article=>[article.id,article])), titles = new Map<number,{title:string;category:string} | null>();
    for (const value of result.titles as unknown[]) {
        const row=record(value);
        if (Object.keys(row).length!==3 || typeof row.id!=='number' || !known.has(row.id)
            || titles.has(row.id) || (row.title!==null && (typeof row.title!=='string' || !row.title.trim()))
            || (row.category!==null && (typeof row.category!=='string' || !row.category.trim()))
            || (row.title===null)!==(row.category===null)) return invalid();
        titles.set(row.id,row.title===null ? null : {title:(row.title as string).trim(),category:(row.category as string).trim()});
    }
    if (selected.some(article=>!titles.get(article.id))) return invalid();
    return [...titles].flatMap(([id,translated])=>translated ? [{...known.get(id)!,...translated}] : []);
}

function renderPrompt(prompt: string, values: Record<string,string>) {
    return prompt.replace(/\{\{([^{}]*)\}\}/g, (_match: string,name: string)=>{
        name = name.trim();
        if (!Object.hasOwn(values,name)) throw new Error(t('promptUnknownVariable',{variable:'{{'+name+'}}'}));
        return values[name];
    });
}

function selectionRequest(prompt: string, articles: Article[], language: string, referenceSources = '', previous: {name: string; content: string}[] = [], feed: FeedEntry[] = [], commentedArticles = 3) {
    const schema = structuredClone(selectionSchema);
    const ids = articles.map(article=>article.id);
    for (const key of ['selected','brief','discard'] as const) Object.assign(schema.properties[key].items,{enum:ids});
    const editorial=articles.filter(article=>isEditorialSource(article.source)).map(article=>article.id);
    const priority=editorial.length ? '\n\n'+t('editorialSourcesContract',{ids:editorial.join(', ')}) : '';
    return {input:articleInput(prompt,articles,language,{commentedArticles:String(commentedArticles),now:new Date().toString(),previousNewsletters:JSON.stringify(previous),AuthorFeed:JSON.stringify(feed),recentPosts:JSON.stringify(feed)}),system:t('selectionContract')+'\n\n'+t('commentedArticlesContract',{count:commentedArticles})+referenceInstructions(articles,referenceSources)+priority+'\n\n'+JSON.stringify({jsonSchema:schema}),schema};
}

async function selectArticles(articles: Article[], build: (articles: Article[])=>ReturnType<typeof selectionRequest>,
    respond: (request: ReturnType<typeof selectionRequest>)=>Promise<string>, progress?: Progress): Promise<ReturnType<typeof parseSelection>> {
    if (!articles.length) return {selected:[],brief:[],discard:[]};
    const queue=[articles], batches: {articles: Article[]; request: ReturnType<typeof selectionRequest>}[]=[];
    while (queue.length) {
        const group=queue.pop()!;
        const request=build(group);
        // Codex rejects turn inputs above 1,048,576 characters.
        if (request.input.length<=1000000) batches.push({articles:group,request});
        else {
            if (group.length===1) throw new Error(t('newsletterSelectionTooLarge'));
            const middle=Math.ceil(group.length/2);
            queue.push(group.slice(middle),group.slice(0,middle));
        }
    }
    const selected: Article[]=[], brief: Article[]=[], discard: number[]=[];
    for (const [index,batch] of batches.entries()) {
        if (batches.length>1) progress?.(t('newsletterSelectingBatch',{current:index+1,total:batches.length}));
        const result=parseSelection(await respond(batch.request),batch.articles);
        selected.push(...result.selected);brief.push(...result.brief);discard.push(...result.discard);
    }
    if (batches.length===1 || selected.length<2) return {selected,brief,discard};
    if (selected.length===articles.length) throw new Error(t('newsletterSelectionTooLarge'));
    progress?.(t('newsletterSelecting'));
    const final=await selectArticles(selected,build,respond,progress);
    return {selected:final.selected,brief:[...brief,...final.brief],discard:[...discard,...final.discard]};
}

function isAuthorSource(value: string, feeds: string, posts: FeedEntry[] = []) {
    const canonical=(value: string)=>{
        const url=new URL(articleUrl(value) || value);
        url.hostname=url.hostname.replace(/^www\./,'');url.hash='';url.searchParams.sort();
        return url.href.replace(/\/$/,'');
    };
    let target: URL;
    try {target=new URL(canonical(value));} catch {return false;}
    if (posts.some(post=>{try {return !!post.url && canonical(post.url)===canonical(value);} catch {return false;}})) return true;
    return feedUrls(feeds).some(value=>{
        const feed=new URL(canonical(value));
        const prefix=feed.pathname.replace(/\/(?:feed|rss|atom)(?:\.(?:xml|rss))?\/?$/i,'').replace(/\/$/,'');
        return target.hostname===feed.hostname && (!prefix || target.pathname===prefix || target.pathname.startsWith(prefix+'/'));
    });
}

function assertNoAuthorSources(paragraphs: string[], feeds: string, posts: FeedEntry[]) {
    const urls=paragraphs.join('\n').match(/https?:\/\/[^\s<>"\])]+/g) || [];
    if (urls.some(url=>isAuthorSource(url.replace(/[.,;:!?]+$/,''),feeds,posts))) throw new Error(t('newsletterAuthorSource'));
}

function parseSelection(text: string, articles: Article[]) {
    let result: Record<string,unknown>;
    try {result=record(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')));} catch {throw new Error(t('newsletterSelectionInvalid'));}
    const known=new Set(articles.map(article=>article.id));
    const classified=[...array(result.selected),...array(result.brief),...array(result.discard)];
    if (!result || Object.keys(result).length!==3 || !Array.isArray(result.selected) || !Array.isArray(result.brief) || !Array.isArray(result.discard)
        || classified.length!==known.size
        || new Set(classified).size!==known.size
        || classified.some(id=>typeof id!=='number' || !known.has(id))) throw new Error(t('newsletterSelectionInvalid'));
    const selected=result.selected as number[];
    return {selected:articles.filter(article=>selected.includes(article.id)),brief:articles.filter(article=>(result.brief as number[]).includes(article.id)),discard:result.discard as number[]};
}

function parseEditorial(text: string): Pick<Editorial,'paragraphs'> {
    let result: Record<string,unknown>;
    try {result=record(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')));} catch {throw new Error(t('newsletterInvalid'));}
    if (Object.keys(result).length!==1 || !strings(result.paragraphs) || result.paragraphs.length<2
        || result.paragraphs.some(paragraph=>!paragraph.trim() || /!\[|<img\b/i.test(paragraph))) throw new Error(t('newsletterInvalid'));
    return {paragraphs:result.paragraphs};
}

function publicationCount(articles: Article[]) {
    return new Set(articles.flatMap(article=>{try {return [domainOf(article.url)];} catch {return [];}})).size;
}

function parseWriter(text: string, articles: Article[]) {
    let result: Record<string,unknown>;
    try {result=record(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')));} catch {throw new Error(t('newsletterInvalid'));}
    const ids=new Set(articles.map(article=>article.id));
    if (Object.keys(result).length!==2 || !Array.isArray(result.used) || new Set(result.used).size!==result.used.length
        || result.used.some(id=>typeof id!=='number' || !ids.has(id))) throw new Error(t('newsletterInvalid'));
    if (!result.used.length) {
        if (!Array.isArray(result.paragraphs) || result.paragraphs.length) throw new Error(t('newsletterInvalid'));
        return {paragraphs:[],used:[]};
    }
    const editorial=parseEditorial(JSON.stringify({paragraphs:result.paragraphs}));
    const used=articles.filter(article=>(result.used as number[]).includes(article.id));
    const cited=new Set((editorial.paragraphs.join('\n').match(/https?:\/\/[^\s<>"\]]+/g) || []).flatMap(url=>{
        try {return [domainOf(url.replace(/[),.;!?]+$/g,''))];} catch {return [];}
    }));
    if (publicationCount(used)<2 || publicationCount(used.filter(article=>cited.has(domainOf(article.url))))<2)
        throw Object.assign(new Error(t('newsletterMultiplePublications')),{code:'RP_TOO_FEW_SOURCES'});
    return {...editorial,used};
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
    const title=result.title.trim().replace(/^(?:IA|AI|intelligence artificielle)\s*[:：]\s*/i,'');
    if (!title.trim()) throw new Error(t('newsletterInvalid'));
    const chapeau=result.chapeau.trim();
    const count=(chapeau.match(/[\p{L}\p{N}]+(?:[’'‐‑-][\p{L}\p{N}]+)*/gu) || []).length;
    if (count>35) throw Object.assign(new Error(t('newsletterChapeauTooLong',{count})),{code:'CHAPEAU_TOO_LONG'});
    return {title,chapeau};
}

function verificationRequest(prompt: string, newsletter: Editorial, articles: Article[], language: string) {
    if (!prompt.trim()) throw new Error(t('newsletterPromptEmpty',{file:'verifier.md'}));
    if (!/\{\{\s*newsletter\s*\}\}/.test(prompt)) throw new Error(t('verifierNewsletterMissing',{variable:'{{newsletter}}'}));
    const {title,chapeau,paragraphs}=newsletter;
    const schema=structuredClone(verifierSchema);
    return {system:t('verifierContract')+'\n\n'+JSON.stringify({jsonSchema:schema}),schema,
        input:articleInput(prompt,articles,language,{newsletter:JSON.stringify({title,chapeau,paragraphs})})};
}

function parseVerification(text: string) {
    let result: Record<string,unknown>;
    try {result=record(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')));}
    catch {throw new Error(t('newsletterInvalid'));}
    if (Object.keys(result).length!==1 || !Object.hasOwn(result,'issues')
        || !strings(result.issues) || result.issues.some(issue=>!issue.trim())) throw new Error(t('newsletterInvalid'));
    if (result.issues.length) throw new Error(t('newsletterVerificationFailed',{issues:result.issues.join('; ')}));
}

function articleInput(prompt: string, articles: Article[], language: string, values: Record<string,string> = {}) {
    if (!/\{\{\s*articles\s*\}\}/.test(prompt)) throw new Error(t('writerArticlesMissing',{variable:'{{articles}}'}));
    return renderPrompt(prompt,{...values,
        language:language.trim() || 'français',
        articles:JSON.stringify(articles.map(article=>({id:article.id,title:articleTitle(article),url:article.url,source:article.source,authors:article.authors || [],
            publish:article.publish,content:article.content}))),
    });
}

function writerRequest(prompt: string, articles: Article[], previous: {name: string; content: string}[], feed: FeedEntry[], language = 'français', referenceSources = '', commentedArticles = 3) {
    if (!prompt.trim()) throw new Error(t('writerPromptEmpty'));
    const values = {
        commentedArticles:String(commentedArticles),
        previousNewsletters:JSON.stringify(previous),
        recentPosts:JSON.stringify(feed),
        AuthorFeed:JSON.stringify(feed),
    };
    const editorialSchema = structuredClone(writerSchema);
    Object.assign(editorialSchema.properties.used.items,{enum:articles.map(article=>article.id)});
    return {
        system:t('writerContract')+'\n\n'+t('commentedArticlesContract',{count:commentedArticles}) + referenceInstructions(articles,referenceSources) + '\n\n' + JSON.stringify({jsonSchema:editorialSchema}),schema:editorialSchema,
        input:articleInput(prompt,articles,language,values),
    };
}

function renderNewsletter(template: string, result: Newsletter, brief: (Pick<Article,'title' | 'url'> & {category?:string})[] = []) {
    if (!template.trim()) throw new Error(t('newsletterTemplateInvalid'));
    const escape = (value: string) => value.replace(/[\r\n]+/g,' ').replace(/[\\`*_[\]<>]/g,'\\$&');
    const link = (url: string) => new URL(url).href.replace(/[()]/g,char=>char === '(' ? '%28' : '%29');
    const image = result.image?.verified === true && result.image.caption.trim() ? result.image : null;
    const paragraphs=result.paragraphs.map((text,index)=>[text,...(result.paragraphImages || [])
        .filter(image=>image.paragraph===index)
        .map(image=>`[![${escape(image.caption)}](${link(image.url)})](${link(image.source)})`)].join('\n\n'));
    interface Context {[key: string]: string | Context[]}
    const values: Context = {
        title:escape(result.title || t('newsletterBriefTitle')),chapeau:escape(result.chapeau),
        paragraphs_before_image:paragraphs.slice(0,2).join('\n\n'),
        image:image ? (image.generated ? image.markdown || `![${escape(image.caption)}](${image.url})` : `[![${escape(image.caption)}](${link(image.url)})](${link(image.source)})`) : '',
        paragraphs_after_image:paragraphs.slice(2).join('\n\n'),
    };
    const briefRows = brief.map(article=>{
        const url=new URL(article.url);
        if ((url.hostname==='arxiv.org' || url.hostname.endsWith('.arxiv.org')) && url.pathname.startsWith('/pdf/')) {
            url.pathname=url.pathname.replace(/^\/pdf\//,'/abs/').replace(/\.pdf$/i,'');
        }
        const domain=domainOf(url.href);
        return {title:escape(articleTitle(article)),url:link(url.href),source:escape(domain),source_url:link(url.protocol+'//'+domain+'/'),category:escape(article.category?.trim() || '')};
    });
    const groups=new Map<string,typeof briefRows>();
    for (const row of briefRows) {
        if (!groups.has(row.category)) groups.set(row.category,[]);
        groups.get(row.category)!.push(row);
    }
    values.articles = [...groups.values()].flat();
    values.editorial = result.used.length ? [{...values}] : [];
    values.brief = [...groups].map(([category,articles],index)=>({
        heading:[index===0 && result.used.length ? '### '+t('newsletterBriefTitle') : '',
            category ? (result.used.length ? '#### ' : '## ')+category : ''].filter(Boolean).join('\n\n'),articles,
    }));
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

function readFeed(xml: string, limit = 5, base = '', accept?: (entry: Pick<FeedEntry,'url' | 'publish'>)=>boolean): FeedEntry[] {
    const doc = new DOMParser().parseFromString(xml,'text/xml');
    if (doc.querySelector('parsererror') || !doc.querySelector('rss, feed')) throw new Error(t('newsletterFeedFailed'));
    return [...doc.querySelectorAll('item, entry')].slice(0,limit).flatMap(item => {
        const links = [...item.querySelectorAll('link')];
        const link = links.find(node=>!node.getAttribute('rel') || node.getAttribute('rel')==='alternate') || links[0];
        let url = link?.getAttribute('href') || link?.textContent?.trim() || '';
        if (url) {try {url = new URL(url,base || undefined).href;} catch {url='';}}
        const published = item.querySelector('pubDate, published')?.textContent?.trim()
            || item.getElementsByTagName('dc:date')[0]?.textContent?.trim() || '';
        const timestamp = publicationDate(published) ? Date.parse(published) : NaN;
        const publish=Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
        if (accept && !accept({url,publish})) return [];
        const encoded = item.getElementsByTagName('content:encoded')[0];
        const atomContent = item.querySelector('content');
        const content = encoded?.textContent
            || item.querySelector('description, content, summary')?.textContent || '';
        const plain = (html: string) => {
            const doc=parseHTML(html);
            doc.querySelectorAll('script,style').forEach(node=>node.remove());
            return (doc.body.textContent || '').trim();
        };
        const body = plain(content);
        const title = plain(item.querySelector('title')?.textContent || '');
        let html = encoded?.textContent || '';
        if (!html && atomContent && !atomContent.hasAttribute('src')) {
            const type = atomContent.getAttribute('type') || 'text';
            if (type === 'html') html = atomContent.textContent || '';
            else if (type === 'xhtml') html = [...atomContent.children].map(child=>new XMLSerializer().serializeToString(child)).join('');
            else if (type === 'text') {
                const doc=parseHTML('');
                doc.body.textContent=atomContent.textContent;
                html=new XMLSerializer().serializeToString(doc.body);
            }
        }
        const authors=authorNames([
            ...[...item.getElementsByTagName('dc:creator')].map(node=>node.textContent),
            ...[...item.querySelectorAll('author')].map(node=>node.querySelector('name')?.textContent || node.textContent),
        ]);
        return [{title,url,publish,content:body,html,authors}];
    });
}

export {day, availableArticles, briefArticles, briefRequest, parseBrief, selectionRequest, selectArticles, parseSelection, isAuthorSource, assertNoAuthorSources, parseEditorial, parseWriter, publicationCount, publisherRequest, parsePublisher, verificationRequest, parseVerification, renderPrompt, writerRequest, renderNewsletter, applyStatuses, feedUrl, feedUrls, readFeed, preview};
