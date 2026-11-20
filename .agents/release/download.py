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


SEMANTIC_TAG = r"v(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})"
COMMIT = r"[0-9a-f]{40}"


def release(version):
    if version == "latest":
        endpoint = "/releases/latest"
    elif re.fullmatch(SEMANTIC_TAG, version):
        endpoint = "/releases/tags/" + version
    elif re.fullmatch(COMMIT, version):
        endpoint = "/releases/tags/helper-" + version
    else:
        raise ValueError("Use latest, vMAJOR.MINOR.PATCH or an exact commit")
    with get(API + endpoint) as response:
        info = json.load(response)
    tag, revision = info.get("tag_name", ""), info.get("target_commitish", "")
    if info.get("draft") or info.get("prerelease") or not re.fullmatch(COMMIT, revision):
        raise ValueError("Unexpected release identity")
    if re.fullmatch(SEMANTIC_TAG, tag):
        if version not in ("latest", tag):
            raise ValueError("Version tag mismatch")
        # This project publishes lightweight v-tags pinned to the exact CI SHA.
        with get(API + "/git/ref/tags/" + tag) as response:
            target = json.load(response).get("object", {})
        if target.get("type") != "commit" or target.get("sha") != revision:
            raise ValueError("Version tag does not match the release commit")
    elif tag != "helper-" + revision or version not in ("latest", revision):
        raise ValueError("Unexpected release tag")
    return info, revision


def download(version, destination):
    info, revision = release(version)
    assets = {item["name"]: item for item in info["assets"]}
    destination.mkdir(parents=True, exist_ok=True)
    for name in (bundle.ASSET, "SHA256SUMS"):
        item = assets[name]
        url = item["browser_download_url"]
        if url != PREFIX + info.get("tag_name", "helper-" + revision) + "/" + name:
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
