# 在 Android 上跑 Linux CLI 工具 · 可用性矩阵

> 全部条目**经本机实测**，不是"理论上可以"。
> 设备：Lenovo TB320FC · Android 15 · aarch64 · Snapdragon 8+ Gen 1 · 无 root（Shizuku 提权）
> 结论核对日期：2026-09-27

---

## 一、判据：为什么有的能跑有的不能

跑通 Blender、Claude Code、Godot 与下面这一批工具之后，规律很清楚 ——
**能不能跑取决于链接方式，而不是"是不是 Linux 程序"**。

| 类型 | 能否直接跑 | 实测证据 |
|---|---|---|
| **Rust musl 静态** | ✅ **零配置，`chmod +x` 就跑** | `typst` `ripgrep` `fd` `bat` |
| **Go 完全静态** | ⚠️ 看它用不用受限 syscall | `yq` ✅ / `lazygit` ❌ `SIGSYS` |
| **musl 动态** | ❌ 缺 `/lib/ld-musl-aarch64.so.1` | `duckdb` 的 musl 版 |
| **glibc 动态** | ✅ 需要一个 glibc 运行时前缀 | `duckdb`(gnu) `astcenc` `magick` |

### ⚠️ 最重要的一条：静态 ≠ 能跑

`lazygit` 是**完全静态**的（无 `PT_INTERP`、无 `PT_DYNAMIC`），一跑就死：

```
SIGSYS: bad system call
```

**Android 的 seccomp 策略拦掉了它用的系统调用。**
光看 `file` 输出判断不出来 —— **必须真跑一次 `--version`，这步不能省。**

### 选型优先级

| 优先级 | 做法 | 成本 |
|---|---|---|
| **1** | Rust musl 静态构建 | 下载 + chmod |
| **2** | Debian 包（用本仓库的 `debtool.mjs`） | 一行命令，依赖自动解 |
| **3** | 官方 glibc arm64 构建 | 需配 glibc 前缀 |
| **4** | 自己编译（`cc4` / Debian GCC） | 最高 |

**额外一条经验**：同一个仓库如果同时发 `musl` 和 `gnu` 两个版本，**musl 跑不了就换 gnu**。
`duckdb` 就是这样救回来的 —— musl 版缺加载器，gnu 版直接跑通。

---

## 二、实测通过的清单

### A. 零配置档（静态，`chmod +x` 即用）

| 命令 | 版本 | 体积 | 用途 |
|---|---|---|---|
| `typst` | 0.15.1 | 15.5 MB | **现代排版引擎**，出 PDF（含公式） |
| `rg` | 15.2.0 | 1.9 MB | ripgrep，极速文本搜索 |
| `fd` | 10.5.0 | 1.4 MB | 找文件（比 `find` 好用） |
| `bat` | 0.26.1 | 3.2 MB | 带语法高亮的 `cat` |
| `yq` | 4.53 | 12.6 MB | YAML / JSON 处理 |

下载源：各项目 GitHub Releases 的 `aarch64-unknown-linux-musl` 资产。

### B. glibc 档（需 glibc 运行时前缀）

| 命令 | 版本 | 体积 | 用途 | 需要的库 |
|---|---|---|---|---|
| `duckdb` | 1.5.5 | 51.8 MB | **分析型数据库**（百万行 CSV / Parquet） | libc, libdl, libgcc_s, libm |
| `astcenc` | 5.7.0 | 3.7 MB | **ASTC 纹理压缩**（ARM 官方） | libc, libgcc_s, libm, libstdc++ |

### C. Debian 档（`debtool.mjs install`）

| 命令 | 用途 | 安装的包 |
|---|---|---|
| `magick` / `convert` / `identify` | **ImageMagick 7** 图像处理 | `imagemagick` |
| `pyftsubset` / `ttx` / `fonttools` | **字体子集化**、字体转 XML | `fonttools` |

---

## 三、踩过的坑（都是实测撞出来的）

### 1. `astcenc` 的三个变体只跑得了一个

```
astcenc-neon      ✅
astcenc-sve_128   ❌ Host does not support SVE ISA extension
astcenc-sve_256   ❌ 同上
```

**Snapdragon 8+ Gen 1 是 ARMv8.2，没有 SVE**（SVE 要 ARMv9）。
官方包同时发三个变体，**必须选 neon**。

### 2. `duckdb` 的 musl 版是**动态链接**的

