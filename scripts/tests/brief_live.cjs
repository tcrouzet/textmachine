const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {findCodex,generate}=require('../../plugin/ai/codex');
const {briefRequest,parseBrief,renderNewsletter,day}=require('../../plugin/newsletter');
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
    const articles=JSON.parse(fs.readFileSync(database,'utf8')).articles;
    const links=[...fs.readFileSync(note,'utf8').matchAll(/^\* \[([^\]]+)\]\(([^)]+)\)/gm)];
    const sources=links.map(([,title,url])=>{
        const article=articles.find(article=>article.url===url);
        assert.ok(article,'Source missing from the database: '+url);
        return {article,previous:title};
    });
    const prompt=profile?.prompts?.['bref.md'] ?? fs.readFileSync(path.join(root,'prompts/bref.md'),'utf8');
    const request=briefRequest(prompt,sources.map(source=>source.article),profile?.newsletterLanguage || settings.newsletterLanguage,
        sources.filter(source=>source.article.status==='').map(source=>source.article));
    process.stdout.write('Translating '+sources.length+' titles with the configured model and effort\n');
    const response=await generate(await findCodex(),request.system,request.input,settings.codexModel,undefined,undefined,request.schema,undefined,settings.codexEffort);
    const translated=parseBrief(response,sources.map(source=>source.article),sources.filter(source=>source.article.status==='').map(source=>source.article));
    assert.deepEqual([hash(note),hash(database)],before,'The note and article database must remain unchanged');
    const originals=new Map(sources.map(source=>[source.article.id,source]));
    const report={date,model:settings.codexModel,effort:settings.codexEffort,testedAt:new Date().toISOString(),unchanged:true,
        titles:[...translated.map(article=>({id:article.id,url:article.url,original:originals.get(article.id).article.title,
            previous:originals.get(article.id).previous,translated:article.title,category:article.category})),
        ...sources.filter(source=>!translated.some(article=>article.id===source.article.id))
            .map(({article,previous})=>({id:article.id,url:article.url,original:article.title,previous,translated:null,category:null}))]};
    const output=path.join(root,'doc','brief-check-'+date+'-'+Date.now()+'.json');
    fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
    const template=profile?.prompts?.['newsletter.md'] ?? fs.readFileSync(path.join(root,'models/newsletter.md'),'utf8');
    const preview=renderNewsletter(template,{title:'',chapeau:'',paragraphs:[],image:null,used:[],discard:[]},translated);
    fs.writeFileSync(output.replace(/\.json$/,'.md'),preview);
    process.stdout.write('REPORT '+output+'\n');
    process.stdout.write(JSON.stringify({total:sources.length,retained:translated.length,
        categories:[...new Set(translated.map(article=>article.category))],unchanged:true})+'\n');
}

main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
