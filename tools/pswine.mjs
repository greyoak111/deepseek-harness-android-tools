#!/usr/bin/env node
// 精确列出 wine 相关进程（排除自身与祖先链、以及 node 诊断进程）
import fs from "node:fs";
const self = process.pid;
const skip = new Set([self]);
let p = self;
for (let i = 0; i < 8; i++) {
  try { const st = fs.readFileSync(`/proc/${p}/stat`, "utf8");
    const pp = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
    if (!pp || pp <= 1) break; skip.add(pp); p = pp;
  } catch { break; }
}
const rows = [];
for (const d of fs.readdirSync("/proc")) {
  if (!/^\d+$/.test(d)) continue;
  const pid = Number(d);
  if (skip.has(pid)) continue;
  try {
    const c = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (!c || c.startsWith("node ") || c.includes("pswine")) continue;
    if (!/ld-linux-aarch64|wineserver|wine-preloader/.test(c)) continue;
    const st = fs.readFileSync(`/proc/${d}/stat`, "utf8");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    rows.push({
      pid, state: f[0],
      kind: /wineserver/.test(c) ? "wineserver" : "wine",
      rssMB: Number(f[21]) * 4 / 1024,
      vszMB: Number(f[20]) / 1048576,
    });
  } catch {}
}
console.log(`  wine 相关进程: ${rows.length} 个`);
for (const r of rows) console.log(`    ${r.kind.padEnd(10)} pid ${String(r.pid).padEnd(7)} 状态=${r.state} RSS=${r.rssMB.toFixed(0)}MB VSZ=${r.vszMB.toFixed(0)}MB`);
// 顺便报内存
const m = {};
for (const l of fs.readFileSync("/proc/meminfo", "utf8").split("\n")) {
  const x = l.match(/^(\w+):\s+(\d+)/); if (x) m[x[1]] = Number(x[2]);
}
console.log(`  内存: Free=${(m.MemFree/1024).toFixed(0)}MB Avail=${(m.MemAvailable/1024).toFixed(0)}MB Cached=${(m.Cached/1024).toFixed(0)}MB`);
console.log(`        Slab=${(m.Slab/1024).toFixed(0)}MB(不可回收${(m.SUnreclaim/1024).toFixed(0)}) PageTables=${(m.PageTables/1024).toFixed(0)}MB Mapped=${(m.Mapped/1024).toFixed(0)}MB`);
