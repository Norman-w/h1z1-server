"use strict";
const fs = require("node:fs");
const file = process.argv[2];
const data = fs.readFileSync(file);
let offset = 0;
let index = 0;
while (offset + 48 <= data.length && index < 10000) {
  const magic = data.readUInt32LE(offset);
  const family = data.readUInt32LE(offset + 4);
  const type = data.readUInt32LE(offset + 8);
  const entry = data.readUInt32LE(offset + 12);
  const length = data.readUInt32LE(offset + 32);
  const alignment = data.readUInt32LE(offset + 40);
  console.log(JSON.stringify({ index, offset: `0x${offset.toString(16)}`, magic: `0x${magic.toString(16)}`, family: `0x${family.toString(16)}`, type: `0x${type.toString(16)}`, entry, length, alignment }));
  if (magic !== 0x18 || family !== 0x0a || !length) break;
  const boundary = alignment && (alignment & (alignment - 1)) === 0 ? alignment : 16;
  offset = ((offset + 48 + length + boundary - 1) / boundary | 0) * boundary;
  index++;
}
