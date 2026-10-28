import { json, noContent } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"

/**
 * GET /api/gallery  (Netlify Functions v2)
 *
 * 代理 r-gallery 站点的图库清单，并缓存到 Netlify Blobs，让访客不用每次都等
 * 上游那 8 秒左右的接口。
 *
 * 查询参数：
 *   limit=500      最多返回多少张（默认 500，上限 1000）
 *   refresh=1      跳过缓存强制刷新
 *
 * 环境变量（可选）：
 *   GALLERY_SOURCE     上游站点，默认 https://r-gallery.netlify.app
 *   GALLERY_CACHE_TTL  缓存毫秒数，默认 900000（15 分钟）
 *
 * 只代理观光模式（safe=1，上游已剔除 R16/R18）；管理员带 token 时前端仍直连全量。
 */

const SOURCE = (process.env.GALLERY_SOURCE || "https://r-gallery.netlify.app").replace(/\/+$/, "")
const CACHE_TTL = Number(process.env.GALLERY_CACHE_TTL || 15 * 60 * 1000)
const STORE = "gallery-cache"
const CACHE_KEY = "photos/safe"
const MAX_PAGES = 4
const PAGE_SIZE = 500

interface GalleryPhoto {
  id: string
  title: string
  rating: string
  tags: any[]
  categories: any[]
  thumb: string
  url: string
}

interface GalleryCache {
  updatedAt: number
  photos: GalleryPhoto[]
}

async function readCache(): Promise<GalleryCache | null> {
  try {
    const store = getBlobStore(STORE)
    const raw = await store.get(CACHE_KEY, { type: "text" })
    return raw ? (JSON.parse(raw) as GalleryCache) : null
  } catch {
    return null
  }
}

async function writeCache(cache: GalleryCache) {
  try {
    const store = getBlobStore(STORE)
    await store.set(CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* 缓存写失败不影响返回 */
  }
}

/** 分页拉完上游清单（cursor 循环，最多 MAX_PAGES 页） */
async function fetchPhotos(): Promise<GalleryPhoto[]> {
  const out: GalleryPhoto[] = []
  let cursor = ""

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), safe: "1" })
    if (cursor) params.set("cursor", cursor)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    let res: Response
    try {
      res = await fetch(`${SOURCE}/api/photos?${params.toString()}`, {
        headers: { "User-Agent": "raven-null-blog", Accept: "application/json" },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`上游接口 ${res.status}`)

    const data: any = await res.json()
    const photos = Array.isArray(data?.photos) ? data.photos : []

    for (const p of photos) {
      const id = String(p?.id ?? "")
      if (!id) continue
      out.push({
        id,
        title: String(p?.title || ""),
        rating: String(p?.rating || "general"),
        tags: Array.isArray(p?.tags) ? p.tags : [],
        categories: Array.isArray(p?.categories) ? p.categories : [],
        // 缩略图带 v=2：上游把缩略图从 480px 提到 960px，换 URL 才能绕过 CDN 旧缓存
        thumb: `${SOURCE}/api/photos/${encodeURIComponent(id)}/thumb?v=2`,
        url: `${SOURCE}/api/photos/${encodeURIComponent(id)}/raw`,
      })
    }

    cursor = String(data?.cursor || "")
    if (!cursor || !photos.length) break
  }

  return out
}

export default async (req: Request) => {
  const method = req.method || "GET"

  if (method === "OPTIONS") return noContent(req)
  if (method !== "GET") {
    return json(405, { status: "error", message: "Method Not Allowed" }, req)
  }

  const params = new URL(req.url).searchParams
  const refresh = params.get("refresh") === "1"
  const limit = Math.min(Math.max(Number(params.get("limit") || PAGE_SIZE), 1), 1000)

  const cached = await readCache()
  const stale = !cached || Date.now() - cached.updatedAt > CACHE_TTL

  if (cached && !refresh && !stale) {
    return json(200, {
      status: "success",
      cached: true,
      updatedAt: cached.updatedAt,
      count: cached.photos.length,
      photos: cached.photos.slice(0, limit),
    }, req)
  }

  try {
    const photos = await fetchPhotos()
    const updatedAt = Date.now()
    await writeCache({ updatedAt, photos })
    return json(200, {
      status: "success",
      cached: false,
      updatedAt,
      count: photos.length,
      photos: photos.slice(0, limit),
    }, req)
  } catch (err: any) {
    // 上游挂了但手上有旧缓存：给旧的，页面别空着
    if (cached) {
      return json(200, {
        status: "success",
        cached: true,
        stale: true,
        updatedAt: cached.updatedAt,
        count: cached.photos.length,
        photos: cached.photos.slice(0, limit),
      }, req)
    }
    return json(503, {
      status: "error",
      message: `图库清单暂不可用：${err?.message ?? err}`,
    }, req)
  }
}
