/**
 * Excalidraw M1 API 回归测试
 * 运行：node scripts/build-excalidraw.mjs 前请先 bundle：
 *   node_modules/.bin/esbuild scripts/poc-test-excalidraw.ts --bundle --platform=node --format=esm --packages=external --outfile=.local-data/poc-test-excalidraw.mjs
 *   node .local-data/poc-test-excalidraw.mjs
 *
 * 覆盖：创建权限 / 公开读取 / 口令校验 / 只读开关 / 乐观锁 409 / force 覆盖 /
 *       rev 快照归档 / rollback 回滚 / meta 修改 / list 列表
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import excalidrawFn from "../netlify/functions/excalidraw"

const ADMIN_KEY = process.env.ADMIN_KEY || "1111"

async function call(method: string, path: string, body?: unknown, admin = false) {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { "x-admin-key": ADMIN_KEY } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
  const req = new Request(`http://localhost${path}`, init)
  const res = await excalidrawFn(req)
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

let failed = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name} ${extra}`)
  }
}

const ID = "m1-demo"
const sceneA = { type: "excalidraw", version: 2, elements: [{ id: "a", type: "rectangle", text: "A" }], files: {} }
const sceneB = { type: "excalidraw", version: 2, elements: [{ id: "b", type: "ellipse", text: "B" }], files: {} }
const sceneC = { type: "excalidraw", version: 2, elements: [{ id: "c", type: "text", text: "C" }], files: {} }

console.log("== M1 Excalidraw API 回归 ==")

// 0. 清理
rmSync(join(process.cwd(), ".local-data/excalidraw"), { recursive: true, force: true })
console.log("0) 清理残留 ✅")

// 1. 匿名创建被拒（防垃圾）
let r = await call("PUT", `/api/excalidraw?id=${ID}`, { scene: sceneA })
check("1) 匿名创建 → 403", r.status === 403, JSON.stringify(r.data))

// 2. 管理员创建
r = await call("PUT", `/api/excalidraw?id=${ID}`, { scene: sceneA }, true)
check("2) Admin 创建 → 200 rev=0", r.status === 200 && r.data?.rev === 0 && r.data?.created === true, JSON.stringify(r.data))

// 3. 公开读取
r = await call("GET", `/api/excalidraw?id=${ID}`)
check("3) 公开读取 → meta 公开字段正确", r.status === 200 && r.data?.meta?.editable === 1 && r.data?.meta?.hasKey === false && r.data?.meta?.rev === 0 && r.data?.scene?.elements?.[0]?.id === "a", JSON.stringify(r.data?.meta))

// 3b. metaOnly 轻量读取（轮询用）：含 meta 不含 scene
r = await call("GET", `/api/excalidraw?id=${ID}&metaOnly=1`)
check("3b) metaOnly → 有 meta 无 scene", r.status === 200 && r.data?.meta?.rev === 0 && !("scene" in (r.data || {})), JSON.stringify(r.data))

// 4. 匿名更新（无口令可编辑）
r = await call("PUT", `/api/excalidraw?id=${ID}`, { scene: sceneB, baseRev: 0 })
check("4) 匿名更新 → 200 rev=1", r.status === 200 && r.data?.rev === 1, JSON.stringify(r.data))

// 5. rev 快照：rev/0 应为初始版本
const snap0 = join(process.cwd(), `.local-data/excalidraw/notes/${ID}/rev/0`)
check("5) 快照 rev/0 已归档（初始版）", existsSync(snap0) && readFileSync(snap0, "utf-8").includes('"id":"a"'))

// 6. 乐观锁：baseRev=0 但当前 rev=1 → 409
r = await call("PUT", `/api/excalidraw?id=${ID}`, { scene: sceneC, baseRev: 0 })
check("6) 冲突 baseRev=0 → 409 latestRev=1", r.status === 409 && r.data?.latestRev === 1, JSON.stringify(r.data))

// 7. force 覆盖 → 200 rev=2
r = await call("PUT", `/api/excalidraw?id=${ID}`, { scene: sceneC, baseRev: 0, force: 1 })
check("7) force 覆盖 → 200 rev=2", r.status === 200 && r.data?.rev === 2, JSON.stringify(r.data))

// 8. Admin 设置口令
r = await call("POST", `/api/excalidraw?id=${ID}&action=meta`, { editKey: "secret123" }, true)
check("8) 设置口令 → hasKey=true", r.status === 200 && r.data?.meta?.hasKey === true, JSON.stringify(r.data))

// 9. 错口令更新 → 401
r = await call("PUT", `/api/excalidraw?id=${ID}`, { scene: sceneA, baseRev: 2, editKey: "wrong" })
check("9) 错口令 → 401", r.status === 401, JSON.stringify(r.data))

// 10. 对口令更新 → 200 rev=3
r = await call("PUT", `/api/excalidraw?id=${ID}`, { scene: sceneA, baseRev: 2, editKey: "secret123" })
check("10) 对口令 → 200 rev=3", r.status === 200 && r.data?.rev === 3, JSON.stringify(r.data))

// 11. 快照 rev/1 应为第一次保存后的版本（sceneB）；rev/0 为初始版（sceneA）
const snap1 = join(process.cwd(), `.local-data/excalidraw/notes/${ID}/rev/1`)
check("11) 快照 rev/1 = sceneB", existsSync(snap1) && readFileSync(snap1, "utf-8").includes('"id":"b"'))

// 12. Admin 关闭编辑 → 带口令更新也 403
r = await call("POST", `/api/excalidraw?id=${ID}&action=meta`, { editable: 0 }, true)
check("12) 设 editable=0 → 成功", r.status === 200 && r.data?.meta?.editable === 0, JSON.stringify(r.data))
r = await call("PUT", `/api/excalidraw?id=${ID}`, { scene: sceneC, baseRev: 3, editKey: "secret123" })
check("13) editable=0 时更新 → 403", r.status === 403, JSON.stringify(r.data))

// 13. rollback 到 rev/1（恢复到第一次保存后 = sceneB，需 Admin）
r = await call("POST", `/api/excalidraw?id=${ID}&action=rollback&rev=1`, undefined, true)
check("14) rollback rev=1 → 200", r.status === 200, JSON.stringify(r.data))
r = await call("GET", `/api/excalidraw?id=${ID}`)
check("15) 回滚后场景 = sceneB", r.status === 200 && r.data?.scene?.elements?.[0]?.id === "b", JSON.stringify(r.data?.scene?.elements?.[0]))

// 13b. rollback 到 rev/0（初始版 = sceneA）
r = await call("POST", `/api/excalidraw?id=${ID}&action=rollback&rev=0`, undefined, true)
check("15b) 回滚到 rev/0 = sceneA", r.status === 200, JSON.stringify(r.data))
r = await call("GET", `/api/excalidraw?id=${ID}`)
check("15c) 场景已恢复初始版", r.status === 200 && r.data?.scene?.elements?.[0]?.id === "a", JSON.stringify(r.data?.scene?.elements?.[0]))

// 14. list（Admin）
r = await call("GET", `/api/excalidraw?action=list`, undefined, true)
check("16) list 含 m1-demo 且 editable=0", r.status === 200 && r.data?.data?.some((n: any) => n.id === ID && n.editable === 0), JSON.stringify(r.data?.data))

// 15. 匿名 list → 401
r = await call("GET", `/api/excalidraw?action=list`)
check("17) 匿名 list → 401", r.status === 401, JSON.stringify(r.data))

// 16. 清除口令
r = await call("POST", `/api/excalidraw?id=${ID}&action=meta`, { editKey: "" }, true)
check("18) 清除口令 → hasKey=false", r.status === 200 && r.data?.meta?.hasKey === false, JSON.stringify(r.data))

// 17. 非法 id
r = await call("GET", `/api/excalidraw?id=非法!!`)
check("19) 非法 id → 400", r.status === 400, JSON.stringify(r.data))

// 18. history（Admin）：快照 revs + 当前 rev（当前最新版无快照，可回滚 0..2）
r = await call("GET", `/api/excalidraw?action=history&id=${ID}`, undefined, true)
const revs = (r.data?.revs || []) as number[]
check("20) history 列出快照 [2,1,0] current=3", r.status === 200 && revs.join(",") === "2,1,0" && r.data?.current === 3, JSON.stringify(r.data))

// 19. 匿名 history → 401
r = await call("GET", `/api/excalidraw?action=history&id=${ID}`)
check("21) 匿名 history → 401", r.status === 401, JSON.stringify(r.data))

// 20. delete（Admin）→ 全部清理，GET 404
r = await call("POST", `/api/excalidraw?action=delete&id=${ID}`, undefined, true)
check("22) delete → removed>=4", r.status === 200 && (r.data?.removed || 0) >= 4, JSON.stringify(r.data))
r = await call("GET", `/api/excalidraw?id=${ID}`)
check("23) 删除后 GET → 404", r.status === 404, JSON.stringify(r.data))

// ===== 压缩场景往返（大场景优化） =====
import { gzipSync } from "node:zlib"
const ID2 = "m1-big"
const bigElems: any[] = []
for (let i = 0; i < 2000; i++) {
  bigElems.push({ type: "text", id: `t${i}`, text: `元素 ${i} `.repeat(15), x: i * 3, y: i, fontSize: 16 })
}
const bigScene = { type: "excalidraw", version: 2, elements: bigElems, files: {} }
const bigRaw = JSON.stringify(bigScene)
const bigGz = gzipSync(Buffer.from(bigRaw, "utf8")).toString("base64")
check("24) 压缩显著减小体积（<1/3）", bigGz.length < bigRaw.length / 3, `${bigGz.length} vs ${bigRaw.length}`)

r = await call("PUT", `/api/excalidraw?id=${ID2}`, { scene: bigGz, compressed: 1 }, true)
check("25) 压缩创建 → 200 rev=0", r.status === 200 && r.data?.rev === 0, JSON.stringify(r.data))

r = await call("GET", `/api/excalidraw?id=${ID2}`)
check("26) 压缩读回 2000 元素", r.status === 200 && r.data?.scene?.elements?.length === 2000, JSON.stringify(r.data?.scene?.elements?.length))

const sceneFile = join(process.cwd(), `.local-data/excalidraw/notes/${ID2}/scene`)
const stored = existsSync(sceneFile) ? readFileSync(sceneFile, "utf-8") : ""
check("27) 落盘为 g1: 压缩格式", stored.startsWith("g1:"), stored.slice(0, 4))

r = await call("PUT", `/api/excalidraw?id=${ID2}`, { scene: bigGz, compressed: 1, baseRev: 0 })
check("28) 压缩更新 → 200 rev=1", r.status === 200 && r.data?.rev === 1, JSON.stringify(r.data))

r = await call("POST", `/api/excalidraw?action=rollback&id=${ID2}&rev=0`, undefined, true)
check("29) 回滚 rev0 → 200", r.status === 200, JSON.stringify(r.data))
r = await call("GET", `/api/excalidraw?id=${ID2}`)
check("30) 回滚后仍 2000 元素", r.status === 200 && r.data?.scene?.elements?.length === 2000, "")

r = await call("POST", `/api/excalidraw?action=delete&id=${ID2}`, undefined, true)
check("31) 清理 m1-big", r.status === 200, JSON.stringify(r.data))

console.log(failed === 0 ? "\n🎉 M1 全部通过" : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
