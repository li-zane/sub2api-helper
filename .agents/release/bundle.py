#!/usr/bin/env python3
"""Build and verify a Linux runtime bundle. Never include runtime account data."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import tarfile

ASSET = "helper-linux-x64-node22.tar.gz"
ROOTS = ("src", "web/src", "web/dist", "node_modules", "package.json", "package-lock.json", "requirements.txt")


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(root):
    result = {}
    for path in sorted(root.rglob("*")):
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            path.resolve().relative_to(root.resolve())
            result[name] = {"link": os.readlink(path)}
        elif path.is_file() and name != "release.json":
            result[name] = {"sha256": digest(path), "executable": bool(path.stat().st_mode & 0o111)}
    return result


def verify(root, revision):
    metadata = json.loads((root / "release.json").read_text())
    if (metadata.get("schema") != 1 or metadata.get("revision") != revision
            or metadata.get("platform") != "linux-x64" or metadata.get("node_major") != 22):
        raise ValueError("Bundle revision/platform mismatch")
    if inventory(root) != metadata["files"]:
        raise ValueError("Bundle file inventory/hash mismatch")
    for name in ("src/console-server.mjs", "web/dist/index.html", "node_modules/jsdom/package.json",
                 "package.json", "package-lock.json", "requirements.txt"):
        if not (root / name).is_file():
            raise ValueError("Required runtime file missing: " + name)
    return metadata


def extract(archive, destination, revision):
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Extraction destination must be empty")
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not name.parts:
                raise ValueError("Unsafe archive member")
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError("Unsupported archive member")
        tar.extractall(destination, filter="data")
    metadata = verify(destination, revision)
    for path in destination.rglob("*"):
        if path.is_symlink():
            continue
        executable = metadata["files"].get(path.relative_to(destination).as_posix(), {}).get("executable")
        path.chmod(0o755 if path.is_dir() or executable else 0o644)
    destination.chmod(0o755)
    return metadata


def build(source, output, revision):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Full commit SHA required")
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64"):
        raise ValueError("Runtime bundles must be built on Linux x64")
    major = subprocess.check_output(["node", "-p", "process.versions.node.split('.')[0]"], text=True).strip()
    if major != "22":
        raise ValueError("Node 22 required")
    output.mkdir(parents=True, exist_ok=True)
    stage = output / "bundle"
    stage.mkdir()
    try:
        for name in ROOTS:
            src, dst = source / name, stage / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                shutil.copytree(src, dst, symlinks=True)
            else:
                shutil.copy2(src, dst)
        metadata = {"schema": 1, "revision": revision, "platform": "linux-x64", "node_major": 22,
                    "files": inventory(stage)}
        (stage / "release.json").write_text(json.dumps(metadata, sort_keys=True) + "\n")
        verify(stage, revision)
        archive = output / ASSET
        with tarfile.open(archive, "w:gz", compresslevel=1) as tar:
            for path in sorted(stage.iterdir()):
                tar.add(path, arcname=path.name)
        smoke = output / "runtime-smoke"
        try:
            extract(archive, smoke, revision)
            subprocess.run(["node", str(source / "test/production-console-smoke.mjs")], cwd=smoke, check=True)
        finally:
            if smoke.exists():
                shutil.rmtree(smoke)
        (output / "SHA256SUMS").write_text(f"{digest(archive)}  {ASSET}\n")
        print(f"BUNDLE_OK revision={revision} files={len(metadata['files'])} asset={ASSET}")
    finally:
        shutil.rmtree(stage)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    build(args.source.resolve(), args.output.resolve(), args.revision)
