import fs from "node:fs";
const url = "https://dl.google.com/android/repository/platform-35_r01.zip";
const out = "/data/user/0/com.deepseek.harness/files/deepseek work/tools/platform-35.zip";
const t0 = Date.now();
const r = await fetch(url, { signal: AbortSignal.timeout(600000) });
const buf = Buffer.from(await r.arrayBuffer());
fs.writeFileSync(out, buf);
const dt = (Date.now() - t0) / 1000;
console.log(`下载完成 ${(buf.length/1048576).toFixed(1)}MB 用时 ${dt.toFixed(0)}s (${(buf.length/1048576/dt).toFixed(2)} MB/s)`);