名字里带 `musl` 让人以为是静态，实际有 `PT_INTERP: /lib/ld-musl-aarch64.so.1`，
而系统里没有这个加载器。**换 gnu 版即可。**

### 3. ImageMagick 的**两个**编译期路径都要覆盖

Debian 的 ImageMagick 二进制叫 `magick-im7.q16`（不叫 `magick`），而且：

```
报 UnableToOpenConfigureFile `delegates.xml'   → 要设 MAGICK_CONFIGURE_PATH
报 NoDecodeDelegateForThisImageFormat `PNG'    → 还要设 MAGICK_CODER_MODULE_PATH
```

**只设第一个不够** —— 会从"找不到配置"变成"找不到编解码器"。

### 4. `pyftsubset` / `ttx` 不是 ELF，是 Python 脚本

```
$ ld-linux ... pyftsubset
pyftsubset: invalid ELF header
```

它们是 `#! /usr/bin/python3` 的脚本，**必须用 Python 解释器跑**，
不能套 glibc 加载器。

### 5. 经 glibc 加载器启动时，`current_exe()` 返回的是**加载器**的路径

装 helix 时发现的。helix 用自己的二进制位置定位 `runtime/` 数据目录，
但我们是用 `ld-linux ... hx` 启动的，于是它拿到的是加载器的路径：

```
Runtime directory does not exist: <glibc 前缀>/glibc/lib/runtime
```

结果：**所有语言支持全部失效**（`hx --health` 里全是 ✘）。

解法是用该工具自己的环境变量显式指定（helix 是 `HELIX_RUNTIME`）。
`addcli` 会自动识别并在包装脚本里注入。

> 这类"数据目录在二进制旁边"的工具都要注意：neovim(`VIMRUNTIME`)、
> 各种带 `share/` 的工具同理。

### 6. `lazygit` 的 `SIGSYS`（见上）

Go 工具在 Android 上不保证能用。**同类的 `yq` 可以，`lazygit` 不行。**

---

## 四、包装脚本模式

本仓库对应的包装脚本放在设备的 `payload/bin/`。三种模式：

### 静态（最简单，其实可以不要包装）

```sh
#!/system/bin/sh
exec /path/to/real/binary "$@"
```

### glibc 动态

```sh
#!/system/bin/sh
# ⚠️ 绝不能把 bionic 库混进搜索路径（会报 version 'LIBC' not found）
unset LD_LIBRARY_PATH LD_PRELOAD LD_DEBUG
exec "$GLIBC_PREFIX/glibc/lib/ld-linux-aarch64.so.1" \
  --library-path "$GLIBC_PREFIX/glibc/lib" /path/to/real "$@"
```

### Debian 侧（要额外带 Debian 的库目录 + 配置路径）

见上面 ImageMagick 那条 —— **编译期路径假设是主要坑源**。

---

## 五、明确不建议的

| 工具 | 原因 |
|---|---|
| `zellij` / `tmux` / `starship` / `zoxide` | 依赖**交互式终端**（PTY）。DSH 的 bash 是一次性调用，没有场景 |
| `meshlab` / `kicad` / `freecad` / `librecad` | Debian 都有，但**都是 GUI 程序**，设备无 X11 |
| 任何需要 `/tmp` 可写的 | Android 的 `/tmp` 应用写不进（属 shell + SELinux） |

---

## 六、怎么加新工具

### 用 addcli（推荐）

```sh
addcli <owner/repo>
```

它按上面的优先级自动挑资产、下载、**试跑验证**、安装。
失败会自动换下一个候选 —— 不用手工一个个试。

常用参数：

| 参数 | 作用 |
|---|---|
| `--list` | 只列候选与评分，不下载 |
| `--name foo` | 指定安装后的命令名 |
| `--tag v1.2.3` | 指定版本 |
| `--runtime-env KEY` | 该工具用什么环境变量指定数据目录 |

### 手工流程

1. **先看有没有 `aarch64-unknown-linux-musl` 资产** → 有就下，`chmod +x`，跑 `--version` 验
2. **没有再试 Debian**（`node tools/debtool.mjs install <包名>`）
3. **还没有就找官方 glibc arm64 构建**，按上面的包装模式配
4. **最后才考虑自己编译**

**第 1 步的 `--version` 验跑不能省** —— `SIGSYS` 那类坑只有跑一次才暴露。

---

## 七、合规

本矩阵只涉及**工具本身能否运行**的技术事实，不涉及任何绕过授权的内容。
所有列出的工具均为各自项目的公开发行版，按其原始许可使用。
