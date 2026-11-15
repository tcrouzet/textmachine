import copy
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from issue_to_rss import convert_issue
from newsletter_to_rss import CONTENT


class IssueTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.event = {
            "repository": {"owner": {"login": "tcrouzet"}},
            "sender": {"login": "tcrouzet"},
            "issue": {
                "number": 12, "user": {"login": "tcrouzet"}, "state": "open",
                "labels": [{"name": "newsletter"}], "created_at": "2026-10-31T12:00:00Z",
                "body": '# Titre\n\n*Chapeau*\n\nTexte avec `$(touch surprise)` et `${{ secrets.TEST }}`.',
            },
        }

    def test_conversion_preserves_text_and_identity(self):
        convert_issue(self.event, self.root)
        self.assertEqual((self.root / "newsletters/issue-12.md").read_text(), self.event["issue"]["body"])
        item = ET.parse(self.root / "textmachine.rss").find("channel/item")
        self.assertEqual(item.findtext("guid"), "textmachine:issue-12")
        self.assertEqual(item.findtext("pubDate"), "Sat, 31 Oct 2026 12:00:00 GMT")
        self.assertIn("$(touch surprise)", item.findtext(f"{{{CONTENT}}}encoded"))
        self.event["issue"]["body"] += "\n\nCorrection."
        convert_issue(self.event, self.root)
        updated = ET.parse(self.root / "textmachine.rss").find("channel/item")
        self.assertEqual(updated.findtext("guid"), item.findtext("guid"))
        self.assertIn("Correction.", updated.findtext(f"{{{CONTENT}}}encoded"))

    def test_rejects_unauthorized_events(self):
        for field, value in (("user", {"login": "visitor"}), ("state", "closed"), ("labels", []), ("number", "../../bad")):
            event = copy.deepcopy(self.event)
            event["issue"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                convert_issue(event, self.root)
        self.event["sender"]["login"] = "visitor"
        with self.assertRaises(ValueError):
            convert_issue(self.event, self.root)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_accepts_dust_newsletter(self):
        self.event["issue"]["user"]["login"] = "dust-agent[bot]"
        for sender in ("dust-agent[bot]", "tcrouzet"):
            with self.subTest(sender=sender):
                self.event["sender"]["login"] = sender
                convert_issue(self.event, self.root)
                self.assertTrue((self.root / "textmachine.rss").is_file())
        self.event["sender"]["login"] = "another-agent[bot]"
        with self.assertRaises(ValueError):
            convert_issue(self.event, self.root)

    def test_invalid_body_preserves_existing_feed(self):
        output = self.root / "textmachine.rss"
        output.write_text("Flux précédent")
        for body in (None, "", "# Titre\n\nSans chapeau"):
            self.event["issue"]["body"] = body
            with self.subTest(body=body), self.assertRaises(ValueError):
                convert_issue(self.event, self.root)
            self.assertEqual(output.read_text(), "Flux précédent")
            self.assertFalse((self.root / "newsletters").exists())


if __name__ == "__main__":
    unittest.main()
