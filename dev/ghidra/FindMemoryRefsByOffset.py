# Scan the program for instructions whose operand references a given displacement.
# Usage:
#   PyGhidraScriptRunner FindMemoryRefsByOffset 0x810 any 0x1404e0000 0x1404f0000
#   PyGhidraScriptRunner FindMemoryRefsByOffset 0x810 store 0x140500000 0x140520000


MAX_SCAN_RANGE = 0x02000000  # 32MB safeguard against whole-program timeout scans
MAX_SCAN_SECONDS = 110       # Keep below daemon default timeout (120s)


def get_program():
    try:
        return currentProgram
    except NameError:
        return None


def parse_int(text):
    value = (text or '').strip()
    if not value:
        raise ValueError('Missing integer value')
    if value.startswith(('0x', '0X')):
        return int(value, 16)
    if any(c in value.lower() for c in 'abcdef'):
        return int(value, 16)
    return int(value, 10)


def to_program_addr(prog, value):
    factory = prog.getAddressFactory()
    space = factory.getDefaultAddressSpace()
    return space.getAddress(value)


def operand_mentions_offset(instr, operand_index, wanted):
    import re

    objects = instr.getOpObjects(operand_index)
    for obj in objects:
        try:
            if hasattr(obj, 'getValue') and int(obj.getValue()) == wanted:
                return True
        except Exception:
            pass

    texts = []
    try:
        texts.append(instr.getDefaultOperandRepresentation(operand_index) or '')
    except Exception:
        pass

    for text in texts:
        lowered = text.lower()
        if '[' not in lowered or ']' not in lowered:
            continue
        for token in re.findall(r'0x[0-9a-f]+', lowered):
            try:
                if int(token, 16) == wanted:
                    return True
            except Exception:
                pass
        for token in re.findall(r'(?<![a-z0-9_])-?\d+', lowered):
            try:
                parsed = int(token, 10)
                if parsed == wanted or parsed == -wanted:
                    return True
            except Exception:
                pass
    return False


def classify_access(instr, operand_index):
    try:
        ref_type = instr.getOperandRefType(operand_index)
        if ref_type is not None:
            if ref_type.isWrite():
                return 'store'
            if ref_type.isRead():
                return 'load'
    except Exception:
        pass

    mnemonic = instr.getMnemonicString().upper()
    try:
        text = instr.getDefaultOperandRepresentation(operand_index)
    except Exception:
        text = ''
    if not text or '[' not in text:
        return 'unknown'

    if mnemonic in ('MOV', 'MOVUPS', 'MOVAPS', 'MOVDQU', 'MOVDQA', 'MOVSS', 'MOVSD', 'LEA', 'CMP', 'TEST'):
        if operand_index == 0:
            return 'store' if mnemonic not in ('CMP', 'TEST') else 'load'
        if operand_index == 1:
            return 'load'
    return 'unknown'


def main():
    import time

    prog = get_program()
    if prog is None:
        print('No program loaded.')
        return

    args = [a.strip() for a in getScriptArgs() if a and a.strip()]
    if not args:
        import os
        env_args = (os.environ.get('GHIDRA_SCRIPT_ARGS') or '').strip()
        if env_args:
            args = env_args.split()
    if not args:
        print('Usage: FindMemoryRefsByOffset <offset> [load|store|any] <start_addr> <end_addr>')
        return

    wanted = parse_int(args[0])
    mode = 'any'
    start_index = 1
    if len(args) >= 2 and args[1].lower() in ('load', 'store', 'any'):
        mode = args[1].lower()
        start_index = 2

    start_addr = None
    end_addr = None
    if len(args) > start_index:
        start_addr = to_program_addr(prog, parse_int(args[start_index]))
    if len(args) > start_index + 1:
        end_addr = to_program_addr(prog, parse_int(args[start_index + 1]))

    if start_addr is None or end_addr is None:
        print('ERROR: start_addr and end_addr are required to avoid timeout-level full scans.')
        print('Usage: FindMemoryRefsByOffset <offset> [load|store|any] <start_addr> <end_addr>')
        return

    if start_addr.compareTo(end_addr) > 0:
        print('ERROR: start_addr must be <= end_addr.')
        return

    start_value = start_addr.getOffset()
    end_value = end_addr.getOffset()
    span = end_value - start_value
    if span > MAX_SCAN_RANGE:
        print('ERROR: requested range too large (%s bytes); limit is %s bytes.' % (hex(span), hex(MAX_SCAN_RANGE)))
        print('Please split into smaller chunks and run multiple queries.')
        return

    listing = prog.getListing()
    instrs = listing.getInstructions(start_addr, True)
    matches = []
    scan_started = time.time()
    scanned_count = 0

    while instrs.hasNext():
        scanned_count += 1
        if scanned_count % 50000 == 0:
            elapsed = time.time() - scan_started
            if elapsed > MAX_SCAN_SECONDS:
                print('ERROR: scan exceeded %.1fs safety budget (elapsed %.1fs).' % (MAX_SCAN_SECONDS, elapsed))
                print('Please narrow the range and/or use mode=load|store instead of any.')
                return

        ins = instrs.next()
        if end_addr is not None and ins.getAddress().compareTo(end_addr) > 0:
            break
        for operand_index in range(ins.getNumOperands()):
            if not operand_mentions_offset(ins, operand_index, wanted):
                continue
            access = classify_access(ins, operand_index)
            if mode != 'any' and access != mode:
                continue
            func = getFunctionContaining(ins.getAddress())
            matches.append((ins.getAddress(), func.getEntryPoint() if func else None, func.getName() if func else None, access, str(ins)))
            break

    print('Scanning range: %s .. %s' % (start_addr, end_addr))
    print('Memory refs with displacement %s mode=%s (%d matches):' % (hex(wanted), mode, len(matches)))
    for addr, entry, name, access, text in matches[:200]:
        if entry is not None:
            print('  %s  in %s @ %s  [%s] %s' % (addr, name, entry, access, text))
        else:
            print('  %s  [%s] %s' % (addr, access, text))
    if len(matches) > 200:
        print('  ... and %d more' % (len(matches) - 200))


if __name__ == '__main__':
    main()
