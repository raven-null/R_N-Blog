import { myFetch } from "../fetch"
import { defineSource, defineRSSSource } from "../source"
import type { NewsItem } from "../types"

interface AIHotItem {
  id: string
  title: string
  url: string
  source: string
  publishedAt?: string | null
  summary?: string | null
}

interface AIHotResponse {
  items?: AIHotItem[]
}

const rss = defineRSSSource("https://aihot.virxact.com/feed/all.xml")

export default defineSource(async () => {
  try {
    const response = await myFetch<AIHotResponse>("https://aihot.virxact.com/api/public/items?mode=all&take=30", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" },
    })
    const items = (response.items || []).map(k => ({
      id: k.id,
      title: k.title,
      url: k.url,
      extra: {
        hover: k.summary ?? undefined,
        info: k.source,
      },
    })) as NewsItem[]
    return items.length ? items : rss()
  } catch {
    return rss()
  }
})
