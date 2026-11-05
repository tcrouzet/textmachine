import { App, Plugin, PluginSettingTab, Setting, ButtonComponent, Notice, addIcon, setIcon, requestUrl, requireApiVersion, Modal, TFolder, TFile, getLanguage } from 'obsidian';
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
import {Settings, Account, Label, Progress, Action, AIProvider, Article, FeedEntry, Model, HttpOptions, SettingRow, SettingsGroup, errorOf, record} from './types';
import * as newsletter from './newsletter';
import * as generation from './ai/generate';
import * as imageGeneration from './ai/image';
import {correctNewsletterPunctuation} from './punctuation';
import {rewriteRequest,parseRewrite} from './ai/rewrite';
import {createIllustration} from './illustration';
import writerPrompt from '../prompts/writer.md';
import publisherPrompt from '../prompts/publisher.md';
import newsletterTemplate from '../models/newsletter.md';
import imagePrompt from '../prompts/image.md';
import rewriterPrompt from '../prompts/rewriter.md';
import brefPrompt from '../prompts/bref.md';
import selectionPrompt from '../prompts/sélection.md';
import textMachineIcon from '../icon.svg';
const {t} = i18n;
const prompts = {'sélection.md':selectionPrompt,'writer.md':writerPrompt,'bref.md':brefPrompt,
    'rewriter.md':rewriterPrompt,'publisher.md':publisherPrompt,'image.md':imagePrompt};
type PromptName = keyof typeof prompts;
interface PromptDefinition {file: PromptName | 'newsletter.md'; name: string; desc: string; variables: string}
interface SourceAttempt {
    method: 'http' | 'browser';
    httpStatus: number | null;
    finalUrl: string;
    contentType: string;
    htmlLength: number;
    contentLength: number;
    publish: string;
    elapsedMs: number;
    outcome: string;
    failure: string;
}
interface SourceProbe {id: number; url: string; outcome: string; attempts: SourceAttempt[]; failure?: string}

function reportUrl(value: string) {
    try {
        const url=new URL(value);
        return url.origin+url.pathname;
    } catch {return '';}
}

