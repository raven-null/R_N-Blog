import { getBlobStore } from "./_shared/blob"
import { getAdminPassword } from "./_shared/auth"

const IMAGE_STORE = "blog-images"
const THUMB_STORE = "blog-image-thumbs"
// 缩略图最长边：1080px 在常见高分屏（2x DPR）下图库网格（每列约 300-600px）依然清晰
const THUMB_MAX = 1080
const THUMB_QUALITY = 80
// 缩略图缓存 key 带尺寸后缀：调整尺寸后旧缓存不冲突
const THUMB_VERSION = "@v1080"
// R18 标签（大小写不敏感）：该标签下的图片原图仅管理员可访问
const R18_TAG = "r18"

// 判断图片是否被归类为 R18（读取图片标签索引）
async function isR18Image(key: string): Promise<boolean> {
  try {
    const tagStore = getBlobStore("blog-image-tags")
    const raw = await tagStore.get("index", { type: "text" })
    if (!raw) return false
    const index: Record<string, string[]> = JSON.parse(raw)
    const tags = index[key] || []
    return tags.some(t => String(t).toLowerCase() === R18_TAG)
  } catch {
    return false
  }
}

// 管理员校验：X-Admin-Key 请求头或 adminKey 查询参数（<img> 无法带 header，只能走 query）
async function isAdmin(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const provided = req.headers.get("x-admin-key") ?? url.searchParams.get("adminKey") ?? ""
  if (!provided) return false
  const password = await getAdminPassword()
  return provided === password
}

export default async (req: Request) => {
  const url = new URL(req.url)

  // 支持多种路由：
  //   /api/admin-image?key=xxx&thumb=1（旧）
  //   /images/g/xxx.webp（原图）、/images/g-thumb/xxx.webp（旧缩略图路径）
  //   /images/t/xxx.webp（新缩略图路径，更高分辨率）
  const pathMatch = url.pathname.match(/^\/images\/(g|g-thumb|t)\/([^/]+)$/)
  const key = pathMatch
    ? decodeURIComponent(pathMatch[2])
    : url.searchParams.get("key")
  const wantThumb = pathMatch
    ? pathMatch[1] === "g-thumb" || pathMatch[1] === "t"
    : url.searchParams.get("thumb") === "1"

  if (!key) return new Response("key required", { status: 400 })

  // 从 key 推断 mime
  const ext = key.split(".").pop()?.toLowerCase() || "png"
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  }
  const mime = mimeMap[ext] || "application/octet-stream"

  const store = getBlobStore(IMAGE_STORE, "strong")

  // 缩略图请求：优先读缓存 store，未命中实时生成并落盘（仅位图；svg 直接原图）。
  const wantThumbFinal = wantThumb && ext !== "svg"

  // R18 图片：缩略图与原图均仅管理员可访问（前台 R18 分类下显示锁定占位，验证密钥后才加载）
  const r18 = await isR18Image(key)
  if (r18 && !(await isAdmin(req))) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "Cache-Control": "private, no-store" },
    })
  }
  // R18 图片响应不做 CDN 缓存，避免绕过权限校验
  const cacheControl = r18 ? "private, no-store" : "public, max-age=31536000"

  if (wantThumbFinal) {
    try {
      const thumbStore = getBlobStore(THUMB_STORE, "strong")
      const cached = await thumbStore.get(key + THUMB_VERSION, { type: "text" })
      if (cached) {
        return new Response(Buffer.from(cached, "base64"), {
          headers: {
            "Content-Type": "image/webp",
            "Cache-Control": cacheControl,
          },
        })
      }
    } catch {
      // thumb store 不可用时回退原图路径
    }
  }

  const raw = await store.get(key, { type: "text" })
  if (!raw) return new Response("Not found", { status: 404 })

  let buf = Buffer.from(raw, "base64")

  if (wantThumbFinal) {
    try {
      const sharp = (await import("sharp")).default
      const thumbBuf = await sharp(buf)
        .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: "inside", withoutEnlargement: true })
        .webp({ quality: THUMB_QUALITY })
        .toBuffer()
      buf = Buffer.from(thumbBuf)
      const thumbStore = getBlobStore(THUMB_STORE)
      await thumbStore.set(key + THUMB_VERSION, buf.toString("base64"))
      return new Response(buf, {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": cacheControl,
        },
      })
    } catch {
      // 缩略图生成失败：回退原图
    }
  }

  return new Response(buf, {
    headers: {
      "Content-Type": mime,
      "Cache-Control": cacheControl,
    },
  })
}

export const config = { path: ["/api/admin-image", "/images/g/:key", "/images/g-thumb/:key", "/images/t/:key"] }
