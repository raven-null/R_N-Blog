import type { SourceMeta } from "../types"

/**
 * 移植自 NewsNow（newsnow/shared/sources.json 的子集）。
 * column → category 映射：
 *   tech    → 技术
 *   finance → 资讯
 *   china   → 资讯
 *   world   → 资讯
 *   sports  → 生活
 * 特定源（aihot）归类为 AI。
 */
export const metadata: Record<string, SourceMeta> = {
  weibo: { id: "weibo", name: "微博", column: "china", category: "资讯", home: "https://weibo.com", title: "实时热搜", type: "hottest", interval: 120000 },
  zhihu: { id: "zhihu", name: "知乎", column: "china", category: "资讯", home: "https://www.zhihu.com", title: "热榜", type: "hottest", interval: 600000 },
  baidu: { id: "baidu", name: "百度热搜", column: "china", category: "资讯", home: "https://www.baidu.com", type: "hottest", interval: 600000 },
  douyin: { id: "douyin", name: "抖音", column: "china", category: "资讯", home: "https://www.douyin.com", title: "热搜", type: "hottest", interval: 600000 },
  toutiao: { id: "toutiao", name: "今日头条", column: "china", category: "资讯", home: "https://www.toutiao.com", type: "hottest", interval: 600000 },
  thepaper: { id: "thepaper", name: "澎湃新闻", column: "china", category: "资讯", home: "https://www.thepaper.cn", title: "热榜", type: "hottest", interval: 1800000 },
  bilibili: { id: "bilibili", name: "哔哩哔哩", column: "china", category: "资讯", home: "https://www.bilibili.com", title: "热搜", type: "hottest", interval: 600000 },
  github: { id: "github", name: "Github", column: "tech", category: "技术", home: "https://github.com/", title: "Today", type: "hottest", interval: 600000 },
  hackernews: { id: "hackernews", name: "Hacker News", column: "tech", category: "技术", home: "https://news.ycombinator.com/", type: "hottest", interval: 600000 },
  v2ex: { id: "v2ex", name: "V2EX", column: "tech", category: "技术", home: "https://v2ex.com/", title: "最新分享", interval: 600000 },
  sspai: { id: "sspai", name: "少数派", column: "tech", category: "技术", home: "https://sspai.com", type: "hottest", interval: 600000 },
  ithome: { id: "ithome", name: "IT之家", column: "tech", category: "技术", home: "https://www.ithome.com", type: "realtime", interval: 600000 },
  juejin: { id: "juejin", name: "稀土掘金", column: "tech", category: "技术", home: "https://juejin.cn", type: "hottest", interval: 600000 },
  "36kr": { id: "36kr", name: "36氪", column: "tech", category: "技术", home: "https://36kr.com", title: "快讯", type: "realtime", interval: 600000 },
  aihot: { id: "aihot", name: "AIHOT", column: "tech", category: "AI", home: "https://aihot.virxact.com/all", type: "realtime", interval: 300000 },
  cls: { id: "cls", name: "财联社", column: "finance", category: "资讯", home: "https://www.cls.cn", title: "电报", type: "realtime", interval: 300000 },
  smzdm: { id: "smzdm", name: "什么值得买", column: "china", category: "生活", home: "https://post.smzdm.com", title: "热门", type: "hottest", interval: 600000 },
}
