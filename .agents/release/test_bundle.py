import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import bundle
import download

REVISION = "a" * 40


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        for name in ("src/console-server.mjs", "web/dist/index.html", "node_modules/jsdom/package.json",
                     "package.json", "package-lock.json", "requirements.txt"):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture runtime " + name + "\n")
        metadata = {"schema": 1, "revision": REVISION, "platform": "linux-x64", "node_major": 22,
                    "files": bundle.inventory(self.source)}
        (self.source / "release.json").write_text(json.dumps(metadata))
        self.archive = self.root / bundle.ASSET
        self.pack()

    def tearDown(self):
        self.temp.cleanup()

    def pack(self):
        with tarfile.open(self.archive, "w:gz") as tar:
            for path in self.source.iterdir():
                tar.add(path, arcname=path.name)

    def test_complete_runtime_round_trip(self):
        target = self.root / "restored"
        actual = bundle.extract(self.archive, target, REVISION)
        self.assertEqual(actual["revision"], REVISION)
        self.assertEqual(bundle.inventory(target), bundle.inventory(self.source))

    def test_rejects_changed_runtime_file(self):
        (self.source / "src/console-server.mjs").write_text("changed")
        self.pack()
        with self.assertRaisesRegex(ValueError, "inventory/hash"):
            bundle.extract(self.archive, self.root / "out", REVISION)

    def test_rejects_unlisted_file(self):
        (self.source / "unexpected.env").write_text("fixture")
        self.pack()
        with self.assertRaisesRegex(ValueError, "inventory/hash"):
            bundle.extract(self.archive, self.root / "out", REVISION)

    def test_rejects_wrong_revision(self):
        with self.assertRaisesRegex(ValueError, "revision/platform"):
            bundle.extract(self.archive, self.root / "out", "b" * 40)

    def test_rejects_parent_traversal(self):
        with tarfile.open(self.archive, "w:gz") as tar:
            member = tarfile.TarInfo("../outside")
            member.size = 4
            tar.addfile(member, io.BytesIO(b"test"))
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            bundle.extract(self.archive, self.root / "out", REVISION)
        self.assertFalse((self.root / "outside").exists())

    def test_rejects_escaping_symlink(self):
        with tarfile.open(self.archive, "w:gz") as tar:
            member = tarfile.TarInfo("escape")
            member.type = tarfile.SYMTYPE
            member.linkname = "../../outside"
            tar.addfile(member)
        with self.assertRaises((tarfile.FilterError, ValueError)):
            bundle.extract(self.archive, self.root / "out", REVISION)

    def release_assets(self, checksum):
        archive = self.archive.read_bytes()
        files = {bundle.ASSET: archive, "SHA256SUMS": checksum}
        assets = [{"name": name, "size": len(body), "digest": "sha256:" + hashlib.sha256(body).hexdigest(),
                   "browser_download_url": download.PREFIX + "helper-" + REVISION + "/" + name}
                  for name, body in files.items()]
        return files, {"assets": assets}

    def test_download_verifies_asset_and_inventory(self):
        files, info = self.release_assets(f"{bundle.digest(self.archive)}  {bundle.ASSET}\n".encode())
        with patch.object(download, "release", return_value=(info, REVISION)), \
                patch.object(download, "get", side_effect=lambda url: io.BytesIO(files[url.rsplit("/", 1)[1]])):
            download.download(REVISION, self.root / "download")
        self.assertTrue((self.root / "download/staging/web/dist/index.html").is_file())

    def test_download_rejects_checksum_mismatch(self):
        files, info = self.release_assets(f"{'0' * 64}  {bundle.ASSET}\n".encode())
        with patch.object(download, "release", return_value=(info, REVISION)), \
                patch.object(download, "get", side_effect=lambda url: io.BytesIO(files[url.rsplit("/", 1)[1]])), \
                self.assertRaisesRegex(ValueError, "checksum mismatch"):
            download.download(REVISION, self.root / "download")

    def test_wrong_github_asset_digest(self):
        files, info = self.release_assets(f"{bundle.digest(self.archive)}  {bundle.ASSET}\n".encode())
        info["assets"][0]["digest"] = "sha256:" + "0" * 64
        with patch.object(download, "release", return_value=(info, REVISION)), \
                patch.object(download, "get", side_effect=lambda url: io.BytesIO(files[url.rsplit("/", 1)[1]])), \
                self.assertRaisesRegex(ValueError, "GitHub asset digest"):
            download.download(REVISION, self.root / "download")


if __name__ == "__main__":
    unittest.main()
