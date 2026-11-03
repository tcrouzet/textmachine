import { App, Plugin, PluginSettingTab, Setting, Notice, addIcon, setIcon, requestUrl, SecretComponent, Modal, TFolder, TFile, getLanguage } from 'obsidian';
import { shell } from 'electron';
import { BrowserWindow } from '@electron/remote';
import { randomUUID } from 'node:crypto';
import * as i18n from './i18n';
import * as gmail from './gmail';
import * as articles from './articles';
import * as crawler from './crawler';
import * as browser from './browser';
import * as ai from './ai/config';
import * as codex from './ai/codex';
import {renderAI} from './ai/settings';
import {Settings, Account, Label, Progress, Action, AIProvider, Article, errorOf} from './types';
import * as newsletter from './newsletter';
import * as generation from './ai/generate';
import * as imageCheck from './ai/image';
import writerPrompt from '../prompts/writer.md';
import newsletterTemplate from '../models/newsletter.md';
import imagePrompt from '../prompts/image.md';
import textMachineIcon from '../icon.svg';
const {t} = i18n;

export default class TextMachine extends Plugin {
    declare settings: Settings;
    i18n = i18n;
    browser = browser;
    gmail = gmail;
    articles = articles;
    crawler = crawler;
    ai = ai;
    codex = codex;
    newsletter = newsletter;
    generate = generation.generate;
    request = requestUrl;
    requestAI = generation.requestStream;
    renderAI = renderAI;
    labels: Label[] = [];
    busy = false;
    loaded = false;
    disposed = false;
    authorizationRequired = false;
    account: Account | null = null;
    email = '';
    oauth: ReturnType<typeof gmail.parseCredentials> | null = null;
    client: InstanceType<typeof gmail.GmailClient> | null = null;
    configurationError = '';
    auth: AbortController | null = null;
    aiController: AbortController | null = null;
    crawlController: AbortController | null = null;
    runDialog: TextMachineRun | null = null;
    folderIconStyle?: HTMLStyleElement;
    loadPage = (url: string, signal: AbortSignal, blocked: (url: string) => boolean) => browser.loadPage(url, signal, blocked, BrowserWindow);

