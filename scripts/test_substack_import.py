from unittest.mock import MagicMock, Mock, patch
import unittest

from playwright.sync_api import TimeoutError

from substack_import import IMPORT_URL, RSS_FIELD, RSS_URL, chrome_context, confirm_send, is_import_page, prepare_import, publish_import, send_imported_post
from substack_import import main


class SubstackImportTests(unittest.TestCase):
    @patch("substack_import.sys.prefix", "/test-venv")
    @patch("substack_import.send_imported_post")
    @patch("substack_import.publish_import", return_value="https://textmachine.substack.com/p/article")
    @patch("substack_import.chrome_context")
    @patch("substack_import.sync_playwright")
    def test_main_closes_chrome_after_sending(self, playwright, chrome, publish, send):
        context = chrome.return_value.__enter__.return_value
        main()
        send.assert_called_once_with(context.new_page.return_value)
        context.wait_for_event.assert_not_called()
        chrome.return_value.__exit__.assert_called_once_with(None, None, None)

    def test_import_page_requires_correct_origin_and_path(self):
        self.assertTrue(is_import_page(IMPORT_URL))
        self.assertTrue(is_import_page(IMPORT_URL + "/?from=login"))
        for url in ("https://substack.com/sign-in", "https://textmachine.substack.com/publish", "https://other.substack.com/publish/import", "https://textmachine.substack.com.evil.test/publish/import", "http://textmachine.substack.com/publish/import"):
            with self.subTest(url=url):
                self.assertFalse(is_import_page(url))

    @patch("substack_import.expect")
    def test_fills_only_after_return_from_login(self, expect):
        for url in (IMPORT_URL, "https://substack.com/sign-in"):
            with self.subTest(url=url):
                page = Mock(url=url)
                field = page.locator.return_value
                page.wait_for_url.side_effect = lambda *args, **kwargs: setattr(page, "url", IMPORT_URL)
                field.fill.side_effect = lambda value: self.assertTrue(is_import_page(page.url))
                prepare_import(page)
                page.goto.assert_called_once_with(IMPORT_URL, wait_until="domcontentloaded")
                page.wait_for_url.assert_called_once_with(is_import_page, timeout=600_000, wait_until="domcontentloaded")
                page.locator.assert_called_once_with(RSS_FIELD)
                field.fill.assert_called_once_with(RSS_URL)
                expect(field).to_have_count.assert_called_with(1, timeout=30_000)
                expect(field).to_have_value.assert_called_with(RSS_URL)
                field.click.assert_not_called()

    def test_missing_login_never_fills(self):
        page = Mock(url="https://substack.com/sign-in")
        page.wait_for_url.side_effect = TimeoutError("Connexion absente")
        with self.assertRaises(TimeoutError):
            prepare_import(page)
        page.locator.assert_not_called()

    @patch("substack_import.expect")
    def test_reenters_url_if_page_clears_first_input(self, expect):
        page = Mock(url=IMPORT_URL)
        field = page.locator.return_value
        values = iter(("", RSS_URL))
        def check_value(expected):
            self.assertEqual(next(values), expected)
        expect.return_value.to_have_value.side_effect = check_value
        prepare_import(page)
        self.assertEqual(field.fill.call_count, 2)
        field.fill.assert_called_with(RSS_URL)
        self.assertEqual(expect.return_value.to_have_value.call_count, 2)

    @patch("substack_import.expect")
    def test_stops_if_url_is_still_empty_after_retry(self, expect):
        page = Mock(url=IMPORT_URL)
        expect.return_value.to_have_value.side_effect = AssertionError("Champ vide")
        with self.assertRaisesRegex(AssertionError, "Champ vide"):
            prepare_import(page)
        self.assertEqual(page.locator.return_value.fill.call_count, 2)
        page.get_by_role.assert_not_called()

    @patch("substack_import.expect")
    def test_missing_or_ambiguous_field_never_fills(self, expect):
        page = Mock(url=IMPORT_URL)
        expect.return_value.to_have_count.side_effect = AssertionError("Champ non unique")
        with self.assertRaises(AssertionError):
            prepare_import(page)
        page.locator.return_value.fill.assert_not_called()

    @patch("substack_import.prepare_import")
    @patch("substack_import.expect")
    def test_import_confirms_public_article(self, expect, prepare):
        page = Mock()
        page.context.request.get.return_value = Mock(
            ok=True, body=lambda: b'<rss><channel><item><title>Article</title><link>https://textmachine.substack.com/p/article</link></item></channel></rss>',
        )
        page.get_by_role.return_value.all.return_value = []
        page.get_by_role.return_value.count.return_value = 1
        self.assertEqual(publish_import(page), "https://textmachine.substack.com/p/article")
        prepare.assert_called_once_with(page)
        self.assertEqual(page.get_by_role.return_value.check.call_count, 2)
        self.assertEqual(page.get_by_role.return_value.click.call_count, 3)
        page.goto.assert_called_once_with("https://textmachine.substack.com/p/article", wait_until="domcontentloaded")

    def test_bad_rss_prevents_import(self):
        page = Mock()
        page.context.request.get.return_value = Mock(ok=False, status=503)
        with self.assertRaisesRegex(RuntimeError, "503"):
            publish_import(page)
        page.goto.assert_not_called()
        page.get_by_role.assert_not_called()

    @patch("substack_import.prepare_import")
    @patch("substack_import.expect")
    def test_ownership_is_accepted_before_next(self, expect, prepare):
        page = Mock()
        page.context.request.get.return_value = Mock(ok=True, body=lambda: b'<rss><channel><item><title>Article</title><link>https://textmachine.substack.com/p/article</link></item></channel></rss>')
        consent, next_button, other = Mock(), Mock(), Mock()
        other.count.return_value = 0
        other.all.return_value = []
        actions = []
        def find(role, name, **kwargs):
            if role == "checkbox" and name.search("Oui, c'est ma publication et j'accepte."):
                return consent
            if role == "button" and name.search("Suivant"):
                return next_button
            return other
        page.get_by_role.side_effect = find
        consent.check.side_effect = lambda: actions.append("accept")
        next_button.click.side_effect = lambda: self.assertEqual(actions, ["accept"])
        publish_import(page)
        consent.check.assert_called_once()
        expect(consent).to_be_checked.assert_called_once()

    @patch("substack_import.prepare_import")
    @patch("substack_import.expect")
    @patch("substack_import.time.monotonic", side_effect=[0, 181])
    def test_does_not_claim_publication_without_confirmation(self, clock, expect, prepare):
        page = Mock()
        page.context.request.get.return_value = Mock(ok=True, body=lambda: b'<rss><channel><item><title>Article</title></item></channel></rss>')
        page.get_by_role.return_value.all.return_value = []
        with self.assertRaisesRegex(RuntimeError, "Publication non confirmée"):
            publish_import(page)
        page.goto.assert_not_called()

    @patch("substack_import.socket.socket")
    @patch("substack_import.subprocess.Popen")
    @patch("substack_import.PROFILE")
    def test_existing_profile_uses_native_chrome(self, profile, popen, socket):
        profile.is_dir.return_value = True
        socket.return_value.__enter__.return_value.getsockname.return_value = ("127.0.0.1", 9223)
        process = popen.return_value
        process.poll.return_value = None
        playwright = Mock()
        browser = playwright.chromium.connect_over_cdp.return_value
        browser.contexts = [Mock()]
        with chrome_context(playwright) as context:
            self.assertIs(context, browser.contexts[0])
        self.assertIn(f"--user-data-dir={profile}", popen.call_args.args[0])
        self.assertNotIn("--use-mock-keychain", popen.call_args.args[0])
        playwright.chromium.launch_persistent_context.assert_not_called()
        browser.close.assert_called_once()
        process.terminate.assert_called_once()

    def test_accepts_only_send_confirmation(self):
        dialog = Mock(type="confirm", message="Send this published post to everyone?")
        confirm_send(dialog)
        dialog.accept.assert_called_once()
        dialog.dismiss.assert_not_called()
        other = Mock(type="confirm", message="Delete this post?")
        with self.assertRaisesRegex(RuntimeError, "inattendue"):
            confirm_send(other)
        other.dismiss.assert_called_once()
        other.accept.assert_not_called()

    @patch("substack_import.expect")
    def test_sends_correct_post_and_checks_server_response(self, expect):
        page = MagicMock()
        page.locator.return_value.inner_text.return_value = "Article"
        post = page.locator.return_value.filter.return_value
        post.get_attribute.return_value = "/publish/posts/detail/123?referrer=posts"
        response = page.expect_response.return_value.__enter__.return_value.value
        response.ok = True
        send_imported_post(page)
        page.locator.assert_any_call("h1.post-title")
        page.locator.return_value.filter.assert_called_once_with(has=page.get_by_text.return_value)
        post.get_by_text.assert_called_once_with("Article", exact=True)
        expect(post).to_have_count.assert_called_with(1)
        page.once.assert_called_once_with("dialog", confirm_send)
        page.remove_listener.assert_called_once_with("dialog", confirm_send)
        predicate = page.expect_response.call_args.args[0]
        good = Mock(url="https://textmachine.substack.com/api/v1/drafts/123/publish", request=Mock(method="POST"))
        self.assertTrue(predicate(good))
        good.url = "https://textmachine.substack.com/api/v1/drafts/456/publish"
        self.assertFalse(predicate(good))

    @patch("substack_import.expect")
    def test_failed_send_is_not_reported_as_success(self, expect):
        page = MagicMock()
        page.locator.return_value.inner_text.return_value = "Article"
        page.locator.return_value.filter.return_value.get_attribute.return_value = "/publish/posts/detail/123"
        response = page.expect_response.return_value.__enter__.return_value.value
        response.ok, response.status = False, 403
        with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
            send_imported_post(page)
        page.get_by_text.assert_called_once_with("Article", exact=True)
        page.remove_listener.assert_called_once_with("dialog", confirm_send)

    @patch("substack_import.expect")
    def test_missing_target_post_prevents_sending(self, expect):
        page = Mock()
        expect.return_value.to_be_visible.side_effect = AssertionError("Article absent")
        with self.assertRaises(AssertionError):
            send_imported_post(page)
        page.once.assert_not_called()
        page.expect_response.assert_not_called()
        page.locator.return_value.filter.return_value.locator.assert_not_called()


if __name__ == "__main__":
    unittest.main()
