/**
 * 节点图文章全链路自测：发布 → 索引 → 前台取数 → 删除时连带清理节点图
 *
 * 用法：
 *   node node_modules/esbuild/bin/esbuild scripts/graph/e2e-article.ts --bundle --format=esm \
 *     --platform=node --target=node20 --packages=external --outfile=.local-data/graph-selftest/e2e.mjs
 *   node .local-data/graph-selftest/e2e.mjs
 *
 * 直接调两个处理函数（admin / graph），不经过 HTTP 服务器，本地自动回退到 .local-data/ 的文件存储。
 */
import adminHandler from "../../netlify/functions/admin"
import graphHandler from "../../netlify/functions/graph"

process.env.ADMIN_KEY = "e2e-admin"
const ADMIN = process.env.ADMIN_KEY!

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: any) {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail !== undefined ? " → " + JSON.stringify(detail) : ""}`)
  }
}

async function call(handler: any, base: string, method: string, query: string, body?: any, admin = true) {
  const headers: Record<string, string> = {}
  if (admin) headers["x-admin-key"] = ADMIN
  if (body !== undefined) headers["content-type"] = "application/json"
  const req = new Request(`${base}${query}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const res = await handler(req)
  const text = await res.text()
  let data: any = null
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

const graphId = "gg-e2e-" + Date.now().toString(36)
const A = "http://localhost/api/admin"
const G = "http://localhost/api/graph"

console.log(`\n节点图文章全链路 · graphId=${graphId}\n`)

/* 1. 先建一张节点图（模拟编辑器保存） */
{
  const r = await call(graphHandler, G, "PUT", `?id=${graphId}`, {
    data: { nodes: [{ id: "n1", label: "中心", desc: "", color: "blue", x: 0, y: 0, w: 9, h: 4 }], connections: [], regions: [] },
    title: "端到端节点图",
  })
  check("PUT 节点图数据 → rev=1", r.status === 200 && r.data.rev === 1, r.data)
}

/* 2. 发布成 type=graph 的文章 */
let articleId = ""
{
  const r = await call(adminHandler, A, "POST", "?action=articles", {
    title: "端到端节点图文章",
    content: "",
    status: "published",
    type: "graph",
    graphId,
    tags: ["测试"],
  })
  articleId = (r.data && r.data.data && r.data.data.id) || ""
  check("POST 文章 type=graph → success", r.status === 200 && r.data.status === "success", r.data)
  check("索引里带回 graphId（前台靠它懒加载画布）", r.data?.data?.graphId === graphId, r.data?.data?.graphId)
  check("type 保持 graph 没被回落成 article", r.data?.data?.type === "graph", r.data?.data?.type)
  check("节点图形态不生成摘要", r.data?.data?.excerpt === "", r.data?.data?.excerpt)
}

/* 3. 前台列表能拿到这篇 */
{
  const r = await call(adminHandler, A, "GET", "?action=articles", undefined, false)
  const list = (r.data && r.data.data) || []
  const hit = list.find((a: any) => a.id === articleId)
  check("文章列表里能查到（首页筛选依赖它）", r.status === 200 && !!hit && hit.type === "graph", { found: !!hit, type: hit?.type })
}

/* 4. 非法 graphId 清洗 */
{
  const r = await call(adminHandler, A, "POST", "?action=articles", {
    title: "非法 id 测试",
    content: "",
    status: "draft",
    type: "graph",
    graphId: "../../etc/passwd",
  })
  // 清洗后剩下的合法字符，或为空
  const gid = r.data?.data?.graphId
  check("非法 graphId 被清洗（不含路径字符）", gid === undefined || !/[./\\]/.test(String(gid)), gid)
  if (r.data?.data?.id) await call(adminHandler, A, "DELETE", `?action=articles&id=${r.data.data.id}`)
}

/* 5. 删除文章 → 连带清理节点图数据 */
{
  const before = await call(graphHandler, G, "GET", `?id=${graphId}`)
  check("删除前节点图数据还在", before.data?.status === "success", before.data?.status)

  const del = await call(adminHandler, A, "DELETE", `?action=articles&id=${articleId}`)
  check("DELETE 文章 → success", del.status === 200 && del.data.status === "success", del.data)

  const after = await call(graphHandler, G, "GET", `?id=${graphId}`)
  check("删除后节点图数据已被一并清理", after.data?.code === "not_found", after.data?.code)
}

/* 6. 随记不受影响（用户要求：删除随记不能带画布逻辑） */
{
  const r = await call(adminHandler, A, "POST", "?action=articles", {
    title: "一条随记",
    content: "随手记一句",
    status: "published",
    type: "card",
  })
  const cid = r.data?.data?.id
  check("POST 随记 → success", r.status === 200 && r.data.status === "success", r.data)
  check("随记没有 graphId 字段", r.data?.data?.graphId === undefined, r.data?.data?.graphId)
  if (cid) await call(adminHandler, A, "DELETE", `?action=articles&id=${cid}`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
