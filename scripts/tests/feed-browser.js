import {readFeed} from '../../plugin/newsletter';
import {extractPage} from '../../plugin/crawler';

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
