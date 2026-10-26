/**
 * 节点图本地验证服务器（不依赖 netlify-cli，沙箱里也能跑）
 *
 * 用法：
 *   node node_modules/esbuild/bin/esbuild netlify/functions/graph.ts --bundle --format=esm \
 *     --platform=node --target=node20 --packages=external --outfile=.local-data/graph-selftest/graph-handler.mjs
 *   node scripts/graph/devserver.mjs [端口]
 *
 * 做两件事：
 *   /api/graph  → 交给真正的处理函数（本地无 Blobs 环境时自动回退到 .local-data/graphs/）
 *   其余路径    → public/ 静态文件
 *
 * 正式开发仍用 `npx netlify dev`；这个脚本只为在没有 CLI 的环境里验证页面。
 */
import http from "node:http"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, extname, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")
const PORT = Number(process.argv[2]) || 8899

const HANDLER = join(root, ".local-data/graph-selftest/graph-handler.mjs")
if (!existsSync(HANDLER)) {
  console.error("找不到 " + HANDLER + "，先按文件头部注释打包处理函数")
  process.exit(1)
}
const { default: handler } = await import("file://" + HANDLER.replace(/\\/g, "/"))

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`)

  // ---- API ----
  if (url.pathname === "/api/graph") {
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      const request = new Request(url, {
        method: req.method,
        headers: Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        duplex: "half",
      })
      const out = await handler(request)
      const buf = Buffer.from(await out.arrayBuffer())
      res.writeHead(out.status, Object.fromEntries(out.headers.entries()))
      res.end(buf)
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ status: "error", message: String((err && err.message) || err) }))
    }
    return
  }

  // ---- 静态 ----
  let p = normalize(url.pathname).replace(/^([/\\])+/, "")
  if (p === "" || p.endsWith("/")) p += "index.html"
  const file = join(root, "public", p)
  if (!file.startsWith(join(root, "public"))) {
    res.writeHead(403).end("forbidden")
    return
  }
  try {
    const buf = await readFile(file)
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    })
    res.end(buf)
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("404 " + url.pathname)
  }
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`节点图验证服务器：http://127.0.0.1:${PORT}/graph.html?id=test`)
  console.log(`API：http://127.0.0.1:${PORT}/api/graph?id=test`)
})
