import { myFetch } from "../fetch"
import { defineSource } from "../source"
import { md5 } from "../source"
import type { NewsItem } from "../types"

interface TelegraphItem {
  id: number
  title?: string
  brief: string
  shareurl: string
  ctime: number
  is_ad: number
}

interface TelegraphRes {
  data: { roll_data: TelegraphItem[] }
}

/**
 * 财联社签名参数（来源：RSSHub cls/utils.ts）
 */
const signParams = { appName: "CailianpressWeb", os: "web", sv: "7.7.5" }

async function getSearchParams(moreParams?: Record<string, any>) {
  const searchParams = new URLSearchParams({ ...signParams, ...moreParams })
  searchParams.sort()
  searchParams.append("sign", await myCrypto(searchParams.toString(), "SHA-1").then(md5))
  return searchParams
}

async function myCrypto(s: string, algorithm: "MD5" | "SHA-1") {
  const sUint8 = new TextEncoder().encode(s)
  const hashBuffer = await crypto.subtle.digest(algorithm, sUint8)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("")
}

export default defineSource(async () => {
  const apiUrl = "https://www.cls.cn/v1/roll/get_roll_list"
  const res: TelegraphRes = await myFetch(apiUrl, {
    query: Object.fromEntries(await getSearchParams({
      last_time: Math.floor(Date.now() / 1000),
      refresh_type: 1,
      rn: 30,
    })),
    headers: { Referer: "https://www.cls.cn/telegraph" },
  })
  return res.data.roll_data.filter(k => !k.is_ad).map(k => ({
    id: k.id,
    title: k.title || k.brief,
    mobileUrl: k.shareurl,
    pubDate: k.ctime * 1000,
    url: `https://www.cls.cn/detail/${k.id}`,
  })) as NewsItem[]
})
