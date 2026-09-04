/**
 * M3 发布链路冒烟：模拟「发布为博文」的后端两步
 *   POST /api/article-image（截图入库）→ POST /api/admin?action=articles（draft 草稿）
 * 运行：esbuild bundle 后 node 执行（见 poc-test-excalidraw.ts 头注释）
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import articleImageFn from "../netlify/functions/article-image"
import adminFn from "../netlify/functions/admin"

const ADMIN_KEY = process.env.ADMIN_KEY || "1111"
const LOCAL = join(process.cwd(), ".local-data")

async function call(fn: (req: Request) => Promise<Response>, method: string, url: string, body?: unknown, admin = false) {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { "x-admin-key": ADMIN_KEY } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
  const res = await fn(new Request(`http://localhost${url}`, init))
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

let failed = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`  ✅ ${name}`)
  else { failed++; console.log(`  ❌ ${name} ${extra}`) }
}

console.log("== M3 发布链路冒烟 ==")

// 1. 上传截图（1x1 红点 PNG）→ 文章图床自动转 webp
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
let r = await call(articleImageFn, "POST", "/api/article-image", { data: tinyPng, mime: "image/png", name: "poc-publish.png" })
check("1) 截图上传 → /images/a/*.webp", r.status === 200 && r.data?.status === "success" && /^\/images\/a\/.+\.webp$/.test(r.data?.url || ""), JSON.stringify(r.data))
const imgUrl = r.data?.url || ""

// 2. 创建 draft 草稿（正文含 ```excalidraw fence + 截图 + 原文链接）
const noteId = "wb-poc-publish"
const content = [
  "",
  `![白板截图](${imgUrl})`,
  "",
  "```excalidraw",
  noteId,
  "```",
  "",
  `[在 Excalidraw 中查看 / 编辑此白板](/excalidraw.html?note=${noteId})`,
  "",
].join("\n")

r = await call(adminFn, "POST", `/api/admin?action=articles`, {
  title: "PoC 发布冒烟（测试后清理）",
  content,
  image: imgUrl,
  status: "draft",
  tags: [],
}, true)
check("2) 创建 draft 草稿", r.status === 200 && r.data?.status === "success" && !!r.data?.data?.id, JSON.stringify(r.data))
const articleId = r.data?.data?.id || ""

// 3. 读回验证内容完整（截图 + fence + 链接）
r = await call(adminFn, "GET", `/api/admin?action=articles&id=${articleId}`)
const body = r.data?.data?.content || ""
check("3) 草稿内容含截图 URL", body.includes(imgUrl), "")
check("4) 草稿内容含 excalidraw fence", body.includes("```excalidraw") && body.includes(noteId), "")
check("5) 草稿内容含原文链接", body.includes(`/excalidraw.html?note=${noteId}`), "")
check("6) 状态为 draft", r.data?.data?.status === "draft", JSON.stringify(r.data?.data?.status))

// 4. 清理测试数据（本地 .local-data 文件操作）
const artStore = join(LOCAL, "blog-articles")
if (existsSync(join(artStore, articleId))) rmSync(join(artStore, articleId))
const idxFile = join(artStore, "index")
if (existsSync(idxFile)) {
  const idx = JSON.parse(readFileSync(idxFile, "utf-8")).filter((a: any) => a.id !== articleId)
  writeFileSync(idxFile, JSON.stringify(idx), "utf-8")
}
const imgKey = (imgUrl || "").split("/").pop() || ""
if (imgKey && existsSync(join(LOCAL, "article-images", imgKey))) {
  rmSync(join(LOCAL, "article-images", imgKey))
}
console.log("7) 测试数据已清理 ✅")

// ===== 白板文章（type=whiteboard + boardId） =====
const boardId2 = "wb-poc-publish"
r = await call(adminFn, "POST", `/api/admin?action=articles`, {
  title: "PoC 白板文章冒烟（测试后清理）",
  content: "",
  image: imgUrl,
  status: "draft",
  tags: [],
  type: "whiteboard",
  boardId: boardId2,
}, true)
check("8) 创建 type=whiteboard 草稿", r.status === 200 && r.data?.status === "success" && r.data?.data?.id, JSON.stringify(r.data))
const wbArticleId = r.data?.data?.id || ""

// 读回验证 type/boardId/content
r = await call(adminFn, "GET", `/api/admin?action=articles&id=${wbArticleId}`)
check("9) type=whiteboard 且 boardId 正确", r.data?.data?.type === "whiteboard" && r.data?.data?.boardId === boardId2, JSON.stringify({ type: r.data?.data?.type, boardId: r.data?.data?.boardId }))
check("10) 正文为空", !r.data?.data?.content, "")

// 清理白板文章
if (existsSync(join(artStore, wbArticleId))) rmSync(join(artStore, wbArticleId))
const idx2File = join(artStore, "index")
if (existsSync(idx2File)) {
  const idx2 = JSON.parse(readFileSync(idx2File, "utf-8")).filter((a: any) => a.id !== wbArticleId)
  writeFileSync(idx2File, JSON.stringify(idx2), "utf-8")
}
console.log("11) 白板文章测试数据已清理 ✅")

// ===== 卡片笔记（type=card） =====
r = await call(adminFn, "POST", `/api/admin?action=articles`, {
  title: "PoC 卡片冒烟（测试后清理）",
  content: "这是一张 **卡片**，验证 type=card 链路。",
  status: "published",
  tags: ["测试", "poc"],
  type: "card",
}, true)
check("12) 创建 type=card", r.status === 200 && r.data?.status === "success" && r.data?.data?.id, JSON.stringify(r.data))
const cardId = r.data?.data?.id || ""
r = await call(adminFn, "GET", `/api/admin?action=articles&id=${cardId}`)
check("13) card 类型与内容正确", r.data?.data?.type === "card" && String(r.data?.data?.content || "").includes("卡片"), JSON.stringify({ type: r.data?.data?.type }))
r = await call(adminFn, "GET", `/api/admin?action=articles`)
check("14) 列表含 card 条目", Array.isArray(r.data?.data) && r.data.data.some((a: any) => a.id === cardId && a.type === "card"), "")
r = await call(adminFn, "DELETE", `/api/admin?action=articles&id=${cardId}`, undefined, true)
check("15) DELETE 删除 card", r.status === 200 && r.data?.status === "success", JSON.stringify(r.data))

console.log(failed === 0 ? "\n🎉 M3 发布链路冒烟通过" : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
