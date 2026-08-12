import { randomUUID, createHash } from "node:crypto"
import { getBlobStore, readComments } from "./blob"

const TASK_STORE = "blog-agent-tasks"
const COMMENT_STORE = "newsnow-comments"

export interface AgentTask {
  id: string
  source: "admin" | "comment"
  instruction: string
  status: "pending" | "running" | "done" | "failed"
  progress: string
  postId?: string
  commentId?: string
  requestedStatus?: "published" | "draft"
  result?: { articleId: string; title: string; url: string; status: string }
  error?: string
  ip?: string
  createdAt: number
  startedAt: number
  finishedAt: number
}

export interface AgentSettings {
  enabled: boolean
  triggerKeywords: string[]
  publishStrategy: "draft" | "published"
  maxTasksPerIpPerDay: number
  dailyGlobalLimit: number
  maxInstructionLength: number
  commentName: string
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: true,
  triggerKeywords: ["@管理员", "@ai", "@博主"],
  publishStrategy: "draft",
  maxTasksPerIpPerDay: 3,
  dailyGlobalLimit: 20,
  maxInstructionLength: 500,
  commentName: "🤖 AI Agent",
}

export async function getAgentSettings(): Promise<AgentSettings> {
  try {
    const store = getBlobStore("blog-settings", "strong")
    const raw = await store.get("site", { type: "text" })
    const data = raw ? JSON.parse(raw) : {}
    const a = data.agent || {}
    const kw = typeof a.triggerKeywords === "string"
      ? a.triggerKeywords.split(",").map((s: string) => s.trim()).filter(Boolean)
      : Array.isArray(a.triggerKeywords) ? a.triggerKeywords : []
    return {
      enabled: a.enabled !== false,
      triggerKeywords: kw.length ? kw : DEFAULT_AGENT_SETTINGS.triggerKeywords,
      publishStrategy: a.publishStrategy === "published" ? "published" : "draft",
      maxTasksPerIpPerDay: Number(a.maxTasksPerIpPerDay) > 0 ? Number(a.maxTasksPerIpPerDay) : DEFAULT_AGENT_SETTINGS.maxTasksPerIpPerDay,
      dailyGlobalLimit: Number(a.dailyGlobalLimit) > 0 ? Number(a.dailyGlobalLimit) : DEFAULT_AGENT_SETTINGS.dailyGlobalLimit,
      maxInstructionLength: Number(a.maxInstructionLength) > 0 ? Number(a.maxInstructionLength) : DEFAULT_AGENT_SETTINGS.maxInstructionLength,
      commentName: String(a.commentName || DEFAULT_AGENT_SETTINGS.commentName).slice(0, 32),
    }
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS }
  }
}

// 读取后台密码（与 admin.ts / ai.ts 保持一致）
export async function getAdminPassword(): Promise<string> {
  const envPwd = process.env.ADMIN_KEY
  if (envPwd) return envPwd
  try {
    const store = getBlobStore("blog-auth", "strong")
    const raw = await store.get("password", { type: "text" })
    if (raw) return raw
  } catch (e) {}
  return "1111"
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
  source: "admin" | "comment"
  instruction: string
  postId?: string
  commentId?: string
  requestedStatus?: "published" | "draft"
  ip?: string
}): AgentTask {
  return {
    id: randomUUID().slice(0, 8),
    source: input.source,
    instruction: String(input.instruction || "").trim().slice(0, 2000),
    status: "pending",
    progress: "等待执行",
    postId: input.postId,
    commentId: input.commentId,
    requestedStatus: input.requestedStatus,
    ip: input.ip,
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0,
  }
}

// ===================== 限流 =====================

export async function checkAgentRateLimit(settings: AgentSettings, ip: string): Promise<string | null> {
  const tasks = await listTasks()
  const dayStart = Date.now() - 86400000
  const today = tasks.filter(t => t.createdAt >= dayStart)
  if (today.length >= settings.dailyGlobalLimit) {
    return "今日全局任务已达上限，请明天再试"
  }
  if (ip) {
    const byIp = today.filter(t => t.ip === ip).length
    if (byIp >= settings.maxTasksPerIpPerDay) {
      return "今日任务次数已达上限，请明天再试"
    }
  }
  return null
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

/** 后端直写一条 Agent 评论（受理/完成/失败），不走访客提交接口 */
export async function writeAgentComment(postId: string, content: string, name: string): Promise<boolean> {
  if (!postId || !content) return false
  try {
    const store = getBlobStore(COMMENT_STORE, "strong")
    const list = await readComments(postId)
    list.push({
      id: randomUUID(),
      postId,
      name,
      content: String(content).slice(0, 2000),
      createdAt: Date.now(),
    })
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
