import fs from "node:fs";
import { contentDigest } from "./apklib.mjs";

const f = process.argv[2];
const buf = fs.readFileSync(f);
console.log(`\n=== ${f.split("/").pop()} (${buf.length} 字节) ===`);

// 找 EOCD
let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--)
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
const cdOffsetField = buf.readUInt32LE(eocd + 16);
console.log(`  EOCD @${eocd}  记录的中央目录偏移=${cdOffsetField}`);

// 找 APK Signing Block（magic 紧贴中央目录之前）
const MAGIC = Buffer.from("APK Sig Block 42", "binary");
const magicPos = cdOffsetField - 16;
const hasBlock = magicPos > 0 && buf.subarray(magicPos, magicPos + 16).equals(MAGIC);
console.log(`  签名块 magic @${magicPos}: ${hasBlock ? "存在 ✅" : "不存在"}`);
if (!hasBlock) { console.log("  实际中央目录在:", cdOffsetField); process.exit(0); }
const size = Number(buf.readBigUInt64LE(magicPos - 8));
const blockStart = magicPos - size + 8;
console.log(`  签名块 size 字段=${size}  块起点=${blockStart}  块总长=${cdOffsetField - blockStart}`);

// 解析 id-value pairs
let off = blockStart + 8;
while (off < magicPos - 8) {
  const pairLen = Number(buf.readBigUInt64LE(off));
  const id = buf.readUInt32LE(off + 8);
  if (id === 0x7109871a) {
    const v = buf.subarray(off + 12, off + 8 + pairLen);
    // 深挖到 digests
    const innerLen = v.readUInt32LE(0);
    const signerLen = v.readUInt32LE(4);
    const signedDataLen = v.readUInt32LE(8);
    const digestsLen = v.readUInt32LE(12);
    const recLen = v.readUInt32LE(16);
    const algId = v.readUInt32LE(20);
    const digLen = v.readUInt32LE(24);
    const digest = v.subarray(28, 28 + digLen);
    console.log(`  v2 块: valueLen=${v.length} signerLen=${signerLen} signedDataLen=${signedDataLen}`);
    console.log(`  digests 记录: 长度=${digestsLen} 单条=${recLen} 算法ID=0x${algId.toString(16)} 摘要长=${digLen}`);
    console.log(`  官方内嵌摘要: ${digest.toString("hex")}`);
    // 用我的算法复算
    const mine = contentDigest([buf.subarray(0, blockStart), buf.subarray(cdOffsetField, eocd), buf.subarray(eocd)]);
    console.log(`  我复算的摘要: ${mine.toString("hex")}`);
    console.log(`  ${digest.equals(mine) ? "✅ 一致 —— 算法正确" : "❌ 不一致 —— 分段方式不同"}`);
  }
  off += 8 + pairLen;
}
