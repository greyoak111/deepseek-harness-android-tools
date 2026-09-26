#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  addcli.mjs —— 从 GitHub Releases 自动安装 Linux CLI 工具到安卓设备
//
//  设计依据全部来自实测踩出来的坑：
//
//   1. 静态 ≠ 能跑 —— 安卓 seccomp 会拦 syscall（lazygit 报 SIGSYS）
//      → 所以【必须真跑一次才算验过】，不能只看 file 输出
//   2. musl/gnu 双版本的仓库，musl 常常跑不了（duckdb 的 musl 版实为动态）
//      → 所以【候选逐个试，失败自动换下一个】
//   3. 安卓没有 xz 解压器
//      → 内置纯 JS 解压
//   4. 有些"二进制"其实是 Python 脚本（pyftsubset）
//      → 先看魔数，是脚本就直接报错而不是硬套加载器
//
//  用法:
//    node addcli.mjs <owner/repo>              自动挑最佳资产
//    node addcli.mjs <owner/repo> --list       只列出候选，不下载
//    node addcli.mjs <owner/repo> --name foo   指定安装后的命令名
//    node addcli.mjs <owner/repo> --tag v1.2.3 指定版本
// ─────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";

// ── 配置 ─────────────────────────────────────────────────────────────
const HOME = process.env.HOME || "/data/user/0/com.deepseek.harness/files";
const CLI_DIR = process.env.ADDRCLI_DIR || path.join(HOME, "cli");
const BIN_OUT = process.env.ADDRCLI_BIN || path.join(HOME, "payload", "bin");
const GLIBC = process.env.GLIBC_PREFIX || path.join(HOME, "dshtc", "prefix");
const TOKEN_FILE = path.join(HOME, ".github-token");
const WORK = path.join(CLI_DIR, "dl");

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${C.g}✅${C.x} ${s}`);
const no = (s) => console.log(`  ${C.r}❌${C.x} ${s}`);
const wr = (s) => console.log(`  ${C.y}⚠️ ${C.x} ${s}`);
const dim = (s) => console.log(`  ${C.d}${s}${C.x}`);
const head = (s) => console.log(`\n${C.b}${s}${C.x}`);

// ── 参数 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const repo = argv.find((a) => !a.startsWith("--") && a.includes("/"));
if (!repo) {
  console.error("用法: node addcli.mjs <owner/repo> [--list] [--name foo] [--tag vX.Y.Z] [--force]");
  process.exit(1);
}
const flag = (n) => argv.includes("--" + n);
const opt = (n) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 ? argv[i + 1] : null;
};
const LIST_ONLY = flag("list");
const FORCE = flag("force");
const NAME_OVERRIDE = opt("name");
const TAG = opt("tag");

// ── GitHub ───────────────────────────────────────────────────────────
function headers() {
  const h = { "User-Agent": "addcli", Accept: "application/vnd.github+json" };
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) h.Authorization = "bearer " + t;
  } catch {}
  return h;
}

async function gh(url) {
  const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// ── 资产评分 ─────────────────────────────────────────────────────────
// 目标是「能在安卓上跑」，不是「下载量最大」。
function score(name) {
  const n = name.toLowerCase();
  let s = 0;
  const why = [];

  // 架构：只要 aarch64/arm64
  const isArm = /aarch64|arm64/.test(n);
  if (!isArm) return { s: -9999, why: ["非 arm64"] };
  s += 100;
  why.push("arm64 +100");

  // 排除明显不能用的
  if (/x86_64|x64|amd64|i386|i686/.test(n)) return { s: -9999, why: ["含 x86"] };
  if (/win(dows)?|\.exe|\.msi|macos|darwin|osx|apple/.test(n)) return { s: -9999, why: ["非 Linux"] };
  // BSD / Solaris 系 —— 也是 arm64，但完全不同的内核 ABI
  // （实测教训：lazygit 同时发 freebsd 和 linux 版，漏掉这条会让 FreeBSD 版排第一）
  if (/freebsd|netbsd|openbsd|dragonfly|illumos|solaris/.test(n)) return { s: -9999, why: ["非 Linux 内核（BSD/Solaris）"] };
  if (/\.(deb|rpm|apk|dmg|pkg)$/.test(n)) return { s: -9000, why: ["包格式，非独立二进制"] };
  if (/source|\.src\.|src\.tar/.test(n)) return { s: -9000, why: ["源码包"] };
  if (/sha256|sha512|\.sig$|\.asc$|checksums|\.json$|\.txt$/.test(n)) return { s: -9999, why: ["校验文件"] };

  // 链接方式偏好（实测结论）
  if (/musl/.test(n)) { s += 50; why.push("musl +50"); }
  else if (/gnu|glibc/.test(n)) { s += 25; why.push("gnu +25"); }
  else if (/static/.test(n)) { s += 40; why.push("static +40"); }
  else { s += 10; why.push("未知链接 +10"); }

  // 解压友好的格式
  if (/\.tar\.gz$|\.tgz$/.test(n)) { s += 15; why.push("tar.gz +15"); }
  else if (/\.zip$/.test(n)) { s += 10; why.push("zip +10"); }
  else if (/\.tar\.xz$/.test(n)) { s += 5; why.push("tar.xz +5"); }
  else if (/\.gz$/.test(n)) { s += 8; why.push("gz +8"); }
  else if (/\.bz2$/.test(n)) { s += 3; why.push("bz2 +3"); }
  else { s += 12; why.push("裸二进制 +12"); }

  // 稍微惩罚名字里带 ui/gui 字样的（大概率要图形环境）
  if (/gui|desktop|qt|gtk/.test(n)) { s -= 40; why.push("疑似 GUI -40"); }

  return { s, why };
}

// ── 解压 ─────────────────────────────────────────────────────────────
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "buffer", maxBuffer: 1 << 28 });
  return { code: r.status, out: (r.stdout || Buffer.alloc(0)).toString(), err: (r.stderr || Buffer.alloc(0)).toString() };
}

/** 解 xz —— 安卓没有 xz 解压器，链到本仓库的纯 JS 实现 */
async function unxzFile(src, dst) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const vendored = [
    path.join(here, "vendor", "xz-decompress", "dist", "package", "xz-decompress.js"),
    path.join(HOME, "dshtc", "vendor", "xz-decompress", "dist", "package", "xz-decompress.js"),
    path.join(HOME, "dshtc", "tools", "vendor", "xz-decompress", "dist", "package", "xz-decompress.js"),
  ];
  const mod = vendored.find((p) => fs.existsSync(p));
  if (!mod) throw new Error("找不到 vendor/xz-decompress，无法解 .xz");

  const m = await import("file://" + mod);
  const x = m.default ?? m;
  const input = fs.readFileSync(src);
  let out = null;

  // 注意：XzReadableStream 要的是 **Web** ReadableStream（有 getReader），
  // 不是 Node 的 stream.Readable —— 直接 pipeThrough 会报
  // "compressedStream.getReader is not a function"。
  // 正确做法是用 Blob 拿到 Web Stream。
  if (x.XzReadableStream && typeof ReadableStream !== "undefined") {
    const reader = new x.XzReadableStream(new Blob([input]).stream()).getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    out = Buffer.concat(chunks);
  } else if (typeof x.decompress === "function") {
    out = Buffer.from(await x.decompress(input));
  }

  if (!out) throw new Error("xz-decompress 没有可用的解压 API");
  fs.writeFileSync(dst, out);
}

function unzipTo(file, dest) {
  const b = fs.readFileSync(file);
  let i = 0,
    n = 0;
  while (i < b.length - 4) {
    if (b.readUInt32LE(i) === 0x04034b50) {
      const method = b.readUInt16LE(i + 8);
      const csize = b.readUInt32LE(i + 18);
      const nlen = b.readUInt16LE(i + 26);
      const elen = b.readUInt16LE(i + 28);
      const fn = b.subarray(i + 30, i + 30 + nlen).toString();
      const ds = i + 30 + nlen + elen;
      // 防目录穿越
      const safe = path.normalize(fn).replace(/^(\.\.[/\\])+/, "");
      if (!/\/$/.test(fn) && csize > 0) {
        const raw = b.subarray(ds, ds + csize);
        const data = method === 0 ? raw : zlib.inflateRawSync(raw);
        const out = path.join(dest, safe);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, data);
        n++;
      }
      i = ds + csize;
    } else i++;
  }
  return n;
}

async function extract(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const n = file.toLowerCase();
  if (/\.tar\.gz$|\.tgz$/.test(n)) return run("tar", ["xzf", file, "-C", dest]).code === 0;
  if (/\.tar\.bz2$|\.tbz2?$/.test(n)) return run("tar", ["xjf", file, "-C", dest]).code === 0;
  if (/\.tar\.xz$/.test(n)) {
    const tmp = file.replace(/\.xz$/, "");
    await unxzFile(file, tmp);
    return run("tar", ["xf", tmp, "-C", dest]).code === 0;
  }
  if (/\.tar$/.test(n)) return run("tar", ["xf", file, "-C", dest]).code === 0;
  if (/\.zip$/.test(n)) return unzipTo(file, dest) > 0;
  if (/\.gz$/.test(n)) {
    fs.writeFileSync(path.join(dest, path.basename(file).replace(/\.gz$/, "")), zlib.gunzipSync(fs.readFileSync(file)));
    return true;
  }
  if (/\.bz2$/.test(n)) {
    // 安卓没自带 bunzip2，借 Debian 的
    const deb = path.join(HOME, "dshbl", "debroot", "usr", "bin", "bzip2");
    if (fs.existsSync(deb)) {
      const r = run(deb, ["-dc", file]);
      if (r.code === 0) {
        fs.writeFileSync(path.join(dest, path.basename(file).replace(/\.bz2$/, "")), r.out);
        return true;
      }
    }
    return false;
  }
  // 裸二进制
  fs.copyFileSync(file, path.join(dest, path.basename(file)));
  return true;
}

// ── ELF 检查 ─────────────────────────────────────────────────────────
function elfInfo(file) {
  let b;
  try {
    b = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (!(b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46)) {
    // 不是 ELF —— 可能是脚本
    const head = b.subarray(0, 64).toString("utf8");
    if (/^#!/.test(head)) return { kind: "script", shebang: head.split("\n")[0] };
    return { kind: "other" };
  }
  const phoff = Number(b.readBigUInt64LE(0x20));
  const phentsize = b.readUInt16LE(0x36);
  const phnum = b.readUInt16LE(0x38);
  let interp = null;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (b.readUInt32LE(o) === 3) {
      const off = Number(b.readBigUInt64LE(o + 8));
      let e = off;
      while (b[e]) e++;
      interp = b.subarray(off, e).toString();
    }
  }
  const arch = b.readUInt16LE(0x12) === 0xb7 ? "aarch64" : "other";
  return { kind: "elf", arch, interp, size: b.length };
}

/** 在解压结果里找主程序 */
function findBinary(dir, prefer) {
  const cands = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else {
        const info = elfInfo(p);
        if (info && (info.kind === "elf" || info.kind === "script")) {
          let s = 0;
          const base = e.name.toLowerCase();
          if (prefer && base === prefer.toLowerCase()) s += 100;
          if (prefer && (base.includes(prefer.toLowerCase()) || prefer.toLowerCase().includes(base))) s += 40;
          if (info.kind === "elf") s += 20;
          if (info.arch === "aarch64") s += 10;
          if (/\/bin\//.test(p)) s += 5;
          if (/readme|license|changelog/.test(base)) s -= 100;
          cands.push({ p, info, s });
        }
      }
    }
  };
  walk(dir, 0);
  cands.sort((a, b) => b.s - a.s);
  return cands;
}

// ── 试跑 ─────────────────────────────────────────────────────────────
/** 真跑一次 —— 这是唯一能抓出 SIGSYS / 缺解释器 的方法 */
function tryRun(binPath, info) {
  const probes = [["--version"], ["-version"], ["version"], ["--help"]];
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;

  let cmd = binPath,
    args = [];
  if (info.kind === "elf" && info.interp) {
    const isGlibc = /ld-linux/.test(info.interp);
    if (isGlibc) {
      const loader = path.join(GLIBC, "glibc", "lib", "ld-linux-aarch64.so.1");
      if (!fs.existsSync(loader)) return { ok: false, why: `需要 glibc 但找不到 ${loader}` };
      cmd = loader;
      args = ["--library-path", path.join(GLIBC, "glibc", "lib"), binPath];
    } else if (/musl/.test(info.interp)) {
      return { ok: false, why: `需要 musl 加载器 ${info.interp}（本机没有）—— 试试同仓库的 gnu 版` };
    }
  }
  for (const probe of probes) {
    const r = spawnSync(cmd, [...args, ...probe], { encoding: "utf8", timeout: 60000, env });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    if (r.status === 0 || (out && !/not found|No such file/.test(out))) {
      if (/bad system call|SIGSYS/i.test(out)) return { ok: false, why: "SIGSYS —— 安卓 seccomp 拦了系统调用" };
      return { ok: true, output: out.split("\n")[0].slice(0, 80) };
    }
    if (/bad system call|SIGSYS/i.test(out)) return { ok: false, why: "SIGSYS —— 安卓 seccomp 拦了系统调用" };
    if (r.error?.code === "ETIMEDOUT") return { ok: false, why: "执行超时" };
  }
  return { ok: false, why: "所有探测参数都无有效输出" };
}

// ── 主流程 ───────────────────────────────────────────────────────────
(async () => {
  head(`═══ addcli · ${repo} ═══`);

  const rel = await gh(TAG ? `https://api.github.com/repos/${repo}/releases/tags/${TAG}` : `https://api.github.com/repos/${repo}/releases/latest`);
  console.log(`  版本: ${rel.tag_name}   资产: ${rel.assets.length} 个`);

  const scored = rel.assets
    .map((a) => ({ a, ...score(a.name) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s);

  if (!scored.length) {
    no("没有可用的 arm64 Linux 资产");
    dim("  该仓库可能只发源码，或只发 x86 —— 考虑 Debian 包或自己编译");
    process.exit(2);
  }

  head("候选（按可跑性排序）");
  for (const x of scored.slice(0, 8)) {
    console.log(`  ${String(x.s).padStart(5)}  ${x.a.name.slice(0, 48).padEnd(50)} ${(x.a.size / 1048576).toFixed(1)}MB`);
    dim(`         ${x.why.join(" · ")}`);
  }

  if (LIST_ONLY) {
    dim("\n  （--list 模式，未下载）");
    return;
  }

  const prefer = NAME_OVERRIDE || repo.split("/")[1].replace(/^(cli|cli-)/, "");
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(path.join(CLI_DIR, "bin"), { recursive: true });

  // 逐个候选试 —— musl 失败就自动换 gnu（duckdb 的教训）
  for (const [idx, cand] of scored.slice(0, 5).entries()) {
    head(`尝试 ${idx + 1}/${Math.min(5, scored.length)}: ${cand.a.name}`);

    const dl = path.join(WORK, cand.a.name.replace(/[/\\]/g, "_"));
    try {
      const r = await fetch(cand.a.browser_download_url, { headers: headers(), signal: AbortSignal.timeout(600000) });
      if (!r.ok) {
        wr(`下载失败 HTTP ${r.status}`);
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(dl, buf);
      dim(`  下载 ${(buf.length / 1048576).toFixed(1)} MB`);
    } catch (e) {
      wr(`下载异常 ${e.message}`);
      continue;
    }

    const dir = path.join(WORK, "x_" + idx);
    fs.rmSync(dir, { recursive: true, force: true });
    if (!(await extract(dl, dir))) {
      wr("解压失败");
      continue;
    }

    const found = findBinary(dir, prefer);
    if (!found.length) {
      wr("里面没有可执行文件");
      continue;
    }

    const { p, info } = found[0];
    dim(`  找到 ${path.relative(dir, p)}  (${info.kind}${info.interp ? ", " + info.interp : ", 静态"})`);

    if (info.kind === "script") {
      wr(`这是脚本不是 ELF（${info.shebang}）—— 需要对应解释器，跳过`);
      continue;
    }
    if (info.arch !== "aarch64") {
      wr(`架构是 ${info.arch}，不是 aarch64`);
      continue;
    }

    const test = tryRun(p, info);
    if (!test.ok) {
      wr(`试跑失败: ${test.why}`);
      dim("  → 换下一个候选");
      continue;
    }
    ok(`试跑通过: ${test.output}`);

    // ── 安装 ──────────────────────────────────────────────────────
    const name = NAME_OVERRIDE || path.basename(p).replace(/\.(exe|bin)$/, "");

    // 有些工具（helix、neovim…）需要旁边的数据目录才能工作。
    // 只拷二进制的话，helix 会报所有语言支持 ✘（实测）。
    // 判据：二进制所在层级附近有没有 runtime/ share/ lib/ 这类目录。
    const relBin = path.relative(dir, p);
    const topDir = relBin.includes(path.sep) ? path.join(dir, relBin.split(path.sep)[0]) : dir;
    const treeMates = ["runtime", "share", "lib", "libexec", "data"];
    const mate = treeMates.find((m) => {
      // 看二进制的同级与上一级
      return fs.existsSync(path.join(path.dirname(p), m)) || (topDir !== dir && fs.existsSync(path.join(topDir, m)));
    });

    let inst;
    let runtimeEnv = null;
    if (mate) {
      // 整棵树搬过去，保持相对结构（二进制按自身位置找 runtime）
      const libDir = path.join(CLI_DIR, "lib", name);
      fs.rmSync(libDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(libDir), { recursive: true });
      fs.cpSync(topDir, libDir, { recursive: true });
      inst = path.join(libDir, relBin.includes(path.sep) ? relBin.split(path.sep).slice(1).join(path.sep) : path.basename(p));
      if (!fs.existsSync(inst)) inst = path.join(libDir, path.basename(p));
      fs.chmodSync(inst, 0o755);
      ok(`检测到数据目录 "${mate}/" —— 整棵树安装到 ${libDir}`);

      // ⚠️ 关键：这类工具通常用 current_exe() 定位数据目录。
      // 但我们是通过 glibc 加载器启动的，current_exe() 返回的是**加载器**的路径，
      // 于是它会去 <加载器目录>/runtime 找 —— 永远找不到（helix 实测如此）。
      // 所以必须显式用环境变量指定数据目录。
      const KNOWN_ENV = { hx: "HELIX_RUNTIME", helix: "HELIX_RUNTIME", nvim: "VIMRUNTIME", vim: "VIMRUNTIME" };
      const envKey = opt("runtime-env") || KNOWN_ENV[name] || null;
      const envVal = path.join(libDir, mate);
      if (envKey) {
        runtimeEnv = [envKey, envVal];
        ok(`数据目录用 ${envKey} 指定（经加载器启动时 current_exe() 不可靠）`);
      } else {
        wr(`该工具的数据目录需自行指定 —— 加 --runtime-env KEY 参数`);
        dim(`  数据在: ${envVal}`);
      }
    } else {
      inst = path.join(CLI_DIR, "bin", name + ".real");
      fs.copyFileSync(p, inst);
      fs.chmodSync(inst, 0o755);
    }
    dim(`  安装 ${inst}`);

    fs.mkdirSync(BIN_OUT, { recursive: true });
    const wrap = path.join(BIN_OUT, name);
    let body;
    if (info.interp && /ld-linux/.test(info.interp)) {
      body = `#!/system/bin/sh
# ${name} —— 由 addcli 安装（glibc 动态）
# 源: https://github.com/${repo}  ${rel.tag_name}
# ⚠️ 绝不能把 bionic 库混进搜索路径（会报 version 'LIBC' not found）
unset LD_LIBRARY_PATH LD_PRELOAD LD_DEBUG
${runtimeEnv ? `export ${runtimeEnv[0]}="${runtimeEnv[1]}"\n` : ""}exec "${GLIBC}/glibc/lib/ld-linux-aarch64.so.1" --library-path "${GLIBC}/glibc/lib" "${inst}" "$@"
`;
    } else {
      body = `#!/system/bin/sh
# ${name} —— 由 addcli 安装（静态）
# 源: https://github.com/${repo}  ${rel.tag_name}
exec "${inst}" "$@"
`;
    }
    fs.writeFileSync(wrap, body);
    fs.chmodSync(wrap, 0o755);
    ok(`已安装命令: ${wrap}`);

    head("验证");
    const v = spawnSync(wrap, ["--version"], { encoding: "utf8", timeout: 60000 });
    const vo = ((v.stdout || "") + (v.stderr || "")).trim().split("\n")[0];
    console.log(`  $ ${name} --version`);
    console.log(`  ${vo || "(无输出)"}`);

    head("清理");
    fs.rmSync(dl, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    ok("临时文件已清理");
    return;
  }

  no("所有候选都试过了，没有一个能跑");
  dim("  下一步：试 Debian 包（node tools/debtool.mjs install <包名>）或自己编译");
  process.exit(3);
})().catch((e) => {
  no(e.message);
  process.exit(1);
});
