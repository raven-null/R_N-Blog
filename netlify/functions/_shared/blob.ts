import { getStore } from "@netlify/blobs"
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { NewsCache } from "./types"

const NEWS_STORE = "newsnow-news"
const NEWS_KEY = "latest"

const COMMENT_STORE = "newsnow-comments"

const LOCAL_DIR = join(process.cwd(), ".local-data")

interface KVStore {
  get(key: string, opts?: { type: "text" }): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(opts: { prefix: string }): Promise<{ blobs: { key: string }[] }>
}

function localStore(name: string): KVStore {
  const dir = join(LOCAL_DIR, name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return {
    async get(key, opts) {
      const file = join(dir, key)
      if (!existsSync(file)) return null
      return readFileSync(file, "utf-8")
    },
    async set(key, value) {
      writeFileSync(join(dir, key), value, "utf-8")
    },
    async delete(key) {
      const file = join(dir, key)
      if (existsSync(file)) unlinkSync(file)
    },
    async list({ prefix }) {
      if (!existsSync(dir)) return { blobs: [] }
      const blobs = readdirSync(dir)
        .filter(f => f.startsWith(prefix))
        .map(f => ({ key: f }))
      return { blobs }
    },
  }
}

export function getBlobStore(name: string, consistency?: "strong" | "eventual"): KVStore {
  const { SITE_ID, NETLIFY_BLOBS_TOKEN, NETLIFY_ACCESS_TOKEN } = process.env
  try {
    // 生产环境优先显式凭据；本地开发或 Blobs 未配置时 getStore 会抛 MissingBlobsEnvironmentError
    const options: any = { name, ...(consistency ? { consistency } : {}) }
    if (SITE_ID && (NETLIFY_BLOBS_TOKEN || NETLIFY_ACCESS_TOKEN)) {
      options.siteID = SITE_ID
      options.token = NETLIFY_BLOBS_TOKEN || NETLIFY_ACCESS_TOKEN
    }
    return getStore(options)
  } catch (err: any) {
    const isMissingBlobs = String(err?.code) === "MissingBlobsEnvironmentError"
      || String(err?.message ?? "").includes("MissingBlobsEnvironmentError")
    if (SITE_ID) {
      // 已部署到 Netlify 但 Blobs 未启用：明确报错，避免静默丢数据
      const e = new Error(
        isMissingBlobs
          ? "Netlify Blobs 未启用：请在 Netlify 站点 Settings → Data collection 开启 Netlify Blobs（否则留言无法持久化）"
          : `Netlify Blobs 存储不可用：${err?.message ?? err}`,
      )
      ;(e as any).code = "BLOBS_UNAVAILABLE"
      throw e
    }
    // 本地开发：回退到本地文件，方便调试
    return localStore(name)
  }
}

// ===================== 资讯缓存 =====================

export async function readNewsCache(): Promise<NewsCache | null> {
  try {
    const store = getBlobStore(NEWS_STORE)
    const raw = await store.get(NEWS_KEY, { type: "text" })
    return raw ? (JSON.parse(raw) as NewsCache) : null
  } catch {
    return null
  }
}

export async function writeNewsCache(cache: NewsCache) {
  try {
    const store = getBlobStore(NEWS_STORE)
    await store.set(NEWS_KEY, JSON.stringify(cache))
    return true
  } catch {
    return false
  }
}

// ===================== 留言存储 =====================

function commentKey(postId: string) {
  return `post:${postId}`
}

export async function readComments(postId: string) {
  try {
    const store = getBlobStore(COMMENT_STORE, "strong")
    const raw = await store.get(commentKey(postId), { type: "text" })
    return raw ? (JSON.parse(raw) as any[]) : []
  } catch {
    return []
  }
}

export async function appendComment(postId: string, comment: any) {
  const store = getBlobStore(COMMENT_STORE, "strong")
  const list = await readComments(postId)
  list.push(comment)
  await store.set(commentKey(postId), JSON.stringify(list))
  return comment
}

export async function deleteComment(postId: string, commentId: string) {
  const store = getBlobStore(COMMENT_STORE, "strong")
  const list = await readComments(postId)
  const next = list.filter(c => c.id !== commentId)
  if (next.length === list.length) return false
  await store.set(commentKey(postId), JSON.stringify(next))
  return true
}

/**
 * 全站留言列表（用于管理页）：遍历所有 post 前缀键
 */
export async function listAllComments(): Promise<{ postId: string; count: number; latest: any }[]> {
  try {
    const store = getBlobStore(COMMENT_STORE, "strong")
    const list = await store.list({ prefix: "post:" })
    const result: { postId: string; count: number; latest: any }[] = []
    for (const item of list.blobs) {
      const raw = await store.get(item.key, { type: "text" })
      const arr = raw ? (JSON.parse(raw) as any[]) : []
      if (arr.length) {
        result.push({
          postId: item.key.slice("post:".length),
          count: arr.length,
          latest: arr[arr.length - 1],
        })
      }
    }
    return result
  } catch {
    return []
  }
}
