import {t} from './i18n';
import {createBrowser} from './obsidian-toolbox/src/web/browser';
export type {Page,PageLoader,PageObserver,BrowserWindowConstructor} from './obsidian-toolbox/src/web/browser';
export const {loadPage,fetchPage,retrievePage,publicAddress,publicUrl,failureCode}=createBrowser({cancelled:()=>t('newsletterCancelled'),invalid:()=>t('invalidMessageContent'),partition:'text-machine'});
