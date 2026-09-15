# 反编译指定函数，并按关键字打印命中行及上下文。
# 用法：
#   PyGhidraCli SearchDecompile 0x140511840 switch
#   PyGhidraCli SearchDecompile 0x140511840 140511680

from ghidra.app.decompiler import DecompInterface


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

    args = list(getScriptArgs())
    if len(args) < 2:
        env_args = (os.environ.get('GHIDRA_SCRIPT_ARGS') or '').strip()
        if env_args:
            args = env_args.split()
    if len(args) < 2:
        print('Usage: SearchDecompile <address> <needle> [contextLines]')
        return

    addr = to_addr(prog, args[0])
    context = 3
    if len(args) > 2:
        try:
            context = int(args[-1])
            needle = ' '.join(args[1:-1])
        except ValueError:
            needle = ' '.join(args[1:])
    else:
        needle = args[1]

    func = getFunctionContaining(addr)
    if func is None:
        print('No containing function for', addr)
        return

    print('Function:', func.getName(), 'Entry:', func.getEntryPoint())
    ifc = DecompInterface()
    ifc.openProgram(prog)
    res = ifc.decompileFunction(func, 90, monitor)
    if not res.decompileCompleted():
        print('Decompile failed.')
        return

    lines = res.getDecompiledFunction().getC().splitlines()
    hits = [i for i, line in enumerate(lines) if needle.lower() in line.lower()]
    print('Hits:', len(hits))
    for idx in hits[:40]:
        print('--- hit line', idx + 1, '---')
        start = max(0, idx - context)
        end = min(len(lines), idx + context + 1)
        for i in range(start, end):
            prefix = '>' if i == idx else ' '
            print('%s%4d %s' % (prefix, i + 1, lines[i]))


if __name__ == '__main__':
    main()
