import { randomUUID } from "node:crypto"
import { json, noContent, badRequest } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"
import { checkAuth } from "./_shared/auth"

/**
 * /api/life  (Netlify Functions v2)
 *
 * 任务 + 日记，仅管理员可访问（全部方法都要 X-Admin-Key）。
 * 数据按月分片存进 Netlify Blobs：
 *   tasks/YYYY-MM     -> Task[]
 *   journals/YYYY-MM  -> Journal[]   ← 一个月一份，天然就是「按月归档」
 *
 * GET    ?month=YYYY-MM              读取该月任务与日记（默认当月）
 * GET    ?months=1                   列出已有归档的月份
 * POST   { type:'task', date, title }            新增任务
 * POST   { type:'task', id, date, done?, title? } 更新任务
 * POST   { type:'journal', date, content }       写入/更新某天日记
 * DELETE ?type=task&date=YYYY-MM-DD&id=xxx       删除任务
 */

const STORE = "blog-life"
const MONTH_RE = /^\d{4}-\d{2}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_TITLE = 120
const MAX_JOURNAL = 20000

interface Task {
  id: string
  date: string
  title: string
  done: boolean
  createdAt: number
}

interface Journal {
  date: string
  content: string
  updatedAt: number
}

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

function monthOf(date: string): string {
  return date.slice(0, 7)
}

/** 日期必须存在（2026-13-99 这种只有格式合法的要拦掉） */
function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const d = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date
}

/** Blobs key 只允许字母数字与 / - _ . */
function taskKey(month: string) {
  return `tasks/${month}`
}
function journalKey(month: string) {
  return `journals/${month}`
}

async function readList<T>(key: string): Promise<T[]> {
  try {
    const store = getBlobStore(STORE, "strong")
    const raw = await store.get(key, { type: "text" })
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

async function writeList<T>(key: string, list: T[]) {
  const store = getBlobStore(STORE, "strong")
  await store.set(key, JSON.stringify(list))
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return ""
  return value.replace(/\r\n/g, "\n").trim().slice(0, max)
}

export default async (req: Request) => {
  const method = req.method || "GET"

  if (method === "OPTIONS") return noContent(req)
  if (!(await checkAuth(req))) {
    return json(401, { status: "error", message: "需要后台登录（X-Admin-Key 无效）" }, req)
  }

  const params = new URL(req.url).searchParams

  if (method === "GET") {
    // 列出有归档的月份
    if (params.get("months") === "1") {
      try {
        const store = getBlobStore(STORE, "strong")
        const listed = await store.list({ prefix: "journals/" })
        const months = listed.blobs
          .map(b => b.key.slice("journals/".length))
          .filter(m => MONTH_RE.test(m))
          .sort()
          .reverse()
        return json(200, { status: "success", months }, req)
      } catch {
        return json(200, { status: "success", months: [] }, req)
      }
    }

    const month = MONTH_RE.test(params.get("month") || "") ? params.get("month")! : currentMonth()
    const [tasks, journals] = await Promise.all([
      readList<Task>(taskKey(month)),
      readList<Journal>(journalKey(month)),
    ])
    return json(200, { status: "success", month, tasks, journals }, req)
  }

  if (method === "POST") {
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      return badRequest("请求体不是合法 JSON", req)
    }
    const type = String(body.type || "")

    if (type === "task") {
      const date = String(body.date || "")
      if (!isValidDate(date)) return badRequest("date 需为有效的 YYYY-MM-DD", req)
      const month = monthOf(date)
      const list = await readList<Task>(taskKey(month))

      if (body.id) {
        // 更新
        const id = String(body.id)
        const idx = list.findIndex(t => t.id === id)
        if (idx < 0) return badRequest("任务不存在", req)
        if (typeof body.done === "boolean") list[idx].done = body.done
        if (typeof body.title === "string") {
          const title = cleanText(body.title, MAX_TITLE)
          if (!title) return badRequest("title 不能为空", req)
          list[idx].title = title
        }
        await writeList(taskKey(month), list)
        return json(200, { status: "success", task: list[idx] }, req)
      }

      const title = cleanText(body.title, MAX_TITLE)
      if (!title) return badRequest("title 不能为空", req)
      const task: Task = { id: randomUUID(), date, title, done: false, createdAt: Date.now() }
      list.push(task)
      list.sort((a, b) => a.createdAt - b.createdAt)
      await writeList(taskKey(month), list)
      return json(200, { status: "success", task }, req)
    }

    if (type === "journal") {
      const date = String(body.date || "")
      if (!isValidDate(date)) return badRequest("date 需为有效的 YYYY-MM-DD", req)
      const content = cleanText(body.content, MAX_JOURNAL)
      const month = monthOf(date)
      const list = await readList<Journal>(journalKey(month))
      const idx = list.findIndex(j => j.date === date)
      const entry: Journal = { date, content, updatedAt: Date.now() }
      if (idx >= 0) {
        if (!content) list.splice(idx, 1)
        else list[idx] = entry
      } else if (content) {
        list.push(entry)
      }
      list.sort((a, b) => a.date.localeCompare(b.date))
      await writeList(journalKey(month), list)
      return json(200, { status: "success", journal: content ? entry : null }, req)
    }

    return badRequest("type 需为 task 或 journal", req)
  }

  if (method === "DELETE") {
    const kind = params.get("type")
    const date = params.get("date") || ""
    const id = params.get("id") || ""
    if (kind === "journal") {
      if (!isValidDate(date)) return badRequest("date 需为有效的 YYYY-MM-DD", req)
      const month = monthOf(date)
      const list = await readList<Journal>(journalKey(month))
      const next = list.filter(j => j.date !== date)
      await writeList(journalKey(month), next)
      return json(200, { status: "success", deleted: list.length - next.length }, req)
    }

    if (!isValidDate(date) || !id) return badRequest("date 与 id 必填", req)
    const month = monthOf(date)
    const list = await readList<Task>(taskKey(month))
    const next = list.filter(t => t.id !== id)
    await writeList(taskKey(month), next)
    return json(200, { status: "success", deleted: list.length - next.length }, req)
  }

  return badRequest("Method Not Allowed", req)
}
