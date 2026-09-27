#!/system/bin/sh
# 解 llvm-mingw + 构建打过补丁的 wowbox64.dll
set -e
D=/data/user/0/com.deepseek.harness/files
DL="$D/llvm-mingw-dl"
MGW="$D/llvm-mingw"
TAR=$(ls "$DL"/*.tar.xz 2>/dev/null | head -1)

echo "═══ 1. 解包 llvm-mingw ═══"
if [ ! -d "$MGW/bin" ]; then
  [ -f "$TAR" ] || { echo "  ❌ 找不到 tar.xz"; exit 1; }
  ls -lh "$TAR" | awk '{print "  源: "$NF" "$5}'
  mkdir -p "$MGW"
  # xz 用 debian 的（安卓没有）
  XZ="$D/dshbl/debroot/usr/bin/xz"
  LIB=$(cat "$D/gtc/libpath.txt")
  LD="$D/dshtc/prefix/glibc/lib/ld-linux-aarch64.so.1"
  echo "  解压中…"
  env -u LD_LIBRARY_PATH "$LD" --library-path "$LIB" "$XZ" -d -c "$TAR" > "$DL/mgw.tar"
  ls -lh "$DL/mgw.tar" | awk '{print "  解出 tar: "$5}'
  echo "  展开中…"
  tar xf "$DL/mgw.tar" -C "$MGW" --strip-components=1
  rm -f "$DL/mgw.tar"
  echo "  ✅ 解包完成"
else
  echo "  已存在，跳过"
fi
ls "$MGW/bin/" 2>/dev/null | grep -E "aarch64-w64-mingw32-(clang|as|gcc)" | head -4 | sed 's/^/    /'

echo
echo "═══ 2. 验证交叉编译器能跑 ═══"
"$MGW/bin/aarch64-w64-mingw32-clang" --version 2>&1 | head -2 | sed 's/^/    /'
echo 'int main(){return 0;}' > "$DL/t.c"
"$MGW/bin/aarch64-w64-mingw32-clang" -o "$DL/t.exe" "$DL/t.c" 2>&1 | head -3 | sed 's/^/    /'
if [ -f "$DL/t.exe" ]; then
  node -e 'const b=require("fs").readFileSync(process.argv[1]);
    console.log("    ✅ 产出 PE: machine=0x"+b.readUInt16LE(18).toString(16)+"  (0xaa64=ARM64)")' "$DL/t.exe"
else
  echo "    ❌ 编译测试失败 —— 可能 glibc 版本不兼容，需要换 llvm-mingw 版本"
  exit 1
fi

echo
echo "═══ 3. 构建 wowbox64.dll（含 PR #4285 补丁）═══"
sh "$D/build-wowbox64.sh"
