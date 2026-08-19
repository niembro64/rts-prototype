#!/usr/bin/env python3
"""Reject shipped assets that also exist in Beyond All Reason.

Assets may be copied freely from ``rts-prototype`` into this project, but only
when the asset originated there. Anything that is byte-identical to a file in
the Beyond All Reason game data is BAR content and may not ship here, no matter
which repository we picked it up from.

The audit runs in two modes:

``index mode`` (default)
    Compares every tracked asset against ``scripts/bar_asset_index.json.gz``, a
    checked-in digest of BAR filenames and content hashes. This needs no BAR
    checkout, so it runs fast, hermetically, in CI and on any workstation.

``live mode`` (``--bar-root``)
    Compares against a real Beyond All Reason checkout, re-hashing it from
    scratch. Slower, but authoritative. Add ``--refresh-index`` to rewrite the
    checked-in digest from that checkout, which is how the index stays current.

Two kinds of hit are reported:

``identical``
    Same content hash as a BAR file. This is BAR content and always fails.

``name``
    Same filename as a BAR file but different content. Usually a coincidence on
    a generic name, so it fails only until the path is acknowledged in
    ``scripts/bar_asset_allowlist.json`` with a reason.

This file is kept byte-identical in ``annihilation-plus-plus`` and
``rts-prototype`` so a single fix lands in both projects.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import subprocess
from pathlib import Path


INDEX_RELATIVE_PATH = "scripts/bar_asset_index.json.gz"
ALLOWLIST_RELATIVE_PATH = "scripts/bar_asset_allowlist.json"
INDEX_SCHEMA = 1

ASSET_SUFFIXES = {
    # Images and textures.
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tga", ".dds", ".ktx", ".ktx2",
    ".basis", ".webp", ".svg", ".ico", ".icns", ".psd", ".xcf",
    # Audio.
    ".ogg", ".wav", ".mp3", ".flac", ".aac", ".m4a", ".mid", ".midi",
    # Video.
    ".mp4", ".webm", ".mov", ".avi",
    # Fonts.
    ".ttf", ".otf", ".woff", ".woff2",
    # Models and animation.
    ".obj", ".fbx", ".dae", ".blend", ".glb", ".gltf", ".s3o", ".3do", ".atlas",
}

# Directories that never hold shipped source assets: dependency trees, build
# output, and generated capture galleries.
EXCLUDED_DIR_NAMES = {
    ".git",
    "node_modules",
    "dist",
    "release-output",
    "Testing",
    "CMakeFiles",
    "__pycache__",
    "target",
    ".tmp",
}
EXCLUDED_DIR_PREFIXES = ("build", "cmake-build")


def is_excluded(relative: str) -> bool:
    """Report whether a repo-relative path sits inside an excluded directory."""
    for part in Path(relative).parts[:-1]:
        if part in EXCLUDED_DIR_NAMES:
            return True
        if part.startswith(EXCLUDED_DIR_PREFIXES):
            return True
    return False


def is_asset(relative: str) -> bool:
    return Path(relative).suffix.lower() in ASSET_SUFFIXES


def tracked_files(root: Path) -> list[str]:
    """List git-tracked files, falling back to a filesystem walk."""
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            check=True,
            capture_output=True,
        )
        names = completed.stdout.decode("utf-8", "surrogateescape").split("\0")
        return [name for name in names if name]
    except (OSError, subprocess.CalledProcessError):
        return [
            path.relative_to(root).as_posix()
            for path in root.rglob("*")
            if path.is_file()
        ]


def asset_paths(root: Path) -> list[str]:
    """List repo-relative asset paths worth auditing, in stable order."""
    return sorted(
        relative
        for relative in tracked_files(root)
        if is_asset(relative)
        and not is_excluded(relative)
        and (root / relative).is_file()
    )


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# Directories every Beyond All Reason checkout has. Verifying these stops a
# mistyped --bar-root from pointing at our own tree, where every asset would
# "match" itself and the audit would report the whole repo as stolen.
BAR_MARKER_DIRS = ("gamedata", "luaui", "unitpics", "sounds")


def looks_like_bar_checkout(root: Path) -> bool:
    return all((root / name).is_dir() for name in BAR_MARKER_DIRS)


def resolve_bar_root(raw: Path | None) -> Path:
    """Validate an explicit --bar-root, failing loudly when it is not BAR."""
    if raw is None or not str(raw).strip():
        raise SystemExit(
            "BAR asset provenance audit: --bar-root needs a path to a Beyond "
            "All Reason checkout."
        )
    root = raw.resolve()
    if not root.is_dir():
        raise SystemExit(f"BAR asset provenance audit: {root} is not a directory.")
    if not looks_like_bar_checkout(root):
        raise SystemExit(
            f"BAR asset provenance audit: {root} does not look like a Beyond "
            f"All Reason checkout (expected {'/, '.join(BAR_MARKER_DIRS)}/)."
        )
    return root


def bar_commit(root: Path) -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
        )
        return completed.stdout.decode().strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def build_index(bar_root: Path) -> dict:
    """Digest a Beyond All Reason checkout into filename and hash lookups."""
    hashes: dict[str, str] = {}
    names: dict[str, str] = {}
    count = 0

    for relative in asset_paths(bar_root):
        count += 1
        digest = hash_file(bar_root / relative)
        # Keep the first path per hash/name purely so failures can name a
        # concrete BAR file to look at.
        hashes.setdefault(digest, relative)
        names.setdefault(Path(relative).name.lower(), relative)

    return {
        "schema": INDEX_SCHEMA,
        "source": "Beyond-All-Reason",
        "commit": bar_commit(bar_root),
        "asset_count": count,
        "hashes": hashes,
        "names": names,
    }


def write_index(index: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(index, indent=0, sort_keys=True).encode()
    # mtime=0 keeps the artifact reproducible across regenerations.
    with gzip.GzipFile(path, "wb", compresslevel=9, mtime=0) as handle:
        handle.write(payload)


def read_index(path: Path) -> dict:
    with gzip.open(path, "rb") as handle:
        index = json.load(handle)
    if index.get("schema") != INDEX_SCHEMA:
        raise SystemExit(
            f"{path}: unsupported index schema {index.get('schema')!r}; "
            f"expected {INDEX_SCHEMA}. Regenerate with --refresh-index."
        )
    return index


def read_allowlist(path: Path) -> dict[str, str]:
    """Map acknowledged repo-relative paths to their stated reason."""
    if not path.is_file():
        return {}
    entries = json.loads(path.read_text()).get("name_collisions", [])
    return {entry["path"]: entry.get("reason", "") for entry in entries}


def audit(repo_root: Path, index: dict, allowlist: dict[str, str]) -> tuple[list, list, list, int]:
    hashes = index["hashes"]
    names = index["names"]

    identical: list[tuple[str, str]] = []
    unacknowledged: list[tuple[str, str]] = []
    acknowledged: list[tuple[str, str]] = []
    checked = 0

    for relative in asset_paths(repo_root):
        checked += 1
        digest = hash_file(repo_root / relative)
        bar_match = hashes.get(digest)
        if bar_match is not None:
            identical.append((relative, bar_match))
            continue

        name_match = names.get(Path(relative).name.lower())
        if name_match is None:
            continue
        if relative in allowlist:
            acknowledged.append((relative, name_match))
        else:
            unacknowledged.append((relative, name_match))

    return identical, unacknowledged, acknowledged, checked


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".", type=Path)
    parser.add_argument(
        "--bar-root",
        type=Path,
        default=None,
        help="Compare against this Beyond All Reason checkout instead of the "
        "checked-in index. Authoritative but slow; the index is the default.",
    )
    parser.add_argument(
        "--refresh-index",
        action="store_true",
        help="Rewrite the checked-in index from --bar-root and exit. Defaults "
        "to the ../Beyond-All-Reason sibling checkout.",
    )
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    index_path = repo_root / INDEX_RELATIVE_PATH
    allowlist_path = repo_root / ALLOWLIST_RELATIVE_PATH

    if args.refresh_index:
        raw_root = args.bar_root
        if raw_root is None:
            raw_root = repo_root.parent / "Beyond-All-Reason"
        index = build_index(resolve_bar_root(raw_root))
        write_index(index, index_path)
        size_kib = index_path.stat().st_size / 1024
        print(
            f"BAR asset provenance index refreshed: {index['asset_count']} BAR "
            f"assets at commit {index['commit'][:12]} "
            f"-> {INDEX_RELATIVE_PATH} ({size_kib:.0f} KiB)."
        )
        return 0

    if args.bar_root is not None:
        bar_root = resolve_bar_root(args.bar_root)
        index = build_index(bar_root)
        source = f"live checkout {bar_root} @ {index['commit'][:12]}"
    elif index_path.is_file():
        index = read_index(index_path)
        source = f"index {INDEX_RELATIVE_PATH} @ {index['commit'][:12]}"
    else:
        print(
            f"BAR asset provenance audit: {INDEX_RELATIVE_PATH} is missing and "
            "no --bar-root was given; cannot verify asset provenance."
        )
        return 2

    allowlist = read_allowlist(allowlist_path)
    identical, unacknowledged, acknowledged, checked = audit(repo_root, index, allowlist)

    if identical or unacknowledged:
        print("BAR asset provenance audit failed:")
        for relative, bar_match in identical:
            print(f"- {relative}: byte-identical to BAR {bar_match}; remove or replace it.")
        for relative, bar_match in unacknowledged:
            print(
                f"- {relative}: shares a filename with BAR {bar_match}. Confirm "
                f"it is our own asset, then record it in {ALLOWLIST_RELATIVE_PATH}."
            )
        print(
            f"\nChecked {checked} assets against {index['asset_count']} BAR assets "
            f"({source})."
        )
        return 1

    count = len(acknowledged)
    plural = "" if count == 1 else "s"
    suffix = f", {count} acknowledged name collision{plural}" if acknowledged else ""
    print(
        f"BAR asset provenance audit passed: {checked} assets carry no Beyond All "
        f"Reason content ({source}; {index['asset_count']} BAR assets{suffix})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
