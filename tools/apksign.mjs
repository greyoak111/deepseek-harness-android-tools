// apksign.mjs — 纯 JS 的 APK v1(JAR) 签名器 + ZIP 重打包
// 用法: node apksign.mjs <输入.apk> <输出.apk>
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import forge from "node-forge";

// ---------- CRC32 ----------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- 读 ZIP（走中央目录，最可靠） ----------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("找不到 EOCD，不是合法 zip");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("中央目录条目签名错误 @" + off);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString("utf8");
    // 本地头 → 数据起点
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const dstart = lho + 30 + lnlen + lelen;
    const raw = buf.subarray(dstart, dstart + csize);
    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    entries.push({ name, method, crc, data });
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

// ---------- 写 ZIP ----------
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    let method = e.method ?? 8;
    let body = e.data;
    if (method === 8) {
      const deflated = zlib.deflateRawSync(e.data, { level: 9 });
      if (deflated.length >= e.data.length) { method = 0; body = e.data; }
      else body = deflated;
    }
    // 对齐支持（STORE 时用 extra 字段填充）
    let extra = Buffer.alloc(0);
    if (e.align && method === 0) {
      const pad = (e.align - ((offset + 30 + nameBuf.length) % e.align)) % e.align;
      if (pad >= 4) extra = Buffer.concat([Buffer.from([0x00, 0x00, pad - 4 < 0 ? 0 : pad - 4]), Buffer.alloc(Math.max(0, pad - 4))]);
      else if (pad > 0) extra = Buffer.concat([Buffer.from([0x00, 0x00, pad + 4]), Buffer.alloc(pad)]);
    }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);            // time
    lh.writeUInt16LE(0x21, 12);         // date = 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(extra.length, 28);
    locals.push(lh, nameBuf, extra, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf, extra);

    offset += 30 + nameBuf.length + extra.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------- Manifest 属性行（72 字节折行） ----------
function attrLines(name, value) {
  const line = `${name}: ${value}`;
  const out = [];
  let s = line;
  while (Buffer.byteLength(s, "utf8") > 72) {
    let cut = 72;
    while (Buffer.byteLength(s.slice(0, cut), "utf8") > 72) cut--;
    out.push(s.slice(0, cut));
    s = " " + s.slice(cut);
  }
  out.push(s);
  return out.join("\r\n");
}

// ---------- 密钥库（首次生成后复用，保证同一签名可覆盖升级） ----------
function loadKey(p) {
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return { privateKey: forge.pki.privateKeyFromPem(j.key), cert: forge.pki.certificateFromPem(j.cert) };
  }
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + Date.now().toString(16);
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 30 * 365 * 86400000);
  const attrs = [
    { name: "commonName", value: "DSH On-Device Debug Key" },
    { name: "organizationName", value: "DeepSeek Harness" },
    { shortName: "OU", value: "On-Device Build" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: "basicConstraints", cA: true }, { name: "keyUsage", digitalSignature: true, keyEncipherment: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  fs.writeFileSync(p, JSON.stringify({ key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) }, null, 2));
  console.log("  已生成新密钥库:", p);
  return { privateKey: keys.privateKey, cert };
}

// ---------- 主流程 ----------
const [inApk, outApk] = process.argv.slice(2);
if (!inApk || !outApk) { console.log("用法: node apksign.mjs <in.apk> <out.apk>"); process.exit(1); }

const workdir = path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, " "));
const { privateKey, cert } = loadKey(path.join(workdir, "keystore.json"));

const entries = readZip(fs.readFileSync(inApk)).filter((e) => !e.name.startsWith("META-INF/"));
console.log(`  读入 ${entries.length} 个条目（已剔除旧签名）`);

const md = forge.md.sha256.create();
const b64 = (buf) => forge.util.encode64(buf.toString("binary"));
const sha256 = (buf) => { const m = forge.md.sha256.create(); m.update(buf.toString("binary")); return forge.util.encode64(m.digest().getBytes()); };

// MANIFEST.MF
let mf = attrLines("Manifest-Version", "1.0") + "\r\n" + attrLines("Created-By", "1.0 (DSH on-device signer)") + "\r\n\r\n";
const sections = [];
for (const e of entries) {
  const sec = attrLines("Name", e.name) + "\r\n" + attrLines("SHA-256-Digest", sha256(e.data)) + "\r\n\r\n";
  sections.push({ name: e.name, sec });
  mf += sec;
}
const mfBuf = Buffer.from(mf, "binary");

// CERT.SF
let sf = attrLines("Signature-Version", "1.0") + "\r\n" +
         attrLines("Created-By", "1.0 (DSH on-device signer)") + "\r\n" +
         attrLines("SHA-256-Digest-Manifest", sha256(mfBuf)) + "\r\n\r\n";
for (const s of sections) {
  sf += attrLines("Name", s.name) + "\r\n" + attrLines("SHA-256-Digest", sha256(Buffer.from(s.sec, "binary"))) + "\r\n\r\n";
}
const sfBuf = Buffer.from(sf, "binary");

// CERT.RSA —— PKCS#7 detached 签名
const p7 = forge.pkcs7.createSignedData();
p7.content = forge.util.createBuffer(sfBuf.toString("binary"));
p7.addCertificate(cert);
p7.addSigner({ key: privateKey, certificate: cert, digestAlgorithm: forge.pki.oids.sha256 });
p7.sign({ detached: true });
const rsaBuf = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), "binary");

const out = writeZip([
  ...entries.map((e) => ({ ...e, align: e.name === "resources.arsc" ? 4 : e.name.endsWith(".so") ? 4096 : 0 })),
  { name: "META-INF/MANIFEST.MF", data: mfBuf, method: 8 },
  { name: "META-INF/CERT.SF", data: sfBuf, method: 8 },
  { name: "META-INF/CERT.RSA", data: rsaBuf, method: 8 },
]);
fs.writeFileSync(outApk, out);
console.log(`  ✅ 已签名 → ${outApk}  ${out.length} 字节`);
console.log(`     签名者: ${cert.subject.getField("CN").value}`);
