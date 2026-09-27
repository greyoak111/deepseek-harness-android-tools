#!/system/bin/sh
# wp.sh —— Wine Profile 管理器（一软件一档案）
#
# 设计要点（来自实测）：
#   · 每个游戏一个独立 minimal prefix —— 避免状态污染导致 wine 挂住
#   · 每个档案可独立指定 DXVK 版本、驱动、DLL 覆盖、box64 调优
#   · 启动时自动起 wineserver（socket 按 CWD 找）
#
# 用法:
#   wp.sh new <名字>              新建档案
#   wp.sh list                    列出档案
#   wp.sh run <名字> <程序> [参数]  运行
#   wp.sh sh <名字>               进该档案的 wine cmd
#   wp.sh rm <名字>               删除档案
#   wp.sh info <名字>             看档案配置
set -e

D=/data/user/0/com.deepseek.harness/files
H="$D/hangover"
P="$D/dshtc/prefix"
LD="$P/glibc/lib/ld-linux-aarch64.so.1"
WINE="$H/wine/usr/bin/wine"
WINESERVER="$H/wine/usr/bin/wineserver"
WD="$H/wine/usr/lib/wine"
PROFILES="$H/profiles"
# 库搜索路径：用精简且重排过的版本（glibc 与 debroot 库目录在最前）。
# 实测：用完整 libpath.txt（93 条）时 wine 每次要 stat 90 个目录才命中，
# 单次启动 18 秒；重排后降到 1 秒。见 libpath-wine.txt。
LIBF="$H/libpath-wine.txt"
[ -f "$LIBF" ] || LIBF="$D/gtc/libpath.txt"
LIB=$(cat "$LIBF")

_need_name() { [ -n "$1" ] || { echo "wp: 需要档案名" >&2; exit 2; }; }

cmd_new() {
  n="$1"; _need_name "$n"
  P_DIR="$PROFILES/$n"
  [ -e "$P_DIR" ] && { echo "wp: 档案 $n 已存在" >&2; exit 1; }
  mkdir -p "$P_DIR/prefix"
  # minimal prefix 只需要 nls 与 wine.inf
  cp -RL "$H/wine/usr/share/wine/nls" "$P_DIR/prefix/nls"
  cp "$H/wine/usr/share/wine/wine.inf" "$P_DIR/prefix/"
  # 档案配置
  cat > "$P_DIR/profile.conf" <<CONF
# Wine Profile: $n
# 建立于 $(date '+%Y-%m-%d %H:%M:%S')

# 该档案的 Windows 程序（相对 profile 目录或绝对路径）
PROGRAM=""

# DXVK 版本（留空 = 不用 DXVK，走 wine 内置 wined3d）
# 可选: $H/dxvk/dxvk-v2.7.1
DXVK=""

# DXVK 架构子目录: x64 / x32 / arm64ec / aarch64
DXVK_ARCH="arm64ec"

# DLL 覆盖（逗号分隔），例如 "d3d11=n,b;dxgi=n,b"
WINEDLLOVERRIDES=""

# box64 调优（传给 WowBox64）
BOX64_DYNAREC_STRONGMEM=""
BOX64_DYNAREC_BIGBLOCK=""

# 显示：留空 = 无图形（命令行程序）；wayland = 接 weston
DISPLAY_BACKEND=""
CONF
  echo "✅ 档案已建立: $n"
  echo "   路径: $P_DIR"
  echo "   配置: $P_DIR/profile.conf"
}

