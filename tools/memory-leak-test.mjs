#!/usr/bin/env node
// memory-leak-test.mjs —— 验证「重复运行 wine 导致资源累积、越来越慢」的假设
//
// 设计要点：
//   · 每次运行前后都记录：进程数、内存、Slab、PageTables、各 wine 进程的 VSZ/RSS
//   · 每次都用全新的 prefix 与全新的 wineserver —— 排除"陈旧 server"这个混淆变量
//   · 记录每次的耗时，看是否与资源累积相关
//   · 运行前彻底清场，确保基线为 0
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const D = "/data/user/0/com.deepseek.harness/files";
const H = D + "/hangover";
const P = D + "/dshtc/prefix";
const LD = P + "/glibc/lib/ld-linux-aarch64.so.1";
const WD = H + "/wine/usr/lib/wine";
const FD = H + "/fontconfig";
const NEW = fs.readFileSync(H + "/libpath-wine.txt", "utf8").trim();
const PFX = H + "/pfx-leak";
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
      if (!/ld-linux|wineserver|wine-preloader/.test(c)) continue;
      const st = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
      list.push({
        pid: Number(d),
        kind: /wineserver/.test(c) ? "wineserver" : "wine",
        state: f[0],
        rssMB: Number(f[21]) * 4 / 1024,
        vszMB: Number(f[20]) / 1048576,
        threads: (() => { try { return fs.readdirSync(`/proc/${d}/task`).length; } catch { return 0; } })(),
        fds: (() => { try { return fs.readdirSync(`/proc/${d}/fd`).length; } catch { return 0; } })(),
      });
    } catch {}
  }
  return list;
};
function snapshot(tag) {
  const m = meminfo();
  const ps = procs();
  return {
    tag,
    memFreeMB: m.MemFree / 1024,
    memAvailMB: m.MemAvailable / 1024,
    slabMB: (m.Slab || 0) / 1024,
    sunreclaimMB: (m.SUnreclaim || 0) / 1024,
    pageTablesMB: (m.PageTables || 0) / 1024,
    mappedMB: (m.Mapped || 0) / 1024,
    shmemMB: (m.Shmem || 0) / 1024,
    nWine: ps.filter(p => p.kind === "wine").length,
    nServer: ps.filter(p => p.kind === "wineserver").length,
    totalVszMB: ps.reduce((a, p) => a + p.vszMB, 0),
    totalRssMB: ps.reduce((a, p) => a + p.rssMB, 0),
    procs: ps,
  };
}
const fmt = s => `进程 wine=${s.nWine} server=${s.nServer} | MemFree=${s.memFreeMB.toFixed(0)}MB ` +
  `Avail=${s.memAvailMB.toFixed(0)}MB | Slab=${s.slabMB.toFixed(0)}(不可回收${s.sunreclaimMB.toFixed(0)})MB ` +
  `PageTables=${s.pageTablesMB.toFixed(0)}MB | VSZ合计=${s.totalVszMB.toFixed(0)}MB RSS合计=${s.totalRssMB.toFixed(0)}MB`;

console.log("═══ 资源累积实验 ═══");
console.log(`  连跑 ${N} 次，每次全新 prefix + 全新 wineserver\n`);

// ── 彻底清场 ──
console.log("【清场】");
let before = procs().length;
sh(`node ${D}/killwine.mjs`);
await new Promise(r => setTimeout(r, 3000));
sh(`node ${D}/killwine.mjs`);
await new Promise(r => setTimeout(r, 2000));
console.log(`  清理前 ${before} 个 → 现在 ${procs().length} 个`);

const snaps = [snapshot("基线")];
console.log(`  ${fmt(snaps[0])}\n`);

