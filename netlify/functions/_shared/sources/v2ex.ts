import { myFetch } from "../fetch"
import { defineSource } from "../source"
import type { NewsItem } from "../types"

interface Res {
  items: {
    url: string
    date_modified?: string
    date_published: string
    title: string
    id: string
  }[]
}

export default defineSource(async () => {
  const res = await Promise.all(["create", "ideas", "programmer", "share"]
    .map(k => myFetch(`https://www.v2ex.com/feed/${k}.json`) as Promise<Res>))
  return res.map(k => k.items).flat().map(k => ({
    id: k.id,
    title: k.title,
    extra: {
      date: k.date_modified ?? k.date_published,
    },
    url: k.url,
  })).sort((m, n) => m.extra.date < n.extra.date ? 1 : -1) as NewsItem[]
})
