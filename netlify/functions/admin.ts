import { randomUUID, createHash } from "node:crypto"
import { json, badRequest, noContent } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"

const ARTICLE_STORE = "blog-articles"
const IMAGE_STORE = "blog-images"
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10MB

const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
}

interface ArticleMeta {
  id: string
  filename: string
  title: string
  date: string
  update?: string
  tags: string[]
  author: string
  excerpt: string
  image: string
  wordCount: number
  status: "published" | "draft"
}

// ===================== 认证 =====================

function checkAuth(req: Request): boolean {
  const adminKey = process.env.ADMIN_KEY
  if (!adminKey) return true // 未配置则免认证（本地开发）
  const provided = req.headers.get("x-admin-key") ?? ""
  return provided === adminKey
}

function generateToken(key: string): string {
  return createHash("sha256").update(key + Date.now()).digest("hex").slice(0, 32)
}

// ===================== 文章存储 =====================

async function getArticleIndex(store: ReturnType<typeof getBlobStore>): Promise<ArticleMeta[]> {
  const raw = await store.get("index", { type: "text" })
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

async function saveArticleIndex(store: ReturnType<typeof getBlobStore>, index: ArticleMeta[]) {
  await store.set("index", JSON.stringify(index))
}

// ===================== 主路由 =====================

export default async (req: Request) => {
  if (req.method === "OPTIONS") return noContent(req)

  const url = new URL(req.url)
  const path = url.searchParams.get("action") || ""

  // 登录验证
  if (path === "login") {
    if (req.method !== "POST") return badRequest("Method Not Allowed", req)
    const body = await req.json().catch(() => ({}))
    const key = body.key || ""
    if (!checkAuth(req) && key !== process.env.ADMIN_KEY) {
      return json(401, { status: "error", message: "密钥错误" }, req)
    }
    return json(200, { status: "success", token: generateToken(key) }, req)
  }

  // 以下接口需要认证
  if (!checkAuth(req)) {
    return json(401, { status: "error", message: "未授权" }, req)
  }

  // ===== 文章管理 =====

  if (path === "articles") {
    const store = getBlobStore(ARTICLE_STORE)

    // GET: 列表或单篇
    if (req.method === "GET") {
      const id = url.searchParams.get("id")
      if (id) {
        const raw = await store.get(id, { type: "text" })
        if (!raw) return json(404, { status: "error", message: "文章不存在" }, req)
        return json(200, { status: "success", data: JSON.parse(raw) }, req)
      }
      const index = await getArticleIndex(store)
      return json(200, { status: "success", data: index }, req)
    }

    // POST: 创建或更新
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const { id, title, tags, author, excerpt, image, content, status } = body
      if (!title || !content) return badRequest("title 和 content 必填", req)

      const articleId = id || randomUUID().slice(0, 8)
      const now = new Date().toISOString().slice(0, 10)
      const wordCount = content.length

      const tagsArr = Array.isArray(tags) ? tags : (tags || "").split(",").map((t: string) => t.trim()).filter(Boolean)

      // 提取摘要
      const autoExcerpt = content
        .replace(/#+\s+/g, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\n/g, " ")
        .trim()
        .slice(0, 150)

      // 生成文件名
      const filename = `${articleId}.md`

      const articleData = {
        id: articleId,
        filename,
        title,
        tags: tagsArr,
        author: author || "渡鸦NULL",
        excerpt: excerpt || autoExcerpt + "...",
        image: image || "",
        content,
        wordCount,
        status: status || "published",
        createdAt: now,
        updatedAt: now,
      }

      // 保存文章内容
      await store.set(articleId, JSON.stringify(articleData))

      // 更新索引
      const index = await getArticleIndex(store)
      const existing = index.findIndex(a => a.id === articleId)
      const meta: ArticleMeta = {
        id: articleId,
        filename,
        title,
        date: existing >= 0 ? index[existing].date : now,
        update: existing >= 0 ? now : undefined,
        tags: tagsArr,
        author: author || "渡鸦NULL",
        excerpt: articleData.excerpt,
        image: image || "",
        wordCount,
        status: status || "published",
      }

      if (existing >= 0) {
        index[existing] = meta
      } else {
        index.unshift(meta)
      }
      await saveArticleIndex(store, index)

      return json(200, { status: "success", data: meta }, req)
    }

    // DELETE: 删除文章
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id")
      if (!id) return badRequest("id 必填", req)

      await store.set(id, "")

      const index = await getArticleIndex(store)
      const next = index.filter(a => a.id !== id)
      await saveArticleIndex(store, next)

      return json(200, { status: "success", message: "已删除" }, req)
    }
  }

  // ===== 图片管理 =====

  if (path === "images") {
    const store = getBlobStore(IMAGE_STORE)

    if (req.method === "GET") {
      const list = await store.list({ prefix: "" })
      const images = []
      for (const blob of list.blobs) {
        if (blob.key === "_index") continue
        images.push({
          key: blob.key,
          url: `/api/admin-image?key=${blob.key}`,
        })
      }
      return json(200, { status: "success", data: images }, req)
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const { data, mime, name } = body
      if (!data || !mime) return badRequest("data 和 mime 必填", req)
      if (!ALLOWED_MIME[mime]) return badRequest("不支持的图片格式", req)

      const buf = Buffer.from(data, "base64")
      if (buf.length > MAX_IMAGE_BYTES) return badRequest("图片过大（限 10MB）", req)

      const ext = ALLOWED_MIME[mime]
      const id = name || `${randomUUID().slice(0, 8)}.${ext}`
      await store.set(id, data)

      return json(200, {
        status: "success",
        key: id,
        url: `/api/admin-image?key=${id}`,
      }, req)
    }

    if (req.method === "DELETE") {
      const key = url.searchParams.get("key")
      if (!key) return badRequest("key 必填", req)
      await store.set(key, "")
      return json(200, { status: "success", message: "已删除" }, req)
    }
  }

  return json(404, { status: "error", message: "未知操作" }, req)
}

export const config = { path: "/api/admin" }
