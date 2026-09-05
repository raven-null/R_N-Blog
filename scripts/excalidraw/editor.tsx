/**
 * Excalidraw 笔记前端（单 bundle 双模式）
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
 *
 * UI：液态玻璃（与博客 glass.css 同款变量）+ 内联 SVG 图标，不使用 emoji。
 */
import React, { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw"

// ===== 消除 unload 类 console violation =====
// Excalidraw 库内部会注册 beforeunload 监听（离开确认等），本场景为手动保存，
// 该监听无用途；Chrome 新版会对其打印 "Permissions policy violation:
// unload is not allowed in this document"。
// 在模块顶层过滤这两个事件类型：本 bundle 动态加载，页面其它脚本均已先执行
// （含 chat.js 的 beforeunload），故只影响 Excalidraw 内部的注册。
{
  const origAdd: any = window.addEventListener.bind(window)
  const origRemove: any = window.removeEventListener.bind(window)
  const blocked = (type: unknown) => type === "beforeunload" || type === "unload"
  window.addEventListener = ((type: any, listener: any, options?: any) => {
    if (blocked(type)) return
    return origAdd(type, listener, options)
  }) as any
  window.removeEventListener = ((type: any, listener: any, options?: any) => {
    if (blocked(type)) return
    return origRemove(type, listener, options)
  }) as any
}

// ===== 液态玻璃 UI 样式（幂等注入一次） =====
const UI_CSS = `
.exc-shell{display:flex;flex-direction:column;height:100%;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;color:#eee}
.exc-bar{display:flex;align-items:center;gap:10px;padding:8px 14px;flex-wrap:wrap;background:rgba(16,16,19,.62);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);border-bottom:1px solid rgba(255,255,255,.1);box-shadow:inset 0 1px 0 rgba(255,255,255,.07);font-size:13px;color:#e8e8ea;position:relative;z-index:6}
.exc-bar-title{display:inline-flex;align-items:center;gap:7px;font-weight:600;color:#fff;min-width:0}
.exc-bar-title svg{width:15px;height:15px;flex:none;color:#9aa0ff}
.exc-bar-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34vw}
.exc-bar-id{color:rgba(255,255,255,.38);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.exc-bar-spacer{flex:1}
.exc-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;cursor:pointer;font-size:13px;color:#e8e8ea;background:linear-gradient(145deg,rgba(255,255,255,.10),rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.14);box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 2px 10px -3px rgba(0,0,0,.5);transition:transform .25s cubic-bezier(.34,1.56,.64,1),background .2s ease,border-color .2s ease,box-shadow .2s ease,opacity .2s ease;white-space:nowrap;user-select:none;text-decoration:none}
.exc-btn:hover{background:linear-gradient(145deg,rgba(255,255,255,.17),rgba(255,255,255,.07));border-color:rgba(255,255,255,.26)}
.exc-btn:active{transform:scale(.95)}
.exc-btn:disabled{opacity:.45;cursor:default;transform:none}
.exc-btn svg{width:14px;height:14px;flex:none}
.exc-btn-primary{color:#0b0b10;background:linear-gradient(180deg,#fff,#d9d9e3);border-color:rgba(255,255,255,.55);box-shadow:inset 0 1px 0 #fff,0 4px 16px -6px rgba(255,255,255,.35)}
.exc-btn-primary:hover{background:linear-gradient(180deg,#fff,#e8e8f0);border-color:#fff}
.exc-input{padding:5px 13px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);color:#fff;font-size:13px;outline:none;box-shadow:inset 0 1px 0 rgba(255,255,255,.06);transition:border-color .2s ease,background .2s ease;width:118px}
.exc-input:focus{border-color:rgba(255,255,255,.38);background:rgba(255,255,255,.11)}
.exc-input::placeholder{color:rgba(255,255,255,.32)}
.exc-canvas{flex:1;min-height:0;position:relative;background:#f5f5f7}
.exc-mask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(8,8,12,.45);backdrop-filter:blur(8px) saturate(140%);-webkit-backdrop-filter:blur(8px) saturate(140%)}
.exc-modal{display:flex;flex-direction:column;gap:10px;padding:22px;border-radius:24px;min-width:min(430px,92vw);background:linear-gradient(145deg,rgba(34,34,42,.94),rgba(22,22,28,.9));backdrop-filter:blur(28px) saturate(180%);-webkit-backdrop-filter:blur(28px) saturate(180%);border:1px solid rgba(255,255,255,.13);box-shadow:0 28px 80px -20px rgba(0,0,0,.75),inset 0 1px 0 rgba(255,255,255,.1);animation:exc-modal-in .3s cubic-bezier(.22,1,.36,1)}
.exc-modal .t{font-size:16px;font-weight:700;color:#fff}
.exc-modal .sub{font-size:12px;color:rgba(255,255,255,.42);margin-bottom:2px}
.exc-pick{display:flex;gap:12px;align-items:flex-start;padding:13px 15px;border-radius:16px;cursor:pointer;background:linear-gradient(145deg,rgba(255,255,255,.07),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.11);color:#e8e8ea;text-align:left;transition:transform .25s cubic-bezier(.34,1.56,.64,1),border-color .2s ease,background .2s ease,box-shadow .2s ease;font-family:inherit}
.exc-pick:hover{border-color:rgba(255,255,255,.32);background:linear-gradient(145deg,rgba(255,255,255,.13),rgba(255,255,255,.05));box-shadow:0 8px 24px -10px rgba(0,0,0,.5)}
.exc-pick:active{transform:scale(.98)}
.exc-pick>svg{width:21px;height:21px;flex:none;margin-top:2px;color:#9aa0ff}
.exc-pick .pt{display:block;font-size:14px;font-weight:600;color:#fff;margin-bottom:3px}
.exc-pick .pd{display:block;font-size:12px;color:rgba(255,255,255,.45);line-height:1.6}
.exc-modal-row{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
/* 隐藏 Excalidraw 内置页脚（版权/语言等链接，本站顶栏已覆盖必要功能） */
.excalidraw .layer-ui__wrapper .layer-ui__wrapper__footer-center,
.excalidraw .layer-ui__wrapper .footer-center{display:none!important}
/* 空画布欢迎屏（新手引导大图）与浮动装饰提示：本站场景不需要 */
.excalidraw .welcome-screen-center,
.excalidraw .welcome-screen-decor{display:none!important}
@keyframes exc-modal-in{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:none}}
.exc-msg{display:flex;align-items:center;gap:8px;margin:8px 14px 10px;padding:7px 14px;border-radius:14px;font-size:12.5px;line-height:1.5;color:#d4d7e2;background:linear-gradient(145deg,rgba(30,30,36,.72),rgba(24,24,30,.6));backdrop-filter:blur(20px) saturate(160%);-webkit-backdrop-filter:blur(20px) saturate(160%);border:1px solid rgba(255,255,255,.1);box-shadow:inset 0 1px 0 rgba(255,255,255,.07);animation:exc-msg-in .35s cubic-bezier(.22,1,.36,1)}
.exc-msg .dot{width:6px;height:6px;border-radius:50%;flex:none;background:#5ac8fa;box-shadow:0 0 10px rgba(90,200,250,.9)}
.exc-ph{height:100%;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse 60% 50% at 30% 20%,rgba(90,120,255,.10),transparent 60%),radial-gradient(ellipse 50% 40% at 80% 75%,rgba(0,210,190,.06),transparent 60%),#101014}
.exc-ph-card{display:flex;flex-direction:column;align-items:center;gap:10px;padding:38px 46px;border-radius:26px;text-align:center;background:linear-gradient(145deg,rgba(255,255,255,.08),rgba(255,255,255,.03));backdrop-filter:blur(26px) saturate(180%);-webkit-backdrop-filter:blur(26px) saturate(180%);border:1px solid rgba(255,255,255,.12);box-shadow:0 20px 60px -16px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.09)}
.exc-ph-card>svg{width:36px;height:36px;color:rgba(255,255,255,.4)}
.exc-ph-title{font-size:17px;color:#fff;font-weight:600}
.exc-ph-sub{font-size:13px;color:rgba(255,255,255,.45);line-height:1.8;max-width:400px}
.exc-spinner{width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,.14);border-top-color:rgba(255,255,255,.75);animation:exc-spin .8s linear infinite}
@keyframes exc-spin{to{transform:rotate(360deg)}}
@keyframes exc-msg-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.exc-btn{transition:none}.exc-msg{animation:none}}
`
function ensureUiStyles() {
  if (document.getElementById("excalidraw-ui-css")) return
  const st = document.createElement("style")
  st.id = "excalidraw-ui-css"
  st.textContent = UI_CSS
  document.head.appendChild(st)
}

// ===== 内联 SVG 图标（stroke 风格，无 emoji） =====
type IconPath = React.ReactNode
const Ic = ({ p, ...rest }: { p: IconPath } & React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    {p}
  </svg>
)
const ICONS = {
  pencil: <><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  save: <><path d="M12 4v11" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m21 15.5-4.5-4.5L6 21.5" /></>,
  send: <><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4Z" /></>,
  doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></>,
  home: <><path d="m3 10.5 9-7.5 9 7.5" /><path d="M5 9.5V21h14V9.5" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.8" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  alert: <><path d="M12 3 2.5 20h19Z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.5" r=".4" fill="currentColor" /></>,
  board: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M8 12h8M12 8v8" /></>,
}

// ===== 工具函数 =====

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
  const [pubOpen, setPubOpen] = useState(false)
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
      const data = await res.json().catch(() => ({}))
      const isMissing = res.status === 404 || data?.code === "not_found"
      if (isMissing) {
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

  // view 模式的消息条自动淡出（不干扰阅读）
  useEffect(() => {
    if (mode !== "view" || !msg) return
    const t = window.setTimeout(() => setMsg(""), 4000)
    return () => window.clearTimeout(t)
  }, [msg, mode])

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
          setMsg(`检测到他人更新（rev ${remoteRev}，你当前 rev ${localRev}）：可刷新页面查看；如需提交你的改动请先保存（将提示覆盖确认）`)
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
      setMsg(`已保存 rev ${data.rev}（${new Date().toLocaleTimeString()}）`)
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

  // 「发布为博文」：导出截图 → 上传 → 按形态创建 draft 草稿
  // kind: article（截图+内嵌白板+链接的普通文章）/ whiteboard（整页白板文章）
  const publishToBlog = async (kind: "article" | "whiteboard") => {
    const api = apiRef.current
    if (!api) return
    try {
      // 1) 确保场景已保存（文章内嵌/白板引用同一 note id，且发布依赖当前画布）
      const saved = await save(false)
      if (!saved) return
      // 2) 导出 PNG 并上传到文章图床（自动转 webp，兼作封面/列表缩略图）
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

      let payload: any
      if (kind === "whiteboard") {
        // 纯白板文章：内容即白板（boardId），正文留空
        payload = { title, content: "", image: up.url, status: "draft", tags: [], type: "whiteboard", boardId: note }
      } else {
        // 普通文章：截图兜底 + 内嵌交互白板 + 原文链接三层
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
        payload = { title, content, image: up.url, status: "draft", tags: [] }
      }

      // 4) 创建 draft 草稿（进后台文章列表，作者完善后发布）
      setMsg("创建草稿…")
      const artRes = await apiFetch("/api/admin?action=articles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const art = await artRes.json().catch(() => ({}))
      if (!artRes.ok || art.status !== "success") {
        setMsg("创建草稿失败：" + (art.message || artRes.status))
        return
      }
      setMsg(
        kind === "whiteboard"
          ? `白板文章草稿已创建（id: ${art.data?.id}）：阅读页将整页展示白板、无目录。后台文章管理可预览发布`
          : `草稿已创建（id: ${art.data?.id}），去后台完善并发布：/admin.html → 文章管理`,
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
    return (
      <div className="exc-ph">
        <div className="exc-spinner" />
      </div>
    )
  }
  // 仅 view 模式对不存在的笔记显示占位；edit 模式继续渲染空画布（保存时创建）
  if (notFound && mode === "view") {
    return (
      <div className="exc-ph">
        <div className="exc-ph-card">
          <Ic p={ICONS.doc} />
          <div className="exc-ph-title">白板不存在</div>
          <div className="exc-ph-sub">链接可能已失效，或笔记尚未创建。</div>
        </div>
      </div>
    )
  }

  const initialData = scene
    ? { elements: scene.elements, appState: scene.appState, files: scene.files }
    : { elements: [] }

  return (
    <div className="exc-shell">
      {mode === "edit" && (
        <div className="exc-bar">
          <span className="exc-bar-title">
            <Ic p={ICONS.pencil} />
            <span>{title}</span>
          </span>
          <span className="exc-bar-id">id: {note}</span>
          <span className="exc-bar-spacer" />
          {meta?.hasKey && !isAdmin && (
            <input
              className="exc-input"
              value={editKey}
              onChange={e => setEditKey(e.target.value)}
              type="password"
              placeholder="编辑口令"
            />
          )}
          <button className="exc-btn" onClick={exportPng} title="导出当前画布为 PNG 图片">
            <Ic p={ICONS.image} />
            PNG
          </button>
          {isAdmin && (
            <button className="exc-btn" onClick={() => setPubOpen(true)} disabled={saving} title="选择文章形态，生成草稿进入后台文章管理">
              <Ic p={ICONS.send} />
              发布为博文
            </button>
          )}
          <button className="exc-btn exc-btn-primary" onClick={() => save(false)} disabled={saving} title="保存到服务器（Ctrl+S）">
            <Ic p={ICONS.save} />
            {saving ? "保存中…" : "保存（Ctrl+S）"}
          </button>
        </div>
      )}
      <div className="exc-canvas">
        <Excalidraw
          key={note + mode}
          excalidrawAPI={api => { apiRef.current = api }}
          initialData={initialData}
          viewModeEnabled={mode === "view"}
          langCode="zh-CN"
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
              : {
                  welcomeScreen: false,
                  canvasActions: {
                    // 编辑模式：功能由本站顶栏承担，隐藏库内同功能入口与无关项
                    export: false,
                    saveToActiveFile: false,
                    loadScene: false,
                    saveAsImage: false,
                    toggleTheme: false,
                  },
                }
          }
        />
      </div>
      {msg && (
        <div className="exc-msg">
          <span className="dot" />
          <span>{msg}</span>
        </div>
      )}
      {pubOpen && (
        <div className="exc-mask" onClick={() => setPubOpen(false)}>
          <div className="exc-modal" onClick={e => e.stopPropagation()}>
            <div className="t">发布为博文</div>
            <div className="sub">选择文章的呈现形态，草稿将进入后台文章管理</div>
            <button className="exc-pick" onClick={() => { setPubOpen(false); publishToBlog("article") }}>
              <Ic p={ICONS.doc} />
              <span>
                <span className="pt">普通文章</span>
                <span className="pd">正文截图 + 可交互白板 + 原文链接，之后可在后台继续写 Markdown 正文</span>
              </span>
            </button>
            <button className="exc-pick" onClick={() => { setPubOpen(false); publishToBlog("whiteboard") }}>
              <Ic p={ICONS.board} />
              <span>
                <span className="pt">纯白板文章</span>
                <span className="pd">阅读页整页展示白板（无目录侧栏），封面自动取白板截图</span>
              </span>
            </button>
            <div className="exc-modal-row">
              <button className="exc-btn" onClick={() => setPubOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 扫描并挂载所有 [data-excalidraw] 容器 */
function mountAll() {
  ensureUiStyles()
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
