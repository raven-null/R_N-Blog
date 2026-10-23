/**
 * 内置模型库：厂商 → 模型，每个模型带官方 OpenAI 兼容接口地址。
 * 前端「AI 设置」用它渲染下拉，后端用它解析接口地址（免手填）。
 * 未命中的（自定义 / 旧配置）回退到存储的手填 apiUrl。
 */
export interface CatalogModel {
  id: string
  label: string
  apiUrl: string
  tags?: string[]
  /** 该模型仅允许的 temperature（如 Kimi K2 只接受 1） */
  temperature?: number
}

export interface CatalogProvider {
  id: string
  name: string
  models: CatalogModel[]
}

export const MODEL_CATALOG: CatalogProvider[] = [
  {
    id: "zhipu",
    name: "智谱 GLM",
    models: [
      { id: "glm-4-flash", label: "GLM-4-Flash", apiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", tags: ["免费", "快速"] },
      { id: "glm-4-air", label: "GLM-4-Air", apiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", tags: ["性价比"] },
      { id: "glm-4-plus", label: "GLM-4-Plus", apiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", tags: ["更强"] },
      { id: "glm-4-long", label: "GLM-4-Long", apiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", tags: ["长文 1M"] },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    models: [
      { id: "deepseek-chat", label: "DeepSeek-V3（对话）", apiUrl: "https://api.deepseek.com/chat/completions", tags: ["性价比"] },
      { id: "deepseek-reasoner", label: "DeepSeek-R1（推理）", apiUrl: "https://api.deepseek.com/chat/completions", tags: ["推理"] },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini", apiUrl: "https://api.openai.com/v1/chat/completions", tags: ["快速"] },
      { id: "gpt-4o", label: "GPT-4o", apiUrl: "https://api.openai.com/v1/chat/completions", tags: ["更强"] },
    ],
  },
  {
    id: "moonshot",
    name: "Kimi（Moonshot）",
    models: [
      { id: "kimi-k2.6", label: "Kimi K2.6", apiUrl: "https://api.moonshot.cn/v1/chat/completions", tags: ["新一代"], temperature: 1 },
      { id: "kimi-k3", label: "Kimi K3", apiUrl: "https://api.moonshot.cn/v1/chat/completions", tags: ["最新"], temperature: 1 },
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", apiUrl: "https://api.moonshot.cn/v1/chat/completions", tags: ["代码"], temperature: 1 },
      { id: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code（高速）", apiUrl: "https://api.moonshot.cn/v1/chat/completions", tags: ["代码", "快速"], temperature: 1 },
      { id: "moonshot-v1-8k", label: "Kimi（8K 上下文）", apiUrl: "https://api.moonshot.cn/v1/chat/completions", tags: ["经典"] },
      { id: "moonshot-v1-32k", label: "Kimi（32K 上下文）", apiUrl: "https://api.moonshot.cn/v1/chat/completions", tags: ["经典"] },
      { id: "moonshot-v1-128k", label: "Kimi（128K 上下文）", apiUrl: "https://api.moonshot.cn/v1/chat/completions", tags: ["经典"] },
    ],
  },
  {
    id: "qwen",
    name: "通义千问",
    models: [
      { id: "qwen-turbo", label: "Qwen-Turbo", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", tags: ["快速"] },
      { id: "qwen-plus", label: "Qwen-Plus", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", tags: ["性价比"] },
      { id: "qwen-max", label: "Qwen-Max", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", tags: ["更强"] },
    ],
  },
  {
    // 小米 MiMo：官方平台 platform.xiaomimimo.com，标准 OpenAI 兼容接口在 api.xiaomimimo.com/v1。
    // 注意：`tp-` 开头的 Token Plan 密钥**不认**这个域名（会返回 401 invalid_key），
    // 必须用下面的「小米 MiMo（Token Plan）」那项（token-plan-cn.xiaomimimo.com）。
    // 另外 v2.6 系列里只有 mimo-v2.6-pro-ultraspeed 强制 temperature=1（传了也会被覆盖），
    // pro / flash 可以正常调温；以后加 ultraspeed 记得带 temperature: 1。
    id: "mimo",
    name: "小米 MiMo",
    models: [
      { id: "mimo-v2.6-pro", label: "MiMo-V2.6-Pro", apiUrl: "https://api.xiaomimimo.com/v1/chat/completions", tags: ["更强"] },
      { id: "mimo-v2.6-flash", label: "MiMo-V2.6-Flash", apiUrl: "https://api.xiaomimimo.com/v1/chat/completions", tags: ["快速", "性价比"] },
    ],
  },
  {
    // 小米 MiMo 的 Token Plan：密钥形如 tp-xxxx，只能走 token-plan 的区域域名
    // （cn / sgp / ams 三个区域，实测同一把 key 只在它绑定的区域有效；这里给的是 cn）。
    // 用错了域名的典型表现就是 401 invalid_key —— 排查时先看密钥前缀。
    id: "mimo-tp",
    name: "小米 MiMo（Token Plan）",
    models: [
      { id: "mimo-v2.6-pro", label: "MiMo-V2.6-Pro", apiUrl: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions", tags: ["Token Plan"] },
      { id: "mimo-v2.6-flash", label: "MiMo-V2.6-Flash", apiUrl: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions", tags: ["Token Plan", "快速"] },
    ],
  },
]

export function findCatalogModel(provider: string, model: string): CatalogModel | null {
  const p = MODEL_CATALOG.find(x => x.id === provider)
  if (!p) return null
  return p.models.find(m => m.id === model) || null
}

/** 解析实际接口地址：目录命中优先，否则回退手填地址 */
export function resolveModelApiUrl(provider: string, model: string, fallbackUrl: string): string {
  const found = findCatalogModel(provider, model)
  return (found && found.apiUrl) || String(fallbackUrl || "").trim()
}

/** 若目录中该模型限定了 temperature（如 K2 只接受 1），返回限定值，否则回退默认 */
export function resolveTemperature(provider: string, model: string, fallback: number): number {
  const found = findCatalogModel(provider, model)
  return found && typeof found.temperature === "number" ? found.temperature : fallback
}
