/**
 * 用 esbuild 把 Mind Elixir + 编辑器封装打成静态 IIFE bundle。
 *
 * 用法：node scripts/build-mindmap.mjs
 * 输出：public/js/vendor/mindmap/mindmap-editor.vX.js（+ .css，若库提供独立样式）
 *
 * 说明：与 scripts/build-excalidraw.mjs 同一模式——直接调用 esbuild CLI shim
 * （JS API 在本机沙箱里 spawn 服务进程会 EPERM）。
 * 改版本号时同时更新 MM_BUNDLE_VERSION 的引用点：
 *   public/mindmap.html、public/js/article-app.js、public/js/admin-app.js、public/js/admin-edit.js
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BUNDLE_VERSION = "v95" // bundle 内容变更时递增

const vendorDir = join(root, "public/js/vendor/mindmap")
mkdirSync(vendorDir, { recursive: true })
const jsName = `mindmap-editor.${BUNDLE_VERSION}.js`

// 1) JS bundle
execFileSync(
  process.execPath,
  [
    join(root, "node_modules/esbuild/bin/esbuild"),
    join(root, "scripts/mindmap/editor.ts"),
    "--bundle",
    "--format=iife",
    "--platform=browser",
    "--target=es2020",
    "--jsx=automatic",
    "--minify",
    "--charset=utf8", // 保留中文字面量（默认会转义成 \uXXXX）
    `--outfile=${join(vendorDir, jsName)}`,
  ],
  { stdio: "inherit" },
)

// 2) 复制库的样式（Mind Elixir 5.x 是 dist/MindElixir.css，12KB，无外部字体依赖）
const pkgDir = join(root, "node_modules/mind-elixir")
const cssCandidates = ["dist/MindElixir.css", "dist/style.css", "style.css"]
let cssCopied = false
for (const rel of cssCandidates) {
  const src = join(pkgDir, rel)
  if (existsSync(src)) {
    cpSync(src, join(vendorDir, `mindmap-editor.${BUNDLE_VERSION}.css`))
    console.log(`已复制样式：${rel}`)
    cssCopied = true
    break
  }
}
if (!cssCopied) console.log("警告：未找到库样式文件，页面可能缺少导图基础样式")
const fontDir = join(pkgDir, "dist/fonts")
if (existsSync(fontDir)) {
  const target = join(vendorDir, "fonts")
  mkdirSync(target, { recursive: true })
  for (const f of readdirSync(fontDir)) {
    cpSync(join(fontDir, f), join(target, f))
  }
  console.log("已复制字体目录 fonts/")
}

console.log(`\n✅ bundle 已生成：public/js/vendor/mindmap/${jsName}`)