    async onload() {
        i18n.setLocale(getLanguage());
        this.gmail = gmail;
        this.articles = articles;
        this.crawler = crawler;
        this.loadPage = (url, signal, blocked) => browser.loadPage(url, signal, blocked, BrowserWindow);
        this.ai = ai;
        this.codex = codex;
        this.renderAI = renderAI;
        this.settings = { ...this.ai.defaults, secretKey: '', labelId: '', outputFolder: '', excludedSources: '', ...await this.loadData() };
        this.labels = [];
        this.busy = false;
        this.loaded = false;
        this.disposed = false;
        this.authorizationRequired = false;
        if (!this.app.secretStorage) {
            new Notice(t('requiresVersion'));
            return;
        }
        if (!this.settings.secretKey) {
            this.settings.secretKey = 'text-machine-' + randomUUID();
            await this.saveData(this.settings);
        }
        let migratedAISecrets = false;
        for (const provider of ['anthropic', 'openai'] as const) {
            const field = `${provider}SecretId` as const;
            if (this.settings[field] === undefined) {
                const legacyId = this.settings.secretKey + '-ai-' + provider;
                this.settings[field] = this.app.secretStorage.getSecret(legacyId) ? legacyId : '';
                migratedAISecrets = true;
            }
        }
        if (migratedAISecrets) await this.saveData(this.settings);
        try {
            const stored = this.app.secretStorage.getSecret(this.settings.secretKey);
            this.account = stored ? JSON.parse(stored) : null;
        } catch {
            this.account = null;
            new Notice(t('unreadableSession'));
        }
        this.email = this.account?.email || '';
        this.oauth = null;
        try {
            const json = await this.app.vault.adapter.read(this.manifest.dir + '/oauth-client.json');
            this.oauth = this.gmail.parseCredentials(json);
        } catch {
            this.configurationError = t('oauthNotConfigured');
        }
        this.makeClient();
        addIcon('text-machine', textMachineIcon);
        this.addSettingTab(new GmailSettings(this.app, this));
        this.app.workspace.onLayoutReady(async () => {
            if (this.disposed) return;
            const style = this.folderIconStyle = document.head.createEl('style');
            this.register(() => style.remove());
            this.updateFolderIcon();
            if (this.dataReady) {
                const file = this.app.vault.getAbstractFileByPath(this.dataPath) as TFile;
                try { await this.app.vault.process(file,text=>this.articles.withIds(text)); }
                catch (caught) { new Notice(errorOf(caught).message); }
            }
        });
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
            if (!(file instanceof TFolder) || (this.dataReady && file.path !== this.settings.outputFolder)) return;
            menu.addItem(item => item.setTitle('Text Machine').setIcon('text-machine').setDisabled(this.busy)
                .onClick(() => this.openTextMachine(file.path)));
        }));
    }

    updateFolderIcon() {
        if (!this.folderIconStyle) return;
        const path = this.settings.outputFolder;
        this.folderIconStyle.textContent = path ? `
            .workspace-leaf-content[data-type="file-explorer"] .nav-folder-title[data-path="${CSS.escape(path)}"] > .nav-folder-title-content::after {
                content: "";
                display: inline-block;
                width: var(--icon-size);
                height: var(--icon-size);
                margin-inline-start: var(--size-4-2);
                vertical-align: middle;
                background-color: currentColor;
                mask: url("data:image/svg+xml,${encodeURIComponent(textMachineIcon)}") center / contain no-repeat;
            }
        ` : '';
    }

    getAIKey(provider: AIProvider) {
        const id = this.settings[`${provider}SecretId`];
        return id ? this.app.secretStorage.getSecret(id) || '' : '';
    }

    async setAISecret(provider: AIProvider, id: string | null) {
        this.settings[`${provider}SecretId`] = id || '';
        await this.saveData(this.settings);
    }

    getAIConnection() {
        return this.ai.getConnection(this.settings, (provider: AIProvider) => this.getAIKey(provider));
    }

    get isConnected() {
        return !!(this.client && this.account?.email && this.account?.refreshToken
            && this.account.clientId === this.oauth?.clientId && !this.authorizationRequired
            && this.account.scope?.split(' ').includes(this.gmail.SCOPE));
    }

    openTextMachine(folderPath: string) {
        if (this.busy || this.runDialog) return;
        this.runDialog = new TextMachineRun(this.app, this, folderPath);
        this.runDialog.open();
    }

    makeClient() {
        const refreshToken = this.account?.clientId === this.oauth?.clientId ? this.account?.refreshToken : '';
        this.client = this.oauth ? new this.gmail.GmailClient({ ...this.oauth, refreshToken }, requestUrl, async (refreshToken: string) => {
            if (this.disposed) throw new Error(t('pluginDisabled'));
            this.account!.refreshToken = refreshToken;
            this.saveAccount();
        }) : null;
    }

    saveAccount() {
        this.app.secretStorage.setSecret(this.settings.secretKey, JSON.stringify(this.account));
    }

    async connect() {
        const email = this.email.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(t('invalidEmail'));
        if (!this.oauth) throw new Error(this.configurationError);
        this.auth = new AbortController();
        try {
            const tokens = await this.gmail.authorize(this.oauth, requestUrl, (url: string) => shell.openExternal(url), this.auth.signal, email);
            if (this.disposed) return;
            const account: Account = { email:'', clientId: this.oauth.clientId, scope: tokens.scope };
            let committed = false;
            const client = new this.gmail.GmailClient(this.oauth, requestUrl, async (refreshToken: string) => {
                if (this.disposed) throw new Error(t('pluginDisabled'));
                account.refreshToken = refreshToken;
                if (committed) this.saveAccount();
            });
            await client.setTokens(tokens);
            const profile = await client.get('profile');
            if (typeof profile.emailAddress !== 'string') throw new Error(t('unknownAccount'));
            const labels = await client.labels();
            if (this.disposed) return;
            account.email = profile.emailAddress;
            const sameAccount = this.account?.email?.toLowerCase() === account.email.toLowerCase();
            const labelId = sameAccount && labels.some((label: Label) => label.id === this.settings.labelId) ? this.settings.labelId : '';
            await this.saveData({ ...this.settings, labelId });
            this.account = account;
            this.client = client;
            this.email = account.email;
            this.settings.labelId = labelId;
            this.labels = labels;
            this.loaded = true;
            this.authorizationRequired = false;
            committed = true;
            this.saveAccount();
        } finally {
            this.auth = null;
        }
    }

    async refreshLabels() {
        this.loaded = true;
        this.labels = await this.client!.labels();
        if (this.settings.labelId && !this.labels.some((label: Label) => label.id === this.settings.labelId)) {
            this.settings.labelId = '';
            await this.saveData(this.settings);
            new Notice(t('labelRemoved'));
        }
    }

    async disconnect() {
        await this.client!.disconnect();
        this.account = null;
        this.saveAccount();
        this.settings.labelId = '';
        this.labels = [];
        this.loaded = false;
        this.makeClient();
        await this.saveData(this.settings);
    }

    get dataPath() {
        return (this.settings.outputFolder ? this.settings.outputFolder + '/' : '') + 'textmachine.json';
    }

    get dataReady() {
        return !!this.settings.outputFolder
            && this.app.vault.getAbstractFileByPath(this.settings.outputFolder) instanceof TFolder
            && this.app.vault.getAbstractFileByPath(this.dataPath) instanceof TFile;
    }

    async ensureData(folderPath = this.settings.outputFolder) {
        const vault = this.app.vault;
        if (typeof folderPath !== 'string' || !folderPath || (folderPath && folderPath.split('/').some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part)))) {
            throw new Error(t('chooseVaultFolder'));
        }
        const parentPath = folderPath.split('/').slice(0, -1).join('/');
        if (parentPath && !(vault.getAbstractFileByPath(parentPath) instanceof TFolder)) {
            throw new Error(t('parentMoved'));
        }
        const folder = folderPath ? vault.getAbstractFileByPath(folderPath) : vault.getRoot();
        if (!folder) await vault.createFolder(folderPath);
        else if (!(folder instanceof TFolder)) throw new Error(t('fileAtFolderPath'));
        const contents = await vault.adapter.list(folderPath);
        if (contents.files.length || contents.folders.length) throw new Error(t('chooseEmptyFolderError'));
        return await vault.create(folderPath + '/textmachine.json', JSON.stringify({ version: 1, articles: [] }, null, 2) + '\n');
    }

    get blockedPath() {
        return this.settings.outputFolder + '/blocked.json';
    }

    async readBlocked() {
        const file = this.app.vault.getAbstractFileByPath(this.blockedPath) as TFile | null;
        return file ? this.crawler.parseBlocked(await this.app.vault.read(file)) : [];
    }

    async crawlArticles(progress?: Progress) {
        const vault = this.app.vault;
        const log = vault.getAbstractFileByPath(this.dataPath) as TFile;
        const blocked = await this.readBlocked();
        const blockedFile = vault.getAbstractFileByPath(this.blockedPath) as TFile | null;
        if (blockedFile) await vault.process(blockedFile, text => JSON.stringify(this.crawler.parseBlocked(text), null, 2) + '\n');
        const articles = this.articles.parseData(await vault.read(log)).articles;
        this.crawlController = new AbortController();
        try {
            for (const article of articles) {
                if (this.disposed) throw new Error(t('pluginDisabled'));
                if (article.status === 'forbidden') continue;
                if (this.articles.isPdf(article.url) || article.status === '404' || this.crawler.isBlocked(article.url,blocked)) {
                    await vault.process(log,text => {
                        const current = this.articles.parseData(text);
                        const saved = current.articles.find((item: Article)=>item.url === article.url);
                        if (saved) saved.status = 'forbidden';
                        return JSON.stringify(current,null,2) + '\n';
                    });
                    continue;
                }
                if (article.content) continue;
                progress?.(t('crawlingArticle', {url:article.url}));
                const before = JSON.stringify(blocked);
                const result = await this.crawler.crawl(article, blocked, this.crawlController.signal, this.loadPage);
                if (JSON.stringify(blocked) !== before) {
                    const blockedFile = vault.getAbstractFileByPath(this.blockedPath) as TFile | null;
                    if (blockedFile) await vault.process(blockedFile, text => {
                        const current = this.crawler.parseBlocked(text);
                        for (const domain of blocked) this.crawler.block(current, domain);
                        return JSON.stringify(current, null, 2) + '\n';
                    });
                    else await vault.create(this.blockedPath, JSON.stringify(blocked, null, 2) + '\n');
                }
                await vault.process(log, text => {
                    const current = this.articles.parseData(text);
                    const saved = current.articles.find((item: {url:string}) => item.url === article.url);
                    if (saved) {
                        for (const key of ['publish', 'content', 'image']) saved[key] ||= result[key];
                        if (result.status === 'forbidden') saved.status = 'forbidden';
                        else if (saved.status === '404') saved.status = '';
                    }
                    return JSON.stringify(current, null, 2) + '\n';
                });
            }
        } finally { this.crawlController = null; }
    }

    async importUnread(progress?: Progress) {
        if (!this.client || !this.account?.email || !this.settings.labelId) throw new Error(t('connectAndChooseLabel'));
        if (!this.dataReady) throw new Error(t('createFolderFirst'));
        if (!this.account.scope?.split(' ').includes(this.gmail.SCOPE)) throw new Error(t('readPermissionMissing'));
        const log = this.app.vault.getAbstractFileByPath(this.dataPath) as TFile;
        await this.app.vault.process(log,text=>this.articles.withIds(text));
        const labelId = this.settings.labelId;
        const blocked = await this.readBlocked();
        let added = 0, links = 0, skipped = 0;
        try {
            for await (const id of this.client.unreadMessages(labelId)) {
                if (this.disposed) throw new Error(t('pluginDisabled'));
                const message = await this.client.message(id);
                if (!message.labelIds.includes('UNREAD') || !message.labelIds.includes(labelId)) continue;
                const entry = this.articles.messageArticles(message)
                    .filter(article => !this.articles.isExcluded(article, this.settings.excludedSources))
                    .map(article=>this.crawler.isBlocked(article.url,blocked) ? {...article,status:'forbidden'} : article);
                if (this.disposed) throw new Error(t('pluginDisabled'));
                let result!: ReturnType<typeof articles.mergeArticles>;
                await this.app.vault.process(log, current => {
                    result = this.articles.mergeArticles(current, entry);
                    return result.text;
                });
                if (result.added) { added++; links += result.count; } else skipped++;
                if (this.disposed) throw new Error(t('pluginDisabled'));
                await this.client.markRead(id);
                progress?.(t('importProgress', { added, links }));
            }
            await this.crawlArticles(progress);
        } catch (caught) {
            const error = errorOf(caught);
            if (error.code === 'AUTH_REQUIRED') this.authorizationRequired = true;
            const failure = new Error(t('importFailed', { error: error.message, added }));
            Object.assign(failure, {code:error.code});
            throw failure;
        }
        return t('importComplete', { added, links, skipped, path: log.path });
    }

    async writeNewsletter(progress?: Progress) {
        if (!this.dataReady) throw new Error(t('createFolderFirst'));
        const vault = this.app.vault;
        const log = vault.getAbstractFileByPath(this.dataPath) as TFile;
        const day = this.newsletter.day();
        const folder = vault.getAbstractFileByPath(this.settings.outputFolder) as TFolder;
        const notes = folder.children.filter((file): file is TFile => file instanceof TFile && /^text-machine-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/.test(file.name));
        const todayNotes = await Promise.all(notes.filter(file=>file.name.startsWith('text-machine-'+day)).map(file=>vault.read(file)));
        await vault.process(log,text=>this.articles.withIds(text));
        const data = await vault.read(log);
        const pending: Article[] = this.newsletter.availableArticles(data,this.settings.excludedSources,day,todayNotes);
        const brief: Article[] = this.newsletter.briefArticles(data,this.settings.excludedSources,day);
        if (!pending.length && !brief.length) {new Notice(t('newsletterNoArticles'));return null;}
        let template = newsletterTemplate;
        const templatePath = this.manifest.dir + '/models/newsletter.md';
        if (await vault.adapter.exists(templatePath)) template = await vault.adapter.read(templatePath);
        if (!template.trim()) throw new Error(t('newsletterTemplateInvalid'));
        const controller = this.aiController = new AbortController();
        const check = () => {if (this.disposed || controller.signal.aborted) throw new Error(t('newsletterCancelled'));};
        try {
            let result: ReturnType<typeof newsletter.parseNewsletter> = {title:'',chapeau:'',paragraphs:[],lead:null,image:null,groups:[],used:[],discard:[]};
            if (pending.length) {
                let prompt = writerPrompt;
                const promptPath = this.manifest.dir + '/prompts/writer.md';
                if (await vault.adapter.exists(promptPath)) prompt = await vault.adapter.read(promptPath);
                if (!prompt.trim()) throw new Error(t('writerPromptEmpty'));
                const connection = this.getAIConnection();
                const oldNotes = notes.filter(file=>!file.name.startsWith('text-machine-'+day))
                    .sort((a,b)=>b.stat.mtime-a.stat.mtime).slice(0,5);
                const previous = await Promise.all(oldNotes.map(async file=>({name:file.name,content:await vault.read(file)})));
                progress?.(t('newsletterReadingContext'));
                const response = await generation.requestWithSignal({url:'https://tcrouzet.substack.com/feed',throw:false},this.request,controller.signal);
                check();
                if (response.status !== 200) throw new Error(t('newsletterFeedFailed'));
                const recent = this.newsletter.readFeed(response.text);
                const input = this.newsletter.writerRequest(prompt,pending,previous,recent);
                progress?.(t('newsletterWriting'));
                const text = connection.provider === 'codex'
                    ? await this.codex.generate(await this.codex.findCodex(),input.system,input.input,connection.model,controller.signal,progress,this.newsletter.schema)
                    : await this.generate(connection,input.system,input.input,this.requestAI,controller.signal,progress);
                check();
                result = this.newsletter.parseNewsletter(text,pending);
                if (result.image) {
                    progress?.(t('newsletterCheckingImage'));
                    try {
                        const imageUrl = result.image.url;
                        if (!await this.browser.publicUrl(imageUrl)) result.image = null;
                        else {
                            const lead = pending.find(article=>article.url === result.lead)!;
                            let prompt = imagePrompt;
                            const path = this.manifest.dir + '/prompts/image.md';
                            if (await vault.adapter.exists(path)) prompt = await vault.adapter.read(path);
                            const request = imageCheck.request(result,lead,prompt);
                            const response = connection.provider === 'codex'
                                ? await this.codex.generate(await this.codex.findCodex(),request.system,request.input,connection.model,controller.signal,undefined,request.schema,imageUrl)
                                : await this.generate(connection,request.system,request.input,this.requestAI,controller.signal,undefined,imageUrl);
                            check();
                            result = imageCheck.apply(result,response);
                        }
                    } catch {
                        check();
                        result.image = null;
                    }
                    if (!result.image) progress?.(t('newsletterImageOmitted'));
                }
                if (!result.used.length && (!brief.length || pending.some(article=>article.status === 'used'))) {
                    await vault.process(log,current=>this.newsletter.applyStatuses(current,pending.filter(article=>article.status === ''),result,day));
                    new Notice(t('newsletterNoArticles'));
                    return null;
                }
            }
            const markdown = this.newsletter.renderNewsletter(template,result,pending,brief);
            const path = this.settings.outputFolder + '/text-machine-' + day + '.md';
            const existing = vault.getAbstractFileByPath(path);
            check();
            let note: TFile;
            if (existing instanceof TFile) {await vault.modify(existing,markdown);note = existing;}
            else note = await vault.create(path,markdown);
            try {await vault.process(log,current=>this.newsletter.applyStatuses(current,pending,result,day,brief));}
            catch {throw new Error(t('newsletterStatusFailed',{path}));}
            try {await this.app.workspace.getLeaf(false).openFile(note);}
            catch {new Notice(t('newsletterCreated',{path}));}
            return note;
        } finally {if (this.aiController === controller) this.aiController = null;}
    }

    onunload() {
        this.disposed = true;
        this.aiController?.abort();
        this.crawlController?.abort();
        this.runDialog?.close();
        this.auth?.abort();
    }
};

