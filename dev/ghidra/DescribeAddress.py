# 给定一个地址，输出所在函数、入口、若干调用关系与反编译片段。
# 用法：
#   PyGhidraCli DescribeAddress 0x140ac8735
#   PyGhidraCli DescribeAddress 14047819f

from ghidra.app.decompiler import DecompInterface


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
        env_args = (os.environ.get("GHIDRA_SCRIPT_ARGS") or "").strip()
        if env_args:
            args = env_args.split()

    if not args:
        print("Usage: DescribeAddress <address> [address2 ...]")
        return

    listing = prog.getListing()
    ifc = DecompInterface()
    ifc.openProgram(prog)

    for i, addr_arg in enumerate(args):
        if i > 0:
            print("\n" + "=" * 78)

        try:
            addr = to_addr(prog, addr_arg)
        except Exception:
            print("Invalid address:", addr_arg)
            continue

        func = getFunctionContaining(addr)
        if func is None:
            print("Address:", addr)
            print("No containing function.")
            code_unit = listing.getCodeUnitAt(addr)
            if code_unit:
                print("CodeUnit:", code_unit)
            continue

        print("Address:", addr)
        print("Function:", func.getName())
        print("Entry:", func.getEntryPoint())
        print("Signature:", func.getSignature())

        ref_mgr = prog.getReferenceManager()
        refs_to = list(ref_mgr.getReferencesTo(func.getEntryPoint()))
        print("Callers/Xrefs to entry (%d):" % len(refs_to))
        for r in refs_to[:20]:
            print("  <- %s (%s)" % (r.getFromAddress(), r.getReferenceType()))
        if len(refs_to) > 20:
            print("  ... and %d more" % (len(refs_to) - 20))

        print("\nInstructions around address:")
        instr = listing.getInstructionAt(addr)
        if instr is None:
            instr = listing.getInstructionBefore(addr)
        cur = instr
        before = []
        for _ in range(6):
            if cur is None:
                break
            before.append(cur)
            cur = cur.getPrevious()
        for ins in reversed(before):
            print("  %s  %s" % (ins.getAddress(), ins))
        cur = instr.getNext() if instr else None
        for _ in range(6):
            if cur is None:
                break
            print("  %s  %s" % (cur.getAddress(), cur))
            cur = cur.getNext()

        res = ifc.decompileFunction(func, 60, monitor)
        if not res.decompileCompleted():
            print("\nDecompile failed.")
            continue

        text = res.getDecompiledFunction().getC()
        lines = text.splitlines()
        max_decompile_lines = 800
        print("\nDecompiled (first %d lines):" % min(len(lines), max_decompile_lines))
        for line in lines[:max_decompile_lines]:
            print(line)
        if len(lines) > max_decompile_lines:
            print("  ... (%d more lines, use DumpDecompile for full)" % (len(lines) - max_decompile_lines))


if __name__ == "__main__":
    main()
