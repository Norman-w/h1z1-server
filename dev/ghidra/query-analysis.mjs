#!/usr/bin/env node
/**
 * 从工程内 analysis/*.json 按名称或 opcode（如 0x0f1e）查询，不依赖 log。
 * 用法：node scripts/ghidra/query-analysis.mjs <名称或0x0fxx>
 * 例：node scripts/ghidra/query-analysis.mjs SetCollidable
 *     node scripts/ghidra/query-analysis.mjs 0x0f1e
 */

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const analysisDir = join(__dirname, "analysis");
const serverDir = join(analysisDir, "server");
const clientDir = join(analysisDir, "client");

const q = process.argv[2];
if (!q) {
  console.log("Usage: node scripts/ghidra/query-analysis.mjs <name or 0x0fxx>");
  process.exit(1);
}

const qLower = q.toLowerCase();
const qHex = qLower.startsWith("0x") ? qLower : null;

function loadJson(dir, name) {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const opcodes = loadJson(serverDir, "character_opcodes.json");
const strings = loadJson(clientDir, "packet_strings.json");
const opcodeRefs = loadJson(clientDir, "opcode_refs.json");

// 1) 查 opcode 表
if (opcodes) {
  const match = opcodes.find(
    (e) =>
      e.name.toLowerCase().includes(qLower) ||
      (qHex && (e.hex || "").toLowerCase() === qHex)
  );
  if (match) {
    console.log("server/character_opcodes.json:");
    console.log(JSON.stringify(match, null, 2));
  }
}

// 2) 查 packet_strings（按字符串内容）
if (strings && !qHex) {
  const matches = strings.filter((e) => (e.string || "").toLowerCase().includes(qLower));
  if (matches.length) {
    console.log("\nclient/packet_strings.json (matches):");
    matches.forEach((e) => {
      console.log("  address:", e.address, " string:", (e.string || "").slice(0, 60));
      (e.xrefs || []).slice(0, 5).forEach((r) => console.log("    ref from", r.from, r.type || ""));
    });
  }
}

// 3) 查 opcode_refs（按名称或 hex）
if (opcodeRefs) {
  const matches = opcodeRefs.filter(
    (e) =>
      (e.name || "").toLowerCase().includes(qLower) ||
      (qHex && (e.hex || "").toLowerCase() === qHex)
  );
  if (matches.length) {
    console.log("\nclient/opcode_refs.json:");
    matches.forEach((e) => {
      console.log("  name:", e.name, " hex:", e.hex);
      console.log("  addresses_16:", (e.addresses_16 || []).slice(0, 10));
      console.log("  addresses_32:", (e.addresses_32 || []).slice(0, 10));
      (e.refs || []).slice(0, 5).forEach((r) => console.log("    ref", r.from, "->", r.to));
    });
  }
}

if (!opcodes && !strings && !opcodeRefs) {
  console.log("No analysis JSON found. Run: node scripts/ghidra/extract-character-opcodes.mjs  then  scripts\\ghidra\\run_headless.bat");
}
