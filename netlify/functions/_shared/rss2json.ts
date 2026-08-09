import { XMLParser } from "fast-xml-parser"
import { myFetch } from "./fetch"

export interface RSSInfo {
  title: string
  description: string
  link: string
  image: string
  category: string[]
  updatedTime: string
  items: RSSItem[]
}

export interface RSSItem {
  id: string
  title: string
  description: string
  link: string
  author: string
  created: string
  category: string[]
  content: string
  enclosures: any[]
}

export async function rss2json(url: string): Promise<RSSInfo | undefined> {
  if (!/^https?:\/\/[^\s$.?#].\S*/i.test(url)) return

  const data = await myFetch(url, { responseType: "text" })

  const xml = new XMLParser({
    attributeNamePrefix: "",
    textNodeName: "$text",
    ignoreAttributes: false,
  })

  const result = xml.parse(data as string)

  let channel = result.rss && result.rss.channel ? result.rss.channel : result.feed
  if (Array.isArray(channel)) channel = channel[0]

  const rss: RSSInfo = {
    title: channel.title ?? "",
    description: channel.description ?? "",
    link: channel.link && channel.link.href ? channel.link.href : channel.link,
    image: channel.image ? channel.image.url : channel["itunes:image"] ? channel["itunes:image"].href : "",
    category: channel.category || [],
    updatedTime: channel.lastBuildDate ?? channel.updated,
    items: [],
  }

  let items = channel.item || channel.entry || []
  if (items && !Array.isArray(items)) items = [items]

  for (let i = 0; i < items.length; i++) {
    const val = items[i]
    const obj: any = {
      id: val.guid && val.guid.$text ? val.guid.$text : val.id,
      title: val.title && val.title.$text ? val.title.$text : val.title,
      description: val.summary && val.summary.$text ? val.summary.$text : val.description,
      link: val.link && val.link.href ? val.link.href : val.link,
      author: val.author && val.author.name ? val.author.name : val["dc:creator"],
      created: val.updated ?? val.pubDate ?? val.created,
      category: val.category || [],
      content: val.content && val.content.$text ? val.content.$text : val["content:encoded"],
      enclosures: val.enclosure ? (Array.isArray(val.enclosure) ? val.enclosure : [val.enclosure]) : [],
    }

    if (val["media:thumbnail"]) obj.enclosures.push(val["media:thumbnail"])
    if (val["media:content"]) obj.enclosures.push(val["media:content"])

    rss.items.push(obj)
  }

  return rss
}
