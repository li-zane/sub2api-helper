"""Exercise the actual rollback script against a separate app and synthetic API."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux service rollback fixture")
class RollbackTest(unittest.TestCase):
    def test_restores_code_frontend_and_dependencies_without_reverting_data(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app, backup, commands = (root / name for name in ("app", "backup", "bin"))
            for path in (app, backup, commands):
                path.mkdir()

            def git(*args):
                return subprocess.check_output(["git", "-C", str(app), *args], text=True).strip()

            git("init", "-b", "main")
            git("config", "user.name", "Release fixture")
            git("config", "user.email", "fixture@example.invalid")
            (app / "source.txt").write_text("old source")
            git("add", "source.txt")
            git("commit", "-m", "old fixture")
            before = git("rev-parse", "HEAD")
            (app / "source.txt").write_text("new source")
            git("commit", "-am", "new fixture")
            for directory, value in ((app / "web/dist", "new"), (backup / "dist-before", "old")):
                (directory / "assets").mkdir(parents=True)
                (directory / "index.html").write_text('<script src="/assets/main.js"></script>')
                (directory / "assets/main.js").write_text(value * 100)
            for directory, value in ((app / "node_modules", "new"), (backup / "node_modules-before", "old")):
                directory.mkdir()
                (directory / "runtime.txt").write_text(value)
            data = root / "business-data.json"
            data.write_text("data written after deployment began")
            (backup / "app-path.txt").write_text(str(app))
            (backup / "service-name.txt").write_text("synthetic-helper.service")
            (backup / "previous-commit.txt").write_text(before)
            (backup / "account-bindings-before.json").write_text(json.dumps([{"id": "fixture", "proxyId": "fixture-proxy"}]))
            tools = Path(__file__).parent
            shutil.copy2(tools / "state-check.py", backup / "state-check.py")

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path == "/api/bootstrap":
                        body = json.dumps({"token": "synthetic-fixture-token"}).encode()
                    elif self.path.split("?", 1)[0] == "/api/jobs":
                        body = json.dumps({"jobs": [{"id": "fixture", "assignedProxyId": "fixture-proxy"}]}).encode()
                    else:
                        body = (app / "web/dist" / ("index.html" if self.path == "/" else self.path.lstrip("/"))).read_bytes()
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, *_):
                    pass

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for name, script in {
                    "systemctl": "#!/bin/sh\nexit 0\n",
                    "curl": "#!/bin/sh\nexit 0\n",
                    "python3": f'#!/bin/sh\nexec {shlex.quote(sys.executable)} "$@" --base http://127.0.0.1:{server.server_port}\n',
                }.items():
                    path = commands / name
                    path.write_text(script)
                    path.chmod(0o755)
                env = os.environ.copy()
                env["PATH"] = str(commands) + os.pathsep + env["PATH"]
                result = subprocess.run(["bash", str(tools / "rollback-x3.sh"), str(backup)],
                                        env=env, text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(f"ROLLBACK_PASS revision={before} service=active data=preserved", result.stdout)
                self.assertEqual(git("rev-parse", "HEAD"), before)
                self.assertEqual(git("branch", "--show-current"), "")
                self.assertEqual((app / "source.txt").read_text(), "old source")
                self.assertEqual((app / "web/dist/assets/main.js").read_text(), "old" * 100)
                self.assertEqual((app / "node_modules/runtime.txt").read_text(), "old")
                self.assertEqual(data.read_text(), "data written after deployment began")
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
