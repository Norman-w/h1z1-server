"""
FindString.py

Search defined data strings for a given needle and print address + xrefs.

Usage (Script Args): FindString <needle>
Or set env: FIND_STRING_NEEDLE

"""

def get_program():
    try:
        return currentProgram
    except NameError:
        return None


def to_str(s):
    try:
        return str(s)
    except:
        return s


def main():
    import os

    prog = get_program()
    if prog is None:
        print("No program loaded.")
        return

    args = list(getScriptArgs())
    if not args:
        env_args = (os.environ.get('GHIDRA_SCRIPT_ARGS') or os.environ.get('FIND_STRING_NEEDLE') or '').strip()
        if env_args:
            args = env_args.split()

    if not args:
        print('Usage: FindString <needle>')
        return

    needle = args[0].strip().lower()
    listing = prog.getListing()
    refMgr = prog.getReferenceManager()

    found = []
    it = listing.getDefinedData(True)
    while it.hasNext():
        data = it.next()
        try:
            if not data.hasStringValue():
                continue
            val = data.getValue()
            if val is None:
                continue
            s = to_str(val).strip()
            if needle in s.lower():
                addr = data.getAddress()
                refs_to = list(refMgr.getReferencesTo(addr))
                xrefs = [{'from': to_str(r.getFromAddress()), 'type': to_str(r.getReferenceType())} for r in refs_to]
                found.append({'address': str(addr), 'string': s, 'xrefs': xrefs})
        except Exception:
            pass

    print('Found %d matching strings for "%s"' % (len(found), needle))
    for f in found:
        print('---')
        print('addr:', f['address'])
        print('str :', f['string'])
        if f['xrefs']:
            print('xrefs:')
            for x in f['xrefs'][:200]:
                print('  from %s  (%s)' % (x['from'], x['type']))
        else:
            print('xrefs: none')


if __name__ == '__main__':
    main()
