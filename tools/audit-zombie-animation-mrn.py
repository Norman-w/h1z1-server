#!/usr/bin/env python3
"""Read the x64 MRN animation names and source clocks used by Zombie001.

This is intentionally metadata-only.  It does not infer which graph leaf a
public Character.PlayAnimation event selects; that selector still requires
client-side correlation.  It exists so action-clock changes can cite the
actual resource packet instead of copying a compatibility constant.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path


HEADER_SIZE = 48
MAGICS = {0x18, 0x1A}
FAMILY = 0x0A
FILE_NAMES = {0x0D, 0x0E}
ANIMATION = {0x0F, 0x10}


def align(value: int, boundary: int) -> int:
    return (value + boundary - 1) & ~(boundary - 1)


def cstrings(data: bytes, start: int, size: int, count: int) -> list[str]:
    end = start + size
    result: list[str] = []
    cursor = start
    for _ in range(count):
        stop = data.find(b"\0", cursor, end)
        if stop < 0:
            raise ValueError("unterminated MRN string")
        result.append(data[cursor:stop].decode("utf-8", "replace"))
        cursor = stop + 1
    return result


def string_table(data: bytes, base: int) -> list[str]:
    count, size, offsets_rel, strings_rel = struct.unpack_from("<IIQQ", data, base)
    if count > 100000 or size > len(data):
        raise ValueError("invalid MRN string table")
    # Read the offsets as a structural check.  The strings are stored in the
    # same order and the offset table is not needed for the report.
    offsets_base = base + offsets_rel
    offsets = struct.unpack_from(f"<{count}I", data, offsets_base)
    strings_base = base + strings_rel
    values = cstrings(data, strings_base, size, count)
    for offset in offsets:
        if offset >= size:
            raise ValueError("MRN string offset outside string blob")
    return values


def read_file_names(data: bytes, payload: int) -> tuple[list[str], list[str], list[str], list[str]]:
    rels = struct.unpack_from("<5Q", data, payload)
    tables = [string_table(data, payload + relative) for relative in rels[:4]]
    return tables[0], tables[1], tables[2], tables[3]


def extract(path: Path) -> dict[str, object]:
    data = path.read_bytes()
    packets: list[dict[str, int]] = []
    cursor = 0
    while cursor + HEADER_SIZE <= len(data):
        magic, family, packet_type, index = struct.unpack_from("<IIII", data, cursor)
        if magic not in MAGICS or family != FAMILY:
            raise ValueError(f"bad MRN header at 0x{cursor:x}: {magic=:#x} {family=:#x}")
        length = struct.unpack_from("<I", data, cursor + 32)[0]
        # The 0x18 packet header has an extra four-byte field before its
        # alignment value; the x64 loader still aligns the payload to 16.
        packet_alignment = struct.unpack_from("<I", data, cursor + 40)[0]
        payload = cursor + HEADER_SIZE
        if payload + length > len(data):
            raise ValueError("MRN packet exceeds file")
        packets.append({
            "offset": cursor,
            "payload": payload,
            "packetType": packet_type,
            "index": index,
            "length": length,
            "alignment": packet_alignment,
        })
        cursor = align(payload + length, packet_alignment or 16)
        # The 0x06 skeleton packet's declared payload omits the eight-byte
        # tail consumed by the native loader (the next 0x18 header is at
        # aligned_end + 8).  Animation/file-name packets do not have this
        # legacy tail.
        if packet_type == 0x06:
            cursor += 8
    if cursor != len(data):
        raise ValueError(f"packet walk ended at 0x{cursor:x}, file has 0x{len(data):x}")

    file_packet = next(packet for packet in packets if packet["packetType"] in FILE_NAMES)
    filenames, filetypes, source_names, animation_names = read_file_names(
        data, file_packet["payload"]
    )
    animations: list[dict[str, object]] = []
    for packet in packets:
        if packet["packetType"] not in ANIMATION:
            continue
        index = packet["index"]
        payload = packet["payload"]
        # Type 0x0f records in the checked-in 0x18 resource put the source
        # duration/rate at +0x28/+0x2c.  The x64 packet variant is +0x20/+0x24.
        duration, framerate = struct.unpack_from("<ff", data, payload + 0x28)
        if not math.isfinite(duration) or duration < 0 or framerate <= 0:
            duration, framerate = struct.unpack_from("<ff", data, payload + 0x20)
        if not math.isfinite(duration) or duration < 0:
            raise ValueError(f"invalid duration for animation {index}: {duration}")
        animations.append({
            "index": index,
            "name": animation_names[index],
            "sourceFilename": source_names[index],
            "resourceFilename": filenames[index],
            "durationSeconds": duration,
            "framerate": framerate,
            "packetOffset": packet["offset"],
            "packetLength": packet["length"],
        })
    return {
        "file": str(path),
        "packetCount": len(packets),
        "animationCount": len(animations),
        "animations": animations,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("asset", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = json.dumps({"tool": "audit-zombie-animation-mrn", "asset": extract(args.asset)}, indent=2) + "\n"
    if args.output:
        args.output.write_text(result, encoding="utf-8")
    else:
        print(result, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
