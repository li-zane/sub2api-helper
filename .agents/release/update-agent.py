#!/usr/bin/env python3
"""Socket-activated x3 release broker: only a verified newer stable release of this project."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

# python -I deliberately ignores caller-controlled paths; only import sibling,
# root-installed release tools.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import download

APP = Path("/opt/tosub2/app")
STATE = Path("/run/tosub2-update")
INSTALLER = "/usr/local/sbin/helper-update"
SEMVER = r"(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})"
HASH = r"[0-9a-f]{40}"


def request_data(line):
    if len(line) > 180 or not line.endswith(b"\n"):
        raise ValueError("invalid request")
    obj = json.loads(line)
    if not isinstance(obj, dict) or set(obj) != {"version", "revision"}:
        raise ValueError("invalid request")
    if not re.fullmatch(SEMVER, obj["version"]) or not re.fullmatch(HASH, obj["revision"]):
        raise ValueError("invalid release")
    return obj["version"], obj["revision"]


def is_newer(candidate, installed):
    return bool(re.fullmatch(SEMVER, installed)) and tuple(map(int, candidate.split("."))) > tuple(map(int, installed.split(".")))


def save_state(version, phase):
    fd, tmp = tempfile.mkstemp(dir=STATE)
    try:
        with os.fdopen(fd, "w") as file:
            json.dump({"version": version, "phase": phase, "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}, file)
            file.flush()
            os.fsync(file.fileno())
            os.fchmod(file.fileno(), 0o644)
        os.replace(tmp, STATE / "status.json")
    finally:
        Path(tmp).unlink(missing_ok=True)


def authorize(version, revision):
    # Never trust a SHA, URL, command or channel supplied by the unprivileged
    # caller. Independently pin the public stable tag AND its immutable bundle.
    stable, head = download.release("latest")
    if stable.get("tag_name") != "v" + version or head != revision:
        raise ValueError("stable release changed")
    if not is_newer(version, json.loads((APP / "package.json").read_text())["version"]):
        raise ValueError("not an upgrade")
    return head


def reply(accepted, reason=None):
    print(json.dumps({"accepted": accepted, "reason": reason}), flush=True)


def main():
    try:
        version, revision = request_data(sys.stdin.buffer.readline(181))
    except (KeyError, TypeError, ValueError):
        reply(False, "invalid")
        return
    STATE.mkdir(mode=0o755, parents=False, exist_ok=True)
    with (STATE / "install.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            reply(False, "busy")
            return
        if not is_newer(version, json.loads((APP / "package.json").read_text())["version"]):
            reply(False, "current")
            return
        save_state(version, "checking")
        # Finish the accepted install even if the operator closes the page.
        try:
            reply(True)
        except (OSError, BrokenPipeError):
            pass
        try:
            head = authorize(version, revision)
            save_state(version, "downloading")
            cmd = [INSTALLER, head, "--wait-seconds", "1200"]
            with subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True, errors="replace", cwd="/", env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                                  "HOME": "/root", "LANG": "C.UTF-8"}) as proc:
                phase = "downloading"
                for line in proc.stdout:
                    # No tool/command output goes back to the console. Only
                    # advance phases using known markers from the installer.
                    next_phase = phase
                    if line.startswith("DISPATCH_DRAIN started="):
                        next_phase = "draining"
                    elif line.startswith("DRAIN_CHECK jobs=0 workers=0"):
                        next_phase = "installing"
                    elif line.startswith("HEALTH_PASS "):
                        next_phase = "verifying"
                    if next_phase != phase:
                        phase = next_phase
                        save_state(version, phase)
                code = proc.wait()
            installed = json.loads((APP / "package.json").read_text())["version"]
            result = "succeeded" if code == 0 and installed == version else "deferred" if code == 75 else "failed"
            if result == "succeeded":
                # Future releases may revise the bridge; only sync from the
                # root-owned, already verified and installed checkout.
                subprocess.run(["/bin/bash", str(APP / ".agents/release/install-update-agent.sh")], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=60)
            save_state(version, result)
        except Exception:
            save_state(version, "failed")


if __name__ == "__main__":
    main()
