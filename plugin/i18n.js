const messages = { en: require('../locales/en.json'), fr: require('../locales/fr.json') };
let locale = 'en';

function resolveLocale(language) {
    const requested = String(language || '').toLowerCase().replace(/_/g, '-');
    const candidate = Object.hasOwn(messages, requested) ? requested : requested.split('-')[0];
    return Object.hasOwn(messages, candidate) ? candidate : 'en';
}

function setLocale(language) { locale = resolveLocale(language); }
function getLocale() { return locale; }

function t(key, parameters = {}) {
    const message = messages[locale][key] ?? messages.en[key];
    if (typeof message !== 'string') throw new Error(`Unknown translation key: ${key}`);
    return message.replace(/\{(\w+)\}/g, (_match, name) => {
        if (!Object.hasOwn(parameters, name)) throw new Error(`Missing translation parameter: ${name}`);
        const value = parameters[name];
        return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : value;
    });
}

module.exports = { resolveLocale, setLocale, getLocale, t };
