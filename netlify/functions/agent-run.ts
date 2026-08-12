import { json, badRequest, noContent } from "./_shared/cors"
import {
  getAdminPassword,
  agentRunKey,
  getTask,
  saveTask,
  getAgentSettings,
  writeAgentComment,
} from "./_shared/agent"
import { createArticle, autoExcerpt } from "./_shared/articles"
import { resolveLlmConfig, buildWritingSystemPrompt, chatComplete, readAiConfigs } from "./_shared/ai"

/**
 * /api/agent-run  (Netlify Background Function)
 *
 * AI Agent 后台执行器：读取任务 → 流式续写生成全文 → 结构化提取标题/标签/摘要 →
 * 创建文章（评论触发默认草稿）→ 回写任务状态与完成评论。
 *
 * 由 agent.ts 通过内部令牌触发；后台函数最长运行 15 分钟。
 */
export default async (req: Request) => {
  if (req.method === "OPTIONS") return noContent(req)

  const password = await getAdminPassword()
  const provided = req.headers.get("x-agent-run-key") ?? ""
  if (provided !== agentRunKey(password)) {
    return json(401, { status: "error", message: "未授权" }, req)
  }

  const taskId = new URL(req.url).searchParams.get("task") || ""
  if (!taskId) return badRequest("task 必填", req)

  const task = await getTask(taskId)
  if (!task) return json(404, { status: "error", message: "任务不存在" }, req)

  await runTask(task)

  return json(200, { status: "success" }, req)
}

async function runTask(task: any): Promise<void> {
  // 幂等保护：已完成 / 正在执行且未超时的任务不重复跑
  if (task.status === "done") return
  if (task.status === "running" && Date.now() - task.startedAt < 15 * 60 * 1000) return

  task.status = "running"
  task.startedAt = Date.now()
  task.progress = "正在生成正文…"
  task.error = ""
  await saveTask(task)

  try {
    const config = await resolveLlmConfig()
    if (!config.apiUrl || !config.apiKey || !config.model) {
      throw new Error("AI 未配置：请在「博客设置」填写写作 AI 或 AI 助手的 API 信息")
    }
    const settings = await getAgentSettings()

    task.progress = "正在撰写文章…"
    await saveTask(task)

    // 人设优先级：Agent 独立提示词（未共用时）→ 写作 AI 提示词 → 默认写作人设
    const { writingAi } = await readAiConfigs()
    const agentBasePrompt = (!settings.shareWritingPrompt && String(settings.systemPrompt || "").trim())
      ? String(settings.systemPrompt).trim()
      : ""
    const { title, tags, excerpt, content } = await generateFullArticle(
      task.instruction,
      config,
      agentBasePrompt,
      String(writingAi.keywords || ""),
    )

    task.progress = "正在保存发布…"
    await saveTask(task)

    const status: "published" | "draft" =
      task.source === "admin"
        ? task.requestedStatus === "draft" ? "draft" : "published"
        : settings.publishStrategy

    const { articleId, url } = await createArticle({ title, tags, excerpt, content, status })

    task.status = "done"
    task.finishedAt = Date.now()
    task.progress = "已完成"
    task.result = { articleId, title, url, status }
    await saveTask(task)

    // 评论触发：回写完成评论
    if (task.source === "comment" && task.postId) {
      const msg = status === "published"
        ? `✅ 已为你发布文章《${title}》：${url}`
        : `✅ 已为你生成文章《${title}》（当前为草稿，管理员审核后可见）：${url}`
      await writeAgentComment(task.postId, msg, settings.commentName)
    }
  } catch (err: any) {
    task.status = "failed"
    task.finishedAt = Date.now()
    task.progress = "生成失败"
    task.error = String(err?.message || err).slice(0, 300)
    await saveTask(task)
    if (task.source === "comment" && task.postId) {
      const settings = await getAgentSettings().catch(() => null)
      const name = settings?.commentName || "🤖 AI Agent"
      await writeAgentComment(task.postId, `🤖 很抱歉，任务执行失败：${task.error}`, name)
    }
  }
}

/** 分段续写生成完整文章 */
async function generateFullArticle(
  instruction: string,
  config: any,
  baseSystem = "",
  keywords = "",
): Promise<{ title: string; tags: string[]; excerpt: string; content: string }> {
  const system = buildWritingSystemPrompt(config, keywords, baseSystem) +
    "\n\n输出要求：直接输出 Markdown 格式的完整文章，标题用 #，小标题用 ## / ###，技术内容给出可运行示例；不要输出 JSON、注释或客套话。"

  let content = ""
  const MAX_CHUNKS = 12
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const user = i === 0
      ? `请根据要求写一篇完整的博客文章（Markdown 格式）：\n要求：${instruction}`
      : `请接着上文继续写，直接输出后续 Markdown 内容，保持标题层级、语气与风格一致，不要重复已有内容：\n${content.slice(-1500)}`
    const res = await chatComplete(config, [
      { role: "system", content: system },
      { role: "user", content: user },
    ])
    if (!res.ok) throw new Error(res.error || "生成失败")
    content += "\n\n" + res.text.trim()
    if (res.finishReason !== "length") break
  }

  let title = ""
  let tags: string[] = []
  let excerpt = ""
  try {
    const meta = await extractMeta(content, config)
    title = meta.title
    tags = meta.tags
    excerpt = meta.excerpt
  } catch (e) {
    // 元信息提取失败则用正文兜底
  }
  if (!title) {
    const m = content.match(/^#\s+(.+)$/m)
    title = m ? m[1].trim().slice(0, 50) : instruction.slice(0, 30)
  }
  if (!excerpt) excerpt = autoExcerpt(content) + "..."
  if (!tags.length) {
    const t = title.split(/[、,，\s，。]+/).map((s: string) => s.trim()).filter(s => s.length >= 2 && s.length <= 8)
    tags = t.slice(0, 3).length ? t.slice(0, 3) : ["AI 生成"]
  }
  return { title, tags, excerpt, content }
}

/** 结构化提取标题 / 标签 / 摘要 */
async function extractMeta(content: string, config: any): Promise<{ title: string; tags: string[]; excerpt: string }> {
  const res = await chatComplete(
    config,
    [
      {
        role: "system",
        content: "你是一个文章元信息提取器。只输出 JSON，不要输出任何其他内容或解释。",
      },
      {
        role: "user",
        content:
          "请根据下面的文章提取元信息，只输出 JSON，格式如下：\n" +
          '{"title":"简洁吸引人的标题","tags":["标签1","标签2","标签3"],"excerpt":"150字以内的中文摘要"}\n\n' +
          `文章内容：\n${content.slice(0, 6000)}`,
      },
    ],
    { maxTokens: 1024 },
  )
  if (!res.ok) throw new Error(res.error || "元信息提取失败")
  const json = extractJson(res.text)
  if (!json) throw new Error("元信息 JSON 解析失败")
  return {
    title: String(json.title || "").trim(),
    tags: Array.isArray(json.tags) ? json.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 6) : [],
    excerpt: String(json.excerpt || "").trim(),
  }
}

function extractJson(text: string): any | null {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export const config = { path: "/api/agent-run", background: true }
