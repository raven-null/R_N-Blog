/**
 * Excalidraw 笔记前端（M1：单 bundle 双模式）
 *
 * 由 scripts/build-excalidraw.mjs 打成静态 IIFE bundle（public/js/vendor/excalidraw/）。
 *
 * 用法（容器协议）：
 *   <div data-excalidraw data-note="demo" data-mode="view"></div>  ← 只读
 *   <div data-excalidraw data-note="demo" data-mode="edit"></div>  ← 编辑（顶栏内置）
 * 同一页面可挂多个容器；初始化后外部可用 window.ExcalidrawMount() 重新扫描（懒加载场景）。
 *
 * 交互：Ctrl/Cmd+S 保存；口令保护笔记需在顶栏输入编辑口令；管理员（localStorage
 * admin_key）自动带 X-Admin-Key，免口令；409 冲突时确认后强制覆盖（旧版进快照）。
 */
import React, { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw"

// 场景 JSON 自后端原样透传（结构由 Excalidraw 运行时解释），类型从宽
interface SceneData {
  type?: string
  version?: number
  elements: any[]
  appState?: any
  files?: any
}
interface NoteMeta {
  title?: string
  editable: 0 | 1
  hasKey: boolean
  rev: number
  updatedAt?: string
}

function getAdminKey(): string | null {
  try {
    return localStorage.getItem("admin_key")
  } catch {
    return null
  }
}

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const ak = getAdminKey()
  return fetch(input, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      ...(ak ? { "x-admin-key": ak } : {}),
    },
  })
}

const btn: React.CSSProperties = {
  padding: "4px 10px",
  background: "#2f6fed",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
  whiteSpace: "nowrap",
}
const btnGhost: React.CSSProperties = {
  ...btn,
  background: "transparent",
  border: "1px solid #555",
  color: "#ccc",
}

/** Blob → base64（去 dataURL 前缀） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const s = String(fr.result || "")
      resolve(s.slice(s.indexOf(",") + 1))
    }
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}

/** 文本 gzip 压缩 → base64（大场景传输用）；浏览器不支持或失败返回 null */
async function gzipEncode(text: string): Promise<string | null> {
  try {
    if (typeof CompressionStream === "undefined") return null
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))
    const buf = await new Response(stream).arrayBuffer()
    const u8 = new Uint8Array(buf)
    let bin = ""
    const CHUNK = 0x8000
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode(...u8.subarray(i, i + CHUNK))
    }
    return btoa(bin)
  } catch {
    return null
  }
}

