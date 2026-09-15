# 在 Listing 指令文本上做子串 / 正则扫描，补 FindMemoryRefsByOffset（只认部分 Operand 字面量）对 LEA、[base+0xa3] 等的漏报。
#
# 用法：
#   FindListingPattern +0xa3 0x140400000 0x140600000
#   FindListingPattern +0xa3 0x140400000 0x140600000 500     # 最多 500 条
#   FindListingPattern /\\+0x0*a3\\]/ 0x1404e0000 0x140540000 300   # 正则（raw 字符串在 CLI 里按 runner 转义）
#
# env：GHIDRA_SCRIPT_ARGS="..."
#
# 注意：命中多含 RSP+RBP+局部栈，需人工筛「首参寄存器像 entity 指针」的项。

import os
import re
import time

MAX_RANGE = 0x02000000
MAX_SECONDS = 110


def get_program():
    try:
        return currentProgram
    except NameError:
        return None


def parse_int(text):
    text = (text or "").strip()
    if text.startswith(("0x", "0X")):
        return int(text, 16)
    if any(c in text.lower() for c in "abcdef"):
        return int(text, 16)
    return int(text, 10)


def to_addr(prog, value):
    return (
        prog.getAddressFactory()
        .getDefaultAddressSpace()
        .getAddress(parse_int(value))
    )


def instr_text(ins):
    parts = [ins.getMnemonicString()]
    for i in range(ins.getNumOperands()):
        try:
            parts.append(ins.getDefaultOperandRepresentation(i) or "")
        except Exception:
            parts.append("")
    return " ".join(parts)


def main():
    prog = get_program()
    if prog is None:
        print("No program loaded.")
        return

    args = [a.strip() for a in getScriptArgs() if a and a.strip()]
    if not args:
        env = (os.environ.get("GHIDRA_SCRIPT_ARGS") or "").strip()
        if env:
            args = env.split()
    if len(args) < 3:
        print(
            "Usage: FindListingPattern <needle|/regex/> <start_va> <end_va> [max_hits]"
        )
        return

    needle = args[0]
    start_a = to_addr(prog, args[1])
    end_a = to_addr(prog, args[2])
    max_hits = int(args[3]) if len(args) > 3 else 250
    max_hits = max(1, min(max_hits, 20000))

    use_re = len(needle) >= 2 and needle.startswith("/") and needle.endswith("/")
    if use_re:
        pat = re.compile(needle[1:-1])
        match_fn = lambda s: pat.search(s) is not None
    elif re.match(r"^0x[0-9a-fA-F]+$", needle):
        # 避免 "0xa3" 误匹配操作数里的 0xa30 / 0xa38
        pat = re.compile(re.escape(needle) + r"(?![0-9a-fA-F])")
        match_fn = lambda s: pat.search(s) is not None
    else:
        nlo = needle.lower()
        match_fn = lambda s: nlo in s.lower()

    if start_a.compareTo(end_a) > 0:
        print("start_va must be <= end_va")
        return
    span = end_a.getOffset() - start_a.getOffset()
    if span > MAX_RANGE:
        print("range too large: %s" % hex(span))
        return

    listing = prog.getListing()
    it = listing.getInstructions(start_a, True)
    hits = []
    t0 = time.time()
    scanned = 0
    while it.hasNext():
        scanned += 1
        if scanned % 50000 == 0 and time.time() - t0 > MAX_SECONDS:
            print("timeout safety stop")
            break
        ins = it.next()
        if ins.getAddress().compareTo(end_a) > 0:
            break
        text = instr_text(ins)
        if not match_fn(text):
            continue
        fn = getFunctionContaining(ins.getAddress())
        fn_name = fn.getName() if fn else "?"
        hits.append((ins.getAddress(), fn_name, text))
        if len(hits) >= max_hits:
            break

    print(
        "FindListingPattern range %s .. %s  needle=%s  (%d hits, cap %d, scanned ~%d ins)"
        % (start_a, end_a, needle, len(hits), max_hits, scanned)
    )
    for addr, fn_name, text in hits:
        print("  %s  [%s]  %s" % (addr, fn_name, text))


# Ghidra 头less 常见 `__name__ == "main"`；与 ScanMemoryPattern 一致，避免漏跑/双跑视 runner 而定
if __name__ in ("__main__", "main"):
    main()
