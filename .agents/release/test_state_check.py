"""Ensure release idle/binding checks never silently inspect just page one."""
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("helper_state_check", Path(__file__).with_name("state-check.py"))
state_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state_check)


class StateCheckTest(unittest.TestCase):
    def run_check(self, mode, directory, pages):
        reads = []

        def response(request, timeout):
            url = request.full_url
            reads.append(url)
            if url.endswith("/api/bootstrap"):
                data = {"token": "synthetic-fixture-token"}
            else:
                page = int(url.rsplit("=", 1)[1])
                data = pages[page - 1]
            return io.BytesIO(json.dumps(data).encode())

        with patch.object(sys, "argv", ["state-check.py", mode, str(directory)]), patch.object(state_check.urllib.request, "urlopen", side_effect=response):
            result = state_check.main()
        return result, reads

    def pages(self):
        return [
            {"jobs": [{"id": "first", "status": "completed", "assignedProxyId": 1}], "pagination": {"total": 2, "totalPages": 2}},
            {"jobs": [{"id": "second", "status": "completed", "assignedProxyId": 2}], "pagination": {"total": 2, "totalPages": 2}},
        ]

    def test_later_page_active_task_defers_release(self):
        with tempfile.TemporaryDirectory() as directory:
            pages = self.pages()
            pages[1]["jobs"][0]["status"] = "totp_otp"
            result, reads = self.run_check("snapshot", directory, pages)
            self.assertEqual(result, 75)
            self.assertTrue(reads[-1].endswith("page=2"))
            self.assertFalse((Path(directory) / "account-bindings-before.json").exists())

    def test_snapshot_captures_bindings_on_every_page(self):
        with tempfile.TemporaryDirectory() as directory:
            result, _ = self.run_check("snapshot", directory, self.pages())
            self.assertEqual(result, 0)
            saved = json.loads((Path(directory) / "account-bindings-before.json").read_text())
            self.assertEqual(saved, [{"id": "first", "proxyId": 1}, {"id": "second", "proxyId": 2}])

    def test_later_page_binding_change_fails_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            pages = self.pages()
            self.run_check("snapshot", directory, pages)
            pages[1]["jobs"][0]["assignedProxyId"] = 99
            with self.assertRaisesRegex(RuntimeError, "bindings changed"):
                self.run_check("verify", directory, pages)

    def test_incomplete_duplicate_and_changing_pages_are_rejected(self):
        for change in ["incomplete", "duplicate", "changed_total"]:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                pages = self.pages()
                if change == "incomplete":
                    pages[1]["jobs"] = []
                elif change == "duplicate":
                    pages[1]["jobs"][0]["id"] = "first"
                else:
                    pages[1]["pagination"]["total"] = 3
                with self.assertRaises(RuntimeError):
                    self.run_check("snapshot", directory, pages)


if __name__ == "__main__":
    unittest.main()
