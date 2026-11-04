const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {findCodex,generate}=require('../../plugin/ai/codex');
const {writerRequest,parseEditorial,renderPrompt,day}=require('../../plugin/newsletter');
const {rewriteRequest,parseRewrite}=require('../../plugin/ai/rewrite');
require('../../plugin/i18n').setLocale('fr');

async function main() {
    const root=path.resolve(__dirname,'../..');
    const settings=JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
    assert.equal(settings.aiModel,'__codex__','This check uses the configured Codex account only');
    const folder=path.resolve(root,'../../..',settings.outputFolder);
    const data=JSON.parse(fs.readFileSync(path.join(folder,'textmachine.json'),'utf8'));
    const sources=data.articles.filter(article=>['edukasoftware.com/2026/10/28/ai-report-card-comments',
        'ideas.repec.org/a/bjf/ijrsci/v13y2026i13p494-499.html','sjhrafrica.org/index.php/public-html/article/view/3086']
        .some(url=>article.url.includes(url)));
    assert.equal(sources.length,3);
    assert.ok(sources.every(article=>article.content));
    const previous=fs.readdirSync(folder).filter(name=>/^text-machine-\d{4}-\d{2}-\d{2}\.md$/.test(name)
        && !name.startsWith('text-machine-'+day())).sort().reverse().slice(0,5)
        .map(name=>({name,content:fs.readFileSync(path.join(folder,name),'utf8')}));
    const candidate=`Rédige le corps d’un article d’actualité en {{language}} pour un lecteur non spécialiste, en 1 500 signes maximum.
Choisis les faits qui méritent d’être racontés sur l’IA et l’écriture. Tu peux laisser de côté une source qui apporte peu. Une seule bonne information développée vaut mieux qu’un rapprochement artificiel entre plusieurs études.
Commence par une situation précise : qui fait quoi, avec quel résultat ? Explique les faits avec leurs détails utiles, chiffres, exemples et paroles d’auteur. Choisis deux courtes citations éclairantes si les sources en offrent ; attribue-les avec des liens Markdown.
Laisse le sens se dégager de ce que tu racontes. Une transition doit expliquer une relation factuelle entre deux informations. Tu peux passer directement à l’information suivante quand cette relation n’existe pas.
Explique les limites importantes avec des mots courants : qui a été comparé, ce que la comparaison permet de dire et ce qu’elle ne mesure pas. Termine sur une information précise plutôt que sur une exhortation ou une morale.
Préserve les faits et les liens. Retourne uniquement le JSON demandé avec les paragraphes, sans titre ni chapeau.
Sujets déjà traités : {{previousNewsletters}}
Articles : {{articles}}`;
    const executable=await findCodex();
    const report={model:settings.codexModel,testedAt:new Date().toISOString(),sources:sources.map(({id,title,url})=>({id,title,url})),authorFeed:[],runs:[]};
    const output=path.join(root,'doc','editorial-check-'+day()+'.json');
    fs.mkdirSync(path.dirname(output),{recursive:true});
    for (const [name,prompt] of [['current',fs.readFileSync(path.join(root,'prompts/writer.md'),'utf8')],['candidate',candidate]]) {
        const request=writerRequest(prompt,sources,previous,[],'français');
        process.stdout.write(name+': writer started\n');
        const result=parseEditorial(await generate(executable,request.system,request.input,settings.codexModel,undefined,undefined,request.schema));
        const run={name,prompt,original:result.paragraphs,final:result.paragraphs};
        report.runs.push(run);fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
        process.stdout.write(name+': revision started\n');
        const system=renderPrompt(fs.readFileSync(path.join(root,'prompts/rewriter.md'),'utf8'),{language:'français',AuthorFeed:'[]',recentPosts:'[]'});
        const revision=rewriteRequest(system,result.paragraphs.join('\n\n'));
        try {run.final=parseRewrite(revision.input,await generate(executable,revision.system,revision.input,settings.codexModel,undefined,undefined,revision.schema));}
        catch(error) {run.revisionError=error.message;}
        fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
        process.stdout.write(name+': complete\n');
    }
    process.stdout.write('Report: '+output+'\n');
}
main().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
