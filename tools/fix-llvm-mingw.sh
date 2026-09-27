#!/system/bin/sh
# fix-llvm-mingw.sh —— 让 llvm-mingw 在安卓上可用
#
# 问题：llvm-mingw 的 clang 是为 Ubuntu 22.04 编的，解释器是
#       /lib/ld-linux-aarch64.so.1 —— 安卓上没有这个文件。
#       而 clang 还靠【自身路径】推导 InstalledDir / resource-dir / sysroot，
#       经加载器调用时这些都会指向加载器目录，导致找不到自己的资源。
#
# 解法（与修 wine-preloader 同一个手法）：
#   把 bin/clang 换成 shell 脚本 —— 脚本有 shebang，内核能直接执行；
#   由它经 glibc 加载器调用真身，并显式传入 -resource-dir 与 --sysroot。
set -e

D=/data/user/0/com.deepseek.harness/files
MGW="$D/llvm-mingw"
LIB=$(cat "$D/gtc/libpath.txt")
LD="$D/dshtc/prefix/glibc/lib/ld-linux-aarch64.so.1"

# clang 需要的库：libLLVM / libclang-cpp 在 $MGW/lib 下
CLANG_LIB="$MGW/lib:$LIB"
RES="$MGW/lib/clang/23"
SYSROOT="$MGW/aarch64-w64-mingw32"

echo "═══ 修正 llvm-mingw ═══"
echo "  clang 资源目录: $RES"
ls -d "$RES" >/dev/null 2>&1 || { echo "  ❌ 资源目录不存在"; exit 1; }
echo "  mingw sysroot:  $SYSROOT"
ls -d "$SYSROOT" >/dev/null 2>&1 || { echo "  ❌ sysroot 不存在"; exit 1; }

# 需要包一层的二进制
for b in clang clang++ clang-23 clang-cpp clang-format clang-scan-deps; do
  SRC="$MGW/bin/$b"
  [ -f "$SRC" ] || continue
  # 已经是脚本就跳过（幂等）
  if head -c 2 "$SRC" 2>/dev/null | grep -q '#!'; then
    echo "  · $b 已是脚本，跳过"
    continue
  fi
  [ -f "$SRC.real" ] || mv "$SRC" "$SRC.real"
  cat > "$SRC" <<EOF
#!/system/bin/sh
# 自动生成：经 glibc 加载器调用 clang 真身。
# 显式传 -resource-dir 与 --sysroot，因为经加载器调用时 clang 无法
# 从自身路径推导出它们（InstalledDir 会指向加载器目录）。
unset LD_PRELOAD
exec env LD_LIBRARY_PATH="$CLANG_LIB" \\
  "$LD" --library-path "$CLANG_LIB" \\
  "$SRC.real" -resource-dir "$RES" --sysroot="$SYSROOT" "\$@"
EOF
  chmod 755 "$SRC" 2>/dev/null
  echo "  ✅ $b 已包装"
done

# aarch64-w64-mingw32-clang 那个包装脚本会直接调 \$DIR/clang，
# 现在 \$DIR/clang 是我们的脚本，于是自动走通。
echo
echo "═══ 验证 ═══"
printf "  aarch64-w64-mingw32-clang --version: "
"$MGW/bin/aarch64-w64-mingw32-clang" --version 2>&1 | head -1 | sed 's/^/    /'
echo
echo "  编译一个 ARM64 PE 测试:"
T="$D/llvm-mingw-dl"
echo 'int main(){return 0;}' > "$T/t.c"
if "$MGW/bin/aarch64-w64-mingw32-clang" -o "$T/t.exe" "$T/t.c" 2>"$T/t.err"; then
  node -e 'const b=require("fs").readFileSync(process.argv[1]);
    console.log("    ✅ 产出 PE: machine=0x"+b.readUInt16LE(18).toString(16)+"  (0xaa64=ARM64)  大小 "+b.length+" 字节")' "$T/t.exe"
else
  echo "    ❌ 失败:"
  head -8 "$T/t.err" | sed 's/^/      /'
fi
