import { json, noContent, badRequest } from "./_shared/cors"
import { getBlobStore } from "./_shared/blob"
import { checkAuth } from "./_shared/auth"

/**
 * GET /api/gallery-list —— 图片库只读列表（v0.2 新增）
 *
 * 给「智能工作台 → 图库 → 博客的图片」用：返回 Blobs 里所有图片的 key 与标签，
 * 前端再拼 /images/g/<key>（原图）与 /images/t/<key>（缩略图）。
 *
 * 鉴权：与后台一致，X-Admin-Key 请求头（或 ?adminKey=）。
 */

const IMAGE_STORE = "blog-images"
const TAG_STORE = "blog-image-tags"

type TagIndex = Record<string, string[]>

/** 标签索引：key → 标签数组（后台打标签时写入） */
async function readTagIndex(): Promise<TagIndex> {
  try {
    const raw = await getBlobStore(TAG_STORE).get("index", { type: "text" })
    if (!raw) return {}
    const parsed = JSON.parse(raw) as TagIndex
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

/** 列出图片 store 里所有 key（Blobs 的 list 单次有上限，按 cursor 循环取完） */
async function listImageKeys(store: any): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  for (let round = 0; round < 40; round += 1) {
    const options: Record<string, unknown> = { prefix: "" }
    if (cursor) options.cursor = cursor
    const page = (await store.list(options)) as { blobs?: Array<{ key: string }>; cursor?: string | null }
    const blobs = page.blobs ?? []
    for (const blob of blobs) keys.push(blob.key)
    cursor = page.cursor ?? undefined
    if (!cursor || blobs.length === 0) break
  }
  return keys
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") return noContent(req)
  if (req.method !== "GET") return badRequest("Method Not Allowed", req)

  const authed = await checkAuth(req)
  if (!authed) return json(401, { status: "error", message: "需要管理员 Key（X-Admin-Key）" }, req)

  try {
    const store = getBlobStore(IMAGE_STORE)
    const keys = await listImageKeys(store)
    const tagIndex = await readTagIndex()

    const items = keys
      .filter((key) => Boolean(key))
      .map((key) => ({
        key,
        tags: tagIndex[key] ?? [],
      }))
      // 新增的排前面（key 里通常带时间戳或随机串，这里只做稳定排序，前端不依赖顺序）
      .sort((a, b) => a.key.localeCompare(b.key))

    return json(
      200,
      {
        status: "ok",
        count: items.length,
        items,
      },
      req,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json(500, { status: "error", message: `读取图片列表失败：${message}` }, req)
  }
}
