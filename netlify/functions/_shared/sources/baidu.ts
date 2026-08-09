import { myFetch } from "../fetch"
import { defineSource } from "../source"
import type { NewsItem } from "../types"

interface Res {
  data: {
    cards: {
      content: {
        isTop?: boolean
        word: string
        rawUrl: string
        desc?: string
      }[]
    }[]
  }
}

export default defineSource(async () => {
  const rawData: string = await myFetch("https://top.baidu.com/board?tab=realtime")
  const jsonStr = (rawData as string).match(/<!--s-data:(.*?)-->/s)
  const data: Res = JSON.parse(jsonStr![1])

  return data.data.cards[0].content.filter(k => !k.isTop).map(k => ({
    id: k.rawUrl,
    title: k.word,
    url: k.rawUrl,
    extra: {
      hover: k.desc,
    },
  })) as NewsItem[]
})
