"""Release preflight runs a fixed read check as the service, not the socket worker."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
PROBE = HERE / "service-read-check.sh"


class ServiceReadTest(unittest.TestCase):
    def test_bootstrap_and_updates_include_the_probe(self):
        for file in ("helper-update", "install-update-agent.sh"):
            self.assertIn(PROBE.name, (HERE / file).read_text())
        steps = (HERE / "deploy-x3.sh").read_text()
        calls = [i for i, line in enumerate(steps.splitlines()) if PROBE.name in line]
        stop = steps.splitlines().index('systemctl stop "$service"')
        self.assertEqual(len(calls), 2)
        self.assertLess(calls[0], stop)
        self.assertLess(stop, calls[1])

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux preflight protocol")
    def test_manager_receives_service_uid_and_propagates_read_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            args_file = root / "args"
            manager = root / "systemd-run"
            manager.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                "args=sys.argv[1:]; i=args.index('/bin/sh')\n"
                "with open(os.environ['ARGS_FILE'],'w') as f: json.dump(args[:i],f)\n"
                "os.execv('/bin/sh', args[i:])\n"
            )
            manager.chmod(0o755)
            env = dict(os.environ, PATH=tmp + ":" + os.environ["PATH"], ARGS_FILE=str(args_file))
            good = root / "a file;still-data"
            good.touch()
            for f, expected in [(good, 0), (root / "absent", 1), ("not-absolute", 1)]:
                result = subprocess.run(["bash", str(PROBE), str(good), str(f)], env=env)
                self.assertEqual(result.returncode, expected)
            flags = json.loads(args_file.read_text())
            self.assertEqual(set(flags), {"--quiet", "--wait", "--collect",
                "--property=User=tosub2", "--property=NoNewPrivileges=yes",
                "--property=PrivateTmp=yes", "--property=ProtectSystem=strict"})
