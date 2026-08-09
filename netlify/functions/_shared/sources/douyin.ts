import { $fetch } from "ofetch"
import { myFetch } from "../fetch"
import { defineSource } from "../source"
import type { NewsItem } from "../types"

interface Res {
  data: {
    word_list: {
      sentence_id: string
      word: string
    }[]
  }
}

export default defineSource(async () => {
  const url = "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1"
  let cookie = ""
  try {
    const raw = await $fetch.raw("https://login.douyin.com/")
    cookie = (raw.headers as any).get?.("set-cookie") ?? ""
  } catch {
    // 忽略 cookie 获取失败，尽力抓取
  }
  const res: Res = await myFetch(url, {
    headers: { cookie },
  })
  return res.data.word_list.map(k => ({
    id: k.sentence_id,
    title: k.word,
    url: `https://www.douyin.com/hot/${k.sentence_id}`,
  })) as NewsItem[]
})
