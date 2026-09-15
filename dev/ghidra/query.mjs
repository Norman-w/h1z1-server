#!/usr/bin/env node
/**
 * CLI：对已导出的 symbols / data_strings / data_scalars 做查询，不依赖 Ghidra。
 * xref 改用 PyGhidra 按需查：python scripts/ghidra/run_query_xref.py to <地址> | from <地址>
 *
 * 用法:
 *   node scripts/ghidra/query.mjs symbol <名称或子串>
 *   node scripts/ghidra/query.mjs string <子串>
 *   node scripts/ghidra/query.mjs opcode <0x0fxx>
 */

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exportDir = join(__dirname, "analysis", "client", "export");
const serverDir = join(__dirname, "analysis", "server");

function loadJson(name, dir = exportDir) {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const cmd = process.argv[2];
const arg = process.argv[3];

if (!cmd || !arg) {
  console.log(`Usage: node scripts/ghidra/query.mjs <cmd> <arg>
  symbol <name>   - 符号名或子串
  string <substr> - 字符串内容子串
  opcode <0x0fxx> - 该值在 data_scalars 中的地址（xref 用 run_query_xref.py to <addr>）`);
  process.exit(1);
}

const symbols = loadJson("symbols.json");
const dataStrings = loadJson("data_strings.json");
const dataScalars = loadJson("data_scalars.json");
const serverOpcodes = loadJson("character_opcodes.json", serverDir);

const argLower = arg.toLowerCase();

switch (cmd) {
  case "symbol": {
    if (!symbols) {
      console.log("No export/symbols.json. Run headless with ExportFull.py first.");
      break;
    }
    const matches = symbols.filter((e) => (e.name || "").toLowerCase().includes(argLower));
    console.log("symbols (%d matches):", matches.length);
    matches.slice(0, 50).forEach((e) => console.log("  %s  %s  %s", e.address, e.type, e.name));
    if (matches.length > 50) console.log("  ... and %d more", matches.length - 50);
    break;
  }

  case "string": {
    if (!dataStrings) {
      console.log("No export/data_strings.json. Run headless with ExportFull.py first.");
      break;
    }
    const matches = dataStrings.filter((e) => (e.string || "").toLowerCase().includes(argLower));
    console.log("data_strings (%d matches):", matches.length);
    matches.slice(0, 30).forEach((e) => {
      console.log("  %s  %s", e.address, (e.string || "").slice(0, 70));
      (e.xrefs || []).slice(0, 5).forEach((r) => console.log("    <- %s  %s", r.from, r.type));
    });
    if (matches.length > 30) console.log("  ... and %d more", matches.length - 30);
    break;
  }

  case "opcode": {
    const hex = argLower.startsWith("0x") ? argLower : "0x" + argLower;
    let value = parseInt(hex, 16);
    if (isNaN(value)) {
      console.log("Invalid opcode:", arg);
      break;
    }
    if (serverOpcodes) {
      const nameEntry = serverOpcodes.find((e) => (e.hex || "").toLowerCase() === hex);
      if (nameEntry) console.log("server name: %s  %s", nameEntry.hex, nameEntry.name);
    }
    if (!dataScalars) {
      console.log("No export/data_scalars.json. Run headless with ExportFull.py first.");
      break;
    }
    const addrs = dataScalars.filter((s) => (s.value & 0xffff) === (value & 0xffff)).map((s) => s.address);
    console.log("opcode %s at %d address(es):", hex, addrs.length);
    addrs.slice(0, 30).forEach((a) => console.log("  %s", a));
    if (addrs.length > 30) console.log("  ... and %d more", addrs.length - 30);
    console.log("xref: python scripts/ghidra/run_query_xref.py to <address>");
    break;
  }

  default:
    console.log("Unknown command: %s. Use symbol|string|opcode. For xref use run_query_xref.py.", cmd);
    process.exit(1);
}
