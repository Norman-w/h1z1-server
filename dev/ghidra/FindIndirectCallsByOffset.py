# Scan the program for indirect CALL/JMP instructions whose memory operand uses a given displacement.
# Excludes CALL [0xABS] (absolute indir / IAT style) when searching for displacement 0 (vtable slot0).
# Usage:
#   PyGhidraScriptRunner FindIndirectCallsByOffset 0x618 0x140500000 0x140540000

MAX_SCAN_RANGE = 0x02000000  # 32MB safeguard against timeout-level scans
MAX_SCAN_SECONDS = 110       # Keep below daemon default timeout (120s)

def get_program():
    try:
        return currentProgram
    except NameError:
        return None


def parse_offset(text):
    value = (text or '').strip()
    if not value:
        raise ValueError('Missing offset')
    if value.startswith('0x') or value.startswith('0X'):
        return int(value, 16)
    if any(c in value.lower() for c in 'abcdef'):
        return int(value, 16)
    return int(value, 10)


def to_program_addr(prog, value):
    factory = prog.getAddressFactory()
    space = factory.getDefaultAddressSpace()
    return space.getAddress(value)


def _memory_operand_is_absolute_ptr(text):
    """True for CALL [0x140012345] style (IAT / abs indir) — not [REG+0] vtable slot0."""
    import re
    if not text:
        return False
    m = re.search(r'\[([^\]]+)\]', text)
    if not m:
        return False
    inner = m.group(1).strip()
    return re.fullmatch(r'0x[0-9a-f]+', inner, re.I) is not None


def _memory_operand_displacement_from_text(text):
    """Parse bracket memory op displacement: [REG+disp] / [REG + disp]. No trailing + => 0.
    Supports signed forms like [RSP + -0x8]. Avoids wanted==0 matching +0xb0."""
    import re
    if not text:
        return None
    m = re.search(r'\[([^\]]+)\]', text)
    if not m:
        return None
    inner = m.group(1).strip()
    if re.fullmatch(r'0x[0-9a-f]+', inner, re.I):
        return None
    # Index scale: R12 + RAX*8 + 0x10 — use last +term as displacement (MSVC style)
    plus_parts = list(re.finditer(
        r'\+\s*(-?\s*0x[0-9a-f]+|-?\s*\d+)\s*$', inner, re.I))
    if plus_parts:
        t = plus_parts[-1].group(1).replace(' ', '')
        if t.lower().startswith('0x'):
            return int(t, 16)
        if t.lower().startswith('-0x'):
            return int(t, 16)
        return int(t, 10)
    return 0


def operand_has_displacement(instr, operand_index, wanted):
    parsed = None
    try:
        text = instr.getDefaultOperandRepresentation(operand_index)
        if _memory_operand_is_absolute_ptr(text):
            return False
        parsed = _memory_operand_displacement_from_text(text)
    except Exception:
        pass
    if parsed is not None:
        return parsed == wanted
    # Fallback: Ghidra op objects (may be wrong for some encodings)
    objects = instr.getOpObjects(operand_index)
    for obj in objects:
        try:
            if hasattr(obj, 'getValue'):
                scalar = int(obj.getValue())
                if scalar == wanted:
                    return True
        except Exception:
            pass
    try:
        text = str(instr)
        parsed2 = _memory_operand_displacement_from_text(text)
        if parsed2 is not None:
            return parsed2 == wanted
    except Exception:
        pass
    return False


def looks_like_memory_indirect(instr, operand_index):
    try:
        ref_type = instr.getOperandRefType(operand_index)
        if ref_type is not None and ref_type.isIndirect():
            return True
    except Exception:
        pass
    try:
        text = instr.getDefaultOperandRepresentation(operand_index)
        if text and '[' in text and ']' in text:
            return True
    except Exception:
        pass
    try:
        text = str(instr)
        if text and '[' in text and ']' in text:
            return True
    except Exception:
        pass
    return False


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
        print('Usage: FindIndirectCallsByOffset <offset> <start_addr> <end_addr>')
        return

    wanted = parse_offset(args[0])
    start_addr = None
    end_addr = None

    if len(args) >= 2:
        start_addr = to_program_addr(prog, parse_offset(args[1]))
    if len(args) >= 3:
        end_addr = to_program_addr(prog, parse_offset(args[2]))

    if start_addr is None or end_addr is None:
        print('ERROR: start_addr and end_addr are required to avoid timeout-level full scans.')
        print('Usage: FindIndirectCallsByOffset <offset> <start_addr> <end_addr>')
        return

    if start_addr is not None and end_addr is not None and start_addr.compareTo(end_addr) > 0:
        print('ERROR: start_addr is greater than end_addr.')
        return

    start_value = start_addr.getOffset()
    end_value = end_addr.getOffset()
    span = end_value - start_value
    if span > MAX_SCAN_RANGE:
        print('ERROR: requested range too large (%s bytes); limit is %s bytes.' % (hex(span), hex(MAX_SCAN_RANGE)))
        print('Please split into smaller chunks and run multiple queries.')
        return

    # Sanity check: struct field offsets are normally a few KB at most.
    # Values >= 0x10000000 almost certainly look like full virtual addresses.
    if wanted >= 0x10000000:
        print('ERROR: 0x%x looks like a full virtual address, not a struct field offset.' % wanted)
        print('  This script searches for indirect CALL/JMP instructions whose memory operand')
        print('  has a displacement equal to the given value, e.g. CALL [rax + 0x618].')
        print('  Pass the displacement value (struct offset), not the target address.')
        print('Usage: FindIndirectCallsByOffset <displacement> [start_addr [end_addr]]')
        return
    if wanted > 0xFFFF:
        print('WARNING: 0x%x is unusually large for a struct offset (> 0xFFFF). Continuing anyway.' % wanted)

    listing = prog.getListing()
    instr = listing.getInstructions(start_addr, True)
    matches = []
    scan_started = time.time()
    scanned_count = 0

    while instr.hasNext():
        scanned_count += 1
        if scanned_count % 50000 == 0:
            elapsed = time.time() - scan_started
            if elapsed > MAX_SCAN_SECONDS:
                print('ERROR: scan exceeded %.1fs safety budget (elapsed %.1fs).' % (MAX_SCAN_SECONDS, elapsed))
                print('Please narrow the range and retry.')
                return

        ins = instr.next()
        if end_addr is not None and ins.getAddress().compareTo(end_addr) > 0:
            break
        mnemonic = ins.getMnemonicString().upper()
        if mnemonic not in ('CALL', 'JMP'):
            continue
        if ins.getNumOperands() < 1:
            continue
        if not looks_like_memory_indirect(ins, 0):
            continue
        if operand_has_displacement(ins, 0, wanted):
            func = getFunctionContaining(ins.getAddress())
            matches.append((ins.getAddress(), func.getEntryPoint() if func else None, func.getName() if func else None, str(ins)))

    print('Scanning range: %s .. %s' % (start_addr, end_addr))
    print('Indirect CALL/JMP with displacement %s (%d matches):' % (hex(wanted), len(matches)))
    for addr, entry, name, text in matches[:200]:
        if entry is not None:
            print('  %s  in %s @ %s  %s' % (addr, name, entry, text))
        else:
            print('  %s  %s' % (addr, text))
    if len(matches) > 200:
        print('  ... and %d more' % (len(matches) - 200))


if __name__ == '__main__':
    main()