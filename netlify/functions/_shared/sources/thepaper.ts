import { myFetch } from "../fetch"
import { defineSource } from "../source"
import type { NewsItem } from "../types"

interface Res {
  data: {
    hotNews: {
      contId: string
      name: string
    }[]
  }
}

export default defineSource(async () => {
  const url = "https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar"
  const res: Res = await myFetch(url)
  return res.data.hotNews.map(k => ({
    id: k.contId,
    title: k.name,
    url: `https://www.thepaper.cn/newsDetail_forward_${k.contId}`,
    mobileUrl: `https://m.thepaper.cn/newsDetail_forward_${k.contId}`,
  })) as NewsItem[]
})