class TextMachineRun extends Modal {
    plugin: TextMachine;
    folderPath: string;
    closed = false;
    working = false;
    error = '';
    result = '';
    statusEl?: HTMLElement;
    logEl?: HTMLElement;
    outputEl?: HTMLElement;
    aiText = '';
    notePath = '';

    constructor(app: App, plugin: TextMachine, folderPath: string) {
        super(app);
        this.plugin = plugin;
        this.folderPath = folderPath;
    }

    onOpen() { this.titleEl.setText('Text Machine'); void this.advance(); }

    onClose() {
        this.closed = true;
        if (this.working) {this.plugin.auth?.abort();this.plugin.aiController?.abort();}
        this.plugin.runDialog = null;
    }

    async perform(action: Action, resume = true) {
        const p = this.plugin;
        if (p.busy || this.closed) return;
        p.busy = true;
        this.working = true;
        this.aiText = '';
        this.outputEl = undefined;
        this.error = '';
        this.render();
        let success = false;
        try { await action(); success = true; }
        catch (caught) {
            const error = errorOf(caught);
            if (error.code === 'AUTH_REQUIRED') p.authorizationRequired = true;
            this.error = error.message;
        } finally {
            p.busy = false;
            this.working = false;
            if (!this.closed) {
                if (success && resume) await this.advance();
                else this.render();
            } else if (this.result || this.error) new Notice(this.error || this.result, 10000);
        }
    }

