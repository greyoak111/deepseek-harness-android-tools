# deepseek-harness-android-tools

> **在无 root 安卓上跑 Windows 程序** —— 完整实现笔记见 [docs/wine-on-android.md](docs/wine-on-android.md)

**把一台安卓设备变成开发机的工具集** —— 在设备本地编译、打包、签名、管理依赖，不需要电脑。

这些工具是随 **[DeepSeek Harness 手机版](https://github.com/woaiys3/deepseek-harness-android-app)** 一起长出来的：
DSH 让 AI 能操作手机，这套工具让 AI 能在手机上**开发**。

```
DSH 安卓 App（woaiys3）       AI 的手和眼 —— Shizuku 特权、无障碍、虚拟屏
        └── 本仓库               AI 的工位 —— 编译器、打包器、包管理器
                └── 两个 CLI 项目   AI 的作品 —— 无头 Godot / Blender
```

---

## 这里面有什么

| 目录 | 内容 |
|---|---|
| `tools/` | 核心脚本（Node.js，无外部依赖，全部 vendored） |
| `bin/` | 包装脚本（拷进 PATH 即用） |
| `scripts/` | 环境修补脚本 |
| `tools/vendor/` | 内置依赖：`node-forge`（APK 签名加密）、`xz-decompress`（解 .deb） |

### 工具清单

| 脚本 | 用途 |
|---|---|
| `tools/mkapk.mjs` | **一键构建 APK** —— aapt2 编译资源 + GCC 编译 C + 自签 v2/v3 |
| `tools/apklib.mjs` | APK 读写与签名实现（v2/v3 签名方案） |
| `tools/apksign.mjs` | 独立的签名工具 |
| `tools/apkanalyze.mjs` | 解析 APK 结构、校验签名 |
| `tools/tpkg.mjs` | **Termux 包管理器** —— 解析依赖闭包、下载、解包 |
| `tools/debtool.mjs` | **Debian arm64 包管理器** —— 同上，面向 .deb |
| `tools/elfneed.mjs` | ELF 依赖分析（不需要 `readelf`） |
| `tools/unxz.mjs` | xz 解压（安卓自带工具链里没有任何 xz 解压器） |
| `tools/getjar.mjs` | 从 Maven 取 jar |
| `tools/localbridge.mjs` | **本地 HTTP 桥** —— 让 glibc 程序绕过 DNS 联网（见下） |
| `scripts/fixprefix.sh` | 修 Termux 前缀的 shebang 与硬编码路径 |

### 包装脚本（`bin/`）

| 命令 | 用途 |
|---|---|
| `cc4` / `cxx4` | C / C++ 编译（安卓原生目标，自动加 PIE） |
| `mk4` | make |
| `mkapk` | 构建 APK |
| `aapt2` | Android 资源打包 |

---

## 快速开始

### 1. 拷到可执行目录

```sh
# ⚠️ /sdcard 是 noexec 且 FUSE 不保存可执行位 —— 必须拷出来再 chmod
DEST="$HOME/dsh-tools"
mkdir -p "$DEST"
cp -RL /path/to/this/repo/. "$DEST/"
chmod 755 "$DEST/bin/"*
export PATH="$DEST/bin:$PATH"
```

> **这一步不能省。** 直接在 `/sdcard` 上跑会报 `Permission denied`；
> 即使在 `/sdcard` 上 `chmod 755` 也不生效（FUSE 不认，实测仍是 `660`）。

### 2. 装上重依赖（工具本体都很小，依赖很大）

```sh
# glibc 运行时 + 常用工具（aapt2 / java / apksigner 等）
node tools/tpkg.mjs install glibc openjdk-17 aapt2

# 装完必须跑一次，修 Termux 包硬编码的 shebang
sh scripts/fixprefix.sh
```

| 依赖 | 体积 | 说明 |
|---|---|---|
| glibc 前缀 | ~1.5 GB | Termux glibc 运行时 + 命令行工具（`GLIBC_PREFIX`） |
| C4droid NDK 工具链 | ~200 MB | `cc4` / `cxx4` / `mk4` 依赖（`C4TC`） |
| `android.jar` | ~26 MB | 编译安卓 App 必需 |

以上都不入仓库，需自行准备。路径用环境变量指定：

```sh
export GLIBC_PREFIX="$HOME/dsh-tools/prefix"
export C4TC="$HOME/c4tc"
```

### 3. 用

```sh
cc4 -O2 -o hello hello.c          # 编译一个安卓原生可执行文件
mkapk                              # 在当前目录找项目并构建 APK
node tools/debtool.mjs install blender python3-numpy   # 解析依赖并解包
node tools/elfneed.mjs ./hello     # 看它依赖哪些库
```

---

## 与 DSH 安卓 App 的关系

本仓库的工具**不依赖 DSH 也能单独使用**（只要有 `node`）。
但在 DSH 环境里，它们和 App 自带的插件是互补的：

| | [deepseek-harness-android-app](https://github.com/woaiys3/deepseek-harness-android-app) 的 `plugins/` | 本仓库 |
|---|---|---|
| 定位 | AI 的**手和眼** | AI 的**工位** |
| 内容 | `dsh-tool-shizuku`（特权 shell）、`dsh-tool-android`（包管理/设置/截图/输入）、`dsh-tool-accessibility`（读屏点击）、`dsh-tool-vscreen`（虚拟屏） | 编译器、打包器、签名器、包管理器 |
| 依赖 | Shizuku | Node.js + 本地工具链 |

**典型配合**：DSH App 提供 `priv` 提权通道 → 本仓库的脚本在特权下执行系统级操作
（如 `pm install` 装自己刚打出来的 APK）。

### 用它做出来的东西

| 项目 | 内容 |
|---|---|
| [godot-cli-on-android](https://github.com/greyoak111/godot-cli-on-android) | 无头 Godot + 一键导出 APK + GitHub Actions |
| [blender-cli-android](https://github.com/greyoak111/blender-cli-android) | Blender 无头 CLI + **GPU 加速渲染** |

两者合起来是一条完整的移动端管线：**Blender → glTF → Godot → APK → 装回本机**。

---

## 已知约束（都是实测踩出来的）

| # | 约束 | 后果 |
|---|---|---|
| 1 | **`/sdcard` noexec + 不保存可执行位** | 包装脚本必须拷出来再 `chmod` |
| 2 | **bionic 与 glibc 库不能混进同一搜索路径** | 报满屏 `version 'LIBC' not found` |
| 3 | **`/tmp` 普通应用写不进**（SELinux） | 临时文件写应用私有目录或 `/sdcard` |
| 4 | **Termux 包路径硬编码** | 装完必须跑 `scripts/fixprefix.sh` |
| 5 | **安卓没有 xz 解压器** | 所以内置了 `vendor/xz-decompress` |
| 6 | **应用身份不能执行 `/data/local/tmp` 里的文件** | 要么走 `priv`，要么放应用私有目录 |
| 7 | **`LD_LIBRARY_PATH` 会污染系统进程** | 包装脚本一律 `unset` 后再执行 |
| 8 | **glibc 程序无法解析域名** | 安卓无 `/etc/resolv.conf`，且 Termux glibc 硬编码了自己的路径。用 `localbridge.mjs` 绕过 |

---

## addcli —— 一条命令装 Linux CLI 工具

```sh
addcli sharkdp/fd              # 自动挑最佳资产、下载、试跑、安装
addcli duckdb/duckdb --list    # 只看候选，不下载
addcli helix-editor/helix      # 需要数据目录的会自动整棵树安装
```

它会**按可跑性排序候选，逐个试跑，失败自动换下一个**。实测 duckdb：

```
① duckdb_cli-linux-arm64-musl.zip   ❌ 需要 musl 加载器
② libduckdb-linux-arm64-musl.zip    ❌ 没有可执行文件（那是库）
③ duckdb_cli-linux-arm64-musl.gz    ❌ 需要 musl 加载器
④ static-libs-linux-arm64.zip       ❌ 里面没有可执行文件
⑤ duckdb_cli-linux-arm64.zip        ✅ v1.5.5   ← 自己找到了
```

### 它内置了哪些实测教训

| 教训 | 脚本里的对应 |
|---|---|
| **静态 ≠ 能跑**（lazygit 报 SIGSYS） | **强制真跑一次**才算验过，专门识别 seccomp 拦截 |
| musl 跑不了就换 gnu（duckdb） | 候选逐个试，**自动回退** |
| 安卓没有 xz 解压器 | 内置纯 JS 解压，并支持 `decompress()` 回退 |
| 有些"二进制"是 Python 脚本 | 先看魔数，是脚本就报错而非硬套加载器 |
| 通过加载器启动时 `current_exe()` 不可靠 | 自动识别数据目录并注入环境变量（如 `HELIX_RUNTIME`） |

> 第 5 条是装 helix 时发现的：经 glibc 加载器启动时，
> 程序拿到的 `current_exe()` 是**加载器**的路径，于是它去
> `<加载器目录>/runtime` 找数据 —— 永远找不到。必须显式指定。

---

## 哪些 Linux CLI 工具能在这台设备上跑

完整矩阵见 **[docs/cli-availability.md](docs/cli-availability.md)** —— 全部经本机实测。

**一句话判据：**

| 类型 | 能否直接跑 |
|---|---|
| Rust **musl 静态** | ✅ 下载即用（typst / ripgrep / fd / bat） |
| Go 完全静态 | ⚠️ 看 syscall（yq ✅ / **lazygit ❌ SIGSYS**） |
| musl **动态** | ❌ 缺加载器 —— **换同仓库的 gnu 版** |
| glibc 动态 | ✅ 配 glibc 前缀（duckdb / astcenc） |

> ⚠️ **静态 ≠ 能跑。** 安卓 seccomp 会拦掉部分系统调用，
> 光看 `file` 输出判断不出来 —— **加工具时必须跑一次 `--version` 才算验过。**

已实测通过的：`typst` `duckdb` `astcenc` `magick` `fonttools` `ripgrep` `fd` `bat` `yq`

---

## localbridge —— 让 glibc 程序联网

安卓**没有 `/etc/resolv.conf`**（DNS 走 `netd`，按网络动态分配），
而 Termux 的 glibc 又被改成只读它自己的硬编码路径：

```
libc.so.6 里的字面量：
  /data/data/com.termux/files/usr/glibc/etc/resolv.conf   ← 别处不存在
  /etc/resolv.conf                                        ← 安卓只读
```

结果：**所有 glibc 程序都无法解析域名**（Blender、编译器、CLI 工具…）。
而 node 是 bionic，用安卓自己的解析器，能正常上网。

```sh
# 让 node 在本地做反向代理
node tools/localbridge.mjs https://api.example.com 8788

# glibc 程序指向它即可 —— 不需要 DNS，也不用改 libc
export SOME_BASE_URL=http://127.0.0.1:8788
```

支持流式（SSE）转发，适合 LLM API 这类长连接。

---

## 许可

MIT（本仓库自身）。

`tools/vendor/` 下的第三方组件保留其原始许可：
- `node-forge` —— BSD-3-Clause OR GPL-2.0
- `xz-decompress` —— MIT