function NoteApp({ note, mode }: { note: string; mode: "edit" | "view" }) {
  const apiRef = useRef<any>(null)
  const loadedRev = useRef<number | null>(null)
  const [scene, setScene] = useState<SceneData | null>(null)
  const [meta, setMeta] = useState<NoteMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [msg, setMsg] = useState("")
  const [editKey, setEditKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState(note || "未命名白板")
  const isAdmin = !!getAdminKey()

  // silent=true：不闪 loading（轮询刷新用），已有画布时用 updateScene 增量替换
  const load = async (silent = false) => {
    if (!note) {
      setLoading(false)
      setNotFound(true)
      return
    }
    if (!silent) setLoading(true)
    try {
      const res = await apiFetch(`/api/excalidraw?id=${encodeURIComponent(note)}`)
      if (res.status === 404) {
        setNotFound(true)
        if (!silent) {
          setLoading(false)
          // 编辑模式：给一块空画布直接画，保存时才创建
          if (mode === "edit") {
            setMsg("新笔记：直接开始画，点「保存」即创建（仅管理员可创建，请先登录 /admin.html）")
          }
        }
        return
      }
      const data = await res.json()
      if (!res.ok || data.status !== "success") {
        if (!silent) {
          setMsg(data.message || `载入失败 ${res.status}`)
          setLoading(false)
        }
        return
      }
      const sc = data.scene as SceneData
      const api = apiRef.current
      if (api) {
        // 已有实例：增量替换元素与文件（不重置视图），避免整页闪烁
        api.updateScene({ elements: sc.elements || [], files: sc.files || undefined })
      }
      setScene(sc)
      setMeta(data.meta as NoteMeta)
      loadedRev.current = data.meta?.rev ?? null
      setTitle(data.meta?.title || note)
      if (!silent) {
        setLoading(false)
        setMsg(
          data.meta?.editable === 1
            ? `已载入（rev ${data.meta?.rev ?? 0}）`
            : "已载入（当前只读：作者未开放编辑）",
        )
      }
    } catch (e: any) {
      if (!silent) {
        setMsg("载入出错：" + (e?.message || e))
        setLoading(false)
      }
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])
  useEffect(() => {
    document.title = mode === "edit" ? `编辑：${title}` : title
  }, [title, mode])

  // L1.5 协作感知：轻量轮询 meta.rev 检测他人更新
  // view 模式自动静默刷新；edit 模式提示（避免覆盖未保存改动）
  useEffect(() => {
    if (!note) return
    const timer = window.setInterval(async () => {
      try {
        const res = await apiFetch(`/api/excalidraw?id=${encodeURIComponent(note)}&metaOnly=1`)
        if (!res.ok) return
        const d = await res.json()
        if (d.status !== "success" || !d.meta) return
        const remoteRev = d.meta.rev as number
        const localRev = loadedRev.current
        if (localRev === null || remoteRev === localRev) return
        if (mode === "view") {
          setMsg(`已自动更新到 rev ${remoteRev}`)
          await load(true)
        } else {
          setMsg(`🔔 检测到他人更新（rev ${remoteRev}，你当前 rev ${localRev}）：可刷新页面查看；如需提交你的改动请先保存（将提示覆盖确认）`)
        }
      } catch {
        // 轮询失败静默（网络抖动/离线）
      }
    }, mode === "view" ? 20000 : 30000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, mode])

  const save = async (force = false): Promise<boolean> => {
    const api = apiRef.current
    if (!api) return false
    const elements = api.getSceneElements()
    if (!elements.length) {
      setMsg("画布是空的，先画点内容再保存")
      return false
    }
    const appState = api.getAppState()
    const scenePayload: SceneData = {
      type: "excalidraw",
      version: 2,
      elements,
      files: api.getFiles(),
      appState: { viewBackgroundColor: appState.viewBackgroundColor },
    }
    // 大场景（>400KB）自动 gzip 压缩传输，服务端透明解压存储
    const sceneText = JSON.stringify(scenePayload)
    const body: any = { baseRev: loadedRev.current ?? 0 }
    if (sceneText.length > 400 * 1024) {
      const gz = await gzipEncode(sceneText)
      if (gz) {
        body.scene = gz
        body.compressed = 1
      } else {
        body.scene = scenePayload
      }
    } else {
      body.scene = scenePayload
    }
    if (meta?.hasKey && !isAdmin) body.editKey = editKey
    if (force) body.force = 1

    setSaving(true)
    setMsg("保存中…")
    try {
      const res = await apiFetch(`/api/excalidraw?id=${encodeURIComponent(note)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409) {
        const ok = window.confirm(
          `检测到他人更新（最新 rev ${data.latestRev}）。以你当前画布覆盖吗？旧版已自动存快照可找回。`,
        )
        if (ok) {
          setSaving(false)
          return save(true)
        }
        setMsg("已取消；刷新页面可查看他人最新版本")
        return false
      }
      if (res.status === 401) {
        setMsg("编辑口令错误")
        setEditKey("")
        return false
      }
      if (res.status === 403) {
        setMsg(data.message || "无权限：笔记只读或仅管理员可创建")
        return false
      }
      if (!res.ok) {
        setMsg(data.message || `保存失败 ${res.status}`)
        return false
      }
      loadedRev.current = data.rev ?? loadedRev.current
      setMeta(m => (m ? { ...m, rev: data.rev ?? m.rev } : m))
      if (data.created) setNotFound(false) // 创建成功：退出"新笔记"状态
      setMsg(`✅ 已保存 rev ${data.rev}（${new Date().toLocaleTimeString()}）`)
      return true
    } catch (e: any) {
      setMsg("保存出错：" + (e?.message || e))
      return false
    } finally {
      setSaving(false)
    }
  }

  const exportPng = async () => {
    const api = apiRef.current
    if (!api) return
    try {
      const blob = await exportToBlob({
        elements: api.getSceneElements(),
        appState: { ...api.getAppState(), exportBackground: true },
        files: api.getFiles(),
        mimeType: "image/png",
      })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `excalidraw-${note || "board"}.png`
      a.click()
      setMsg(`已导出 PNG（${Math.round(blob.size / 1024)} KB）`)
    } catch (e: any) {
      setMsg("导出 PNG 出错：" + (e?.message || e))
    }
  }

  // 「发布为博文」：截图上传 → 组装含内嵌白板的 Markdown → 以 draft 草稿入库
  const publishToBlog = async () => {
    const api = apiRef.current
    if (!api) return
    try {
      // 1) 确保场景已保存（文章内嵌 fence 引用同一 note id，且发布依赖当前画布）
      const saved = await save(false)
      if (!saved) return
      // 2) 导出 PNG 并上传到文章图床（自动转 webp）
      const blob = await exportToBlob({
        elements: api.getSceneElements(),
        appState: { ...api.getAppState(), exportBackground: true },
        files: api.getFiles(),
        mimeType: "image/png",
      })
      setMsg("上传截图…")
      const upRes = await fetch("/api/article-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: await blobToBase64(blob), mime: "image/png", name: `${note || "board"}.png` }),
      })
      const up = await upRes.json().catch(() => ({}))
      if (!upRes.ok || up.status !== "success" || !up.url) {
        setMsg("截图上传失败：" + (up.message || upRes.status))
        return
      }
      // 3) 标题（默认取笔记标题）
      const fallbackTitle = meta?.title || `白板：${note}`
      const title = (window.prompt("文章标题：", fallbackTitle) || "").trim() || fallbackTitle
      // 4) 组装 Markdown：截图兜底 + 内嵌交互白板 + 原文链接
      const content = [
        "",
        `![白板截图（点击图片可放大，下方为可交互白板）](${up.url})`,
        "",
        "```excalidraw",
        note,
        "```",
        "",
        `[在 Excalidraw 中查看 / 编辑此白板](/excalidraw.html?note=${encodeURIComponent(note)})`,
        "",
      ].join("\n")
      // 5) 创建 draft 草稿（进后台文章列表，作者完善后发布）
      setMsg("创建草稿…")
      const artRes = await apiFetch("/api/admin?action=articles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, image: up.url, status: "draft", tags: [] }),
      })
      const art = await artRes.json().catch(() => ({}))
      if (!artRes.ok || art.status !== "success") {
        setMsg("创建草稿失败：" + (art.message || artRes.status))
        return
      }
      setMsg(
        `✅ 草稿已创建（id: ${art.data?.id}），去后台完善并发布：/admin.html → 文章管理`,
      )
    } catch (e: any) {
      setMsg("发布出错：" + (e?.message || e))
    }
  }

  // Ctrl/Cmd + S 保存
  useEffect(() => {
    if (mode !== "edit") return
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  })

  if (loading) {
    return <div style={{ ...placeholder, color: "#999" }}>加载中…</div>
  }
  // 仅 view 模式对不存在的笔记显示占位；edit 模式继续渲染空画布（保存时创建）
  if (notFound && mode === "view") {
    return (
      <div style={placeholder}>
        <div style={{ fontSize: 18, marginBottom: 8 }}>📄 白板不存在</div>
        <div style={{ color: "#999", fontSize: 13 }}>
          链接可能已失效，或笔记尚未创建。
        </div>
      </div>
    )
  }

  const initialData = scene
    ? { elements: scene.elements, appState: scene.appState, files: scene.files }
    : { elements: [] }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {mode === "edit" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            background: "#171717",
            color: "#ddd",
            fontSize: 13,
            borderBottom: "1px solid #2c2c2c",
            flexWrap: "wrap",
          }}
        >
          <strong style={{ color: "#fff" }}>✏️ {title}</strong>
          <span style={{ color: "#888", fontSize: 12 }}>id: {note}</span>
          <span style={{ flex: 1 }} />
          {meta?.hasKey && !isAdmin && (
            <input
              value={editKey}
              onChange={e => setEditKey(e.target.value)}
              type="password"
              placeholder="编辑口令"
              style={{ padding: "4px 8px", width: 110, background: "#242424", color: "#fff", border: "1px solid #444", borderRadius: 4, fontSize: 13 }}
            />
          )}
          <button onClick={exportPng} style={btnGhost}>🖼 PNG</button>
          {isAdmin && (
            <button onClick={publishToBlog} disabled={saving} style={btnGhost} title="导出截图并生成一篇含交互白板的草稿文章">
              📝 发布为博文
            </button>
          )}
          <button onClick={() => save(false)} disabled={saving} style={btn}>
            {saving ? "保存中…" : "💾 保存（Ctrl+S）"}
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Excalidraw
          key={note + mode}
          excalidrawAPI={api => { apiRef.current = api }}
          initialData={initialData}
          viewModeEnabled={mode === "view"}
          theme="light"
          UIOptions={
            mode === "view"
              ? {
                  welcomeScreen: false,
                  canvasActions: {
                    export: false,
                    saveToActiveFile: false,
                    loadScene: false,
                    clearCanvas: false,
                    changeViewBackgroundColor: false,
                    toggleTheme: false,
                  },
                }
              : undefined
          }
        />
      </div>
      {mode === "edit" && msg && (
        <div style={{ padding: "4px 10px", fontSize: 12, color: "#8ab4f8", background: "#101010", borderTop: "1px solid #222" }}>
          {msg}
        </div>
      )}
    </div>
  )
}

const placeholder: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  background: "#121212",
  color: "#ccc",
  fontFamily: "system-ui, sans-serif",
}

/** 扫描并挂载所有 [data-excalidraw] 容器 */
function mountAll() {
  document.querySelectorAll<HTMLElement>("[data-excalidraw]").forEach(el => {
    if (el.dataset.mounted) return
    el.dataset.mounted = "1"
    const note = (el.dataset.note || "").trim()
    const mode = el.dataset.mode === "edit" ? "edit" : "view"
    createRoot(el).render(<NoteApp note={note} mode={mode} />)
  })
}

;(window as any).ExcalidrawMount = mountAll

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountAll)
} else {
  mountAll()
}
