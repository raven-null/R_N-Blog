import { json, noContent } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"

/**
 * GET /api/github  (Netlify Functions v2)
 *
 * 把 GitHub 仓库列表喂给博客主页展示。
 *
 * 查询参数：
 *   limit=12        最多返回几个仓库（默认 12，上限 100）
 *   refresh=1       跳过缓存强制重新拉取
 *
 * 环境变量（可选）：
 *   GITHUB_OWNER      账号名，默认 raven-null
 *   GITHUB_TOKEN      PAT（只需 public_repo / 只读权限）；不配也能用，
 *                     走匿名接口（60 次/小时），配合 Blobs 缓存完全够用
 *   GITHUB_CACHE_TTL  缓存时长，默认 30 分钟
 *
 * 缓存：结果写入 Netlify Blobs（本地开发回退 .local-data），
 *       所以即使 GitHub 接口限流，访客仍能看到上一次成功的结果。
 */

const OWNER = (process.env.GITHUB_OWNER || "raven-null").trim()
const CACHE_TTL = Number(process.env.GITHUB_CACHE_TTL || 30 * 60 * 1000)
const STORE = "github-repos"
// key 只允许字母数字与 / - _ .（本地文件回退层与生产 Blobs 都遵守这条规则）
const CACHE_KEY = `repos/${OWNER.toLowerCase()}`

// 语言配色（与 GitHub 一致，前端直接用，避免两边各维护一份）
const LANG_COLORS: Record<string, string> = {
  JavaScript: "#f1e05a",
  TypeScript: "#3178c6",
  Vue: "#41b883",
  HTML: "#e34c26",
  CSS: "#563d7c",
  SCSS: "#c6538c",
  Python: "#3572A5",
  Java: "#b07219",
  Go: "#00ADD8",
  Rust: "#dea584",
  "C++": "#f34b7d",
  C: "#555555",
  Shell: "#89e051",
  Dart: "#00B4AB",
  Swift: "#F05138",
  PHP: "#4F5D95",
  Kotlin: "#A97BFF",
  Lua: "#000080",
}

interface RepoItem {
  name: string
  description: string
  language: string
  languageColor: string
  stars: number
  forks: number
  topics: string[]
  homepage: string
  updatedAt: string
  createdAt: string
  htmlUrl: string
}

interface RepoCache {
  updatedAt: number
  items: RepoItem[]
}

async function readCache(): Promise<RepoCache | null> {
  try {
    const store = getBlobStore(STORE)
    const raw = await store.get(CACHE_KEY, { type: "text" })
    return raw ? (JSON.parse(raw) as RepoCache) : null
  } catch {
    return null
  }
}

async function writeCache(cache: RepoCache) {
  try {
    const store = getBlobStore(STORE)
    await store.set(CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* 缓存写失败不影响返回 */
  }
}

function pickColor(language: string): string {
  return LANG_COLORS[language] || "#8b8b8b"
}

async function fetchRepos(): Promise<RepoItem[]> {
  const token = process.env.GITHUB_TOKEN
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "raven-null-blog",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  let res: Response
  try {
    res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(OWNER)}/repos?per_page=100&sort=pushed&type=owner`,
      { headers, signal: controller.signal },
    )
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw new Error(`GitHub API ${res.status}`)

  const list = (await res.json()) as any[]
  if (!Array.isArray(list)) throw new Error("GitHub API 返回格式异常")

  return list
    // 不要 fork 与已归档仓库
    .filter(r => !r.fork && !r.archived)
    .map(r => {
      const language = String(r.language || "")
      return {
        name: String(r.name || ""),
        description: String(r.description || "").trim(),
        language,
        languageColor: pickColor(language),
        stars: Number(r.stargazers_count || 0),
        forks: Number(r.forks_count || 0),
        topics: Array.isArray(r.topics) ? r.topics.slice(0, 3).map(String) : [],
        homepage: String(r.homepage || ""),
        updatedAt: String(r.pushed_at || r.updated_at || ""),
        createdAt: String(r.created_at || ""),
        htmlUrl: String(r.html_url || `https://github.com/${OWNER}/${r.name}`),
      }
    })
    // 最近有提交的排前面
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

export default async (req: Request) => {
  const method = req.method || "GET"

  if (method === "OPTIONS") return noContent(req)
  if (method !== "GET") {
    return json(405, { status: "error", message: "Method Not Allowed" }, req)
  }

  const params = new URL(req.url).searchParams
  const refresh = params.get("refresh") === "1"
  const limit = Math.min(Math.max(Number(params.get("limit") || 12), 1), 100)

  const cached = await readCache()
  const stale = !cached || Date.now() - cached.updatedAt > CACHE_TTL

  if (cached && !refresh && !stale) {
    return json(200, {
      status: "success",
      owner: OWNER,
      cached: true,
      updatedAt: cached.updatedAt,
      count: cached.items.length,
      items: cached.items.slice(0, limit),
    }, req)
  }

  try {
    const items = await fetchRepos()
    const updatedAt = Date.now()
    await writeCache({ updatedAt, items })
    return json(200, {
      status: "success",
      owner: OWNER,
      cached: false,
      updatedAt,
      count: items.length,
      items: items.slice(0, limit),
    }, req)
  } catch (err: any) {
    // 拉取失败但手上还有旧缓存：先把旧的给出去，页面上不至于空白
    if (cached) {
      return json(200, {
        status: "success",
        owner: OWNER,
        cached: true,
        stale: true,
        updatedAt: cached.updatedAt,
        count: cached.items.length,
        items: cached.items.slice(0, limit),
      }, req)
    }
    return json(503, {
      status: "error",
      message: `GitHub 数据暂时不可用：${err?.message ?? err}`,
    }, req)
  }
}
