#!/usr/bin/env python3
"""PF8 index inspection and extraction. Python 3.9+, standard library only.

No script execution or text transcoding. Repacking requires an extraction manifest.
Archive format references and validation scope are documented in ../README.md.
"""
import argparse
import fnmatch
import hashlib
import json
import struct
import sys
import unicodedata
from pathlib import Path

VERSION = "0.2.0"
MAX_INDEX = 64 * 1024 * 1024
CHUNK = 1024 * 1024


def normalized_path(name):
    name = name.replace("\\", "/")
    parts = name.split("/")
    if any(p in ("", ".", "..") or ":" in p or "\x00" in p for p in parts):
        raise ValueError("Unsafe archive path: " + repr(name))
    if any(any(ord(c) < 32 for c in p) or p.endswith((" ", ".")) for p in parts):
        raise ValueError("Unsupported archive path: " + repr(name))
    reserved = {"CON", "PRN", "AUX", "NUL"}
    reserved.update("COM" + str(i) for i in range(1, 10))
    reserved.update("LPT" + str(i) for i in range(1, 10))
    if any(p.split(".")[0].upper() in reserved for p in parts):
        raise ValueError("Reserved archive path: " + repr(name))
    return name


def read_index(archive, encoding):
    archive = Path(archive)
    archive_size = archive.stat().st_size
    with archive.open("rb") as stream:
        header = stream.read(7)
        if len(header) != 7 or header[:3] != b"pf8":
            raise ValueError("Only PF8 archives are supported")
        index_size = struct.unpack_from("<I", header, 3)[0]
        if not 4 <= index_size <= min(MAX_INDEX, archive_size - 7):
            raise ValueError("Invalid or oversized PF8 index")
        index = stream.read(index_size)
    count = struct.unpack_from("<I", index)[0]
    if count > (index_size - 4) // 17:
        raise ValueError("Invalid PF8 entry count")
    entries, seen, ranges = [], set(), []
    cursor = 4
    for _ in range(count):
        if cursor + 4 > len(index):
            raise ValueError("Truncated PF8 index")
        length = struct.unpack_from("<I", index, cursor)[0]
        cursor += 4
        if length == 0 or cursor + length + 12 > len(index):
            raise ValueError("Invalid PF8 filename length")
        raw_name = index[cursor:cursor + length]
        cursor += length
        reserved, offset, size = struct.unpack_from("<III", index, cursor)
        cursor += 12
        # Explicit encoding: never silently replace undecodable filename bytes.
        original_name = raw_name.decode(encoding, errors="strict")
        relative = normalized_path(original_name)
        identity = unicodedata.normalize("NFC", relative).casefold()
        if identity in seen:
            raise ValueError("Colliding archive paths: " + relative)
        seen.add(identity)
        if offset < 7 + index_size or offset + size > archive_size:
            raise ValueError("Entry outside data area: " + relative)
        if size:
            ranges.append((offset, offset + size))
        entries.append({"path": relative, "archive_name": original_name,
                        "name_bytes_hex": raw_name.hex(), "reserved": reserved,
                        "offset": offset, "size": size})
    for identity in seen:
        parts = identity.split("/")
        if any("/".join(parts[:i]) in seen for i in range(1, len(parts))):
            raise ValueError("File/directory path collision: " + identity)
    ranges.sort()
    if any(right[0] < left[1] for left, right in zip(ranges, ranges[1:])):
        raise ValueError("Overlapping data entries are not supported")
    return {"schema": 1, "tool_version": VERSION, "archive": str(archive.resolve()),
            "archive_size": archive_size, "magic": "pf8", "path_encoding": encoding,
            "index_size": index_size, "index_sha256": hashlib.sha256(index).hexdigest(),
            "entry_count": count, "entries": entries}, hashlib.sha1(index).digest()


def select_entries(entries, includes):
    if not includes:
        return entries
    return [e for e in entries if any(fnmatch.fnmatchcase(e["path"], p) for p in includes)]


def xor_data(data, key, position=0):
    return bytes(value ^ key[(position + i) % len(key)] for i, value in enumerate(data))


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def extract(archive, output, manifest, encoding, includes=(), plain_patterns=()):
    report, key = read_index(archive, encoding)
    entries = select_entries(report["entries"], includes)
    if not entries:
        raise ValueError("No matching entries; no files created")
    output, manifest = Path(output), Path(manifest)
    if output.exists() or output.is_symlink():
        raise ValueError("Output must be a new directory")
    if manifest.exists() or manifest.is_symlink():
        raise ValueError("Manifest already exists")
    if output.resolve() == manifest.resolve() or output.resolve() in manifest.resolve().parents:
        raise ValueError("Manifest must be outside the extracted resource directory")
    # The source is only ever opened for reading. Each extraction has its own root.
    output.mkdir(parents=True, exist_ok=False)
    report["archive_sha256"] = file_hash(archive)
    report["output"] = str(output.resolve())
    report["include_patterns"] = list(includes)
    report["plain_patterns"] = list(plain_patterns)
    report["entries"] = []
    with Path(archive).open("rb") as stream:
        for entry in entries:
            dest = output.joinpath(*entry["path"].split("/"))
            dest.parent.mkdir(parents=True, exist_ok=True)
            encrypted = not any(fnmatch.fnmatchcase(entry["path"], p) for p in plain_patterns)
            digest = hashlib.sha256()
            stream.seek(entry["offset"])
            position = 0
            with dest.open("xb") as target:
                while position < entry["size"]:
                    block = stream.read(min(CHUNK, entry["size"] - position))
                    if not block:
                        raise ValueError("Truncated archive while extracting " + entry["path"])
                    if encrypted:
                        block = xor_data(block, key, position)
                    target.write(block)
                    digest.update(block)
                    position += len(block)
            report["entries"].append(dict(entry, encrypted=encrypted, sha256=digest.hexdigest()))
    report["extracted_count"] = len(report["entries"])
    manifest.parent.mkdir(parents=True, exist_ok=True)
    with manifest.open("x", encoding="utf-8") as target:
        json.dump(report, target, ensure_ascii=False, indent=2)
        target.write("\n")
    return {"output": report["output"], "manifest": str(manifest.resolve()),
            "extracted_count": len(entries)}


