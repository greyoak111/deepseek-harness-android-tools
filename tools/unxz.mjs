import fs from "node:fs";
import * as xz from "./vendor/xz-decompress/dist/package/xz-decompress.js";

const inFile = process.argv[2];
const outFile = process.argv[3];
const mod = xz.default ?? xz;
console.log("可用导出:", Object.keys(mod).join(", "));

const input = fs.readFileSync(inFile);
let out = null;

if (mod.XzReadableStream && typeof ReadableStream !== "undefined") {
  const src = new Blob([input]).stream();
  const dec = new mod.XzReadableStream(src);
  const chunks = [];
  const reader = dec.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
  out = Buffer.concat(chunks);
} else if (typeof mod.decompress === "function") {
  out = Buffer.from(await mod.decompress(input));
}

if (!out) { console.log("没有可用的解压 API"); process.exit(1); }
fs.writeFileSync(outFile, out);
console.log(`${inFile.split("/").pop()}  ${input.length}B  →  ${outFile.split("/").pop()}  ${out.length}B`);
