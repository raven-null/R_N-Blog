/**
 * 本地抓取验证脚本：
 *   pnpm scrape         抓取全部来源并输出摘要
 *   pnpm scrape -- --json  输出完整 JSON
 *   pnpm scrape -- weibo,zhihu  只抓指定来源
 */
import { scrapeSources } from "../netlify/functions/_shared/news-engine"
import { metadata } from "../netlify/functions/_shared/sources"

const start = Date.now()
const args = process.argv.slice(2)
const jsonMode = args.includes("--json")
const ids = args.filter(a => !a.startsWith("--")).flatMap(a => a.split(",")).map(s => s.trim()).filter(Boolean)

const { cache, failed, skipped } = await scrapeSources({ ids, budgetMs: 12000 })

if (jsonMode) {
  console.log(JSON.stringify({ cache, failed, skipped }, null, 2))
  process.exit(0)
}

const lines = Object.values(cache.sources).map(s => {
  const first = s.items[0]?.title?.slice(0, 40) ?? "(空)"
  return `  ✔ ${s.id.padEnd(10)} ${s.name.padEnd(8)} ${s.category.padEnd(4)} ${String(s.items.length).padStart(3)} 条  ${first}`
})
console.log(`\n=== 抓取结果 (${Object.keys(cache.sources).length}/${Object.keys(metadata).length} 源成功) ===`)
console.log(lines.join("\n"))
if (failed.length) console.log(`\n❌ 失败(${failed.length}): ${failed.join(", ")}`)
if (skipped.length) console.log(`⚠️ 跳过(${skipped.length}): ${skipped.join(", ")}`)
console.log(`\n总耗时: ${((Date.now() - start) / 1000).toFixed(1)}s`)