def pack(source, manifest, output, additions=()):
    """Rebuild a PF8 with original name bytes, entry order and XOR policy.

    Physical offsets/padding are rebuilt; decoded resource bytes are preserved.
    New resources must be explicitly named. Never writes over an existing archive.
    """
    source, output = Path(source), Path(output)
    report = json.loads(Path(manifest).read_text(encoding="utf-8"))
    if report.get("include_patterns") or report.get("extracted_count") != report.get("entry_count"):
        raise ValueError("Packing requires a complete extraction manifest")
    entries = [dict(e) for e in report["entries"]]
    for name in additions:
        name = normalized_path(name)
        raw = name.replace("/", "\\").encode(report["path_encoding"])
        entries.append(dict(path=name, name_bytes_hex=raw.hex(), reserved=0, encrypted=True))
    seen, files, names = set(), [], []
    for entry in entries:
        name = normalized_path(entry["path"])
        identity = unicodedata.normalize("NFC", name).casefold()
        if identity in seen:
            raise ValueError("Colliding resource: " + name)
        seen.add(identity)
        raw = bytes.fromhex(entry["name_bytes_hex"])
        if normalized_path(raw.decode(report["path_encoding"])) != name:
            raise ValueError("Manifest raw path mismatch: " + name)
        path = source / name
        if not path.is_file() or source.resolve() not in path.resolve().parents:
            raise ValueError("Missing/outside source resource: " + name)
        if path.resolve() == output.resolve():
            raise ValueError("Output collides with a source resource")
        files.append(path)
        names.append(raw)
    actual = {p.relative_to(source).as_posix() for p in source.rglob("*") if p.is_file()}
    if actual != {e["path"] for e in entries}:
        raise ValueError("Source membership differs from manifest and explicit additions")
    index_size = 4 + sum(len(n) + 16 for n in names) + 4 + (len(names) + 1) * 8 + 4
    if index_size > MAX_INDEX:
        raise ValueError("Oversized index")
    offset = 7 + index_size
    index = bytearray(struct.pack("<I", len(entries)))
    footer_offsets = []
    for entry, raw, path in zip(entries, names, files):
        size = path.stat().st_size
        if offset + size > 0xffffffff:
            raise ValueError("PF8 exceeds 32-bit archive limit")
        index.extend(struct.pack("<I", len(raw)) + raw)
        index.extend(struct.pack("<III", entry["reserved"], offset, size))
        footer_offsets.append(len(index) - 12)
        offset += size
    footer_start = len(index)
    index.extend(struct.pack("<I", len(entries) + 1))
    for position in footer_offsets:
        index.extend(struct.pack("<Q", position))
    index.extend(struct.pack("<QI", 0, footer_start))
    key = hashlib.sha1(index).digest()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as target:
        target.write(b"pf8" + struct.pack("<I", len(index)) + index)
        for entry, path in zip(entries, files):
            position = 0
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(CHUNK), b""):
                    target.write(xor_data(block, key, position) if entry["encrypted"] else block)
                    position += len(block)
    read_index(output, report["path_encoding"])
    return dict(output=str(output.resolve()), entry_count=len(entries), sha256=file_hash(output))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=VERSION)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("list", "extract"):
        child = sub.add_parser(command)
        child.add_argument("archive", type=Path)
        child.add_argument("--encoding", required=True, choices=("cp932", "utf-8"),
                           help="Archive filename encoding, unrelated to script content encoding")
        child.add_argument("--include", action="append", default=[],
                           help="Repeatable glob over slash-separated paths; quote shell patterns")
        if command == "extract":
            child.add_argument("--output", required=True, type=Path)
            child.add_argument("--manifest", required=True, type=Path)
            child.add_argument("--plain-pattern", action="append", default=[],
                               help="Explicitly skip XOR for known plaintext entries only")
    child = sub.add_parser("pack")
    child.add_argument("source", type=Path)
    child.add_argument("--manifest", required=True, type=Path)
    child.add_argument("--output", required=True, type=Path)
    child.add_argument("--add", action="append", default=[])
    args = parser.parse_args()
    try:
        if args.command == "list":
            result, _ = read_index(args.archive, args.encoding)
            result["entries"] = select_entries(result["entries"], args.include)
            result["selected_count"] = len(result["entries"])
        elif args.command == "pack":
            result = pack(args.source, args.manifest, args.output, args.add)
        else:
            result = extract(args.archive, args.output, args.manifest, args.encoding,
                             args.include, args.plain_pattern)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
