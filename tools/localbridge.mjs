// localbridge.mjs —— 给 glibc 程序用的本地 HTTP 桥
//
// 为什么需要它：
//   安卓没有 /etc/resolv.conf，DNS 走 netd。
//   Termux 的 glibc 被改成一律读 /data/data/com.termux/files/usr/glibc/etc/resolv.conf，
//   那个路径在别处不存在 → glibc 程序（Blender、Claude Code…）全部无法解析域名。
//   而 node 是 bionic，用安卓自己的解析器，能正常上网。
//
// 做法：让 node 在 127.0.0.1 上做反向代理，glibc 程序指向这个本地端口即可 ——
//       不需要 DNS，也不需要改 libc。
//
// 用法:
//   node localbridge.mjs <上游URL> [端口]
//   node localbridge.mjs https://api.deepseek.com/anthropic 8788
//
// 然后:
//   export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
//
// 支持流式（SSE）转发，这是 LLM API 必需的。

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const upstream = process.argv[2];
const port = Number(process.argv[3] || 8788);
if (!upstream) {
  console.error("用法: node localbridge.mjs <上游URL> [端口]");
  process.exit(1);
}
const base = new URL(upstream);
const isHttps = base.protocol === "https:";
const agent = isHttps ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });

let n = 0;
const server = http.createServer((req, res) => {
  const id = ++n;
  // 把上游 base path 与请求 path 拼起来
  const path = base.pathname.replace(/\/$/, "") + req.url;
  const headers = { ...req.headers, host: base.host };
  delete headers["accept-encoding"]; // 让上游发未压缩内容，避免再解一遍

  const opts = {
    hostname: base.hostname,
    port: base.port || (isHttps ? 443 : 80),
    path,
    method: req.method,
    headers,
    agent,
  };

  const started = Date.now();
  const up = (isHttps ? https : http).request(opts, (upRes) => {
    console.log(`[${id}] ${req.method} ${req.url} → ${upRes.statusCode} (${Date.now() - started}ms)`);
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res); // 流式透传
  });

  up.on("error", (e) => {
    console.log(`[${id}] 上游错误: ${e.code || e.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "bridge_upstream_error", message: String(e.code || e.message) } }));
  });

  req.pipe(up);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`localbridge: 127.0.0.1:${port}  →  ${upstream}`);
  console.log(`  把 glibc 程序指向 http://127.0.0.1:${port} 即可`);
});
