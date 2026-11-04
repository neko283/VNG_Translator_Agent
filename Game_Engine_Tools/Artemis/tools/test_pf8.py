"""Synthetic fixtures only; does not modify or require game assets."""
import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path

import pf8


def fixture(entries, encoding="cp932", plain=()):
    names = [name.encode(encoding) for name, _ in entries]
    index_size = 4 + sum(len(n) + 16 for n in names) + 4 + (len(names) + 1) * 8 + 4
    offset = 7 + index_size
    index = bytearray(struct.pack("<I", len(names)))
    size_offsets = []
    for raw, (_, content) in zip(names, entries):
        index.extend(struct.pack("<I", len(raw)))
        index.extend(raw)
        index.extend(struct.pack("<III", 0, offset, len(content)))
        size_offsets.append(7 + len(index) - 4 - 15)
        offset += len(content)
    count_offset = len(index)
    index.extend(struct.pack("<I", len(names) + 1))
    for size_offset in size_offsets:
        index.extend(struct.pack("<Q", size_offset))
    index.extend(struct.pack("<QI", 0, count_offset))
    key = hashlib.sha1(index).digest()
    payload = bytearray()
    for name, content in entries:
        # Independent fixture writer: no reuse of the tool's XOR implementation.
        payload.extend(content if name in plain else bytes(b ^ key[i % 20] for i, b in enumerate(content)))
    return b"pf8" + struct.pack("<I", len(index)) + index + payload


class PF8Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.archive = self.root / "test.pfs"

    def tearDown(self):
        self.temp.cleanup()

    def test_cp932_extraction_and_raw_path_preservation(self):
        content = '[sel_text text="挙手した"]\r\n'.encode("cp932")
        original = fixture([("scenario\\共通.txt", content), ("empty.txt", b"")])
        self.archive.write_bytes(original)
        result = pf8.extract(self.archive, self.root / "out", self.root / "manifest.json", "cp932")
        self.assertEqual(result["extracted_count"], 2)
        self.assertEqual((self.root / "out/scenario/共通.txt").read_bytes(), content)
        self.assertEqual(self.archive.read_bytes(), original)
        report = json.loads((self.root / "manifest.json").read_text())
        self.assertEqual(report["entries"][0]["name_bytes_hex"], "scenario\\共通.txt".encode("cp932").hex())
        self.assertEqual(report["entries"][0]["sha256"], hashlib.sha256(content).hexdigest())
        with self.assertRaises(ValueError):
            pf8.extract(self.archive, self.root / "out", self.root / "another.json", "cp932")

    def test_utf8_filter_and_chunk_boundary(self):
        content = bytes(range(256)) * 4100
        self.archive.write_bytes(fixture([("脚本/正文.txt", content), ("other.txt", b"skip")], "utf-8"))
        pf8.extract(self.archive, self.root / "out", self.root / "m.json", "utf-8", ["脚本/*"])
        self.assertEqual((self.root / "out/脚本/正文.txt").read_bytes(), content)
        self.assertFalse((self.root / "out/other.txt").exists())

    def test_explicit_plain_entry(self):
        self.archive.write_bytes(fixture([("movie/test.mp4", b"plaintext")], plain=["movie/test.mp4"]))
        pf8.extract(self.archive, self.root / "out", self.root / "m.json", "cp932", plain_patterns=["*.mp4"])
        self.assertEqual((self.root / "out/movie/test.mp4").read_bytes(), b"plaintext")

    def test_pack_roundtrip_modified_and_added_resources(self):
        self.archive.write_bytes(fixture([("scenario\\日本.txt", b"old"), ("movie/a.mp4", b"plain")], plain=["movie/a.mp4"]))
        src, manifest = self.root / "src", self.root / "m.json"
        pf8.extract(self.archive, src, manifest, "cp932", plain_patterns=["*.mp4"])
        unchanged = self.root / "same.pfs"
        pf8.pack(src, manifest, unchanged)
        self.assertEqual(unchanged.read_bytes(), self.archive.read_bytes())
        (src / "scenario/日本.txt").write_bytes(b"longer translated content")
        (src / "font.ttf").write_bytes(bytes(range(256))*5000)
        patched = self.root / "patched.pfs"
        with self.assertRaises(ValueError):
            pf8.pack(src, manifest, patched)
        pf8.pack(src, manifest, patched, ["font.ttf"])
        pf8.extract(patched, self.root / "verify", self.root / "v.json", "cp932", plain_patterns=["*.mp4"])
        for f in src.rglob("*"):
            if f.is_file():
                self.assertEqual(f.read_bytes(), (self.root / "verify" / f.relative_to(src)).read_bytes())
        with self.assertRaises(FileExistsError):
            pf8.pack(src, manifest, patched, ["font.ttf"])

    def test_pack_rejects_partial_and_symlink_escape(self):
        self.archive.write_bytes(fixture([("a.txt", b"a"), ("b.txt", b"b")]))
        pf8.extract(self.archive, self.root / "partial", self.root / "part.json", "cp932", ["a.txt"])
        with self.assertRaises(ValueError):
            pf8.pack(self.root / "partial", self.root / "part.json", self.root / "p.pfs")
        pf8.extract(self.archive, self.root / "all", self.root / "all.json", "cp932")
        (self.root / "outside.txt").write_bytes(b"secret")
        (self.root / "all/link.txt").symlink_to(self.root / "outside.txt")
        with self.assertRaises(ValueError):
            pf8.pack(self.root / "all", self.root / "all.json", self.root / "p.pfs", ["link.txt"])

    def test_reject_paths_and_collisions(self):
        for entries in [[("../outside", b"x")], [("/absolute", b"x")], [("C:\\file", b"x")],
                        [("a.txt", b"a"), ("A.txt", b"b")], [("a", b"a"), ("a/b", b"b")]]:
            with self.subTest(entries=entries):
                self.archive.write_bytes(fixture(entries))
                with self.assertRaises(ValueError):
                    pf8.read_index(self.archive, "cp932")

    def test_reject_bad_headers_encoding_and_offsets(self):
        for data in [b"pf6", b"pf8" + struct.pack("<I", 999999), fixture([("日本.txt", b"x")])[:-1]]:
            self.archive.write_bytes(data)
            with self.assertRaises(ValueError):
                pf8.read_index(self.archive, "cp932")
        self.archive.write_bytes(fixture([("日本.txt", b"x")]))
        with self.assertRaises(UnicodeDecodeError):
            pf8.read_index(self.archive, "utf-8")


if __name__ == "__main__":
    unittest.main()
