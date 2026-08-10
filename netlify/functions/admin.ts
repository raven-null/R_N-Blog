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
      const { id, title, tags, author, excerpt, image, content, status, staticFile } = body
      if (!title) return badRequest("title 必填", req)

      const articleId = id || randomUUID().slice(0, 8)
      const now = new Date().toISOString().slice(0, 10)
      const wordCount = (content || "").length

      const tagsArr = Array.isArray(tags) ? tags : (tags || "").split(",").map((t: string) => t.trim()).filter(Boolean)

      // 提取摘要（有内容时自动提取，否则用传入的 excerpt）
      const autoExcerpt = content
        ? content.replace(/#+\s+/g, "").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/!\[([^\]]*)\]\([^)]+\)/g, "").replace(/`([^`]+)`/g, "$1").replace(/\n/g, " ").trim().slice(0, 150)
        : ""

      // 生成文件名
      const filename = staticFile || `${articleId}.md`

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
    const tagStore = getBlobStore("blog-image-tags")

    // 获取图片标签索引
    async function getImageTagIndex(): Promise<Record<string, string[]>> {
      const raw = await tagStore.get("index", { type: "text" })
      if (!raw) return {}
      try { return JSON.parse(raw) } catch { return {} }
    }
    async function saveImageTagIndex(idx: Record<string, string[]>) {
      await tagStore.set("index", JSON.stringify(idx))
    }

    if (req.method === "GET") {
      const tag = url.searchParams.get("tag")
      const tagIndex = await getImageTagIndex()
      const list = await store.list({ prefix: "" })
      const images = []
      for (const blob of list.blobs) {
        if (blob.key === "_index") continue
        const tags = tagIndex[blob.key] || []
        // 按标签筛选
        if (tag && !tags.includes(tag)) continue
        images.push({
          key: blob.key,
          url: `/api/admin-image?key=${blob.key}`,
          tags,
        })
      }
      return json(200, { status: "success", data: images }, req)
    }

    // PATCH: 更新图片标签
    if (req.method === "PATCH") {
      const body = await req.json().catch(() => ({}))
      const { key, tags } = body
      if (!key) return badRequest("key 必填", req)
      const tagIndex = await getImageTagIndex()
      tagIndex[key] = Array.isArray(tags) ? tags : (tags || "").split(",").map((t: string) => t.trim()).filter(Boolean)
      await saveImageTagIndex(tagIndex)
      return json(200, { status: "success", key, tags: tagIndex[key] }, req)
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const { data, mime, name, tags } = body
      if (!data || !mime) return badRequest("data 和 mime 必填", req)
      if (!ALLOWED_MIME[mime]) return badRequest("不支持的图片格式", req)

      const buf = Buffer.from(data, "base64")
      if (buf.length > MAX_IMAGE_BYTES) return badRequest("图片过大（限 10MB）", req)

      let finalBuf = buf
      let finalKey = ""
      const isSvg = mime === "image/svg+xml"

      if (!isSvg) {
        try {
          const sharp = (await import("sharp")).default
          finalBuf = await sharp(buf)
            .resize({ width: 1920, height: 1080, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 82 })
            .toBuffer()
          const baseName = name ? name.replace(/\.[^.]+$/, "") : randomUUID().slice(0, 8)
          finalKey = `${baseName}.webp`
        } catch (err) {
          const ext = ALLOWED_MIME[mime]
          finalKey = name || `${randomUUID().slice(0, 8)}.${ext}`
        }
      } else {
        finalKey = name || `${randomUUID().slice(0, 8)}.svg`
      }

      await store.set(finalKey, finalBuf.toString("base64"))

      // 保存标签
      if (tags) {
        const tagIndex = await getImageTagIndex()
        tagIndex[finalKey] = Array.isArray(tags) ? tags : (tags || "").split(",").map((t: string) => t.trim()).filter(Boolean)
        await saveImageTagIndex(tagIndex)
      }

      return json(200, {
        status: "success",
        key: finalKey,
        url: `/api/admin-image?key=${finalKey}`,
        converted: !isSvg,
      }, req)
    }

    if (req.method === "DELETE") {
      const key = url.searchParams.get("key")
      if (!key) return badRequest("key 必填", req)
      await store.set(key, "")
      // 清理标签
      const tagIndex = await getImageTagIndex()
      delete tagIndex[key]
      await saveImageTagIndex(tagIndex)
      return json(200, { status: "success", message: "已删除" }, req)
    }
  }

  // ===== 标签管理 =====

  if (path === "tags") {
    const imageStore = getBlobStore(IMAGE_STORE)
    const tagStore = getBlobStore("blog-image-tags")
    const articleStore = getBlobStore(ARTICLE_STORE)

    async function getImageTagIndex(): Promise<Record<string, string[]>> {
      const raw = await tagStore.get("index", { type: "text" })
      if (!raw) return {}
      try { return JSON.parse(raw) } catch { return {} }
    }
    async function saveImageTagIndex(idx: Record<string, string[]>) {
      await tagStore.set("index", JSON.stringify(idx))
    }
    async function getArticleIndex(): Promise<ArticleMeta[]> {
      const raw = await articleStore.get("index", { type: "text" })
      if (!raw) return []
      try { return JSON.parse(raw) } catch { return [] }
    }
    async function saveArticleIndex(index: ArticleMeta[]) {
      await articleStore.set("index", JSON.stringify(index))
    }

    // GET: 列出所有标签及其使用次数
    if (req.method === "GET") {
      const imageTagIndex = await getImageTagIndex()
      const articleIndex = await getArticleIndex()

      const tagMap: Record<string, { imageCount: number; articleCount: number }> = {}

      // 统计图片标签
      for (const tags of Object.values(imageTagIndex)) {
        for (const tag of tags) {
          if (!tagMap[tag]) tagMap[tag] = { imageCount: 0, articleCount: 0 }
          tagMap[tag].imageCount++
        }
      }

      // 统计文章标签
      for (const article of articleIndex) {
        for (const tag of (article.tags || [])) {
          if (!tagMap[tag]) tagMap[tag] = { imageCount: 0, articleCount: 0 }
          tagMap[tag].articleCount++
        }
      }

      const result = Object.entries(tagMap).map(([name, counts]) => ({
        name,
        imageCount: counts.imageCount,
        articleCount: counts.articleCount,
        total: counts.imageCount + counts.articleCount,
      })).sort((a, b) => b.total - a.total)

      return json(200, { status: "success", data: result }, req)
    }

    // PATCH: 重命名标签
    if (req.method === "PATCH") {
      const body = await req.json().catch(() => ({}))
      const { oldName, newName } = body
      if (!oldName || !newName) return badRequest("oldName 和 newName 必填", req)
      if (oldName === newName) return badRequest("新旧名称相同", req)

      let imageChanges = 0, articleChanges = 0

      // 更新图片标签
      const imageTagIndex = await getImageTagIndex()
      for (const [key, tags] of Object.entries(imageTagIndex)) {
        const idx = tags.indexOf(oldName)
        if (idx >= 0) {
          tags[idx] = newName
          imageChanges++
        }
      }
      await saveImageTagIndex(imageTagIndex)

      // 更新文章标签
      const articleIndex = await getArticleIndex()
      for (const article of articleIndex) {
        const idx = (article.tags || []).indexOf(oldName)
        if (idx >= 0) {
          article.tags[idx] = newName
          articleChanges++
        }
      }
      await saveArticleIndex(articleIndex)

      return json(200, { status: "success", imageChanges, articleChanges }, req)
    }

    // DELETE: 删除标签
    if (req.method === "DELETE") {
      const tagName = url.searchParams.get("name")
      if (!tagName) return badRequest("name 必填", req)

      let imageChanges = 0, articleChanges = 0

      // 从图片中移除
      const imageTagIndex = await getImageTagIndex()
      for (const [key, tags] of Object.entries(imageTagIndex)) {
        const idx = tags.indexOf(tagName)
        if (idx >= 0) {
          tags.splice(idx, 1)
          imageChanges++
        }
      }
      await saveImageTagIndex(imageTagIndex)

      // 从文章中移除
      const articleIndex = await getArticleIndex()
      for (const article of articleIndex) {
        const idx = (article.tags || []).indexOf(tagName)
        if (idx >= 0) {
          article.tags.splice(idx, 1)
          articleChanges++
        }
      }
      await saveArticleIndex(articleIndex)

      return json(200, { status: "success", imageChanges, articleChanges }, req)
    }
  }

  return json(404, { status: "error", message: "未知操作" }, req)
}

export const config = { path: "/api/admin" }
