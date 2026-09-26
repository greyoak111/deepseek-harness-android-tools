// mkapk.mjs — 一键把项目打成已签名 APK（全程本机，无需 Gradle / JVM / PC）
// 用法: mkapk [项目目录] [-o 输出.apk] [--install] [--launch] [--clean] [--verbose]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signApk } from "./apklib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(HERE);
const PREFIX = path.join(TOOLS, "prefix");
const AAPT2 = path.join(PREFIX, "bin", "aapt2");
const ANDROID_JAR = path.join(PREFIX, "framework", "android.jar");
const TC = "/data/user/0/com.deepseek.harness/files/c4tc/tc/gcc";
const SYSROOT = path.join(TC, "aarch64-linux-android");
const GLUE = path.join(SYSROOT, "include", "android_native_app_glue.c");

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const oIdx = argv.findIndex((a) => a === "-o" || a === "--out");
const outArg = oIdx >= 0 ? argv[oIdx + 1] : null;
const positional = argv.filter((a, i) => !a.startsWith("-") && (oIdx < 0 || i !== oIdx + 1));
const PROJ = path.resolve(positional[0] || ".");
const VERBOSE = flags.has("--verbose") || flags.has("-v");

const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", x: "\x1b[0m" };
const step = (n, s) => console.log(`${C.c}[${n}/6]${C.x} ${C.b}${s}${C.x}`);
const ok = (s) => console.log(`      ${C.g}✓${C.x} ${s}`);
const warn = (s) => console.log(`      ${C.y}!${C.x} ${s}`);
const die = (s) => { console.error(`${C.r}✗ ${s}${C.x}`); process.exit(1); };
const run = (bin, args, opts = {}) => {
  if (VERBOSE) console.log(`${C.dim}      $ ${bin} ${args.join(" ")}${C.x}`);
  return execFileSync(bin, args, { encoding: "utf8", stdio: VERBOSE ? "inherit" : "pipe", ...opts });
};
const mb = (b) => (b / 1048576).toFixed(2) + "MB";
/** aapt2 是 Termux 抽出来的原生二进制，必须显式给库路径 */
const AAPT_ENV = { ...process.env, LD_LIBRARY_PATH: path.join(PREFIX, "lib") };
const aapt2 = (args) => run(AAPT2, args, { env: AAPT_ENV });

// ---------- 配置 ----------
if (!fs.existsSync(PROJ)) die(`项目目录不存在: ${PROJ}`);
const cfgPath = path.join(PROJ, "apk.json");
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
const name = path.basename(PROJ).replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
const packageName = cfg.package || `li.dsh.${name}`;
const label = cfg.label || cfg.package || name;
const nativeName = cfg.native?.name || "main";
const nativeSrc = cfg.native?.src || "native";
const minSdk = cfg.minSdk ?? 24;
const targetSdk = cfg.targetSdk ?? 28;
const orientation = cfg.orientation || "landscape";
const activity = cfg.activity || "android.app.NativeActivity";
const BUILD = path.join(PROJ, "build");
const OUT = outArg ? path.resolve(outArg) : path.join(BUILD, `${name}.apk`);

console.log(`\n${C.b}📦 mkapk${C.x}  ${C.dim}本机 APK 构建（aapt2 + GCC + 自签）${C.x}`);
console.log(`   项目   ${PROJ}`);
console.log(`   包名   ${packageName}   版本 ${cfg.versionName || "1.0"}(${cfg.versionCode || 1})`);
console.log(`   目标   API ${minSdk} → ${targetSdk}   ${orientation}\n`);

if (flags.has("--clean")) { fs.rmSync(BUILD, { recursive: true, force: true }); ok("已清理 build/"); }
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(path.join(BUILD, "lib", "arm64-v8a"), { recursive: true });

// ---------- 1. 编译原生代码 ----------
step(1, "编译原生代码");
const libDir = path.join(BUILD, "lib", "arm64-v8a");
const soOut = path.join(libDir, `lib${nativeName}.so`);
const srcDir = path.join(PROJ, nativeSrc);
let soBuilt = null;
if (fs.existsSync(srcDir)) {
  const sources = fs.readdirSync(srcDir).filter((f) => /\.(c|cpp|cc)$/.test(f)).map((f) => path.join(srcDir, f));
  if (sources.length) {
    const libs = cfg.native?.libs || ["GLESv2", "EGL", "android", "log", "m"];
    const cflags = (cfg.native?.cflags || "-O2 -Wall").split(/\s+/).filter(Boolean);
    const allSrc = [...sources];
    if (cfg.native?.glue !== false && fs.existsSync(GLUE)) allSrc.push(GLUE);
    const t0 = Date.now();
    const ldArgs = [
      "-shared", "-fPIC", ...cflags,
      "-I" + path.join(SYSROOT, "include"),
      ...(cfg.native?.includes || []).map((p) => "-I" + path.join(SYSROOT, "include", p)),
      ...(cfg.native?.includedirs || []).map((p) => "-I" + path.resolve(PROJ, p)),
      ...(cfg.native?.libdirs || []).map((p) => "-L" + path.resolve(PROJ, p)),
      "-o", soOut, ...allSrc,
      "-Wl,--start-group",
      ...libs.flatMap((l) => (cfg.native?.wholeArchive || []).includes(l)
        ? ["-Wl,--whole-archive", "-l" + l, "-Wl,--no-whole-archive"]
        : ["-l" + l]),
      "-Wl,--end-group",
    ];
    if (cfg.native?.glue !== false) ldArgs.push("-Wl,-u,ANativeActivity_onCreate");
    run("cc4", ldArgs);
    soBuilt = fs.statSync(soOut).size;
    ok(`${sources.length} 个源文件 → lib${nativeName}.so  ${mb(soBuilt)}  (${Date.now() - t0}ms)`);
    if (cfg.native?.glue !== false) ok("已链接 android_native_app_glue（零 Java 依赖）");
  } else warn("native/ 下没有 .c/.cpp");
} else warn("无 native/ 目录，跳过（纯资源包）");

// ---------- 2. 清单 ----------
step(2, "准备 AndroidManifest.xml");
let manifest = path.join(PROJ, "AndroidManifest.xml");
if (fs.existsSync(manifest)) {
  ok("使用项目自带的 AndroidManifest.xml");
} else {
  manifest = path.join(BUILD, "AndroidManifest.xml");
  const hasCode = fs.existsSync(path.join(PROJ, "classes.dex"));
  fs.writeFileSync(manifest, `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${packageName}"
    android:versionCode="${cfg.versionCode || 1}"
    android:versionName="${cfg.versionName || "1.0"}">
    <uses-sdk android:minSdkVersion="${minSdk}" android:targetSdkVersion="${targetSdk}" />
    <uses-feature android:glEsVersion="0x00020000" android:required="true" />
    <application android:label="${label}"
        android:hasCode="${hasCode}"
        android:extractNativeLibs="true"
        android:hardwareAccelerated="true">
        <activity android:name="${activity}"
            android:exported="true"
            android:label="${label}"
            android:screenOrientation="${orientation}"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|screenLayout|smallestScreenSize|uiMode|density">
            <meta-data android:name="android.app.lib_name" android:value="${nativeName}" />
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`);
  ok(`已生成（NativeActivity · lib_name=${nativeName} · hasCode=${hasCode}）`);
}

// ---------- 3. 资源 ----------
step(3, "编译资源");
const resDir = path.join(PROJ, "res");
const resZip = path.join(BUILD, "res.zip");
let hasRes = false;
if (fs.existsSync(resDir)) {
  aapt2(["compile", "--dir", resDir, "-o", resZip]);
  hasRes = true;
  ok(`res/ → ${mb(fs.statSync(resZip).size)}`);
} else warn("无 res/，跳过");

// ---------- 4. 链接 ----------
step(4, "链接 APK");
const unsigned = path.join(BUILD, "unsigned.apk");
const linkArgs = ["link", "-o", unsigned, "-I", ANDROID_JAR, "--manifest", manifest,
  "--min-sdk-version", String(minSdk), "--target-sdk-version", String(targetSdk)];
if (hasRes) linkArgs.push(resZip);
const assetsDir = path.join(PROJ, "assets");
if (fs.existsSync(assetsDir)) { linkArgs.push("-A", assetsDir); ok("已包含 assets/"); }
aapt2(linkArgs);
ok(`unsigned.apk ${mb(fs.statSync(unsigned).size)}`);

// ---------- 5. 附加原生库 ----------
step(5, "附加内容并签名");
const extra = [];
if (soBuilt && fs.existsSync(soOut)) {
  extra.push({ name: `lib/arm64-v8a/lib${nativeName}.so`, data: fs.readFileSync(soOut), method: 0 });
}
const prebuilt = path.join(PROJ, "lib");
if (fs.existsSync(prebuilt)) {
  for (const abi of fs.readdirSync(prebuilt)) {
    const d = path.join(prebuilt, abi);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) extra.push({ name: `lib/${abi}/${f}`, data: fs.readFileSync(path.join(d, f)), method: 0 });
  }
}
const dex = path.join(PROJ, "classes.dex");
if (fs.existsSync(dex)) { extra.push({ name: "classes.dex", data: fs.readFileSync(dex), method: 8 }); ok("已包含 classes.dex"); }
for (const e of extra) if (e.name.endsWith(".so")) ok(`${e.name}  ${mb(e.data.length)}`);

const r = signApk(unsigned, OUT, extra);
ok(`已签名 by ${r.signer} · ${r.entries} 个条目 · ${mb(r.size)}`);

// ---------- 6. 安装 / 启动 ----------
step(6, "完成");
console.log(`\n   ${C.g}${C.b}APK: ${OUT}${C.x}\n`);

const sh = (cmd) => {
  try { return execFileSync("/data/user/0/com.deepseek.harness/files/payload/bin/priv", [cmd + " 2>&1"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (e) { return ((e.stdout || "") + (e.stderr || "")).trim(); }
};
if (flags.has("--install") || flags.has("--launch")) {
  const staged = `/sdcard/DeepSeekHarness/mkapk/${path.basename(OUT)}`;
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.copyFileSync(OUT, staged);
  const out = sh(`cp "${staged}" /data/local/tmp/_b.apk && pm install -r /data/local/tmp/_b.apk`);
  if (!/Success/i.test(out)) die("安装失败: " + out.split("\n").slice(-2).join(" "));
  ok(`已安装到设备 (${packageName})`);
}
if (flags.has("--launch")) {
  const comp = sh(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${packageName} | tail -1`);
  sh(`am start -n ${comp}`);
  ok(`已启动 ${comp}`);
}