    async advance() {
        const p = this.plugin;
        if (this.closed || p.disposed) return;
        this.render();
        if (!p.isConnected || !p.dataReady) return;
        if (!p.settings.labelId) {
            if (!p.loaded) await this.perform(() => p.refreshLabels(), false);
            return;
        }
        await this.perform(async () => {
            const progress: Progress = (message,stream) => this.showProgress(message,stream);
            const collected = await p.importUnread(progress);
            if (this.closed || p.disposed) return;
            const note = await p.writeNewsletter(progress);
            this.result = collected;
            this.notePath = note?.path || '';
        }, false);
    }

    showProgress(message: string, stream = false) {
        if (this.closed || !this.logEl) return;
        const follow = this.logEl.scrollHeight-this.logEl.scrollTop-this.logEl.clientHeight <= 1;
        if (stream) {
            this.aiText += message;
            const preview = this.plugin.newsletter.preview(this.aiText);
            if (preview) {
                this.outputEl ||= this.logEl.createEl('pre',{cls:'text-machine-live-output'});
                this.outputEl.setText(preview);
            }
        } else {
            this.statusEl?.setText(message);
            this.logEl.createEl('p',{text:message});
        }
        if (follow) this.logEl.scrollTop = this.logEl.scrollHeight;
    }

    render() {
        const p = this.plugin, el = this.contentEl;
        el.empty();
        if (this.error) el.createEl('p', {text:this.error, attr:{role:'alert'}});
        if (this.working) {
            const activity = el.createDiv('text-machine-activity');
            const spinner = activity.createSpan({cls:'text-machine-spinner',attr:{'aria-hidden':'true'}});
            setIcon(spinner,'loader-circle');
            this.statusEl = activity.createSpan({text:p.isConnected ? t('readingUnread') : t('finishInBrowser'),attr:{role:'status'}});
            this.logEl = el.createDiv({cls:'text-machine-run-log',attr:{role:'log','aria-label':t('activityLog'),'aria-live':'off',tabindex:'0'}});
            return;
        }
        if (this.result) {
            el.createEl('p', {text:this.result, attr:{role:'status'}});
            if (this.notePath) el.createEl('p',{text:t('newsletterCreated',{path:this.notePath}),attr:{role:'status'}});
            return;
        }
        if (!p.isConnected) {
            el.createEl('p', {text:t('connectToRun')});
            new Setting(el).setName(t('emailAddress')).addText(text => {
                text.inputEl.type = 'email';
                text.inputEl.setAttribute('aria-label', t('emailAddress'));
                text.setValue(p.email).setPlaceholder(t('emailPlaceholder')).onChange(value => {p.email = value;});
            }).addButton(button => button.setButtonText(t('connectGmail')).setCta().setDisabled(!p.oauth)
                .onClick(() => this.perform(() => p.connect())));
            if (p.configurationError) el.createEl('p', {text:p.configurationError, attr:{role:'alert'}});
            return;
        }
        if (!p.dataReady) {
            el.createEl('p', {text:t('createFolderFirst')});
            new Setting(el).addButton(button => button.setButtonText(t('createFolder')).setCta().onClick(() => {
                new FolderPicker(this.app, this.folderPath, async folder => {
                    await p.ensureData(folder);
                    p.settings.outputFolder = folder;
                    p.updateFolderIcon();
                    await p.saveData(p.settings);
                    void this.advance();
                }).open();
            }));
            return;
        }
        if (!p.settings.labelId) {
            new Setting(el).setName(t('gmailLabel')).addDropdown(dropdown => {
                dropdown.selectEl.setAttribute('aria-label', t('gmailLabel'));
                dropdown.addOption('',t('chooseLabel'));
                for (const label of p.labels) dropdown.addOption(label.id,label.name);
                dropdown.onChange(id => this.perform(async () => {
                    if (!p.labels.some((label: Label) => label.id === id)) throw new Error(t('unknownLabel'));
                    p.settings.labelId = id;
                    await p.saveData(p.settings);
                }));
            }).addButton(button => button.setButtonText(t('refresh')).onClick(() => this.perform(() => p.refreshLabels(), false)));
            return;
        }
        new Setting(el).addButton(button => button.setButtonText(t('retry')).setCta().onClick(() => this.advance()));
    }
}

