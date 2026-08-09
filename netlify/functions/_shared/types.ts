export interface NewsItem {
  id: string | number
  title: string
  url: string
  mobileUrl?: string
  pubDate?: number | string
  extra?: {
    hover?: string
    date?: number | string
    info?: false | string
    diff?: number
    icon?: false | string | { url: string; scale: number }
  }
}

export type SourceGetter = () => Promise<NewsItem[]>

export type SourceColumn = "china" | "tech" | "finance" | "world" | "sports"

/**
 * 单个资讯源的元信息。
 * category 为映射到 ravennull.work 博客「资讯」卡片的分类：技术 / 资讯 / AI / 生活
 */
export interface SourceMeta {
  id: string
  name: string
  column: SourceColumn
  category: string
  home?: string
  title?: string
  type?: "hottest" | "realtime"
  interval: number
  desc?: string
}

export interface SourceResult {
  id: string
  name: string
  column: SourceColumn
  category: string
  home?: string
  title?: string
  updatedTime: number
  items: NewsItem[]
}

export interface NewsCache {
  updatedAt: number
  sources: Record<string, SourceResult>
}

export interface Comment {
  id: string
  postId: string
  name: string
  email?: string
  site?: string
  content: string
  image?: string
  createdAt: number
  ip?: string
}
