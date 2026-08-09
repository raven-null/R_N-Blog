const DEFAULT_ORIGIN = "https://ravennull.work"

/**
 * 计算允许跨域访问的来源。
 * ALLOWED_ORIGIN 环境变量可配置多个（逗号分隔）；本地开发自动放行 localhost。
 */
export function allowedOrigins(): string[] {
  const env = (process.env.ALLOWED_ORIGIN || DEFAULT_ORIGIN)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
  if (process.env.NODE_ENV !== "production") {
    env.push("http://localhost:5173", "http://localhost:8080", "http://127.0.0.1:5173", "http://127.0.0.1:8080")
  }
  return env
}

export function corsHeaders(req?: Request): Record<string, string> {
  const origins = allowedOrigins()
  const reqOrigin = req?.headers?.get?.("origin") ?? undefined
  const allow = origins.includes("*") ? "*" : reqOrigin && origins.includes(reqOrigin) ? reqOrigin : origins[0]
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  }
}

/** v2 函数（Web Request/Response）统一 JSON 响应 */
export function json(status: number, body: any, req?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
    },
  })
}

export function badRequest(message: string, req?: Request): Response {
  return json(400, { status: "error", message }, req)
}

export function noContent(req?: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) })
}