class FolderPicker extends Modal {
    choose: (folder: string) => Promise<void>;
    folder: TFolder;
    newName = 'TextMachine';
    working = false;
    error = '';

    constructor(app: App, startPath: string, choose: (folder: string) => Promise<void>) {
        super(app);
        this.choose = choose;
        const folder = app.vault.getAbstractFileByPath(startPath);
        this.folder = folder instanceof TFolder ? folder : app.vault.getRoot();
        this.newName = 'TextMachine';
    }

    onOpen() { this.render(); }

    async select(create = false) {
        if (this.working) return;
        this.working = true;
        this.error = '';
        this.render();
        try {
            let destination = this.folder.isRoot() ? '' : this.folder.path;
            if (create) {
                const name = this.newName.trim();
                if (!name || name === '.' || name === '..' || /[\\/:]/.test(name) || [...name].some(character => character.charCodeAt(0) < 32)) {
                    throw new Error(t('invalidFolderName'));
                }
                destination = (destination ? destination + '/' : '') + name;
                if (this.app.vault.getAbstractFileByPath(destination)) throw new Error(t('folderNameExists'));
            }
            await this.choose(destination);
            this.close();
        } catch (caught) {
            const error = errorOf(caught);
            this.error = error.message;
        } finally {
            this.working = false;
            this.render();
        }
    }

