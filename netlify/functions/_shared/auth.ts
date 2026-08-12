import { getBlobStore } from "./blob"

// 读取后台密码：环境变量 ADMIN_KEY 优先，其次 Blobs（设置中修改的），默认 1111
export async function getAdminPassword(): Promise<string> {
  const envPwd = process.env.ADMIN_KEY
  if (envPwd) return envPwd
  try {
    const store = getBlobStore("blog-auth", "strong")
    const raw = await store.get("password", { type: "text" })
    if (raw) return raw
  } catch (e) {}
  return "1111"
}

// 校验 X-Admin-Key 请求头是否与后台密码一致
export async function checkAuth(req: Request): Promise<boolean> {
  const adminKey = await getAdminPassword()
  const provided = req.headers.get("x-admin-key") ?? ""
  return provided === adminKey
}
