import { myFetch } from "../fetch"
import { defineSource } from "../source"
import type { NewsItem } from "../types"

interface WapRes {
  list: {
    keyword: string
    show_name: string
    icon: string
  }[]
}

export default defineSource(async () => {
  const url = "https://s.search.bilibili.com/main/hotword?limit=30"
  const res: WapRes = await myFetch(url)
  return res.list.map(k => ({
    id: k.keyword,
    title: k.show_name,
    url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(k.keyword)}`,
    extra: {
      icon: k.icon,
    },
  })) as NewsItem[]
})
