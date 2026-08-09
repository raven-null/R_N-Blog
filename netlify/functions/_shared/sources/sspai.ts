import { myFetch } from "../fetch"
import { defineSource } from "../source"
import type { NewsItem } from "../types"

interface Res {
  data: {
    id: number
    title: string
  }[]
}

export default defineSource(async () => {
  const timestamp = Date.now()
  const url = `https://sspai.com/api/v1/article/tag/page/get?limit=30&offset=0&created_at=${timestamp}&tag=%E7%83%AD%E9%97%A8%E6%96%87%E7%AB%A0&released=false`
  const res: Res = await myFetch(url)
  return res.data.map(k => ({
    id: k.id,
    title: k.title,
    url: `https://sspai.com/post/${k.id}`,
  })) as NewsItem[]
})
