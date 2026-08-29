import { badRequest, json, noContent } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"

const IMAGE_STORE = "comment-images"

/**
 * /api/image  (Netlify Functions v2)
 *
 * GET ?key=xxx&mime=image/png   按 key 读取已上传的留言图片
 */
export default async (req: Request) => {
  if (req.method === "OPTIONS") return noContent(req)
  if (req.method !== "GET") return badRequest("Method Not Allowed", req)

  const params = new URL(req.url).searchParams
  const key = params.get("key")
  if (!key) return badRequest("key 必填", req)

  try {
    const store = getBlobStore(IMAGE_STORE)
    const raw = await store.get(key)
    if (!raw) return json(404, { status: "error", message: "图片不存在" }, req)
    // mime 优先取参数（兼容旧 URL），否则按 key 扩展名推断（新缓存友好 URL 无 mime 参数）
    const ext = key.split(".").pop()?.toLowerCase() || ""
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    }
    const mime = params.get("mime") || mimeMap[ext] || "image/png"
    const buf = Buffer.from(raw as string, "base64")
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=31536000",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (err: any) {
    return json(500, { status: "error", message: err?.message || "读取图片失败" }, req)
  }
}
