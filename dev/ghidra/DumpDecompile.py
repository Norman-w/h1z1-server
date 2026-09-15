# 打印指定函数的更长反编译窗口，可按行范围导出，也可按关键字命中自动扩窗。
# 用法：
#   PyGhidraCli DumpDecompile 0x14051a900
#   PyGhidraCli DumpDecompile 0x14051a900 1 500
#   PyGhidraCli DumpDecompile 0x14051a900 DAT_142b249a8 25 300 3
#
# 规则：
#   - 单参数：输出前 DEFAULT_SINGLE_MAX 行（默认 2000，超长函数可分段用 startLine lineCount）
#   - 第二参数为整数：视为 startLine，第三参数为 lineCount（默认 1500）
#   - 第二参数非整数：视为 needle，第三/四/五参数为 before/after/maxHits（after 默认 300）
#   - 末尾加 "resolve" 或 "--resolve-refs"：在输出末尾追加「引用解析」附录（DAT_/PTR_ 地址→字符串或符号名）
DEFAULT_SINGLE_MAX = 2000
DEFAULT_LINE_COUNT = 1500
DEFAULT_NEEDLE_AFTER = 300

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


def parse_int(value):
    try:
        return int(value)
    except Exception:
        return None


def print_lines(lines, start_idx, end_idx, highlight_idx=None):
    start_idx = max(0, start_idx)
    end_idx = min(len(lines), end_idx)
    for idx in range(start_idx, end_idx):
        prefix = '>' if highlight_idx is not None and idx == highlight_idx else ' '
        print('%s%4d %s' % (prefix, idx + 1, lines[idx]))


def collect_ref_addresses_from_lines(lines, start_idx, end_idx):
    """从反编译行中收集 DAT_/PTR_ 后的十六进制地址（用于解析附录）。"""
    import re
    seen = set()
    # DAT_142b199d8, PTR_FUN_1420c1678, LAB_14... 等，取 0x14 开头的 8+ 位十六进制
    for i in range(max(0, start_idx), min(len(lines), end_idx)):
        for m in re.finditer(r'(?:DAT_|PTR_[A-Za-z_]*|LAB_)([0-9a-fA-F]{8,})\b', lines[i]):
            hexstr = m.group(1)
            if len(hexstr) <= 16 and (hexstr.startswith('14') or hexstr.startswith('0')):
                try:
                    va = int(hexstr, 16)
                    if 0x140000000 <= va <= 0x14ffffffff or 0 < va < 0x100000000:
                        seen.add(va)
                except ValueError:
                    pass
    return sorted(seen)


def resolve_refs_appendix(prog, addr_list, max_entries=200):
    """对地址列表查询符号/字符串，输出附录（不修改 C 正文）。"""
    if not addr_list:
        return
    factory = prog.getAddressFactory()
    space = factory.getDefaultAddressSpace()
    listing = prog.getListing()
    out = []
    for va in addr_list[:max_entries]:
        try:
            addr = space.getAddress(va)
        except Exception:
            continue
        sym = prog.getSymbolTable().getPrimarySymbol(addr)
        data = listing.getDataAt(addr)
        line = None
        if sym and sym.getName() and not sym.getName().startswith(('DAT_', 'PTR_', 'LAB_', 'FUN_14')):
            line = '  0x%x  =>  symbol: %s' % (va, sym.getName())
        if data:
            try:
                dt = data.getDataType()
                if dt and 'String' in dt.getName():
                    raw = data.getValue()
                    if raw is not None:
                        s = str(raw)[:120] + ('...' if len(str(raw)) > 120 else '')
                        line = (line + '  |  string: ' + repr(s)) if line else ('  0x%x  =>  string: ' % va + repr(s))
            except Exception:
                pass
        if line:
            out.append(line)
    if not out:
        return
    print('')
    print('--- Resolved refs (address => symbol or string) ---')
    for line in out:
        print(line)


def main():
    import os

    prog = get_program()
    if prog is None:
        print('No program loaded.')
        return

    args = list(getScriptArgs())
    if len(args) < 1:
        env_args = (os.environ.get('GHIDRA_SCRIPT_ARGS') or '').strip()
        if env_args:
            args = env_args.split()
    if len(args) < 1:
        print('Usage: DumpDecompile <address> [startLine lineCount] | [needle before after maxHits] [resolve]')
        return

    do_resolve = False
    if args and (args[-1] == 'resolve' or args[-1] == '--resolve-refs'):
        do_resolve = True
        args = args[:-1]

    addr = to_addr(prog, args[0])
    func = getFunctionContaining(addr)
    if func is None:
        print('No containing function for', addr)
        return

    ifc = DecompInterface()
    ifc.openProgram(prog)
    res = ifc.decompileFunction(func, 120, monitor)
    if not res.decompileCompleted():
        print('Decompile failed.')
        return

    lines = res.getDecompiledFunction().getC().splitlines()
    print('Function:', func.getName(), 'Entry:', func.getEntryPoint())
    print('TotalLines:', len(lines))

    if len(args) == 1:
        cap = min(len(lines), DEFAULT_SINGLE_MAX)
        print('Mode: range')
        print('Range: 1-%d' % cap)
        print_lines(lines, 0, cap)
        if do_resolve:
            addrs = collect_ref_addresses_from_lines(lines, 0, cap)
            resolve_refs_appendix(prog, addrs)
        return

    maybe_start = parse_int(args[1])
    if maybe_start is not None:
        start_line = max(1, maybe_start)
        line_count = DEFAULT_LINE_COUNT
        if len(args) >= 3:
            parsed_count = parse_int(args[2])
            if parsed_count is not None and parsed_count > 0:
                line_count = parsed_count
        start_idx = start_line - 1
        end_idx = start_idx + line_count
        print('Mode: range')
        print('Range: %d-%d' % (start_idx + 1, min(len(lines), end_idx)))
        print_lines(lines, start_idx, end_idx)
        if do_resolve:
            addrs = collect_ref_addresses_from_lines(lines, start_idx, end_idx)
            resolve_refs_appendix(prog, addrs)
        return

    needle = args[1]
    before = 20
    after = DEFAULT_NEEDLE_AFTER
    max_hits = 5
    if len(args) >= 3:
        parsed_before = parse_int(args[2])
        if parsed_before is not None and parsed_before >= 0:
            before = parsed_before
    if len(args) >= 4:
        parsed_after = parse_int(args[3])
        if parsed_after is not None and parsed_after >= 0:
            after = parsed_after
    if len(args) >= 5:
        parsed_hits = parse_int(args[4])
        if parsed_hits is not None and parsed_hits > 0:
            max_hits = parsed_hits

    hits = [idx for idx, line in enumerate(lines) if needle.lower() in line.lower()]
    print('Mode: needle')
    print('Needle:', needle)
    print('Hits:', len(hits))
    end_needle = 0
    for hit_idx in hits[:max_hits]:
        print('--- hit line %d ---' % (hit_idx + 1))
        print_lines(lines, hit_idx - before, hit_idx + after + 1, hit_idx)
        end_needle = max(end_needle, min(len(lines), hit_idx + after + 2))
    if do_resolve and hits:
        start_needle = max(0, hits[0] - before)
        end_needle = min(len(lines), end_needle)
        addrs = collect_ref_addresses_from_lines(lines, start_needle, end_needle)
        resolve_refs_appendix(prog, addrs)


if __name__ == '__main__':
    main()
