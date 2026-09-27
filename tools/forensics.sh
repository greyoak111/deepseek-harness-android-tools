#!/system/bin/sh
# forensics.sh —— 抓 wine 第二次运行挂住时的完整现场
#
# 目标：搞清楚 fd 3/4 之间那个 64 字节死循环到底是什么，
#       以及第 1 次（成功）与第 2 次（挂住）的差异在哪。
set -e
D=/data/user/0/com.deepseek.harness/files
H=$D/hangover
P=$D/dshtc/prefix
LD="$P/glibc/lib/ld-linux-aarch64.so.1"
WD="$H/wine/usr/lib/wine"
FD="$H/fontconfig"
STRACE="$D/dshbl/debroot/usr/bin/strace"
NEW=$(cat "$H/libpath-wine.txt")
PFX="$H/pfx-forensic"
OUT="$H/forensics"
mkdir -p "$OUT"

echo "═══ 取证开始 $(date '+%H:%M:%S') ═══"

# 清场
node "$D/killwine.mjs" >/dev/null 2>&1 || true
sleep 2
rm -rf "$PFX"; mkdir -p "$PFX"
cp -RL "$H/wine/usr/share/wine/nls" "$PFX/nls"
cp "$H/wine/usr/share/wine/wine.inf" "$PFX/"

cd "$PFX"
nohup env -u LD_LIBRARY_PATH WINEPREFIX="$PFX" WINEDLLPATH="$WD" \
  "$LD" --library-path "$NEW" "$H/wine/usr/bin/wineserver" -p > "$PFX/ws.log" 2>&1 &
sleep 10
echo "wineserver socket: $(ls "$PFX/.wine-10361" 2>/dev/null | tr '\n' ' ')" > "$OUT/00-setup.txt"

RUN() {  # RUN <tag> <额外env>
  tag="$1"; shift
  echo "--- $tag 开始 $(date '+%H:%M:%S') ---"
  env -u LD_LIBRARY_PATH WINEDEBUG=-all HODLL=libwow64fex.dll \
    FONTCONFIG_PATH="$FD" FONTCONFIG_FILE="$FD/fonts.conf" \
    WINEPREFIX="$PFX" WINEDLLPATH="$WD" WINELOADERNOEXEC=1 \
    "$@" \
    "$LD" --library-path "$NEW" "$STRACE" -f -tt -s 200 \
    -e trace=read,write,openat,connect,recvmsg,sendmsg,futex,socket,bind,accept \
    "$LD" --library-path "$NEW" "$H/wine/usr/bin/wine" cmd /c "echo ===$tag===" \
    > "$OUT/$tag.log" 2>&1 &
  echo $! > "$OUT/$tag.pid"
}

RUN run1
echo "等第 1 次（预期成功）…"
for i in $(seq 1 60); do
  grep -q "===run1===" "$OUT/run1.log" 2>/dev/null && break
  sleep 2
done
echo "第 1 次: $(grep -c '===run1===' "$OUT/run1.log" 2>/dev/null || echo 0) 次命中"
wc -l < "$OUT/run1.log" | awk '{print "  日志行数: "$1}'

# 保留 wineserver，跑第 2 次
RUN run2
echo "等第 2 次（预期挂住）…"
for i in $(seq 1 45); do
  grep -q "===run2===" "$OUT/run2.log" 2>/dev/null && { echo "第 2 次成功"; break; }
  sleep 2
done
if ! grep -q "===run2===" "$OUT/run2.log" 2>/dev/null; then
  echo "第 2 次未完成 —— 这正是要抓的现场"
fi
wc -l < "$OUT/run2.log" | awk '{print "  日志行数: "$1}'

# ---------- 现场分析 ----------
echo
echo "═══ 现场分析 ═══"

# 1. 第 2 次日志的尾部模式
echo "[1] run2.log 尾部 20 行:"
tail -20 "$OUT/run2.log" | cut -c1-150 > "$OUT/01-run2-tail.txt"
cat "$OUT/01-run2-tail.txt"

# 2. fd 3 和 4 是什么
echo
echo "[2] run2 里 fd 3/4 的来历（找 open/socket 建立它们的行）:"
grep -nE "= (3|4)$|= 3$|= 4$|socket\(|connect\(" "$OUT/run2.log" 2>/dev/null | head -20 | cut -c1-150 > "$OUT/02-fd-origin.txt"
cat "$OUT/02-fd-origin.txt"

# 3. 死循环模式的精确统计
echo
echo "[3] run2 尾部 2000 行的系统调用分布:"
tail -2000 "$OUT/run2.log" 2>/dev/null | grep -oE "^[0-9:.]+ [a-z_]+\(" | awk '{print $2}' | sort | uniq -c | sort -rn | head -8 > "$OUT/03-syscall-hist.txt"
cat "$OUT/03-syscall-hist.txt"

