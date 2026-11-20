import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import download

SHA = "ab"*20
TAG = "v0.1.0"
if os.name == "posix":
    spec = importlib.util.spec_from_file_location("update_agent", Path(__file__).with_name("update-agent.py"))
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)


class VersionedReleaseTest(unittest.TestCase):
    def test_pinned_version_and_commit_channels(self):
        def fetch(url):
            return io.BytesIO(json.dumps({"object":{"type":"commit","sha":SHA}} if "/git/ref/" in url
                else {"tag_name":TAG, "target_commitish":SHA}).encode())
        with patch.object(download,"get",side_effect=fetch):
            self.assertEqual(download.release(TAG)[1],SHA)
            self.assertEqual(download.release("latest")[1],SHA)
            with self.assertRaises(ValueError): download.release("v0.9.0")
            with self.assertRaises(ValueError): download.release("../main")
        def wrong_tag(url):
            return io.BytesIO(json.dumps({"object":{"type":"commit","sha":"f"*40}} if "/git/ref/" in url
                else {"tag_name":TAG,"target_commitish":SHA}).encode())
        with patch.object(download,"get",side_effect=wrong_tag), self.assertRaises(ValueError):
            download.release("latest")

    @unittest.skipUnless(os.name=="posix","Linux update socket")
    def test_worker_checks_release_before_install_and_records_result(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); app=root/"app"; app.mkdir(); state=root/"run"; pkg=app/"package.json"
            pkg.write_text(json.dumps({"version":"0.0.9"}))
            def call(v,sha):
                stream=io.TextIOWrapper(io.BytesIO((json.dumps({"version":v,"revision":sha})+"\n").encode()))
                with stream, patch.object(sys,"stdin",stream), patch.object(sys,"stdout",new_callable=io.StringIO) as out:
                    worker.main()
                    return json.loads(out.getvalue())
            with patch.object(worker,"APP",app),patch.object(worker,"STATE",state),\
                 patch.object(worker.download,"release",return_value=({"tag_name":TAG},SHA)),\
                 patch.object(worker.subprocess,"Popen") as popen,patch.object(worker.subprocess,"run") as sync:
                self.assertFalse(call("bad",SHA)["accepted"])
                self.assertTrue(call("0.1.0","cd"*20)["accepted"])
                self.assertEqual(json.loads((state/"status.json").read_text())["phase"],"failed")
                popen.assert_not_called()
                proc=popen.return_value.__enter__.return_value
                proc.stdout=["DISPATCH_DRAIN started=true","DRAIN_CHECK jobs=0 workers=0","HEALTH_PASS jobs=0"]
                def complete():
                    pkg.write_text(json.dumps({"version":"0.1.0"}))
                    return 0
                proc.wait.side_effect=complete
                self.assertTrue(call("0.1.0",SHA)["accepted"])
                self.assertEqual(popen.call_args.args[0],[worker.INSTALLER,SHA,"--wait-seconds","1200"])
                self.assertEqual(json.loads((state/"status.json").read_text())["phase"],"succeeded")
                sync.assert_called_once()
                self.assertFalse(call("0.1.0",SHA)["accepted"])
