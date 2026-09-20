#!/usr/bin/env python3
"""Audit native animal animation names and source clip timing.

The unpacked ``AnimalsX64.mrn`` uses the 2016 resource packet layout.  Its
animation records are packet type ``0x0f`` and the adjacent file-name packet
contains the source ``.nsa``/``.xmd`` names.  This tool reads only the resource
metadata; it does not change the server's attack clock or claim that a source
clip is the clip selected by a live ``KnifeSlash`` graph event.

The important boundary is intentional: source duration is an asset fact,
while the network ``Character.PlayAnimation.unknownDword2`` value and the
runtime graph speed/selector still need live client correlation.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path
from typing import Any


MAGIC = 0x18
RESOURCE_FAMILY = 0x0A
HEADER_SIZE = 48
ANIMATION_PACKET_TYPE = 0x0F
FILE_NAMES_PACKET_TYPE = 0x0D


class MrnParseError(ValueError):
    """The file is not the supported 2016 animal MRN packet layout."""


class MrnFile:
    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        if len(self.data) < HEADER_SIZE:
            raise MrnParseError(f"file too short: {path}")

    def u32(self, offset: int) -> int:
        self.check(offset, 4)
        return struct.unpack_from("<I", self.data, offset)[0]

    def u64(self, offset: int) -> int:
        self.check(offset, 8)
        return struct.unpack_from("<Q", self.data, offset)[0]

    def f32(self, offset: int) -> float:
        self.check(offset, 4)
        return struct.unpack_from("<f", self.data, offset)[0]

    def check(self, offset: int, size: int) -> None:
        if offset < 0 or offset + size > len(self.data):
            raise MrnParseError(
                f"out-of-range read at 0x{offset:x} (+{size}) in {self.path}"
            )

    @staticmethod
    def align(offset: int, alignment: int) -> int:
        if alignment <= 0 or alignment & (alignment - 1):
            raise MrnParseError(f"invalid packet alignment {alignment}")
        return (offset + alignment - 1) & ~(alignment - 1)

    def packets(self) -> list[dict[str, int]]:
        packets: list[dict[str, int]] = []
        offset = 0
        while offset < len(self.data):
            self.check(offset, HEADER_SIZE)
            magic = self.u32(offset)
            family = self.u32(offset + 4)
            packet_type = self.u32(offset + 8)
            index = self.u32(offset + 12)
            length = self.u32(offset + 32)
            alignment = self.u32(offset + 40)
            if magic != MAGIC or family != RESOURCE_FAMILY:
                raise MrnParseError(
                    f"invalid packet header at 0x{offset:x}: "
                    f"magic=0x{magic:x}, family=0x{family:x}"
                )
            payload = offset + HEADER_SIZE
            if payload + length > len(self.data):
                raise MrnParseError(
                    f"packet at 0x{offset:x} exceeds file: length={length}"
                )
            packets.append(
                {
                    "offset": offset,
                    "payloadOffset": payload,
                    "packetType": packet_type,
                    "index": index,
                    "length": length,
                    "alignment": alignment,
                }
            )
            offset = self.align(payload + length, alignment)
        if offset != len(self.data):
            raise MrnParseError(
                f"packet walk ended at 0x{offset:x}, file has {len(self.data)} bytes"
            )
        return packets


def read_string_table(asset: MrnFile, table_offset: int) -> list[str]:
    """Read the new table shape: count/size + ids + offsets + string blob."""

    asset.check(table_offset, 32)
    count, string_size = struct.unpack_from("<II", asset.data, table_offset)
    ids_relative = asset.u64(table_offset + 8)
    offsets_relative = asset.u64(table_offset + 16)
    strings_relative = asset.u64(table_offset + 24)
    if count > 100000:
        raise MrnParseError(f"unreasonable string count {count}")

    ids_end = table_offset + ids_relative + count * 4
    offsets_end = table_offset + offsets_relative + count * 4
    strings_start = table_offset + strings_relative
    strings_end = strings_start + string_size
    asset.check(table_offset + ids_relative, count * 4)
    asset.check(table_offset + offsets_relative, count * 4)
    asset.check(strings_start, string_size)
    if ids_end > len(asset.data) or offsets_end > len(asset.data):
        raise MrnParseError("string table index array exceeds file")

    offsets = [
        struct.unpack_from("<I", asset.data, table_offset + offsets_relative + 4 * i)[0]
        for i in range(count)
    ]
    strings: list[str] = []
    for value in offsets:
        if value >= string_size:
            raise MrnParseError(f"string offset {value} >= data size {string_size}")
        start = strings_start + value
        end = asset.data.find(b"\0", start, strings_end)
        if end < 0:
            raise MrnParseError(f"unterminated string at 0x{start:x}")
        strings.append(asset.data[start:end].decode("utf-8", "replace"))
    return strings


def read_file_names(asset: MrnFile, packet: dict[str, int]) -> dict[str, list[str]]:
    base = packet["payloadOffset"]
    asset.check(base, 5 * 8)
    table_offsets = struct.unpack_from("<5Q", asset.data, base)
    names = [
        read_string_table(asset, base + relative)
        for relative in table_offsets[:4]
    ]
    labels = ("filenames", "filetypes", "sourceFilenames", "animationNames")
    return dict(zip(labels, names, strict=True))


def extract(path: Path) -> dict[str, Any]:
    asset = MrnFile(path)
    packets = asset.packets()
    file_packets = [
        packet for packet in packets if packet["packetType"] == FILE_NAMES_PACKET_TYPE
    ]
    if len(file_packets) != 1:
        raise MrnParseError(f"expected one file-name packet, found {len(file_packets)}")
    tables = read_file_names(asset, file_packets[0])
    names = tables["animationNames"]
    source_names = tables["sourceFilenames"]
    file_names = tables["filenames"]
    animation_packets = [
        packet for packet in packets if packet["packetType"] == ANIMATION_PACKET_TYPE
    ]
    if len(animation_packets) != len(names):
        raise MrnParseError(
            f"animation packet/name mismatch: {len(animation_packets)} != {len(names)}"
        )

    animations: list[dict[str, Any]] = []
    for packet in animation_packets:
        index = packet["index"]
        if index >= len(names):
            raise MrnParseError(f"animation index {index} outside name table")
        payload = packet["payloadOffset"]
        # The packet's common animation header stores source duration and
        # sample rate at +0x28/+0x2c.  These are source-clip facts, not the
        # server's Character.PlayAnimation timer.
        duration = asset.f32(payload + 0x28)
        framerate = asset.f32(payload + 0x2C)
        if not math.isfinite(duration) or duration < 0:
            raise MrnParseError(f"invalid duration for animation {index}: {duration}")
        if not math.isfinite(framerate) or framerate <= 0:
            raise MrnParseError(
                f"invalid framerate for animation {index}: {framerate}"
            )
        animations.append(
            {
                "index": index,
                "name": names[index],
                "sourceFilename": source_names[index],
                "resourceFilename": file_names[index],
                "durationSeconds": duration,
                "framerate": framerate,
                "packetOffset": packet["offset"],
                "packetLength": packet["length"],
            }
        )

    return {
        "file": str(path),
        "header": {
            "magic": f"0x{MAGIC:02x}",
            "resourceFamily": f"0x{RESOURCE_FAMILY:02x}",
            "headerBytes": HEADER_SIZE,
            "animationPacketType": f"0x{ANIMATION_PACKET_TYPE:02x}",
            "fileNamesPacketType": f"0x{FILE_NAMES_PACKET_TYPE:02x}",
        },
        "packetCount": len(packets),
        "animations": animations,
        "summary": {
            "animationCount": len(animations),
            "framerates": sorted({animation["framerate"] for animation in animations}),
            "semanticStatus": (
                "source-clip-duration-recovered; graph-selector-speed-and-live-contact-unverified"
            ),
        },
    }


def default_asset() -> Path:
    return Path(
        "/mnt/d/WindowsOnly/Games/H1EMU_Client/Resources/Assets/unpacked/AnimalsX64.mrn"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("asset", nargs="?", type=Path, default=default_asset())
    parser.add_argument("--output", type=Path, help="write JSON instead of stdout")
    args = parser.parse_args()
    if not args.asset.is_file():
        raise SystemExit(f"asset not found: {args.asset}")
    rendered = json.dumps(
        {"tool": "audit-animal-animation-mrn", "asset": extract(args.asset)},
        indent=2,
    ) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
