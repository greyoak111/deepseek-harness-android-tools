#!/usr/bin/env node
// 清理 wine 相关残留进程。
//
// 踩过的坑（很重要）：
//   /proc/<pid>/cmdline 上限 4096 字节，而 wine 的 --library-path 参数极长，
//   导致 "wine" 二字根本没出现在可读部分 —— 按 "wine" 匹配永远失败，
//   僵尸进程越积越多、占住 wineserver，表现为「wine 挂住」。
//   所以匹配锚点必须用出现在【命令行开头】的加载器路径。
import fs from "node:fs";
const self = process.pid;
const skip = new Set([self]);
let p = self;
for (let i = 0; i < 8; i++) {
  try {
    const st = fs.readFileSync(`/proc/${p}/stat`, "utf8");
    const pp = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
    if (!pp || pp <= 1) break;
    skip.add(pp); p = pp;
  } catch { break; }
}
// 锚点：加载器路径（在命令行最前，不会被截断）+ wineserver 等直接可执行的名字
const ANCHORS = [
  "ld-linux-aarch64.so.1",
  "ld-linux-armhf.so.3",
  "wine-preloader",
  "wineserver",
  "winedevice",
  "box64",
  "box86",
];
let n = 0; const by = {};
for (const d of fs.readdirSync("/proc")) {
  if (!/^\d+$/.test(d)) continue;
  const pid = Number(d);
  if (skip.has(pid)) continue;
  try {
    const c = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (!c || c.startsWith("node ")) continue;
    const hit = ANCHORS.find(a => c.includes(a));
    if (!hit) continue;
    process.kill(pid, "SIGKILL");
    n++; by[hit] = (by[hit] || 0) + 1;
  } catch {}
}
const detail = Object.entries(by).map(([k, v]) => `${k}×${v}`).join(" ");
console.log(`  结束 ${n} 个残留进程${detail ? "  (" + detail + ")" : ""}`);
