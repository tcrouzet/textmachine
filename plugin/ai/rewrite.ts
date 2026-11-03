import {markdownLinks} from '../punctuation/markdown-links';
import {t} from '../i18n';

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
