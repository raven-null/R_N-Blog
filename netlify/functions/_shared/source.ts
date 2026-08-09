import type { SourceGetter } from "./types"
import { rss2json } from "./rss2json"

/**
 * 纯透传，用于兼容 NewsNow 源文件的编写方式
 */
export function defineSource(source: SourceGetter): SourceGetter
export function defineSource(source: Record<string, SourceGetter>): Record<string, SourceGetter>
export function defineSource(source: SourceGetter | Record<string, SourceGetter>): SourceGetter | Record<string, SourceGetter> {
  return source
}

/**
 * 将 RSS 地址转换为资讯源
 */
export function defineRSSSource(url: string): SourceGetter {
  return async () => {
    const data = await rss2json(url)
    if (!data?.items.length) throw new Error(`Cannot fetch rss data: ${url}`)
    return data.items.map(item => ({
      title: item.title,
      url: item.link,
      id: item.link,
      pubDate: item.created,
    }))
  }
}

/**
 * md5 + WebCrypto，兼容 Node / Netlify 运行时
 */
import _md5 from "md5"

export async function md5(s: string) {
  try {
    const sUint8 = new TextEncoder().encode(s)
    const hashBuffer = await crypto.subtle.digest("MD5", sUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("")
  } catch {
    return _md5(s)
  }
}
