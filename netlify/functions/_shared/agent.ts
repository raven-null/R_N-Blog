import { randomUUID, createHash } from "node:crypto"
import { getBlobStore, readComments } from "./blob"
import { getAdminPassword } from "./auth"

export { getAdminPassword }

const TASK_STORE = "blog-agent-tasks"
const COMMENT_STORE = "newsnow-comments"

export interface AgentTask {
  id: string
  source: "admin" | "comment" | "chat"
  type: "article" | "qa"
  instruction: string
  status: "pending" | "running" | "done" | "failed"
  progress: string
  /** 进度百分比（0-100，前端进度条用） */
  progressPercent?: number
  postId?: string
  commentId?: string
  /** 受理评论 id（问答任务完成后原位更新为答案） */
  ackCommentId?: string
  /** 公开轮询密钥（chat 来源用，前端凭 key 查询状态） */
  pollKey?: string
  requestedStatus?: "published" | "draft"
  result?: { articleId: string; title: string; url: string; status: string } | { answer: string }
  error?: string
  ip?: string
  createdAt: number
  startedAt: number
  finishedAt: number
}

export interface AgentSettings {
  enabled: boolean
  /** 生成文章触发词（@管理员 等，需后台密钥） */
  articleTriggers: string[]
  /** 文章问答触发词（@ai 等，AI 助手回答） */
  qaTriggers: string[]
  publishStrategy: "draft" | "published"
  maxInstructionLength: number
  commentName: string
  shareWritingPrompt: boolean
  systemPrompt: string
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: true,
  articleTriggers: ["@管理员", "@博主"],
  qaTriggers: ["@ai", "@助手"],
  publishStrategy: "draft",
  maxInstructionLength: 500,
  commentName: "🤖 AI Agent",
  shareWritingPrompt: true,
  systemPrompt: "",
}

export async function getAgentSettings(): Promise<AgentSettings> {
  try {
    const store = getBlobStore("blog-settings", "strong")
    const raw = await store.get("site", { type: "text" })
    const data = raw ? JSON.parse(raw) : {}
    const a = data.agent || {}
    const arr = (v: unknown, def: string[]) => {
      const list = typeof v === "string"
        ? v.split(",").map((s: string) => s.trim()).filter(Boolean)
        : Array.isArray(v) ? v.map((s: unknown) => String(s).trim()).filter(Boolean) : []
      return list.length ? list : def
    }
    return {
      enabled: a.enabled !== false,
      articleTriggers: arr(a.articleTriggers, DEFAULT_AGENT_SETTINGS.articleTriggers),
      qaTriggers: arr(a.qaTriggers, DEFAULT_AGENT_SETTINGS.qaTriggers),
      publishStrategy: a.publishStrategy === "published" ? "published" : "draft",
      maxInstructionLength: Number(a.maxInstructionLength) > 0 ? Number(a.maxInstructionLength) : DEFAULT_AGENT_SETTINGS.maxInstructionLength,
      commentName: String(a.commentName || DEFAULT_AGENT_SETTINGS.commentName).slice(0, 32),
      shareWritingPrompt: a.shareWritingPrompt !== false,
      systemPrompt: String(a.systemPrompt || "").trim(),
    }
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS }
  }
}

/** 判定评论命中的触发类型：生成文章 / 文章问答 / 无 */
export function detectTriggerType(content: string, settings: AgentSettings): "article" | "qa" | "" {
  if (matchTrigger(content, settings.articleTriggers)) return "article"
  if (matchTrigger(content, settings.qaTriggers)) return "qa"
  return ""
}

// agent-run 后台函数调用的安全令牌
export function agentRunKey(password: string): string {
  return createHash("sha256").update(password + ":agent-run").digest("hex")
}

// ===================== 任务存储 =====================

