这些包装脚本解决两件事：

1. 环境隔离 —— 剥掉 DSH 运行时注入的 LD_LIBRARY_PATH/LD_PRELOAD
   （它的 libz.so 会污染系统 app_process 的链接，报 cannot find libz.so from verneed）
2. 路径无关 —— 全部用环境变量定位依赖，默认值可被覆盖

拷到任意在 PATH 里的目录即可使用。依赖位置：

    C4TC             C4droid NDK 工具链根目录（含 tc/gcc/）
    GLIBC_PREFIX     glibc 前缀（含 bin/aapt2）
    DSH_TOOLS_REPO   本仓库根目录（仅当包装脚本被拷出仓库时需要）
