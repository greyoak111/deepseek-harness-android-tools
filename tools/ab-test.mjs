#!/usr/bin/env node
// A/B 对比：三个 x86 后端在同一条件下的表现
//   A) HODLL=wowbox64.dll      我们的补丁版（v0.4.5 + PR #4285）
//   B) HODLL=wowbox64.dll.orig Hangover 原版（v0.4.4）
//   C) HODLL=libwow64fex.dll   FEX（wp.sh 的默认值）
//
// 每个变体跑 N 次，每次都新建 wineserver（排除上一次的残留影响），
// 记录成功/失败与耗时。这是判断「问题出在哪个后端」的唯一可靠办法。
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const D = "/data/user/0/com.deepseek.harness/files";
const H = D + "/hangover";
const P = D + "/dshtc/prefix";
const LD = P + "/glibc/lib/ld-linux-aarch64.so.1";
const WD = H + "/wine/usr/lib/wine";
const FD = H + "/fontconfig";
const NEW = fs.readFileSync(H + "/libpath-wine.txt", "utf8").trim();
const PFX = H + "/pfx-ab";
const N = 3;                     // 每个变体跑几次
const TIMEOUT = 120;             // 单次上限（秒）

function sh(cmd, timeoutMs = 400000) {
  try { return execFileSync("/system/bin/sh", ["-c", cmd], { encoding: "utf8", timeout: timeoutMs }); }
  catch (e) { return (e.stdout || "") + (e.stderr || ""); }
}

// 每个变体都用全新的 prefix + 全新的 wineserver，
// 保证唯一的变量就是 HODLL
function prepare() {
  sh(`node ${D}/killwine.mjs`);
  sh(`rm -rf ${PFX} && mkdir -p ${PFX} && cp -RL ${H}/wine/usr/share/wine/nls ${PFX}/nls && cp ${H}/wine/usr/share/wine/wine.inf ${PFX}/`);
  // 先把 prefix 初始化掉（第一次一定会跑 wineboot，那步慢且与后端无关）
  sh(`cd ${PFX} && nohup env -u LD_LIBRARY_PATH WINEPREFIX=${PFX} WINEDLLPATH=${WD} "${LD}" --library-path "${NEW}" "${H}/wine/usr/bin/wineserver" -p > ${PFX}/ws.log 2>&1 &`);
}

function runOnce(hodll, tag, i) {
  const t0 = Date.now();
  const out = sh(`cd ${PFX} && timeout ${TIMEOUT} env -u LD_LIBRARY_PATH WINEDEBUG=-all HODLL=${hodll} ` +
    `FONTCONFIG_PATH=${FD} FONTCONFIG_FILE=${FD}/fonts.conf ` +
    `WINEPREFIX=${PFX} WINEDLLPATH=${WD} WINELOADERNOEXEC=1 ` +
    `"${LD}" --library-path "${NEW}" "${H}/wine/usr/bin/wine" cmd /c "echo ===${tag}-${i}===" 2>&1`,
    (TIMEOUT + 30) * 1000);
  const ms = Date.now() - t0;
  const ok = new RegExp(`===${tag}-${i}===`).test(out);
  return { ok, ms, tail: out.split("\n").filter(l => !/fontconfig|^\[BOX64\]|could not open working|setupapi|start_rpcss/.test(l)).slice(-2) };
}

console.log("═══ x86 后端 A/B 对比 ═══");
console.log(`  每个变体 ${N} 次，每次都用全新 prefix + 全新 wineserver\n`);

const variants = [
  ["wowbox64.dll",      "PATCH", "补丁版 box64 (v0.4.5 + PR #4285)"],
  ["wowbox64.dll.orig", "ORIG",  "原版 box64 (Hangover v0.4.4)"],
  ["libwow64fex.dll",   "FEX",   "FEX (wp.sh 默认)"],
];

const results = {};
for (const [hodll, tag, desc] of variants) {
  console.log(`── ${desc}`);
  console.log(`   HODLL=${hodll}`);
  prepare();
  await new Promise(r => setTimeout(r, 9000));

  let ok = 0; const times = [];
  for (let i = 1; i <= N; i++) {
    // 每次都重启 wineserver，避免上一次的残留状态干扰
    sh(`node ${D}/killwine.mjs`);
    await new Promise(r => setTimeout(r, 1500));
    sh(`cd ${PFX} && nohup env -u LD_LIBRARY_PATH WINEPREFIX=${PFX} WINEDLLPATH=${WD} "${LD}" --library-path "${NEW}" "${H}/wine/usr/bin/wineserver" -p > ${PFX}/ws.log 2>&1 &`);
    await new Promise(r => setTimeout(r, 7000));

    const r = runOnce(hodll, tag, i);
    times.push(r.ms);
    if (r.ok) ok++;
    console.log(`   第 ${i} 次: ${r.ok ? "✅" : "❌ 挂住"}  ${(r.ms / 1000).toFixed(1)}s`);
    if (!r.ok) r.tail.forEach(l => console.log("        " + l.slice(0, 110)));
  }
  results[desc] = { ok, n: N, times };
  console.log(`   小结: ${ok}/${N} 成功\n`);
}

sh(`node ${D}/killwine.mjs`);
console.log("═══ 结论 ═══");
for (const [k, v] of Object.entries(results)) {
  const avg = (v.times.reduce((a, b) => a + b, 0) / v.times.length / 1000).toFixed(1);
  console.log(`  ${k.padEnd(38)} ${v.ok}/${v.n} 成功   平均 ${avg}s`);
}
fs.writeFileSync(H + "/ab-result.json", JSON.stringify(results, null, 2));
console.log(`\n  结果已存 ${H}/ab-result.json`);