export async function listTasks(): Promise<AgentTask[]> {
  try {
    const store = getBlobStore(TASK_STORE, "strong")
    const raw = await store.get("index", { type: "text" })
    const ids: string[] = raw ? JSON.parse(raw) : []
    const tasks: AgentTask[] = []
    for (const id of ids) {
      const t = await store.get(`task:${id}`, { type: "text" })
      if (t) {
        try { tasks.push(JSON.parse(t)) } catch {}
      }
    }
    return tasks.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export async function getTask(id: string): Promise<AgentTask | null> {
  try {
    const store = getBlobStore(TASK_STORE, "strong")
    const raw = await store.get(`task:${id}`, { type: "text" })
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export async function saveTask(task: AgentTask): Promise<void> {
  const store = getBlobStore(TASK_STORE, "strong")
  await store.set(`task:${task.id}`, JSON.stringify(task))
  try {
    const raw = await store.get("index", { type: "text" })
    const ids: string[] = raw ? JSON.parse(raw) : []
    if (!ids.includes(task.id)) {
      ids.unshift(task.id)
      await store.set("index", JSON.stringify(ids.slice(0, 100)))
    }
  } catch {}
}

export async function deleteTask(id: string): Promise<boolean> {
  try {
    const store = getBlobStore(TASK_STORE, "strong")
    await store.delete(`task:${id}`)
    const raw = await store.get("index", { type: "text" })
    const ids: string[] = raw ? JSON.parse(raw) : []
    const next = ids.filter(x => x !== id)
    await store.set("index", JSON.stringify(next))
    return true
  } catch {
    return false
  }
}

export function newTask(input: {
  source: "admin" | "comment" | "chat"
  type?: "article" | "qa"
  instruction: string
  postId?: string
  commentId?: string
  requestedStatus?: "published" | "draft"
  ip?: string
}): AgentTask {
  return {
    id: randomUUID().slice(0, 8),
    source: input.source,
    type: input.type === "qa" ? "qa" : "article",
    instruction: String(input.instruction || "").trim().slice(0, 2000),
    status: "pending",
    progress: "等待执行",
    progressPercent: 0,
    postId: input.postId,
    commentId: input.commentId,
    pollKey: randomUUID().slice(0, 16),
    requestedStatus: input.requestedStatus,
    ip: input.ip,
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0,
  }
}

/** 评论内容是否命中触发词 */
export function matchTrigger(content: string, keywords: string[]): boolean {
  if (!content) return false
  const c = content.toLowerCase()
  return keywords.some(k => c.includes(String(k).toLowerCase()))
}

/** 去掉评论中触发词前缀，得到指令正文 */
export function stripTrigger(content: string, keywords: string[]): string {
  let text = String(content || "").trim()
  for (const k of keywords) {
    const idx = text.toLowerCase().indexOf(String(k).toLowerCase())
    if (idx >= 0) {
      text = text.slice(idx + k.length)
      break
    }
  }
  return text.replace(/^[：:\s，,。]+/, "").trim()
}

// ===================== Agent 评论 =====================

/** 后端直写一条 Agent 评论（受理/完成/失败），不走访客提交接口，返回评论 id */
export async function writeAgentComment(postId: string, content: string, name: string): Promise<string | null> {
  if (!postId || !content) return null
  try {
    const store = getBlobStore(COMMENT_STORE, "strong")
    const list = await readComments(postId)
    const comment = {
      id: randomUUID(),
      postId,
      name,
      content: String(content).slice(0, 2000),
      createdAt: Date.now(),
    }
    list.push(comment)
    await store.set(`post:${postId}`, JSON.stringify(list))
    return comment.id
  } catch {
    return null
  }
}

/** 原位更新一条 Agent 评论（如「正在回答…」→ 最终答案） */
export async function updateAgentComment(postId: string, commentId: string, content: string): Promise<boolean> {
  if (!postId || !commentId || !content) return false
  try {
    const store = getBlobStore(COMMENT_STORE, "strong")
    const list = await readComments(postId)
    const c = list.find(x => x.id === commentId)
    if (!c) return false
    c.content = String(content).slice(0, 2000)
    await store.set(`post:${postId}`, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

/** 读取某篇文章的评论（校验评论存在） */
export async function findComment(postId: string, commentId: string): Promise<any | null> {
  const list = await readComments(postId)
  return list.find(c => c.id === commentId) || null
}