    render() {
        const el = this.contentEl;
        el.empty();
        el.createEl('h2', { text: t('journalFolder') });
        el.createEl('p', { text: this.folder.isRoot() ? t('vaultRoot') : this.folder.path });
        const list = el.createDiv('text-machine-folders');
        const root = list.createEl('button', { text: t('vaultRoot') });
        root.disabled = this.working;
        root.classList.toggle('is-selected', this.folder.isRoot());
        root.addEventListener('click', () => { this.folder = this.app.vault.getRoot(); this.error = ''; this.render(); });
        if (!this.folder.isRoot() && !this.folder.parent!.isRoot()) {
            const parent = list.createEl('button', { text: '.. / ' + this.folder.parent!.path, attr: { 'aria-label': t('parentFolder') } });
            parent.disabled = this.working;
            parent.addEventListener('click', () => { this.folder = this.folder.parent!; this.error = ''; this.render(); });
        }
        if (!this.folder.isRoot()) {
            const current = list.createEl('button', { text: this.folder.name, cls: 'is-selected', attr: { 'aria-current': 'location' } });
            current.disabled = this.working;
        } else root.setAttribute('aria-current', 'location');
        const folders = this.folder.children.filter(child => child instanceof TFolder).sort((a, b) => a.name.localeCompare(b.name));
        for (const folder of folders) {
            const button = list.createEl('button', { text: folder.name, attr: { 'aria-label': t('openFolder', { name: folder.name }) } });
            button.disabled = this.working;
            button.addEventListener('click', () => { this.folder = folder; this.error = ''; this.render(); });
        }
        if (!folders.length) list.createEl('p', { text: t('noSubfolders') });
        const rows = [...list.querySelectorAll('button')];
        for (const row of rows) {
            row.classList.add('tree-item-self');
            row.addEventListener('keydown', event => {
                if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
                event.preventDefault();
                const index = rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1);
                rows[Math.max(0, Math.min(rows.length - 1, index))].focus();
            });
        }

