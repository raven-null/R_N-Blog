import { getBlobStore } from "./blob"
import { resolveModelApiUrl, resolveTemperature } from "./models"

export interface LlmConfig {
  apiUrl: string
  apiKey: string
  model: string
  systemPrompt: string
  maxTokens: number
  temperature: number
}

export const DEFAULT_WRITING_PROMPT =
  "你是一名资深的个人博客写作助手。你的写作风格：中文流畅、结构清晰、善用小标题与列表、技术类内容会给出可运行的示例代码。请严格按用户要求输出 Markdown 格式，不要输出与正文无关的客套话。涉及事实时如实说明，不确定的内容标注\"（待核实）\"，不编造数据。"

/** 读取博客设置，取写作 AI 与聊天 AI 配置（与 ai.ts 保持一致） */
export async function readAiConfigs(): Promise<{ writingAi: any; chatAi: any }> {
  const store = getBlobStore("blog-settings", "strong")
  const raw = await store.get("site", { type: "text" })
  const data = raw ? JSON.parse(raw) : {}
  return {
    writingAi: data.writingAi || {},
    chatAi: data.ai || {},
  }
}

/** 解析实际使用的 LLM 配置：写作 AI 优先，缺失字段回退聊天 AI；接口地址优先从模型库解析 */
export async function resolveLlmConfig(): Promise<LlmConfig> {
  const { writingAi, chatAi } = await readAiConfigs()
  // 写作 AI 若完全未配置（无 Key / 无接口地址 / 无 厂商+模型）则整体回退聊天配置
  const wrKey = String(writingAi.apiKey || "").trim()
  const wrModel = String(writingAi.model || "").trim()
  const wrUrl = String(writingAi.apiUrl || "").trim()
  const wrProvider = String(writingAi.provider || "").trim()
  const writingConfigured = !!(wrKey || wrUrl || (wrProvider && wrModel))
  const src = writingConfigured ? writingAi : chatAi
  const provider = String(src.provider || "").trim()
  const model = String(src.model || chatAi.model || "").trim()
  const apiKey = String(src.apiKey || chatAi.apiKey || "").trim()
  const storedUrl = String(src.apiUrl || chatAi.apiUrl || "").trim()
  const apiUrl = resolveModelApiUrl(provider, model, storedUrl)
  const maxTokens = Number(writingAi.maxTokens) > 0 ? Number(writingAi.maxTokens) : Number(chatAi.maxTokens) > 0 ? Number(chatAi.maxTokens) : 4096
  const computedTemp = typeof writingAi.temperature === "number" && !Number.isNaN(writingAi.temperature)
    ? writingAi.temperature
    : typeof chatAi.temperature === "number" && !Number.isNaN(chatAi.temperature) ? chatAi.temperature : 0.7
  const temperature = resolveTemperature(provider, model, computedTemp)
  return {
    apiUrl,
    apiKey,
    model,
    systemPrompt: String(writingAi.systemPrompt || chatAi.systemPrompt || "").trim(),
    maxTokens: Math.min(16384, Math.max(maxTokens, 1024)),
    temperature,
  }
}

/** 解析前台聊天 AI 配置（AI 助手，不叠加写作 AI） */
export async function resolveChatConfig(): Promise<LlmConfig> {
  const { chatAi } = await readAiConfigs()
  const provider = String(chatAi.provider || "").trim()
  const model = String(chatAi.model || "").trim()
  const apiKey = String(chatAi.apiKey || "").trim()
  const storedUrl = String(chatAi.apiUrl || "").trim()
  const apiUrl = resolveModelApiUrl(provider, model, storedUrl)
  const maxTokens = Number(chatAi.maxTokens) > 0 ? Number(chatAi.maxTokens) : 2048
  const computedTemp = typeof chatAi.temperature === "number" && !Number.isNaN(chatAi.temperature) ? chatAi.temperature : 0.7
  const temperature = resolveTemperature(provider, model, computedTemp)
  return {
    apiUrl,
    apiKey,
    model,
    systemPrompt: String(chatAi.systemPrompt || "").trim(),
    maxTokens: Math.min(16384, Math.max(maxTokens, 256)),
    temperature,
  }
}

/** 拼接写作系统提示词（基础人设 + 关键词约束），baseSystem 可覆盖（Agent 独立人设用） */
export function buildWritingSystemPrompt(config: LlmConfig, keywords?: string, baseSystem?: string): string {
  let system = String(baseSystem || config.systemPrompt || DEFAULT_WRITING_PROMPT).trim()
  system += "\n\n请严格遵循用户要求的主题、字数、风格与格式，内容要充实完整，不要提前草草结束。"
  const kw = String(keywords || "").split(",").map((s: string) => s.trim()).filter(Boolean)
  if (kw.length) {
    system += `\n\n全文请自然融入以下关键词：${kw.join("、")}，贴合博客选题方向。`
  }
  return system
}

export interface ChatResult {
  ok: boolean
  text: string
  finishReason: string
  error?: string
}

/** 非流式调用 OpenAI 兼容接口，返回文本与结束原因 */
export async function chatComplete(
  config: LlmConfig,
  messages: { role: string; content: string }[],
  opts?: { maxTokens?: number; temperature?: number },
): Promise<ChatResult> {
  const maxTokens = Math.min(16384, Math.max(opts && Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : config.maxTokens, 256))
  const temperature = opts && typeof opts.temperature === "number" ? opts.temperature : config.temperature
  try {
    const res = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
    })
    if (!res.ok) {
      const err = await res.text().catch(() => "")
      return { ok: false, text: "", finishReason: "error", error: `HTTP ${res.status}: ${err.slice(0, 300)}` }
    }
    const data = await res.json()
    const choice = data?.choices?.[0]
    const text = String(choice?.message?.content || "").trim()
    return { ok: true, text, finishReason: String(choice?.finish_reason || "stop") }
  } catch (err: any) {
    return { ok: false, text: "", finishReason: "error", error: err?.message || String(err) }
  }
}
