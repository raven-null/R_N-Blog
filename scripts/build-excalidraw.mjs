/**
 * 用 esbuild 把 React + @excalidraw/excalidraw 打成静态 IIFE bundle，
 * 并同步复制 Excalidraw 的样式资源（index.css + 其引用的字体）到 public。
 *
 * 用法：node scripts/build-excalidraw.mjs   （或 pnpm build:excalidraw）
 * 输出：
 *   public/js/vendor/excalidraw/excalidraw-editor.vX.js
 *   public/js/vendor/excalidraw/excalidraw-editor.vX.css
 *   public/js/vendor/excalidraw/fonts/...（css 引用的 woff2）
 *
 * 说明：
 * - esbuild 的 JS API 在本机（node 沙箱/受限环境）spawn 服务进程会 EPERM，
 *   因此这里直接调用 esbuild 的 CLI shim（bin/esbuild），行为一致。
 * - Excalidraw 0.18 为 Vite 库产物，样式独立在 dist/prod/index.css，
 *   页面必须同时引入 CSS，否则组件图标/布局全部失效。
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BUNDLE_VERSION = "v9" // bundle 内容变更时递增（配合 immutable 缓存换新）

const vendorDir = join(root, "public/js/vendor/excalidraw")
const excDist = join(root, "node_modules/@excalidraw/excalidraw/dist/prod")
const jsName = `excalidraw-editor.${BUNDLE_VERSION}.js`
const cssName = `excalidraw-editor.${BUNDLE_VERSION}.css`

// 1) JS bundle
execFileSync(
  process.execPath,
  [
    join(root, "node_modules/esbuild/bin/esbuild"),
    join(root, "scripts/excalidraw/editor.tsx"),
    "--bundle",
    "--format=iife",
    "--platform=browser",
    "--target=es2020",
    "--jsx=automatic",
    "--minify",
    `--outfile=${join(vendorDir, jsName)}`,
  ],
  { stdio: "inherit" },
)

// 2) CSS + css 引用的相对资源（fonts）
mkdirSync(vendorDir, { recursive: true })
const cssSrc = join(excDist, "index.css")
cpSync(cssSrc, join(vendorDir, cssName))
const css = readFileSync(cssSrc, "utf8")
const refs = [
  ...new Set(
    [...css.matchAll(/url\((['"]?)(\.\/[^)'"]+)\1\)/g)].map(m => m[2]),
  ),
]
for (const ref of refs) {
  const src = join(excDist, ref)
  const dest = join(vendorDir, ref)
  if (existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src, dest)
  }
}

console.log(`\n✅ bundle 已生成：public/js/vendor/excalidraw/${jsName}`)
console.log(`✅ 样式资源已同步：${cssName} + ${refs.length} 个字体文件`)
