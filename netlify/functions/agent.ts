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
  detectTriggerType,
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
    const taskId = url.searchParams.get("task")
    if (taskId) {
      const task = await getTask(taskId)
      if (!task) return json(404, { status: "error", message: "任务不存在" }, req)
      // 管理员可查任意任务；公开轮询需任务自带 pollKey 匹配
      const pollKey = url.searchParams.get("key") || ""
      const isAdmin = await requireAdmin()
      if (!isAdmin && !(task.pollKey && pollKey === task.pollKey)) {
        return json(401, { status: "error", message: "未授权" }, req)
      }
      return json(200, { status: "success", data: task }, req)
    }
    if (!(await requireAdmin())) return json(401, { status: "error", message: "未授权" }, req)
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
    const source = body.source === "admin" ? "admin" : body.source === "comment" ? "comment" : body.source === "chat" ? "chat" : ""
    if (!source) return badRequest("source 必填（admin / comment / chat）", req)
    const settings = await getAgentSettings()
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || ""

    // source=chat：AI 对话输入框内发起（@ai 问答 / @管理员 生成文章）
    if (source === "chat") {
      const type = body.type === "qa" ? "qa" : "article"
      const instruction = String(body.instruction || "").trim()
      if (!instruction) return badRequest("instruction 必填", req)
      if (type === "article") {
        const adminKey = String(body.adminKey || "").trim()
        if (adminKey !== password) return json(401, { status: "error", message: "后台密钥不正确" }, req)
        if (instruction.length > settings.maxInstructionLength) {
          return badRequest(`指令过长（上限 ${settings.maxInstructionLength} 字）`, req)
        }
        const task = newTask({
          source: "chat",
          type: "article",
          instruction,
          requestedStatus: body.status === "draft" ? "draft" : "published",
          ip,
        })
        await saveTask(task)
        await kickAgentRun(task.id, runKey, url)
        return json(200, { status: "success", data: task }, req)
      }
      // qa：需文章上下文
      const postId = String(body.articleId || body.postId || "").trim()
      if (!postId) return badRequest("articleId 必填（请在文章页使用 @ai 询问文章问题）", req)
      const task = newTask({
        source: "chat",
        type: "qa",
        instruction,
        postId,
        ip,
      })
      await saveTask(task)
      await kickAgentRun(task.id, runKey, url)
      return json(200, { status: "success", data: task }, req)
    }

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
    const postId = String(body.postId || "")
    const commentId = String(body.commentId || "")
    if (!postId || !commentId) return badRequest("postId / commentId 必填", req)

    // 校验评论真实存在
    const comment = await findComment(postId, commentId)
    if (!comment) return badRequest("评论不存在", req)
    const commentContent = String(comment.content || "")

    // 未开启时回评说明，避免「没反应」
    if (!settings.enabled) {
      await writeAgentComment(postId, `🤖 AI Agent 未开启，管理员可在「博客设置 → AI Agent」开启后重试`, settings.commentName)
      return json(200, { status: "ignored", message: "AI Agent 未开启" }, req)
    }

    // 判定触发类型：@管理员 生成文章（需后台密钥） / @ai 文章问答
    const triggerType = detectTriggerType(commentContent, settings)
    if (triggerType === "") {
      return json(200, { status: "ignored", message: "评论未包含触发词" }, req)
    }

    if (triggerType === "article") {
      // 生成文章需要正确的后台登录密钥
      const adminKey = String(body.adminKey || "").trim()
      if (adminKey !== password) {
        await writeAgentComment(postId, `🔒 生成文章需要正确的后台登录密钥，本次未生成`, settings.commentName)
        return json(401, { status: "error", message: "后台密钥不正确" }, req)
      }
      const instruction = stripTrigger(commentContent, settings.articleTriggers) || commentContent
      if (instruction.length > settings.maxInstructionLength) {
        await writeAgentComment(postId, `🤖 指令过长（上限 ${settings.maxInstructionLength} 字）`, settings.commentName)
        return badRequest(`指令过长（上限 ${settings.maxInstructionLength} 字）`, req)
      }
      const task = newTask({
        source: "comment",
        type: "article",
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

    // triggerType === "qa"：AI 助手回答文章相关问题（无需密钥）
    const question = stripTrigger(commentContent, settings.qaTriggers) || commentContent
    const task = newTask({
      source: "comment",
      type: "qa",
      instruction: question,
      postId,
      commentId,
      ip,
    })
    const ackId = await writeAgentComment(postId, `🤖 正在回答你的问题…`, settings.commentName)
    if (ackId) task.ackCommentId = ackId
    await saveTask(task)
    await kickAgentRun(task.id, runKey, url)
    return json(200, { status: "success", message: "已受理", data: task }, req)
  }

  return badRequest("Method Not Allowed", req)
}

/** 触发后台函数异步执行任务（后台函数收到请求后立即返回 202，任务在后台继续） */
async function kickAgentRun(taskId: string, runKey: string, baseUrl: URL): Promise<void> {
  try {
    const target = new URL("/api/agent-run?task=" + encodeURIComponent(taskId), baseUrl.origin).href
    // 最多等 3 秒（后台函数应秒回 202），避免阻塞主响应
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    await fetch(target, {
      method: "POST",
      headers: { "x-agent-run-key": runKey },
      signal: controller.signal,
    }).catch(() => {})
    clearTimeout(timer)
  } catch (e) {
    // 触发失败不阻塞主流程：任务保持 pending，可在后台面板手动重试
  }
}

export const config = { path: "/api/agent" }
