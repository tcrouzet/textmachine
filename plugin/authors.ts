import {record} from './types';

export function authorNames(input: unknown): string[] {
    const names: string[]=[];
    const visit=(value: unknown): void=>{
        if (Array.isArray(value)) {value.forEach(visit);return;}
        if (value && typeof value==='object') {
            const data=record(value);
            visit(data.name || [data.givenName,data.familyName].filter(part=>typeof part==='string').join(' '));
            return;
        }
        if (typeof value!=='string') return;
        const name=value.replace(/\s+/g,' ').replace(/^(?:written by|by|par|authors?|auteurs?)\s*:?\s+/i,'')
            .replace(/\s*\b(?:published|updated|publié|mis à jour)\b.*$/i,'').trim();
        if (name.length<3 || name.length>180 || /https?:\/\/|www\.|@|^\d|^[#/]/i.test(name) || !/\p{L}/u.test(name)) return;
        if (!names.some(existing=>existing.toLowerCase()===name.toLowerCase())) names.push(name);
    };
    visit(input);
    return names;
}

export function authorsFromText(text: string): string[] {
    const byline=/^(?:By|Par|Written by|Authors?\s*:|Auteurs?\s*:)\s+([\p{Lu}][^\n]{2,159})$/mu.exec(text.slice(0,1000));
    return byline ? authorNames(byline[1]) : [];
}
