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
/* bare 模式（前台画布舞台就地编辑）：极简口令浮条 */
.exc-bare-key{position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:8;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 14px;border-radius:999px;background:linear-gradient(145deg,rgba(28,28,34,.86),rgba(18,18,24,.8));backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);border:1px solid rgba(255,255,255,.13);box-shadow:0 10px 30px -8px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.09)}
.exc-bare-key svg{width:13px;height:13px;flex:none;color:#9aa0ff}
.exc-bare-key .exc-input{width:130px}
.exc-ph{height:100%;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse 60% 50% at 30% 20%,rgba(90,120,255,.10),transparent 60%),radial-gradient(ellipse 50% 40% at 80% 75%,rgba(0,210,190,.06),transparent 60%),#101014}
.exc-ph-card{display:flex;flex-direction:column;align-items:center;gap:10px;padding:38px 46px;border-radius:26px;text-align:center;background:linear-gradient(145deg,rgba(255,255,255,.08),rgba(255,255,255,.03));backdrop-filter:blur(26px) saturate(180%);-webkit-backdrop-filter:blur(26px) saturate(180%);border:1px solid rgba(255,255,255,.12);box-shadow:0 20px 60px -16px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.09)}
.exc-ph-card>svg{width:36px;height:36px;color:rgba(255,255,255,.4)}
.exc-ph-title{font-size:17px;color:#fff;font-weight:600}
.exc-ph-sub{font-size:13px;color:rgba(255,255,255,.45);line-height:1.8;max-width:400px}
.exc-spinner{width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,.14);border-top-color:rgba(255,255,255,.75);animation:exc-spin .8s linear infinite}
@keyframes exc-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.exc-btn{transition:none}}
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

/** 画布内嵌图片压缩参数：最长边限制 + WebP 质量（可用时显著减小保存体积） */
const MAX_IMAGE_EDGE = 1600
const IMAGE_WEBP_QUALITY = 0.8
const SHRINK_MIN_BYTES = 200 * 1024 // 小于 200KB 且已是 WebP 的图片不动，避免无谓的质量损失

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("image decode failed"))
    img.src = src
  })
}

/**
 * 把内嵌图片压成 WebP 并限制最长边。
 * - 跳过 GIF（动图会被压成静态）与 SVG（矢量，canvas 处理不可靠）
 * - 已经足够小且本就是 WebP 的图片直接返回 null（保持原样）
 * - 压完反而更大时返回 null
 */
async function shrinkImageDataURL(
  dataURL: string,
  mimeType?: string,
): Promise<{ blob: Blob; mimeType: string } | null> {
  const mime = String(mimeType || (dataURL.match(/^data:([^;]+)/) || [])[1] || "").toLowerCase()
  if (!mime.startsWith("image/")) return null
  if (mime.includes("gif") || mime.includes("svg")) return null
  const comma = dataURL.indexOf(",")
  if (comma < 0) return null
  const approxBytes = Math.floor((dataURL.length - comma - 1) * 0.75) // base64 → 字节的粗略换算
  if (approxBytes <= SHRINK_MIN_BYTES && mime.includes("webp")) return null
  try {
    const img = await loadImageEl(dataURL)
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    if (!w || !h) return null
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(w, h))
    const cw = Math.max(1, Math.round(w * scale))
    const ch = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement("canvas")
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, cw, ch)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", IMAGE_WEBP_QUALITY))
    if (!blob || blob.size >= approxBytes) return null // 没变小就不换
    return { blob, mimeType: "image/webp" }
  } catch {
    return null
  }
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result || ""))
    fr.onerror = () => reject(new Error("blob→dataURL 失败"))
    fr.readAsDataURL(blob)
  })
}

async function dataURLToBlob(dataURL: string): Promise<Blob | null> {
  try {
    return await (await fetch(dataURL)).blob()
  } catch {
    return null
  }
}

