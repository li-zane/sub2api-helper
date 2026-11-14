#!/usr/bin/env python3
"""Resolve immutable GitHub releases and verify their complete runtime bundles."""
import argparse
import json
from pathlib import Path
import re
import urllib.request
import bundle

API = "https://api.github.com/repos/li-zane/sub2api-helper"
PREFIX = "https://github.com/li-zane/sub2api-helper/releases/download/"


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "sub2api-helper-update",
                                                  "Accept": "application/vnd.github+json"})
    return urllib.request.urlopen(request, timeout=60)


def release(version):
    if version != "latest" and not re.fullmatch(r"[0-9a-f]{40}", version):
        raise ValueError("Use latest or a full 40-character commit SHA")
    endpoint = "/releases/latest" if version == "latest" else "/releases/tags/helper-" + version
    with get(API + endpoint) as response:
        info = json.load(response)
    revision = info.get("tag_name", "").removeprefix("helper-")
    if (not re.fullmatch(r"[0-9a-f]{40}", revision) or info.get("draft") or info.get("prerelease")
            or info.get("target_commitish") != revision or (version != "latest" and version != revision)):
        raise ValueError("Unexpected release identity")
    return info, revision


def download(version, destination):
    info, revision = release(version)
    assets = {item["name"]: item for item in info["assets"]}
    destination.mkdir(parents=True, exist_ok=True)
    for name in (bundle.ASSET, "SHA256SUMS"):
        item = assets[name]
        url = item["browser_download_url"]
        if not url.startswith(PREFIX + "helper-" + revision + "/"):
            raise ValueError("Unexpected release asset URL")
        path = destination / name
        with get(url) as response, path.open("wb") as output:
            while data := response.read(1024 * 1024):
                output.write(data)
        if path.stat().st_size != item["size"]:
            raise ValueError("Truncated release asset")
        api_digest = item.get("digest")
        if api_digest and api_digest != "sha256:" + bundle.digest(path):
            raise ValueError("GitHub asset digest mismatch")
    expected = (destination / "SHA256SUMS").read_text().strip().split()
    if len(expected) != 2 or expected[1] != bundle.ASSET or expected[0] != bundle.digest(destination / bundle.ASSET):
        raise ValueError("Release checksum mismatch")
    metadata = bundle.extract(destination / bundle.ASSET, destination / "staging", revision)
    print(f"DOWNLOAD_OK revision={revision} files={len(metadata['files'])} sha256={expected[0]}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["resolve", "download"])
    parser.add_argument("version", nargs="?", default="latest")
    parser.add_argument("--destination", type=Path)
    args = parser.parse_args()
    if args.mode == "resolve":
        print(release(args.version)[1])
    else:
        if args.destination is None:
            parser.error("download requires --destination")
        download(args.version, args.destination)
