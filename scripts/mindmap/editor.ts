/**
 * 思维导图编辑器（供 mindmap.html 使用）
 *
 * 职责：
 *   - 按 URL 参数（note / edit）加载或新建导图
 *   - 只读/编辑两种模式（编辑模式需管理员，或笔记对外开放编辑且口令匹配）
 *   - 保存（乐观锁 baseRev；冲突时提示覆盖）、导出 PNG / SVG / JSON
 *   - 暴露 window.__mindmapSave / __mindmapDirty 给宿主页（后台编辑页 iframe 调用）
 *
 * 与白板编辑器（scripts/excalidraw/editor.tsx）保持同一套约定：
 *   接口 /api/mindmap、口令来自 localStorage.admin_key 或页面输入、
 *   admin_key 缺失时不带 editKey（由服务端判定权限）。
 */
import MindElixir, { DARK_THEME } from "mind-elixir"

/** 右键菜单/工具栏文案（取自库自带 dist/i18n.js 的 zh_CN；该文件未在 package exports 中，无法直接 import） */
const zhCN = {
  addChild: "插入子节点",
  addParent: "插入父节点",
  addSibling: "插入同级节点",
  removeNode: "删除节点",
  focus: "专注",
  cancelFocus: "取消专注",
  moveUp: "上移",
  moveDown: "下移",
  link: "连接",
  linkBidirectional: "双向连接",
  clickTips: "请点击目标节点",
  summary: "摘要",
}

interface MapMeta {
  title?: string
  editable: 0 | 1
  hasKey: boolean
  rev: number
  updatedAt?: string
}

/** 供页面兜底诊断判断 bundle 是否加载成功 */
;(window as any).MindMapMount = () => {}

const root = document.getElementById("mm-root") as HTMLElement | null
if (root) {
  boot(root)
}

