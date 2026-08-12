import { randomUUID, createHash } from "node:crypto"
import { json, badRequest, noContent } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"
import { getAdminPassword, checkAuth } from "./_shared/auth"
import { DEFAULT_AGENT_SETTINGS } from "./_shared/agent"
import { MODEL_CATALOG, resolveModelApiUrl, resolveTemperature } from "./_shared/models"

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

// 设置后台密码
async function setAdminPassword(password: string): Promise<void> {
  const store = getBlobStore("blog-auth", "strong")
  await store.set("password", password)
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

// 使用强一致性读取文章索引，避免最终一致性导致读到旧数据
async function getArticleIndexStrong(store: ReturnType<typeof getBlobStore>): Promise<ArticleMeta[]> {
  const raw = await getBlobStore(ARTICLE_STORE, "strong").get("index", { type: "text" })
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
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
    const validPwd = await getAdminPassword()
    if (key !== validPwd) {
      return json(401, { status: "error", message: "密钥错误" }, req)
    }
    return json(200, { status: "success", token: generateToken(key) }, req)
  }

  // ===== 文章管理（公开读取） =====

  if (path === "articles") {
    const store = getBlobStore(ARTICLE_STORE)

    // GET: 列表或单篇（公开访问）
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

    // 以下写操作需要认证
    if (!(await checkAuth(req))) {
      return json(401, { status: "error", message: "未授权" }, req)
    }

    // 重排文章索引（拖拽排序）：body.ids 为期望的全量顺序 id 列表
    if (url.searchParams.get("reorder") === "1") {
      const body = await req.json().catch(() => ({}))
      const ids = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === "string") : []
      const index = await getArticleIndexStrong(store)
      const byId = new Map(index.map(a => [a.id, a]))
      const next: ArticleMeta[] = []
      for (const id of ids) {
        const meta = byId.get(id)
        if (meta) { next.push(meta); byId.delete(id) }
      }
      for (const meta of byId.values()) next.push(meta)
      await saveArticleIndex(store, next)
      return json(200, { status: "success", message: "已更新排序" }, req)
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

      // 同步文章标签到注册表
      try {
        const registryStore = getBlobStore("blog-tag-registry")
        const rawReg = await registryStore.get("index", { type: "text" })
        const reg = rawReg ? JSON.parse(rawReg) : { article: [], image: [] }
        for (const tag of tagsArr) {
          if (!reg.article.includes(tag)) reg.article.push(tag)
        }
        await registryStore.set("index", JSON.stringify(reg))
      } catch (e) {}

      // 更新索引（使用强一致性读取，避免读到旧数据）
      const index = await getArticleIndexStrong(store)
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
        index.splice(existing, 1)
      }
      // 新建或编辑后始终置顶
      index.unshift(meta)
      await saveArticleIndex(store, index)

      return json(200, { status: "success", data: meta }, req)
    }

    // DELETE: 删除文章
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id")
      if (!id) return badRequest("id 必填", req)

      await store.delete(id)

      const index = await getArticleIndex(store)
      const next = index.filter(a => a.id !== id)
      await saveArticleIndex(store, next)

      return json(200, { status: "success", message: "已删除" }, req)
    }

    // PATCH: 修改文章状态（发布 / 下架）
    if (req.method === "PATCH") {
      const body = await req.json().catch(() => ({}))
      const { id, status } = body
      if (!id) return badRequest("id 必填", req)
      if (status !== "published" && status !== "draft") return badRequest("status 必须是 published 或 draft", req)

      const raw = await store.get(id, { type: "text" })
      if (!raw) return json(404, { status: "error", message: "文章不存在" }, req)
      const article = JSON.parse(raw)
      article.status = status
      article.updatedAt = new Date().toISOString().slice(0, 10)
      await store.set(id, JSON.stringify(article))

      // 更新索引（状态变更后置顶）
      const index = await getArticleIndexStrong(store)
      const idx = index.findIndex(a => a.id === id)
      if (idx >= 0) {
        index[idx].status = status
        const meta = index[idx]
        index.splice(idx, 1)
        index.unshift(meta)
      }
      await saveArticleIndex(store, index)

      return json(200, { status: "success", message: status === "published" ? "已发布" : "已下架为草稿" }, req)
    }
  }

  // ===== 图片管理 =====

  if (path === "images") {
    const store = getBlobStore(IMAGE_STORE, "strong")
    const tagStore = getBlobStore("blog-image-tags", "strong")

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
        // 跳过已删除（空内容）的 blob，并顺带清理
        const raw = await store.get(blob.key, { type: "text" })
        if (!raw || raw.length < 10) {
          try { await store.delete(blob.key) } catch {}
          continue
        }
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
      const newTags = Array.isArray(tags) ? tags : (tags || "").split(",").map((t: string) => t.trim()).filter(Boolean)
      tagIndex[key] = newTags

      // 同步图片标签到注册表
      try {
        const registryStore = getBlobStore("blog-tag-registry")
        const rawReg = await registryStore.get("index", { type: "text" })
        const reg = rawReg ? JSON.parse(rawReg) : { article: [], image: [] }
        for (const tag of newTags) {
          if (!reg.image.includes(tag)) reg.image.push(tag)
        }
        await registryStore.set("index", JSON.stringify(reg))
      } catch (e) {}

      await saveImageTagIndex(tagIndex)
      return json(200, { status: "success", key, tags: tagIndex[key] }, req)
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const { data, mime, name, tags } = body
      if (!data || !mime) return badRequest("data 和 mime 必填", req)
      if (!ALLOWED_MIME[mime]) return badRequest("不支持的图片格式", req)

      const buf = Buffer.from(data, "base64")
      if (buf.length === 0) return badRequest("图片内容为空", req)
      if (buf.length > MAX_IMAGE_BYTES) return badRequest("图片过大（限 10MB）", req)

      let finalBuf = buf
      let finalKey = ""
      const isSvg = mime === "image/svg+xml"
      const safeName = (name || "").replace(/\s+/g, "_").replace(/[^\w.\-]/g, "").replace(/\.(webp|jpg|jpeg|png|gif|svg)$/i, "")

      if (!isSvg) {
        try {
          const sharp = (await import("sharp")).default
          const sharpBuf = await sharp(buf)
            .resize({ width: 1920, height: 1080, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 82 })
            .toBuffer()
          finalBuf = Buffer.from(sharpBuf)
          const baseName = safeName || randomUUID().slice(0, 8)
          // 使用 UUID 前缀避免文件名冲突覆盖
          finalKey = `${randomUUID().slice(0, 4)}_${baseName}.webp`
        } catch (err) {
          const ext = ALLOWED_MIME[mime]
          finalKey = `${randomUUID().slice(0, 4)}_${safeName || randomUUID().slice(0, 8)}.${ext}`
        }
      } else {
        finalKey = `${randomUUID().slice(0, 4)}_${safeName || randomUUID().slice(0, 8)}.svg`
      }

      // 如果 key 已存在，追加随机后缀避免覆盖
      const existing = await store.get(finalKey, { type: "text" })
      if (existing) {
        finalKey = `${randomUUID().slice(0, 8)}_${finalKey}`
      }

      await store.set(finalKey, finalBuf.toString("base64"))

      // 验证写入是否成功（使用 strong consistency 立即读取）
      try {
        const verify = await getBlobStore(IMAGE_STORE, "strong").get(finalKey, { type: "text" })
        if (!verify || verify.length < 10) {
          return json(500, { status: "error", message: "图片写入失败，请重试" }, req)
        }
      } catch (e) {
        return json(500, { status: "error", message: "图片写入验证失败" }, req)
      }

      // 保存标签
      if (tags) {
        const tagIndex = await getImageTagIndex()
        const tagsArr = Array.isArray(tags) ? tags : (tags || "").split(",").map((t: string) => t.trim()).filter(Boolean)
        tagIndex[finalKey] = tagsArr

        // 同步图片标签到注册表
        try {
          const registryStore = getBlobStore("blog-tag-registry")
          const rawReg = await registryStore.get("index", { type: "text" })
          const reg = rawReg ? JSON.parse(rawReg) : { article: [], image: [] }
          for (const tag of tagsArr) {
            if (!reg.image.includes(tag)) reg.image.push(tag)
          }
          await registryStore.set("index", JSON.stringify(reg))
        } catch (e) {}

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
      await store.delete(key)
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
    const tagStore = getBlobStore("blog-image-tags", "strong")
    const articleStore = getBlobStore(ARTICLE_STORE, "strong")
    const registryStore = getBlobStore("blog-tag-registry", "strong")

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
    // 标签注册表：{ article: string[], image: string[] }
    async function getRegistry(): Promise<{ article: string[]; image: string[] }> {
      const raw = await registryStore.get("index", { type: "text" })
      if (!raw) return { article: [], image: [] }
      try { return JSON.parse(raw) } catch { return { article: [], image: [] } }
    }
    async function saveRegistry(reg: { article: string[]; image: string[] }) {
      await registryStore.set("index", JSON.stringify(reg))
    }

    // GET: 列出所有标签（注册表 + 实际使用统计）
    if (req.method === "GET") {
      const imageTagIndex = await getImageTagIndex()
      const articleIndex = await getArticleIndex()
      const registry = await getRegistry()

      const tagMap: Record<string, { imageCount: number; articleCount: number }> = {}

      // 从注册表初始化（确保空标签也出现）
      for (const tag of registry.article) {
        if (!tagMap[tag]) tagMap[tag] = { imageCount: 0, articleCount: 0 }
        tagMap[tag].articleCount = tagMap[tag].articleCount // 保持为0，后面会统计
      }
      for (const tag of registry.image) {
        if (!tagMap[tag]) tagMap[tag] = { imageCount: 0, articleCount: 0 }
        tagMap[tag].imageCount = tagMap[tag].imageCount // 保持为0，后面会统计
      }

      // 统计图片实际使用
      for (const tags of Object.values(imageTagIndex)) {
        for (const tag of tags) {
          if (!tagMap[tag]) tagMap[tag] = { imageCount: 0, articleCount: 0 }
          tagMap[tag].imageCount++
        }
      }

      // 统计文章实际使用
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
        // 标记标签属于哪个类别（注册表 或 实际使用）
        inArticleRegistry: registry.article.includes(name) || counts.articleCount > 0,
        inImageRegistry: registry.image.includes(name) || counts.imageCount > 0,
      })).sort((a, b) => b.total - a.total)

      return json(200, { status: "success", data: result }, req)
    }

    // POST: 添加新标签到注册表
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const { name, type } = body
      if (!name) return badRequest("name 必填", req)
      if (!type || !["article", "image"].includes(type)) return badRequest("type 必须是 article 或 image", req)

      const registry = await getRegistry()
      const list = type === "article" ? registry.article : registry.image
      if (!list.includes(name)) {
        list.push(name)
        await saveRegistry(registry)
      }
      return json(200, { status: "success", name, type }, req)
    }

    // PATCH: 重命名标签
    if (req.method === "PATCH") {
      const body = await req.json().catch(() => ({}))
      const { oldName, newName } = body
      if (!oldName || !newName) return badRequest("oldName 和 newName 必填", req)
      if (oldName === newName) return badRequest("新旧名称相同", req)

      let imageChanges = 0, articleChanges = 0

      // 更新注册表
      const registry = await getRegistry()
      const ai = registry.article.indexOf(oldName)
      if (ai >= 0) registry.article[ai] = newName
      const ii = registry.image.indexOf(oldName)
      if (ii >= 0) registry.image[ii] = newName
      await saveRegistry(registry)

      // 更新图片标签
      const imageTagIndex = await getImageTagIndex()
      for (const [key, tags] of Object.entries(imageTagIndex)) {
        const idx = tags.indexOf(oldName)
        if (idx >= 0) { tags[idx] = newName; imageChanges++ }
      }
      await saveImageTagIndex(imageTagIndex)

      // 更新文章标签
      const articleIndex = await getArticleIndex()
      for (const article of articleIndex) {
        const idx = (article.tags || []).indexOf(oldName)
        if (idx >= 0) { article.tags[idx] = newName; articleChanges++ }
      }
      await saveArticleIndex(articleIndex)

      return json(200, { status: "success", imageChanges, articleChanges }, req)
    }

    // DELETE: 删除标签
    if (req.method === "DELETE") {
      const tagName = url.searchParams.get("name")
      if (!tagName) return badRequest("name 必填", req)

      let imageChanges = 0, articleChanges = 0

      // 从注册表移除
      const registry = await getRegistry()
      registry.article = registry.article.filter(t => t !== tagName)
      registry.image = registry.image.filter(t => t !== tagName)
      await saveRegistry(registry)

      // 从图片中移除
      const imageTagIndex = await getImageTagIndex()
      for (const [key, tags] of Object.entries(imageTagIndex)) {
        const idx = tags.indexOf(tagName)
        if (idx >= 0) { tags.splice(idx, 1); imageChanges++ }
      }
      await saveImageTagIndex(imageTagIndex)

      // 从文章中移除
      const articleIndex = await getArticleIndex()
      for (const article of articleIndex) {
        const idx = (article.tags || []).indexOf(tagName)
        if (idx >= 0) { article.tags.splice(idx, 1); articleChanges++ }
      }
      await saveArticleIndex(articleIndex)

      return json(200, { status: "success", imageChanges, articleChanges }, req)
    }
  }

  // ===== 博客设置 =====

  if (path === "settings") {
    const settingsStore = getBlobStore("blog-settings", "strong")

    // 默认设置（通用默认值，打包分发时用户可自行修改）
    const DEFAULT_SETTINGS = {
      siteTitle: "我的博客",
      favicon: "",
      siteName: "",
      avatar: "",
      authorName: "",
      bio: "",
      views: { blog: true, gallery: true, news: true, dashboard: true },
      stats: { posts: true, tags: true, words: true, images: true },
      navTags: [],
      about: { version: "", tech: "", updated: "" },
      ai: {
        enabled: true,
        provider: "zhipu",
        apiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        apiKey: "5dc4e465fad643a7b486d85e2f35594f.l105oILErFBpytEq",
        model: "glm-4-flash",
        systemPrompt: "",
        maxTokens: 2048,
        temperature: 0.7,
      },
      // 写作 AI（后台写文章用，与前台聊天 AI 独立配置）
      writingAi: {
        enabled: true,
        provider: "zhipu",
        apiUrl: "",
        apiKey: "",
        model: "",
        systemPrompt: "",
        keywords: "",
        maxTokens: 4096,
        temperature: 0.7,
      },
      // AI Agent（自动写作发布：后台指令 + 评论区 @管理员 触发）
      agent: { ...DEFAULT_AGENT_SETTINGS },
    }

    // GET: 读取设置（公开，首页需要）
    if (req.method === "GET") {
      const raw = await settingsStore.get("site", { type: "text" })
      const data = raw ? JSON.parse(raw) : {}
      const storedAi = data.ai || {}
      const aiDefaults = DEFAULT_SETTINGS.ai
      const storedWritingAi = data.writingAi || {}
      const writingAiDefaults = DEFAULT_SETTINGS.writingAi
      const storedAgent = data.agent || {}
      const agentDefaults = DEFAULT_AGENT_SETTINGS
      // 合并默认值，确保关键字段有值
      const merged = {
        ...DEFAULT_SETTINGS,
        ...data,
        views: { ...DEFAULT_SETTINGS.views, ...(data.views || {}) },
        stats: { ...DEFAULT_SETTINGS.stats, ...(data.stats || {}) },
        about: { ...DEFAULT_SETTINGS.about, ...(data.about || {}) },
        // AI 字段留空时回退到内置默认值，保证开箱即用
        ai: {
          ...aiDefaults,
          ...storedAi,
          provider: storedAi.provider || aiDefaults.provider,
          apiUrl: storedAi.apiUrl || aiDefaults.apiUrl,
          apiKey: storedAi.apiKey || aiDefaults.apiKey,
          model: storedAi.model || aiDefaults.model,
          systemPrompt: storedAi.systemPrompt || aiDefaults.systemPrompt,
          maxTokens: Number(storedAi.maxTokens) > 0 ? Number(storedAi.maxTokens) : aiDefaults.maxTokens,
          temperature: resolveTemperature(
            storedAi.provider || aiDefaults.provider,
            storedAi.model || aiDefaults.model,
            typeof storedAi.temperature === "number" && !Number.isNaN(storedAi.temperature) ? storedAi.temperature : aiDefaults.temperature,
          ),
        },
        // 写作 AI：apiUrl/apiKey/model 留空时不在此处回退（由 /api/ai 后端回退 ai），其余字段用默认值
        writingAi: {
          ...writingAiDefaults,
          ...storedWritingAi,
          provider: storedWritingAi.provider || "",
          systemPrompt: storedWritingAi.systemPrompt || writingAiDefaults.systemPrompt,
          keywords: storedWritingAi.keywords || writingAiDefaults.keywords,
          maxTokens: Number(storedWritingAi.maxTokens) > 0 ? Number(storedWritingAi.maxTokens) : writingAiDefaults.maxTokens,
          temperature: resolveTemperature(
            storedWritingAi.provider || "",
            storedWritingAi.model || "",
            typeof storedWritingAi.temperature === "number" && !Number.isNaN(storedWritingAi.temperature) ? storedWritingAi.temperature : writingAiDefaults.temperature,
          ),
        },
        navTags: data.navTags && data.navTags.length ? data.navTags : DEFAULT_SETTINGS.navTags,
        // AI Agent 设置
        agent: {
          enabled: storedAgent.enabled !== false,
          articleTriggers: Array.isArray(storedAgent.articleTriggers) && storedAgent.articleTriggers.length
            ? storedAgent.articleTriggers
            : agentDefaults.articleTriggers,
          qaTriggers: Array.isArray(storedAgent.qaTriggers) && storedAgent.qaTriggers.length
            ? storedAgent.qaTriggers
            : agentDefaults.qaTriggers,
          publishStrategy: storedAgent.publishStrategy === "published" ? "published" : "draft",
          maxInstructionLength: Number(storedAgent.maxInstructionLength) > 0 ? Number(storedAgent.maxInstructionLength) : agentDefaults.maxInstructionLength,
          commentName: String(storedAgent.commentName || agentDefaults.commentName).slice(0, 32),
          shareWritingPrompt: storedAgent.shareWritingPrompt !== false,
          systemPrompt: String(storedAgent.systemPrompt || "").trim(),
        },
      }
      return json(200, { status: "success", data: merged }, req)
    }

    // POST: 保存设置（需认证）
    if (!(await checkAuth(req))) {
      return json(401, { status: "error", message: "未授权" }, req)
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      const { siteTitle, favicon, siteName, avatar, authorName, bio, views, stats, navTags, about, ai, writingAi, agent } = body

      // 修改密码操作
      if (body.oldPassword !== undefined || body.newPassword !== undefined) {
        const oldPassword = String(body.oldPassword || "")
        const newPassword = String(body.newPassword || "")
        const currentPwd = await getAdminPassword()
        if (oldPassword !== currentPwd) {
          return json(401, { status: "error", message: "当前密码错误" }, req)
        }
        if (!newPassword || newPassword.length < 4) {
          return badRequest("新密码至少 4 位", req)
        }
        await setAdminPassword(newPassword)
        return json(200, { status: "success", message: "密码已更新" }, req)
      }

      // 允许保存空值（默认无个人信息）
      const settings = {
        siteTitle: String(siteTitle || "").trim(),
        favicon: String(favicon || "").trim(),
        siteName: String(siteName || "").trim(),
        avatar: String(avatar || "").trim(),
        authorName: String(authorName || "").trim(),
        bio: String(bio || "").trim(),
        views: {
          blog: views?.blog !== false,
          gallery: views?.gallery !== false,
          news: views?.news !== false,
          dashboard: views?.dashboard !== false,
        },
        stats: {
          posts: stats?.posts !== false,
          tags: stats?.tags !== false,
          words: stats?.words !== false,
          images: stats?.images !== false,
        },
        navTags: Array.isArray(navTags) ? navTags.map(t => String(t).trim()).filter(Boolean) : [],
        about: {
          version: String(about?.version || "").trim(),
          tech: String(about?.tech || "").trim(),
          updated: String(about?.updated || "").trim(),
        },
        ai: {
          enabled: ai?.enabled !== false,
          provider: String(ai?.provider || "").trim().slice(0, 40),
          apiUrl: String(ai?.apiUrl || "").trim(),
          apiKey: String(ai?.apiKey || "").trim(),
          model: String(ai?.model || "").trim(),
          systemPrompt: String(ai?.systemPrompt || "").trim(),
          maxTokens: Number(ai?.maxTokens) > 0 ? Number(ai?.maxTokens) : 2048,
          temperature: typeof ai?.temperature === "number" && !Number.isNaN(ai.temperature) ? ai.temperature : 0.7,
        },
        writingAi: {
          enabled: writingAi?.enabled !== false,
          provider: String(writingAi?.provider || "").trim().slice(0, 40),
          apiUrl: String(writingAi?.apiUrl || "").trim(),
          apiKey: String(writingAi?.apiKey || "").trim(),
          model: String(writingAi?.model || "").trim(),
          systemPrompt: String(writingAi?.systemPrompt || "").trim(),
          keywords: String(writingAi?.keywords || "").trim(),
          maxTokens: Number(writingAi?.maxTokens) > 0 ? Number(writingAi?.maxTokens) : 4096,
          temperature: typeof writingAi?.temperature === "number" && !Number.isNaN(writingAi.temperature) ? writingAi.temperature : 0.7,
        },
        agent: {
          enabled: agent?.enabled !== false,
          articleTriggers: String(agent?.articleTriggers || "").split(",").map((t: string) => t.trim()).filter(Boolean),
          qaTriggers: String(agent?.qaTriggers || "").split(",").map((t: string) => t.trim()).filter(Boolean),
          publishStrategy: agent?.publishStrategy === "published" ? "published" : "draft",
          maxInstructionLength: Number(agent?.maxInstructionLength) > 0 ? Number(agent?.maxInstructionLength) : DEFAULT_AGENT_SETTINGS.maxInstructionLength,
          commentName: String(agent?.commentName || "").trim().slice(0, 32) || DEFAULT_AGENT_SETTINGS.commentName,
          shareWritingPrompt: agent?.shareWritingPrompt !== false,
          systemPrompt: String(agent?.systemPrompt || "").trim(),
        },
      }
      await settingsStore.set("site", JSON.stringify(settings))
      return json(200, { status: "success", data: settings }, req)
    }

    return badRequest("Method Not Allowed", req)
  }

  // ===== 数据迁移 =====

  if (path === "migrate") {
    if (req.method !== "POST") return badRequest("Method Not Allowed", req)
    const body = await req.json().catch(() => ({}))
    const { articles: migrateArticles, images: migrateImages } = body

    const articleStore = getBlobStore(ARTICLE_STORE)
    const imageStore = getBlobStore(IMAGE_STORE)
    const tagStore = getBlobStore("blog-image-tags")

    let articleCount = 0
    let imageCount = 0

    // 迁移文章
    if (Array.isArray(migrateArticles)) {
      const index = await getArticleIndex(articleStore)
      for (const a of migrateArticles) {
        const articleId = a.id || randomUUID().slice(0, 8)
        const now = new Date().toISOString().slice(0, 10)
        const tagsArr = Array.isArray(a.tags) ? a.tags : (a.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean)
        const content = a.content || ""
        const autoExcerpt = content
          ? content.replace(/#+\s+/g, "").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/!\[([^\]]*)\]\([^)]+\)/g, "").replace(/`([^`]+)`/g, "$1").replace(/\n/g, " ").trim().slice(0, 150)
          : ""

        const articleData = {
          id: articleId,
          filename: a.filename || `${articleId}.md`,
          title: a.title,
          tags: tagsArr,
          author: a.author || "渡鸦NULL",
          excerpt: a.excerpt || autoExcerpt + "...",
          image: a.image || "",
          content,
          wordCount: content.length,
          status: a.status || "published",
          createdAt: a.date || now,
          updatedAt: a.update || now,
        }

        await articleStore.set(articleId, JSON.stringify(articleData))

        const existing = index.findIndex((x: ArticleMeta) => x.id === articleId)
        const meta: ArticleMeta = {
          id: articleId,
          filename: articleData.filename,
          title: articleData.title,
          date: existing >= 0 ? index[existing].date : (a.date || now),
          update: existing >= 0 ? (a.update || now) : undefined,
          tags: tagsArr,
          author: articleData.author,
          excerpt: articleData.excerpt,
          image: articleData.image,
          wordCount: articleData.wordCount,
          status: articleData.status,
        }

        if (existing >= 0) {
          index[existing] = meta
        } else {
          index.push(meta)
        }
        articleCount++
      }
      await saveArticleIndex(articleStore, index)
    }

    // 迁移图片
    if (Array.isArray(migrateImages)) {
      const getTagIndex = async (): Promise<Record<string, string[]>> => {
        const raw = await tagStore.get("index", { type: "text" })
        if (!raw) return {}
        try { return JSON.parse(raw) } catch { return {} }
      }
      const tagIndex = await getTagIndex()

      for (const img of migrateImages) {
        if (!img.data || !img.key) continue
        // 检查是否已存在
        const existing = await imageStore.get(img.key, { type: "text" })
        if (existing) {
          // 已存在，只更新标签
          if (img.tags) {
            tagIndex[img.key] = Array.isArray(img.tags) ? img.tags : [img.tags]
          }
          continue
        }
        await imageStore.set(img.key, img.data)
        if (img.tags) {
          tagIndex[img.key] = Array.isArray(img.tags) ? img.tags : [img.tags]
        }
        imageCount++
      }
      await tagStore.set("index", JSON.stringify(tagIndex))
    }

    return json(200, {
      status: "success",
      message: `迁移完成：${articleCount} 篇文章，${imageCount} 张图片`,
      articleCount,
      imageCount,
    }, req)
  }

  // ===== 内置模型库（AI 设置下拉用） =====

  if (path === "models") {
    if (req.method !== "GET") return badRequest("Method Not Allowed", req)
    return json(200, { status: "success", data: MODEL_CATALOG }, req)
  }

  // ===== 测试 AI 连接（选模型 + API Key 后验证可用） =====

  if (path === "test-ai") {
    if (req.method !== "POST") return badRequest("Method Not Allowed", req)
    if (!(await checkAuth(req))) return json(401, { status: "error", message: "未授权" }, req)
    const body = await req.json().catch(() => ({}))
    const provider = String(body.provider || "").trim()
    const model = String(body.model || "").trim()
    const apiKey = String(body.apiKey || "").trim()
    const customUrl = String(body.apiUrl || "").trim()
    if (!model) return badRequest("model 必填", req)
    if (!apiKey) return badRequest("apiKey 必填", req)
    const apiUrl = resolveModelApiUrl(provider, model, customUrl)
    if (!apiUrl) return badRequest("无法解析接口地址，请填写自定义接口地址", req)
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 8,
          stream: false,
        }),
      })
      if (!res.ok) {
        const err = await res.text().catch(() => "")
        return json(502, { status: "error", message: `接口返回 ${res.status}：${err.slice(0, 200)}` }, req)
      }
      return json(200, { status: "success", message: "连接成功" }, req)
    } catch (err: any) {
      return json(500, { status: "error", message: `连接失败：${err?.message || err}` }, req)
    }
  }

  // ===== 设置卡片排序（博客设置拖拽排序持久化） =====

  if (path === "setting-order") {
    const settingsStore = getBlobStore("blog-settings", "strong")
    if (req.method === "GET") {
      const raw = await settingsStore.get("setting-order", { type: "text" })
      const data = raw ? JSON.parse(raw) : {}
      return json(200, { status: "success", data }, req)
    }
    if (req.method === "POST") {
      if (!(await checkAuth(req))) return json(401, { status: "error", message: "未授权" }, req)
      const body = await req.json().catch(() => ({}))
      const order = body.order
      if (!order || typeof order !== "object" || Array.isArray(order)) return badRequest("order 必填", req)
      const clean: Record<string, string[]> = {}
      for (const key of Object.keys(order)) {
        if (Array.isArray(order[key])) {
          clean[key] = order[key].map((s: unknown) => String(s).slice(0, 100)).filter(Boolean).slice(0, 30)
        }
      }
      await settingsStore.set("setting-order", JSON.stringify(clean))
      return json(200, { status: "success", message: "已保存排序", data: clean }, req)
    }
    return badRequest("Method Not Allowed", req)
  }

  return json(404, { status: "error", message: "未知操作" }, req)
}

export const config = { path: "/api/admin" }
