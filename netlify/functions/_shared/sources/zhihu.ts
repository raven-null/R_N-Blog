import { myFetch } from "../fetch"
import { defineSource } from "../source"
import type { NewsItem } from "../types"

interface Res {
  data: {
    target: {
      title_area: { text: string }
      excerpt_area: { text: string }
      metrics_area: { text: string }
      link: { url: string }
    }
  }[]
}

export default defineSource(async () => {
  const url = "https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true"
  const res: Res = await myFetch(url)
  return res.data.map(k => ({
    id: k.target.link.url.match(/(\d+)$/)?.[1] ?? k.target.link.url,
    title: k.target.title_area.text,
    extra: {
      info: k.target.metrics_area.text,
      hover: k.target.excerpt_area.text,
    },
    url: k.target.link.url,
  })) as NewsItem[]
})
