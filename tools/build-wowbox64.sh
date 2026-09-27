#!/system/bin/sh
# build-wowbox64.sh —— 构建打过 PR #4285 补丁的 wowbox64.dll
#
# 背景：
#   box64 PR #4285「[WOWBOX64] Initialize memory before reading RC file」
#   原文："This fixes hangs when .box64rc file is provided."
#   根因：BTCpuProcessInit() 里 InitializeEnvFiles()（读 .box64rc）
#         在 init_custommem_helper()（内存分配器初始化）【之前】被调用。
#   补丁已打在 src/wine/wow64/wowbox64.c（见该文件的注释）。
#
# 构建要点：
#   · wowbox64 是 PE DLL，由 box64 主 CMake 作为 ExternalProject 拉起来
#     条件是 -DWOW64=ON 且 ARM_DYNAREC=ON
#   · 它用 wine/toolchain_mingw.cmake，需要 aarch64-w64-mingw32-clang / -as
#     → 用 llvm-mingw（自带 clang，静态链接，aarch64 Linux 原生可跑）
#   · 主工程仍用我们的 gtc/gcc（glibc 交叉工具链）
set -e

D=/data/user/0/com.deepseek.harness/files
OUT="$D/box64-build"
SRC="$OUT/src"
GT="$D/gtc"
SHIM="$GT/shim"
MGW="$D/llvm-mingw"
BLD="$OUT/build-wow64"

echo "═══ 构建 wowbox64.dll（含 PR #4285 补丁）═══"

# ---------- 1. 确认补丁在位 ----------
echo "(1) 检查补丁"
node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.argv[1],"utf8").split("\n");
const s=lines.findIndex(l=>l.includes("NTSTATUS WINAPI BTCpuProcessInit"));
let order=[];
for(let i=s;i<s+60&&i<lines.length;i++){
  const t=lines[i].trim();
  if(t.startsWith("//")||t.startsWith("*")||t.startsWith("/*")) continue;
  if(/^(LoadEnvVariables|InitializeSystemInfo|init_custommem_helper|InitializeEnvFiles)\(/.test(t))
    order.push(t.replace(/\(.*/,""));
}
const want=["LoadEnvVariables","InitializeSystemInfo","init_custommem_helper","InitializeEnvFiles"];
const ok=JSON.stringify(order)===JSON.stringify(want);
console.log("    调用顺序: "+order.join(" → "));
console.log("    "+(ok?"✅ 补丁在位":"❌ 补丁不对，期望 "+want.join(" → ")));
process.exit(ok?0:1);
' "$SRC/wine/wow64/wowbox64.c"
[ $? -eq 0 ] || { echo "  补丁未生效，终止"; exit 1; }

# ---------- 2. 确认 llvm-mingw ----------
echo "(2) 检查 llvm-mingw"
[ -d "$MGW/bin" ] || { echo "  ❌ 缺 $MGW（先把 tar.xz 解开到该目录）"; exit 1; }
export PATH="$MGW/bin:$PATH"
"$MGW/bin/aarch64-w64-mingw32-clang" --version 2>&1 | head -2 | sed 's/^/    /'

# ---------- 3. 配置（加 WOW64=ON）----------
echo "(3) 配置 CMake（WOW64=ON）"
rm -rf "$BLD" && mkdir -p "$BLD" && cd "$BLD"
"$OUT/tools/cmake" "$SRC" \
  -G Ninja -DCMAKE_BUILD_TYPE=Release -DARM64=ON \
  -DBOX32=ON -DBOX32_BINFMT=OFF -DNOGIT=ON \
  -DWOW64=ON \
  -DCMAKE_C_COMPILER="$GT/gcc" \
  -DCMAKE_MAKE_PROGRAM="$OUT/tools/ninja" \
  -DPython3_EXECUTABLE="$OUT/tools/python3" \
  -DCMAKE_AR="$SHIM/ar" -DCMAKE_RANLIB="$SHIM/ranlib" \
  -DCMAKE_NM="$SHIM/nm" -DCMAKE_STRIP="$SHIM/strip" -DCMAKE_OBJCOPY="$SHIM/objcopy" \
  > "$D/wow64-cfg.log" 2>&1 || { echo "  配置失败："; tail -20 "$D/wow64-cfg.log" | sed 's/^/    /'; exit 1; }
echo "    配置完成"

# 修 ninja 里写死的 cmake 绝对路径
node -e '
const fs=require("fs"),path=require("path");
const bld=process.argv[1], ok=process.argv[2]+"/tools/cmake";
const real="/data/user/0/com.deepseek.harness/files/deepseek work/blender/debroot/usr/bin/cmake";
const walk=(d,dep)=>{ if(dep>4) return;
  for(const e of fs.readdirSync(d,{withFileTypes:true})){
    const p=path.join(d,e.name);
    if(e.isDirectory()){ if(!/CMakeFiles\/.*\.dir/.test(p)) walk(p,dep+1); }
    else if(/\.(ninja|cmake|txt)$/.test(e.name)){
      let s; try{s=fs.readFileSync(p,"utf8");}catch(x){continue;}
      const b=s; s=s.split("\""+real+"\"").join(ok).split(real).join(ok);
      if(s!==b) fs.writeFileSync(p,s);
    }}};
walk(bld,0);' "$BLD" "$OUT" 2>/dev/null || true

# ---------- 4. 只构建 wowbox64 目标 ----------
echo "(4) 构建 wowbox64 目标（可能要几分钟）"
"$OUT/tools/cmake" --build . --target wowbox64 > "$D/wow64-build.log" 2>&1 || true

# ---------- 5. 找产物 ----------
echo "(5) 查找产物"
FOUND=$(find "$BLD" -name "wowbox64.dll" 2>/dev/null | head -1)
if [ -n "$FOUND" ]; then
  ls -l "$FOUND" | awk '{printf "    ✅ %s  %.1f MB\n", $NF, $5/1048576}'
  cp "$FOUND" "$D/wowbox64-patched.dll"
  echo "    已复制到 $D/wowbox64-patched.dll"
else
  echo "    ❌ 没找到 wowbox64.dll，错误摘要："
  grep -E "error|Error|FAILED" "$D/wow64-build.log" 2>/dev/null | head -12 | sed 's/^/      /'
fi
echo "═══ 完成 ═══"
