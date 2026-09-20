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
        print("Usage: ReadMemory <address> [count=32] [format=hex|dwords]")
        return

    addr_str = args[0]
    count = int(args[1]) if len(args) > 1 else 32
    fmt = args[2] if len(args) > 2 else "hex"

    addr = to_addr(prog, addr_str)
    mem = prog.getMemory()

    raw = bytearray(count)
    try:
        mem.getBytes(addr, raw)
    except Exception as e:
        print("Error reading %d bytes at %s: %s" % (count, addr, e))
        return

    print("Address: %s  Count: %d" % (addr, count))

    if fmt == "dwords":
        for i in range(0, count, 4):
            if i + 4 <= count:
                val = (raw[i] | (raw[i+1] << 8) | (raw[i+2] << 16) | (raw[i+3] << 24))
                print("  +0x%03x: 0x%08x (%d)" % (i, val, val))
    elif fmt == "qwords":
        for i in range(0, count, 8):
            if i + 8 <= count:
                lo = (raw[i] | (raw[i+1] << 8) | (raw[i+2] << 16) | (raw[i+3] << 24))
                hi = (raw[i+4] | (raw[i+5] << 8) | (raw[i+6] << 16) | (raw[i+7] << 24))
                val = lo | (hi << 32)
                print("  +0x%03x: 0x%016x" % (i, val))
    else:
        hex_str = " ".join("%02x" % b for b in raw)
        print("Hex: %s" % hex_str)
        for i in range(0, count, 4):
            if i + 4 <= count:
                val = (raw[i] | (raw[i+1] << 8) | (raw[i+2] << 16) | (raw[i+3] << 24))
                print("  +0x%03x: 0x%08x (%d)" % (i, val, val))

    listing = prog.getListing()
    cu = listing.getCodeUnitAt(addr)
    if cu:
        print("CodeUnit: %s" % cu)

    sym_table = prog.getSymbolTable()
    syms = list(sym_table.getSymbols(addr))
    if syms:
        print("Symbols at address:")
        for s in syms:
            print("  %s (%s)" % (s.getName(), s.getSymbolType()))


if __name__ == "__main__":
    main()
