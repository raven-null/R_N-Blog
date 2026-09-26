/**
 * 思维导图 API（Netlify Functions v2）
 *
 * 路由：export const config = { path: "/api/mindmap" }
 *
 * 公开：
 *   GET  ?id=xxx                     读导图 + 公开 meta（title / editable / hasKey / rev / updatedAt）
 *   PUT  ?id=xxx                     保存（baseRev 乐观锁；旧版入快照）
 *                                     需管理员，或笔记 editable=1 且口令匹配（body.editKey）
 * Admin（X-Admin-Key）：
 *   GET  ?action=history&id=xxx      快照列表（revs + current）
 *   POST ?action=meta&id=xxx         改标题 / editable / 口令（editKey 传 "" 清除）
 *   POST ?action=rollback&id=&rev=   回滚到指定快照
 *   POST ?action=delete&id=xxx       删除导图（含全部快照）
 *
 * 存储结构（与白板 excalidraw store 同构）：
 *   notes/<id>/meta     元数据
 *   notes/<id>/data     导图数据（JSON 文本）
 *   notes/<id>/rev/<n>  历史快照
 */
import { getBlobStore } from "./_shared/blob"
import { checkAuth } from "./_shared/auth"
import { json, badRequest, noContent } from "./_shared/cors"
import { createHash } from "crypto"

const STORE = "mindmaps"
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_DATA_CHARS = 4 * 1024 * 1024 // 导图数据上限 4MB（正常几 KB ~ 几十 KB）
const MAX_REV = 50 // 每篇保留的快照数

const metaKey = (id: string) => `notes/${id}/meta`
const dataKey = (id: string) => `notes/${id}/data`
const revKey = (id: string, rev: number) => `notes/${id}/rev/${rev}`
const revPrefix = (id: string) => `notes/${id}/rev/`

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

interface MapMeta {
  title?: string
  editable: 0 | 1
  editKeyHash?: string
  createdAt: string
  updatedAt: string
  rev: number
}

function publicMeta(m: MapMeta) {
  return {
    title: m.title || "",
    editable: m.editable,
    hasKey: !!m.editKeyHash,
    updatedAt: m.updatedAt,
    rev: m.rev,
  }
}