function destructive(button: ButtonComponent) {
    if (requireApiVersion('1.13.0')) return button.setDestructive();
    button.buttonEl.addClass('mod-warning');
    return button;
}

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
    createIllustration = createIllustration;
    generateIllustration = imageGeneration.generate;
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
    folderIconDocuments = new Set<Document>();
    loadPage = (url: string, signal: AbortSignal | undefined, blocked: (url: string) => boolean) => browser.retrievePage(url, signal, blocked, BrowserWindow);

    async onload() {
        i18n.setLocale(getLanguage());
        this.gmail = gmail;
        this.articles = articles;
        this.crawler = crawler;
        this.loadPage = (url, signal, blocked) => browser.retrievePage(url, signal, blocked, BrowserWindow);
        this.ai = ai;
        this.codex = codex;
        this.renderAI = renderAI;
        const {newsletterFeed:legacyFeed,...storedSettings} = record(await this.loadData());
        const defaults: Settings = {...this.ai.defaults, secretKey:'',labelId:'',outputFolder:'',excludedSources:'',newsletterLanguage:'français',referenceSources:'',includeFeeds:'',
            authorFeeds:typeof legacyFeed==='string' ? legacyFeed : '',minimumSources:10,debug:false,anthropicSecretId:undefined,openaiSecretId:undefined};
        this.settings = {...storedSettings,...defaults};
        for (const key of Object.keys(defaults) as (keyof Settings)[]) {
            const value=storedSettings[key];
            if (key!=='debug' && key!=='minimumSources' && typeof value==='string') this.settings[key]=value;
        }
        if (typeof storedSettings.minimumSources==='number' && Number.isSafeInteger(storedSettings.minimumSources) && storedSettings.minimumSources>0)
            this.settings.minimumSources=storedSettings.minimumSources;
        this.settings.debug=storedSettings.debug===true;
        this.settings.codexEffort=/^[a-z][a-z0-9_-]{0,31}$/.test(this.settings.codexEffort.trim()) ? this.settings.codexEffort.trim() : this.ai.defaults.codexEffort;
        if (legacyFeed!==undefined) await this.saveData(this.settings);
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
            const account = stored ? record(JSON.parse(stored)) : null;
            if (account && (typeof account.clientId!=='string' || typeof account.email!=='string'
                || (account.scope!==undefined && typeof account.scope!=='string')
                || (account.refreshToken!==undefined && typeof account.refreshToken!=='string'))) throw new Error();
            this.account = account as Account | null;
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
            this.observeFolderIcons(document);
            if (this.dataReady) {
                const file = this.dataFile;
                try { await this.app.vault.process(file,text=>this.articles.withIds(text)); }
                catch (caught) { new Notice(errorOf(caught).message); }
            }
        });
        this.registerEvent(this.app.workspace.on('window-open', (_workspace, win) => this.observeFolderIcons(win.document)));
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
            if (!(file instanceof TFolder) || (this.dataReady && file.path !== this.settings.outputFolder)) return;
            menu.addItem(item => item.setTitle('Text Machine').setIcon('text-machine').setDisabled(this.busy)
                .onClick(() => this.openTextMachine(file.path)));
        }));
    }

    observeFolderIcons(doc: Document) {
        if (this.folderIconDocuments.has(doc)) return;
        this.folderIconDocuments.add(doc);
        const observer = new MutationObserver(() => this.updateFolderIcon());
        observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-path']});
        this.register(() => {
            observer.disconnect();
            doc.querySelectorAll('.text-machine-folder').forEach(el=>el.classList.remove('text-machine-folder'));
            this.folderIconDocuments.delete(doc);
        });
        this.updateFolderIcon();
    }

    updateFolderIcon() {
        for (const doc of this.folderIconDocuments) {
            for (const el of doc.querySelectorAll('.nav-folder-title')) {
                el.classList.toggle('text-machine-folder',!!this.settings.outputFolder && el.getAttribute('data-path')===this.settings.outputFolder);
            }
        }
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

    get dataFile(): TFile {
        const file=this.app.vault.getAbstractFileByPath(this.dataPath);
        if (!(file instanceof TFile)) throw new Error(t('createFolderFirst'));
        return file;
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

    async moveData(parentPath: string) {
        if (this.busy) throw new Error(t('promptBusy'));
        if (!this.dataReady) throw new Error(t('createFolderFirst'));
        const vault=this.app.vault, source=this.settings.outputFolder;
        const folder=vault.getAbstractFileByPath(source);
        if (!(folder instanceof TFolder)) throw new Error(t('parentMoved'));
        const parent=parentPath ? vault.getAbstractFileByPath(parentPath) : vault.getRoot();
        if (!(parent instanceof TFolder)) throw new Error(t('parentMoved'));
        const destination=(parentPath ? parentPath+'/' : '')+folder.name;
        if (destination===source) return;
        if (parentPath===source || parentPath.startsWith(source+'/')) throw new Error(t('folderMoveInside'));
        if (vault.getAbstractFileByPath(destination)) throw new Error(t('folderNameExists'));
        this.busy=true;
        try {
            await this.app.fileManager.renameFile(folder,destination);
            this.settings.outputFolder=destination;
            this.updateFolderIcon();
            try {await this.saveData(this.settings);}
            catch (caught) {throw new Error(t('folderMovedSaveFailed',{path:destination,error:errorOf(caught).message}));}
        } finally {this.busy=false;}
    }

    get blockedPath() {
        return this.settings.outputFolder + '/blocked.json';
    }

    async readBlocked() {
        const file = this.app.vault.getAbstractFileByPath(this.blockedPath);
        if (file && !(file instanceof TFile)) throw new Error(t('invalidBlockedFile'));
        return file ? this.crawler.parseBlocked(await this.app.vault.read(file)) : [];
    }

    async testBlockedSources(progress?: Progress) {
        if (this.crawlController) throw new Error(t('blockedTestBusy'));
        const vault=this.app.vault, log=this.dataFile;
        const domains=await this.readBlocked();
        const articles=this.articles.parseData(await vault.read(log)).articles;
        const sources=domains.map(domain=>{
            const matches=[...new Map(articles.filter(article=>this.crawler.isBlocked(article.url,[domain])).map(article=>[article.url,article])).values()];
            const targets=matches.filter(article=>!this.articles.isPdf(article.url));
            return {domain,skippedPdfs:matches.length-targets.length,reason:targets.length ? '' : matches.length ? 'pdf-only' : 'no-article-url',
                articles:targets.slice(0,1).map((article): SourceProbe=>({id:article.id,url:reportUrl(article.url),outcome:'pending',attempts:[]}))};
        });
        const report={version:1,pluginVersion:this.manifest.version,startedAt:new Date().toISOString(),finishedAt:'',cancelled:false,sources};
        const path=this.settings.outputFolder+'/blocked-report-'+report.startedAt.replace(/[:.]/g,'-')+'.json';
        const controller=this.crawlController=new AbortController();
        try {
            const file=await vault.create(path,JSON.stringify(report,null,2)+'\n');
            const total=sources.reduce((count,source)=>count+source.articles.length,0);
            let current=0;
            for (const source of sources) {
                for (const target of source.articles) {
                    if (controller.signal.aborted) break;
                    current++;
                    const url=articles.find(article=>article.id===target.id)!.url;
                    progress?.(t('blockedTestProgress',{current,total,url:target.url}));
                    target.outcome='running';
                    try {
                        await this.browser.retrievePage(url,controller.signal,()=>false,BrowserWindow,this.browser.fetchPage,(method,page,elapsedMs)=>{
                            const pdf=this.articles.isPdf(page.url,page.contentType) || page.status===415 || page.html.trimStart().startsWith('%PDF-');
                            const extracted=!pdf && !page.failure && page.status>=200 && page.status<300 && page.html ? this.crawler.extractPage(page.html,page.url) : null;
                            const outcome=pdf ? 'pdf' : page.failure ? 'network-error' : page.status<200 || page.status>=300 ? 'http-error'
                                : extracted?.content ? 'readable' : extracted?.blocked ? 'restricted' : 'no-content';
                            target.attempts.push({method,httpStatus:page.failure ? null : page.status,finalUrl:reportUrl(page.url),contentType:page.contentType || '',
                                htmlLength:page.html.length,contentLength:extracted?.content?.length || 0,publish:extracted?.publish || '',elapsedMs,outcome,failure:page.failure || ''});
                            target.outcome=outcome;
                            progress?.(t('blockedTestProgress',{current,total,url:target.url})+' · '+method);
                        });
                    } catch (caught) {
                        target.outcome=controller.signal.aborted ? 'cancelled' : 'error';
                        if (!controller.signal.aborted) target.failure=this.browser.failureCode(caught);
                    }
                    await vault.modify(file,JSON.stringify(report,null,2)+'\n');
                }
                if (controller.signal.aborted) break;
            }
            report.cancelled=controller.signal.aborted;
            report.finishedAt=new Date().toISOString();
            await vault.modify(file,JSON.stringify(report,null,2)+'\n');
            return file;
        } finally {if (this.crawlController===controller) this.crawlController=null;}
    }

    async crawlArticles(progress?: Progress) {
        const vault = this.app.vault;
        const log = this.dataFile;
        const blocked = await this.readBlocked();
        const blockedFile = vault.getAbstractFileByPath(this.blockedPath);
        if (blockedFile && !(blockedFile instanceof TFile)) throw new Error(t('invalidBlockedFile'));
        if (blockedFile) await vault.process(blockedFile, text => JSON.stringify(this.crawler.parseBlocked(text), null, 2) + '\n');
        const articles = this.articles.parseData(await vault.read(log)).articles;
        const now = Date.now();
        this.crawlController = new AbortController();
        try {
            for (const article of articles) {
                if (this.disposed) throw new Error(t('pluginDisabled'));
                if (article.status === 'forbidden') continue;
                if (!article.content && article.source.startsWith('RSS: ') && !this.articles.recentPublication(article.publish,now)) continue;
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
                    const blockedFile = vault.getAbstractFileByPath(this.blockedPath);
                    if (blockedFile && !(blockedFile instanceof TFile)) throw new Error(t('invalidBlockedFile'));
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
                        for (const key of ['publish', 'content', 'image'] as const) saved[key] ||= result[key];
                        if (!saved.authors?.length && result.authors?.length) saved.authors=[...result.authors];
                        if (saved.image===result.image && !saved.imageCaption) saved.imageCaption = result.imageCaption;
                        if (result.status === 'forbidden') saved.status = 'forbidden';
                        else if (saved.status === '404') saved.status = '';
                    }
                    return JSON.stringify(current, null, 2) + '\n';
                });
            }
        } finally { this.crawlController = null; }
    }

    async importFeeds(progress?: Progress) {
        const feeds = this.newsletter.feedUrls(this.settings.includeFeeds).filter(url=>!this.newsletter.isAuthorSource(url,this.settings.authorFeeds));
        if (!feeds.length) return 0;
        if (!this.dataReady) throw new Error(t('createFolderFirst'));
        const log = this.dataFile;
        const blocked = await this.readBlocked();
        const controller = this.crawlController = new AbortController();
        let added = 0, succeeded = 0, failed = 0, ignored = 0, duplicates = 0;
        const now = Date.now();
        const urls = new Map<string,Omit<Article,'id'>>(), titles = new Map<string,Omit<Article,'id'>>();
        const remember = (article: Omit<Article,'id'>) => {
            const keys = this.articles.articleKeys(article);
            urls.set(keys.urlKey,article);
            titles.set(keys.titleKey,article);
        };
        try {
            for (const article of this.articles.parseData(await this.app.vault.read(log)).articles) remember(article);
            for (const url of feeds) {
                if (this.disposed || controller.signal.aborted) throw new Error(t('newsletterCancelled'));
                progress?.(t('readingIncludeFeed',{source:new URL(url).hostname}));
                let entries: FeedEntry[];
                try {
                    const response = await generation.requestWithSignal({url,throw:false},this.request,controller.signal);
                    if (response.status!==200) throw new Error(t('newsletterFeedFailed'));
                    entries = this.newsletter.readFeed(response.text,Infinity,url);
                } catch (caught) {
                    if (this.disposed || controller.signal.aborted) throw new Error(t('newsletterCancelled'));
                    failed++;
                    progress?.(t('includeFeedError',{url,error:errorOf(caught).message}));
                    continue;
                }
                if (this.disposed || controller.signal.aborted) throw new Error(t('newsletterCancelled'));
                const incoming: Omit<Article,'id'>[] = [];
                for (const entry of entries) {
                    if (!this.articles.recentPublication(entry.publish,now)) {ignored++;continue;}
                    const article = this.articles.feedArticles([entry],url,this.newsletter.day())[0];
                    if (!article || this.articles.isExcluded(article,this.settings.excludedSources)
                        || this.newsletter.isAuthorSource(article.url,this.settings.authorFeeds)) continue;
                    const keys = this.articles.articleKeys(article);
                    const known = urls.get(keys.urlKey) ?? titles.get(keys.titleKey);
                    if (known) {
                        duplicates++;
                        urls.set(keys.urlKey,known);
                        titles.set(keys.titleKey,known);
                        if (known.content || known.status || !entry.html) continue;
                    }
                    if (this.crawler.isBlocked(article.url,blocked)) article.status='forbidden';
                    article.authors=entry.authors || [];
                    if (!article.status && entry.html) {
                        const extracted=this.crawler.extractPage(entry.html,article.url);
                        if (extracted.content && !extracted.blocked) {
                            article.content=extracted.content;
                            article.image=extracted.image || '';
                            article.imageCaption=extracted.imageCaption;
                            if (extracted.authors?.length) article.authors=extracted.authors;
                        }
                    }
                    if (known) {
                        // Enrich the existing identity when feeds syndicate the same title at another URL.
                        article.url=known.url;
                        article.title=known.title;
                        Object.assign(known,{content:article.content});
                    } else remember(article);
                    incoming.push(article);
                }
                if (incoming.length) {
                    let result!: ReturnType<typeof articles.mergeArticles>;
                    await this.app.vault.process(log,text=>{
                        result = this.articles.mergeArticles(text,incoming);
                        return result.text;
                    });
                    added += result.count;
                }
                if (this.disposed || controller.signal.aborted) throw new Error(t('newsletterCancelled'));
                succeeded++;
            }
            progress?.(t('includeFeedsSummary',{succeeded,failed,added,ignored,duplicates}));
            return added;
        } finally {if (this.crawlController===controller) this.crawlController=null;}
    }

    async importUnread(progress?: Progress) {
        if (!this.client || !this.account?.email || !this.settings.labelId) throw new Error(t('connectAndChooseLabel'));
        if (!this.dataReady) throw new Error(t('createFolderFirst'));
        if (!this.account.scope?.split(' ').includes(this.gmail.SCOPE)) throw new Error(t('readPermissionMissing'));
        const log = this.dataFile;
        await this.app.vault.process(log,text=>this.articles.withIds(text));
        const labelId = this.settings.labelId;
        const debug = this.settings.debug;
        const blocked = await this.readBlocked();
        let added = 0, links = 0, skipped = 0, feedLinks = 0;
        let feedSummary = '';
        try {
            for await (const id of this.client.unreadMessages(labelId)) {
                if (this.disposed) throw new Error(t('pluginDisabled'));
                const message = await this.client.message(id);
                if (!message.labelIds.includes('UNREAD') || !message.labelIds.includes(labelId)) continue;
                const entry = this.articles.messageArticles(message)
                    .filter(article => !this.articles.isExcluded(article, this.settings.excludedSources) && !this.newsletter.isAuthorSource(article.url,this.settings.authorFeeds))
                    .map(article=>this.crawler.isBlocked(article.url,blocked) ? {...article,status:'forbidden'} : article);
                if (this.disposed) throw new Error(t('pluginDisabled'));
                let result!: ReturnType<typeof articles.mergeArticles>;
                await this.app.vault.process(log, current => {
                    result = this.articles.mergeArticles(current, entry);
                    return result.text;
                });
                if (result.added) { added++; links += result.count; } else skipped++;
                if (this.disposed) throw new Error(t('pluginDisabled'));
                if (!debug) await this.client.markRead(id);
                progress?.(t('importProgress', { added, links }));
            }
            feedLinks = await this.importFeeds(message=>{feedSummary=message;progress?.(message);});
            await this.crawlArticles(progress);
        } catch (caught) {
            const error = errorOf(caught);
            if (error.code === 'AUTH_REQUIRED') this.authorizationRequired = true;
            const failure = new Error(t('importFailed', { error: error.message, added }));
            Object.assign(failure, {code:error.code});
            throw failure;
        }
        const result = t('importComplete', { added, links, skipped, path: log.path });
        return this.settings.includeFeeds.trim() ? result+'\n'+t('includeFeedsComplete',{count:feedLinks})+(feedSummary ? '\n'+feedSummary : '') : result;
    }

    async readAuthorFeeds(signal: AbortSignal) {
        const posts: ReturnType<typeof newsletter.readFeed> = [];
        for (const url of this.newsletter.feedUrls(this.settings.authorFeeds)) {
            const response = await generation.requestWithSignal({url,throw:false},this.request,signal);
            if (this.disposed || signal.aborted) throw new Error(t('newsletterCancelled'));
            if (response.status!==200) throw new Error(t('newsletterFeedFailed'));
            posts.push(...this.newsletter.readFeed(response.text,5,url).map(entry=>{const post={...entry};delete post.html;return post;}));
        }
        return [...new Map(posts.map(post=>[post.url || post.title,post])).values()];
    }

    async readPrompt(file: PromptDefinition['file']) {
        const path=this.manifest.dir+(file==='newsletter.md' ? '/models/' : '/prompts/')+file;
        const adapter=this.app.vault.adapter;
        return await adapter.exists(path) ? adapter.read(path) : file==='newsletter.md' ? newsletterTemplate : prompts[file];
    }

    async savePrompt(file: PromptDefinition['file'], text: string, original: string) {
        if (this.busy || this.aiController) throw new Error(t('promptBusy'));
        if (!text.trim()) throw new Error(file==='newsletter.md' ? t('newsletterTemplateInvalid') : t('newsletterPromptEmpty',{file}));
        const language=this.settings.newsletterLanguage;
        switch (file) {
            case 'sélection.md': this.newsletter.selectionRequest(text,[],language); break;
            case 'writer.md': this.newsletter.writerRequest(text,[],[],[],language); break;
            case 'publisher.md': this.newsletter.publisherRequest(text,[],language); break;
            case 'bref.md': this.newsletter.briefRequest(text,[],language); break;
            case 'rewriter.md': this.newsletter.renderPrompt(text,{language,AuthorFeed:'[]',recentPosts:'[]'}); break;
            case 'image.md': this.newsletter.renderPrompt(text,{language}); break;
            case 'newsletter.md':
                this.newsletter.renderNewsletter(text,{title:'Title',chapeau:'Introduction',paragraphs:['Article'],image:null,
                    used:['https://example.com/article'],discard:[]},[{title:'Brief title',url:'https://example.com/brief'}]);
                break;
        }
        if (await this.readPrompt(file)!==original) throw new Error(t('promptChanged'));
        const folder=this.manifest.dir+(file==='newsletter.md' ? '/models' : '/prompts');
        const adapter=this.app.vault.adapter;
        if (!await adapter.exists(folder)) await adapter.mkdir(folder);
        await adapter.write(folder+'/'+file,text);
    }

    async writeNewsletter(progress?: Progress) {
        if (!this.dataReady) throw new Error(t('createFolderFirst'));
        const vault = this.app.vault;
        const log = this.dataFile;
        const day = this.newsletter.day();
        const debug = this.settings.debug;
        const editionName=(debug ? 'test-' : '')+'text-machine-'+day;
        const language = this.settings.newsletterLanguage.trim() || 'français';
        let connection: ReturnType<typeof ai.getConnection> | undefined;
        const folder = vault.getAbstractFileByPath(this.settings.outputFolder);
        if (!(folder instanceof TFolder)) throw new Error(t('createFolderFirst'));
        const notes = folder.children.filter((file): file is TFile => file instanceof TFile && /^text-machine-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/.test(file.name));
        const lastEdition=notes.map(file=>file.name.slice('text-machine-'.length,'text-machine-'.length+10)).filter(date=>date<day).sort().pop() || '';
        const todayNotes = await Promise.all(notes.filter(file=>file.name.startsWith('text-machine-'+day)).map(file=>vault.read(file)));
        const historyNotes=notes.filter(file=>debug || !file.name.startsWith('text-machine-'+day))
            .sort((a,b)=>debug ? b.name.localeCompare(a.name) : b.stat.mtime-a.stat.mtime).slice(0,5);
        const testHistory=debug ? await Promise.all(historyNotes.map(async file=>({name:file.name,content:await vault.read(file)}))) : [];

        await vault.process(log,text=>this.articles.withIds(text));
        const data = await vault.read(log);
        let pending: Article[] = this.newsletter.availableArticles(data,this.settings.excludedSources,day,todayNotes,lastEdition);
        let brief: Article[] = this.newsletter.briefArticles(data,this.settings.excludedSources,day,lastEdition);
        if (debug) {
            const links=this.articles.extractLinks({payload:{},labelIds:[],bodies:[{type:'text/plain',text:testHistory.map(note=>note.content).join('\n')}]});
            const published=new Set(links.map(link=>this.articles.articleKeys({url:link.url,title:''}).urlKey));
            const unpublished=(article: Article)=>!published.has(this.articles.articleKeys(article).urlKey);
            pending=pending.filter(unpublished);
            brief=brief.filter(unpublished);
        }

        if (!pending.length && !brief.length) {new Notice(t('newsletterNoArticles'));return null;}
        const template = await this.readPrompt('newsletter.md');
        if (!template.trim()) throw new Error(t('newsletterTemplateInvalid'));
        const controller = this.aiController = new AbortController();
        const check = () => {if (this.disposed || controller.signal.aborted) throw new Error(t('newsletterCancelled'));};
        const saveSnapshot = async (name: string, text: string) => {
            check();
            if (!debug) return;
            const path=this.settings.outputFolder+'/'+name+'-'+day+'.md';
            const file=vault.getAbstractFileByPath(path);
            try {
                if (file instanceof TFile) await vault.modify(file,text.trim()+'\n');
                else if (!file) await vault.create(path,text.trim()+'\n');
                else throw new Error();
            } catch {throw new Error(t('newsletterSnapshotFailed',{path}));}
            check();
        };
        const readPrompt = async (name: PromptName) => {
            const prompt=await this.readPrompt(name);
            if (!prompt.trim()) throw new Error(t('newsletterPromptEmpty',{file:name}));
            return prompt;
        };
        const respond = async (request: {system: string; input: string; schema?: object}, feedback?: Progress) => {
            if (!connection) {
                connection = this.getAIConnection();
                const provider = connection.provider==='codex' ? 'Codex' : connection.provider==='anthropic' ? 'Anthropic' : connection.baseUrl ? t('aiLocalServer') : 'OpenAI';
                progress?.('',false,false,provider+' · '+(connection.model || t('aiDefaultCodexModel')));
            }
            const report: Progress = (message,stream,reset,model) => {
                if (model) progress?.(message,stream,reset,model);
                else feedback?.(message,stream,reset);
            };
            const response=connection.provider==='codex'
                ? await this.codex.generate(await this.codex.findCodex(),request.system,request.input,connection.model,controller.signal,report,request.schema,undefined,connection.effort)
                : await this.generate(connection,request.system,request.input,this.requestAI,controller.signal,report);
            check();
            return response;
        };
        try {
            const result: newsletter.Newsletter = {title:'',chapeau:'',paragraphs:[],image:null,used:[],discard:[]};
            let generated: Awaited<ReturnType<typeof createIllustration>> | null = null;
            const authorPosts=await this.readAuthorFeeds(controller.signal);
            pending=pending.filter(article=>!this.newsletter.isAuthorSource(article.url,this.settings.authorFeeds,authorPosts));
            brief=brief.filter(article=>!this.newsletter.isAuthorSource(article.url,this.settings.authorFeeds,authorPosts));
            if (!pending.length && !brief.length) {new Notice(t('newsletterNoArticles'));return null;}
            if (!debug && pending.length<this.settings.minimumSources)
                throw new Error(t('newsletterNotEnoughSources',{count:pending.length,minimum:this.settings.minimumSources}));
            if (pending.length) {
                const prompt=await readPrompt('writer.md');
                const selectionTemplate=await readPrompt('sélection.md');
                const previous=[prompt,selectionTemplate].some(text=>/\{\{\s*previousNewsletters\s*\}\}/.test(text))
                    ? debug ? testHistory : await Promise.all(historyNotes.map(async file=>({name:file.name,content:await vault.read(file)}))) : [];
                progress?.(t('newsletterReadingContext'));
                check();
                progress?.(t('newsletterSelecting'));
                const selectionRequest=this.newsletter.selectionRequest(selectionTemplate,pending,language,this.settings.referenceSources,previous,authorPosts);
                const selection=this.newsletter.parseSelection(await respond(selectionRequest),pending);
                result.discard=selection.discard.map((id: number)=>pending.find(article=>article.id===id)!.url);
                if (selection.selected.length) {
                    progress?.(t('newsletterWriting'));
                    const request=this.newsletter.writerRequest(prompt,selection.selected,previous,authorPosts || [],language,this.settings.referenceSources);
                    const editorial=this.newsletter.parseEditorial(await respond(request,progress));
                    result.paragraphs=editorial.paragraphs;
                    result.used=selection.selected.map(article=>article.url);
                    await saveSnapshot('brouillon',result.paragraphs.join('\n\n'));
                    await saveSnapshot('revision','> '+t('newsletterRevisionPending'));
                    this.newsletter.assertNoAuthorSources(result.paragraphs,this.settings.authorFeeds,authorPosts);
                }
                if (!result.used.length && (!brief.length || pending.some(article=>!!article.usedAt))) {
                    if (!debug) await vault.process(log,current=>this.newsletter.applyStatuses(current,pending.filter(article=>!article.usedAt),result,day));
                    new Notice(t('newsletterNoArticles'));
                    return null;
                }
            }
            let translatedBrief = brief;
            if (brief.length) {
                progress?.(t('newsletterTranslatingBrief'));
                const prompt = await this.readPrompt('bref.md');
                const request = this.newsletter.briefRequest(prompt,brief,language);
                const response = await respond(request);
                translatedBrief = this.newsletter.parseBrief(response,brief);
            }
            if (!result.used.length && !translatedBrief.length) {
                if (!debug) await vault.process(log,current=>this.newsletter.applyStatuses(current,pending,result,day));
                new Notice(t('newsletterNoArticles'));
                return null;
            }
            if (result.used.length && connection) {
                const original = result.paragraphs.join('\n\n');
                let revisedText=original, revisionError='';
                try {
                    const prompt = await this.readPrompt('rewriter.md');
                    if (!prompt.trim()) throw new Error(t('newsletterRewriterEmpty'));
                    const serializedPosts = JSON.stringify(authorPosts || []);
                    const system = this.newsletter.renderPrompt(prompt,{language,AuthorFeed:serializedPosts,recentPosts:serializedPosts});
                    progress?.(t('newsletterRewriting'));
                    const response = await respond(rewriteRequest(system,original),progress);
                    revisedText=response;
                    try {
                        const paragraphs=record(JSON.parse(response.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''))).paragraphs;
                        if (Array.isArray(paragraphs) && paragraphs.every((item: unknown)=>typeof item==='string')) revisedText=paragraphs.join('\n\n');
                    } catch { /* Preserve malformed responses for comparison. */ }
                    const revised=parseRewrite(original,response);
                    this.newsletter.assertNoAuthorSources(revised,this.settings.authorFeeds,authorPosts);
                    result.paragraphs = revised;
                } catch (caught) {
                    check();
                    revisionError=t('newsletterRewriteFallback',{reason:errorOf(caught).message});
                    progress?.(revisionError);
                    progress?.(original,true,true);
                }
                const fence='`'.repeat((revisedText.match(/`+/g) || []).reduce((length,run)=>Math.max(length,run.length+1),3));
                await saveSnapshot('revision',revisionError ? '> '+revisionError+'\n\n'+fence+'\n'+revisedText+'\n'+fence : revisedText);
            }
            if (result.used.length) {
                progress?.(t('newsletterPublishing'));
                const request=this.newsletter.publisherRequest(await readPrompt('publisher.md'),result.paragraphs,language);
                const publication=this.newsletter.parsePublisher(await respond(request,progress));
                this.newsletter.assertNoAuthorSources([publication.title,publication.chapeau],this.settings.authorFeeds,authorPosts);
                Object.assign(result,publication);
            }
            const illustrationName=editionName+'.png';
            const imagePath=this.settings.outputFolder+'/illustrations/'+illustrationName;
            const cachedImage=vault.getAbstractFileByPath(imagePath);
            if (cachedImage && !(cachedImage instanceof TFile)) throw new Error(t('newsletterIllustrationFailed'));
            if (cachedImage) progress?.(t('newsletterReusingIllustration'));
            else {
                progress?.(t('newsletterCreatingIllustration'));
                const prompt=this.newsletter.renderPrompt(await readPrompt('image.md'),{language});
                const context=JSON.stringify({title:result.title,chapeau:result.chapeau,paragraphs:result.paragraphs,
                    brief:result.used.length ? [] : translatedBrief.map(article=>article.title)});
                const bytes=await this.generateIllustration(this.getAIKey('openai'),prompt+'\n\n'+context,
                    (options: HttpOptions,signal?: AbortSignal)=>this.requestAI(options,undefined,signal,32*1024*1024),controller.signal);
                check();
                generated=await this.createIllustration(bytes);
                check();
            }
            result.image={url:'illustrations/'+illustrationName,source:'',caption:result.title || t('newsletterBriefTitle'),verified:true,generated:true};
            const markdown = correctNewsletterPunctuation(this.newsletter.renderNewsletter(template,result,translatedBrief),language);
            const path = this.settings.outputFolder + '/' + editionName + '.md';
            const existing = vault.getAbstractFileByPath(path);
            check();
            if (generated) {
                const folderPath = this.settings.outputFolder+'/illustrations';
                const folder = vault.getAbstractFileByPath(folderPath);
                if (folder && !(folder instanceof TFolder)) throw new Error(t('newsletterIllustrationFailed'));
                if (!folder) await vault.createFolder(folderPath);
                const imagePath = folderPath+'/'+illustrationName;
                const imageFile = vault.getAbstractFileByPath(imagePath);
                if (imageFile && !(imageFile instanceof TFile)) throw new Error(t('newsletterIllustrationFailed'));
                if (!imageFile) await vault.createBinary(imagePath,generated.data);
                check();
            }
            let note: TFile;
            if (existing instanceof TFile) {await vault.modify(existing,markdown);note = existing;}
            else note = await vault.create(path,markdown);
            try {if (!debug) await vault.process(log,current=>this.newsletter.applyStatuses(current,pending,result,day,brief));}
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
    modelEl?: HTMLElement;
    modelText = '';
    aiText = '';
    notePath = '';
    clockEl?: HTMLElement;
    startedAt: number | null = null;
    elapsed: number | null = null;
    clockTimer?: number;

    constructor(app: App, plugin: TextMachine, folderPath: string) {
        super(app);
        this.plugin = plugin;
        this.folderPath = folderPath;
    }

    onOpen() { this.titleEl.setText('Text Machine'); void this.advance(); }

    onClose() {
        this.closed = true;
        this.stopClock();
        if (this.working) {this.plugin.auth?.abort();this.plugin.aiController?.abort();this.plugin.crawlController?.abort();}
        this.plugin.runDialog = null;
    }

    async perform(action: Action, resume = true) {
        const p = this.plugin;
        if (p.busy || this.closed) return;
        p.busy = true;
        this.working = true;
        this.aiText = '';
        this.modelText = '';
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
            this.stopClock();
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
            const progress: Progress = (message,stream,reset,model) => this.showProgress(message,stream,reset,model);
            this.startClock();
            const collected = await p.importUnread(progress);
            if (this.closed || p.disposed) return;
            const note = await p.writeNewsletter(progress);
            this.result = collected;
            this.notePath = note?.path || '';
        }, false);
    }

    startClock() {
        this.stopClock();
        this.elapsed=0;
        this.startedAt=performance.now();
        this.updateClock();
        this.clockTimer=window.setInterval(()=>this.updateClock(),1000);
    }

    updateClock() {
        if (this.startedAt!==null) this.elapsed=performance.now()-this.startedAt;
        const seconds=Math.floor((this.elapsed || 0)/1000);
        const parts=[Math.floor(seconds/60)%60,seconds%60];
        if (seconds>=3600) parts.unshift(Math.floor(seconds/3600));
        this.clockEl?.setText(t('elapsedTime',{time:parts.map(part=>String(part).padStart(2,'0')).join(':')}));
        if (this.clockEl) this.clockEl.hidden=false;
    }

    stopClock() {
        if (this.clockTimer!==undefined) window.clearInterval(this.clockTimer);
        this.clockTimer=undefined;
        if (this.startedAt!==null) this.updateClock();
        this.startedAt=null;
    }

    showProgress(message: string, stream = false, reset = false, model?: string) {
        if (this.closed || !this.logEl) return;
        if (model) {
            this.modelText = t('aiTextModel',{model});
            if (this.modelEl) {this.modelEl.setText(this.modelText);this.modelEl.hidden=false;}
            return;
        }
        const follow = this.logEl.scrollHeight-this.logEl.scrollTop-this.logEl.clientHeight <= 1;
        if (stream) {
            if (reset) this.aiText='';
            this.aiText += message;
            const preview = this.plugin.newsletter.preview(this.aiText);
            if (preview) {
                this.outputEl ||= this.logEl.createEl('pre',{cls:'text-machine-live-output'});
                this.outputEl.setText(preview);
            }
        } else {
            if (message===t('newsletterRewriting')) { this.aiText=''; this.outputEl=undefined; }
            this.statusEl?.setText(message);
            this.logEl.createEl('p',{text:message});
        }
        if (follow) this.logEl.scrollTop = this.logEl.scrollHeight;
    }

    render() {
        const p = this.plugin, el = this.contentEl;
        el.empty();
        this.modelEl = el.createEl('p',{cls:'text-machine-run-model',text:this.modelText});
        this.modelEl.hidden = !this.modelText;
        this.clockEl=el.createEl('p',{cls:'setting-item-description',attr:{role:'timer','aria-live':'off'}});
        this.clockEl.hidden=true;
        if (this.elapsed!==null) this.updateClock();
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

    constructor(app: App, startPath: string, choose: (folder: string) => Promise<void>, private moving = false) {
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
        el.createEl('h2', { text: this.moving ? t('moveFolder') : t('journalFolder') });
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

        if (!this.moving) new Setting(el).setName(t('newFolderName'))
            .addText(text => {
                text.inputEl.setAttribute('aria-label', t('newFolderInput'));
                text.setValue(this.newName).setDisabled(this.working).onChange(value => { this.newName = value; });
            })
            .addButton(button => button.setButtonText(t('createHere')).setCta().setDisabled(this.working).onClick(() => this.select(true)));
        new Setting(el).setDesc(this.moving ? t('moveFolderDescription') : t('folderPickerDescription'))
            .addButton(button => button.setButtonText(this.moving ? t('moveHere') : t('chooseFolder')).setDisabled(this.working || (!this.moving && (this.folder.isRoot() || this.folder.children.length > 0))).onClick(() => this.select()))
            .addButton(button => button.setButtonText(t('cancel')).setDisabled(this.working).onClick(() => this.close()));
        if (this.error) el.createEl('p', { text: this.error, attr: { role: 'alert' } });
    }
}

class PromptEditor extends Modal {
    constructor(app: App, private plugin: TextMachine, private prompt: PromptDefinition, private original: string) {
        super(app);
    }

    onOpen() {
        this.modalEl.addClass('text-machine-prompt-editor');
        this.titleEl.setText(this.prompt.name);
        this.contentEl.createEl('p',{text:this.prompt.desc});
        this.contentEl.createEl('p',{cls:'setting-item-description',text:t('promptVariables',{variables:this.prompt.variables})});
        const input=this.contentEl.createEl('textarea',{cls:'text-machine-prompt-text',attr:{'aria-label':this.prompt.file==='newsletter.md' ? t('newsletterTemplateText') : t('promptText')}});
        input.value=this.original;
        const error=this.contentEl.createDiv({cls:'text-machine-prompt-error',attr:{role:'alert'}});
        let saving=false;
        const actions=new Setting(this.contentEl);
        const cancel=new ButtonComponent(actions.controlEl).setButtonText(t('cancel')).onClick(()=>this.close());
        const save=new ButtonComponent(actions.controlEl).setButtonText(t('savePrompt')).setCta().onClick(async()=>{
            if (saving) return;
            saving=true;
            error.empty();
            input.disabled=true;
            cancel.setDisabled(true);
            save.setDisabled(true);
            try {
                await this.plugin.savePrompt(this.prompt.file,input.value,this.original);
                this.close();
            } catch (caught) {error.setText(errorOf(caught).message);}
            finally {
                saving=false;
                input.disabled=false;
                cancel.setDisabled(false);
                save.setDisabled(false);
            }
        });
        input.focus();
    }

    onClose() {this.contentEl.empty();}
}

export class GmailSettings extends PluginSettingTab {
    override icon = 'text-machine';
    plugin: TextMachine;
    error = '';
    result = '';
    progress = '';
    aiError = '';
    aiLoading = false;
    aiModelsLoaded = false;
    aiDiscoveryStarted = false;
    aiDiscoveryComplete = false;
    codexPath: string | null = null;
    codexModels: Model[] = [];
    aiCustom = false;

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
        this.redraw();
        try {
            const pending = action();
            this.redraw();
            await pending;
        } catch (caught) {
            const error = errorOf(caught);
            if (error.code === 'AUTH_REQUIRED') p.authorizationRequired = true;
            this.error = error.message;
        } finally {
            p.busy = false;
            if (!p.disposed) this.redraw();
        }
    }

    redraw() {
        if (requireApiVersion('1.13.0')) {
            this.update();
        } else this.renderLegacy();
    }

    // Obsidian before 1.13 renders the same definitions through this fallback.
    display() { this.redraw(); }

    renderLegacy() {
        const el=this.containerEl;
        el.empty();
        el.addClass('text-machine-settings');
        for (const item of this.getSettingDefinitions()) {
            if ('type' in item) {
                const section=el.createDiv(item.cls);
                new Setting(section).setName(item.heading).setHeading();
                for (const row of item.items) this.renderRow(section,row);
            } else this.renderRow(el,item);
        }
    }

    renderRow(el: HTMLElement, row: SettingRow) {
        const setting=new Setting(el).setName(row.name);
        if (row.desc) setting.setDesc(row.desc);
        row.render?.(setting);
    }

    getSettingDefinitions(): (SettingRow | SettingsGroup)[] {
        const p=this.plugin;
        const connected=p.isConnected;
        const group=(heading: string): SettingsGroup=>({type:'group',heading,cls:'text-machine-section',items:[]});
        const account=group(t('accountHeading'));
        const source=group(t('sourceHeading'));
        const journal=group(p.dataReady ? t('journalFolder') : t('folderHeading'));
        const newsletterSettings=group(t('newsletterHeading'));
        const newsletterSources: SettingRow[]=[];
        const items: (SettingRow | SettingsGroup)[] = [{name:'TextMachine',desc:t('intro'),searchable:false,render:setting=>{
            this.containerEl.addClass('text-machine-settings');
            setting.setHeading();
        }},account];
        if (connected) account.items.push({name:p.account!.email,desc:t('accountConnected'),render:setting=>{
            setting.addButton(button=>button.setButtonText(t('disconnect')).setDisabled(p.busy)
                .onClick(()=>this.run(t('disconnecting'),()=>p.disconnect())));
        }});
        else {
            account.items.push({name:t('emailAddress'),desc:t('browserSignIn'),render:setting=>{
                setting.addText(text=>{
                    text.inputEl.type='email';
                    text.inputEl.autocomplete='email';
                    text.inputEl.id='text-machine-email';
                    text.inputEl.setAttribute('aria-label',t('emailAddress'));
                    text.setPlaceholder(t('emailPlaceholder')).setValue(p.email).setDisabled(p.busy).onChange(value=>{p.email=value;});
                    text.inputEl.addEventListener('keydown',event=>{
                        if (event.key==='Enter' && p.oauth) void this.run(t('connecting'),()=>p.connect());
                    });
                });
                setting.nameEl.empty();
                setting.nameEl.createEl('label',{text:t('emailAddress'),attr:{for:'text-machine-email'}});
            }});
            account.items.push({name:t('connectGmail'),render:setting=>{
                setting.addButton(button=>button.setButtonText(t('connectGmail')).setCta().setDisabled(p.busy || !p.oauth)
                    .onClick(()=>this.run(t('connecting'),()=>p.connect())));
            }});
        }
        account.items.push({name:t('readOnly'),searchable:false});
        if (p.busy) items.push({name:this.progress,searchable:false,render:setting=>{
            setting.settingEl.addClass('text-machine-feedback');
            setting.settingEl.setAttribute('role','status');
            if (p.auth) setting.setDesc(t('finishInBrowser')).addButton(button=>button.setButtonText(t('cancel')).onClick(()=>p.auth?.abort()));
        }});
        if (this.error || p.configurationError) items.push({name:this.error || p.configurationError,searchable:false,render:setting=>{
            setting.settingEl.addClass('text-machine-feedback','text-machine-error');
            setting.settingEl.setAttribute('role','alert');
        }});
        items.push(source);
        if (!connected) source.items.push({name:t('connectForLabels'),searchable:false});
        source.items.push({name:t('gmailLabel'),desc:t('labelDescription'),render:setting=>{
            setting.addDropdown(dropdown=>{
                dropdown.selectEl.id='text-machine-label';
                dropdown.selectEl.setAttribute('aria-label',t('gmailLabel'));
                dropdown.addOption('',t('chooseLabel'));
                for (const label of p.labels) dropdown.addOption(label.id,label.name);
                dropdown.setValue(p.settings.labelId).setDisabled(!connected || p.busy || !p.labels.length)
                    .onChange(id=>this.run(t('savingLabel'),async()=>{
                        if (id && !p.labels.some(label=>label.id===id)) throw new Error(t('unknownLabel'));
                        p.settings.labelId=id;
                        await p.saveData(p.settings);
                    }));
            });
            setting.nameEl.empty();
            setting.nameEl.createEl('label',{text:t('gmailLabel'),attr:{for:'text-machine-label'}});
        }});
        source.items.push({name:t('refresh'),desc:t('newLabelHint'),render:setting=>{
            setting.addButton(button=>button.setButtonText(t('refresh')).setDisabled(!connected || p.busy)
                .onClick(()=>this.run(t('loadingLabels'),()=>p.refreshLabels())));
            if (connected && !p.loaded && !p.busy) void this.run(t('loadingLabels'),()=>p.refreshLabels());
        }});
        if (p.loaded && !p.busy && !p.labels.length && !this.error) source.items.push({name:t('noLabels'),searchable:false});
        if (p.settings.labelId) {
            const selected=p.labels.find(label=>label.id===p.settings.labelId);
            source.items.push({name:t('savedSource'),desc:selected?.name || t('loading'),render:setting=>{
                setting.addButton(button=>button.setButtonText(t('checkAccess')).setDisabled(!connected || p.busy)
                    .onClick(()=>this.run(t('checkingAccess'),async()=>{
                        const label=await p.client!.label(p.settings.labelId);
                        if (label.id!==p.settings.labelId) throw new Error(t('inconsistentResponse'));
                        this.result=t('labelAccessible',{name:label.name,count:label.messagesTotal ?? 0});
                    })));
            }});
        }
        items.push(journal);
        journal.items.push({name:p.dataReady ? p.settings.outputFolder : t('chooseEmptyFolder'),render:setting=>{
            setting.addButton(button=>{
                if (connected && !p.dataReady) button.setCta();
                button.setButtonText(p.dataReady ? t('moveFolder') : t('createFolder')).setDisabled(p.busy || (!p.dataReady && !connected)).onClick(()=>{
                    if (p.dataReady) {
                        const parent=p.settings.outputFolder.split('/').slice(0,-1).join('/');
                        new FolderPicker(this.app,parent,async destination=>{
                            try {await p.moveData(destination);}
                            finally {this.redraw();}
                        },true).open();
                        return;
                    }
                    new FolderPicker(this.app,p.settings.outputFolder,async folder=>{
                        const log=await p.ensureData(folder);
                        p.settings.outputFolder=folder;
                        p.updateFolderIcon();
                        await p.saveData(p.settings);
                        this.result=t('journalReady',{path:log.path});
                        this.error='';
                        this.redraw();
                    }).open();
                });
            });
        }});
        if (p.dataReady) {
            newsletterSources.push({name:t('excludedSources'),desc:t('excludedSourcesDescription'),render:setting=>{
                setting.addTextArea(text=>{
                    text.inputEl.setAttribute('aria-label',t('excludedSources'));
                    text.inputEl.rows=3;
                    text.setPlaceholder('example.com\nGoogle Alerts').setValue(p.settings.excludedSources).setDisabled(!connected || p.busy)
                        .onChange(async value=>{
                            p.settings.excludedSources=value;
                            try {await p.saveData(p.settings);} catch (caught) {new Notice(errorOf(caught).message);}
                        });
                });
            }});
            if (p.settings.debug) journal.items.push({name:t('dataFile'),render:setting=>{
                setting.addButton(button=>button.setButtonText(t('openLog')).setDisabled(!connected || p.busy || !p.dataReady)
                    .onClick(()=>this.run(t('openingLog'),async()=>{
                        const file=p.dataFile;
                        await this.app.vault.process(file,text=>{
                            try {return p.articles.withIds(text);} catch {return text;}
                        });
                        let text=await this.app.vault.read(file);
                        try {text=JSON.stringify(JSON.parse(text),null,2);} catch { /* Display malformed files as-is for inspection. */ }
                        const viewer=new Modal(this.app);
                        viewer.titleEl.setText('textmachine.json');
                        viewer.contentEl.createEl('pre',{cls:'text-machine-json',text});
                        viewer.open();
                    })));
            }});
            newsletterSources.push({name:t('blockedSites'),desc:t('blockedSitesDescription'),render:setting=>{
                if (p.settings.debug) setting.descEl.createEl('p',{text:t('blockedSitesEditHelp')});
                setting.addTextArea(text=>{
                    const path=p.blockedPath;
                    let original: string[] | null=null, saving=false;
                    const canEdit=()=>p.settings.debug && !p.busy && !p.crawlController && !p.aiController && !p.disposed;
                    const error=setting.descEl.createEl('p',{attr:{id:'text-machine-blocked-error',role:'alert'}});
                    error.hidden=true;
                    text.inputEl.setAttribute('aria-label',t('blockedSites'));
                    text.inputEl.setAttribute('aria-describedby','text-machine-blocked-error');
                    text.inputEl.readOnly=true;
                    text.inputEl.rows=3;
                    text.setPlaceholder(t('blockedSitesEmpty')).setValue(t('loading'));
                    void p.readBlocked().then((domains): void=>{
                        original=domains;
                        text.setValue(domains.join(', '));
                        text.inputEl.readOnly=!canEdit();
                    }).catch(caught=>{
                        text.setValue('').setPlaceholder('');
                        error.setText(errorOf(caught).message);error.hidden=false;
                    });
                    text.inputEl.addEventListener('blur',async()=>{
                        if (!original || saving || !canEdit() || p.blockedPath!==path) return;
                        saving=true;text.inputEl.readOnly=true;
                        error.hidden=true;text.inputEl.removeAttribute('aria-invalid');
                        try {
                            let domains: string[];
                            try {
                                domains=p.crawler.parseBlocked(JSON.stringify(text.getValue().split(/[,\n]/).map(value=>value.trim()).filter(Boolean)));
                                if (domains.some(domain=>!domain.includes('.'))) throw new Error();
                            } catch {throw new Error(t('blockedSitesInvalid'));}
                            if (JSON.stringify(domains)!==JSON.stringify(original)) {
                                const vault=this.app.vault, file=vault.getAbstractFileByPath(path);
                                if (file && !(file instanceof TFile)) throw new Error(t('invalidBlockedFile'));
                                const contents=JSON.stringify(domains,null,2)+'\n';
                                if (file) await vault.process(file,current=>{
                                    if (JSON.stringify(p.crawler.parseBlocked(current))!==JSON.stringify(original)) throw new Error(t('blockedSitesChanged'));
                                    return contents;
                                });
                                else {
                                    if (original.length) throw new Error(t('blockedSitesChanged'));
                                    await vault.create(path,contents);
                                }
                                original=domains;
                            }
                            text.setValue(domains.join(', '));
                        } catch (caught) {
                            error.setText(errorOf(caught).message);error.hidden=false;
                            text.inputEl.setAttribute('aria-invalid','true');
                        } finally {saving=false;text.inputEl.readOnly=!canEdit();}
                    });
                });
            }});
            if (p.settings.debug) newsletterSources.push({name:t('testBlockedSources'),desc:t('testBlockedSourcesDescription'),render:setting=>{
                setting.addButton(button=>button.setButtonText(t('testBlockedSources')).setDisabled(p.busy).onClick(()=>
                    this.run(t('testingBlockedSources'),async()=>{
                        const file=await p.testBlockedSources(message=>{this.progress=message;if (!p.disposed) this.redraw();});
                        this.result=t('blockedReportSaved',{path:file.path});
                        if (p.disposed) return;
                        const viewer=new Modal(this.app);
                        viewer.titleEl.setText(t('blockedReportTitle'));
                        viewer.contentEl.createEl('p',{text:file.path});
                        viewer.contentEl.createEl('pre',{cls:'text-machine-json',text:await this.app.vault.read(file)});
                        viewer.open();
                    })));
                if (p.crawlController) {
                    const activity=setting.descEl.createDiv({cls:'text-machine-activity',attr:{role:'status'}});
                    setIcon(activity.createSpan({cls:'text-machine-spinner',attr:{'aria-hidden':'true'}}),'loader-circle');
                    activity.createSpan({text:this.progress});
                    setting.addButton(button=>button.setButtonText(t('cancel')).onClick(()=>p.crawlController?.abort()));
                }
            }});
            if (p.settings.debug) journal.items.push({name:t('resetData'),desc:t('resetDataDescription'),render:setting=>{
                setting.addButton(button=>destructive(button).setButtonText(t('resetData')).setDisabled(!connected || p.busy).onClick(()=>{
                    if (!p.dataReady) {new Notice(t('createFolderFirst'));return;}
                    const file=p.dataFile;
                    const confirmation=new Modal(this.app);
                    confirmation.titleEl.setText(t('resetData'));
                    confirmation.contentEl.createEl('p',{text:t('resetDataConfirm',{path:file.path})});
                    new Setting(confirmation.contentEl)
                        .addButton(cancel=>cancel.setButtonText(t('cancel')).onClick(()=>confirmation.close()))
                        .addButton(confirm=>destructive(confirm).setButtonText(t('confirmReset')).onClick(()=>{
                            confirmation.close();
                            void this.run(t('resettingData'),async()=>{
                                await this.app.vault.modify(file,JSON.stringify({version:1,articles:[]},null,2)+'\n');
                                this.result=t('dataReset');
                            });
                        }));
                    confirmation.open();
                }));
            }});
        }
        if (this.result) journal.items.push({name:this.result,searchable:false,render:setting=>{
            setting.settingEl.addClass('text-machine-feedback');
            setting.settingEl.setAttribute('role','status');
        }});
        items.push(newsletterSettings);
        newsletterSources.unshift({name:t('referenceSources'),desc:t('referenceSourcesDescription'),render:setting=>{
            setting.addTextArea(text=>{
                text.inputEl.setAttribute('aria-label',t('referenceSources'));
                text.inputEl.rows=3;
                text.setPlaceholder('theguardian.com\nlemonde.fr').setValue(p.settings.referenceSources).onChange(value=>{
                    p.settings.referenceSources=value.trim();
                    void p.saveData(p.settings).catch(()=>{this.error=t('aiSaveFailed');this.redraw();});
                });
            });
        }});
        newsletterSettings.items.push({name:t('newsletterLanguage'),desc:t('newsletterLanguageDescription',{variable:'{{language}}'}),render:setting=>{
            setting.addText(text=>{
                text.inputEl.setAttribute('aria-label',t('newsletterLanguage'));
                text.setValue(p.settings.newsletterLanguage).setPlaceholder('français').onChange(value=>{
                    p.settings.newsletterLanguage=value.trim();
                    void p.saveData(p.settings).catch(()=>{this.error=t('aiSaveFailed');this.redraw();});
                });
            });
        }});
        newsletterSettings.items.push({name:t('minimumSources'),desc:t('minimumSourcesDescription'),render:setting=>{
            setting.addText(text=>{
                text.inputEl.type='number';
                text.inputEl.min='1';
                text.inputEl.step='1';
                text.inputEl.setAttribute('aria-label',t('minimumSources'));
                text.setValue(String(p.settings.minimumSources)).onChange(()=>{
                    const value=text.inputEl.valueAsNumber;
                    const valid=Number.isSafeInteger(value) && value>0;
                    text.inputEl.setAttribute('aria-invalid',String(!valid));
                    if (!valid) return;
                    p.settings.minimumSources=value;
                    void p.saveData(p.settings).catch(()=>{this.error=t('aiSaveFailed');this.redraw();});
                });
                text.inputEl.addEventListener('blur',()=>{
                    text.setValue(String(p.settings.minimumSources));
                    text.inputEl.removeAttribute('aria-invalid');
                });
            });
        }});
        for (const [key,label,description,placeholder] of [
            ['includeFeeds',t('includeFeeds'),t('includeFeedsDescription'),'https://site.example/feed\nhttps://autre.example/rss'],
            ['authorFeeds',t('authorFeeds'),t('authorFeedsDescription',{variable:'{{AuthorFeed}}'}),'https://monblog.substack.com\nhttps://autreblog.example/feed'],
        ] as const) newsletterSources.push({name:label,desc:description,render:setting=>{
            setting.addTextArea(text=>{
                text.inputEl.setAttribute('aria-label',label);
                text.inputEl.rows=3;
                text.setValue(p.settings[key]).setPlaceholder(placeholder).onChange(value=>{
                    p.settings[key]=value.trim();
                    void p.saveData(p.settings).catch(()=>{this.error=t('aiSaveFailed');this.redraw();});
                });
            });
        }});
        newsletterSettings.items.push({name:t('newsletterSourcesHeading'),render:setting=>{setting.setHeading();}},...newsletterSources);
        const promptDefinitions: PromptDefinition[] = [
            {file:'sélection.md',name:t('promptSelection'),desc:t('promptSelectionDescription'),variables:'{{language}}, {{articles}}, {{now}}, {{previousNewsletters}}, {{AuthorFeed}}'},
            {file:'writer.md',name:t('promptWriter'),desc:t('promptWriterDescription'),variables:'{{language}}, {{articles}}, {{previousNewsletters}}, {{AuthorFeed}}'},
            {file:'bref.md',name:t('promptBrief'),desc:t('promptBriefDescription'),variables:'{{language}}'},
            {file:'rewriter.md',name:t('promptRewriter'),desc:t('promptRewriterDescription'),variables:'{{language}}, {{AuthorFeed}}'},
            {file:'publisher.md',name:t('promptPublisher'),desc:t('promptPublisherDescription'),variables:'{{language}}, {{article}}'},
            {file:'image.md',name:t('promptImage'),desc:t('promptImageDescription'),variables:'{{language}}'},
            {file:'newsletter.md',name:t('newsletterTemplate'),desc:t('newsletterTemplateDescription'),
                variables:'{{title}}, {{chapeau}}, {{paragraphs_before_image}}, {{image}}, {{paragraphs_after_image}} ; {{#editorial}}…{{/editorial}}, {{#brief}}…{{/brief}} ({{heading}}), {{#articles}}…{{/articles}} ({{title}}, {{url}}, {{source}}, {{source_url}})'},
        ];
        newsletterSettings.items.push({name:t('newsletterPromptsHeading'),desc:t('newsletterPromptsDescription'),render:setting=>{setting.setHeading();}},
            ...promptDefinitions.map(prompt=>({name:prompt.name,desc:prompt.desc,render:(setting: Setting)=>{
                setting.addButton(button=>button.setButtonText(t('editPrompt')).setDisabled(p.busy).onClick(async()=>{
                    try {
                        const original=await p.readPrompt(prompt.file);
                        if (!p.disposed) new PromptEditor(this.app,p,prompt,original).open();
                    } catch (caught) {new Notice(errorOf(caught).message);}
                }));
            }})));
        items.push(p.renderAI(p,this));
        items.push({name:t('debug'),desc:t('debugDescription'),render:setting=>{
            setting.addToggle(toggle=>toggle.setValue(p.settings.debug).onChange(value=>{
                p.settings.debug=value;
                void p.saveData(p.settings).then(()=>{if (!p.disposed) this.redraw();})
                    .catch(()=>{this.error=t('aiSaveFailed');this.redraw();});
            }));
        }});
        return items;
    }
}
