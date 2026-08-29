import { randomUUID } from "node:crypto"
import { json, badRequest, noContent } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"

const IMAGE_STORE = "comment-images"
const MAX_IMAGE_BYTES = 2 * 1024 * 1024 // 2MB
const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
}

/**
 * /api/upload  (Netlify Functions v2)
 *
 * POST { data: "<base64>", mime: "image/png" }  上传图片，返回 { url }
 * DELETE ?key=xxx                              删除图片（需 X-Admin-Key）
 */
export default async (req: Request) => {
  if (req.method === "OPTIONS") return noContent(req)

  const params = new URL(req.url).searchParams

  if (req.method === "POST") {
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      return badRequest("请求体不是合法 JSON", req)
    }

    const data = typeof body.data === "string" ? body.data : ""
    const mime = typeof body.mime === "string" ? body.mime : ""
    if (!data) return badRequest("data 必填（base64 图片）", req)
    if (!ALLOWED_MIME[mime]) return badRequest("仅支持 jpg / png / gif / webp 图片", req)

    let buf: Buffer
    try {
      buf = Buffer.from(data, "base64")
    } catch {
      return badRequest("base64 解码失败", req)
    }
    if (buf.length === 0) return badRequest("图片内容为空", req)
    if (buf.length > MAX_IMAGE_BYTES) return badRequest("图片过大（限 2MB）", req)

    const id = randomUUID()
    try {
      const store = getBlobStore(IMAGE_STORE)
      // key 带扩展名：/images/c/xxx.webp 缓存友好 URL 下可按扩展名推断 mime
      const ext = ALLOWED_MIME[mime] || "png"
      await store.set(`${id}.${ext}`, buf.toString("base64"))
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "上传失败" }, req)
    }

    const ext = ALLOWED_MIME[mime] || "png"
    return json(200, {
      status: "success",
      url: `/images/c/${id}.${ext}`,
      key: `${id}.${ext}`,
    }, req)
  }

  if (req.method === "DELETE") {
    const adminKey = process.env.ADMIN_KEY
    const provided = req.headers.get("x-admin-key") ?? params.get("adminKey") ?? ""
    if (adminKey && provided !== adminKey) {
      return badRequest("无权限", req)
    }
    const key = params.get("key")
    if (!key) return badRequest("key 必填", req)
    try {
      const store = getBlobStore(IMAGE_STORE)
      await store.delete(key)
      return json(200, { status: "success", message: "已删除" }, req)
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "删除失败" }, req)
    }
  }

  return badRequest("Method Not Allowed", req)
}
