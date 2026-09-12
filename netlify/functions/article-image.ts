import { randomUUID } from "node:crypto"
import { json, badRequest, noContent } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"

const IMAGE_STORE = "article-images"
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10MB
const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
}

/**
 * /api/article-image  (Netlify Functions v2)
 *
 * 文章图片独立存储，与图库（blog-images）完全隔离。
 *
 * POST { data: "<base64>", mime: "image/png" }  上传图片，返回 { url }
 * GET  ?key=xxx                                 读取图片
 * DELETE ?key=xxx                               删除图片（需 X-Admin-Key）
 */
export default async (req: Request) => {
  if (req.method === "OPTIONS") return noContent(req)

  const params = new URL(req.url).searchParams

  if (req.method === "GET") {
    // 支持两种路由：/api/article-image?key=xxx（旧）与 /images/a/xxx.webp（缓存友好）
    const url = new URL(req.url)
    const pathMatch = url.pathname.match(/^\/images\/a\/([^/]+)$/)
    const key = pathMatch
      ? decodeURIComponent(pathMatch[1])
      : params.get("key")
    if (!key) return badRequest("key 必填", req)
    try {
      const store = getBlobStore(IMAGE_STORE, "strong")
      const raw = await store.get(key, { type: "text" })
      if (!raw) return new Response("Not found", { status: 404 })
      const buf = Buffer.from(raw, "base64")
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
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "读取图片失败" }, req)
    }
  }

  if (req.method === "POST") {
    // 两种上传方式都支持：
    //   1) multipart/form-data（Vditor 拖拽/粘贴/工具栏上传，字段名 file）
    //   2) JSON { data: "<base64>", mime, name }（后台图库选择/封面上传等）
    const contentType = req.headers.get("content-type") || ""
    const name0 = ""
    let buf: Buffer
    let mime = ""
    let name = name0

    if (contentType.includes("multipart/form-data")) {
      try {
        const fd = await req.formData()
        const file = fd.get("file")
        if (!(file instanceof File)) return badRequest("file 字段必填", req)
        mime = file.type || ""
        name = file.name || ""
        buf = Buffer.from(await file.arrayBuffer())
      } catch {
        return badRequest("表单解析失败", req)
      }
    } else {
      let body: any = {}
      try {
        body = await req.json()
      } catch {
        return badRequest("请求体不是合法 JSON", req)
      }
      const data = typeof body.data === "string" ? body.data : ""
      mime = typeof body.mime === "string" ? body.mime : ""
      name = typeof body.name === "string" ? body.name : ""
      if (!data) return badRequest("data 必填（base64 图片）", req)
      try {
        buf = Buffer.from(data, "base64")
      } catch {
        return badRequest("base64 解码失败", req)
      }
    }

    if (!mime) mime = "image/png"
    if (!ALLOWED_MIME[mime]) {
      // 剪贴板偶尔给出非常规 mime，按扩展名兜底
      const lower = (name || "").toLowerCase()
      const guess = lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg"
        : lower.endsWith(".gif") ? "image/gif"
          : lower.endsWith(".webp") ? "image/webp"
            : lower.endsWith(".svg") ? "image/svg+xml"
              : ""
      if (guess) mime = guess
      else return badRequest("仅支持 jpg / png / gif / webp / svg 图片", req)
    }
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
        finalKey = `${randomUUID().slice(0, 4)}_${baseName}.webp`
      } catch (err) {
        const ext = ALLOWED_MIME[mime]
        finalKey = `${randomUUID().slice(0, 4)}_${safeName || randomUUID().slice(0, 8)}.${ext}`
      }
    } else {
      finalKey = `${randomUUID().slice(0, 4)}_${safeName || randomUUID().slice(0, 8)}.svg`
    }

    const store = getBlobStore(IMAGE_STORE, "strong")

    // key 冲突时追加随机后缀
    const existing = await store.get(finalKey, { type: "text" })
    if (existing) {
      finalKey = `${randomUUID().slice(0, 8)}_${finalKey}`
    }

    await store.set(finalKey, finalBuf.toString("base64"))

    // 验证写入
    try {
      const verify = await store.get(finalKey, { type: "text" })
      if (!verify || verify.length < 10) {
        return json(500, { status: "error", message: "图片写入失败，请重试" }, req)
      }
    } catch {
      return json(500, { status: "error", message: "图片写入验证失败" }, req)
    }

    return json(200, {
      status: "success",
      url: `/images/a/${finalKey}`,
      key: finalKey,
      converted: !isSvg,
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
      const store = getBlobStore(IMAGE_STORE, "strong")
      await store.delete(key)
      return json(200, { status: "success", message: "已删除" }, req)
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "删除失败" }, req)
    }
  }

  return badRequest("Method Not Allowed", req)
}

export const config = { path: ["/api/article-image", "/images/a/:key"] }
