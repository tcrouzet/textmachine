const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {findCodex,generate}=require('../../plugin/ai/codex');
const {selectionRequest,selectArticles,writerRequest,parseWriter,briefRequest,parseBrief,publisherRequest,parsePublisher,renderPrompt,renderNewsletter,day}=require('../../plugin/newsletter');
const {rewriteRequest,parseRewrite}=require('../../plugin/ai/rewrite');
const {correctNewsletterPunctuation}=require('../../plugin/punctuation');
const {t}=require('../../plugin/i18n');
require('../../plugin/i18n').setLocale('fr');

async function main() {
    const root=path.resolve(__dirname,'../..');
    const settings=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
    assert.equal(settings.aiModel,'__codex__','This check uses the configured account and model only');
    const profile=settings.newsletters?.find(profile=>profile.id===settings.activeNewsletter);
    const folder=path.resolve(root,'../../..',profile?.outputFolder || settings.outputFolder);
    const date=process.argv[2] || day();
    assert.match(date,/^\d{4}-\d{2}-\d{2}$/);
    const note=path.join(folder,'text-machine-'+date+'.md'),database=path.join(folder,'textmachine.json');
    const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const before=[hash(note),hash(database)];
    const original=fs.readFileSync(note,'utf8').split(/\n#{2,}\s/)[0];
    const urls=new Set([...original.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map(match=>match[1]));
    const sources=JSON.parse(fs.readFileSync(database,'utf8')).articles.filter(article=>urls.has(article.url));
    assert.ok(sources.length>=2 && sources.every(article=>article.content),'Use the actual readable sources of the saved article');
    const previous=fs.readdirSync(folder).filter(name=>/^text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(name) && name!=='text-machine-'+date+'.md')
        .sort().reverse().slice(0,5).map(name=>({name,content:fs.readFileSync(path.join(folder,name),'utf8')}));
    const read=file=>profile?.prompts?.[file] ?? fs.readFileSync(path.join(root,'prompts',file),'utf8');
    const language=profile?.newsletterLanguage || settings.newsletterLanguage;
    const executable=await findCodex();
    const report={date,model:settings.codexModel,effort:settings.codexEffort,startedAt:new Date().toISOString(),complete:false,
        sources:sources.map(({id,title,url})=>({id,title,url})),original,stages:{}};
    const output=path.join(root,'doc','editorial-check-'+date+'-'+Date.now()+'.json');
    fs.mkdirSync(path.dirname(output),{recursive:true});
    const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
    const respond=async(stage,request)=>{
        process.stdout.write(stage+': started\n');
        return generate(executable,request.system,request.input,settings.codexModel,undefined,undefined,request.schema,undefined,settings.codexEffort);
    };
    const publication=async(stage,request,parse)=>{
        try {return parse(await respond(stage,request));}
        catch(error) {
            if (error.code!=='CHAPEAU_TOO_LONG') throw error;
            return parse(await respond(stage,{...request,system:request.system+'\n\n'+t('publicationShorten')}));
        }
    };
    save();
    const selection=await selectArticles(sources,articles=>selectionRequest(read('sélection.md'),articles,language,
        profile?.referenceSources || settings.referenceSources,previous,[]),request=>respond('selection',request));
    report.stages.selection={selected:selection.selected.map(article=>article.id),brief:selection.brief.map(article=>article.id),discard:selection.discard};save();
    const complex=sources.find(article=>article.url.includes('mindmatters.ai/2026/11/for-c-s-lewis'));
    if (complex) assert.ok(selection.brief.some(article=>article.id===complex.id),'The source needing extensive context belongs in brief');
    const writer=parseWriter(await respond('writer',writerRequest(read('writer.md'),selection.selected,previous,[],language,profile?.referenceSources || settings.referenceSources)),selection.selected);
    assert.ok(writer.paragraphs.length,'The clarity check needs an actual press review');
    report.used=writer.used.map(article=>article.id);report.stages.writer=writer.paragraphs;save();
    const result={title:'',chapeau:'',paragraphs:writer.paragraphs,image:null,used:writer.used.map(article=>article.url),discard:[]};
    try {result.paragraphs=parseRewrite(writer.paragraphs.join('\n\n'),await respond('rewriter',rewriteRequest(renderPrompt(read('rewriter.md'),{language,AuthorFeed:'[]',recentPosts:'[]'}),writer.paragraphs.join('\n\n'))));}
    catch(error) {report.revisionError=error.message;}
    report.stages.rewriter=result.paragraphs;save();
    Object.assign(result,await publication('publisher',publisherRequest(read('publisher.md'),result.paragraphs,language),parsePublisher));
    report.stages.publisher={title:result.title,chapeau:result.chapeau};save();
    report.final={title:result.title,chapeau:result.chapeau,paragraphs:result.paragraphs};
    const brief=[...selection.brief,...selection.selected.filter(article=>!result.used.includes(article.url))];
    let translated=[];
    if (brief.length) {
        const request=briefRequest(read('bref.md'),brief,language,brief);
        translated=parseBrief(await respond('brief',request),brief,brief);
        report.brief=translated.map(({id,title,url,category})=>({id,title,url,category}));
    }
    assert.deepEqual([hash(note),hash(database)],before,'The saved newsletter and article database must remain unchanged');
    report.unchanged=true;report.complete=true;report.finishedAt=new Date().toISOString();save();
    const template=profile?.prompts?.['newsletter.md'] ?? fs.readFileSync(path.join(root,'models/newsletter.md'),'utf8');
    fs.writeFileSync(output.replace(/\.json$/,'.md'),correctNewsletterPunctuation(renderNewsletter(template,result,translated),language));
    process.stdout.write('REPORT '+output+'\n');
}
main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