function boot(el: HTMLElement) {
  const note = el.dataset.note || ""
  const mode: "edit" | "view" = el.dataset.mode === "edit" ? "edit" : "view"

  // 深色主题：以官方 DARK_THEME 为底，换成博客的暖色调强调色
  const theme = {
    ...DARK_THEME,
    cssVar: {
      ...(DARK_THEME as any).cssVar,
      "--main-color": "#ff9f0a",
      "--main-bgcolor": "#141418",
      "--color": "#e8e8ea",
      "--bgcolor": "#0b0b0e",
      "--selected": "#2a2113",
      "--panel-color": "#e8e8ea",
      "--panel-bgcolor": "#18181c",
      "--panel-border-color": "rgba(255,255,255,.14)",
    },
  } as any

  // MindElixir 只接受 HTMLDivElement / 选择器字符串，而且会清空该容器：
  // 这里自建一层干净 div 交给它，外层 el 留给浮条等 UI，互不干扰。
  const canvasHost = document.createElement("div")
  // 注意：MindElixir 构造时会执行 el.style.position = "relative"（内联样式），
  // 因此定位必须靠 .mm-canvas-host 的 !important 规则，否则容器高度会塌成内容高度。
  canvasHost.className = "mm-canvas-host"
  el.appendChild(canvasHost)

  const mind = new MindElixir({
    el: canvasHost,
    direction: (MindElixir as any).SIDE ?? 2,
    editable: mode === "edit",
    // 文案本地化：库的顶层 locale 选项已弃用，改为传给 contextMenu / toolBar
    contextMenu: mode === "edit" ? ({ locale: zhCN } as any) : false,
    toolBar: mode === "edit" ? ({ locale: zhCN } as any) : false,
    keypress: mode === "edit",
    theme,
    overflowHidden: false,
    scaleSensitivity: 40,
    // 默认 alignment 是 "root"（按根节点居中）→ 内容会贴顶、下方留白；改为按整个导图内容居中
    alignment: "nodes",
    newTopicName: "新主题",
  } as any)

  let meta: MapMeta | null = null
  let loadedRev: number | null = null
  let dirty = false
  let saving = false

  /* ---------------- 浮条 UI ---------------- */
  const bar = document.createElement("div")
  bar.className = "mm-bar"
  const msgEl = document.createElement("span")
  msgEl.className = "mm-msg"
  bar.appendChild(msgEl)

  const btn = (text: string, cls: string, onClick: () => void) => {
    const b = document.createElement("button")
    b.className = "mm-btn" + (cls ? " " + cls : "")
    b.textContent = text
    b.addEventListener("click", onClick)
    bar.appendChild(b)
    return b
  }

  if (mode === "edit") {
    btn("保存", "primary", () => void save(false))
    btn("导出 PNG", "", () => void exportImage("png"))
    btn("导出 SVG", "", () => void exportImage("svg"))
    btn("导出 JSON", "", () => exportJson())
  } else {
    btn("导出 PNG", "", () => void exportImage("png"))
    btn("导出 JSON", "", () => exportJson())
  }
  el.appendChild(bar)

  let msgTimer: number | null = null
  function setMsg(text: string, sticky = false) {
    msgEl.textContent = text
    if (msgTimer) window.clearTimeout(msgTimer)
    if (!sticky) msgTimer = window.setTimeout(() => (msgEl.textContent = ""), 6000)
  }

  /* ---------------- 口令浮条 ---------------- */
  let editKey = ""
  let keyInput: HTMLInputElement | null = null
  function mountKeyBar() {
    if (keyInput || mode !== "edit") return
    const wrap = document.createElement("div")
    wrap.className = "mm-key"
    const label = document.createElement("span")
    label.textContent = "编辑口令"
    keyInput = document.createElement("input")
    keyInput.type = "password"
    keyInput.placeholder = "输入后点击保存"
    keyInput.value = editKey
    keyInput.addEventListener("input", () => {
      editKey = keyInput ? keyInput.value : ""
    })
    wrap.appendChild(label)
    wrap.appendChild(keyInput)
    el.appendChild(wrap)
  }
  function updateKeyBar() {
    if (meta && meta.hasKey && !isAdmin()) mountKeyBar()
  }

  function isAdmin(): boolean {
    try {
      return !!localStorage.getItem("admin_key")
    } catch {
      return false
    }
  }

  /* ---------------- 加载 ---------------- */
  async function load() {
    setMsg("加载中…", true)
    try {
      const res = await fetch(`/api/mindmap?id=${encodeURIComponent(note)}`, { cache: "no-store" })
      const d = await res.json().catch(() => ({}))
      const missing = !res.ok || d.status !== "success" || d.code === "not_found"
      if (missing) {
        meta = null
        loadedRev = 0
        mind.init(emptyData())
        scheduleFit(200)
        if (mode === "edit") {
          setMsg(isAdmin() ? "新导图：直接编辑并保存即可创建" : "新导图：仅管理员可创建（请先登录后台）")
        }
        return
      }
      meta = d.meta || null
      loadedRev = meta?.rev ?? null
      mind.init(d.data || emptyData())
      // 加载完成后自适应铺满可视区（只读与编辑模式都适用）
      fitView()
      scheduleFit(320)
      updateKeyBar()
      setMsg("")
    } catch (e: any) {
      setMsg("加载失败：" + (e?.message || e))
    }
  }

  function emptyData() {
    return {
      nodeData: {
        id: "root",
        topic: "中心主题",
        children: [{ id: "n1", topic: "分支主题", children: [] }],
      },
    }
  }

  /* ---------------- 保存 ---------------- */
  async function save(force: boolean): Promise<boolean> {
    if (mode !== "edit" || saving) return false
    flushOutline() // 面板里可能还有未生效的改动
    saving = true
    setMsg("保存中…", true)
    try {
      const data = mind.getData()
      const body: any = { data, baseRev: loadedRev ?? 0 }
      if (meta?.hasKey && !isAdmin()) body.editKey = keyInput ? keyInput.value : editKey
      if (force) body.force = 1

      const res = await fetch(`/api/mindmap?id=${encodeURIComponent(note)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (res.status === 409) {
        setMsg("检测到他人更新，正在以当前内容覆盖…")
        saving = false
        return save(true)
      }
      if (!res.ok || d.status !== "success") {
        setMsg(d.message || `保存失败（${res.status}）`)
        return false
      }
      loadedRev = d.rev ?? loadedRev
      if (meta) meta.rev = d.rev ?? meta.rev
      dirty = false
      setMsg(`已保存 rev ${d.rev}（${new Date().toLocaleTimeString()}）`)
      return true
    } catch (e: any) {
      setMsg("保存出错：" + (e?.message || e))
      return false
    } finally {
      saving = false
    }
  }

  /* ---------------- 导出 ---------------- */
  async function exportImage(kind: "png" | "svg") {
    try {
      const blob = kind === "png" ? await (mind as any).exportPng() : (mind as any).exportSvg()
      if (!blob) {
        setMsg("导出失败（浏览器不支持）")
        return
      }
      download(blob, `${fileNameBase()}.${kind}`)
    } catch (e: any) {
      setMsg("导出失败：" + (e?.message || e))
    }
  }
  function exportJson() {
    try {
      const blob = new Blob([JSON.stringify(mind.getData(), null, 2)], { type: "application/json" })
      download(blob, `${fileNameBase()}.json`)
    } catch (e: any) {
      setMsg("导出失败：" + (e?.message || e))
    }
  }
  function fileNameBase() {
    const t = (meta?.title || note || "mindmap").replace(/[\\/:*?"<>|]/g, "_")
    return t.slice(0, 40)
  }
  function download(blob: Blob, name: string) {
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }

  /* ---------------- 大纲按钮：图标形式，与库左下工具栏并列 ---------------- */
  function mountOutlineButton() {
    if (mode !== "edit") return
    const ltBar = el.querySelector(".mind-elixir-toolbar.lt")
    if (!ltBar || ltBar.querySelector(".mm-outline-btn")) return
    const b = document.createElement("button") as HTMLButtonElement
    b.type = "button"
    b.className = "mm-outline-btn"
    b.title = "大纲（左侧写大纲，右侧实时成图）"
    b.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="9" y1="6" x2="21" y2="6"></line>' +
      '<line x1="9" y1="12" x2="21" y2="12"></line>' +
      '<line x1="9" y1="18" x2="21" y2="18"></line>' +
      '<circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none"></circle>' +
      '<circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"></circle>' +
      '<circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none"></circle>' +
      "</svg>"
    b.addEventListener("click", (e) => {
      e.stopPropagation()
      toggleOutline()
    })
    ltBar.appendChild(b)
    outlineBtnEl = b
  }

  /* ---------------- 视野适配：内容自适应铺满可视区 ---------------- */
  // 内容较小时导图会缩在中间显得"没铺满"，这里在关键时机自动居中并缩放到合适大小
  function fitView() {
    const host = canvasHost
    const w = host.clientWidth
    const h = host.clientHeight
    const canvas = host.querySelector(".map-canvas") as HTMLElement | null
    if (!canvas) return
    try {
      ;(mind as any).scaleFit() // 先让库定缩放比例
    } catch {
      /* 忽略 */
    }
    const scale = Number((mind as any).scaleVal) || 1
    const cw = canvas.offsetWidth * scale
    const ch = canvas.offsetHeight * scale
    if (!w || !h || !cw || !ch) return
    // 直接用容器与内容的真实尺寸居中：水平与垂直都留出均等留白
    const tx = Math.max(0, Math.round((w - cw) / 2))
    const ty = Math.max(0, Math.round((h - ch) / 2))
    canvas.style.transformOrigin = "0 0"
    canvas.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`
  }
  let fitTimer: number | null = null
  function scheduleFit(delay = 260) {
    if (fitTimer) window.clearTimeout(fitTimer)
    fitTimer = window.setTimeout(fitView, delay)
  }
  window.addEventListener("resize", () => scheduleFit(200))

  /* ---------------- 大纲面板：左写大纲、右实时成图 ---------------- */
  // 面板默认关闭；打开时导图区让出宽度，右侧实时刷新
  let panelOpen = false
  let outlineEl: HTMLElement | null = null
  let outlineText: HTMLTextAreaElement | null = null

  let uid = 0
  const nextId = () => "n" + ++uid

  /** 大纲文本 → 导图数据：支持「# 标题」与「缩进的 - / * / 纯文本」两种写法 */
  function outlineToData(text: string): any {
    const root: any = { id: "root", topic: "", children: [] }
    const stack: Array<{ level: number; node: any }> = []
    let isFirst = true
    const push = (level: number, topic: string) => {
      const node = { id: nextId(), topic, children: [] }
      if (isFirst) {
        root.topic = topic
        isFirst = false
        stack.length = 0
        stack.push({ level: 0, node: root })
        return
      }
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
      const parent = stack.length ? stack[stack.length - 1].node : root
      parent.children.push(node)
      stack.push({ level, node })
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+$/, "")
      if (!line.trim()) continue
      const heading = line.match(/^(#{1,6})\s*(.+)$/)
      if (heading) {
        push(heading[1].length, heading[2].trim())
        continue
      }
      const indentMatch = line.match(/^(\s*)/)
      const indent = (indentMatch ? indentMatch[1].replace(/\t/g, "  ") : "").length
      const topic = line.trim().replace(/^([-*+]\s+)+/, "").trim()
      if (!topic) continue
      push(Math.floor(indent / 2) + 2, topic)
    }
    if (!root.topic) root.topic = "中心主题"
    if (!root.children.length) root.children.push({ id: nextId(), topic: "分支主题", children: [] })
    return { nodeData: root }
  }

  /** 导图 → 大纲文本（用缩进列表，方便直接编辑；也兼容 Markdown 列表） */
  function dataToOutline(data: any): string {
    const lines: string[] = []
    const walk = (node: any, depth: number) => {
      const topic = String(node?.topic ?? "").replace(/\r?\n/g, " ")
      if (depth === 0) lines.push(topic)
      else lines.push("  ".repeat(depth - 1) + "- " + topic)
      ;(node?.children || []).forEach((c: any) => walk(c, depth + 1))
    }
    walk(data?.nodeData ?? data, 0)
    return lines.join("\n")
  }

  let flushTimer: number | null = null
  let dirtyOutline = false
  function applyOutline() {
    if (!outlineText) return
    dirtyOutline = false
    try {
      mind.refresh(outlineToData(outlineText.value))
      dirty = true
      scheduleFit(60) // 内容变了，重新居中
      setMsg("已按大纲更新导图")
    } catch (e: any) {
      setMsg("大纲解析失败：" + (e?.message || e))
    }
  }
  function scheduleApply() {
    dirtyOutline = true
    if (flushTimer) window.clearTimeout(flushTimer)
    flushTimer = window.setTimeout(() => applyOutline(), 350)
  }
  function flushOutline() {
    if (flushTimer) { window.clearTimeout(flushTimer); flushTimer = null }
    if (dirtyOutline) applyOutline()
  }

  function buildOutline() {
    if (outlineEl) return
    outlineEl = document.createElement("div")
    outlineEl.className = "mm-outline"
    outlineEl.innerHTML =
      '<div class="mm-outline-head">' +
      '<span class="mm-outline-title">大纲</span>' +
      '<span class="mm-outline-tip">每行一项，缩进表示层级；改动实时成图</span>' +
      '<button class="mm-btn" data-act="sync" title="用当前导图内容覆盖大纲">从导图刷新</button>' +
      '<button class="mm-btn" data-act="close">关闭</button>' +
      "</div>" +
      '<textarea class="mm-outline-text" spellcheck="false" placeholder="中心主题&#10;- 分支一&#10;  - 子节点"></textarea>'
    el.appendChild(outlineEl)
    outlineText = outlineEl.querySelector(".mm-outline-text") as HTMLTextAreaElement
    outlineText.addEventListener("input", scheduleApply)
    outlineText.addEventListener("blur", flushOutline)
    outlineEl.addEventListener("click", (e) => {
      const t = e.target as HTMLElement
      const act = t && t.dataset ? t.dataset.act : ""
      if (act === "close") setOutlineOpen(false)
      if (act === "sync") {
        outlineText!.value = dataToOutline(mind.getData())
        setMsg("已用导图内容刷新大纲")
      }
    })
  }

  let outlineBtnEl: HTMLButtonElement | null = null
  function setOutlineOpen(open: boolean) {
    buildOutline()
    panelOpen = open
    outlineEl!.classList.toggle("open", open)
    if (outlineBtnEl) {
      outlineBtnEl.classList.toggle("active", open)
      outlineBtnEl.title = open ? "关闭大纲（左侧写大纲，右侧实时成图）" : "大纲（左侧写大纲，右侧实时成图）"
    }
    // 导图区让出左侧空间（右侧实时成图）
    canvasHost.classList.toggle("outline-open", open)
    scheduleFit(320) // 可用宽度变了，重新居中并缩放
    if (open && outlineText) {
      outlineText.value = dataToOutline(mind.getData())
      setTimeout(() => outlineText!.focus(), 80)
    }
    try {
      localStorage.setItem("mindmap_outline_open", open ? "1" : "0")
    } catch {
      /* 忽略 */
    }
  }
  function toggleOutline() {
    setOutlineOpen(!panelOpen)
  }

  /* ---------------- 交互 ---------------- */
  // Ctrl/Cmd + S 保存
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault()
      void save(false)
    }
  })

  // 变更标记（用于宿主页询问是否保存）
  try {
    ;(mind as any).bus?.addListener?.("operation", () => {
      dirty = true
    })
  } catch {
    /* 忽略 */
  }
  ;(window as any).__mindmapSave = () => save(false)
  ;(window as any).__mindmapDirty = () => dirty
  ;(window as any).MindMapInstance = mind

  mountOutlineButton()
  void load()
  // 面板默认关闭；上次开着则恢复（仅编辑模式）
  if (mode === "edit") {
    try {
      if (localStorage.getItem("mindmap_outline_open") === "1") setOutlineOpen(true)
    } catch {
      /* 忽略 */
    }
  }
}
