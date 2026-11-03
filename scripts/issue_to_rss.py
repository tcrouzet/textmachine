from datetime import datetime
import json
import os
from pathlib import Path
import sys
import tempfile

from newsletter_to_rss import ROOT, build_feed


def convert_issue(event, root=ROOT):
    issue = event["issue"]
    owner = event["repository"]["owner"]["login"]
    allowed = {owner, "dust-agent[bot]"}
    if (issue["user"]["login"] not in allowed or event["sender"]["login"] not in allowed
            or issue["state"] != "open"
            or "newsletter" not in [label["name"] for label in issue["labels"]]):
        raise ValueError("Seule une issue newsletter ouverte, créée et modifiée par le propriétaire ou Dust est autorisée.")
    number = issue["number"]
    if type(number) is not int or number < 1:
        raise ValueError("Numéro d’issue invalide.")
    body = issue.get("body")
    if not isinstance(body, str) or not body.strip():
        raise ValueError("Le corps de l’issue doit contenir la newsletter Markdown.")
    name = f"issue-{number}.md"
    date = datetime.fromisoformat(issue["created_at"].replace("Z", "+00:00")).timestamp()
    with tempfile.TemporaryDirectory() as temporary:
        source = Path(temporary) / name
        source.write_text(body, encoding="utf-8")
        os.utime(source, (date, date))
        rss = build_feed(source)
    (root / "newsletters").mkdir(exist_ok=True)
    (root / "newsletters" / name).write_text(body, encoding="utf-8")
    output = root / "textmachine.rss.tmp"
    output.write_bytes(rss)
    output.replace(root / "textmachine.rss")
    print(f"Issue #{number} → textmachine.rss")


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    if len(sys.argv) > 1:
        event["issue"] = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    convert_issue(event)
