import { getBlobStore } from "./_shared/blob"

const IMAGE_STORE = "blog-images"
const THUMB_STORE = "blog-image-thumbs"
// 缩略图最长边：1080px 在常见高分屏（2x DPR）下图库网格（每列约 300-600px）依然清晰
const THUMB_MAX = 1080
const THUMB_QUALITY = 80
// 缩略图缓存 key 带尺寸后缀：调整尺寸后旧缓存不冲突
const THUMB_VERSION = "@v1080"

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
  if (wantThumbFinal) {
    try {
      const thumbStore = getBlobStore(THUMB_STORE, "strong")
      const cached = await thumbStore.get(key + THUMB_VERSION, { type: "text" })
      if (cached) {
        return new Response(Buffer.from(cached, "base64"), {
          headers: {
            "Content-Type": "image/webp",
            "Cache-Control": "public, max-age=31536000",
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
          "Cache-Control": "public, max-age=31536000",
        },
      })
    } catch {
      // 缩略图生成失败：回退原图
    }
  }

  return new Response(buf, {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=31536000",
    },
  })
}

export const config = { path: ["/api/admin-image", "/images/g/:key", "/images/g-thumb/:key", "/images/t/:key"] }
