/**
 * 节点图 API（Netlify Functions v2）
 *
 * 路由：export const config = { path: "/api/graph" }
 *
 * 与 mindmap.ts 同构（都基于 Blobs 的 notes/<id>/ 结构），差异：
 *   1. store 换成 graphs，路由换成 /api/graph
 *   2. 多一个 action=file：节点图里的图片节点逐张单独存储（不借 excalidraw 通道）
 *   3. 数据体是 Weave 的存档对象（nodes / connections / regions / viewport），后端不校验内部结构，
 *      只校验"是个对象"——节点类型（text / image / code）由前端解释，后端透明透传。
 *
 * 公开：
 *   GET  ?id=xxx                     读节点图 + 公开 meta（title / editable / hasKey / rev / updatedAt）
 *   GET  ?id=xxx&metaOnly=1          只读 meta
 *   PUT  ?id=xxx                     保存（baseRev 乐观锁；旧版入快照）
 *                                     需管理员，或笔记可编辑且口令匹配（body.editKey）
 *   GET  ?action=file&id=&fid=       读图片（返回 dataURL）
 *   PUT  ?action=file&id=&fid=       写图片（二进制直传或 JSON { dataURL }）
 *   DELETE ?action=file&id=&fid=     删图片
 *
 * Admin（X-Admin-Key）：
 *   GET  ?action=list                节点图列表
 *   GET  ?action=history&id=xxx      快照列表（revs + current）
 *   POST ?action=meta&id=xxx         改标题 / editable / 口令（editKey 传 "" 清除）
 *   POST ?action=rollback&id=&rev=   回滚到指定快照
 *   POST ?action=delete&id=xxx       删除节点图（含全部快照与图片）
 */
import { getBlobStore } from "./_shared/blob"
import { checkAuth } from "./_shared/auth"
import { json, badRequest, noContent } from "./_shared/cors"
import { createHash } from "crypto"

const STORE = "graphs"
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_DATA_CHARS = 4 * 1024 * 1024 // 节点图数据上限 4MB（正常几十 KB）
const MAX_REV = 50 // 每篇保留的快照数
const MAX_FILE_BYTES = 5.2 * 1024 * 1024 // 单张图片上限（低于服务器 6MB 请求体上限）
const MAX_FILE_CHARS = 5.2 * 1024 * 1024 // dataURL 形态的字符上限

const metaKey = (id: string) => `notes/${id}/meta`
const dataKey = (id: string) => `notes/${id}/data`
const revKey = (id: string, rev: number) => `notes/${id}/rev/${rev}`
const revPrefix = (id: string) => `notes/${id}/rev/`
const fileKey = (id: string, fid: string) => `notes/${id}/files/${fid}`

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

