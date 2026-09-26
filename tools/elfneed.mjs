// elfneed.mjs — 读 ELF 的 DT_NEEDED（动态依赖库列表），不依赖 readelf
import fs from "node:fs";

const f = process.argv[2];
const buf = fs.readFileSync(f);

if (buf.readUInt32LE(0) !== 0x464c457f) { console.log("不是 ELF 文件"); process.exit(1); }
const is64 = buf[4] === 2;
const le = buf[5] === 1;
if (!is64 || !le) { console.log("只支持 64 位小端 ELF"); process.exit(1); }

const e_shoff = Number(buf.readBigUInt64LE(0x28));
const e_shentsize = buf.readUInt16LE(0x3a);
const e_shnum = buf.readUInt16LE(0x3c);
const e_shstrndx = buf.readUInt16LE(0x3e);

// 段表
const sections = [];
for (let i = 0; i < e_shnum; i++) {
  const o = e_shoff + i * e_shentsize;
  sections.push({
    nameOff: buf.readUInt32LE(o),
    type: buf.readUInt32LE(o + 4),
    offset: Number(buf.readBigUInt64LE(o + 0x18)),
    size: Number(buf.readBigUInt64LE(o + 0x20)),
    link: buf.readUInt32LE(o + 0x28),
    entsize: Number(buf.readBigUInt64LE(o + 0x38)),
  });
}

// 段名字符串表
const shstr = sections[e_shstrndx];
const shstrBuf = buf.subarray(shstr.offset, shstr.offset + shstr.size);
const shName = (off) => { let e = off; while (shstrBuf[e] !== 0) e++; return shstrBuf.subarray(off, e).toString(); };

const dyn = sections.find((s) => s.type === 6);           // SHT_DYNAMIC
const dynstr = sections.find((s) => s.type === 3);        // SHT_STRTAB (动态字符串表)
if (!dyn) { console.log("没有 .dynamic 段（静态链接？）"); process.exit(0); }

const strBuf = buf.subarray(dynstr.offset, dynstr.offset + dynstr.size);
const readStr = (off) => { let e = off; while (strBuf[e] !== 0) e++; return strBuf.subarray(off, e).toString(); };

const needed = [];
let soname = null, interp = null;
for (let o = dyn.offset; o < dyn.offset + dyn.size; o += 16) {
  const tag = Number(buf.readBigUInt64LE(o));
  const val = Number(buf.readBigUInt64LE(o + 8));
  if (tag === 0) break;                    // DT_NULL
  if (tag === 1) needed.push(readStr(val));// DT_NEEDED
  if (tag === 14) soname = readStr(val);   // DT_SONAME
}

// PT_INTERP
const e_phoff = Number(buf.readBigUInt64LE(0x20));
const e_phentsize = buf.readUInt16LE(0x36);
const e_phnum = buf.readUInt16LE(0x38);
for (let i = 0; i < e_phnum; i++) {
  const o = e_phoff + i * e_phentsize;
  if (buf.readUInt32LE(o) === 3) {         // PT_INTERP
    const off = Number(buf.readBigUInt64LE(o + 8));
    const sz = Number(buf.readBigUInt64LE(o + 0x20));
    interp = buf.subarray(off, off + sz - 1).toString();
  }
}

console.log(`文件: ${f.split("/").pop()}  (${(buf.length / 1048576).toFixed(1)} MB)`);
console.log(`解释器: ${interp || "(无)"}`);
if (soname) console.log(`SONAME: ${soname}`);
console.log(`\nDT_NEEDED (${needed.length} 个):`);
for (const n of needed.sort()) console.log(`  ${n}`);
