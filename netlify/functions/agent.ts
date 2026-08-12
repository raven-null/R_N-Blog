import { json, badRequest, noContent } from "./_shared/cors"
import {
  getAdminPassword,
  agentRunKey,
  getAgentSettings,
  newTask,
  saveTask,
  getTask,
  listTasks,
  deleteTask,
  checkAgentRateLimit,
  matchTrigger,
  stripTrigger,
  findComment,
  writeAgentComment,
} from "./_shared/agent"

/**
 * /api/agent  (Netlify Functions v2)
 *
 * AI Agent 自动写作与发布：
 *  - source=admin   后台指令：需 X-Admin-Key，按指令生成并发布（或存草稿）
 *  - source=comment 评论区 @管理员 触发：校验评论存在 + Agent 开关 + 限流，受理后写评论
 *  - 任务创建后立刻通过后台函数 /api/agent-run 异步执行，长文自动续写
 *
 * POST { source, instruction, status?, postId?, commentId? }
 * GET  ?task=id   任务状态（需 X-Admin-Key）
 * GET  ?list=1    任务列表（需 X-Admin-Key）
 * POST { action:'retry', taskId }  重试任务（需 X-Admin-Key）
 * POST { action:'delete', taskId } 删除任务（需 X-Admin-Key）
 */
export default async (req: Request) => {
  if (req.method === "OPTIONS") return noContent(req)

  const url = new URL(req.url)
  const method = req.method
  const password = await getAdminPassword()
  const runKey = agentRunKey(password)

  // 统一鉴权（后台功能均需管理员）
  async function requireAdmin(): Promise<boolean> {
    const provided = req.headers.get("x-admin-key") ?? ""
    return provided === password
  }

  const body: any = method === "POST" ? await req.json().catch(() => ({})) : {}

  // ===== 后台：任务查询 / 重试 / 删除 =====

  if (method === "GET") {
    if (!(await requireAdmin())) return json(401, { status: "error", message: "未授权" }, req)
    const taskId = url.searchParams.get("task")
    if (taskId) {
      const task = await getTask(taskId)
      if (!task) return json(404, { status: "error", message: "任务不存在" }, req)
      return json(200, { status: "success", data: task }, req)
    }
    const tasks = await listTasks()
    return json(200, { status: "success", data: tasks }, req)
  }

  if (method === "POST") {
    // 删除 / 重试
    if (body.action === "delete") {
      if (!(await requireAdmin())) return json(401, { status: "error", message: "未授权" }, req)
      const ok = await deleteTask(String(body.taskId || ""))
      return ok ? json(200, { status: "success", message: "已删除" }, req) : badRequest("任务不存在", req)
    }
    if (body.action === "retry") {
      if (!(await requireAdmin())) return json(401, { status: "error", message: "未授权" }, req)
      const task = await getTask(String(body.taskId || ""))
      if (!task) return badRequest("任务不存在", req)
      if (task.status === "running" && Date.now() - task.startedAt < 15 * 60 * 1000) {
        return badRequest("任务正在执行中，请稍候", req)
      }
      task.status = "pending"
      task.progress = "等待执行"
      task.error = ""
      await saveTask(task)
      await kickAgentRun(task.id, runKey, url)
      return json(200, { status: "success", message: "已重新提交", data: task }, req)
    }

    // ===== 创建任务 =====
    const source = body.source === "admin" ? "admin" : body.source === "comment" ? "comment" : ""
    if (!source) return badRequest("source 必填（admin / comment）", req)
    const settings = await getAgentSettings()
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || ""

    if (source === "admin") {
      if (!(await requireAdmin())) return json(401, { status: "error", message: "未授权" }, req)
      const instruction = String(body.instruction || "").trim()
      if (!instruction) return badRequest("instruction 必填", req)
      if (instruction.length > settings.maxInstructionLength) {
        return badRequest(`指令过长（上限 ${settings.maxInstructionLength} 字）`, req)
      }
      const task = newTask({
        source: "admin",
        instruction,
        requestedStatus: body.status === "draft" ? "draft" : "published",
        ip,
      })
      await saveTask(task)
      await kickAgentRun(task.id, runKey, url)
      return json(200, { status: "success", message: "任务已创建", data: task }, req)
    }

    // source === comment
    if (!settings.enabled) {
      return json(200, { status: "ignored", message: "AI Agent 未开启" }, req)
    }
    const postId = String(body.postId || "")
    const commentId = String(body.commentId || "")
    if (!postId || !commentId) return badRequest("postId / commentId 必填", req)

    // 校验评论真实存在且命中触发词
    const comment = await findComment(postId, commentId)
    if (!comment) return badRequest("评论不存在", req)
    const commentContent = String(comment.content || "")
    if (!matchTrigger(commentContent, settings.triggerKeywords)) {
      return json(200, { status: "ignored", message: "评论未包含触发词" }, req)
    }

    // 限流
    const limitMsg = await checkAgentRateLimit(settings, ip)
    if (limitMsg) {
      await writeAgentComment(postId, `🤖 ${limitMsg}`, settings.commentName)
      return json(429, { status: "error", message: limitMsg }, req)
    }

    const instruction = stripTrigger(commentContent, settings.triggerKeywords) || commentContent
    const task = newTask({
      source: "comment",
      instruction,
      postId,
      commentId,
      ip,
    })
    await saveTask(task)
    await writeAgentComment(postId, `🤖 已收到任务，正在为你生成文章…`, settings.commentName)
    await kickAgentRun(task.id, runKey, url)
    return json(200, { status: "success", message: "已受理", data: task }, req)
  }

  return badRequest("Method Not Allowed", req)
}

/** 触发后台函数异步执行任务（后台函数收到请求后立即返回 202，任务在后台继续） */
async function kickAgentRun(taskId: string, runKey: string, baseUrl: URL): Promise<void> {
  try {
    const target = new URL("/api/agent-run?task=" + encodeURIComponent(taskId), baseUrl.origin).href
    await fetch(target, {
      method: "POST",
      headers: { "x-agent-run-key": runKey },
    })
  } catch (e) {
    // 触发失败不阻塞主流程：任务保持 pending，可在后台面板手动重试
  }
}

export const config = { path: "/api/agent" }
