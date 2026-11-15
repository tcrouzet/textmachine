import {readFeed} from '../../plugin/newsletter';
import {extractPage, extractSocialImage, crawl} from '../../plugin/crawler';

// Obsidian's DOM helper for the standalone browser fixture.
Element.prototype.createEl ||= function(tag,options={}) {
    const el=this.ownerDocument.createElement(tag);
    for(const [key,value] of Object.entries(options.attr || {})) el.setAttribute(key,value);
    if(options.prepend) this.prepend(el); else this.append(el);
    return el;
};

export function runFeedChecks() {
    let checks=0;
    const check=(condition,message)=>{if(!condition) throw new Error(message);checks++;};
    const prose='<p>'+('An author describes how writing changes with automation, offering evidence and concrete examples. ').repeat(8)+'</p>';
    const rss=body=>'<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>Writing</title><link>https://example.com/article</link>'+body+'</item></channel></rss>';
    const full=readFeed(rss('<pubDate>Thu, 05 Nov 2026 09:00:00 GMT</pubDate><dc:creator>An Author</dc:creator><content:encoded><![CDATA['+prose+prose+']]></content:encoded>'))[0];
    check(full.publish==='2026-11-05T09:00:00.000Z','RSS date');
    check(full.authors[0]==='An Author','RSS author');
    check(extractPage(full.html,full.url).content.includes('concrete examples'),'Full RSS body extraction');
    const summary=readFeed(rss('<description><![CDATA['+prose+']]></description>'))[0];
    check(!summary.html,'A description must not be treated as full content');
    for(const body of ['<pubDate>2026-02-30T12:00:00Z</pubDate>','<pubDate>nonsense</pubDate>','<pubDate>Mon, 30 Feb 2026 12:00:00 GMT</pubDate>'])
        check(readFeed(rss(body))[0].publish==='','Invalid publication date');
    const atom=body=>'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Writing</title><link href="/article" rel="alternate"/><author><name>Another Author</name></author>'+body+'</entry></feed>';
    const html=readFeed(atom('<published>2026-11-03T12:00:00+01:00</published><updated>2026-11-05T12:00:00Z</updated><content type="html"><![CDATA['+prose+']]></content>'),5,'https://example.com/feed')[0];
    check(html.publish==='2026-11-03T11:00:00.000Z','Published must win over updated');
    check(html.authors[0]==='Another Author','Atom author');
    check(html.url==='https://example.com/article','Atom relative URL');
    check(extractPage(html.html,html.url).content.length>120,'Atom HTML extraction');
    const xhtml=readFeed(atom('<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">'+prose+'</div></content>'),5,'https://example.com/feed')[0];
    check(extractPage(xhtml.html,xhtml.url).content.length>120,'Atom XHTML extraction');
    check(!readFeed(atom('<updated>2026-11-05T12:00:00Z</updated>'))[0].publish,'Updated alone is not publication');
    check(!readFeed(atom('<content type="html" src="https://example.com/body"/>'))[0].html,'External Atom body must not be fetched');
    const restricted=readFeed(rss('<content:encoded><![CDATA['+prose+'<p>Subscribe to read the full article.</p>]]></content:encoded>'))[0];
    check(extractPage(restricted.html,restricted.url).blocked,'Paywall text must not become a complete article');
    check(!extractPage('<p>A tiny excerpt.</p>','https://example.com/short').content,'Short excerpt must be crawled');
    return {passed:checks};
}

export async function runSourceChecks() {
    const url='https://www.theatlantic.com/books/2026/11/ai-literary-scams-amazon/689391/';
    const prose='<p>'+('A novelist describes how fabricated versions of her books mislead readers. ').repeat(12)+'</p>';
    const html='<title>Real article title</title><meta property="og:title" content="Real article title">'
        +'<meta property="og:image" content="/photo.jpg"><article><h1>Real article title</h1>'+prose
        +'<figure><img src="/photo.jpg"><figcaption>Original photograph. Credit: Author / Agency.</figcaption></figure></article>';
    const original={id:1,url:'https://flip.it/MtZqB9',title:'MtZqB9',date:'',source:'User',authors:[],status:'',usedAt:'',publish:'',content:'',image:''};
    for (const content of ['', 'Previously collected full article.']) {
        const result=await crawl({...original,content},[],undefined,async()=>({url,status:200,html}));
        if (result.url!==url || result.title!=='Real article title' || !result.content
            || (content && result.content!==content)) throw new Error('Resolve redirects while preserving cached text and recovering the title');
    }
    const image=extractSocialImage(html,url);
    if (image?.image!=='https://www.theatlantic.com/photo.jpg' || image.imageCaption!=='Original photograph. Credit: Author / Agency.')
        throw new Error('Preserve the complete original image credit');
    return {passed:3};
}

export function runImageCaptionChecks() {
    let passed=0;
    const check=(condition,message)=>{if(!condition) throw new Error(message);passed++;};
    const url='https://scroll.in/article/1096984/the-algorithms-autograph-can-artificial-intelligence-ever-become-an-author';
    const social='https://sc0.blr1.cdn.digitaloceanspaces.com/book/192343-ygpzvdjuap-1689746514.jpg';
    const original=social.replace('/book/','/article/');
    const html='<meta property="og:image" content="'+social+'"><article><figure><picture><img src="'+original+'"></picture><figcaption>CC BY 4.0</figcaption></figure><p>'
        +'An author describes the practical consequences of automated writing. '.repeat(20)+'</p></article>';
    const image=extractSocialImage(html,url);
    check(image?.image===social && image.imageCaption==='CC BY 4.0','The Scroll social rendition must keep the original figure credit');
    check(extractPage(html,url).imageCaption==='CC BY 4.0','Article crawling must recover the same caption');
    check(extractSocialImage(html.replace('CC BY 4.0',' \n '),url)===null,'An empty figure caption must not produce an image');
    const unrelated=html.replace(original,'https://other.example/'+original.split('/').pop());
    check(extractSocialImage(unrelated,url)===null,'Matching filenames from other hosts must not borrow captions');
    const missing='<meta property="og:image" content="https://images.example/uncaptioned.jpg">';
    check(extractSocialImage(missing,url)===null,'A social thumbnail alone has no original caption');
    const fallback=missing+'<meta name="twitter:image" content="'+original+'"><figure><img src="'+original+'"><figcaption>Original caption. Photo: Author / Agency.</figcaption></figure>';
    check(extractSocialImage(fallback,url)?.imageCaption==='Original caption. Photo: Author / Agency.','Try the next social thumbnail if the first has no caption');
    return {passed};
}
