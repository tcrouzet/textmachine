from contextlib import contextmanager
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

from playwright.sync_api import Error, expect, sync_playwright


IMPORT_URL = "https://textmachine.substack.com/publish/import"
RSS_URL = "https://tcrouzet.github.io/textmachine/textmachine.rss"
PROFILE = Path.home() / "Library/Application Support/Google/Chrome/PlaywrightProfile"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
RSS_FIELD = (
    'input[type="url"]:visible, input[placeholder*="url" i]:visible, '
    'input[placeholder*="http" i]:visible, input[placeholder*="website" i]:visible'
)


def is_import_page(url):
    parsed = urlsplit(str(url))
    return (parsed.scheme == "https" and parsed.netloc == "textmachine.substack.com"
            and parsed.path.rstrip("/") == "/publish/import")


def prepare_import(page):
    page.goto(IMPORT_URL, wait_until="domcontentloaded")
    if not is_import_page(page.url):
        print("Connectez-vous à Substack dans la fenêtre Chrome. Attente du retour à l’import…", flush=True)
    page.wait_for_url(is_import_page, timeout=600_000, wait_until="domcontentloaded")
    field = page.locator(RSS_FIELD)
    expect(field).to_have_count(1, timeout=30_000)
    page.wait_for_timeout(3000)
    field.fill(RSS_URL)
    try:
        expect(field).to_have_value(RSS_URL)
    except AssertionError:
        field.fill(RSS_URL)
        expect(field).to_have_value(RSS_URL)


@contextmanager
def chrome_context(playwright):
    if not PROFILE.is_dir():
        raise RuntimeError(f"Profil Substack de NoMoreWordPress introuvable : {PROFILE}")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    process = subprocess.Popen(
        [CHROME, f"--user-data-dir={PROFILE}", f"--remote-debugging-port={port}",
         "--no-first-run", "--start-maximized", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    browser = None
    try:
        deadline = time.monotonic() + 30
        while browser is None:
            try:
                browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}", timeout=1000)
            except Error:
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("Chrome Substack indisponible : le profil est peut-être déjà ouvert.") from None
                time.sleep(.2)
        yield browser.contexts[0]
    finally:
        if browser is not None:
            browser.close()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)


def publish_import(page):
    response = page.context.request.get(RSS_URL)
    if not response.ok:
        raise RuntimeError(f"Flux RSS inaccessible : HTTP {response.status}")
    title = ET.fromstring(response.body()).findtext("channel/item/title")
    if not title:
        raise RuntimeError("Le flux RSS ne contient aucun titre d’article.")
    prepare_import(page)
    page.get_by_role("button", name=re.compile(r"^(Commencer|Get started|Start)$", re.I)).click()
    import_button = page.get_by_role("button", name=re.compile(r"^(Importer|Import)$", re.I))
    expect(import_button).to_be_visible(timeout=120_000)
    update = page.get_by_role("checkbox", name=re.compile(r"Update existing posts|Mettre à jour les (articles|publications) existant", re.I))
    if update.count() == 1:
        update.check()
    import_button.click()
    next_button = page.get_by_role("button", name=re.compile(r"^(Suivant|Continuer|Next|Continue)$", re.I))
    expect(next_button).to_be_visible(timeout=120_000)
    consent = page.get_by_role("checkbox", name=re.compile(r"^Oui, c['’]est ma publication et j['’]accepte\.?$|^Yes,.*my publication.*agree", re.I))
    expect(consent).to_be_visible()
    consent.check()
    expect(consent).to_be_checked()
    expect(next_button).to_be_enabled()
    next_button.click()
    expect(next_button).not_to_be_visible(timeout=120_000)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        published = page.context.request.get("https://textmachine.substack.com/feed")
        if published.ok:
            for item in ET.fromstring(published.body()).findall("channel/item"):
                link = item.findtext("link", "")
                url = urlsplit(link)
                if (item.findtext("title") == title and url.scheme == "https"
                        and url.netloc == "textmachine.substack.com" and url.path.startswith("/p/")):
                    page.goto(link, wait_until="domcontentloaded")
                    expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible()
                    return link
        time.sleep(2)
    raise RuntimeError("Publication non confirmée dans le flux public Substack.")


def confirm_send(dialog):
    if dialog.type == "confirm" and dialog.message == "Send this published post to everyone?":
        dialog.accept()
    else:
        dialog.dismiss()
        raise RuntimeError("Confirmation Substack inattendue : envoi interrompu.")


def send_imported_post(page):
    title = page.locator("h1.post-title").inner_text()
    page.get_by_role("button", name=re.compile(r"^(Tableau de bord|Dashboard)$", re.I)).click()
    page.get_by_role("link", name="Posts", exact=True).click()
    post = page.locator('a[href*="/publish/posts/detail/"]').filter(has=page.get_by_text(title, exact=True))
    expect(post).to_have_count(1)
    expect(post.get_by_text(title, exact=True)).to_be_visible()
    match = re.search(r"/publish/posts/detail/(\d+)(?:\?|$)", post.get_attribute("href") or "")
    if not match:
        raise RuntimeError("Impossible d’identifier l’article à envoyer.")
    publish_path = f"/api/v1/drafts/{match[1]}/publish"
    post.locator('button[aria-haspopup="menu"]').click()
    send = page.get_by_role("menuitem", name=re.compile(r"^(Envoyer à tous|Send to everyone)$", re.I))
    expect(send).to_be_visible()
    page.once("dialog", confirm_send)
    try:
        with page.expect_response(
            lambda response: response.request.method == "POST"
            and urlsplit(response.url).netloc == "textmachine.substack.com"
            and urlsplit(response.url).path == publish_path,
            timeout=60_000,
        ) as pending:
            send.click()
        response = pending.value
        if not response.ok:
            raise RuntimeError(f"Substack a refusé l’envoi : HTTP {response.status}.")
        expect(page.get_by_text(re.compile(r"^(Post envoyé|Post sent)$"))).to_be_visible(timeout=15_000)
    finally:
        page.remove_listener("dialog", confirm_send)


def main():
    if sys.prefix == sys.base_prefix:
        raise SystemExit("Lancez ce script avec le Python du venv.")
    try:
        with sync_playwright() as playwright:
            with chrome_context(playwright) as context:
                page = context.new_page()
                link = publish_import(page)
                send_imported_post(page)
                print(f"Article publié et envoyé : {link}", flush=True)
    except (Error, AssertionError, RuntimeError, ET.ParseError) as error:
        raise SystemExit(f"Import Substack interrompu : {error}") from None


if __name__ == "__main__":
    main()
