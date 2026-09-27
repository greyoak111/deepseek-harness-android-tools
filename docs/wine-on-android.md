# 在无 root 安卓上跑 Windows 程序 —— 完整实现笔记

> 设备：Lenovo TB320FC · Android 15 · Snapdragon 8+ Gen 1 · Adreno 730 · **无 root**
> 运行时身份：普通应用（uid 10361），SELinux enforcing，seccomp filter 已装
> 最后核对：2026-09-27

---

## 一、结论摘要

**能在安卓上跑 Windows 程序，图形走 Wayland，单次启动约 10 秒（热 prefix 约 1 秒）。**

```
Windows PE (x86 / x86_64)
   ↓  Hangover wine 11.16（aarch64 原生 —— 整个 Wine 不经翻译）
   ↓  FEX 或 WowBox64（只翻译程序自身的 x86 代码）
   ↓  ARM64 安卓
   ↓  weston headless（Wayland）
```

用的是 [AndreRH/hangover](https://github.com/AndreRH/hangover)（⭐2045, LGPL-2.1），
发布包直接提供 **Debian 13 trixie arm64** 构建，正好匹配本机的 Debian root。

---

## 二、为什么选 Hangover，而不是「x86_64 Wine + box64」

|  | x86_64 Wine + box64 | **Hangover** |
|---|---|---|
| Wine 本体 | x86_64，**整体被翻译** | **aarch64 原生** |
| 被翻译的部分 | 整个 Wine | **只有程序自身的 x86 代码** |
| 32 位程序 | 需 box86（安卓上跑不起来） | **WoW64 原生支持** |
| 运行身份 | 需 shell 身份 | **应用身份即可**（能连 Wayland socket） |

作者原话：

> As soon as the application does a Windows/Wine system call, it's executed
> **outside the emulator** (native, fast). **Everything Unix related is never emulated.**

模拟器分工：

| DLL | 用途 |
|---|---|
| `libarm64ecfex.dll` | x86_64 模拟（FEX） |
| `libwow64fex.dll` | i386 模拟（FEX，**推荐**） |
| `wowbox64.dll` | i386 模拟（Box64，Hangover 默认） |

---

## 三、六个绕不开的补丁

安卓没有 `/lib/ld-linux-aarch64.so.1`，且应用身份受 SELinux 限制。
下面这些**全部已在 `wine/` 树里打好**：

| # | 改哪里 | 改成 | 为什么 |
|---|--------|------|--------|
| 1 | `usr/bin/wineserver` | `/tmp/.wine-%u` → `.wine-%u` | 应用身份写不进 `/tmp`；`TMPDIR` 无效（路径写死） |
| 2 | `usr/lib/wine/aarch64-unix/ntdll.so` | 同上 | 客户端要算出同一路径才能连上 server |
| 3 | `usr/bin/wineserver` | `%s/server-%llx-%llx` → `%s` | wine 只 chdir 到 `.wine-<uid>` 就找 `socket`，而 server 建在下一层 |
| 4 | `usr/lib/wine/aarch64-unix/wine` | **放一个 shell 脚本** | wine 回退时 exec 这个不存在的路径；脚本有 shebang，内核能直接执行 |
| 5 | `usr/lib/wine/aarch64-unix/wine-preloader` | **移走**（改名 `.disabled`） | 它的设计是「exec → 布置地址空间 → 再 exec 自己」，第二次必然失败 |
| 6 | 库搜索路径顺序 | 见第五节 | 加载器按序查找，目标在最后一条时要 stat 90 个目录 |

第 4 条的脚本内容：

```sh
#!/system/bin/sh
unset LD_LIBRARY_PATH LD_PRELOAD
export WINEDLLPATH=<wine>/usr/lib/wine
exec <glibc>/lib/ld-linux-aarch64.so.1 --library-path "<LIB>" \
     <wine>/usr/bin/wine "$@"
```

---

## 四、必需的运行环境变量

| 变量 | 值 | 说明 |
|---|---|---|
| `WINEPREFIX` | 档案的 prefix | |
| `WINEDLLPATH` | `<wine>/usr/lib/wine` | 否则按 `/proc/self/exe` 找模块会找错 |
| `WINELOADERNOEXEC` | `1` | 否则 wine exec 自己的 loader 会失败 |
| `HODLL` | `libwow64fex.dll` | 见第七节 |
| `FONTCONFIG_PATH` / `FONTCONFIG_FILE` | `<H>/fontconfig/...` | 见第六节 ① |
| `XDG_RUNTIME_DIR` / `WAYLAND_DISPLAY` | `<weston>/run` / `wayland-0` | 要图形时 |

**CWD 必须是 `WINEPREFIX`** —— wineserver 的 socket 与 nls 都按 CWD 查找。

启动器：`<glibc>/lib/ld-linux-aarch64.so.1 --library-path "<libpath-wine>" <wine>/usr/bin/wine`

---

## 五、最小 prefix

只需要两样，**不要主动跑 wineboot**：

```
nls/        ← cp -RL <wine>/usr/share/wine/nls
wine.inf    ← cp <wine>/usr/share/wine/wine.inf
```

wine 首次运行会自动执行 wineboot，生成完整 Windows 目录树与注册表
（实测 prefix 涨到 **2.2 GB**，其中 `system.reg` 3.3 MB），那一次约 10–14 秒。
之后的运行约 1 秒。

---

## 六、性能：三个坑，从 18 秒到 1 秒

### ① fontconfig 未配置 → wine 暴力扫描 209 个系统字体

症状是日志里持续出现：

```
Fontconfig error: Cannot load default config file: File not found
```

strace 会看到 wine 反复打开 `/system/fonts/` 下几百个 ttf。

**修复**：提供最小 `fonts.conf`，并设 `FONTCONFIG_PATH` + `FONTCONFIG_FILE`。

### ② 库搜索路径顺序不对（影响最大）

完整 `libpath.txt` 有 93 条路径。加载器**按顺序**查找 ——
目标库在最后一条时，每个库都要先 stat 90 个目录。
wine 要加载 100+ 个 DLL，累积十几秒。

**修复**：把下面三个提到最前（见 `libpath-wine.txt`，81 条）：

```
<glibc>/lib
<debroot>/usr/lib/aarch64-linux-gnu
<debroot>/usr/lib
```

### ③ 清理工具的匹配锚点错了（隐蔽）

`/proc/<pid>/cmdline` **上限 4096 字节**，而 wine 的 `--library-path` 参数极长，
**`wine` 二字根本没出现在可读部分** —— 按 `wine` 匹配永远失败，
残留进程越积越多（实测堆到 19 个）。

**修复**：锚点改用出现在**命令行开头**的加载器路径：

```
ld-linux-aarch64.so.1  ld-linux-armhf.so.3  wine-preloader
wineserver  winedevice  box64  box86
```

---

## 七、实测数据：性能稳定，不稳的是环境（已定案）

### A 组 —— 运行之间【不杀】wineserver

| 次数 | 耗时 | MemFree | Slab | PageTables | server 数 |
|---|---|---|---|---|---|
| 1 | 10.9s | 234MB | 734MB | 201MB | 1 |
| 2 | 10.2s | 245MB | 733MB | 201MB | 2 |
| 3 | 9.7s | 232MB | 733MB | 201MB | 3 |
| 4 | 10.8s | 356MB | 733MB | 202MB | 4 |
| 5 | 10.7s | 497MB | 732MB | 202MB | 5 |
| 6 | 9.7s | 533MB | 732MB | 202MB | 6 |

### B 组 —— 每次运行前【杀】wineserver 并重建

| 次数 | 耗时 | MemFree | server 数 |
|---|---|---|---|
| 1 | 11.0s | 227MB | 2 |
| 2 | 10.7s | 346MB | 1 |
| 3 | 10.1s | 305MB | 1 |
| 4 | 10.6s | 350MB | 1 |
| 5 | 10.5s | 552MB | 1 |
| 6 | 10.8s | 630MB | 1 |

### 结论

- **两组共 12 次运行全部成功，耗时集中在 9.7 – 11.0 秒，零退化。**
- **不是内存泄漏**：Slab 恒定 732–734MB，PageTables 恒定 201–202MB，
  MemFree 反而逐次上升（227 → 630MB）。
- 唯一真累积是 wineserver 数量，每个仅 14MB RSS，无害。
- **杀不杀 server 对速度没有影响** —— 关键是别留残骸。

### 那之前观察到的 45s / 150s 呢

对比"慢"与"快"两组实验的环境，**唯一实质差别是起始残留**：
慢的那次，系统里已有多个 wineserver，其中三个 VSZ 达 **10–11 GB**。
它们占着 `.wine-<uid>/socket`，新的 wine 连上的是**陈旧 server**，
于是又慢又像挂住。

**教训：性能波动先怀疑自己的运维操作，再怀疑软件。**
本次一度把残留进程造成的劣化误判为 wine/box64 缺陷，
并据此去查上游 issue、打补丁、设想修 `statx` —— 全是在错误方向上用力。

---

## 八、上游已知问题（查证结果）

### ✅ box64 #3813「Wine server directory name mismatch」—— 已修复

2026-09-26 维护者确认 *"this should be fixed now"*。
本机源码（commit `ac9b13a`）已包含修复，代码逐行查证：

```c
case 4:   S_RAX = my_stat(emu, ...);      // ✓ 有 struct stat 转换
case 5:   S_RAX = my_fstat(emu, ...);     // ✓
case 6:   S_RAX = my_lstat(emu, ...);     // ✓
case 262: S_RAX = my_fstatat(emu, ...);   // ✓
```

`UnalignStat64()` 逐字段拷贝，`st_ino` 正确；`x64_stat64` 布局与真实 x86_64 一致。

**遗留**：`statx` (332) **未处理**，会透传内核结果。

### 🟡 box64 #4285「Initialize memory before reading RC file」—— open

> "This fixes hangs when `.box64rc` file is provided."

根因：`BTCpuProcessInit()` 里 `InitializeEnvFiles()`（读 `.box64rc`）
在 `init_custommem_helper()`（内存分配器初始化）**之前**被调用。

**本机不适用** —— box64 查 `/etc/box64.box64rc`，而安卓的 `/etc` 是只读系统分区，
里面没有这个文件（那个 15KB 的 rc 在 `<debroot>/etc/`，box64 不会去那找）。

补丁已自己打上并经 CI 构建验证（见 `build-wowbox64.yml`），留着无害。

### 🟡 hangover #196「Freeze at startup」—— open

症状与本机曾观察到的一致。**作者建议：`HODLL=libwow64fex.dll`（改用 FEX）**。

---

## 九、strace 取证：所谓「死循环」是正常协议

曾把下面这个模式误判为死循环：

```
read(4,  "\0\0\0\0\0\0\0\0l\0...", 64) = 64
write(3, "\25\0\0\0\0\0\0\0\0\0\0\0h...", 64) = 64
```

**但成功的运行尾部也是同样模式**，并且：

```
socket(AF_UNIX, SOCK_STREAM, 0) = 4
connect(4, {sa_family=AF_UNIX, sun_path="socket"}, 9) = 0
recvmsg(4, ...)
```

**那就是 wine↔wineserver 的正常通信**；连接用的相对路径 `"socket"`
说明补丁 1/2/3 生效。

---

## 十、CI：绕过安卓无法做 PE 交叉编译的限制

**本机构建不了 `wowbox64.dll`** —— clang 编译时要 spawn `clang -cc1`，
而它靠 `/proc/self/exe` 定位自身；经 glibc 加载器调用时该值指向加载器。
这是无 root 安卓的硬约束（ELF 解释器路径须存在且 ≤26 字节）。

**解法**：GitHub Actions `ubuntu-24.04-arm` runner。
工作流见 `.github/workflows/build-wowbox64.yml`，实测全绿。
这套管线可复用于构建 box64 的任何组件。

---

## 十一、一软件一档案

```
wp.sh new <名字>                新建档案
wp.sh list                      列出
wp.sh run <名字> <程序> [参数]   运行
wp.sh sh <名字>                 进 wine cmd
wp.sh info <名字>               看配置
wp.sh rm <名字>                 删除
```

档案结构：

```
profiles/<名字>/
  profile.conf   PROGRAM / DXVK / WINEDLLOVERRIDES /
                 BOX64_DYNAREC_* / DISPLAY_BACKEND
  prefix/        该档案专属的 minimal prefix
```

设了 `DXVK=` 后会自动把 DLL 装进 prefix：
64 位 → `arm64ec` 进 `system32`，32 位 → `x32` 进 `syswow64`，
并自动加 `WINEDLLOVERRIDES=d3d8,d3d9,d3d10core,d3d11,dxgi=n,b`。

---

## 十二、DXVK

Hangover 发布包自带 **DXVK 2.7.1**，四种架构：
`arm64ec` / `x64` / `x32` / `aarch64`。Hangover 用 **arm64ec**。

---

## 十三、方法论教训

1. **看到 issue 标题「匹配」不等于命中** —— 必须验证前提条件。
   （曾误判 PR #4285 是根因，没验证 `.box64rc` 是否在查找路径上。）
2. **「看起来像死循环」要拿成功案例对照** —— 差点把正常协议通信当成 bug。
3. **性能波动先怀疑自己的运维操作**，再怀疑软件。
   （反复杀 wineserver 制造的脏状态，一度被当成 wine 的缺陷。）
4. **二分法是定位利器** —— 换个 x86 后端立刻把范围缩小。
5. **长任务丢后台**，前台干别的，出结果再取。
6. **清理进程的锚点**要用命令行开头的路径，别用会被 4096 截断的中间词。
7. **清理命令的匹配串会匹配到自己** —— 必须排除自身与整条祖先链。

---

## 十四、组件来源

| 组件 | 来源 | 许可 |
|---|---|---|
| Hangover wine | [AndreRH/hangover](https://github.com/AndreRH/hangover) | LGPL-2.1 |
| WowBox64 | 同上（内含 [ptitSeb/box64](https://github.com/ptitSeb/box64)） | MIT |
| FEX | [FEX-Emu/FEX](https://github.com/FEX-Emu/FEX) | MIT |
| DXVK | [doitsujin/dxvk](https://github.com/doitsujin/dxvk) | zlib |
| weston | [wayland/weston](https://gitlab.freedesktop.org/wayland/weston) | MIT |
| Turnip / Mesa | [freedreno](https://gitlab.freedesktop.org/mesa/mesa) | MIT |
| llvm-mingw | [mstorsjo/llvm-mingw](https://github.com/mstorsjo/llvm-mingw) | MIT |

包版本：`hangover-11.16`（Debian 13 trixie arm64）。