# 4. 对比两次的差异
echo
echo "[4] 两次运行的行数与结尾对比:"
{
  echo "run1 行数: $(wc -l < "$OUT/run1.log")"
  echo "run2 行数: $(wc -l < "$OUT/run2.log")"
  echo "run1 尾部:"; tail -3 "$OUT/run1.log" | cut -c1-140
  echo "run2 尾部:"; tail -3 "$OUT/run2.log" | cut -c1-140
} > "$OUT/04-compare.txt"
cat "$OUT/04-compare.txt"

# 5. 进程现场
echo
echo "[5] 挂住时的进程状态:"
node -e '
const fs=require("fs");
const rows=[];
for(const d of fs.readdirSync("/proc")){
  if(!/^\d+$/.test(d)) continue;
  try{
    const c=fs.readFileSync(`/proc/${d}/cmdline`,"utf8").replace(/\0/g," ").trim();
    if(!c||!/(ld-linux|wineserver)/.test(c)) continue;
    const st=fs.readFileSync(`/proc/${d}/stat`,"utf8");
    const f=st.slice(st.lastIndexOf(")")+2).split(" ");
    // 打开的文件描述符
    let fds=[];
    try{ fds=fs.readdirSync(`/proc/${d}/fd`).filter(x=>/^\d+$/.test(x)).slice(0,12); }catch(e){}
    const links=fds.map(fd=>{ try{ return fd+"→"+fs.readlinkSync(`/proc/${d}/fd/${fd}`).slice(0,48); }catch(e){ return fd+"→?"; } });
    rows.push(`pid ${d} 状态=${f[0]} cpu=${((Number(f[11])+Number(f[12]))/100).toFixed(1)}s\n    fds: ${links.join("  ")}`);
  }catch(e){}
}
console.log(rows.length?rows.join("\n"):"  （无相关进程）");
' > "$OUT/05-procs.txt" 2>&1
cat "$OUT/05-procs.txt"

# 6. box64 内部日志（若能）
echo
echo "[6] 用 BOX64_LOG=2 再跑一次，抓 box64 内部状态:"
node "$D/killwine.mjs" >/dev/null 2>&1 || true
sleep 3
rm -rf "$PFX"; mkdir -p "$PFX"
cp -RL "$H/wine/usr/share/wine/nls" "$PFX/nls"
cp "$H/wine/usr/share/wine/wine.inf" "$PFX/"
cd "$PFX"
nohup env -u LD_LIBRARY_PATH WINEPREFIX="$PFX" WINEDLLPATH="$WD" \
  "$LD" --library-path "$NEW" "$H/wine/usr/bin/wineserver" -p > "$PFX/ws.log" 2>&1 &
sleep 10
timeout 200 env -u LD_LIBRARY_PATH WINEDEBUG=-all HODLL=libwow64fex.dll BOX64_LOG=2 \
  FONTCONFIG_PATH="$FD" FONTCONFIG_FILE="$FD/fonts.conf" \
  WINEPREFIX="$PFX" WINEDLLPATH="$WD" WINELOADERNOEXEC=1 \
  "$LD" --library-path "$NEW" "$H/wine/usr/bin/wine" cmd /c "echo ===LOG2-1===" > "$OUT/06-log2-run1.log" 2>&1 || true
echo "  run1 完成: $(grep -c '===LOG2-1===' "$OUT/06-log2-run1.log" 2>/dev/null || echo 0) 次命中, $(wc -l < "$OUT/06-log2-run1.log") 行"
timeout 200 env -u LD_LIBRARY_PATH WINEDEBUG=-all HODLL=libwow64fex.dll BOX64_LOG=2 \
  FONTCONFIG_PATH="$FD" FONTCONFIG_FILE="$FD/fonts.conf" \
  WINEPREFIX="$PFX" WINEDLLPATH="$WD" WINELOADERNOEXEC=1 \
  "$LD" --library-path "$NEW" "$H/wine/usr/bin/wine" cmd /c "echo ===LOG2-2===" > "$OUT/06-log2-run2.log" 2>&1 || true
echo "  run2 完成: $(grep -c '===LOG2-2===' "$OUT/06-log2-run2.log" 2>/dev/null || echo 0) 次命中, $(wc -l < "$OUT/06-log2-run2.log") 行"
echo "  run2 尾部:"
tail -8 "$OUT/06-log2-run2.log" | cut -c1-140

echo
echo "═══ 取证结束 $(date '+%H:%M:%S') ═══"
echo "所有文件在 $OUT/"
ls -la "$OUT/" | awk '{printf "  %-28s %s\n", $NF, $5}'
