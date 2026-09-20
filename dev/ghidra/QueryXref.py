# 按需查 xref：用 PyGhidra 打开工程后对给定地址做 getReferencesTo / getReferencesFrom，不依赖 refs.json。
# 若 to 某地址为 0 条：可能是 Ghidra 未建立数据引用，改用 ScanMemoryPattern.py（搜 qword/dword/both）。
# 用法（Ghidra GUI）：Script Args 填 "to 1420633d0" 或 "from 14162dcc0"
# 用法（headless/runner）：通过 getScriptArgs() 得到 ["to", "1420633d0"] 或 ["from", "14162dcc0"]；地址可带或不带 0x

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
        elif any(c in va.lower() for c in "abcdef"):
            va = int(va, 16)
        elif va.isdigit() and len(va) >= 8:
            va = int(va, 16)
        else:
            va = int(va, 10)
    return prog.getAddressFactory().getDefaultAddressSpace().getAddress(va)

def main():
    import os
    prog = get_program()
    if prog is None:
        print("No program loaded.")
        return
    args = getScriptArgs()
    if not args:
        env_args = (os.environ.get("GHIDRA_SCRIPT_ARGS") or "").strip()
        if env_args:
            args = env_args.split()
    if args and len(args) >= 2:
        mode = str(args[0]).strip().lower()
        addr_arg = str(args[1]).strip()
    else:
        mode = (os.environ.get("QUERY_XREF_MODE") or "").strip().lower()
        addr_arg = (os.environ.get("QUERY_XREF_ADDR") or "").strip()
    if not addr_arg or mode not in ("to", "from"):
        print("Usage: Script Args = to <address>  or  from <address>")
        print("   or env: QUERY_XREF_MODE=to QUERY_XREF_ADDR=1420633d0")
        return
    try:
        addr = to_addr(prog, addr_arg)
    except Exception as e:
        print("Invalid address: %s" % addr_arg)
        return
    ref_mgr = prog.getReferenceManager()
    if mode == "to":
        refs = list(ref_mgr.getReferencesTo(addr))
        print("xref-to %s (%d refs):" % (addr, len(refs)))
        for r in refs[:200]:
            print("  %s  <-  %s  (%s)" % (addr, r.getFromAddress(), r.getReferenceType()))
        if len(refs) > 200:
            print("  ... and %d more" % (len(refs) - 200))
    else:
        refs = list(ref_mgr.getReferencesFrom(addr))
        print("xref-from %s (%d refs):" % (addr, len(refs)))
        for r in refs[:200]:
            print("  %s  ->  %s  (%s)" % (addr, r.getToAddress(), r.getReferenceType()))
        if len(refs) > 200:
            print("  ... and %d more" % (len(refs) - 200))

if __name__ == "__main__":
    main()
