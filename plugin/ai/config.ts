import {t} from '../i18n';
import models from './models.json';
import {Settings, AIProvider, Connection} from '../types';
const CODEX_MODEL = '__codex__';
const defaults = {aiModel:models[0].value, codexModel:'', codexEffort:'low', localAIServer:'', localAIModel:''};

function getConnection(settings: Settings, secrets: (provider: AIProvider)=>string): Connection {
    if (settings.aiModel === CODEX_MODEL) {
        const effort=settings.codexEffort.trim();
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(effort)) throw new Error(t('aiCodexEffortInvalid'));
        return {provider:'codex', apiKey:'', model:settings.codexModel.trim(), effort};
    }
    if (settings.localAIServer.trim()) {
        let url;
        try { url = new URL(settings.localAIServer.trim()); } catch { throw new Error(t('aiInvalidServer')); }
        if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(t('aiInvalidServer'));
        const model = settings.localAIModel.trim();
        if (!model) throw new Error(t('aiMissingLocalModel'));
        const path = url.pathname.replace(/\/+$/, '');
        url.pathname = path.endsWith('/v1') ? path : path + '/v1';
        return {provider:'openai', apiKey:'', model, baseUrl:url.href.replace(/\/$/, '')};
    }
    const provider = /^(gpt|o\d)/i.test(settings.aiModel) ? 'openai' : 'anthropic';
    const apiKey = secrets(provider);
    if (!apiKey) throw new Error(t('aiMissingKey', {provider:provider === 'openai' ? 'OpenAI' : 'Anthropic'}));
    return {provider, apiKey, model:settings.aiModel};
}

export {models, CODEX_MODEL, defaults, getConnection};
