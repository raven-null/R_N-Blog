import { getNews, NEWS_ITEM_LIMIT } from "./_shared/news-engine"
import { json, noContent } from "./_shared/cors"
import type { SourceResult } from "./_shared/types"

/**
 * GET /api/news  (Netlify Functions v2)
 *
 * 查询参数：
 *   sources=weibo,zhihu    只返回指定来源（可选）
 *   flat=1                 扁平数组模式，便于博客直接渲染（推荐）
 *   limit=50               每个来源最多条数
 *   refresh=1              强制刷新缓存
 *   column=tech,china      按栏目过滤（flat 模式下可用）
 */
export default async (req: Request) => {
  const method = req.method || "GET"

  if (method === "OPTIONS") return noContent(req)
  if (method !== "GET") {
    return json(405, { status: "error", message: "Method Not Allowed" }, req)
  }

  const params = new URL(req.url).searchParams
  const refresh = params.get("refresh") === "1"

  const { cache, refreshed, failed } = await getNews({ refresh })

  if (!cache) {
    return json(503, {
      status: "error",
      message: "资讯缓存暂不可用，请稍后再试",
      refreshed,
    }, req)
  }

  const limit = Math.min(Number(params.get("limit") || NEWS_ITEM_LIMIT), 100)

  const filterIds = params.get("sources")?.split(",").map(s => s.trim()).filter(Boolean)
  let sources: Record<string, SourceResult> = cache.sources
  if (filterIds?.length) {
    sources = Object.fromEntries(filterIds.map(id => [id, cache.sources[id]]).filter(([, v]) => v))
  }

  const columnFilter = params.get("column")?.split(",").map(s => s.trim()).filter(Boolean)

  if (params.get("flat") === "1") {
    const items = Object.values(sources).flatMap(s => {
      if (columnFilter?.length && !columnFilter.includes(s.column)) return []
      return s.items.slice(0, limit).map(it => ({
        id: `${s.id}:${it.id}`,
        title: it.title,
        url: it.url,
        mobileUrl: it.mobileUrl,
        source: s.name,
        sourceId: s.id,
        category: s.category,
        column: s.column,
        date: it.pubDate ?? it.extra?.date ?? s.updatedTime,
        summary: it.extra?.hover,
        info: it.extra?.info,
      }))
    })
    items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    return json(200, {
      status: "success",
      updatedAt: cache.updatedAt,
      refreshed,
      failed,
      count: items.length,
      items,
    }, req)
  }

  return json(200, {
    status: "success",
    updatedAt: cache.updatedAt,
    refreshed,
    failed,
    sources,
  }, req)
}
