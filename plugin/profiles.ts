import {t} from './i18n';
import {NewsletterProfile,NewsletterSettings,Settings,record} from './types';

export const newsletterDefaults: NewsletterSettings={labelId:'',outputFolder:'',excludedSources:'',newsletterLanguage:'français',
    minimumSources:10,referenceSources:'',includeFeeds:'',authorFeeds:'',generateImages:true};

export function newsletterValues(settings: NewsletterSettings): NewsletterSettings {
    const {labelId,outputFolder,excludedSources,newsletterLanguage,minimumSources,referenceSources,includeFeeds,authorFeeds,generateImages}=settings;
    return {labelId,outputFolder,excludedSources,newsletterLanguage,minimumSources,referenceSources,includeFeeds,authorFeeds,generateImages};
}

export function newsletterProfiles(settings: Settings): NewsletterProfile[] {
    return settings.newsletters.map(profile=>profile.id===settings.activeNewsletter ? {...profile,...newsletterValues(settings)} : profile);
}

export function readProfiles(value: unknown, legacy: NewsletterSettings): NewsletterProfile[] {
    if (value===undefined) return [{id:'default',name:legacy.outputFolder.split('/').pop() || 'Text Machine',...newsletterValues(legacy)}];
    if (!Array.isArray(value) || !value.length) throw new Error(t('invalidNewsletters'));
    const profiles: NewsletterProfile[]=[],ids=new Set<string>();
    for (const entry of value) {
        const row=record(entry);
        if (typeof row.id!=='string' || !row.id.trim() || ids.has(row.id) || typeof row.name!=='string' || !row.name.trim()) throw new Error(t('invalidNewsletters'));
        for (const key of Object.keys(newsletterDefaults) as (keyof NewsletterSettings)[]) {
            if (typeof row[key]!==typeof newsletterDefaults[key]) throw new Error(t('invalidNewsletters'));
        }
        if (!Number.isSafeInteger(row.minimumSources) || Number(row.minimumSources)<1) throw new Error(t('invalidNewsletters'));
        if (row.prompts!==undefined && (typeof row.prompts!=='object' || row.prompts===null || Array.isArray(row.prompts)
            || Object.values(row.prompts).some(text=>typeof text!=='string'))) throw new Error(t('invalidNewsletters'));
        const profile={id:row.id,name:row.name,...newsletterValues(row as unknown as NewsletterSettings),
            ...(row.prompts!==undefined ? {prompts:{...record(row.prompts)} as Record<string,string>} : {})};
        if (profile.outputFolder && profiles.some(other=>foldersOverlap(profile.outputFolder,other.outputFolder))) throw new Error(t('invalidNewsletters'));
        profiles.push(profile);
        ids.add(profile.id);
    }
    return profiles;
}

export function foldersOverlap(first: string, second: string) {
    return !!first && !!second && (first===second || first.startsWith(second+'/') || second.startsWith(first+'/'));
}
