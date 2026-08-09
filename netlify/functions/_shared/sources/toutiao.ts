import { myFetch } from "../fetch"
import { defineSource } from "../source"
import type { NewsItem } from "../types"

interface Res {
  data: {
    ClusterIdStr: string
    Title: string
    LabelUri?: { url: string }
  }[]
}

export default defineSource(async () => {
  const url = "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc"
  const res: Res = await myFetch(url)
  return res.data.map(k => ({
    id: k.ClusterIdStr,
    title: k.Title,
    url: `https://www.toutiao.com/trending/${k.ClusterIdStr}/`,
    extra: {
      icon: k.LabelUri?.url,
    },
  })) as NewsItem[]
})
