import { App, FuzzySuggestModal, Modal, Setting, TFolder } from 'obsidian';

export interface FolderPickerLabels {
 title: string; current: string; use: string; createNew: string; openExisting: string;
 browse: string; root: string; chooseLocation: string; location: string; name: string;
 placeholder: string; back: string; create: string; cancel: string;
}
export interface FolderPickerOptions {
 labels: FolderPickerLabels;
 defaultName?: string;
 description?: string;
 allowCreate?: boolean;
 canUse?: (folder: TFolder) => boolean;
}

export class FolderSuggest extends FuzzySuggestModal<TFolder> {
 constructor(app: App, private readonly choose: (folder: TFolder) => void,
  private readonly labels: Pick<FolderPickerLabels,'root'|'chooseLocation'>,
  private readonly allowed: (folder: TFolder) => boolean = folder => !folder.isRoot()) {
  super(app);this.setPlaceholder(labels.chooseLocation);
 }
 getItems(): TFolder[] { return [this.app.vault.getRoot(),...this.app.vault.getAllFolders(false)].filter(this.allowed); }
 getItemText(folder: TFolder): string { return folder.isRoot()?this.labels.root:folder.path; }
 onChooseItem(folder: TFolder): void { this.choose(folder); }
}

export class FolderPicker extends Modal {
 private error!: HTMLElement;
 private submitting=false;
 constructor(app: App, private readonly folder: string,
  private readonly create: (name: string | null, folder: string) => Promise<void>,
  private readonly options: FolderPickerOptions) { super(app);this.folder=folder==='/'?'':folder; }
 private canUse(folder: TFolder): boolean { return this.options.canUse?this.options.canUse(folder):!folder.isRoot(); }
 onOpen(): void {
  const el=this.contentEl,labels=this.options.labels;
  el.empty();this.setTitle(labels.title);
  const current=this.folder?this.app.vault.getAbstractFileByPath(this.folder):this.app.vault.getRoot();
  new Setting(el).setName(labels.current).setDesc(this.folder || labels.root)
   .addButton(button=>button.setButtonText(labels.use).setDisabled(!(current instanceof TFolder) || !this.canUse(current)).setCta().onClick(()=>{void this.submit(null,this.folder);}));
  if(this.options.allowCreate!==false)new Setting(el).setName(labels.createNew)
   .addButton(button=>button.setButtonText(labels.create).onClick(()=>this.newFolder()));
  new Setting(el).setName(labels.openExisting).addButton(button=>button.setButtonText(labels.browse).onClick(()=>{
   new FolderSuggest(this.app,folder=>{void this.submit(null,folder.isRoot()?'':folder.path);},labels,folder=>this.canUse(folder)).open();
  }));
  this.error=el.createEl('p',{attr:{role:'alert'}});
  new Setting(el).addButton(button=>button.setButtonText(labels.cancel).onClick(()=>this.close()));
 }
 private newFolder(): void {
  const el=this.contentEl,labels=this.options.labels;
  el.empty();this.setTitle(labels.createNew);
  let parent=this.folder;
  const location=new Setting(el).setName(labels.location).setDesc(parent || labels.root);
  location.addButton(button=>button.setButtonText(labels.browse).onClick(()=>{
   new FolderSuggest(this.app,folder=>{parent=folder.isRoot()?'':folder.path;location.setDesc(parent || labels.root);},labels,()=>true).open();
  }));
  let name=this.options.defaultName || '';
  new Setting(el).setName(labels.name).addText(input=>{
   input.inputEl.setAttribute('aria-label',labels.name);
   input.setPlaceholder(labels.placeholder).setValue(name).onChange(value=>{name=value;});input.inputEl.focus();
  });
  if(this.options.description)el.createEl('p',{text:this.options.description});
  this.error=el.createEl('p',{attr:{role:'alert'}});
  new Setting(el).addButton(button=>button.setButtonText(labels.back).onClick(()=>this.onOpen()))
   .addButton(button=>button.setButtonText(labels.create).setCta().onClick(()=>{void this.submit(name.trim(),parent);}));
 }
 private async submit(name: string | null, folder: string): Promise<void> {
  if(this.submitting)return;
  this.submitting=true;this.error.setText('');
  const buttons=Array.from(this.contentEl.querySelectorAll('button'),button=>({button,disabled:button.disabled}));
  for(const {button} of buttons)button.disabled=true;
  try{await this.create(name,folder);this.close();}
  catch(failure){
   this.error.setText(failure instanceof Error?failure.message:String(failure));this.submitting=false;
   for(const {button,disabled} of buttons)button.disabled=disabled;
  }
 }
 onClose(): void { this.contentEl.empty(); }
}
