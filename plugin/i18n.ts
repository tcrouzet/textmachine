import en from '../locales/en.json';
import fr from '../locales/fr.json';
const messages: Record<string, Record<string,string>> = {en,fr};
let locale = 'en';

function resolveLocale(language: unknown) {
    const requested = String(language || '').toLowerCase().replace(/_/g, '-');
    const candidate = Object.hasOwn(messages, requested) ? requested : requested.split('-')[0];
    return Object.hasOwn(messages, candidate) ? candidate : 'en';
}

function setLocale(language: unknown) { locale = resolveLocale(language); }
function getLocale() { return locale; }

function t(key: string, parameters: Record<string,string | number> = {}) {
    const message = messages[locale][key] ?? messages.en[key];
    if (typeof message !== 'string') throw new Error(`Unknown translation key: ${key}`);
    return message.replace(/\{(\w+)\}/g, (_match: string, name: string) => {
        if (!Object.hasOwn(parameters, name)) throw new Error(`Missing translation parameter: ${name}`);
        const value = parameters[name];
        return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : value;
    });
}

export { resolveLocale, setLocale, getLocale, t };
