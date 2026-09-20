#!/usr/bin/env python3
"""Read the NvParameterized collision assets used by the 2016 animals.

The client ships these files with an ``.apx`` suffix, but the payload is the
binary NvParameterized/APB layout (the header magic is ``5a 5b 5c 5d``).  The
tool intentionally stops at the collision-resource boundary.  It does not
turn the body capsules into a melee reach or damage rule: the native animal
attack graph/weapon contact shape is a separate resource and still needs its
own runtime proof.

The H1Z1 files use the VcWin64 target ABI.  Values in the data section are
little-endian target values; the canonical file header is big-endian.  The
parser only depends on the stable object-header and reference layout from
NvParameterized and validates every offset before following it.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path
from typing import Any, Iterable


MAGIC = 0x5A5B5C5D
HEADER_WORDS = 16
HEADER_SIZE = HEADER_WORDS * 4
PTR_SIZE = 8
OBJECT_HEADER_REL_MIN = 0x20
OBJECT_HEADER_DATA_PADDING = 72  # 8 pointers + 3 bools, aligned to 8
MODEL_COLLISION = "ModelCollision"
CAPSULE_CLASS = "DynamicSystemCapsuleShapeParams"
SPHERE_CLASS = "DynamicSystemSphereShapeParams"


class ParseError(ValueError):
    """The file is not a supported H1Z1 NvParameterized asset."""


class ApbFile:
    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        if len(self.data) < HEADER_SIZE:
            raise ParseError(f"file too short for header: {path}")

        header = struct.unpack_from(">16I", self.data, 0)
        if header[0] != MAGIC:
            raise ParseError(f"bad APB magic in {path}: 0x{header[0]:08x}")
        if header[1] != 0:
            raise ParseError(f"unsupported binary type {header[1]} in {path}")
        if header[3] < 1:
            raise ParseError(f"asset has no root objects: {path}")

        self.version = header[2]
        self.num_objects = header[3]
        self.file_length = header[4]
        self.dict_offset = header[5]
        self.data_offset = header[6]
        self.reloc_offset = header[7]
        self.metadata_offset = header[8]
        self.arch_type = header[9]
        self.compiler_type = header[10]
        self.compiler_version = header[11]
        self.os_type = header[12]
        self.num_metadata = header[14]
        self.alignment = header[15]

        if self.file_length != len(self.data):
            raise ParseError(
                f"header fileLength={self.file_length} != bytes={len(self.data)}"
            )
        for label, offset in (
            ("dict", self.dict_offset),
            ("data", self.data_offset),
            ("reloc", self.reloc_offset),
        ):
            if not 0 <= offset < self.file_length:
                raise ParseError(f"{label} offset outside file: {offset}")

        # The dictionary is NUL-delimited and uses absolute file offsets.  A
        # bounded lookup avoids treating arbitrary binary bytes as strings.
        self._string_cache: dict[int, str | None] = {}

    def u32(self, offset: int) -> int:
        self._check(offset, 4)
        return struct.unpack_from("<I", self.data, offset)[0]

    def u64(self, offset: int) -> int:
        self._check(offset, 8)
        return struct.unpack_from("<Q", self.data, offset)[0]

    def f32(self, offset: int) -> float:
        self._check(offset, 4)
        return struct.unpack_from("<f", self.data, offset)[0]

    def _check(self, offset: int, size: int) -> None:
        if offset < 0 or offset + size > self.file_length:
            raise ParseError(
                f"out-of-range read at 0x{offset:x} (+{size}) in {self.path}"
            )

    def string(self, offset: int) -> str | None:
        if offset == 0:
            return None
        if offset in self._string_cache:
            return self._string_cache[offset]
        if not self.dict_offset <= offset < self.data_offset:
            self._string_cache[offset] = None
            return None
        end = self.data.find(b"\0", offset, self.data_offset)
        if end < 0:
            self._string_cache[offset] = None
            return None
        raw = self.data[offset:end]
        if not raw or any(byte < 0x20 or byte >= 0x7F for byte in raw):
            self._string_cache[offset] = None
            return None
        value = raw.decode("ascii")
        self._string_cache[offset] = value
        return value

    def object_header(self, offset: int) -> dict[str, Any] | None:
        """Return an object header if *offset* has the expected shape."""

        if offset % 8 or offset < self.data_offset or offset + 48 > self.file_length:
            return None
        rel = self.u32(offset)
        class_offset = self.u64(offset + 8)
        name_offset = self.u64(offset + 16)
        class_name = self.string(class_offset)
        name = self.string(name_offset)
        if rel < OBJECT_HEADER_REL_MIN or not class_name:
            return None
        if offset + rel >= self.file_length:
            return None
        # readObjHeader aligns version/checksum fields exactly as the VcWin64
        # target does: bool at +24, version at +28, checksum size at +32,
        # checksum pointer at +40.
        is_included = self.data[offset + 24]
        version = self.u32(offset + 28)
        checksum_size = self.u32(offset + 32)
        checksum_offset = self.u64(offset + 40)
        if is_included not in (0, 1):
            return None
        if checksum_offset and checksum_offset >= self.file_length:
            return None
        data_offset = offset + rel
        fields_offset = data_offset + OBJECT_HEADER_DATA_PADDING
        if fields_offset > self.file_length:
            return None
        return {
            "offset": offset,
            "relativeDataOffset": rel,
            "className": class_name,
            "name": name,
            "isIncluded": bool(is_included),
            "version": version,
            "checksumSize": checksum_size,
            "checksumOffset": checksum_offset or None,
            "dataOffset": data_offset,
            "fieldsOffset": fields_offset,
        }

    def object_headers(self) -> list[dict[str, Any]]:
        """Find valid serialized objects without assuming module registrations."""

        found: list[dict[str, Any]] = []
        seen: set[int] = set()
        # Included references are 8-byte aligned in this ABI.  Scanning the
        # data/relocation section also finds nested module objects for which
        # the server does not have generated NvParameterized definitions.
        for offset in range(self.data_offset, self.reloc_offset, 8):
            header = self.object_header(offset)
            if header and offset not in seen:
                found.append(header)
                seen.add(offset)
        return found

    def root_table(self) -> list[dict[str, Any]]:
        roots: list[dict[str, Any]] = []
        cursor = self.data_offset
        for index in range(self.num_objects):
            object_offset = self.u64(cursor)
            class_offset = self.u64(cursor + 8)
            name_offset = self.u64(cursor + 16)
            filename_offset = self.u64(cursor + 24)
            header = self.object_header(object_offset)
            if not header:
                raise ParseError(
                    f"root {index} points to invalid object 0x{object_offset:x}"
                )
            roots.append(
                {
                    "index": index,
                    "objectOffset": object_offset,
                    "className": self.string(class_offset),
                    "name": self.string(name_offset),
                    "filename": self.string(filename_offset),
                    "header": header,
                }
            )
            cursor += 4 * PTR_SIZE
        return roots


def almost_ten(value: float) -> bool:
    return math.isfinite(value) and abs(value - 10.0) <= 1e-5


def read_c_string(asset: ApbFile, offset: int) -> str | None:
    return asset.string(asset.u64(offset))


def capsule_record(asset: ApbFile, record_offset: int) -> dict[str, Any]:
    capsule_offset = asset.u64(record_offset + 0x68)
    capsule = asset.object_header(capsule_offset)
    if not capsule or capsule["className"] not in (CAPSULE_CLASS, SPHERE_CLASS):
        raise ParseError(
            f"record 0x{record_offset:x} does not reference a supported body shape"
        )

    values = [asset.f32(capsule["fieldsOffset"] + index * 4) for index in range(10)]
    if not all(math.isfinite(value) for value in values):
        raise ParseError(f"non-finite capsule fields at 0x{capsule_offset:x}")

    shape_class = capsule["className"]
    is_capsule = shape_class == CAPSULE_CLASS
    return {
        "recordOffset": record_offset,
        "shapeKindRaw": asset.u32(record_offset),
        "shapeScaleRaw": asset.f32(record_offset + 4),
        "shapeClass": shape_class,
        "capsuleObjectOffset": capsule_offset,
        "capsuleFieldsOffset": capsule["fieldsOffset"],
        # These are the first two fields in the native capsule parameter
        # object.  Keep the explicit candidate wording until the game's
        # DynamicSystem schema is recovered; do not use them as combat reach.
        "radiusCandidate": values[0],
        "heightCandidate": values[1] if is_capsule else None,
        "poseFieldsRaw": values[2:9] if is_capsule else values[1:8],
        "bone": read_c_string(asset, record_offset + 0x98),
        "parentBone": read_c_string(asset, record_offset + 0xA8),
        "jointObjectOffset": asset.u64(record_offset + 0x70),
    }


def extract_asset(path: Path) -> dict[str, Any]:
    asset = ApbFile(path)
    headers = asset.object_headers()
    model_headers = [h for h in headers if h["className"] == MODEL_COLLISION]
    if len(model_headers) != 1:
        raise ParseError(
            f"expected exactly one {MODEL_COLLISION}, found {len(model_headers)}"
        )
    model = model_headers[0]

    # ModelCollision stores a fixed-size array of 0xc8-byte records.  The
    # first two words (kind=1, scale=10) are stable across the four animal
    # assets; the stride is checked rather than assumed silently.
    first_record: int | None = None
    for offset in range(model["fieldsOffset"], min(asset.reloc_offset, model["fieldsOffset"] + 0x200), 8):
        if asset.u32(offset) == 1 and almost_ten(asset.f32(offset + 4)):
            first_record = offset
            break
    if first_record is None:
        raise ParseError(f"no collision record found in {path}")

    records: list[dict[str, Any]] = []
    record_offset = first_record
    while record_offset + 0xC8 <= asset.reloc_offset:
        if asset.u32(record_offset) != 1 or not almost_ten(asset.f32(record_offset + 4)):
            break
        records.append(capsule_record(asset, record_offset))
        record_offset += 0xC8

    if not records:
        raise ParseError(f"empty collision record array in {path}")
    if record_offset < asset.reloc_offset and asset.u32(record_offset) == 1 and almost_ten(asset.f32(record_offset + 4)):
        raise ParseError(f"collision record array is not contiguous at 0x{record_offset:x}")

    candidate_radii = [record["radiusCandidate"] for record in records]
    candidate_heights = [
        record["heightCandidate"]
        for record in records
        if record["heightCandidate"] is not None
    ]
    return {
        "file": str(path),
        "bytes": len(asset.data),
        "header": {
            "magic": f"0x{MAGIC:08x}",
            "version": asset.version,
            "numObjects": asset.num_objects,
            "dictOffset": asset.dict_offset,
            "dataOffset": asset.data_offset,
            "relocOffset": asset.reloc_offset,
            "targetAbi": {
                "archType": asset.arch_type,
                "compilerType": asset.compiler_type,
                "compilerVersion": asset.compiler_version,
                "osType": asset.os_type,
                "pointerBytes": PTR_SIZE,
                "alignment": asset.alignment,
            },
        },
        "rootObjects": asset.root_table(),
        "serializedObjectClassCounts": {
            class_name: sum(1 for header in headers if header["className"] == class_name)
            for class_name in sorted({header["className"] for header in headers})
        },
        "modelCollisionObjectOffset": model["offset"],
        "modelCollisionFieldsOffset": model["fieldsOffset"],
        "recordStride": 0xC8,
        "records": records,
        "summary": {
            "recordCount": len(records),
            "bones": [record["bone"] for record in records],
            "radiusCandidateRange": [min(candidate_radii), max(candidate_radii)],
            "heightCandidateRange": ([min(candidate_heights), max(candidate_heights)] if candidate_heights else None),
            "shapeClassCounts": {
                shape_class: sum(1 for record in records if record["shapeClass"] == shape_class)
                for shape_class in sorted({record["shapeClass"] for record in records})
            },
            "semanticStatus": "collision-capsule-data-recovered; melee-contact-shape-unverified",
        },
    }


def default_assets() -> list[Path]:
    return [
        Path("/mnt/d/WindowsOnly/Games/H1EMU_Client/Resources/Assets/unpacked") / name
        for name in (
            "Bear_Brown_COL.apx",
            "Wolf001_COL.apx",
            "Deer001_COL.apx",
            "Rabbit_Tan_COL.apx",
        )
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", nargs="*", type=Path, help="animal *_COL.apx files")
    parser.add_argument("--output", type=Path, help="write JSON instead of stdout")
    args = parser.parse_args()

    paths = args.assets or default_assets()
    results: list[dict[str, Any]] = []
    for path in paths:
        if not path.is_file():
            raise SystemExit(f"asset not found: {path}")
        results.append(extract_asset(path))

    payload = {"tool": "audit-animal-collision-apx", "assets": results}
    rendered = json.dumps(payload, indent=2, sort_keys=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
