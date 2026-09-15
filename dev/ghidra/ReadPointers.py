import os


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
    prog = get_program()
    if prog is None:
        print("No program loaded.")
        return

    args = [a.strip() for a in getScriptArgs() if a and a.strip()]
    if not args:
        env_args = (os.environ.get("GHIDRA_SCRIPT_ARGS") or "").strip()
        if env_args:
            args = env_args.split()

    if len(args) < 1:
        print("Usage: ReadPointers <address> [count=16] [stride=8]")
        return

    addr_str = args[0]
    count = int(args[1]) if len(args) > 1 else 16
    stride = int(args[2]) if len(args) > 2 else 8

    start_addr = to_addr(prog, addr_str)
    listing = prog.getListing()
    sym_table = prog.getSymbolTable()
    ref_mgr = prog.getReferenceManager()

    print("Base: %s  Count: %d  Stride: %d" % (start_addr, count, stride))

    for i in range(count):
        offset = i * stride
        addr = start_addr.add(offset)
        cu = listing.getCodeUnitAt(addr)
        if cu is None:
            cu = listing.getCodeUnitContaining(addr)

        syms = list(sym_table.getSymbols(addr))
        sym_str = ""
        if syms:
            sym_str = " [%s]" % syms[0].getName()

        refs = list(ref_mgr.getReferencesFrom(addr))
        ref_str = ""
        if refs:
            targets = []
            for r in refs:
                t = r.getToAddress()
                t_syms = list(sym_table.getSymbols(t))
                if t_syms:
                    targets.append("%s (%s)" % (t, t_syms[0].getName()))
                else:
                    targets.append(str(t))
            ref_str = " -> " + ", ".join(targets)

        cu_str = ""
        if cu and cu.getAddress() == addr:
            cu_str = " | %s" % cu
        elif cu:
            cu_str = " | (within %s at %s)" % (cu, cu.getAddress())

        print("  +0x%03x [%s]:%s%s%s" % (offset, addr, sym_str, ref_str, cu_str))


if __name__ == "__main__":
    main()
