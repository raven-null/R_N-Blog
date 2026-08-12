import { randomUUID } from "node:crypto"
import { getBlobStore } from "./blob"

const ARTICLE_STORE = "blog-articles"

export interface ArticleMeta {
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

export interface CreateArticleInput {
  title: string
  tags?: string[]
  excerpt?: string
  image?: string
  content: string
  status?: "published" | "draft"
  author?: string
}

export async function getArticleIndex(store?: ReturnType<typeof getBlobStore>): Promise<ArticleMeta[]> {
  const s = store || getBlobStore(ARTICLE_STORE)
  const raw = await s.get("index", { type: "text" })
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

export async function getArticleIndexStrong(): Promise<ArticleMeta[]> {
  const raw = await getBlobStore(ARTICLE_STORE, "strong").get("index", { type: "text" })
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

export async function saveArticleIndex(index: ArticleMeta[]) {
  await getBlobStore(ARTICLE_STORE).set("index", JSON.stringify(index))
}

export async function readArticle(id: string): Promise<any | null> {
  try {
    const raw = await getBlobStore(ARTICLE_STORE).get(id, { type: "text" })
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

/** 从正文自动提取摘要（与 admin.ts 逻辑一致） */
export function autoExcerpt(content: string): string {
  return content
    ? content.replace(/#+\s+/g, "").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
        .replace(/`([^`]+)`/g, "$1").replace(/\n/g, " ").trim().slice(0, 150)
    : ""
}

/** 创建或更新文章（复用 admin.ts 的写入索引、同步标签注册表、置顶逻辑） */
export async function createArticle(input: CreateArticleInput): Promise<{ articleId: string; meta: ArticleMeta; url: string }> {
  const title = String(input.title || "").trim()
  if (!title) throw new Error("title 必填")
  const content = String(input.content || "")

  const articleId = randomUUID().slice(0, 8)
  const now = new Date().toISOString().slice(0, 10)
  const wordCount = content.length

  const tagsArr = Array.isArray(input.tags)
    ? input.tags.map((t: string) => String(t).trim()).filter(Boolean)
    : String(input.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean)

  const excerpt = String(input.excerpt || "").trim() || autoExcerpt(content) + "..."
  const filename = `${articleId}.md`
  const author = input.author || "渡鸦NULL"
  const status = input.status === "draft" ? "draft" : "published"

  const articleData = {
    id: articleId,
    filename,
    title,
    tags: tagsArr,
    author,
    excerpt,
    image: input.image || "",
    content,
    wordCount,
    status,
    createdAt: now,
    updatedAt: now,
  }

  const store = getBlobStore(ARTICLE_STORE)
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

  // 更新索引（强一致读取，新建置顶）
  const index = await getArticleIndexStrong()
  const meta: ArticleMeta = {
    id: articleId,
    filename,
    title,
    date: now,
    tags: tagsArr,
    author,
    excerpt,
    image: input.image || "",
    wordCount,
    status,
  }
  index.unshift(meta)
  await saveArticleIndex(index)

  return { articleId, meta, url: `/article.html?id=${articleId}` }
}
