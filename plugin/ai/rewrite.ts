import {markdownLinks} from '../punctuation/markdown-links';
import {t} from '../i18n';
import {record} from '../types';
import rewriteSchema from '../../models/rewriter.json';

export function rewriteRequest(system: string, original: string) {
    const schema=structuredClone(rewriteSchema);
    return {system:system+'\n\n'+t('rewriterContract')+'\n\n'+JSON.stringify({jsonSchema:schema}),input:original,schema};
}

export function parseRewrite(original: string, response: unknown): string[] {
    const invalid = (reason: string): never => {throw new Error(t('newsletterRewriteInvalid',{reason}));};
    if (typeof response!=='string' || !response.trim()) return invalid(t('newsletterRewriteEmpty'));
    let result: Record<string,unknown>;
    try {result=record(JSON.parse(response.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')));}
    catch {return invalid(t('newsletterRewriteFormat'));}
    if (Object.keys(result).length!==1 || !Array.isArray(result.paragraphs) || result.paragraphs.length<2
        || !result.paragraphs.every((value: unknown)=>typeof value==='string' && !!value.trim())) return invalid(t('newsletterRewriteFormat'));
    const paragraphs=result.paragraphs as string[];
    validateRewrite(original,paragraphs.join('\n\n'));
    return paragraphs;
}

export function validateRewrite(original: string, response: unknown): string {
    const invalid = (reason: string) => { throw new Error(t('newsletterRewriteInvalid',{reason})); };
    if (typeof response !== 'string' || !response.trim()) return invalid(t('newsletterRewriteEmpty'));
    const text = response.trim();
    if (text.length < original.trim().length * 0.9) return invalid(t('newsletterRewriteTruncated'));
    const links = (value: string) => markdownLinks(value).map(({from,to,label})=>label
        ? value.slice(from,label[0])+value.slice(label[1],to) : value.slice(from,to));
    const headings = (value: string) => [...value.matchAll(/^(#{1,6})[ \t]+/gm)].map(match=>match[1]);
    let structured = false;
    try {const value: unknown = JSON.parse(text);structured = value!==null && typeof value==='object';} catch { /* Plain prose is expected. */ }
    if (structured || /^```/.test(text) || /!\[|<img\b/i.test(text)
        || JSON.stringify(headings(text)) !== JSON.stringify(headings(original))) return invalid(t('newsletterRewriteFormat'));
    if (JSON.stringify(links(text)) !== JSON.stringify(links(original))) return invalid(t('newsletterRewriteLinks'));
    return text+'\n';
}