/** 内嵌图片指纹（长度 + 末尾片段）：用于跳过未变化的图片重复上传 */
const fileSigOf = (dataURL: string) => `${dataURL.length}:${dataURL.slice(-32)}`

/** 场景轻量指纹：元素数 + versionNonce 混合（判断是否有未保存改动，O(n) 开销极小） */
function sceneFp(elements: readonly any[]): number {
  let h = (elements.length * 2654435761) >>> 0
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    if (el) h = ((h ^ (el.versionNonce | 0)) * 31) >>> 0
  }
  return h
}

function NoteApp({
  note,
  mode,
  bare,
  fromAdmin,
}: {
  note: string
  mode: "edit" | "view"
  bare?: boolean
  fromAdmin?: boolean
}) {
  const apiRef = useRef<any>(null)
  const filesSigRef = useRef<Record<string, string>>({}) // 已上传图片指纹（避免重复上传）
  const loadedRev = useRef<number | null>(null)
  // 未保存改动检测：画布指纹基准
  const fpRef = useRef(0)
  const dirtyRef = useRef(false)
  // 查看 / 编辑就地切换（与导图页同一套胶囊体验，不改 URL）
  const [editMode, setEditMode] = useState(mode === "edit")
  const [capMenuOpen, setCapMenuOpen] = useState(false)
  const capRef = useRef<HTMLDivElement | null>(null)
  const embedded = typeof window !== "undefined" && window.parent !== window
  // 白板胶囊默认渲染，显隐交给 CSS（body 上有 exc-no-capsule 时隐藏）：
  // 只在后台编辑页这类「顶栏本来就有整套按钮」的场合用 ?capsule=0 收起。
  const showCapsule = true
  // 信息浮层（独立打开时没有宿主页面的气泡，这里自带一个）
  const [infoOpen, setInfoOpen] = useState(false)
  // 留言抽屉（形态与导图/白板独立页一致）
  const [cmtOpen, setCmtOpen] = useState(false)
  const [cmts, setCmts] = useState<any[] | null>(null)
  const [cmtName, setCmtName] = useState("")
  const [cmtText, setCmtText] = useState("")
  const [cmtTip, setCmtTip] = useState("")
  const [cmtSending, setCmtSending] = useState(false)
  const cmtLoadedRef = useRef(false)
  // 进入编辑时是否要把口令浮条滑出来
  const keyRef = useRef<HTMLDivElement | null>(null)
  const toggleKeyBar = () => {
    const el = keyRef.current
    if (!el) return
    const open = el.classList.toggle("open")
    if (open) el.querySelector("input")?.focus()
  }
  // 成功类消息短暂显示后自动消失
  const okTimer = useRef<number | undefined>(undefined)
  const setMsgOk = (text: string) => {
    setMsg(text)
    if (okTimer.current) window.clearTimeout(okTimer.current)
    okTimer.current = window.setTimeout(() => setMsg(""), 6000)
  }
  useEffect(() => () => { if (okTimer.current) window.clearTimeout(okTimer.current) }, [])
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
          // 编辑模式：给一块空画布直接画，保存时才创建（文案区分管理员/访客）
          if (editMode) {
            setMsg(
              isAdmin
                ? "新笔记：直接开始画，点「保存」即可创建"
                : "新笔记：直接开始画，点「保存」即创建（仅管理员可创建，请先登录 /admin.html）",
            )
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
      let sc = data.scene as SceneData
      const api = apiRef.current
      // 内嵌图片改为逐张存储（v15）：按 scene.fileIds 逐张拉回后合并；旧数据仍带 files 时直接用
      const fids: string[] = Array.isArray((sc as any).fileIds) ? (sc as any).fileIds : []
      if (fids.length) {
        const got: Record<string, any> = {}
        await Promise.all(
          fids.map(async (fid) => {
            try {
              const r = await apiFetch(
                `/api/excalidraw?action=file&id=${encodeURIComponent(note)}&fid=${encodeURIComponent(fid)}`,
              )
              const d = await r.json().catch(() => ({}))
              if (d && d.file && d.file.dataURL) got[fid] = d.file
            } catch {
              /* 单张失败不影响整体 */
            }
          }),
        )
        fids.forEach((fid) => {
          const f = got[fid]
          if (f && f.dataURL) filesSigRef.current[fid] = fileSigOf(f.dataURL)
        })
        sc = { ...sc, files: got }
      }
      // 注意：旧格式（图片内嵌在 scene.files 里）不记录指纹——那些图片还没单独存到服务端，
      // 首次保存时必须上传，否则场景里只剩 fileIds 而图片实际缺失。
      if (api) {
        // 已有实例：增量替换元素与文件（不重置视图），避免整页闪烁
        api.updateScene({ elements: sc.elements || [], files: sc.files || undefined })
      }
      setScene(sc)
      setMeta(data.meta as NoteMeta)
      loadedRev.current = data.meta?.rev ?? null
      setTitle(data.meta?.title || note)
      // 指纹基准同步到服务器内容（初始载入 / 自动刷新都不算未保存改动）
      fpRef.current = sceneFp(sc.elements || [])
      dirtyRef.current = false
      if (!silent) {
        setLoading(false)
        setMsgOk(
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
    document.title = editMode ? `编辑：${title}` : title
  }, [title, editMode])

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
        if (!editMode) {
          setMsgOk(`已自动更新到 rev ${remoteRev}`)
          await load(true)
        } else {
          setMsg(`检测到他人更新（rev ${remoteRev}，你当前 rev ${localRev}）：可刷新页面查看；如需提交你的改动请先保存（将提示覆盖确认）`)
        }
      } catch {
        // 轮询失败静默（网络抖动/离线）
      }
    }, editMode ? 30000 : 20000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, editMode])

  const save = async (force = false): Promise<boolean> => {
    const api = apiRef.current
    if (!api) return false
    const elements = api.getSceneElements()
    if (!elements.length) {
      setMsg("画布是空的，先画点内容再保存")
      return false
    }
    const appState = api.getAppState()
    /* 内嵌图片逐张上传（v15）：整个场景一起传会超过服务器 6MB 请求体上限 → 保存 413 */
    const filesObj = (api.getFiles() || {}) as Record<string, any>
    const fileIds = Object.keys(filesObj)
    // 只上传有变化的图片（指纹判定），并按并发 3 上传：串行会让多图场景慢十几秒
    const pending = fileIds.filter((fid) => {
      const f = filesObj[fid]
      return !!(f && f.dataURL) && filesSigRef.current[fid] !== fileSigOf(f.dataURL)
    })
    const pendingChars = pending.reduce((n, fid) => n + (filesObj[fid].dataURL.length || 0), 0)
    /* ---- 第一步：压缩（最长边 1600 + WebP；GIF/SVG 与小图跳过）并准备二进制 ---- */
    const tShrinkStart = performance.now()
    const uploads: Array<{ fid: string; blob: Blob; mime: string; bytes: number }> = []
    let shrunkCount = 0
    let shrunkSaved = 0
    let prepError: string | null = null
    for (let i = 0; i < pending.length; i++) {
      const fid = pending[i]
      const f = filesObj[fid]
      if (pending.length > 1) setMsg(`压缩画布图片 ${i + 1}/${pending.length}…`)
      const beforeChars = f.dataURL.length
      const shrunk = await shrinkImageDataURL(f.dataURL, f.mimeType)
      if (shrunk) {
        const dataURL = await blobToDataURL(shrunk.blob) // 画布内部仍需 dataURL
        f.dataURL = dataURL
        f.mimeType = shrunk.mimeType
        shrunkCount++
        shrunkSaved += Math.max(0, beforeChars - dataURL.length)
        uploads.push({ fid, blob: shrunk.blob, mime: shrunk.mimeType, bytes: shrunk.blob.size })
      } else {
        const blob = await dataURLToBlob(f.dataURL)
        if (!blob) prepError = "画布图片读取失败（可能是跨域或损坏的图片）"
        uploads.push({ fid, blob: (blob || new Blob([])) as Blob, mime: f.mimeType || "application/octet-stream", bytes: blob ? blob.size : 0 })
      }
    }
    if (shrunkCount) {
      try {
        api.updateScene({ files: filesObj }) // 画布用上压缩后的数据，避免下次保存重传原图
      } catch {
        /* 忽略 */
      }
    }
    const tShrink = (performance.now() - tShrinkStart) / 1000
    const totalBytes = uploads.reduce((n, u) => n + u.bytes, 0)

    /* ---- 第二步：并发 3 直传二进制 ---- */
    const tUploadStart = performance.now()
    let done = 0
    let failed: string | null = prepError
    if (uploads.length && !failed) {
      setMsg(`上传画布图片 0/${uploads.length}（${(totalBytes / 1048576).toFixed(1)}MB）…`)
      const queue = uploads.slice()
      const worker = async (): Promise<void> => {
        while (queue.length && !failed) {
          const item = queue.shift() as { fid: string; blob: Blob; mime: string; bytes: number }
          try {
            const fr = await apiFetch(
              `/api/excalidraw?action=file&id=${encodeURIComponent(note)}&fid=${encodeURIComponent(item.fid)}`,
              {
                method: "POST",
                headers: { "Content-Type": item.mime || "application/octet-stream" },
                body: item.blob,
              },
            )
            if (!fr.ok) {
              const fd = await fr.json().catch(() => ({}))
              failed = fd.message || `画布图片上传失败（${fr.status}）：单张图片过大或网络问题`
              return
            }
            filesSigRef.current[item.fid] = fileSigOf(filesObj[item.fid].dataURL)
          } catch (e: any) {
            failed = e?.message || "画布图片上传失败：网络错误"
            return
          }
          done++
          setMsg(`上传画布图片 ${done}/${uploads.length}…`)
        }
      }
      await Promise.all([worker(), worker(), worker()])
      if (failed) {
        setSaving(false)
        setMsg(failed)
        return false
      }
    }
    const tUpload = (performance.now() - tUploadStart) / 1000
    if (shrunkCount || uploads.length) {
      console.log(
        `[白板] 图片处理：压缩 ${tShrink.toFixed(1)}s（${shrunkCount}/${uploads.length} 张，省 ${(shrunkSaved / 1048576).toFixed(1)}MB）· 上传 ${tUpload.toFixed(1)}s（${(totalBytes / 1048576).toFixed(1)}MB）`,
      )
    }
    const scenePayload: any = {
      type: "excalidraw",
      version: 2,
      elements,
      files: {}, // 图片数据已单独存储，这里只留 id 列表
      fileIds,
      appState: { viewBackgroundColor: appState.viewBackgroundColor },
    }
    // 大场景自动 gzip 压缩传输，服务端透明解压存储
    const sceneText = JSON.stringify(scenePayload)
    const body: any = { baseRev: loadedRev.current ?? 0 }
    if (sceneText.length > 64 * 1024) {
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
    // 体积预检：压缩后仍超过服务器请求上限时提前给出明确提示（避免直接 413）
    const finalChars = typeof body.scene === "string" ? body.scene.length : sceneText.length
    if (finalChars > 5.2 * 1024 * 1024) {
      setSaving(false)
      setMsg(
        `画布数据过大（约 ${(finalChars / 1048576).toFixed(1)}MB），服务器单次请求上限约 6MB，保存会被拒绝。请拆分画板或减少元素后重试。`,
      )
      return false
    }
    if (meta?.hasKey && !isAdmin) body.editKey = editKey
    if (force) body.force = 1

    setSaving(true)
    setMsg("保存中…")
    const tSceneStart = performance.now()
    try {
      const res = await apiFetch(`/api/excalidraw?id=${encodeURIComponent(note)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409) {
        if (bare) {
          // 前台舞台：不弹确认，自动以当前画布覆盖（旧版照常进快照可回滚）
          setSaving(false)
          return save(true)
        }
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
      // 保存成功：更新指纹基准与脏标记
      fpRef.current = sceneFp(elements)
      dirtyRef.current = false
      const tScene = (performance.now() - tSceneStart) / 1000
      console.log(
        `[白板] 保存完成 rev ${data.rev}：压缩 ${(typeof tShrink === "number" ? tShrink : 0).toFixed(1)}s · 上传 ${(typeof tUpload === "number" ? tUpload : 0).toFixed(1)}s · 场景 ${tScene.toFixed(1)}s`,
      )
      setMsgOk(
        bare
          ? force
            ? "已保存（他人更新的较新版本已被覆盖，旧版已存快照）"
            : "已保存"
          : `已保存 rev ${data.rev} · 压缩 ${(typeof tShrink === "number" ? tShrink : 0).toFixed(1)}s · 图片 ${(typeof tUpload === "number" ? tUpload : 0).toFixed(1)}s · 场景 ${tScene.toFixed(1)}s`,
      )
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
      setMsgOk(`已导出 PNG（${Math.round(blob.size / 1024)} KB）`)
    } catch (e: any) {
      setMsg("导出 PNG 出错：" + (e?.message || e))
    }
  }

  /* ---------- 底部胶囊（与导图页同一套外观与交互） ---------- */

  /** 留言时间格式（与导图页一致） */
  const fmtTime = (ts: number) => {
    try {
      const d = new Date(ts)
      const p = (n: number) => String(n).padStart(2, "0")
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    } catch {
      return ""
    }
  }

  async function loadComments() {
    try {
      const res = await fetch(`/api/comments?postId=${encodeURIComponent(note)}`, { cache: "no-store" })
      const d = await res.json().catch(() => ({}))
      setCmts(Array.isArray(d?.comments) ? d.comments : [])
    } catch {
      setCmts([])
      setCmtTip("留言加载失败")
    }
  }

  function toggleComments() {
    const next = !cmtOpen
    setCmtOpen(next)
    if (next && !cmtLoadedRef.current) {
      cmtLoadedRef.current = true
      try {
        setCmtName(localStorage.getItem("comment_name") || "")
      } catch {
        /* 忽略 */
      }
      void loadComments()
    }
  }

  async function submitComment() {
    const name = cmtName.trim()
    const content = cmtText.trim()
    if (!name || !content) {
      setCmtTip("昵称和内容都要填")
      return
    }
    setCmtSending(true)
    setCmtTip("发送中…")
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: note, name, content }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.status !== "success") {
        setCmtTip(d.message || `发送失败（${res.status}）`)
        return
      }
      try {
        localStorage.setItem("comment_name", name)
      } catch {
        /* 忽略 */
      }
      setCmtText("")
      setCmtTip("留言成功")
      await loadComments()
    } catch (e: any) {
      setCmtTip("发送出错：" + (e?.message || e))
    } finally {
      setCmtSending(false)
    }
  }

  /** 导出成 .excalidraw 文件，可再次导入 */
  const exportScene = () => {
    const api = apiRef.current
    if (!api) return
    try {
      const data = {
        type: "excalidraw",
        version: 2,
        source: "raven-blog",
        elements: api.getSceneElements(),
        appState: api.getAppState(),
        files: api.getFiles(),
      }
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `excalidraw-${note || "board"}.excalidraw`
      a.click()
      setMsgOk("已导出 .excalidraw")
    } catch (e: any) {
      setMsg("导出出错：" + (e?.message || e))
    }
  }

  /** 与宿主页面（文章页）通信：返回 / 留言 / 信息 */
  const tell = (action: string) => {
    try {
      window.parent.postMessage({ type: "board-stage", action, note }, "*")
    } catch {
      /* 忽略 */
    }
  }

  /** 进入 / 退出编辑：就地切换，不刷新页面 */
  const enterEdit = () => {
    setInfoOpen(false)
    setEditMode(true)
    setMsgOk(isAdmin || !meta?.hasKey ? "" : "此白板已加密：请先输入编辑口令")
  }
  /** 完成：有未保存改动先尝试保存，成功才退出编辑 */
  const finishEdit = async () => {
    if (dirtyRef.current) {
      const ok = await save(false)
      if (!ok) return // 保存失败（口令错等）：留在编辑态，错误信息已在提示里
    }
    setEditMode(false)
  }

  // 菜单点外部 / Esc 收起
  useEffect(() => {
    if (!capMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (capRef.current && !capRef.current.contains(e.target as Node)) setCapMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCapMenuOpen(false) }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [capMenuOpen])

  // 加密白板进编辑态时把口令浮条滑出来
  useEffect(() => {
    if (!editMode || !meta?.hasKey || isAdmin) return
    const el = keyRef.current
    if (!el) return
    el.classList.add("open")
    el.querySelector("input")?.focus()
  }, [editMode, meta?.hasKey, isAdmin])

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
    if (!editMode) return
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  })

  // 暴露保存方法与脏标记给宿主页面（bare 模式：前台舞台「完成」时判断是否需询问保存）
  useEffect(() => {
    if (!editMode) return
    const fn = () => save(false)
    ;(window as any).__excalidrawSave = fn
    ;(window as any).__excalidrawDirty = () => dirtyRef.current
    return () => {
      if ((window as any).__excalidrawSave === fn) delete (window as any).__excalidrawSave
      if ((window as any).__excalidrawDirty) delete (window as any).__excalidrawDirty
    }
  })

  if (loading) {
    return (
      <div className="exc-ph">
        <div className="exc-spinner" />
      </div>
    )
  }
  // 仅 view 模式对不存在的笔记显示占位；edit 模式继续渲染空画布（保存时创建）
  if (notFound && !editMode) {
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
    // 结构与导图页一致：.exc-shell 充当 #mm-root 的角色（固定铺满视口），
    // 所有浮层（胶囊 / 口令浮条 / 状态条）都挂在它下面，定位规则与导图完全相同。
    <div className="exc-shell" style={{ position: "fixed", inset: 0, zIndex: 1 }}>
      {/* 口令浮条：与导图页同一套样式，进编辑态自动滑出（bare 模式沿用旧的紧凑浮条） */}
      {editMode && meta?.hasKey && !isAdmin && (
        bare ? (
          <div className="exc-bare-key">
            <Ic p={ICONS.lock} />
            <input
              className="exc-input"
              value={editKey}
              onChange={e => setEditKey(e.target.value)}
              type="password"
              placeholder="编辑口令（输入后 Ctrl+S 保存）"
            />
          </div>
        ) : (
          <div className="mm-key" ref={keyRef}>
            <Ic p={ICONS.lock} />
            <input
              value={editKey}
              onChange={e => setEditKey(e.target.value)}
              type="password"
              placeholder="编辑口令"
            />
          </div>
        )
      )}

      {/* 底部居中胶囊：默认渲染，内嵌场景由 CSS（body.exc-no-capsule / .exc-from-admin）收起 */}
      {showCapsule && (
        <div className={"mm-capsule" + (editMode ? " is-edit" : "")} ref={capRef}>
          {/* 返回博客：独立打开直接回首页 */}
          <button className="mm-cap-btn bb-view-only cap-back" title="返回博客首页" onClick={() => { if (embedded) tell("back"); else location.href = "/" }}>
            <Ic p={ICONS.home} />
            <span>返回</span>
          </button>
          {/* 导出：PNG / .excalidraw 收进小菜单 */}
          <button
            className={"mm-cap-btn bb-view-only cap-export" + (capMenuOpen ? " active" : "")}
            title="导出白板"
            onClick={() => setCapMenuOpen(v => !v)}
          >
            <Ic p={ICONS.save} />
            <span>导出</span>
          </button>
          <button className="mm-cap-btn bb-view-only" title="在当前位置编辑这块白板" onClick={enterEdit}>
            <Ic p={ICONS.pencil} />
            <span>编辑</span>
          </button>
          <button className="mm-cap-btn bb-view-only" title="查看留言" onClick={toggleComments}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            <span>留言</span>
          </button>
          <button className="mm-cap-btn bb-view-only" title="白板信息" onClick={() => setInfoOpen(v => !v)}>
            <Ic p={ICONS.alert} />
            <span>信息</span>
          </button>
          {/* 编辑态：只留「保存」和「完成」 */}
          <button
            className="mm-cap-btn bb-edit-only cap-save"
            title="保存到服务器（Ctrl / ⌘ + S）"
            disabled={saving}
            onClick={() => save(false)}
          >
            <Ic p={ICONS.save} />
            <span>{saving ? "保存中" : "保存"}</span>
          </button>
          <button className="mm-cap-btn bb-edit-only" title="保存并退出编辑" onClick={finishEdit}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            <span>完成</span>
          </button>
          {/* 口令入口：仅设了口令且非管理员时显形 */}
          {meta?.hasKey && !isAdmin && (
            <button
              className="mm-cap-btn bb-edit-only cap-key show"
              title="输入编辑口令"
              onClick={toggleKeyBar}
            >
              <Ic p={ICONS.lock} />
              <span>口令</span>
            </button>
          )}
          {/* 导出菜单 */}
          <div className={"mm-cap-menu" + (capMenuOpen ? " open" : "")}>
            <button className="mm-cap-item bb-view-only" title="导出为 PNG 图片" onClick={() => { setCapMenuOpen(false); exportPng() }}>
              <Ic p={ICONS.image} />
              <span>PNG 图片</span>
            </button>
            <button className="mm-cap-item bb-view-only" title="导出为 .excalidraw 文件（可再次导入）" onClick={() => { setCapMenuOpen(false); exportScene() }}>
              <Ic p={ICONS.doc} />
              <span>.excalidraw 文件</span>
            </button>
          </div>
        </div>
      )}

      {/* 信息浮层（独立打开时自带；嵌入时点「信息」交给宿主页面） */}
      {showCapsule && infoOpen && (
        <div className="mm-info">
          <h4>{title}</h4>
          <div className="row"><span className="k">白板</span><span style={{ wordBreak: "break-all" }}>{note}</span></div>
          {meta?.rev != null && <div className="row"><span className="k">版本</span><span>rev {meta.rev}</span></div>}
          {meta?.hasKey && <div className="row"><span className="k">口令</span><span>已加密</span></div>}
        </div>
      )}
      {/* 留言抽屉：形态与导图一致（右侧滑出） */}
      <div className={"mm-drawer-scrim" + (cmtOpen ? " show" : "")} onClick={() => setCmtOpen(false)} />
      <aside className={"mm-drawer" + (cmtOpen ? " open" : "")}>
        <div className="mm-drawer-head">
          <span className="mm-drawer-title">留言{cmts && cmts.length ? <span className="cnt">（{cmts.length}）</span> : null}</span>
          <button className="mm-drawer-x" title="关闭" aria-label="关闭" onClick={() => setCmtOpen(false)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        </div>
        <div className="mm-drawer-body">
          {cmts === null ? (
            <div className="mm-cmt-empty">加载中…</div>
          ) : cmts.length === 0 ? (
            <div className="mm-cmt-empty">还没有留言</div>
          ) : (
            cmts.map((c, i) => (
              <div className="mm-cmt" key={c?.id || i}>
                <div className="mm-cmt-avatar">{String(c?.name || "客").trim().slice(0, 1) || "客"}</div>
                <div className="mm-cmt-main">
                  <div className="mm-cmt-top">
                    <span className="mm-cmt-name">{c?.name || "访客"}</span>
                    <span className="mm-cmt-time">{fmtTime(Number(c?.createdAt) || 0)}</span>
                  </div>
                  <div className="mm-cmt-text">{c?.content || ""}</div>
                  {c?.image ? <img className="mm-cmt-img" src={c.image} alt="留言图片" loading="lazy" /> : null}
                </div>
              </div>
            ))
          )}
        </div>
        <form
          className="mm-drawer-foot"
          onSubmit={e => {
            e.preventDefault()
            void submitComment()
          }}
        >
          <input value={cmtName} maxLength={32} placeholder="昵称 *" required onChange={e => setCmtName(e.target.value)} />
          <textarea
            value={cmtText}
            maxLength={5000}
            placeholder="写下你的留言… *（纯文本，最长 5000 字）"
            required
            onChange={e => setCmtText(e.target.value)}
          />
          <div className="row">
            <span className={"tip" + (cmtTip.includes("失败") || cmtTip.includes("出错") || cmtTip.includes("都要填") ? " err" : "")}>{cmtTip}</span>
            <button className="send" type="submit" disabled={cmtSending}>{cmtSending ? "发送中" : "发送"}</button>
          </div>
        </form>
      </aside>

      <div className="exc-canvas">
        <Excalidraw
          key={note + (editMode ? "edit" : "view")}
          excalidrawAPI={api => { apiRef.current = api }}
          onChange={(els: readonly any[]) => {
            // 画布指纹变化即视为有未保存改动；撤销回原状会自动恢复「已保存」态
            if (!Array.isArray(els)) return
            const f = sceneFp(els)
            if (f !== fpRef.current) {
              fpRef.current = f
              dirtyRef.current = true
            } else {
              dirtyRef.current = false
            }
          }}
          initialData={initialData}
          viewModeEnabled={!editMode}
          langCode="zh-CN"
          theme="light"
          UIOptions={
            !editMode
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
                    // 编辑模式：顶栏已移除，恢复库内导出/另存入口，便于导出 .excalidraw 备份
                    export: {}, // ExportOpts：启用库内导出菜单（顶栏已移除，便于导出备份）
                    saveToActiveFile: true,
                    loadScene: false,
                    saveAsImage: true,
                    toggleTheme: false,
                  },
                }
          }
        />
      </div>
      {/* 状态提示：顶部居中胶囊浮条（与导图一致），没有文案时自动隐藏 */}
      <div className={"mm-bar" + (msg ? " show" : "")}>
        <span className="mm-msg">{msg}</span>
      </div>
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
    const bare = el.dataset.bare === "1"
    const fromAdmin = new URLSearchParams(location.search).get("from") === "admin"
    const root = createRoot(el)
    // 记住 root，便于宿主清空/换画板时真正卸载（否则旧实例的 window 级监听会残留）
    ;(el as any).__excRoot = root
    root.render(<NoteApp note={note} mode={mode} bare={bare} fromAdmin={fromAdmin} />)
  })
}

/**
 * 卸载编辑器实例：传元素只卸载该容器，不传则卸载全部。
 * 卸载后容器会被清空、mounted 标记被移除，宿主可安全重建 DOM 或再次 ExcalidrawMount()。
 */
function unmountAll(target?: HTMLElement) {
  const els = target ? [target] : Array.from(document.querySelectorAll<HTMLElement>("[data-excalidraw]"))
  els.forEach(el => {
    const root = (el as any).__excRoot
    if (root) {
      try {
        root.unmount()
      } catch {
        /* 已经卸载过 */
      }
      delete (el as any).__excRoot
    }
    delete el.dataset.mounted
    el.innerHTML = ""
  })
  // 没有挂载中的实例时，清掉全局保存钩子，避免宿主误用已卸载的实例
  if (!document.querySelector("[data-excalidraw][data-mounted]")) {
    delete (window as any).__excalidrawSave
    delete (window as any).__excalidrawDirty
  }
}

;(window as any).ExcalidrawMount = mountAll
;(window as any).ExcalidrawUnmount = unmountAll

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountAll)
} else {
  mountAll()
}
