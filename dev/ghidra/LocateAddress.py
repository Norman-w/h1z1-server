# 轻量版地址定位：仅输出所在函数、入口与入口 xref。
# 用法：PyGhidraCli LocateAddress 0x140bf0f84


def get_program():
    try:
        return currentProgram
    except NameError:
        return None


def to_addr(prog, va):
    if isinstance(va, str):
        va = va.strip()
        if va.startswith('0x') or va.startswith('0X'):
            va = int(va, 16)
        elif va.isdigit() and len(va) >= 8:
            va = int(va, 16)
        elif any(c in va.lower() for c in 'abcdef'):
            va = int(va, 16)
        else:
            va = int(va)
    return prog.getAddressFactory().getDefaultAddressSpace().getAddress(va)


def main():
    import os

    prog = get_program()
    if prog is None:
        print('No program loaded.')
        return

    args = [a.strip() for a in getScriptArgs() if a and a.strip()]
    if not args:
        env_args = (os.environ.get('GHIDRA_SCRIPT_ARGS') or '').strip()
        if env_args:
            args = env_args.split()
    addr_arg = args[0] if args else ''
    if not addr_arg:
        print('Usage: LocateAddress <address>')
        return

    try:
        addr = to_addr(prog, addr_arg)
    except Exception:
        print('Invalid address:', addr_arg)
        return

    func = getFunctionContaining(addr)
    print('Address:', addr)
    if func is None:
        print('No containing function.')
        return

    print('Function:', func.getName())
    print('Entry:', func.getEntryPoint())
    print('Signature:', func.getSignature())

    ref_mgr = prog.getReferenceManager()
    refs_to = list(ref_mgr.getReferencesTo(func.getEntryPoint()))
    print('Entry xrefs (%d):' % len(refs_to))
    for r in refs_to[:20]:
        print('  <- %s (%s)' % (r.getFromAddress(), r.getReferenceType()))
    if len(refs_to) > 20:
        print('  ... and %d more' % (len(refs_to) - 20))


if __name__ == '__main__':
    main()
