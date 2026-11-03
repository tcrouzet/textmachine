import base64
from contextlib import redirect_stderr
from io import BytesIO, StringIO
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
import xml.etree.ElementTree as ET

from newsletter_to_rss import CONTENT, build_feed, embed_image, latest_markdown


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")


class NewsletterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source = self.directory / "newsletter.md"
        self.download = self.enterContext(patch("newsletter_to_rss.urlopen", side_effect=lambda *args, **kwargs: BytesIO(PNG)))
        self.errors = self.enterContext(redirect_stderr(StringIO()))

    def convert(self, text):
        self.source.write_text(text, encoding="utf-8")
        return ET.fromstring(build_feed(self.source))

    def test_content_and_subtitle(self):
        rss = self.convert('# Un *titre* & une preuve\n\n_Chapeau avec [lien](https://example.org)\net accents é._\n\n## Section\n\n![Image](https://example.org/a.jpg?a=1&b=2)\n\n**Texte** et *italique*.\n\n- Un\n- Deux\n\n*Signature.*')
        item = rss.find("channel/item")
        self.assertEqual(rss.findtext("channel/link"), "https://textmachine.substack.com/")
        self.assertEqual(item.findtext("title"), "Un titre & une preuve")
        self.assertEqual(item.findtext("description"), "Chapeau avec lien et accents é.")
        body = item.findtext(f"{{{CONTENT}}}encoded")
        self.assertTrue(body.startswith('<p><em>Chapeau avec <a href="https://example.org">lien</a>'))
        self.assertNotIn("<h1>", body)
        for expected in ('<h2>Section</h2>', f'src="data:image/png;base64,{base64.b64encode(PNG).decode()}"', '<strong>Texte</strong>', '<em>italique</em>', '<li>Un</li>', '<em>Signature.</em>'):
            self.assertIn(expected, body)
        self.assertEqual(item.find("guid").get("isPermaLink"), "false")
        self.assertEqual(len(rss.findall("channel/item")), 1)

    def test_latest_uses_modification_time(self):
        old = self.directory / "z.md"
        old.write_text("Ancien")
        self.source.write_text("Récent")
        os.utime(old, (100, 100))
        os.utime(self.source, (200, 200))
        self.assertEqual(latest_markdown(self.directory), self.source)
        with self.assertRaisesRegex(ValueError, "Aucun fichier"):
            latest_markdown(self.directory / "absent")

    def test_visible_image_captions(self):
        rss = self.convert('# Titre\n\n*Chapeau*\n\n![Légende *accentuée* & <photo>](https://example.org/a.png)\n\n![](https://example.org/b.png)')
        body = rss.findtext(f"channel/item/{{{CONTENT}}}encoded")
        self.assertIn('alt="Légende accentuée &amp; &lt;photo&gt;"', body)
        self.assertIn('<br>\n<em>Légende accentuée &amp; &lt;photo&gt;</em>', body)
        self.assertEqual(body.count('<br>'), 1)

    def test_invalid_structure(self):
        for text in ("", "## Titre\n\n*Chapeau*\n\nCorps", "# Titre\n\nSans italique\n\nCorps", "# Titre\n\n*Début* milieu *fin*\n\nCorps", "# Titre\n\n*Chapeau*"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.convert(text)

    def test_images_before_subtitle(self):
        for images in ("![Légende](https://example.org/a.png)",
                       "![Légende](https://example.org/a.png)\n\n![Suite](https://example.org/b.png)"):
            with self.subTest(images=images):
                rss = self.convert(f"# Titre\n\n{images}\n\n*Chapeau*\n\nCorps")
                self.assertEqual(rss.findtext("channel/item/description"), "Chapeau")
                body = rss.findtext(f"channel/item/{{{CONTENT}}}encoded")
                self.assertIn('src="data:image/png;base64,', body)
                self.assertIn("<em>Légende</em>", body)
                self.assertLess(body.index("<img"), body.index("<em>Chapeau</em>"))
                self.assertIn("Corps", body)

    def test_image_before_invalid_subtitle(self):
        for tail in ("", "Sans italique\n\nCorps", "*Chapeau*",
                     "Texte\n\n*Chapeau*\n\nCorps"):
            with self.subTest(tail=tail), self.assertRaises(ValueError):
                self.convert(f"# Titre\n\n![Image](https://example.org/a.png)\n\n{tail}")

    def test_invalid_image_urls_are_omitted(self):
        for url in ("image.jpg", "//example.org/image.jpg", "data:image/png;base64,AAAA"):
            with self.subTest(url=url):
                rss = self.convert(f"# Titre\n\n*Chapeau*\n\n![Image]({url})\n\nTexte conservé.")
                body = rss.findtext(f"channel/item/{{{CONTENT}}}encoded")
                self.assertNotIn("<img", body)
                self.assertIn("Texte conservé.", body)
        self.download.assert_not_called()

    def test_failed_images_are_omitted(self):
        for error in (HTTPError("https://example.org/a.png", 403, "Forbidden", {}, None), URLError("DNS"), TimeoutError("timeout")):
            with self.subTest(error=error):
                self.download.side_effect = error
                rss = self.convert("# Titre\n\n*Chapeau*\n\n![Image](https://example.org/a.png)\n\nCorps")
                body = rss.findtext(f"channel/item/{{{CONTENT}}}encoded")
                self.assertNotIn("<img", body)
                self.assertNotIn("Image", body)
                self.assertIn("Corps", body)
                self.assertIn("Image omise", self.errors.getvalue())

    def test_image_bytes_round_trip_and_reject_non_images(self):
        encoded = embed_image("https://example.org/a.png")
        self.assertEqual(base64.b64decode(encoded.split(",", 1)[1], validate=True), PNG)
        request = self.download.call_args.args[0]
        self.assertEqual(request.full_url, "https://example.org/a.png")
        self.assertEqual(self.download.call_args.kwargs["timeout"], 20)
        for data in (b"", b"<html>Access denied</html>", b"\x89PNG\r\n\x1a\n" + b"x" * (10 * 1024 * 1024)):
            with self.subTest(size=len(data)):
                self.download.side_effect = lambda *args, **kwargs: BytesIO(data)
                self.assertIsNone(embed_image("https://example.org/a.png"))

    def test_wordpress_proxy_404_uses_original_image(self):
        proxy = "https://i0.wp.com/example.org/photo.jpg?resize=2000%2C1200&ssl=1"
        self.download.side_effect = [HTTPError(proxy, 404, "Not Found", {}, None), BytesIO(PNG)]
        rss = self.convert(f"# Titre\n\n*Chapeau*\n\n![Légende]({proxy})")
        body = rss.findtext(f"channel/item/{{{CONTENT}}}encoded")
        self.assertIn("data:image/png;base64,", body)
        self.assertIn("<em>Légende</em>", body)
        self.assertEqual(self.download.call_args.args[0].full_url, "https://example.org/photo.jpg")

    def test_original_image_failure_is_omitted(self):
        proxy = "https://i0.wp.com/example.org/photo.jpg?resize=2000%2C1200"
        self.download.side_effect = [HTTPError(proxy, 404, "Not Found", {}, None), URLError("DNS")]
        self.assertIsNone(embed_image(proxy))
        self.assertEqual(self.download.call_count, 2)

    def test_bad_site_url_and_xml_characters(self):
        self.source.write_text("# Titre\n\n*Chapeau*\n\nCorps")
        with self.assertRaisesRegex(ValueError, "URL de publication"):
            build_feed(self.source, "file:///tmp/textmachine.rss")
        with self.assertRaises(ET.ParseError):
            self.convert("# Titre\n\n*Chapeau*\n\nContrôle \x01")


if __name__ == "__main__":
    unittest.main()
