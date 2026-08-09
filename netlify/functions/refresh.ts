import { scrapeSources } from "./_shared/news-engine"
import { json } from "./_shared/cors"

/**
 * 定时 + 手动刷新资讯缓存 (Netlify Functions v2)
 * - 默认每小时自动执行（config.schedule），Netlify 会带 x-netlify-scheduled 头调用
 * - 手动触发：GET /api/refresh?key=你的ADMIN_KEY
 */
export default async (req: Request) => {
  const params = new URL(req.url).searchParams

  const isScheduled = req.headers.get("x-netlify-scheduled") === "1"
  const adminKey = process.env.ADMIN_KEY

  if (adminKey && !isScheduled && params.get("key") !== adminKey) {
    return json(403, { status: "error", message: "无权限：请携带 ?key= 管理密钥" }, req)
  }

  const { cache, failed, skipped } = await scrapeSources({})
  return json(200, {
    status: "success",
    updatedAt: cache.updatedAt,
    sourceCount: Object.keys(cache.sources).length,
    failed,
    skipped,
  }, req)
}

export const config = {
  schedule: "@hourly",
}
