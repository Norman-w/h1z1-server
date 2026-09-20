# 在已加载映像里扫内存字节（对齐匹配），补 QueryXref 没有建的引用 / GUI Search Memory 的 CLI 版。
# 注：旧版曾误用 MemoryBlock.isEmpty()（API 不存在）。若 PyGhidra 仍报 isEmpty：守护进程在用缓存脚本，需重启。
#
# 典型：vtable 槽地址 getReferencesTo 为 0，但 .rdata 里可能有 RVA(4) 或 VA(8) 的立即数。
#
# 用法（Script Args 或 GHIDRA_SCRIPT_ARGS，空格分隔）：
#   8 1420c1f58              — 小端 QWORD == 0x1420c1f58
#   4 020c1f58               — 小端 DWORD（常是 PE 里相对 image base 的 RVA）
#   both 1420c1f58           — 同时搜 QWORD 与 (VA - imageBase) 的 DWORD
#   8 1420c1f58 max=800      — 最多打 800 条命中（默认 400）
#   8 1420c1f58 block=rdata     — 只在块名含 rdata 的段里搜（忽略大小写）
#
# env（可选）：
#   SCAN_MEM_WIDTH=8|4|both
#   SCAN_MEM_VALUE=1420c1f58
#   SCAN_MEM_MAX=400
#   SCAN_MEM_BLOCK=rdata

import os
import struct


CHUNK = 0x100000  # 1 MiB per read


def as_int(x):
    """Ghidra/Java 常返回非 int；统一成 Python int 避免 getAddress / 格式化崩掉。"""
    try:
        return int(x)
    except Exception:
        return int(str(x))


def find_aligned(hay, needle, align, base_off):
    """Yield absolute file offsets (base_off + i) for matches."""
    base_off = as_int(base_off)
    n = len(needle)
    if n == 0 or len(hay) < n:
        return
    limit = len(hay) - n
    i = 0
    while i <= limit:
        if hay[i : i + n] == needle:
            abs_off = base_off + i
            if abs_off % align == 0:
                yield abs_off
                i += align
            else:
                i += 1
        else:
            i += 1


def get_program():
    try:
        return currentProgram
    except NameError:
        return None


def parse_int(text):
    text = (text or "").strip()
    if not text:
        raise ValueError("empty")
    if text.startswith(("0x", "0X")):
        return int(text, 16)
    if any(c in text.lower() for c in "abcdef"):
        return int(text, 16)
    return int(text, 10)


def parse_kv_args(args, out):
    """Extract key=value from args list; returns new list without those tokens."""
    rest = []
    for a in args:
        if "=" in a:
            k, v = a.split("=", 1)
            k, v = k.strip().lower(), v.strip()
            if k == "max":
                out["max"] = int(v, 10)
            elif k == "block":
                out["block"] = v
            else:
                rest.append(a)
        else:
            rest.append(a)
    return rest


def main():
    prog = get_program()
    if prog is None:
        print("No program loaded.")
        return

    opts = {"max": 400, "block": ""}
    args = [a.strip() for a in getScriptArgs() if a and a.strip()]
    if not args:
        env = (os.environ.get("GHIDRA_SCRIPT_ARGS") or "").strip()
        if env:
            args = env.split()
    args = parse_kv_args(args, opts)

    if len(args) < 1:
        mode = (os.environ.get("SCAN_MEM_WIDTH") or "").strip().lower()
        val_s = (os.environ.get("SCAN_MEM_VALUE") or "").strip()
        if os.environ.get("SCAN_MEM_MAX"):
            opts["max"] = int(os.environ.get("SCAN_MEM_MAX"), 10)
        if os.environ.get("SCAN_MEM_BLOCK"):
            opts["block"] = os.environ.get("SCAN_MEM_BLOCK").strip()
        if mode and val_s:
            args = [mode, val_s]
        else:
            print(
                "Usage: ScanMemoryPattern <8|4|both> <hex_value> [max=N] [block=substr]"
            )
            return
    if len(args) < 2:
        print("Usage: ScanMemoryPattern <8|4|both> <hex_value> [max=N] [block=substr]")
        return

    mode = args[0].lower()
    value = parse_int(args[1])
    max_hits = max(1, min(opts["max"], 50000))
    block_filter = (opts.get("block") or "").lower()

    mem = prog.getMemory()
    space = prog.getAddressFactory().getDefaultAddressSpace()
    try:
        img_off = as_int(prog.getImageBase().getOffset())
    except Exception:
        img_off = 0

    patterns = []
    if mode in ("8", "qword", "64"):
        patterns.append(("qword", struct.pack("<Q", value & 0xFFFFFFFFFFFFFFFF), 8))
    elif mode in ("4", "dword", "32"):
        patterns.append(("dword", struct.pack("<I", value & 0xFFFFFFFF), 4))
    elif mode == "both":
        patterns.append(("qword", struct.pack("<Q", value & 0xFFFFFFFFFFFFFFFF), 8))
        rva = (value - img_off) & 0xFFFFFFFF
        patterns.append(("dword_rva", struct.pack("<I", rva), 4))
        print(
            "imageBase=0x%x  scan qword=0x%x  dword_rva=0x%x"
            % (as_int(img_off), as_int(value), as_int(rva))
        )
    else:
        print("First arg must be 8, 4, or both (got %s)" % mode)
        return

    total_printed = 0
    for pname, needle, align in patterns:
        if total_printed >= max_hits:
            break
        print("=== pattern %s (%d bytes) ===" % (pname, len(needle)))
        for block in mem.getBlocks():
            if block_filter and block_filter not in (block.getName() or "").lower():
                continue
            try:
                if block.getSize() <= 0:
                    continue
            except Exception:
                continue
            try:
                bstart = as_int(block.getStart().getOffset())
                bend = as_int(block.getEnd().getOffset())
            except Exception:
                continue
            # iterate chunks inside block
            overlap = max(0, len(needle) - 1)
            pos = bstart
            while pos <= bend and total_printed < max_hits:
                end = min(pos + CHUNK - 1, bend)
                size = as_int(end - pos + 1)
                if size < len(needle):
                    break
                buf = bytearray(size)
                try:
                    mem.getBytes(space.getAddress(as_int(pos)), buf)
                except Exception:
                    pos = end + 1 - overlap
                    if pos <= bstart:
                        pos = end + 1
                    continue
                for addr_off in find_aligned(buf, needle, align, pos):
                    addr_off = as_int(addr_off)
                    if addr_off < bstart or addr_off > bend - len(needle) + 1:
                        continue
                    hit_addr = space.getAddress(addr_off)
                    print("  %s  [%s]" % (hit_addr, block.getName()))
                    total_printed += 1
                    if total_printed >= max_hits:
                        break
                next_pos = end + 1 - overlap
                if next_pos <= pos:
                    next_pos = end + 1
                pos = next_pos
            if total_printed >= max_hits:
                break
        if total_printed >= max_hits:
            break

    print(
        "done, hits printed: %d (cap %d)"
        % (as_int(total_printed), as_int(max_hits))
    )


if __name__ in ("__main__", "main"):
    main()
