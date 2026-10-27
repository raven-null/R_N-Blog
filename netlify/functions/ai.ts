/**
 * 前台 AI 助手代理（Netlify Functions v2）
 *
 * 路由：export const config = { path: "/api/ai" }
 *
 * 为什么需要这个函数：
 *   1. 浏览器直连 open.bigmodel.cn 会被 CORS 拦死 ——
 *      对方不返 Access-Control-Allow-Origin，预检直接失败（线上就是这样挂的）
 *   2. API Key 放在前端 JS 里等于公开，任何人看源码就能盗用额度
 * 所以改成服务端转发：前端 POST /api/ai → 本函数带上 Key 调上游 → SSE 原样透传。
 *
 * 请求体：{ messages: [{role, content}], model? }
 *   - system 提示词由前端传（每个助手人设不同），服务端只做长度与角色清洗
 *   - model 只接受后台设置里的那个，防止有人拿这个接口去跑贵的模型
 *
 * 密钥来源优先级：环境变量 ZHIPU_API_KEY / BIGMODEL_API_KEY → 后台「博客设置 → AI 助手」
 * 环境变量优先，是为了让线上不依赖 blob 里存的那把（那也是可见的）。
 */
import { json, badRequest, noContent, corsHeaders } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"
import { resolveModelApiUrl, resolveTemperature } from "./_shared/models"

const SETTINGS_STORE = "blog-settings"
const SETTINGS_KEY = "site"

const DEFAULT_API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
const DEFAULT_MODEL = "glm-4-flash"
const DEFAULT_MAX_TOKENS = 2048
const DEFAULT_TEMPERATURE = 0.7

const MAX_MESSAGES = 24 // 上下文轮数上限（前端本来就裁到 10 轮）
const MAX_MESSAGE_CHARS = 8000 // 单条上限
const MAX_TOTAL_CHARS = 80000 // 整体上限，防超大请求打穿额度
const UPSTREAM_TIMEOUT_MS = 60000

interface AiSettings {
  enabled: boolean
  provider: string
  apiUrl: string
  apiKey: string
  model: string
  maxTokens: number
  temperature: number
}

async function loadAiSettings(): Promise<AiSettings> {
  let stored: any = {}
  try {
    const store = getBlobStore(SETTINGS_STORE, "strong")
    const raw = await store.get(SETTINGS_KEY, { type: "text" })
    if (raw) {
      const data = JSON.parse(raw)
      stored = (data && data.ai) || {}
    }
  } catch {
    /* 读不到就用默认值 */
  }

  const envKey = process.env.ZHIPU_API_KEY || process.env.BIGMODEL_API_KEY || ""
  const key = envKey || (typeof stored.apiKey === "string" ? stored.apiKey : "")
  const num = (v: any, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)

  const provider = typeof stored.provider === "string" && stored.provider ? stored.provider : "zhipu"
  const model = typeof stored.model === "string" && stored.model ? stored.model : DEFAULT_MODEL
  const customUrl = typeof stored.apiUrl === "string" ? stored.apiUrl : ""
  // 接口地址必须跟「provider + model」配套解析：
  // 后台可能只选了模型没填地址（比如 mimo-tp 的 MiMo），
  // 直接回退到智谱默认地址就会拿小米的 key 去打智谱，必然 401。
  const apiUrl = resolveModelApiUrl(provider, model, customUrl) || customUrl || DEFAULT_API_URL
  const temperature = resolveTemperature(
    provider,
    model,
    Number.isFinite(Number(stored.temperature)) ? Number(stored.temperature) : DEFAULT_TEMPERATURE,
  )

  return {
    enabled: stored.enabled !== false,
    provider,
    apiUrl,
    apiKey: key,
    model,
    maxTokens: num(stored.maxTokens, DEFAULT_MAX_TOKENS),
    temperature,
  }
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") return noContent(req)
  if (req.method !== "POST") return badRequest("不支持的请求方法", req)

  let body: any = {}
  try {
    body = await req.json()
  } catch {
    return badRequest("请求体不是合法 JSON", req)
  }

  const cfg = await loadAiSettings()
  if (!cfg.enabled) {
    return json(400, { status: "error", message: "AI 助手已在后台关闭（博客设置 → AI 助手）" }, req)
  }
  if (!cfg.apiKey) {
    return json(400, { status: "error", message: "还没配置 AI 密钥（博客设置 → AI 助手，或环境变量 ZHIPU_API_KEY）" }, req)
  }

  // ---- 清洗消息：角色只留 system/user/assistant，超长直接拒 ----
  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  if (!rawMessages.length) return badRequest("messages 不能为空", req)
  if (rawMessages.length > MAX_MESSAGES) return badRequest(`上下文过长（最多 ${MAX_MESSAGES} 条）`, req)

  const messages: { role: string; content: string }[] = rawMessages.map((m: any) => {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "system" ? "system" : "user"
    return { role, content: String(m?.content || "").slice(0, MAX_MESSAGE_CHARS) }
  })
  const totalChars = messages.reduce((n: number, m: { content: string }) => n + m.content.length, 0)
  if (totalChars > MAX_TOTAL_CHARS) return badRequest("内容过长，请精简后再问", req)
  if (!messages.some((m: { role: string; content: string }) => m.role !== "system" && m.content.trim())) {
    return badRequest("消息内容为空", req)
  }

  // ---- 模型只认后台配置的那个，避免这个公开接口被拿去跑贵模型 ----
  const askedModel = typeof body.model === "string" ? body.model.trim() : ""
  const model = askedModel && askedModel === cfg.model ? askedModel : cfg.model

  // ---- 转发上游 ----
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  let upstream: Response
  try {
    upstream = await fetch(cfg.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        stream: true,
      }),
      signal: controller.signal,
    })
  } catch (err: any) {
    clearTimeout(timer)
    const reason = err?.name === "AbortError" ? `上游超时（${UPSTREAM_TIMEOUT_MS / 1000}s）` : err?.message || String(err)
    return json(
      400,
      { status: "error", message: `连接 AI 接口失败：${reason}`, apiUrl: cfg.apiUrl, model: cfg.model },
      req,
    )
  }
  clearTimeout(timer)

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "")
    // 尽量从上游的 JSON 里抠出人话，抠不出就用原文
    let detail = text.slice(0, 300)
    try {
      const j = JSON.parse(text)
      const msg = (j && j.error && (j.error.message || j.error.code)) || (j && j.message)
      if (msg) detail = String(msg)
    } catch {
      /* 不是 JSON 就保留原文 */
    }
    // 状态码刻意用 4xx：Cloudflare 会把源站的 5xx 换成它自己的错误页，
    // 那样前端只能看到「502 Bad gateway」，完全看不到真正原因（这次排查就栽在这上面）。
    const mapped = upstream.status === 401 || upstream.status === 403 ? 401 : upstream.status === 429 ? 429 : 400
    return json(
      mapped,
      {
        status: "error",
        message: `上游接口返回 ${upstream.status}：${detail}`,
        upstreamStatus: upstream.status,
        apiUrl: cfg.apiUrl,
        model: cfg.model,
      },
      req,
    )
  }

  // 上游有时忽略 stream 参数直接返回整段 JSON，这里原样透传，前端按 content-type 处理
  const upstreamType = upstream.headers.get("content-type") || ""
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders(req),
      "Content-Type": upstreamType || "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no", // 让 Netlify / 反代别缓冲，保证边生成边到浏览器
    },
  })
}

export const config = { path: "/api/ai" }