        new Setting(el).setName(t('newFolderName'))
            .addText(text => {
                text.inputEl.setAttribute('aria-label', t('newFolderInput'));
                text.setValue(this.newName).setDisabled(this.working).onChange(value => { this.newName = value; });
            })
            .addButton(button => button.setButtonText(t('createHere')).setCta().setDisabled(this.working).onClick(() => this.select(true)));
        new Setting(el).setDesc(t('folderPickerDescription'))
            .addButton(button => button.setButtonText(t('chooseFolder')).setDisabled(this.working || this.folder.isRoot() || this.folder.children.length > 0).onClick(() => this.select()))
            .addButton(button => button.setButtonText(t('cancel')).setDisabled(this.working).onClick(() => this.close()));
        if (this.error) el.createEl('p', { text: this.error, attr: { role: 'alert' } });
    }
}

class GmailSettings extends PluginSettingTab {
    override icon = 'text-machine';
    plugin: TextMachine;
    error = '';
    result = '';
    progress = '';

    constructor(app: App, plugin: TextMachine) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async run(message: string, action: Action) {
        const p = this.plugin;
        if (p.busy) return;
        p.busy = true;
        this.error = '';
        this.result = '';
        this.progress = message;
        this.display();
        try {
            const pending = action();
            this.display();
            await pending;
        } catch (caught) {
            const error = errorOf(caught);
            if (error.code === 'AUTH_REQUIRED') p.authorizationRequired = true;
            this.error = error.message;
        } finally {
            p.busy = false;
            if (!p.disposed) this.display();
        }
    }