/** 图片类型嗅探（与 excalidraw.ts 同一套：以 magic bytes 判断，不信任扩展名） */
function sniffImageMime(buf: Buffer): string {
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp"
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png"
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg"
  if (buf.length > 3 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif"
  return "application/octet-stream"
}

interface GraphMeta {
  title?: string
  editable: 0 | 1
  editKeyHash?: string
  createdAt: string
  updatedAt: string
  rev: number
}

function publicMeta(m: GraphMeta) {
  return {
    title: m.title || "",
    editable: m.editable,
    hasKey: !!m.editKeyHash,
    updatedAt: m.updatedAt,
    rev: m.rev,
  }
}

async function readMeta(store: ReturnType<typeof getBlobStore>, id: string): Promise<GraphMeta | null> {
  try {
    const raw = await store.get(metaKey(id), { type: "text" })
    if (!raw) return null
    const m = JSON.parse(raw) as GraphMeta
    const out: GraphMeta = {
      title: m.title || "",
      editable: m.editable === 0 ? 0 : 1,
      createdAt: m.createdAt || "",
      updatedAt: m.updatedAt || "",
      rev: Number(m.rev) || 0,
    }
    if (m.editKeyHash) out.editKeyHash = m.editKeyHash
    return out
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

  if (action === "list") {
    if (!isAdmin) return json(401, { status: "error", message: "未授权" }, req)
    try {
      const store = getBlobStore(STORE, "strong")
      const res = await store.list({ prefix: "notes/" })
      const ids = res.blobs
        .map((b: any) => String(b.key))
        .filter((k: string) => k.endsWith("/meta"))
        .map((k: string) => k.slice("notes/".length, -"/meta".length))
        .filter((nid: string) => !!nid && ID_RE.test(nid))
      const items: any[] = []
      for (const nid of ids) {
        const meta = await readMeta(store, nid)
        items.push({
          id: nid,
          title: meta?.title || "未命名节点图",
          rev: meta?.rev ?? 0,
          updatedAt: meta?.updatedAt || "",
          hasKey: !!meta?.editKeyHash,
          editable: (meta?.editable ?? 1) === 1,
        })
      }
      items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      return json(200, { status: "success", items }, req, { "Cache-Control": "no-store" })
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "读取节点图列表失败" }, req)
    }
  }

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

  // ===================== 图片（图片节点用） =====================
  // 与 excalidraw 的 action=file 同构，但走 graphs 自己的 store：
  // 节点图不借用白板的文件通道，两边数据完全隔离。

  if (action === "file") {
    const fid = (params.get("fid") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)
    if (!ID_RE.test(id) || !fid) return badRequest("id / fid 非法", req)
    try {
      const store = getBlobStore(STORE, "strong")
      const key = fileKey(id, fid)

      if (req.method === "GET") {
        const text = await store.get(key, { type: "text" })
        if (!text) return json(404, { status: "error", message: "文件不存在" }, req)
        const mime = sniffImageMime(Buffer.from(text, "base64"))
        return json(
          200,
          { status: "success", file: { id: fid, mimeType: mime, dataURL: `data:${mime};base64,${text}` } },
          req,
          { "Cache-Control": "public, max-age=31536000, immutable" },
        )
      }

      // 写：管理员，或节点图对外可编辑且未设口令（与数据保存的权限口径一致）
      const meta = await readMeta(store, id)
      const canWrite = isAdmin || (!!meta && meta.editable === 1 && !meta.editKeyHash)
      if (!canWrite) return json(403, { status: "error", message: "无权限写入节点图图片" }, req)

      if (req.method === "DELETE") {
        await store.delete(key)
        return json(200, { status: "success", id: fid }, req)
      }

      const ctype = (req.headers.get("content-type") || "").toLowerCase()
      let bytes: Buffer
      if (ctype.startsWith("image/") || ctype === "application/octet-stream") {
        bytes = Buffer.from(await req.arrayBuffer())
        if (bytes.length > MAX_FILE_BYTES) {
          return badRequest(`单张图片过大（上限 ${Math.round(MAX_FILE_BYTES / 1048576)}MB）`, req)
        }
      } else {
        const body: any = await req.json().catch(() => ({}))
        const dataURL = typeof body.dataURL === "string" ? body.dataURL : ""
        if (!dataURL || !dataURL.startsWith("data:")) return badRequest("dataURL 非法", req)
        if (dataURL.length > MAX_FILE_CHARS) {
          return badRequest(`单张图片过大（上限 ${Math.round(MAX_FILE_CHARS / 1048576)}MB 字符）`, req)
        }
        bytes = Buffer.from(dataURL.slice(dataURL.indexOf(",") + 1), "base64")
      }
      await store.set(key, bytes.toString("base64"))
      return json(200, { status: "success", id: fid, bytes: bytes.length }, req)
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "节点图图片读写失败" }, req)
    }
  }

  // ===================== 公开读写 =====================

  if (!ID_RE.test(id)) return badRequest("id 非法（1-64 位字母 / 数字 / - / _）", req)

  try {
    const store = getBlobStore(STORE, "strong")

    if (req.method === "GET") {
      const meta = await readMeta(store, id)
      if (params.get("metaOnly") === "1") {
        if (!meta) return json(200, { status: "error", code: "not_found", message: "节点图不存在" }, req)
        return json(200, { status: "success", id, meta: publicMeta(meta) }, req, { "Cache-Control": "no-store" })
      }
      const raw = await store.get(dataKey(id), { type: "text" })
      if (!raw) {
        return json(200, { status: "error", code: "not_found", message: "节点图不存在" }, req)
      }
      let data: any = null
      try {
        data = JSON.parse(raw)
      } catch {
        return json(500, { status: "error", message: "节点图数据损坏" }, req)
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
      if (!data || typeof data !== "object") return badRequest("data 必填（节点图数据对象）", req)
      // Weave 存档必须带 nodes 数组，否则前端 _prepareSerializedData 会拒收
      if (!Array.isArray(data.nodes)) return badRequest("data.nodes 必须是数组", req)
      const text = JSON.stringify(data)
      if (text.length > MAX_DATA_CHARS) {
        return badRequest(`节点图数据过大（超过 ${Math.round(MAX_DATA_CHARS / 1048576)}MB）`, req)
      }

      const existing = await readMeta(store, id)
      const now = new Date().toISOString()

      // ---- 创建（仅管理员，防垃圾数据）----
      if (!existing) {
        if (!isAdmin) return json(403, { status: "error", message: "仅管理员可创建新节点图" }, req)
        const meta: GraphMeta = { title: String(body.title || "").slice(0, 100), editable: 1, createdAt: now, updatedAt: now, rev: 1 }
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
        if (existing.editable !== 1) return json(403, { status: "error", message: "该节点图是只读的" }, req)
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

export const config = { path: "/api/graph" }
