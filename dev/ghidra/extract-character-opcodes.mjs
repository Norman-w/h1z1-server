#!/usr/bin/env node
/**
 * 从 character.ts 提取 Character 包名与 opcode，写入 analysis/character_opcodes.json。
 * 供 Ghidra 无头脚本读取，用于在客户端二进制中搜索 0x0fxx 命令号引用。
 * 运行：node scripts/ghidra/extract-character-opcodes.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const charTsPath = join(__dirname, "../../src/packets/ClientProtocol/ClientProtocol_1080/character.ts");
const outPath = join(__dirname, "analysis/server/character_opcodes.json");

const text = readFileSync(charTsPath, "utf8");
const list = [];
// 匹配 "Character.XXX" 或 0x0fYY（同一行或跨行）
const nameRe = /"Character\.[^"]+"/g;
const opcodeRe = /0x0f[0-9a-f]{2}/gi;
const names = text.match(nameRe) || [];
const opcodes = text.match(opcodeRe) || [];
// 按出现顺序配对（names 和 opcodes 在文件里交替出现，顺序一致）
let i = 0,
  j = 0;
while (i < names.length && j < opcodes.length) {
  const name = names[i].slice(1, -1);
  const hex = opcodes[j].toLowerCase();
  const opcode = parseInt(hex, 16);
  list.push({ name, opcode, hex });
  i++;
  j++;
}

writeFileSync(outPath, JSON.stringify(list, null, 2), "utf8");
console.log("Wrote", list.length, "entries to", outPath);
