# 在指定 VA 前后打印若干条 Listing 指令（补 DescribeAddress 默认 ±6 条）。
# 用法：
#   PyGhidraCli DumpListingWindow 0x1405141A0 10 10
#   PyGhidraCli DumpListingWindow 1405141A0 12 8
#
# 参数：中心地址、向前条数、向后条数（中心指令行标 >>>）。

def get_program():
    try:
        return currentProgram
    except NameError:
        return None


def to_addr(prog, va):
    if isinstance(va, str):
        va = va.strip()
        if va.startswith("0x") or va.startswith("0X"):
            va = int(va, 16)
        elif va.isdigit() and len(va) >= 8:
            va = int(va, 16)
        elif any(c in va.lower() for c in "abcdef"):
            va = int(va, 16)
        else:
            va = int(va)
    return prog.getAddressFactory().getDefaultAddressSpace().getAddress(va)


def main():
    import os

    prog = get_program()
    if prog is None:
        print("No program loaded.")
        return

    args = [a.strip() for a in getScriptArgs() if a and a.strip()]
    if not args:
        env = (os.environ.get("GHIDRA_SCRIPT_ARGS") or "").strip()
        if env:
            args = env.split()
    if len(args) < 1:
        print("Usage: DumpListingWindow <address> [before_n] [after_n]")
        return

    try:
        center = to_addr(prog, args[0])
    except Exception:
        print("Invalid address:", args[0])
        return

    before_n = int(args[1]) if len(args) > 1 else 10
    after_n = int(args[2]) if len(args) > 2 else 10
    before_n = max(0, min(before_n, 200))
    after_n = max(0, min(after_n, 200))

    listing = prog.getListing()
    instr = listing.getInstructionAt(center)
    if instr is None:
        instr = listing.getInstructionBefore(center)
    if instr is None:
        print("No instruction at or before", center)
        return

    chain = []
    cur = instr
    for _ in range(before_n):
        prev = cur.getPrevious()
        if prev is None:
            break
        chain.append(prev)
        cur = prev
    chain.reverse()
    chain.append(instr)
    cur = instr
    for _ in range(after_n):
        nxt = cur.getNext()
        if nxt is None:
            break
        chain.append(nxt)
        cur = nxt

    func = getFunctionContaining(instr.getAddress())
    print(
        "DumpListingWindow center=%s before=%d after=%d containing=%s"
        % (instr.getAddress(), before_n, after_n, func.getName() if func else "?")
    )
    for ins in chain:
        mark = ">>>" if ins.getAddress() == instr.getAddress() else "   "
        print("%s %s  %s" % (mark, ins.getAddress(), ins))


if __name__ == "__main__":
    main()
