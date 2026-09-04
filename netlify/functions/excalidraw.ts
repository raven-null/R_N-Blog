import { createHash } from "node:crypto"
import { json, badRequest, noContent } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"
import { checkAuth } from "./_shared/auth"

const STORE = "excalidraw"
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_SCENE_CHARS = 8 * 1024 * 1024 // 场景文本上限 8MB
const MAX_REV = 50 // 每篇笔记保留的快照数

const metaKey = (id: string) => `notes/${id}/meta`
const sceneKey = (id: string) => `notes/${id}/scene`
const revKey = (id: string, rev: number) => `notes/${id}/rev/${rev}`
const revPrefix = (id: string) => `notes/${id}/rev/`

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

interface NoteMeta {
  title?: string
  editable: 0 | 1
  editKeyHash?: string
  createdAt: string
  updatedAt: string
  rev: number
}

function publicMeta(m: NoteMeta) {
  return {
    title: m.title || "",
    editable: m.editable,
    hasKey: !!m.editKeyHash,
    updatedAt: m.updatedAt,
    rev: m.rev,
  }
}

async function readMeta(store: ReturnType<typeof getBlobStore>, id: string): Promise<NoteMeta | null> {
  const raw = await store.get(metaKey(id), { type: "text" })
  if (!raw) return null
  try {
    const m = JSON.parse(raw)
    return { title: "", editable: m.editable === 0 ? 0 : 1, createdAt: m.createdAt || "", updatedAt: m.updatedAt || "", rev: Number(m.rev) || 0, ...m }
  } catch {
    return null
  }
}

/** 清理超过 MAX_REV 的旧快照（保留最新 MAX_REV 份） */
async function trimRevs(store: ReturnType<typeof getBlobStore>, id: string) {
  try {
    const list = await store.list({ prefix: revPrefix(id) })
    const revs = list.blobs
      .map(b => Number(b.key.slice(revPrefix(id).length)))
      .filter(n => Number.isFinite(n))
      .sort((a, b) => b - a)
    for (const old of revs.slice(MAX_REV)) {
      await store.delete(revKey(id, old))
    }
  } catch {
    // 清理失败不影响主流程
  }
}

/**
 * /api/excalidraw —— Excalidraw 笔记存取（M1）
 *
 * 公开：
 *   GET  ?id=xxx                      读场景 + meta 公开字段（editable/hasKey/title/rev）
 *   PUT  ?id=xxx  {scene, editKey?, baseRev?, force?}
 *      - 笔记不存在：需 Admin（X-Admin-Key）→ 创建（editable=1，无口令）
 *      - 笔记存在：editable=1 且口令匹配（若有）→ 旧场景入快照 rev/{rev+1} 后覆盖
 *      - baseRev 与当前 rev 不一致且未 force → 409 { latestRev }（乐观锁冲突）
 * Admin（X-Admin-Key）：
 *   GET  ?action=list                 全部笔记（含 meta）
 *   POST ?action=meta ?id=            { title?, editable?, editKey? }（editKey 传 "" 清除口令）
 *   POST ?action=rollback ?id=&rev=N  快照恢复（写回 scene，历史保留）
 */
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
      const store = getBlobStore(STORE)
      const list = await store.list({ prefix: "notes/" })
      const out: any[] = []
      for (const item of list.blobs) {
        if (!item.key.endsWith("/meta")) continue
        const noteId = item.key.slice("notes/".length, -"/meta".length)
        const meta = await readMeta(store, noteId)
        if (meta) out.push({ id: noteId, ...publicMeta(meta), sceneBytes: undefined })
      }
      out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
      return json(200, { status: "success", data: out }, req, { "Cache-Control": "no-store" })
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "列表失败" }, req)
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
      const store = getBlobStore(STORE)
      const meta = await readMeta(store, id)
      if (!meta) return json(404, { status: "error", message: "笔记不存在" }, req)

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
      const store = getBlobStore(STORE)
      const snap = await store.get(revKey(id, rev), { type: "text" })
      if (!snap) return json(404, { status: "error", message: `快照 rev ${rev} 不存在` }, req)
      await store.set(sceneKey(id), snap)
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

  // ===================== 公开读写 =====================

  if (!ID_RE.test(id)) return badRequest("id 非法（1-64 位字母 / 数字 / - / _）", req)

  try {
    const store = getBlobStore(STORE)

    if (req.method === "GET") {
      const raw = await store.get(sceneKey(id), { type: "text" })
      if (!raw) return json(404, { status: "error", message: "笔记不存在" }, req)
      const meta = await readMeta(store, id)
      return json(
        200,
        { status: "success", id, scene: JSON.parse(raw), meta: meta ? publicMeta(meta) : null },
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
      const scene = body?.scene
      if (!scene || typeof scene !== "object") return badRequest("scene 必填（对象）", req)
      const text = JSON.stringify(scene)
      if (text.length > MAX_SCENE_CHARS) return badRequest("场景过大（超过 8MB）", req)

      const existing = await readMeta(store, id)

      // ---- 创建（仅管理员，防垃圾数据） ----
      if (!existing) {
        if (!isAdmin) {
          return json(403, { status: "error", message: "仅管理员可创建新笔记" }, req)
        }
        const now = new Date().toISOString()
        const meta: NoteMeta = {
          title: "",
          editable: 1, // 默认公开可编辑；如需保护请用 ?action=meta 设口令或关 editable
          createdAt: now,
          updatedAt: now,
          rev: 0,
        }
        await store.set(metaKey(id), JSON.stringify(meta))
        await store.set(sceneKey(id), text)
        return json(200, { status: "success", id, rev: 0, created: true }, req)
      }

      // ---- 更新（L1 协作：editable + 口令） ----
      if (existing.editable !== 1) {
        return json(403, { status: "error", message: "笔记当前为只读（作者未开放编辑）" }, req)
      }
      if (existing.editKeyHash) {
        const provided = typeof body.editKey === "string" ? body.editKey : ""
        if (sha256(provided) !== existing.editKeyHash) {
          return json(401, { status: "error", message: "编辑口令错误" }, req)
        }
      }

      // 乐观锁：baseRev 不一致且未强制 → 409
      const baseRev = Number(body.baseRev)
      const force = body.force === 1 || body.force === true
      if (!force && Number.isFinite(baseRev) && baseRev !== existing.rev) {
        return json(
          409,
          { status: "error", message: "笔记已被他人更新", latestRev: existing.rev },
          req,
        )
      }

      // 旧场景归档为 rev/{k}（k = 被覆盖版本的 rev，回滚语义：恢复到 rev k 的状态）
      const nextRev = existing.rev + 1
      const oldRaw = await store.get(sceneKey(id), { type: "text" })
      if (oldRaw) await store.set(revKey(id, existing.rev), oldRaw)
      await trimRevs(store, id)

      await store.set(sceneKey(id), text)
      existing.rev = nextRev
      existing.updatedAt = new Date().toISOString()
      await store.set(metaKey(id), JSON.stringify(existing))

      return json(200, { status: "success", id, rev: nextRev }, req)
    }

    return badRequest("Method Not Allowed", req)
  } catch (err: any) {
    const msg =
      err?.code === "BLOBS_UNAVAILABLE"
        ? err.message
        : `Excalidraw 存储操作失败：${err?.message || err}`
    return json(500, { status: "error", message: msg }, req)
  }
}

export const config = { path: "/api/excalidraw" }
