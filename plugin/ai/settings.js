const {t} = require('../i18n');
const {models, CODEX_MODEL} = require('./config');

function renderAI(container, plugin, tab, Setting, SecretComponent) {
    const section = container.createDiv('text-machine-section');
    section.createEl('h3', {text:t('aiHeading')});
    const redraw = () => { if (!plugin.disposed && container.isConnected) tab.display(); };
    const save = async action => {
        try { await action(); tab.aiError = ''; }
        catch { tab.aiError = t('aiSaveFailed'); redraw(); }
    };
    const loadModels = async () => {
        if (tab.aiLoading || !tab.codexPath) return;
        tab.aiLoading = true;
        tab.aiError = '';
        redraw();
        const controller = plugin.aiController = new AbortController();
        try { tab.codexModels = await plugin.codex.listModels(tab.codexPath, controller.signal); }
        catch (error) { tab.codexModels = []; tab.aiError = error.message; }
        finally { tab.aiLoading = false; if (plugin.aiController === controller) plugin.aiController = null; redraw(); }
    };
    if (!tab.aiDiscoveryStarted) {
        tab.aiDiscoveryStarted = true;
        void plugin.codex.findCodex().then(executable => {
            if (plugin.disposed) return;
            tab.codexPath = executable;
            if (executable) void loadModels(); else redraw();
        }).catch(() => { tab.codexPath = null; redraw(); });
    }
    for (const [provider,label,url] of [
        ['anthropic',t('aiAnthropicKey'),'https://platform.claude.com/docs/en/get-api-key'],
        ['openai',t('aiOpenaiKey'),'https://platform.openai.com/api-keys'],
    ]) {
        const setting = new Setting(section).setName(label).setDesc(t('aiKeyDescription'));
        setting.descEl.append(' ');
        setting.descEl.createEl('a', {text:t('aiGetKey'),href:url,attr:{target:'_blank',rel:'noopener noreferrer'}});
        setting.addComponent(el => new SecretComponent(plugin.app, el)
            .setValue(plugin.settings[provider + 'SecretId'])
            .onChange(id => save(() => plugin.setAISecret(provider, id))));
    }
    for (const [key,label,description,placeholder] of [
        ['localAIServer',t('aiLocalServer'),t('aiLocalServerDescription'),'http://localhost:11434'],
        ['localAIModel',t('aiLocalModel'),t('aiLocalModelDescription'),t('aiModelId')],
    ]) {
        new Setting(section).setName(label).setDesc(description).addText(text => {
            text.inputEl.setAttribute('aria-label',label);
            text.setValue(plugin.settings[key]).setPlaceholder(placeholder).onChange(value => save(async () => {
                plugin.settings[key] = value.trim();
                await plugin.saveData(plugin.settings);
            }));
        });
    }
    if (tab.codexPath) {
        new Setting(section).setName(t('aiCodexModel')).setDesc(tab.aiLoading ? t('aiLoadingModels') : t('aiCodexDescription'))
            .addDropdown(dropdown => {
                dropdown.selectEl.setAttribute('aria-label',t('aiCodexModel'));
                dropdown.addOption('',t('aiDefaultCodexModel'));
                for (const model of tab.codexModels || []) dropdown.addOption(model.value,model.label);
                const selected = plugin.settings.codexModel;
                if (selected && !tab.codexModels?.some(model => model.value === selected)) {
                    dropdown.addOption(selected,selected + ' (' + t('aiUnavailable') + ')');
                    dropdown.selectEl.lastElementChild.disabled = true;
                }
                dropdown.setValue(selected).setDisabled(!!tab.aiLoading).onChange(value => save(async () => {
                    plugin.settings.codexModel = value;
                    await plugin.saveData(plugin.settings);
                }));
            }).addButton(button => button.setButtonText(t('aiReload')).setDisabled(!!tab.aiLoading).onClick(loadModels));
    }
    const choices = [...models];
    if (tab.codexPath || plugin.settings.aiModel === CODEX_MODEL) choices.push({value:CODEX_MODEL,label:tab.codexPath ? 'Codex' : 'Codex (' + t('aiUnavailable') + ')'});
    const custom = tab.aiCustom || !choices.some(model => model.value === plugin.settings.aiModel);
    new Setting(section).setName(t('aiDefaultModel')).setDesc(t('aiPriorityDescription')).addDropdown(dropdown => {
        dropdown.selectEl.setAttribute('aria-label',t('aiDefaultModel'));
        for (const model of choices) {
            dropdown.addOption(model.value, model.label);
            if (model.value === CODEX_MODEL && !tab.codexPath) dropdown.selectEl.lastElementChild.disabled = true;
        }
        dropdown.addOption('__custom__',t('aiCustomModel'));
        dropdown.setValue(custom ? '__custom__' : plugin.settings.aiModel).onChange(async value => {
            tab.aiCustom = value === '__custom__';
            if (!tab.aiCustom) await save(async () => {plugin.settings.aiModel = value; await plugin.saveData(plugin.settings);});
            redraw();
        });
    });
    if (custom) new Setting(section).setName(t('aiModelId')).addText(text => {
        text.inputEl.setAttribute('aria-label',t('aiModelId'));
        text.setValue(plugin.settings.aiModel).onChange(value => save(async () => {
            plugin.settings.aiModel = value.trim() || models[0].value;
            await plugin.saveData(plugin.settings);
        }));
    });
    section.createEl('p', {cls:'text-machine-note',text:t('aiPromptsDescription')});
    if (tab.aiError) section.createEl('p', {text:tab.aiError,attr:{role:'alert'}});
}

module.exports = {renderAI};
