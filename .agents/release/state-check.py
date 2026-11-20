#!/usr/bin/env python3
"""Read-only production checks; never print bootstrap credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.request

TERMINAL = {"completed", "failed", "mfa_failed", "banned", "canceled",
            "reauth_required", "resume_available"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["snapshot", "verify", "resumed"])
    parser.add_argument("backup", type=Path)
    parser.add_argument("--app", type=Path, default=Path("/opt/tosub2/app"))
    parser.add_argument("--base", default="http://127.0.0.1:4399")
    parser.add_argument("--require-drain", action="store_true")
    args = parser.parse_args()

    def get(path, token=None):
        headers = {"x-console-token": token} if token else {}
        with urllib.request.urlopen(urllib.request.Request(args.base + path, headers=headers), timeout=30) as response:
            return response.read()

    token = json.loads(get("/api/bootstrap"))["token"]
    if args.mode == "resumed":
        state = json.loads(get("/api/release-drain", token))
        if state.get("paused") is False and state.get("ready") is True:
            print("DISPATCH_READY enabled_settings_unchanged=true", flush=True)
            return 0
        return 75
    # The console paginates jobs. Both the idle gate and binding verification
    # must include later pages, including accounts with running tasks.
    jobs = []
    page = 1
    expected_total = None
    while True:
        payload = json.loads(get(f"/api/jobs?page={page}", token))
        jobs.extend(payload["jobs"])
        pagination = payload.get("pagination", {})
        total = pagination.get("total", len(jobs))
        if expected_total is not None and total != expected_total:
            raise RuntimeError("Account list changed during paginated check; retry when stable")
        expected_total = total
        if page >= pagination.get("totalPages", 1):
            break
        page += 1
    if len(jobs) != expected_total or len({job["id"] for job in jobs}) != len(jobs):
        raise RuntimeError("Incomplete or changing account list; refusing partial verification")
    bindings = sorted([{"id": job["id"], "proxyId": job.get("assignedProxyId")}
                       for job in jobs], key=lambda item: item["id"])
    snapshot = args.backup / "account-bindings-before.json"
    if args.mode == "snapshot":
        active = sum(job.get("status") not in TERMINAL for job in jobs)
        print(f"IDLE_CHECK jobs={len(jobs)} active={active}", flush=True)
        if args.require_drain:
            gate = json.loads(get("/api/release-drain", token))
            if gate.get("paused") is not True:
                raise RuntimeError("Running service did not acknowledge the dispatch pause")
            busy = [gate.get("busyJobs"), gate.get("busyWorkers")]
            if any(type(n) is not int or n < 0 for n in busy):
                raise RuntimeError("Missing release drain counters")
            print(f"DRAIN_CHECK jobs={busy[0]} workers={busy[1]}", flush=True)
            if any(busy):
                return 75
        if active:
            return 75
        snapshot.write_text(json.dumps(bindings), encoding="utf-8")
        return 0
    if json.loads(snapshot.read_text(encoding="utf-8")) != bindings:
        raise RuntimeError("Account set or proxy bindings changed; inspect before continuing")
    html = get("/").decode()
    assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)
    if not assets:
        raise RuntimeError("Frontend asset links missing")
    for asset in assets:
        local = (args.app / "web/dist" / asset.lstrip("/")).resolve()
        local.relative_to((args.app / "web/dist").resolve())
        body = get(asset)
        if len(body) < 100 or hashlib.sha256(body).digest() != hashlib.sha256(local.read_bytes()).digest():
            raise RuntimeError("Served frontend differs from deployed files")
    print(f"HEALTH_PASS jobs={len(jobs)} bindings_unchanged={len(bindings)} assets={len(assets)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
