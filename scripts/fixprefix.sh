#!/system/bin/sh
# fixprefix.sh — tpkg 每次安装都会覆盖 prefix，装完必须跑一遍这个
# 作用：修 shebang + 重建 JVM/d8/apksigner 包装器（Termux 原版脚本的 shebang 指向不存在的路径）
P=/data/user/0/com.deepseek.harness/files/dshtc/prefix
J=$P/lib/jvm/java-17-openjdk

echo "== 1) 修 bin 下脚本的 shebang =="
n=0
for f in "$P"/bin/*; do
  [ -f "$f" ] || continue
  if head -c 2 "$f" 2>/dev/null | grep -q '#!'; then
    sed -i '1s|^#!.*|#!/system/bin/sh|' "$f" 2>/dev/null
    sed -i "s|/data/data/com.termux/files/usr|$P|g" "$f" 2>/dev/null
    n=$((n+1))
  fi
done
echo "   修正 $n 个脚本"

echo "== 2) 重建 JVM 包装器 =="
for t in java javac jar keytool jarsigner javap jdeps; do
  [ -x "$J/bin/$t" ] || continue
  cat > "$P/bin/$t" <<EOF
#!/system/bin/sh
export LD_LIBRARY_PATH="$P/lib"
export JAVA_HOME="$J"
exec "$J/bin/$t" "\$@"
EOF
  chmod 755 "$P/bin/$t"
done
echo "   java/javac/jar/keytool 就绪"

echo "== 3) 重建 d8 =="
cat > "$P/bin/d8" <<EOF
#!/system/bin/sh
exec "$P/bin/java" -cp "$P/share/java/d8.jar" com.android.tools.r8.D8 "\$@"
EOF
chmod 755 "$P/bin/d8"

echo "== 4) 重建 apksigner =="
if [ -f "$P/share/java/apksigner.jar" ]; then
  cat > "$P/bin/apksigner" <<EOF
#!/system/bin/sh
export LD_LIBRARY_PATH="$P/lib"
exec "$P/bin/java" -jar "$P/share/java/apksigner.jar" "\$@"
EOF
  chmod 755 "$P/bin/apksigner"
  echo "   apksigner 就绪"
fi

echo "== 完成 =="
