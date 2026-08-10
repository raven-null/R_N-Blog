import { randomUUID } from "node:crypto"
import { json, noContent, badRequest } from "./_shared/cors"
import { readComments, appendComment, deleteComment, listAllComments } from "./_shared/blob"
import type { Comment } from "./_shared/types"

const MAX_NAME = 32
const MAX_CONTENT = 5000
const MAX_COMMENTS_PER_POST = 500

function sanitize(input: string) {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function safeText(value: unknown, max: number): string {
  if (typeof value !== "string") return ""
  return sanitize(value).slice(0, max)
}

/**
 * /api/comments  (Netlify Functions v2)
 *
 * GET  ?postId=xxx            获取某篇文章的留言
 * GET  ?list=1                全站留言汇总（管理用）
 * GET  ?diag=1                存储环境诊断
 * POST  { postId, name, content }   提交留言
 * DELETE ?postId=xxx&id=yyy   删除留言（需 X-Admin-Key）
 */
export default async (req: Request, context: any) => {
  const method = req.method || "GET"

  if (method === "OPTIONS") return noContent(req)

  const params = new URL(req.url).searchParams

  if (method === "GET") {
    if (params.get("diag") === "1") {
      const g = globalThis as any
      let getStoreResult = "not-tested"
      try {
        const { getStore } = await import("@netlify/blobs")
        const store = getStore({ name: "diag-test" })
        await store.set("ping", "pong")
        const value = await store.get("ping", { type: "text" })
        getStoreResult = value === "pong" ? "OK" : `unexpected-value:${value}`
      } catch (err: any) {
        getStoreResult = `ERROR: ${err?.message ?? err}`
      }
      return json(200, {
        status: "success",
        diag: {
          siteId: !!process.env.SITE_ID,
          netlify: !!process.env.NETLIFY,
          blobsToken: !!process.env.NETLIFY_BLOBS_TOKEN,
          blobsSiteId: !!process.env.NETLIFY_BLOBS_SITE_ID,
          blobsContextEnv: !!process.env.NETLIFY_BLOBS_CONTEXT,
          accessToken: !!process.env.NETLIFY_ACCESS_TOKEN,
          globalBlobsContext: !!g?.netlifyBlobsContext,
          globalContextKeys: g?.netlifyBlobsContext ? Object.keys(g.netlifyBlobsContext) : [],
          getStoreTest: getStoreResult,
        },
      }, req)
    }

    if (params.get("list") === "1") {
      const summary = await listAllComments()
      const total = summary.reduce((acc, s) => acc + s.count, 0)
      return json(200, { status: "success", total, posts: summary }, req)
    }

    const postId = safeText(params.get("postId"), 200)
    if (!postId) return badRequest("postId 必填", req)
    const comments = await readComments(postId)
    return json(200, { status: "success", postId, count: comments.length, comments }, req)
  }

  if (method === "POST") {
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      return badRequest("请求体不是合法 JSON", req)
    }

    const postId = safeText(body.postId, 200)
    const name = safeText(body.name, MAX_NAME)
    const content = safeText(body.content, MAX_CONTENT)
    // 图片为 /api/image?key=... 链接，仅接受以 /api/image 开头或同源相对路径
    let image = typeof body.image === "string" ? sanitize(body.image).slice(0, 300) : ""
    if (image && !image.startsWith("/api/image?")) image = ""

    if (!postId) return badRequest("postId 必填", req)
    if (!name) return badRequest("name 必填", req)
    if (!content) return badRequest("content 必填", req)
    if (content.length < 1) return badRequest("content 太短", req)

    const existing = await readComments(postId)
    if (existing.length >= MAX_COMMENTS_PER_POST) {
      return badRequest("该文章留言已达上限", req)
    }

    const linkCount = (content.match(/https?:\/\//g) || []).length
    if (linkCount > 3) {
      return badRequest("留言包含过多链接，疑似垃圾信息", req)
    }

    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    const comment: Comment = {
      id: randomUUID(),
      postId,
      name,
      content,
      image: image || undefined,
      createdAt: Date.now(),
      ip: context?.ip || req.headers.get("x-nf-client-connection-ip") || forwarded,
    }

    try {
      await appendComment(postId, comment)
    } catch (err: any) {
      return json(500, { status: "error", message: err?.message || "存储留言失败，请稍后再试" }, req)
    }
    return json(200, { status: "success", message: "留言成功", comment }, req)
  }

  if (method === "DELETE") {
    const adminKey = process.env.ADMIN_KEY
    const provided = req.headers.get("x-admin-key") ?? ""
    if (adminKey && provided !== adminKey) {
      return badRequest("无权限", req)
    }
    const postId = safeText(params.get("postId"), 200)
    const id = safeText(params.get("id"), 64)
    if (!postId || !id) return badRequest("postId 与 id 必填", req)
    const ok = await deleteComment(postId, id)
    if (!ok) return badRequest("留言不存在", req)
    return json(200, { status: "success", message: "已删除" }, req)
  }

  return badRequest("Method Not Allowed", req)
}
