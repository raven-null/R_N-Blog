/**
 * 用 esbuild 把 React + @excalidraw/excalidraw 打成静态 IIFE bundle。
 *
 * 用法：node scripts/build-excalidraw.mjs   （或 pnpm build:excalidraw）
 * 输出：public/js/vendor/excalidraw/excalidraw-editor.js
 *
 * 说明：esbuild 的 JS API 在本机（node 沙箱/受限环境）spawn 服务进程会 EPERM，
 *       因此这里直接调用 esbuild 的 CLI shim（bin/esbuild），行为一致。
 */
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const esbuildBin = join(root, "node_modules/esbuild/bin/esbuild")
const entry = join(root, "scripts/excalidraw/editor.tsx")
const outfile = join(root, "public/js/vendor/excalidraw/excalidraw-editor.v4.js")

execFileSync(
  process.execPath,
  [
    esbuildBin,
    entry,
    "--bundle",
    "--format=iife",
    "--platform=browser",
    "--target=es2020",
    "--jsx=automatic",
    "--minify",
    `--outfile=${outfile}`,
  ],
  { stdio: "inherit" },
)

console.log(`\n✅ bundle 已生成：public/js/vendor/excalidraw/excalidraw-editor.v4.js`) // eslint-disable-line no-console
