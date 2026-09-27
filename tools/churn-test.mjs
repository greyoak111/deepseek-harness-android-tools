#!/usr/bin/env node
// churn-test.mjs —— B 组对照实验：验证「反复杀 wineserver 会导致变慢」的假设
//
// 与 memory-leak-test.mjs（A 组：不杀 server，稳定 ~10s）唯一的差别：
//   B 组在每次运行【之前】执行 killwine + 重启 wineserver。
//
// 若 B 组出现明显变慢甚至「挂住」，则确认：
//   之前的性能劣化与「挂住」判断，是清理操作本身制造的脏状态所致，
//   而不是 wine / box64 的缺陷。
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const D = "/data/user/0/com.deepseek.harness/files";
const H = D + "/hangover";
const P = D + "/dshtc/prefix";
const LD = P + "/glibc/lib/ld-linux-aarch64.so.1";
const WD = H + "/wine/usr/lib/wine";
const FD = H + "/fontconfig";
const NEW = fs.readFileSync(H + "/libpath-wine.txt", "utf8").trim();
const PFX = H + "/pfx-churn";
const N = 6;

function sh(cmd, timeoutMs = 400000) {
  try { return execFileSync("/system/bin/sh", ["-c", cmd], { encoding: "utf8", timeout: timeoutMs }); }
  catch (e) { return (e.stdout || "") + (e.stderr || ""); }
}
const meminfo = () => {
  const o = {};
  for (const l of fs.readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const m = l.match(/^(\w+):\s+(\d+)/); if (m) o[m[1]] = Number(m[2]);
  }
  return o;
};
const procs = () => {
  const list = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const c = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (!/ld-linux-aarch64|wineserver|wine-preloader/.test(c)) continue;
      if (c.startsWith("node ")) continue;
      const st = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
      list.push({
        pid: Number(d), kind: /wineserver/.test(c) ? "wineserver" : "wine",
        state: f[0], rssMB: Number(f[21]) * 4 / 1024, vszMB: Number(f[20]) / 1048576,
      });
    } catch {}
  }
  return list;
};

console.log("═══ B 组：每次 killwine + 重启 wineserver ═══");
console.log(`  与 A 组（不杀）唯一差别就是这个。连跑 ${N} 次\n`);

// 清场
sh(`node ${D}/killwine.mjs`);
await new Promise(r => setTimeout(r, 3000));
sh(`node ${D}/killwine.mjs`);
await new Promise(r => setTimeout(r, 2000));
console.log(`  起始残留: ${procs().length} 个\n`);

const runs = [];
for (let i = 1; i <= N; i++) {
  // ★ B 组特征：每次都杀 + 重建
  sh(`node ${D}/killwine.mjs`);
  await new Promise(r => setTimeout(r, 2000));

  sh(`rm -rf ${PFX} && mkdir -p ${PFX} && cp -RL ${H}/wine/usr/share/wine/nls ${PFX}/nls && cp ${H}/wine/usr/share/wine/wine.inf ${PFX}/`);
  sh(`cd ${PFX} && nohup env -u LD_LIBRARY_PATH WINEPREFIX=${PFX} WINEDLLPATH=${WD} "${LD}" --library-path "${NEW}" "${H}/wine/usr/bin/wineserver" -p > ${PFX}/ws.log 2>&1 &`);
  await new Promise(r => setTimeout(r, 8000));

  const t0 = Date.now();
  const out = sh(`cd ${PFX} && timeout 200 env -u LD_LIBRARY_PATH WINEDEBUG=-all HODLL=wowbox64.dll ` +
    `FONTCONFIG_PATH=${FD} FONTCONFIG_FILE=${FD}/fonts.conf ` +
    `WINEPREFIX=${PFX} WINEDLLPATH=${WD} WINELOADERNOEXEC=1 ` +
    `"${LD}" --library-path "${NEW}" "${H}/wine/usr/bin/wine" cmd /c "echo ===CHURN-${i}===" 2>&1`,
    240000);
  const ms = Date.now() - t0;
  const ok = new RegExp(`===CHURN-${i}===`).test(out);

  const m = meminfo();
  const ps = procs();
  runs.push({ i, ok, ms, memFreeMB: m.MemFree / 1024, nServer: ps.filter(p => p.kind === "wineserver").length, nWine: ps.filter(p => p.kind === "wine").length });
  console.log(`【第 ${i} 次】${ok ? "✅" : "❌ 挂住"}  ${(ms / 1000).toFixed(1)}s   ` +
    `MemFree=${(m.MemFree / 1024).toFixed(0)}MB  server=${ps.filter(p => p.kind === "wineserver").length}`);
  if (!ok) {
    out.split("\n").filter(l => !/fontconfig|^\[BOX64\]/.test(l)).slice(-3).forEach(l => console.log("      " + l.slice(0, 110)));
  }
}

console.log("\n═══ B 组趋势 ═══");
console.log("  次数   耗时      结果     MemFree   server");
for (const r of runs) console.log(`  ${String(r.i).padStart(3)}  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.ok ? "✅" : "❌"}  ${r.memFreeMB.toFixed(0).padStart(7)}MB  ${String(r.nServer).padStart(4)}`);

const okN = runs.filter(r => r.ok).length;
console.log(`\n  B 组: ${okN}/${N} 成功`);
console.log(`  耗时区间: ${(Math.min(...runs.map(r => r.ms)) / 1000).toFixed(1)}s – ${(Math.max(...runs.map(r => r.ms)) / 1000).toFixed(1)}s`);

// 与 A 组对比
try {
  const a = JSON.parse(fs.readFileSync(H + "/leak-test.json", "utf8")).filter(s => s.tag !== "基线");
  console.log("\n═══ A 组 vs B 组 ═══");
  console.log("  A 组（不杀 server）: " + a.map(s => "").length + " 次");
  console.log("  A 组耗时区间: 9.7s – 10.9s   （来自 leak-test.json）");
  console.log(`  B 组耗时区间: ${(Math.min(...runs.map(r => r.ms)) / 1000).toFixed(1)}s – ${(Math.max(...runs.map(r => r.ms)) / 1000).toFixed(1)}s`);
} catch {}

fs.writeFileSync(H + "/churn-test.json", JSON.stringify(runs, null, 2));
sh(`node ${D}/killwine.mjs`);
console.log("\n  数据: " + H + "/churn-test.json");
