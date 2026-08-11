import { json, noContent, badRequest } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"

const CHAT_STORE = "blog-chat"
const MAX_CLIENT_ID = 64
const MAX_SESSIONS = 30
const MAX_MESSAGES = 200
const MAX_CONTENT = 20000
const MAX_NAME = 50

function sanitizeClientId(value: unknown): string {
  if (typeof value !== "string") return ""
  return value.trim().replace(/[^\w\-.:@]/g, "").slice(0, MAX_CLIENT_ID)
}

function sanitizeSessions(sessions: unknown): any[] {
  if (!Array.isArray(sessions)) return []
  return sessions.slice(0, MAX_SESSIONS).map(s => {
    const session = (s && typeof s === "object" ? s : {}) as any
    const messages = Array.isArray(session.messages) ? session.messages.slice(0, MAX_MESSAGES) : []
    const cleanMessages = messages.map((m: any) => {
      const role = m && ["user", "assistant", "system"].includes(m.role) ? m.role : "user"
      const content = typeof m?.content === "string" ? m.content.slice(0, MAX_CONTENT) : ""
      return { role, content }
    })
    return {
      id: typeof session.id === "string" ? session.id.slice(0, 64) : "",
      name: typeof session.name === "string" ? session.name.slice(0, MAX_NAME) : "会话",
      messages: cleanMessages,
    }
  }).filter(s => s.id)
}

/**
 * /api/chat  (Netlify Functions v2)
 *
 * 前台 AI 助手的会话记录持久化（按访客 clientId 存储到 Netlify Blobs）
 *
 * GET    ?clientId=xxx            读取该访客的会话列表
 * POST   { clientId, sessions, currentSessionId }   保存会话
 * DELETE ?clientId=xxx            清空该访客的全部会话
 */
export default async (req: Request) => {
  if (req.method === "OPTIONS") return noContent(req)

  const params = new URL(req.url).searchParams
  const store = getBlobStore(CHAT_STORE, "strong")

  if (req.method === "GET") {
    const clientId = sanitizeClientId(params.get("clientId"))
    if (!clientId) return badRequest("clientId 必填", req)
    const raw = await store.get(`client:${clientId}`, { type: "text" })
    let data = { sessions: [] as any[], currentSessionId: "" }
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.sessions)) {
          data = {
            sessions: parsed.sessions,
            currentSessionId: typeof parsed.currentSessionId === "string" ? parsed.currentSessionId : "",
          }
        }
      } catch {}
    }
    return json(200, { status: "success", data }, req)
  }

  if (req.method === "POST") {
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      return badRequest("请求体不是合法 JSON", req)
    }
    const clientId = sanitizeClientId(body.clientId)
    if (!clientId) return badRequest("clientId 必填", req)

    const sessions = sanitizeSessions(body.sessions)
    let currentSessionId = typeof body.currentSessionId === "string" ? body.currentSessionId.slice(0, 64) : ""
    if (!sessions.some(s => s.id === currentSessionId)) {
      currentSessionId = sessions.length ? sessions[0].id : ""
    }

    await store.set(`client:${clientId}`, JSON.stringify({ sessions, currentSessionId }))
    return json(200, { status: "success", data: { sessions, currentSessionId } }, req)
  }

  if (req.method === "DELETE") {
    const clientId = sanitizeClientId(params.get("clientId"))
    if (!clientId) return badRequest("clientId 必填", req)
    await store.delete(`client:${clientId}`)
    return json(200, { status: "success", message: "已清空" }, req)
  }

  return badRequest("Method Not Allowed", req)
}

export const config = { path: "/api/chat" }
