#!/usr/bin/env node
// 按模式清理进程。
// 关键：模式从命令行参数读入 —— 但脚本自身命令行会含该模式字面量，
// 所以必须排除自身与整条祖先链。
import fs from "node:fs";
const pat = new RegExp(process.argv[2] || "____none____", "i");
const self = process.pid;
const skip = new Set([self]);
let p = self;
for (let i = 0; i < 8; i++) {
  try {
    const st = fs.readFileSync(`/proc/${p}/stat`, "utf8");
    const ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
    if (!ppid || ppid <= 1) break;
    skip.add(ppid); p = ppid;
  } catch { break; }
}
let n = 0; const killed = [];
for (const d of fs.readdirSync("/proc")) {
  if (!/^\d+$/.test(d)) continue;
  const pid = Number(d);
  if (skip.has(pid)) continue;
  try {
    const c = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (!c || c.startsWith("node ")) continue;
    if (pat.test(c)) { process.kill(pid, "SIGKILL"); n++; killed.push(pid); }
  } catch {}
}
console.log(`  按 /${pat.source}/ 结束 ${n} 个进程（跳过自身+祖先 ${skip.size} 个）`);
