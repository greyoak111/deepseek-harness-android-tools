#!/system/bin/sh
# setup.sh —— 把仓库铺到可执行位置并修好权限
#
# 为什么需要这一步：
#   1) /sdcard 是 noexec，脚本在那里跑不起来
#   2) /sdcard 的 FUSE 不保存可执行位 —— 即使在原地 chmod 755，实际仍是 660
#   所以必须「拷出来 + chmod」，两步都不能省。
#
# 用法:
#   sh setup.sh [目标目录]        默认 $HOME/dsh-tools
set -e

SRC=$(cd "$(dirname "$0")" && pwd)
DEST="${1:-$HOME/dsh-tools}"

echo "源:   $SRC"
echo "目标: $DEST"
echo

mkdir -p "$DEST"
cp -RL "$SRC/." "$DEST/" 2>/dev/null || true
rm -rf "$DEST/.git"

# 关键的一步：chmod 必须在「非 /sdcard」的文件系统上做才生效
chmod 755 "$DEST/bin/"* 2>/dev/null || true
chmod 755 "$DEST/setup.sh" "$DEST/scripts/"*.sh 2>/dev/null || true

echo "✅ 完成"
echo
echo "把下面两行加进 shell 配置："
echo "    export PATH=\"$DEST/bin:\$PATH\""
echo "    export DSH_TOOLS_REPO=\"$DEST\""
echo
echo "重依赖（不在仓库里，需自行准备）："
echo "    GLIBC_PREFIX   glibc 前缀，含 bin/aapt2     （tpkg.mjs 可装）"
echo "    C4TC           C4droid NDK 工具链根目录"
echo
echo "验证：cc4 --version && mkapk"
