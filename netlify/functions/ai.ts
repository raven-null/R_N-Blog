import { json, noContent, badRequest } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"
import { resolveLlmConfig } from "./_shared/ai"

const DEFAULT_WRITING_PROMPT =
  "你是一名资深的个人博客写作助手。你的写作风格：中文流畅、结构清晰、善用小标题与列表、技术类内容会给出可运行的示例代码。请严格按用户要求输出 Markdown 格式，不要输出与正文无关的客套话。涉及事实时如实说明，不确定的内容标注\"（待核实）\"，不编造数据。"

// 读取后台密码（与 admin.ts 保持一致）
async function getAdminPassword(): Promise<string> {
  const envPwd = process.env.ADMIN_KEY
  if (envPwd) return envPwd
  try {
    const store = getBlobStore("blog-auth", "strong")
    const raw = await store.get("password", { type: "text" })
    if (raw) return raw
  } catch (e) {}
  return "1111"
}

async function checkAuth(req: Request): Promise<boolean> {
  const adminKey = await getAdminPassword()
  const provided = req.headers.get("x-admin-key") ?? ""
  return provided === adminKey
}

// 读取博客设置，取写作 AI 与聊天 AI 配置
async function readAiConfigs(): Promise<{ writingAi: any; chatAi: any }> {
  const store = getBlobStore("blog-settings", "strong")
  const raw = await store.get("site", { type: "text" })
  const data = raw ? JSON.parse(raw) : {}
  return {
    writingAi: data.writingAi || {},
    chatAi: data.ai || {},
  }
}

// 拼接系统提示词：写作人设 + 关键词约束 + 要求遵循
function buildSystemPrompt(writingAi: any, bodyKeywords?: string): string {
  let system = (writingAi.systemPrompt || DEFAULT_WRITING_PROMPT).trim()
  system += "\n\n请严格遵循用户的写作要求：主题、字数、风格、格式都要尽量满足。若用户要求生成 N 字的文章，正文应尽量达到该字数，内容要充实完整，不要提前草草结束。"
  const keywords = String(bodyKeywords || writingAi.keywords || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean)
  if (keywords.length) {
    system += `\n\n全文请自然融入以下关键词：${keywords.join("、")}，贴合博客选题方向。`
  }
  return system
}

// 按动作拼接用户消息
function buildUserMessage(action: string, b: any): string {
  const title = String(b.title || "").trim()
  const content = String(b.content || "").trim()
  const selection = String(b.selection || "").trim()
  const topic = String(b.topic || "").trim()
  const outline = String(b.outline || "").trim()
  const words = Number(b.words) > 0 ? Number(b.words) : 800
  const existingTitles = Array.isArray(b.existingTitles) ? b.existingTitles.slice(0, 30).join("、") : ""

  switch (action) {
    case "custom":
      {
        const prompt = String(b.prompt || "").trim()
        const ctx: string[] = []
        if (title) ctx.push(`当前文章标题：${title}`)
        if (content) ctx.push(`当前正文（供续写/修改参考）：\n${content.slice(0, 6000)}`)
        return ctx.length ? `${prompt}\n\n（下面是当前编辑中的文章上下文，供你参考）\n${ctx.join("\n\n")}` : prompt
      }
    case "title":
      return `请为以下主题生成 5-10 个吸引人的中文博客标题（每行一个，不要编号）：\n主题：${topic || title || "（未提供，请先给出主题）"}\n${existingTitles ? `已有文章标题（请避免重复）：${existingTitles}` : ""}`
    case "outline":
      return `请为《${title || "未命名"}》生成 Markdown 大纲（用 ## 与 ### 标题，并在每个标题下用 - 简述要点）：\n${content ? `背景内容：\n${content.slice(0, 3000)}` : ""}`
    case "draft":
      return `请根据以下信息写一篇中文博客初稿（Markdown 格式，含代码块时请给出可运行示例）：\n标题：${title || "未命名"}\n${topic ? `主题/关键词：${topic}\n` : ""}${outline ? `大纲：\n${outline}\n` : ""}${content ? `已有内容（可续写或重写）：\n${content.slice(0, 5000)}\n` : ""}`
    case "continue":
      return `请接着下面的正文继续写，保持语气、结构与 Markdown 风格一致：\n${content || "（正文为空，请先输入内容）"}`
    case "polish":
      return `请润色以下文字，使其更通顺、有文采、适合博客阅读（保持原意，直接输出润色结果）：\n${selection || content || "（未选中/无内容）"}`
    case "summarize":
      return `请为下面的文章写一段 100-150 字的中文摘要，并推荐 3-5 个中文标签（用、分隔，格式为：摘要内容\n\n标签：a、b、c）：\n${content || "（正文为空）"}`
    default:
      return content || "请提供需要处理的内容。"
  }
}

/**
 * /api/ai  (Netlify Functions v2)
 *
 * 后台写文章用的 AI 写作助手代理：鉴权 + 读取写作 AI 配置（缺失回退聊天 AI）+
 * 组装 Prompt + 流式转发上游大模型（SSE 透传）。
 *
 * POST { action, title, content, selection, topic, outline, words, keywords, existingTitles }
 */
export default async (req: Request) => {
  if (req.method === "OPTIONS") return noContent(req)
  if (req.method !== "POST") return badRequest("Method Not Allowed", req)

  if (!(await checkAuth(req))) {
    return json(401, { status: "error", message: "未授权" }, req)
  }

  let body: any = {}
  try {
    body = await req.json()
  } catch {
    return badRequest("请求体不是合法 JSON", req)
  }

  const { writingAi, chatAi } = await readAiConfigs()
  if (writingAi.enabled === false) {
    return badRequest("写作 AI 已在「博客设置 → 写作 AI」中关闭", req)
  }

  // 写作 AI 优先，缺失字段回退聊天 AI；接口地址优先从内置模型库解析
  const config = await resolveLlmConfig()
  const apiUrl = config.apiUrl
  const apiKey = config.apiKey
  const model = config.model
  if (!apiUrl || !apiKey || !model) {
    return badRequest("写作 AI 未配置：请在「博客设置 → AI 设置」选择模型并填写 API Key", req)
  }

  const action = String(body.action || "draft").trim()
  const system = buildSystemPrompt(writingAi, body.keywords)
  const user = buildUserMessage(action, body)
  // 输出预算：按请求字数适当放大，但不超过配置上限与 16384
  const words = Number(body.words) > 0 ? Number(body.words) : 800
  const baseMax = Number(writingAi.maxTokens) > 0 ? Number(writingAi.maxTokens) : 4096
  const maxTokens = Math.min(16384, Math.max(baseMax, words * 2 + 1024))
  const temperature = config.temperature

  try {
    const upstream = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature,
        stream: true,
      }),
    })

    if (!upstream.ok) {
      const err = await upstream.text().catch(() => "")
      return json(502, { status: "error", message: `AI 接口返回 ${upstream.status}：${err.slice(0, 300)}` }, req)
    }

    // SSE 透传
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (err: any) {
    return json(500, { status: "error", message: `调用 AI 失败：${err?.message || err}` }, req)
  }
}

export const config = { path: "/api/ai" }
