import { sourceGetters, metadata } from "./sources"
import { withTimeout } from "./fetch"
import { readNewsCache, writeNewsCache } from "./blob"
import type { NewsCache, SourceResult } from "./types"

export const CACHE_TTL = Number(process.env.NEWS_CACHE_TTL || 15 * 60 * 1000)
export const SCRAPE_BUDGET_MS = Number(process.env.SCRAPE_BUDGET_MS || 8000)
export const NEWS_ITEM_LIMIT = Number(process.env.NEWS_ITEM_LIMIT || 50)

export { readNewsCache, writeNewsCache }

export interface ScrapeResult {
  cache: NewsCache
  failed: string[]
  skipped: string[]
}

/**
 * 并行抓取全部（或指定）资讯源，单个源超时即跳过。
 * 预算必须小于 Netlify 函数 10s 超时。
 */
export async function scrapeSources(options: { ids?: string[]; budgetMs?: number } = {}): Promise<ScrapeResult> {
  const budget = options.budgetMs ?? SCRAPE_BUDGET_MS
  const targets = options.ids?.length ? options.ids : Object.keys(sourceGetters)

  const sources: Record<string, SourceResult> = {}
  const failed: string[] = []
  const skipped: string[] = []

  await Promise.allSettled(targets.map(async id => {
    const getter = sourceGetters[id]
    const meta = metadata[id]
    if (!getter || !meta) {
      skipped.push(id)
      return
    }
    try {
      const items = await withTimeout(getter(), budget)
      sources[id] = {
        id,
        name: meta.name,
        column: meta.column,
        category: meta.category,
        home: meta.home,
        title: meta.title,
        updatedTime: Date.now(),
        items: items.slice(0, NEWS_ITEM_LIMIT),
      }
    } catch {
      failed.push(id)
    }
  }))

  const cache: NewsCache = { updatedAt: Date.now(), sources }
  await writeNewsCache(cache)
  return { cache, failed, skipped }
}

/**
 * 读取缓存；若已过期则就地刷新（受预算限制），供 news.ts 使用
 */
export async function getNews(options: { refresh?: boolean; budgetMs?: number } = {}): Promise<{
  cache: NewsCache | null
  refreshed: boolean
  failed: string[]
}> {
  const existing = await readNewsCache()
  const now = Date.now()
  const stale = !existing || now - existing.updatedAt > CACHE_TTL

  if (options.refresh || stale) {
    const { cache, failed } = await scrapeSources({ budgetMs: options.budgetMs })
    return { cache, refreshed: true, failed }
  }

  return { cache: existing, refreshed: false, failed: [] }
}