const runs = [];
for (let i = 1; i <= N; i++) {
  // 全新 prefix
  sh(`rm -rf ${PFX} && mkdir -p ${PFX} && cp -RL ${H}/wine/usr/share/wine/nls ${PFX}/nls && cp ${H}/wine/usr/share/wine/wine.inf ${PFX}/`);
  // 全新 wineserver
  sh(`cd ${PFX} && nohup env -u LD_LIBRARY_PATH WINEPREFIX=${PFX} WINEDLLPATH=${WD} "${LD}" --library-path "${NEW}" "${H}/wine/usr/bin/wineserver" -p > ${PFX}/ws.log 2>&1 &`);
  await new Promise(r => setTimeout(r, 8000));

  const t0 = Date.now();
  const out = sh(`cd ${PFX} && timeout 200 env -u LD_LIBRARY_PATH WINEDEBUG=-all HODLL=wowbox64.dll ` +
    `FONTCONFIG_PATH=${FD} FONTCONFIG_FILE=${FD}/fonts.conf ` +
    `WINEPREFIX=${PFX} WINEDLLPATH=${WD} WINELOADERNOEXEC=1 ` +
    `"${LD}" --library-path "${NEW}" "${H}/wine/usr/bin/wine" cmd /c "echo ===LEAK-${i}===" 2>&1`,
    240000);
  const ms = Date.now() - t0;
  const ok = new RegExp(`===LEAK-${i}===`).test(out);

  const s = snapshot(`第${i}次`);
  snaps.push(s);
  runs.push({ i, ok, ms, ...s });

  console.log(`【第 ${i} 次】${ok ? "✅" : "❌"}  ${(ms / 1000).toFixed(1)}s`);
  console.log(`  ${fmt(s)}`);
  const big = s.procs.filter(p => p.vszMB > 500);
  if (big.length) big.forEach(p => console.log(`    ⚠ ${p.kind} pid ${p.pid} VSZ=${p.vszMB.toFixed(0)}MB RSS=${p.rssMB.toFixed(0)}MB 线程=${p.threads}`));
  console.log();

  // 每次之间只杀 wine，保留 wineserver 以便观察它是否累积
  if (i < N) { sh(`node ${D}/killpat.mjs "wine cmd" 2>/dev/null || true`); await new Promise(r => setTimeout(r, 1000)); }
}

console.log("═══ 趋势分析 ═══");
console.log("  次数   耗时      MemFree   Slab     PageTables  wine进程  server进程  VSZ合计");
for (const r of runs) {
  console.log(`  ${String(r.i).padStart(3)}  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ` +
    `${r.memFreeMB.toFixed(0).padStart(7)}MB  ${r.slabMB.toFixed(0).padStart(5)}MB  ` +
    `${r.pageTablesMB.toFixed(0).padStart(8)}MB  ${String(r.nWine).padStart(7)}  ${String(r.nServer).padStart(9)}  ` +
    `${r.totalVszMB.toFixed(0).padStart(7)}MB`);
}

const first = runs[0], last = runs[runs.length - 1];
console.log("\n  首末对比:");
console.log(`    耗时:      ${(first.ms / 1000).toFixed(1)}s → ${(last.ms / 1000).toFixed(1)}s`);
console.log(`    MemFree:   ${first.memFreeMB.toFixed(0)}MB → ${last.memFreeMB.toFixed(0)}MB`);
console.log(`    Slab:      ${first.slabMB.toFixed(0)}MB → ${last.slabMB.toFixed(0)}MB`);
console.log(`    PageTables:${first.pageTablesMB.toFixed(0)}MB → ${last.pageTablesMB.toFixed(0)}MB`);
console.log(`    wineserver: ${first.nServer} → ${last.nServer}`);
console.log(`    VSZ合计:   ${first.totalVszMB.toFixed(0)}MB → ${last.totalVszMB.toFixed(0)}MB`);

fs.writeFileSync(H + "/leak-test.json", JSON.stringify(snaps, null, 2));
console.log(`\n  详细数据: ${H}/leak-test.json`);

sh(`node ${D}/killwine.mjs`);
