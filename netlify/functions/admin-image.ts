import { getBlobStore } from "./_shared/blob"

const IMAGE_STORE = "blog-images"
const THUMB_STORE = "blog-image-thumbs"
const THUMB_MAX = 420 // 缩略图最长边（px）

export default async (req: Request) => {
  const url = new URL(req.url)
  const key = url.searchParams.get("key")
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
  const wantThumb = url.searchParams.get("thumb") === "1" && ext !== "svg"
  if (wantThumb) {
    try {
      const thumbStore = getBlobStore(THUMB_STORE, "strong")
      const cached = await thumbStore.get(key, { type: "text" })
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

  if (wantThumb) {
    try {
      const sharp = (await import("sharp")).default
      const thumbBuf = await sharp(buf)
        .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer()
      buf = Buffer.from(thumbBuf)
      const thumbStore = getBlobStore(THUMB_STORE)
      await thumbStore.set(key, buf.toString("base64"))
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

export const config = { path: "/api/admin-image" }
