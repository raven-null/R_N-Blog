import { getBlobStore } from "./_shared/blob"

const IMAGE_STORE = "blog-images"

export default async (req: Request) => {
  const url = new URL(req.url)
  const key = url.searchParams.get("key")
  if (!key) return new Response("key required", { status: 400 })

  const store = getBlobStore(IMAGE_STORE)
  const raw = await store.get(key, { type: "text" })
  if (!raw) return new Response("Not found", { status: 404 })

  const buf = Buffer.from(raw, "base64")

  // 从 key 推断 mime
  const ext = key.split(".").pop()?.toLowerCase() || "png"
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  }

  return new Response(buf, {
    headers: {
      "Content-Type": mimeMap[ext] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000",
    },
  })
}

export const config = { path: "/api/admin-image" }
