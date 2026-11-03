import argparse
import base64
from datetime import datetime, timezone
from email.utils import format_datetime
from html import escape
from http.client import HTTPException
from pathlib import Path
import sys
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

from markdown_it import MarkdownIt


ROOT = Path(__file__).resolve().parents[1]
CONTENT = "http://purl.org/rss/1.0/modules/content/"
ET.register_namespace("content", CONTENT)


def embed_image(url):
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("URL HTTP(S) absolue requise")
        request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "image/*"})
        try:
            with urlopen(request, timeout=20) as response:
                data = response.read(10 * 1024 * 1024 + 1)
        except HTTPError as error:
            if error.code == 404 and parsed.hostname in {"i0.wp.com", "i1.wp.com", "i2.wp.com"}:
                return embed_image("https://" + parsed.path.lstrip("/"))
            raise
        if len(data) > 10 * 1024 * 1024:
            raise ValueError("image supérieure à 10 Mo")
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            mime = "image/png"
        elif data.startswith(b"\xff\xd8\xff"):
            mime = "image/jpeg"
        elif data.startswith((b"GIF87a", b"GIF89a")):
            mime = "image/gif"
        elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            mime = "image/webp"
        else:
            raise ValueError("format d’image non reconnu")
        return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
    except (OSError, ValueError, HTTPException) as error:
        print(f"Image omise : {url} ({error})", file=sys.stderr)
        return None


def latest_markdown(directory):
    files = [path for path in directory.glob("*.md") if path.is_file()]
    if not files:
        raise ValueError(f"Aucun fichier Markdown dans {directory}")
    return max(files, key=lambda path: (path.stat().st_mtime_ns, path.name))


def plain_text(tokens):
    return "".join(
        " " if token.type in {"softbreak", "hardbreak"} else token.content
        for token in tokens
        if token.nesting == 0
    ).strip()


def image_with_caption(renderer, tokens, index, options, env):
    image = renderer.image(tokens, index, options, env)
    caption = tokens[index].attrGet("alt")
    return image + (f"<br>\n<em>{escape(caption)}</em>" if caption else "")


def build_feed(source, site_url="https://textmachine.substack.com/"):
    url = urlsplit(site_url)
    if url.scheme not in {"http", "https"} or not url.hostname or url.fragment:
        raise ValueError("L’URL de publication doit être une URL HTTP(S) absolue sans fragment.")
    markdown = MarkdownIt("commonmark", {"html": False})
    markdown.add_render_rule("image", image_with_caption)
    tokens = markdown.parse(source.read_text(encoding="utf-8-sig"))
    if len(tokens) < 6 or tokens[0].type != "heading_open" or tokens[0].tag != "h1":
        raise ValueError("Le Markdown doit commencer par un titre # puis un chapeau en italique.")
    intro_index = 3
    while (intro_index + 2 < len(tokens)
           and tokens[intro_index].type == "paragraph_open"
           and tokens[intro_index + 1].children
           and all(child.type == "image" for child in tokens[intro_index + 1].children)):
        intro_index += 3
    intro = tokens[intro_index + 1].children or [] if intro_index + 2 < len(tokens) else []
    if (not intro or tokens[intro_index].type != "paragraph_open"
            or intro[0].type != "em_open" or intro[-1].type != "em_close"
            or any(token.level == 0 for token in intro[1:-1])):
        raise ValueError("Le paragraphe après le titre doit être entièrement en italique.")
    title = plain_text(tokens[1].children or [])
    subtitle = plain_text(intro)
    if not title or not subtitle or not tokens[intro_index + 3:]:
        raise ValueError("Le titre, le chapeau et le corps doivent être non vides.")
    for token in tokens:
        for child in token.children or []:
            if child.type == "image":
                image = embed_image(child.attrGet("src") or "")
                if image:
                    child.attrSet("src", image)
                else:
                    child.type = "text"
                    child.content = ""
                    child.children = None
    body = markdown.renderer.render(tokens[3:], markdown.options, {})
    rss = ET.Element("rss", version="2.0")
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = "TextMachine"
    ET.SubElement(channel, "link").text = site_url
    ET.SubElement(channel, "description").text = "Newsletter TextMachine"
    ET.SubElement(channel, "language").text = "fr"
    item = ET.SubElement(channel, "item")
    ET.SubElement(item, "title").text = title
    ET.SubElement(item, "guid", isPermaLink="false").text = f"textmachine:{source.stem}"
    date = datetime.fromtimestamp(source.stat().st_mtime, timezone.utc)
    ET.SubElement(item, "pubDate").text = format_datetime(date, usegmt=True)
    ET.SubElement(item, "description").text = subtitle
    ET.SubElement(item, f"{{{CONTENT}}}encoded").text = body
    ET.indent(rss)
    data = ET.tostring(rss, encoding="utf-8", xml_declaration=True)
    ET.fromstring(data)
    return data


def main():
    parser = argparse.ArgumentParser(description="Convertit la dernière newsletter Markdown en textmachine.rss.")
    parser.parse_args()
    try:
        source = latest_markdown(ROOT / "newsletters")
        data = build_feed(source)
        output = ROOT / "textmachine.rss"
        temporary = output.with_suffix(".rss.tmp")
        temporary.write_bytes(data)
        temporary.replace(output)
    except (OSError, ValueError, ET.ParseError) as error:
        parser.exit(1, f"Erreur : {error}\n")
    print(f"{source.name} → {output}")


if __name__ == "__main__":
    main()