cmd_list() {
  [ -d "$PROFILES" ] || { echo "（还没有档案）"; return; }
  i=0
  for d in "$PROFILES"/*/; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    p=$(grep -m1 '^PROGRAM=' "$d/profile.conf" 2>/dev/null | cut -d= -f2- | tr -d '"')
    x=$(grep -m1 '^DXVK=' "$d/profile.conf" 2>/dev/null | cut -d= -f2- | tr -d '"')
    printf "  %-20s 程序=%-28s DXVK=%s\n" "$n" "${p:-（未设）}" "$([ -n "$x" ] && basename "$x" || echo 无)"
    i=$((i+1))
  done
  [ $i -eq 0 ] && echo "  （还没有档案）"
  return 0
}

_load_conf() {
  # 读配置到环境（安全：只认已知键）
  CONF="$PROFILES/$1/profile.conf"
  [ -f "$CONF" ] || { echo "wp: 档案 $1 不存在" >&2; exit 1; }
  PROGRAM=""; DXVK=""; DXVK_ARCH="arm64ec"; WINEDLLOVERRIDES=""
  BOX64_DYNAREC_STRONGMEM=""; BOX64_DYNAREC_BIGBLOCK=""; DISPLAY_BACKEND=""
  while IFS= read -r line; do
    case "$line" in
      PROGRAM=*)              PROGRAM=$(printf '%s' "${line#PROGRAM=}" | tr -d '"') ;;
      DXVK=*)                 DXVK=$(printf '%s' "${line#DXVK=}" | tr -d '"') ;;
      DXVK_ARCH=*)            DXVK_ARCH=$(printf '%s' "${line#DXVK_ARCH=}" | tr -d '"') ;;
      WINEDLLOVERRIDES=*)     WINEDLLOVERRIDES=$(printf '%s' "${line#WINEDLLOVERRIDES=}" | tr -d '"') ;;
      BOX64_DYNAREC_STRONGMEM=*) BOX64_DYNAREC_STRONGMEM=$(printf '%s' "${line#BOX64_DYNAREC_STRONGMEM=}" | tr -d '"') ;;
      BOX64_DYNAREC_BIGBLOCK=*)  BOX64_DYNAREC_BIGBLOCK=$(printf '%s' "${line#BOX64_DYNAREC_BIGBLOCK=}" | tr -d '"') ;;
      DISPLAY_BACKEND=*)      DISPLAY_BACKEND=$(printf '%s' "${line#DISPLAY_BACKEND=}" | tr -d '"') ;;
    esac
  done < "$CONF"
}

_setup_dxvk() {
  # DXVK 的 DLL 要按目标架构分别投放：
  #   64 位游戏 → arm64ec（或 x64）→ drive_c/windows/system32
  #   32 位游戏 → x32               → drive_c/windows/syswow64
  # 只放 system32 的话对 32 位程序无效。
  [ -n "$DXVK" ] || return 0
  PFX="$PROFILES/$1/prefix"
  S32="$PFX/drive_c/windows/system32"
  S64="$PFX/drive_c/windows/syswow64"
  mkdir -p "$S32" "$S64"
  n=0

  _put() {  # _put <源目录> <目标目录>
    [ -d "$1" ] || return 0
    for f in "$1"/*.dll; do
      [ -f "$f" ] || continue
      cp -f "$f" "$2/$(basename "$f")" 2>/dev/null && n=$((n+1))
    done
  }

  # 64 位：优先 arm64ec（Hangover 的 ARM64EC ABI），回退 x64
  if   [ -d "$DXVK/arm64ec" ]; then _put "$DXVK/arm64ec" "$S32"
  elif [ -d "$DXVK/x64" ];     then _put "$DXVK/x64"     "$S32"
  fi
  # 32 位
  [ -d "$DXVK/x32" ] && _put "$DXVK/x32" "$S64"

  echo "   DXVK: 装入 $n 个 DLL（64位→system32，32位→syswow64）"
  # 必须加 DLL 覆盖，否则 wine 用内置 d3d 实现，DXVK 不生效
  DXVK_OVERRIDES="d3d8,d3d9,d3d10core,d3d11,dxgi=n,b"
}

_server_alive() {
  # 注意：不能只看 socket 文件是否存在 ——
  # wineserver 死掉后 socket 文件会残留，造成假阳性，
  # 于是不重启 server，wine 就报「could not exec wineserver」或直接挂住。
  # 判据改用 pid 文件 + 进程是否真的还在。
  WDIR="$1/.wine-$(id -u)"
  [ -f "$WDIR/pid" ] || return 1
  P=$(cat "$WDIR/pid" 2>/dev/null)
  [ -n "$P" ] || return 1
  kill -0 "$P" 2>/dev/null
}

_ensure_server() {
  PFX="$1"
  # 运行前清掉残留 wine 进程 —— 否则它们占住 wineserver，新 wine 连上会卡。
  # 注意：清理脚本的匹配锚点必须用命令行【开头】的加载器路径，
  # 因为 /proc/<pid>/cmdline 有 4096 字节上限，wine 的 --library-path 极长，
  # "wine" 二字会被截断掉（这个坑害了我很久）。
  node "$D/killwine.mjs" >/dev/null 2>&1 || true
  WDIR="$PFX/.wine-$(id -u)"
  SOCK="$WDIR/socket"

  if _server_alive "$PFX"; then return 0; fi

  # server 不在了（可能只剩残留文件与 socket），清干净再起
  rm -rf "$WDIR" 2>/dev/null || true

  ( cd "$PFX" && nohup env -u LD_LIBRARY_PATH WINEPREFIX="$PFX" WINEDLLPATH="$WD" \
      "$LD" --library-path "$LIB" "$WINESERVER" -p > "$PFX/wineserver.log" 2>&1 & )
  i=0
  while [ ! -S "$SOCK" ] && [ $i -lt 40 ]; do sleep 0.5; i=$((i+1)); done
  [ -S "$SOCK" ] || { echo "wp: wineserver 未就绪" >&2; cat "$PFX/wineserver.log" >&2; return 1; }
  i=0
  while [ ! -f "$WDIR/pid" ] && [ $i -lt 20 ]; do sleep 0.5; i=$((i+1)); done
}

cmd_run() {
  n="$1"; shift
  _load_conf "$n"
  PROG="${1:-$PROGRAM}"
  if [ $# -gt 0 ]; then shift; fi
  [ -n "$PROG" ] || { echo "wp: 档案 $n 没设 PROGRAM，也没在命令行给程序" >&2; exit 2; }
  PFX="$PROFILES/$n/prefix"
  DXVK_OVERRIDES=""
  _setup_dxvk "$n" || true
  _ensure_server "$PFX"
  OV="$WINEDLLOVERRIDES"
  [ -n "$DXVK_OVERRIDES" ] && OV="${OV:+$OV;}$DXVK_OVERRIDES"
  # 显示后端：wayland = 接 weston；已实测 winewayland.so 能连上
  DISP_ENV=""
  if [ "$DISPLAY_BACKEND" = "wayland" ]; then
    DISP_ENV="XDG_RUNTIME_DIR=$D/weston-app/run WAYLAND_DISPLAY=wayland-0"
  fi
  cd "$PFX"
  unset LD_LIBRARY_PATH LD_PRELOAD
  exec env -u LD_LIBRARY_PATH \
    WINEPREFIX="$PFX" WINEDLLPATH="$WD" WINELOADERNOEXEC=1 \
    $DISP_ENV \
    ${OV:+WINEDLLOVERRIDES="$OV"} \
    ${BOX64_DYNAREC_STRONGMEM:+BOX64_DYNAREC_STRONGMEM="$BOX64_DYNAREC_STRONGMEM"} \
    ${BOX64_DYNAREC_BIGBLOCK:+BOX64_DYNAREC_BIGBLOCK="$BOX64_DYNAREC_BIGBLOCK"} \
    "$LD" --library-path "$LIB" "$WINE" "$PROG" "$@"
}

cmd_info() {
  n="$1"; _load_conf "$n"
  echo "  档案: $n"
  echo "  路径: $PROFILES/$n"
  echo "  prefix: $PROFILES/$n/prefix"
  echo "  程序: ${PROGRAM:-（未设）}"
  echo "  DXVK: ${DXVK:-无}  架构=${DXVK_ARCH}"
  echo "  DLL 覆盖: ${WINEDLLOVERRIDES:-无}"
}

cmd_rm() {
  n="$1"; _need_name "$n"
  [ -d "$PROFILES/$n" ] || { echo "wp: 档案 $n 不存在" >&2; exit 1; }
  rm -rf "$PROFILES/$n"
  echo "✅ 已删除档案: $n"
}

case "${1:-}" in
  new)  shift; cmd_new "$@" ;;
  list) cmd_list ;;
  run)  shift; cmd_run "$@" ;;
  sh)   shift; cmd_run "$1" cmd ;;
  info) shift; cmd_info "$@" ;;
  rm)   shift; cmd_rm "$@" ;;
  *) cat <<USAGE
wp.sh —— Wine Profile 管理器

  wp.sh new <名字>                新建档案
  wp.sh list                      列出档案
  wp.sh run <名字> <程序> [参数]   运行
  wp.sh sh <名字>                 进该档案的 wine cmd
  wp.sh info <名字>               看配置
  wp.sh rm <名字>                 删除

档案目录: $PROFILES/<名字>/
  profile.conf   配置（程序、DXVK、DLL 覆盖、box64 调优、显示后端）
  prefix/        该档案专属的 minimal wine prefix
USAGE
     exit 0 ;;
esac