async function readMeta(store: ReturnType<typeof getBlobStore>, id: string): Promise<MapMeta | null> {
  try {
    const raw = await store.get(metaKey(id), { type: "text" })
    if (!raw) return null
    const m = JSON.parse(raw) as MapMeta
    return {
      title: m.title || "",
      editable: m.editable === 0 ? 0 : 1,
      createdAt: m.createdAt || "",
      updatedAt: m.updatedAt || "",
      rev: Number(m.rev) || 0,
      ...m,
    }
  } catch {
    return null
  }
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") return noContent(req)

  const url = new URL(req.url)
  const params = url.searchParams
  const action = params.get("action") || ""
  const id = params.get("id") || ""

  const isAdmin = await checkAuth(req)

  // ===================== Admin 端点 =====================

  if (action === "history") {
    if (!isAdmin) return json(401, { status: "error", message: "未授权" }, req)
    if (!ID_RE.test(id)) return badRequest("id 非法", req)
    try {
      const store = getBlobStore(STORE, "strong")
      const list = await store.list({ prefix: revPrefix(id) })
      const revs = list.blobs
        .map((b: any) => Number(b.key.slice(revPrefix(id).length)))
        .filter((n: number) => Number.isFinite(n))
        .sort((a: number, b: number) => b - a)
      const meta = await readMeta(store, id)
      return json(200, { status: "success", id, revs, current: meta?.rev ?? 0 }, req, { "Cache-Control": "no-store" })
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "读取历史失败" }, req)
    }
  }

  if (action === "meta") {
    if (!isAdmin) return json(401, { status: "error", message: "未授权" }, req)
    if (!ID_RE.test(id)) return badRequest("id 非法", req)
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      return badRequest("请求体不是合法 JSON", req)
    }
    try {
      const store = getBlobStore(STORE, "strong")
      let meta = await readMeta(store, id)
      if (!meta) {
        const now = new Date().toISOString()
        meta = { title: "", editable: 1, createdAt: now, updatedAt: now, rev: 0 }
      }
      if (typeof body.title === "string") meta.title = body.title.slice(0, 100)
      if (body.editable === 0 || body.editable === 1) meta.editable = body.editable
      if ("editKey" in body) {
        const key = typeof body.editKey === "string" ? body.editKey : ""
        if (key) {
          if (key.length < 4) return badRequest("口令至少 4 位", req)
          meta.editKeyHash = sha256(key)
        } else {
          delete meta.editKeyHash // 传空串清除口令
        }
      }
      meta.updatedAt = new Date().toISOString()
      await store.set(metaKey(id), JSON.stringify(meta))
      return json(200, { status: "success", id, meta: publicMeta(meta) }, req)
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "更新 meta 失败" }, req)
    }
  }

  if (action === "rollback") {
    if (!isAdmin) return json(401, { status: "error", message: "未授权" }, req)
    if (!ID_RE.test(id)) return badRequest("id 非法", req)
    const rev = Number(params.get("rev"))
    if (!Number.isInteger(rev) || rev < 0) return badRequest("rev 非法（>=0）", req)
    try {
      const store = getBlobStore(STORE, "strong")
      const snap = await store.get(revKey(id, rev), { type: "text" })
      if (!snap) return json(404, { status: "error", message: `快照 rev ${rev} 不存在` }, req)
      await store.set(dataKey(id), snap)
      const meta = await readMeta(store, id)
      if (meta) {
        meta.updatedAt = new Date().toISOString()
        await store.set(metaKey(id), JSON.stringify(meta))
      }
      return json(200, { status: "success", id, rev }, req)
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "回滚失败" }, req)
    }
  }

  if (action === "delete") {
    if (!isAdmin) return json(401, { status: "error", message: "未授权" }, req)
    if (!ID_RE.test(id)) return badRequest("id 非法", req)
    try {
      const store = getBlobStore(STORE, "strong")
      const list = await store.list({ prefix: `notes/${id}/` })
      for (const item of list.blobs) {
        await store.delete(item.key)
      }
      return json(200, { status: "success", id, removed: list.blobs.length }, req)
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "删除失败" }, req)
    }
  }

  // ===================== 公开读写 =====================

  if (!ID_RE.test(id)) return badRequest("id 非法（1-64 位字母 / 数字 / - / _）", req)

  try {
    const store = getBlobStore(STORE, "strong")

    if (req.method === "GET") {
      const meta = await readMeta(store, id)
      if (params.get("metaOnly") === "1") {
        if (!meta) return json(200, { status: "error", code: "not_found", message: "导图不存在" }, req)
        return json(200, { status: "success", id, meta: publicMeta(meta) }, req, { "Cache-Control": "no-store" })
      }
      const raw = await store.get(dataKey(id), { type: "text" })
      if (!raw) {
        return json(200, { status: "error", code: "not_found", message: "导图不存在" }, req)
      }
      let data: any = null
      try {
        data = JSON.parse(raw)
      } catch {
        return json(500, { status: "error", message: "导图数据损坏" }, req)
      }
      return json(
        200,
        { status: "success", id, data, meta: meta ? publicMeta(meta) : null },
        req,
        { "Cache-Control": "no-store" },
      )
    }

    if (req.method === "PUT") {
      let body: any = {}
      try {
        body = await req.json()
      } catch {
        return badRequest("请求体不是合法 JSON", req)
      }
      const data = body?.data
      if (!data || typeof data !== "object") return badRequest("data 必填（导图数据对象）", req)
      const text = JSON.stringify(data)
      if (text.length > MAX_DATA_CHARS) {
        return badRequest(`导图数据过大（超过 ${Math.round(MAX_DATA_CHARS / 1048576)}MB）`, req)
      }

      const existing = await readMeta(store, id)
      const now = new Date().toISOString()

      // ---- 创建（仅管理员，防垃圾数据）----
      if (!existing) {
        if (!isAdmin) return json(403, { status: "error", message: "仅管理员可创建新导图" }, req)
        const meta: MapMeta = { title: String(body.title || "").slice(0, 100), editable: 1, createdAt: now, updatedAt: now, rev: 1 }
        if (typeof body.editKey === "string" && body.editKey) {
          if (body.editKey.length < 4) return badRequest("口令至少 4 位", req)
          meta.editKeyHash = sha256(body.editKey)
        }
        await store.set(dataKey(id), text)
        await store.set(metaKey(id), JSON.stringify(meta))
        return json(200, { status: "success", id, rev: meta.rev, created: true }, req)
      }

      // ---- 权限：管理员，或对外开放编辑且口令匹配 ----
      let permitted = isAdmin
      if (!permitted) {
        if (existing.editable !== 1) return json(403, { status: "error", message: "该导图是只读的" }, req)
        if (existing.editKeyHash) {
          const key = typeof body.editKey === "string" ? body.editKey : ""
          if (!key || sha256(key) !== existing.editKeyHash) {
            return json(401, { status: "error", message: "编辑口令错误" }, req)
          }
        }
        permitted = true
      }
      if (!permitted) return json(403, { status: "error", message: "无权限保存" }, req)

      // ---- 乐观锁 ----
      const baseRev = Number(body.baseRev)
      const force = body.force === 1 || body.force === true
      if (!force && Number.isFinite(baseRev) && baseRev !== existing.rev) {
        return json(409, { status: "error", message: "检测到他人更新", latestRev: existing.rev }, req)
      }

      // ---- 旧版入快照 ----
      const oldRaw = await store.get(dataKey(id), { type: "text" })
      const nextRev = (existing.rev || 0) + 1
      if (oldRaw) {
        try {
          await store.set(revKey(id, nextRev), oldRaw)
          const list = await store.list({ prefix: revPrefix(id) })
          const revs = list.blobs
            .map((b: any) => Number(b.key.slice(revPrefix(id).length)))
            .filter((n: number) => Number.isFinite(n))
            .sort((a: number, b: number) => b - a)
          for (const old of revs.slice(MAX_REV)) {
            await store.delete(revKey(id, old))
          }
        } catch {
          /* 快照失败不阻断保存 */
        }
      }

      await store.set(dataKey(id), text)
      existing.updatedAt = now
      existing.rev = nextRev
      if (typeof body.title === "string" && body.title.trim()) existing.title = body.title.slice(0, 100)
      await store.set(metaKey(id), JSON.stringify(existing))

      return json(200, { status: "success", id, rev: nextRev }, req)
    }

    return badRequest("不支持的请求方法", req)
  } catch (err: any) {
    return json(500, { status: "error", message: err?.message || "服务器错误" }, req)
  }
}

export const config = { path: "/api/mindmap" }
