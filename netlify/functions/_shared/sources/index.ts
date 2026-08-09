import type { SourceGetter } from "../types"
import { metadata } from "./metadata"
import weibo from "./weibo"
import zhihu from "./zhihu"
import baidu from "./baidu"
import douyin from "./douyin"
import toutiao from "./toutiao"
import thepaper from "./thepaper"
import bilibili from "./bilibili"
import github from "./github"
import hackernews from "./hackernews"
import v2ex from "./v2ex"
import sspai from "./sspai"
import ithome from "./ithome"
import juejin from "./juejin"
import _36kr from "./_36kr"
import aihot from "./aihot"
import cls from "./cls"
import smzdm from "./smzdm"

export const sourceGetters: Record<string, SourceGetter> = {
  weibo,
  zhihu,
  baidu,
  douyin,
  toutiao,
  thepaper,
  bilibili,
  github,
  hackernews,
  v2ex,
  sspai,
  ithome,
  juejin,
  "36kr": _36kr,
  aihot,
  cls,
  smzdm,
}

export { metadata }
export type { SourceGetter }