    display() {
        const p = this.plugin;
        const el = this.containerEl;
        const connected = p.isConnected;
        el.empty();
        el.addClass('text-machine-settings');
        el.createEl('h2', { text: 'TextMachine' });
        el.createEl('p', { cls: 'text-machine-intro', text: t('intro') });
        const account = el.createDiv('text-machine-section');
        account.createEl('h3', { text: t('accountHeading') });
        if (connected) {
            new Setting(account).setName(p.account!.email)
                .setDesc(t('accountConnected'))
                .addButton(button => button.setButtonText(t('disconnect')).setDisabled(p.busy)
                    .onClick(() => this.run(t('disconnecting'), () => p.disconnect())));
        } else {
            const emailSetting = new Setting(account).setName(t('emailAddress'))
                .setDesc(t('browserSignIn'))
                .addText(text => {
                    text.inputEl.type = 'email';
                    text.inputEl.autocomplete = 'email';
                    text.inputEl.id = 'text-machine-email';
                    text.inputEl.setAttribute('aria-label', t('emailAddress'));
                    text.setPlaceholder(t('emailPlaceholder')).setValue(p.email).setDisabled(p.busy)
                        .onChange(value => { p.email = value; });
                    text.inputEl.addEventListener('keydown', event => {
                        if (event.key === 'Enter' && p.oauth) void this.run(t('connecting'), () => p.connect());
                    });
                });
            emailSetting.nameEl.empty();
            emailSetting.nameEl.createEl('label', { text: t('emailAddress'), attr: { for: 'text-machine-email' } });
            new Setting(account).addButton(button => button.setButtonText(t('connectGmail')).setCta()
                .setDisabled(p.busy || !p.oauth).onClick(() => this.run(t('connecting'), () => p.connect())));
        }
        account.createEl('p', { cls: 'text-machine-note', text: t('readOnly') });
        if (p.busy) {
            const progress = el.createDiv({ cls: 'text-machine-feedback', attr: { role: 'status' } });
            progress.createEl('p', { text: this.progress });
            if (p.auth) new Setting(progress).setName(t('finishInBrowser'))
                .addButton(button => button.setButtonText(t('cancel')).onClick(() => p.auth?.abort()));
        }
        if (this.error || p.configurationError) {
            el.createEl('p', { cls: 'text-machine-feedback text-machine-error', text: this.error || p.configurationError, attr: { role: 'alert' } });
        }
        const source = el.createDiv('text-machine-section');
        source.createEl('h3', { text: t('sourceHeading') });
        if (!connected) {
            source.createEl('p', { cls: 'text-machine-note', text: t('connectForLabels') });
        }
        const labelSetting = new Setting(source).setName(t('gmailLabel'))
            .setDesc(t('labelDescription'))
            .addDropdown(dropdown => {
                dropdown.selectEl.id = 'text-machine-label';
                dropdown.selectEl.setAttribute('aria-label', t('gmailLabel'));
                dropdown.addOption('', t('chooseLabel'));
                for (const label of p.labels) dropdown.addOption(label.id, label.name);
                dropdown.setValue(p.settings.labelId).setDisabled(!connected || p.busy || !p.labels.length)
                    .onChange(id => this.run(t('savingLabel'), async () => {
                        if (id && !p.labels.some((label: Label) => label.id === id)) throw new Error(t('unknownLabel'));
                        p.settings.labelId = id;
                        await p.saveData(p.settings);
                    }));
            });
        labelSetting.nameEl.empty();
        labelSetting.nameEl.createEl('label', { text: t('gmailLabel'), attr: { for: 'text-machine-label' } });
        new Setting(source).setDesc(t('newLabelHint'))
            .addButton(button => button.setButtonText(t('refresh')).setDisabled(!connected || p.busy)
                .onClick(() => this.run(t('loadingLabels'), () => p.refreshLabels())));
        if (p.loaded && !p.busy && !p.labels.length && !this.error) {
            source.createEl('p', { cls: 'text-machine-note', text: t('noLabels') });
        }
        if (p.settings.labelId) {
            const selected = p.labels.find(label => label.id === p.settings.labelId);
            new Setting(source).setName(t('savedSource')).setDesc(selected?.name || t('loading'))
                .addButton(button => button.setButtonText(t('checkAccess')).setDisabled(!connected || p.busy)
                    .onClick(() => this.run(t('checkingAccess'), async () => {
                        const label = await p.client!.label(p.settings.labelId);
                        if (label.id !== p.settings.labelId) throw new Error(t('inconsistentResponse'));
                        this.result = t('labelAccessible', { name: label.name, count: label.messagesTotal ?? 0 });
                    })));
        }
        const journal = el.createDiv('text-machine-section');
        journal.createEl('h3', { text: t('folderHeading') });
        new Setting(journal).setName(t('chooseEmptyFolder'))
            .addButton(button => {
                if (connected && !p.dataReady) button.setCta();
                button.setButtonText(p.dataReady ? t('changeFolder') : t('createFolder')).setDisabled(!connected || p.busy).onClick(() => {
                new FolderPicker(this.app, p.settings.outputFolder, async folder => {
                    const log = await p.ensureData(folder);
                    p.settings.outputFolder = folder;
                    p.updateFolderIcon();
                    await p.saveData(p.settings);
                    this.result = t('journalReady', { path: log.path });
                    this.error = '';
                    this.display();
                }).open();
                });
            });
        if (p.dataReady) {
            new Setting(journal).setName(t('excludedSources')).setDesc(t('excludedSourcesDescription'))
                .addTextArea(text => {
                    text.inputEl.setAttribute('aria-label', t('excludedSources'));
                    text.inputEl.rows = 3;
                    text.setPlaceholder('example.com\nGoogle Alerts').setValue(p.settings.excludedSources).setDisabled(!connected || p.busy)
                        .onChange(async value => {
                            p.settings.excludedSources = value;
                            try { await p.saveData(p.settings); }
                            catch (caught) {
            const error = errorOf(caught); new Notice(error.message); }
                        });
                });
            new Setting(journal).setName(t('dataFile'))
                .addButton(button => button.setButtonText(t('openLog')).setDisabled(!connected || p.busy || !p.dataReady)
                    .onClick(() => this.run(t('openingLog'), async () => {
                        const file = this.app.vault.getAbstractFileByPath(p.dataPath) as TFile;
                        await this.app.vault.process(file,text=>{
                            try { return p.articles.withIds(text); } catch { return text; }
                        });
                        let text = await this.app.vault.read(file);
                        try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Display malformed files as-is for inspection. */ }
                        const viewer = new Modal(this.app);
                        viewer.titleEl.setText('textmachine.json');
                        viewer.contentEl.createEl('pre', { cls: 'text-machine-json', text });
                        viewer.open();
                    })));
            new Setting(journal).setName(t('blockedSites')).setDesc(t('blockedSitesDescription'))
                .addButton(button => button.setButtonText(t('viewBlocked')).setDisabled(!connected || p.busy)
                    .onClick(() => this.run(t('openingLog'), async () => {
                        const data = await p.readBlocked();
                        const viewer = new Modal(this.app);
                        viewer.titleEl.setText('blocked.json');
                        viewer.contentEl.createEl('pre', {cls:'text-machine-json', text:JSON.stringify(data, null, 2)});
                        viewer.open();
                    })));
            new Setting(journal).setName(t('resetData')).setDesc(t('resetDataDescription'))
                .addButton(button => button.setButtonText(t('resetData')).setWarning().setDisabled(!connected || p.busy)
                    .onClick(() => {
                        const file = this.app.vault.getAbstractFileByPath(p.dataPath) as TFile;
                        const confirmation = new Modal(this.app);
                        confirmation.titleEl.setText(t('resetData'));
                        confirmation.contentEl.createEl('p', { text: t('resetDataConfirm', { path: file.path }) });
                        new Setting(confirmation.contentEl)
                            .addButton(cancel => cancel.setButtonText(t('cancel')).onClick(() => confirmation.close()))
                            .addButton(confirm => confirm.setButtonText(t('confirmReset')).setWarning().onClick(() => {
                                confirmation.close();
                                void this.run(t('resettingData'), async () => {
                                    await this.app.vault.modify(file, JSON.stringify({ version: 1, articles: [] }, null, 2) + '\n');
                                    this.result = t('dataReset');
                                });
                            }));
                        confirmation.open();
                    }));
        }
        this.plugin.renderAI(el, p, this, Setting, SecretComponent);
        if (this.result) journal.createEl('p', { cls: 'text-machine-feedback', text: this.result, attr: { role: 'status' } });
        if (connected && !p.loaded && !p.busy) void this.run(t('loadingLabels'), () => p.refreshLabels());
    }
}
