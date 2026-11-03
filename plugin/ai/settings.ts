import {t} from '../i18n';
import {models, CODEX_MODEL} from './config';
import {SecretComponent} from 'obsidian';
import type TextMachine from '../main';
import type {GmailSettings} from '../main';
import {Action,SettingRow,SettingsGroup,errorOf} from '../types';

function renderAI(plugin: TextMachine, tab: GmailSettings): SettingsGroup {
    const redraw = () => { if (!plugin.disposed && tab.containerEl.isConnected) tab.redraw(); };
    const save = async (action: Action) => {
        try { await action(); tab.aiError = ''; }
        catch { tab.aiError = t('aiSaveFailed'); redraw(); }
    };
    const loadModels = async () => {
        if (tab.aiLoading || !tab.codexPath || plugin.busy) return;
        tab.aiLoading = true;
        tab.aiError = '';
        redraw();
        const controller = plugin.aiController = new AbortController();
        try { tab.codexModels = await plugin.codex.listModels(tab.codexPath, controller.signal); }
        catch (error) { tab.codexModels = []; tab.aiError = errorOf(error).message; }
        finally { tab.aiLoading = false; if (plugin.aiController === controller) plugin.aiController = null; redraw(); }
    };
    const discover = () => {
        if (tab.aiDiscoveryStarted) return;
        tab.aiDiscoveryStarted = true;
        void plugin.codex.findCodex().then(executable => {
            if (plugin.disposed) return;
            tab.codexPath = executable;
            if (executable) void loadModels(); else redraw();
        }).catch(() => { tab.codexPath = null; redraw(); });
    };
    const items: SettingRow[] = [];
    for (const [provider,label,url] of [
        ['anthropic',t('aiAnthropicKey'),'https://platform.claude.com/docs/en/get-api-key'],
        ['openai',t('aiOpenaiKey'),'https://platform.openai.com/api-keys'],
    ] as const) {
        items.push({name:label,desc:t('aiKeyDescription'),render:setting=>{
            setting.descEl.append(' ');
            setting.descEl.createEl('a', {text:t('aiGetKey'),href:url,attr:{target:'_blank',rel:'noopener noreferrer'}});
            setting.addComponent(el => new SecretComponent(plugin.app, el)
                .setValue(plugin.settings[`${provider}SecretId`] || '')
                .onChange(id => save(() => plugin.setAISecret(provider, id))));
        }});
    }
    for (const [key,label,description,placeholder] of [
        ['localAIServer',t('aiLocalServer'),t('aiLocalServerDescription'),'http://localhost:11434'],
        ['localAIModel',t('aiLocalModel'),t('aiLocalModelDescription'),t('aiModelId')],
    ] as const) {
        items.push({name:label,desc:description,render:setting=>{setting.addText(text => {
            text.inputEl.setAttribute('aria-label',label);
            text.setValue(plugin.settings[key]).setPlaceholder(placeholder).onChange(value => save(async () => {
                plugin.settings[key] = value.trim();
                await plugin.saveData(plugin.settings);
            }));
        });}});
    }
    if (tab.codexPath) items.push({name:t('aiCodexModel'),desc:tab.aiLoading ? t('aiLoadingModels') : t('aiCodexDescription'),render:setting=>{
        setting.addDropdown(dropdown => {
            dropdown.selectEl.setAttribute('aria-label',t('aiCodexModel'));
            dropdown.addOption('',t('aiDefaultCodexModel'));
            for (const model of tab.codexModels) dropdown.addOption(model.value,model.label);
            const selected = plugin.settings.codexModel;
            if (selected && !tab.codexModels.some(model => model.value === selected)) {
                dropdown.addOption(selected,selected + ' (' + t('aiUnavailable') + ')');
                const option=dropdown.selectEl.lastElementChild;
                if (option instanceof HTMLOptionElement) option.disabled = true;
            }
            dropdown.setValue(selected).setDisabled(tab.aiLoading || plugin.busy).onChange(value => save(async () => {
                plugin.settings.codexModel = value;
                await plugin.saveData(plugin.settings);
            }));
        }).addButton(button => button.setButtonText(t('aiReload')).setDisabled(tab.aiLoading || plugin.busy).onClick(loadModels));
    }});
    const choices = [...models];
    if (tab.codexPath || plugin.settings.aiModel === CODEX_MODEL) choices.push({value:CODEX_MODEL,label:tab.codexPath ? 'Codex' : 'Codex (' + t('aiUnavailable') + ')'});
    const custom = tab.aiCustom || !choices.some(model => model.value === plugin.settings.aiModel);
    items.push({name:t('aiDefaultModel'),desc:t('aiPriorityDescription'),render:setting=>{
        setting.addDropdown(dropdown => {
            dropdown.selectEl.setAttribute('aria-label',t('aiDefaultModel'));
            for (const model of choices) {
                dropdown.addOption(model.value, model.label);
                const option=dropdown.selectEl.lastElementChild;
                if (model.value === CODEX_MODEL && !tab.codexPath && option instanceof HTMLOptionElement) option.disabled = true;
            }
            dropdown.addOption('__custom__',t('aiCustomModel'));
            dropdown.setValue(custom ? '__custom__' : plugin.settings.aiModel).onChange(async value => {
                tab.aiCustom = value === '__custom__';
                if (!tab.aiCustom) await save(async () => {plugin.settings.aiModel = value; await plugin.saveData(plugin.settings);});
                redraw();
            });
        });
        discover();
    }});
    if (custom) items.push({name:t('aiModelId'),render:setting=>{setting.addText(text => {
        text.inputEl.setAttribute('aria-label',t('aiModelId'));
        text.setValue(plugin.settings.aiModel).onChange(value => save(async () => {
            plugin.settings.aiModel = value.trim() || models[0].value;
            await plugin.saveData(plugin.settings);
        }));
    });}});
    items.push({name:t('aiPromptsDescription'),searchable:false});
    if (tab.aiError) items.push({name:tab.aiError,searchable:false,render:setting=>{setting.settingEl.setAttribute('role','alert');}});
    return {type:'group',heading:t('aiHeading'),cls:'text-machine-section',items};
}

export {renderAI};
