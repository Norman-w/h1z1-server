# Ghidra 脚本：把当前程序「解压」成可查询的结构化数据，写入 export/ 目录。
# 类似解压 zip：一次导出 symbols、refs、全部字符串、标量常量；之后用 CLI 按需查。
#
# 无头：analyzeHeadless ... -postScript ExportFull.py <outputDir>  (outputDir 填 analysis/client 即可)
# GUI：在 CodeBrowser 打开 H1Z1.exe 后，Window -> Script Manager -> 选 ExportFull.py -> 在 Script Args 填
#      输出目录绝对路径，例如 C:\Users\WS\CursorProjects\h1z1-server\scripts\ghidra\analysis\client -> Run

from ghidra.program.model.listing import Listing
from ghidra.program.model.symbol import RefType, SymbolType
from ghidra.program.model.mem import Memory
import os
import java.io.FileWriter as FileWriter

EXPORT_SUBDIR = "export"
# refs：0=不导出（改用 PyGhidra QueryXref 动态查）；正数=上限条数；无上限可设极大值如 999999999。
MAX_REFS_EXPORT = 0
MIN_STRING_LEN = 2
SCALAR_OPCODE_MIN = 0x0f00
SCALAR_OPCODE_MAX = 0x0ffff

def get_output_dir():
    args = getScriptArgs()
    if args and len(args) > 0:
        return args[0]
    # PyGhidra 运行时无 script args，从环境变量读（见 run_export_pyghidra.py）
    return os.environ.get("EXPORT_FULL_OUTPUT_DIR")

def escape(s):
    if s is None:
        return ""
    return str(s).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").replace("\r", " ")

def ensure_export_dir(base_dir):
    out = os.path.join(base_dir, EXPORT_SUBDIR)
    if not os.path.exists(out):
        os.makedirs(out)
    return out

def write_json_array(fpath, rows, row_to_json):
    f = FileWriter(fpath)
    f.write("[\n")
    for i, row in enumerate(rows):
        if i > 0:
            f.write(",\n")
        f.write("  " + row_to_json(row))
    f.write("\n]\n")
    f.close()

def main():
    prog = currentProgram
    if prog is None:
        print("No program loaded.")
        return
    base_dir = get_output_dir()
    if not base_dir:
        print("Usage: -postScript ExportFull.py <outputDir>  (e.g. analysis/client)")
        return
    export_dir = ensure_export_dir(base_dir)
    listing = prog.getListing()
    refMgr = prog.getReferenceManager()
    mem = prog.getMemory()
    symTable = prog.getSymbolTable()

    # 1) symbols.json - 全部符号，便于「按名查地址」
    symbols = []
    for sym in symTable.getAllSymbols(True):
        try:
            addr = sym.getAddress()
            name = sym.getName(True)
            if name and addr:
                symbols.append({"address": str(addr), "name": name, "type": str(sym.getSymbolType())})
        except:
            pass
    def sym_json(s):
        return '{"address":"%s","name":"%s","type":"%s"}' % (s["address"], escape(s["name"]), escape(s["type"]))
    write_json_array(os.path.join(export_dir, "symbols.json"), symbols, sym_json)
    print("Wrote symbols.json (%d entries)" % len(symbols))

    # 2) refs.json - 仅当 MAX_REFS_EXPORT > 0 时导出；0=不导出，用 PyGhidra 脚本 QueryXref 按需查。
    try:
        if MAX_REFS_EXPORT > 0:
            refs = []
            minAddr = prog.getMemory().getMinAddress()
            it = refMgr.getReferenceIterator(minAddr)
            while it.hasNext():
                r = it.next()
                refs.append({"from": str(r.getFromAddress()), "to": str(r.getToAddress()), "type": str(r.getReferenceType())})
                if len(refs) >= MAX_REFS_EXPORT:
                    break
            def ref_json(r):
                return '{"from":"%s","to":"%s","type":"%s"}' % (r["from"], r["to"], escape(r["type"]))
            write_json_array(os.path.join(export_dir, "refs.json"), refs, ref_json)
            print("Wrote refs.json (%d entries)" % len(refs))
        else:
            print("refs.json skipped (MAX_REFS_EXPORT=0). Use PyGhidra QueryXref for xref.)")
    except Exception as e:
        print("refs.json failed: %s" % str(e))

    # 3) data_strings.json - 全部已定义字符串（不按关键字过滤），想查什么就查什么
    try:
        strings = []
        it = listing.getDefinedData(True)
        while it.hasNext():
            data = it.next()
            try:
                if not data.hasStringValue():
                    continue
                val = data.getValue()
                if val is None or len(val) < MIN_STRING_LEN:
                    continue
                s = str(val).strip()
                addr = data.getAddress()
                refs_to = list(refMgr.getReferencesTo(addr))
                xrefs = [{"from": str(r.getFromAddress()), "type": str(r.getReferenceType())} for r in refs_to[:100]]
                strings.append({"address": str(addr), "string": s[:500], "xrefs": xrefs})
            except:
                pass
        def str_json(e):
            xref_str = ",".join(['{"from":"%s","type":"%s"}' % (escape(x["from"]), escape(x["type"])) for x in e["xrefs"]])
            return '{"address":"%s","string":"%s","xrefs":[%s]}' % (e["address"], escape(e["string"]), xref_str)
        write_json_array(os.path.join(export_dir, "data_strings.json"), strings, str_json)
        print("Wrote data_strings.json (%d entries)" % len(strings))
    except Exception as e:
        print("data_strings.json failed: %s" % str(e))

    # 4) data_scalars.json - 2/4 字节标量且值在 0x0f00..0x0ffff，便于按 opcode 查出现位置再 xref
    try:
        scalars = []
        it = listing.getDefinedData(True)
        while it.hasNext():
            data = it.next()
            try:
                size = data.getLength()
                addr = data.getAddress()
                if size == 2:
                    v = mem.getShort(addr) & 0xFFFF
                    if SCALAR_OPCODE_MIN <= v <= SCALAR_OPCODE_MAX:
                        scalars.append({"address": str(addr), "size": 2, "value": v, "hex": "0x%04x" % v})
                elif size >= 4:
                    v = mem.getInt(addr) & 0xFFFF
                    if SCALAR_OPCODE_MIN <= v <= SCALAR_OPCODE_MAX:
                        scalars.append({"address": str(addr), "size": 4, "value": v, "hex": "0x%04x" % v})
            except:
                pass
        def scalar_json(e):
            return '{"address":"%s","size":%d,"value":%d,"hex":"%s"}' % (e["address"], e["size"], e["value"], e["hex"])
        write_json_array(os.path.join(export_dir, "data_scalars.json"), scalars, scalar_json)
        print("Wrote data_scalars.json (%d entries)" % len(scalars))
    except Exception as e:
        print("data_scalars.json failed: %s" % str(e))

    print("Export done. Use: node scripts/ghidra/query.mjs <cmd> <args>")

if __name__ == "__main__":
    main()
