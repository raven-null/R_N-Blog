/**
 * 节点图后端自测：直接调用 /api/graph 的处理函数，不经过 HTTP 服务器。
 *
 * 用法：npx tsx scripts/graph/selftest.ts
 *
 * 本地没有 Blobs 环境时会自动回退到 .local-data/graphs/ 的文件存储（见 _shared/blob.ts），
 * 所以这个脚本不需要 netlify dev，也不会碰线上数据。
 */
import handler from "../../netlify/functions/graph"

process.env.ADMIN_KEY = "selftest-admin"

const BASE = "http://localhost/api/graph"
const ADMIN = process.env.ADMIN_KEY!
const id = "selftest-" + Date.now().toString(36)

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

async function call(method: string, query: string, opts: { body?: any; admin?: boolean; contentType?: string; raw?: ArrayBuffer } = {}) {
  const headers: Record<string, string> = {}
  if (opts.admin) headers["x-admin-key"] = ADMIN
  let body: any
  if (opts.raw) {
    headers["content-type"] = opts.contentType || "application/octet-stream"
    body = opts.raw
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json"
    body = JSON.stringify(opts.body)
  }
  const req = new Request(`${BASE}${query}`, { method, headers, body })
  const res = await handler(req)
  const text = await res.text()
  let data: any = null
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data, headers: res.headers }
}

/** 一份最小的合法 Weave 存档（格单位：w=9 h=4 即 180×80 像素） */
function sampleDoc(label: string) {
  return {
    nodes: [{ id: "n1", label, desc: "", color: "blue", x: 0, y: 0, w: 9, h: 4 }],
    connections: [],
    regions: [],
    viewport: { panX: 0, panY: 0, scale: 1, unit: "px" },
  }
}

console.log(`\n节点图后端自测 · id=${id}\n`)

/* 1. 创建 */
{
  const r = await call("PUT", `?id=${id}`, { body: { data: sampleDoc("根节点"), title: "自测节点图" }, admin: true })
  check("PUT 创建（管理员）→ 200 且 rev=1", r.status === 200 && r.data.rev === 1 && r.data.created === true, r.data)
}

/* 2. 读回 */
{
  const r = await call("GET", `?id=${id}`)
  check("GET 读回数据", r.status === 200 && r.data.status === "success" && r.data.data.nodes[0].label === "根节点", r.data?.data?.nodes?.[0])
  check("公开 meta 不含口令哈希", r.data.meta && r.data.meta.editKeyHash === undefined && r.data.meta.rev === 1, r.data.meta)
}

/* 3. 非管理员更新：默认 editable=1，应允许 */
{
  const r = await call("PUT", `?id=${id}`, { body: { data: sampleDoc("改过"), baseRev: 1 } })
  check("PUT 更新（公开可编辑）→ rev=2", r.status === 200 && r.data.rev === 2, r.data)
}

/* 4. 乐观锁冲突 */
{
  const r = await call("PUT", `?id=${id}`, { body: { data: sampleDoc("冲突"), baseRev: 1 } })
  check("PUT baseRev 过期 → 409", r.status === 409 && r.data.latestRev === 2, r.data)
}

/* 5. 强制覆盖 */
{
  const r = await call("PUT", `?id=${id}`, { body: { data: sampleDoc("强制"), baseRev: 1, force: 1 } })
  check("PUT force=1 → 越过冲突", r.status === 200 && r.data.rev === 3, r.data)
}

/* 6. 数据校验 */
{
  const r = await call("PUT", `?id=${id}`, { body: { data: { nope: 1 }, baseRev: 3 }, admin: true })
  check("PUT 缺 nodes 数组 → 400", r.status === 400, r.data)
}

/* 7. 快照与回滚 */
{
  const h = await call("GET", `?action=history&id=${id}`, { admin: true })
  check("GET history → 有快照", h.status === 200 && Array.isArray(h.data.revs) && h.data.revs.length >= 2, h.data)
  const rb = await call("POST", `?action=rollback&id=${id}&rev=${h.data.revs[0]}`, { admin: true })
  check("POST rollback → 200", rb.status === 200 && rb.data.status === "success", rb.data)
  const after = await call("GET", `?id=${id}`)
  check("回滚后读到的仍是合法存档", after.status === 200 && Array.isArray(after.data?.data?.nodes), after.data?.data)
}

/* 8. 只读锁定 */
{
  const m = await call("POST", `?action=meta&id=${id}`, { body: { editable: 0 }, admin: true })
  check("POST meta 置为只读", m.status === 200 && m.data.meta.editable === 0, m.data)
  const w = await call("PUT", `?id=${id}`, { body: { data: sampleDoc("只读态写入"), baseRev: 3 } })
  check("只读时公开写入 → 403", w.status === 403, w.data)
  await call("POST", `?action=meta&id=${id}`, { body: { editable: 1 }, admin: true })
}

/* 9. 口令 */
{
  await call("POST", `?action=meta&id=${id}`, { body: { editKey: "abcd" }, admin: true })
  const wrong = await call("PUT", `?id=${id}`, { body: { data: sampleDoc("口令错"), baseRev: 3, editKey: "zzzz" } })
  check("口令错误 → 401", wrong.status === 401, wrong.data)
  const right = await call("PUT", `?id=${id}`, { body: { data: sampleDoc("口令对"), baseRev: 3, editKey: "abcd" } })
  check("口令正确 → 200", right.status === 200, right.data)
}

/* 10. 图片节点文件通道 */
{
  const fid = "img-" + Date.now().toString(36)
  // 1×1 的透明 PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  )
  const put = await call("PUT", `?action=file&id=${id}&fid=${fid}`, {
    raw: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    contentType: "image/png",
    admin: true,
  })
  check("PUT file 上传 → 200", put.status === 200 && put.data.bytes === png.length, put.data)
  const get = await call("GET", `?action=file&id=${id}&fid=${fid}`)
  check(
    "GET file 回读为 dataURL 且嗅探出 image/png",
    get.status === 200 && get.data.file?.mimeType === "image/png" && get.data.file?.dataURL?.startsWith("data:image/png;base64,"),
    get.data?.file?.mimeType,
  )
  const del = await call("DELETE", `?action=file&id=${id}&fid=${fid}`, { admin: true })
  check("DELETE file → 200", del.status === 200, del.data)
  const gone = await call("GET", `?action=file&id=${id}&fid=${fid}`)
  check("删除后 GET file → 404", gone.status === 404, gone.status)
}

/* 11. 列表 */
{
  const r = await call("GET", `?action=list`, { admin: true })
  const hit = (r.data.items || []).find((x: any) => x.id === id)
  check("GET list 里能查到自己的图", r.status === 200 && !!hit, { status: r.status, found: !!hit })
}

/* 12. 权限边界 */
{
  const r = await call("GET", `?action=list`)
  check("GET list 无管理员 → 401", r.status === 401, r.status)
  const bad = await call("GET", `?id=../etc/passwd`)
  check("非法 id → 400", bad.status === 400, bad.data)
}

/* 13. 删除 */
{
  const r = await call("POST", `?action=delete&id=${id}`, { admin: true })
  check("POST delete → 200", r.status === 200, r.data)
  const after = await call("GET", `?id=${id}`)
  check("删除后 GET → not_found", after.data?.code === "not_found", after.data)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
