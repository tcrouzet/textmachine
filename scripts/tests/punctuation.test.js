const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const code = require('esbuild').buildSync({
    entryPoints:[path.join(__dirname,'../../plugin/punctuation/index.ts')],
    bundle:true,platform:'node',format:'cjs',write:false,
}).outputFiles[0].text;
const context = {module:{exports:{}}};
vm.runInNewContext(code,context);
const {correctNewsletterPunctuation:correct} = context.module.exports;

test('French newsletters receive Finition typography and remain unchanged on a second pass',()=>{
    for (const [input,expected] of [
        ["# L'IA: demain...\n\n«Un livre!», dit l'auteur; prix: 25 euros.\n\n– Bonjour!",
            '# L’IA\u00a0: demain…\n\n«\u00a0Un livre\u00a0!\u00a0», dit l’auteur\u00a0; prix\u00a0: 25\u00a0euros.\n\n—\u00a0Bonjour\u00a0!'],
        ['Une – idée — utile. De 10—20 km, à 10:30.','Une –\u00a0idée\u00a0– utile. De 10–20\u00a0km, à 10:30.'],
        ['« Une « autre » citation. »\n\n25\u202fkg et 20 %!','«\u00a0Une “autre” citation.\u00a0»\n\n25\u202fkg et 20\u00a0%\u00a0!'],
    ]) {
        assert.equal(correct(input,'français'),expected);
        assert.equal(correct(expected,'français'),expected);
    }
});

test('punctuation preserves Markdown links, images, code, metadata and addresses',()=>{
    const protectedParts = [
        "[L'IA?...](https://example.com/a_(b)?first=1&next=2)",
        "![L'IA!](https://example.com/image.jpg?size=2)",
        "[[L'IA: demain|L'IA!]]", "https://example.com/l'auteur?first=1&next=2", '10:30',
        "`l'IA:...`", "```js\nconst url = 'https://example.com?a=1';\n\n\n```",
        '<a href="https://example.com">L’IA: demain...</a>',
    ];
    const metadata = "---\ntitle: L'IA: demain...\n---\n\n";
    const input = metadata + "L'IA: demain...\n\n" + protectedParts.join('\n\n');
    const output = correct(input,'français');
    assert.ok(output.startsWith(metadata+'L’IA\u00a0: demain…'));
    for (const part of protectedParts) assert.ok(output.includes(part),part);
});

test('French heading and brief link titles receive nonbreaking colon spacing without changing their targets',()=>{
    const target='https://example.com/report:2026?q=10:30&title=Writing:practice';
    const input='# Écrire: apprendre\n\n#### [Écriture : pratiques](<'+target+'> "Source: titre")\n\n* [Atelier à 10:30: écrire](https://example.com/a_(b):c)';
    const expected='# Écrire\u00a0: apprendre\n\n#### [Écriture\u00a0: pratiques](<'+target+'> "Source: titre")\n\n* [Atelier à 10:30\u00a0: écrire](https://example.com/a_(b):c)';
    assert.equal(correct(input,'français'),expected);
    assert.equal(correct(expected,'français'),expected);
    assert.equal(correct(input,'English'),input);
});

test('colon correction in link labels preserves code, frontmatter, images and wiki targets',()=>{
    const parts=[
        '---\ntitle: "[Titre: lien](https://example.com)"\n---',
        '`[Titre: code](https://example.com)`',
        '```md\n[Titre: bloc](https://example.com)\n```',
        '![Photo: légende](https://example.com/photo.jpg)',
        '[![Photo: légende](https://example.com/photo.jpg)](https://example.com/article)',
        '[[Note: cible]]',
        '[Titre: référence][ref]\n\n[ref]: https://example.com',
    ];
    const input=parts.join('\n\n');
    assert.equal(correct(input,'français'),input);
});

test('Finition paragraph spacing keeps lists compact and code blank lines intact',()=>{
    const input = '- Un\n\n- Deux\n\n\nFin.\n\n```\nUn\n\n\nDeux\n```';
    assert.equal(correct(input,'français'),'- Un\n- Deux\n\nFin.\n\n```\nUn\n\n\nDeux\n```');
});

test('source image captions and credits retain their original typography in a French newsletter',()=>{
    for (const image of ['![A portrait](https://example.com/photo.jpg)','[![A portrait](https://example.com/photo.jpg)](https://example.com/article)']) {
        const caption = "A writer's portrait. Photograph: Jane Example / Agency. A book...";
        const block = image.replace('A portrait',caption);
        const output = correct("# L'IA: demain...\n\n"+block+"\n\nL'auteur: un livre!",'français');
        assert.ok(output.includes(block));
        assert.ok(output.includes('# L’IA\u00a0: demain…'));
        assert.ok(output.includes('L’auteur\u00a0: un livre\u00a0!'));
        assert.equal(correct(output,'français'),output);
    }
});

test('French names and locale codes activate correction while other languages preserve the text',()=>{
    const input = "L'IA: demain...";
    for (const language of ['français','francais','Français','French','fr','fr-FR','fr_CA',' FR ']) {
        assert.equal(correct(input,language),'L’IA\u00a0: demain…');
    }
    for (const language of ['English','en','en-US','español','de','franglais','']) assert.equal(correct(input,language),input);
    assert.equal(correct('','français'),'');
});
