/**
 * 节点图构建：把上游 Weave 单文件 + 我们的补丁拼成 public/graph.html
 *
 * 用法：node scripts/build-graph.mjs
 *
 * 原理（见 docs/节点图模块-设计方案.md §3）：
 *   上游 Weave.html 一行不改，只在两个位置注入：
 *     A. 主 <script> 开头  ← scripts/graph/pre.js（启动前清存档键）
 *     B. 主 <script> 末尾  ← scripts/graph/post.js（接管存储 / 只读态 / 保存）
 *   注入点缺失即报错退出——上游升级若改了结构，宁可构建失败也不产出坏页面。
 *
 * 上游来源：.local-data/weave（不入库）。首次构建前先：
 *   git -c http.sslBackend=openssl clone --depth 1 https://github.com/Quan-Chan/Weave .local-data/weave
 *
 * 许可：Weave 为 Apache-2.0，产物保留其版权声明（上方 NOTICE 注释块），
 *      修改处已在补丁文件内注明。
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Script } from "node:vm"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

/** 上游与产物路径 */
const UPSTREAM = join(root, ".local-data/weave/APPs/Weave.min.html")
const UPSTREAM_FULL = join(root, ".local-data/weave/APPs/Weave.html")
const PRE = join(root, "scripts/graph/pre.js")
const POST = join(root, "scripts/graph/post.js")
const OUT = join(root, "public/graph.html")

/** 产物版本：注入内容变更时递增（仅用于构建日志与产物注释） */
const GRAPH_VERSION = "v1"

function fail(msg) {
  console.error("\n❌ 构建失败：" + msg + "\n")
  process.exit(1)
}

/* ── 1. 读取上游 ── */

if (!existsSync(UPSTREAM)) {
  fail(
    "找不到上游 " +
      UPSTREAM +
      "\n   先克隆：git -c http.sslBackend=openssl clone --depth 1 https://github.com/Quan-Chan/Weave .local-data/weave",
  )
}

let html = readFileSync(UPSTREAM, "utf-8")
const pre = readFileSync(PRE, "utf-8")
const post = readFileSync(POST, "utf-8")

/* ── 2. 注入点校验 ──
   min 版只有一对 <script></script>。数量不是 1 就说明上游结构变了，
   此时不能猜位置，直接失败让人来看。 */

const openCount = (html.match(/<script/gi) || []).length
const closeCount = (html.match(/<\/script>/gi) || []).length
if (openCount !== 1 || closeCount !== 1) {
  fail(`上游 script 标签数量异常（<script ${openCount} 个 / </script> ${closeCount} 个），需要人工确认注入位置`)
}

const openTag = html.match(/<script[^>]*>/i)
if (!openTag) fail("找不到 <script> 起始标签")
const openIdx = html.indexOf(openTag[0]) + openTag[0].length
const closeIdx = html.lastIndexOf("</script>")
if (closeIdx < openIdx) fail("</script> 出现在 <script> 之前，结构不符合预期")

/* ── 3. 注入 ── */

function upstreamCommit() {
  try {
    return execFileSync("git", ["-C", join(root, ".local-data/weave"), "rev-parse", "--short", "HEAD"], {
      encoding: "utf-8",
    }).trim()
  } catch {
    return "unknown"
  }
}

const banner = `
/* ══════════════════════════════════════════════════════════════════
 * 本文件由 scripts/build-graph.mjs 生成，请勿手工编辑。
 *   上游：Quan-Chan/Weave（Apache-2.0）· ${upstreamCommit()}
 *   补丁：scripts/graph/pre.js + scripts/graph/post.js
 *   版本：${GRAPH_VERSION}
 * 修改说明：本文在 Weave 原文件基础上注入了存储接管、只读态与保存反馈三部分，
 *          画布引擎、交互与渲染逻辑保持原样。
 * ══════════════════════════════════════════════════════════════════ */
`

const patchA = banner + "\n" + pre + "\n"
const patchB = "\n" + post + "\n"

html = html.slice(0, closeIdx) + patchB + html.slice(closeIdx)
html = html.slice(0, openIdx) + patchA + html.slice(openIdx)

/* ── 4. 产物自检 ──
   注入完不能就这么交付：语法错误和"上游改了方法名"这两类问题，
   在浏览器里表现都是白屏，必须在这里挡住。 */

// 4a. 注入顺序
{
  const iPre = html.indexOf("启动前补丁")
  const iPost = html.indexOf("节点图 · 宿主补丁")
  const iClose = html.lastIndexOf("</script>")
  if (iPre < openIdx || iPost < iPre || iClose < iPost) fail("注入位置不正确（pre / post / </script> 顺序错乱）")
}

// 4b. 脚本语法（用 vm 编译，不执行）
{
  const m = html.match(/<script[\s\S]*?>([\s\S]*)<\/script>/i)
  if (!m) fail("产物里找不到主脚本块")
  try {
    new Script(m[1])
  } catch (e) {
    fail("注入后脚本语法错误：" + (e && e.message))
  }
}

// 4c. 依赖方法存在性 —— 上游升级后若重命名这些方法，这里必须失败，
//     而不是让页面跑到一半悄悄失效（见 post.js 顶部的覆盖点清单）。
{
  const REQUIRED = ["_prepareSerializedData", "_commitSerialized", "_lsSet", "_lsGetJson", "_lsGet", "showToast", "renderCanvas"]
  const missing = REQUIRED.filter(k => !html.includes(k))
  if (missing.length) fail("上游缺少依赖方法：" + missing.join(" / ") + "（Weave 升级后可能改名，需同步调整 scripts/graph/post.js）")
}

writeFileSync(OUT, html, "utf-8")

/* ── 4. 汇报 ── */

const kb = n => (n / 1024).toFixed(1) + "KB"
const upstreamKb = kb(statSync(UPSTREAM).size)
const fullKb = existsSync(UPSTREAM_FULL) ? kb(statSync(UPSTREAM_FULL).size) : "—"
const outKb = kb(statSync(OUT).size)

console.log("上游 Weave.min.html   " + upstreamKb + "（未压缩版 " + fullKb + "）")
console.log("补丁 pre.js " + kb(statSync(PRE).size) + " · post.js " + kb(statSync(POST).size))
console.log("产物 public/graph.html " + outKb + "（版本 " + GRAPH_VERSION + "）")
console.log("\n✅ 节点图页面已生成：public/graph.html")
console.log("   本地预览：npx netlify dev 后访问 /graph.html?id=test")
