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
  let mode: "edit" | "view" = el.dataset.mode === "edit" ? "edit" : "view"
  // 被 iframe 嵌入（前台文章页 or 后台编辑页）：返回 / 留言 / 信息要通知父页面
  const embedded = window.parent !== window
  // 后台编辑页内嵌的实例：它顶栏已有一整套按钮，这里不再重复给「返回」
  const fromAdmin = new URLSearchParams(location.search).get("from") === "admin"

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
    // 关键：工具条和右键菜单只在 init() 时按这里的开关创建，之后改属性不会补建。
    // 所以必须无条件注册（哪怕当前是只读），否则「查看 → 点编辑」切过来时
    // 工具条和右键菜单根本不存在，表现就是「编辑了但什么都不能动」。
    // 中文文案：库的顶层 locale 已弃用，改为传给 contextMenu / toolBar。
    contextMenu: {
      locale: zhCN,
      // 与库自带菜单项同构：name 显示文案、key 提示快捷键、onclick 直接调
      extend: [
        { name: "插入图片", key: "", onclick: () => void pickImage() },
        { name: "移除图片", key: "", onclick: () => removeImageFromSelection() },
      ],
    } as any,
    toolBar: { locale: zhCN } as any,
    keypress: true,
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
  // 状态提示（保存结果 / 大纲变化）放在顶部，导出按钮已全部移入底部胶囊
  el.appendChild(bar)

  /* ---------- 底部居中胶囊：仅导图页/前台文章页需要；后台内嵌不渲染 ---------- */
  const capsule = document.createElement("div")
  capsule.className = "mm-capsule"
  const capBtn = (cls: string, title: string, svg: string, text: string, onClick: () => void) => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = "mm-cap-btn" + (cls ? " " + cls : "")
    b.title = title
    b.innerHTML = svg + "<span>" + text + "</span>"
    b.addEventListener("click", onClick)
    capsule.appendChild(b)
    return b
  }
  const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10.5 9-7.5 9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>'
  const ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/></svg>'
  const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'
  const ICON_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
  const ICON_COMMENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  const ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".4" fill="currentColor"/></svg>'
  const ICON_KEY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>'
  const ICON_OUTLINE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>'
  const ICON_SAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg>'

  // 返回：放胶囊最左边。文章页嵌入 → 请宿主回上一级；独立打开 → 自己回上一级（history.back）。
  // （后台内嵌时整条胶囊都不渲染，各按钮照常构建即可，不必单独判断）
  capBtn("bb-view-only cap-back", "返回上一页", ICON_BACK, "返回", () => {
    if (embedded) tell("back")
    else goBack()
  })
  // 导出：多个格式收进一个「导出」按钮，点开小菜单选择（只读态）
  const exportBtn = capBtn("bb-view-only cap-export", "导出导图", ICON_DL, "导出", () => toggleExportMenu())
  capBtn("bb-view-only", "在当前位置编辑这张导图", ICON_EDIT, "编辑", () => setMode("edit"))
  // 编辑态只留「保存」和「完成」：大纲按钮挪进库工具条（和库自带图标同一排），
  // 留言/信息/返回/导出在编辑时全部收起，跟白板的编辑态一致。
  const capSaveBtn = capBtn("bb-edit-only cap-save", "保存到服务器（Ctrl / ⌘ + S）", ICON_SAVE, "保存", () => void save(false))
  capBtn("bb-edit-only", "保存并退出编辑", ICON_DONE, "完成", () => void finishEditing())
  // 只有「这张导图真的设了口令」才显形，所以单独持有引用
  const capKeyBtn = capBtn("bb-edit-only cap-key", "输入编辑口令", ICON_KEY, "口令", () => toggleKeyBar())
  if (embedded) {
    capBtn("bb-view-only", "查看留言", ICON_COMMENT, "留言", () => toggleDrawer())
    capBtn("bb-view-only", "导图信息", ICON_INFO, "信息", () => tell("info"))
  }
  capsule.classList.toggle("is-edit", mode === "edit")

  // 导出菜单：绝对定位在胶囊正上方（放 capsule 内部，随胶囊一起定位）
  const exportMenu = document.createElement("div")
  exportMenu.className = "mm-cap-menu"
  const ICON_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="m4 17 4.5-4.5L13 17l3-3 4 4"/></svg>'
  const ICON_VEC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h5"/><circle cx="4" cy="4" r="1.8"/><path d="M4 20h5"/><circle cx="4" cy="20" r="1.8"/><path d="M14 12h7"/><circle cx="20" cy="12" r="1.8"/><path d="M5.6 5.2 18.4 11"/><path d="M5.6 18.8 18.4 13"/></svg>'
  const ICON_JSON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6c-2 0-2.5 1-2.5 3S6 12 4.5 12C6 12 6.5 13 6.5 15s.5 3 2.5 3"/><path d="M15 6c2 0 2.5 1 2.5 3S18 12 19.5 12C18 12 17.5 13 17.5 15s-.5 3-2.5 3"/></svg>'
  const menuItem = (icon: string, title: string, text: string, cls: string, onClick: () => void) => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = "mm-cap-item" + (cls ? " " + cls : "")
    b.title = title
    b.innerHTML = icon + "<span>" + text + "</span>"
    b.addEventListener("click", () => {
      setExportMenu(false)
      onClick()
    })
    exportMenu.appendChild(b)
  }
  menuItem(ICON_IMG, "导出为 PNG 图片（位图，适合分享）", "PNG 图片", "", () => void exportImage("png"))
  menuItem(ICON_VEC, "导出为 SVG 矢量图（可继续编辑放大）", "SVG 矢量图", "bb-edit-only", () => void exportImage("svg"))
  menuItem(ICON_JSON, "导出为 JSON 数据（可再次导入）", "JSON 数据", "", () => exportJson())
  capsule.appendChild(exportMenu)

  let exportOpen = false
  function setExportMenu(open: boolean) {
    exportOpen = open
    exportMenu.classList.toggle("open", open)
    exportBtn.classList.toggle("active", open)
  }
  function toggleExportMenu() {
    setExportMenu(!exportOpen)
  }
  // 点别处或按 Esc 收起菜单
  document.addEventListener("click", (e) => {
    if (!exportOpen) return
    const t = e.target as Node | null
    if (t && (capsule.contains(t) || exportMenu.contains(t))) return
    setExportMenu(false)
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setExportMenu(false)
  })

  // 后台编辑页内嵌时不要这条胶囊：它顶栏已经有新建/新窗口/只读/口令/发布一整套按钮，
  // 「保存」由宿主顶栏调用 window.__mindmapSave()，这里再放一排是重复的。
  if (!fromAdmin) el.appendChild(capsule)

  /* ---------- 退出编辑确认弹层（「完成」时若还有未保存改动） ---------- */
  const dlg = document.createElement("div")
  dlg.className = "mm-dlg"
  dlg.innerHTML =
    '<div class="mm-dlg-card">' +
    '<div class="mm-dlg-title">退出编辑</div>' +
    '<div class="mm-dlg-sub">还有改动没写进服务器。可以先保存，或者直接放弃这些改动。</div>' +
    '<div class="mm-dlg-btns">' +
    '<button class="mm-dlg-btn primary" data-act="save">保存并退出</button>' +
    '<button class="mm-dlg-btn" data-act="discard">不保存，直接退出</button>' +
    '<button class="mm-dlg-btn" data-act="cancel">取消</button>' +
    "</div>" +
    '<div class="mm-dlg-err"></div>' +
    "</div>"
  el.appendChild(dlg)
  const dlgErr = dlg.querySelector(".mm-dlg-err") as HTMLElement
  function closeDlg() {
    dlg.classList.remove("show")
    dlgErr.classList.remove("show")
    dlgErr.textContent = ""
  }
  dlg.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null
    const act = (t?.closest("[data-act]") as HTMLElement | null)?.dataset.act || ""
    if (!act) return
    if (act === "cancel") {
      closeDlg()
      return
    }
    if (act === "discard") {
      closeDlg()
      setMode("view")
      return
    }
    void (async () => {
      const ok = await save(false)
      if (ok) {
        closeDlg()
        setMode("view")
      } else {
        dlgErr.textContent = "保存失败，改动还在。可以重试，或选「不保存，直接退出」。"
        dlgErr.classList.add("show")
      }
    })()
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dlg.classList.contains("show")) closeDlg()
  })

  /** 点「完成」：有未保存改动先问一句，避免默默丢掉 */
  async function finishEditing() {
    if (mode !== "edit") return
    flushOutline()
    if (!dirty) {
      setMode("view")
      return
    }
    dlgErr.textContent = ""
    dlgErr.classList.remove("show")
    dlg.classList.add("show")
  }

  /* ---------------- 留言抽屉（形态与白板一致：右侧滑出） ---------------- */
  const drawerScrim = document.createElement("div")
  drawerScrim.className = "mm-drawer-scrim"
  const drawer = document.createElement("aside")
  drawer.className = "mm-drawer"
  drawer.innerHTML =
    '<div class="mm-drawer-head">' +
    '<span class="mm-drawer-title">留言<span class="cnt" id="mmCmtCount"></span></span>' +
    '<button class="mm-drawer-x" data-mm-close="1" title="关闭" aria-label="关闭">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>' +
    "</button>" +
    "</div>" +
    '<div class="mm-drawer-body" id="mmCmtList"><div class="mm-cmt-empty">加载中…</div></div>' +
    '<form class="mm-drawer-foot" id="mmCmtForm">' +
    '<input id="mmCmtName" maxlength="32" placeholder="昵称 *" required>' +
    '<textarea id="mmCmtText" maxlength="5000" placeholder="写下你的留言… *（纯文本，最长 5000 字）" required></textarea>' +
    '<div class="row"><span class="tip" id="mmCmtTip"></span>' +
    '<button class="send" type="submit" id="mmCmtSend">发送</button></div>' +
    "</form>"
  el.appendChild(drawerScrim)
  el.appendChild(drawer)
  const cmtList = drawer.querySelector("#mmCmtList") as HTMLElement
  const cmtForm = drawer.querySelector("#mmCmtForm") as HTMLFormElement
  const cmtName = drawer.querySelector("#mmCmtName") as HTMLInputElement
  const cmtText = drawer.querySelector("#mmCmtText") as HTMLTextAreaElement
  const cmtTip = drawer.querySelector("#mmCmtTip") as HTMLElement
  const cmtSend = drawer.querySelector("#mmCmtSend") as HTMLButtonElement
  const cmtCount = drawer.querySelector("#mmCmtCount") as HTMLElement
  let cmtLoaded = false

  const esc = (s: any) =>
    String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

  function fmtTime(ts: number): string {
    try {
      const d = new Date(ts)
      const p = (n: number) => String(n).padStart(2, "0")
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    } catch {
      return ""
    }
  }

  function renderComments(list: any[]) {
    cmtCount.textContent = list.length ? `（${list.length}）` : ""
    if (!list.length) {
      cmtList.innerHTML = '<div class="mm-cmt-empty">还没有留言</div>'
      return
    }
    cmtList.innerHTML = list
      .map((c) => {
        const name = esc(c?.name || "访客")
        const initial = esc(String(c?.name || "客").trim().slice(0, 1) || "客")
        const img = c?.image ? `<img class="mm-cmt-img" src="${esc(c.image)}" alt="留言图片" loading="lazy">` : ""
        return (
          '<div class="mm-cmt">' +
          `<div class="mm-cmt-avatar">${initial}</div>` +
          '<div class="mm-cmt-main">' +
          `<div class="mm-cmt-top"><span class="mm-cmt-name">${name}</span><span class="mm-cmt-time">${esc(fmtTime(Number(c?.createdAt) || 0))}</span></div>` +
          `<div class="mm-cmt-text">${esc(c?.content || "")}</div>` +
          img +
          "</div></div>"
        )
      })
      .join("")
  }

  async function loadComments() {
    try {
      const res = await fetch(`/api/comments?postId=${encodeURIComponent(note)}`, { cache: "no-store" })
      const d = await res.json().catch(() => ({}))
      renderComments(Array.isArray(d?.comments) ? d.comments : [])
    } catch (e: any) {
      cmtList.innerHTML = '<div class="mm-cmt-empty">留言加载失败</div>'
    }
  }

  function setDrawerOpen(open: boolean) {
    drawer.classList.toggle("open", open)
    drawerScrim.classList.toggle("show", open)
    if (open) {
      if (!cmtLoaded) {
        cmtLoaded = true
        void loadComments()
      }
      try {
        cmtName.value = localStorage.getItem("comment_name") || cmtName.value
      } catch {
        /* 忽略 */
      }
    }
    // 通知父页面（嵌入时用于同步按钮状态）
    tell(open ? "comments-open" : "comments-close")
  }
  function toggleDrawer() {
    setDrawerOpen(!drawer.classList.contains("open"))
  }

  drawerScrim.addEventListener("click", () => setDrawerOpen(false))
  drawer.querySelector(".mm-drawer-x")?.addEventListener("click", () => setDrawerOpen(false))
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer.classList.contains("open")) setDrawerOpen(false)
  })

  cmtForm.addEventListener("submit", async (e) => {
    e.preventDefault()
    const name = cmtName.value.trim()
    const content = cmtText.value.trim()
    if (!name || !content) {
      cmtTip.textContent = "昵称和内容都要填"
      cmtTip.classList.add("err")
      return
    }
    cmtSend.disabled = true
    cmtTip.classList.remove("err")
    cmtTip.textContent = "发送中…"
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: note, name, content }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.status !== "success") {
        cmtTip.textContent = d.message || `发送失败（${res.status}）`
        cmtTip.classList.add("err")
        return
      }
      try {
        localStorage.setItem("comment_name", name)
      } catch {
        /* 忽略 */
      }
      cmtText.value = ""
      cmtTip.textContent = "留言成功"
      await loadComments()
    } catch (err: any) {
      cmtTip.textContent = "发送出错：" + (err?.message || err)
      cmtTip.classList.add("error")
    } finally {
      cmtSend.disabled = false
    }
  })

  // 宿主页面（文章页/后台）让它打开抽屉
  window.addEventListener("message", (e: MessageEvent) => {
    const d: any = e.data || {}
    if (d.type === "mindmap-open-comments") setDrawerOpen(true)
  })

  /** 返回上一级：有来路就 history.back（首页/列表不会重载），没有历史才回首页 */
  function goBack() {
    try {
      if (window.history.length > 1) {
        window.history.back()
        return
      }
    } catch {
      /* 忽略 */
    }
    location.href = "/"
  }

  function tell(action: string) {
    try {
      window.parent.postMessage({ type: "mindmap-stage", action, note }, "*")
    } catch {
      /* 忽略 */
    }
  }
  function reportMode() {
    try {
      window.parent.postMessage({ type: "mindmap-mode", mode }, "*")
    } catch {
      /* 忽略 */
    }
  }

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
      applyEditable() // 口令一填就能改（对错最终由保存时的服务端裁定）
    })
    wrap.appendChild(label)
    wrap.appendChild(keyInput)
    el.appendChild(wrap)
  }
  /** 导图设了口令、当前又不是管理员 → 编辑时自动滑出口令浮条（胶囊里不再放按钮，保持只有「保存/完成」） */
  function updateKeyBar() {
    if (locked() && !isAdmin() && mode === "edit") {
      mountKeyBar()
      const wrap = el.querySelector(".mm-key") as HTMLElement | null
      if (wrap && !wrap.classList.contains("open")) {
        wrap.classList.add("open")
        ;(wrap.querySelector("input") as HTMLInputElement | null)?.focus()
      }
    }
  }
  /** 口令浮条默认收起，点胶囊上的「口令」才展开 */
  function toggleKeyBar() {
    const wrap = el.querySelector(".mm-key") as HTMLElement | null
    if (!wrap) return
    const open = wrap.classList.toggle("open")
    if (open) (wrap.querySelector("input") as HTMLInputElement | null)?.focus()
  }

  /* ---------- 查看 / 编辑 双向切换 ---------- */
  // 关键：MindElixir 用实例属性 mind.editable 控制能否编辑（库内部大量 `if (!e.editable) return`），
  // 它只赋值不做别的副作用，运行时切换是安全的；再配合 DOM 层拦截做双保险。
  const MOD_KEYS = ["Delete", "Backspace", "Enter", "Tab", "F2", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
  el.addEventListener(
    "contextmenu",
    (e) => {
      if (mode === "view") e.stopPropagation()
    },
    true,
  )
  el.addEventListener(
    "keydown",
    (e) => {
      if (mode !== "view") return
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === "c" || e.key === "C")) return // 允许复制
      if (mod || MOD_KEYS.includes(e.key)) e.stopPropagation()
    },
    true,
  )

  function setMode(next: "edit" | "view") {
    if (next === mode) return
    const editing = next === "edit"
    setExportMenu(false) // 菜单里的 SVG 项在编辑态才出现，切模式先收起
    if (editing) {
      // 进入编辑：把待办的大纲改动丢掉重来，避免上面的旧文本盖掉导图
      dirtyOutline = false
      if (flushTimer) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
    } else {
      flushOutline() // 退出前把大纲里的改动落到导图上
    }
    mode = next
    el.dataset.mode = next
    capsule.classList.toggle("is-edit", editing)
    // 口令先准备好（applyEditable 要根据它判断权限）
    if (editing) mountKeyBar()
    applyEditable()
    if (editing) {
      // 切到编辑：工具条这时才显示，大纲图标要补挂一次（库工具条只在 init 时创建）
      mountOutlineButton()
      // 只有「加密导图还没给口令」这一种情况需要文字说明，其余不打扰
      if (locked() && !editKey) setMsg("此导图已加密：请先输入编辑口令")
    }
    // 大纲面板在两种模式下都能看；只读时只是改不了（readOnly 由 setOutlineOpen 按 mode 设置）
    if (outlineEl?.classList.contains("open")) setOutlineOpen(true)
    scheduleFit(280)
    reportMode()
  }

  /** 这张导图是否设了编辑口令 */
  function locked(): boolean {
    return !!meta?.hasKey
  }

  /**
   * 把编辑权限同步到库实例。库内部到处是 `if (!e.editable) return`（点节点不进编辑、
   * 右键菜单不弹、按键不增删），而库只暴露了 mind.editable 这一个开关
   * （下面的 enableEdit/disableEdit 挂在冻结的静态对象上、实例上并没有这两个方法），
   * 所以直接改它。load 会重建节点，因此 init 之后还要再调一次。
   */
  function applyEditable() {
    const editing = mode === "edit"
    // 加密导图在拿到口令前不给改（保存本来也会被服务端拒），避免白改一场
    const allowed = editing && (!locked() || !!editKey || isAdmin())
    try {
      ;(mind as any).editable = allowed
    } catch {
      /* 忽略 */
    }
    el.classList.toggle("mm-readonly", !allowed)
  }

  /** 后台登录后 localStorage 里存有 admin_key，带上它服务端才认管理员身份 */
  function authHeaders(): Record<string, string> {
    try {
      const k = localStorage.getItem("admin_key") || ""
      return k ? { "X-Admin-Key": k } : {}
    } catch {
      return {}
    }
  }

  function isAdmin(): boolean {
    try {
      return !!localStorage.getItem("admin_key")
    } catch {
      return false
    }
  }


  /* ---------------- 节点图片（插入时统一转 WebP，与原图同尺寸存服务器） ---------------- */
  // 存储端：尽量保留细节（原图压到 1600px 存 WebP，前台显示时再缩小，放大了也清楚）
  const MAX_IMAGE_EDGE = 1600
  const WEBP_QUALITY = 0.82
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024
  // 显示端：节点里图片的展示上限。库给节点里的 img 设了 object-fit:cover，
  // 尺寸一旦超过节点的 max-width(35em) 就会被裁掉，所以展示尺寸必须单独算小。
  const DISPLAY_MAX_W = 320
  const DISPLAY_MAX_H = 240

  /** 按展示上限等比缩放（只缩不放） */
  function displaySize(w: number, h: number) {
    const scale = Math.min(1, DISPLAY_MAX_W / Math.max(1, w), DISPLAY_MAX_H / Math.max(1, h))
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
  }
  const imageUrls = new Map<string, string>() // fid → blob URL（刷新后按需从服务器取回）

  const fileInput = document.createElement("input")
  fileInput.type = "file"
  fileInput.accept = "image/*"
  fileInput.style.display = "none"
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0]
    fileInput.value = ""
    if (f) addImage(f)
  })
  el.appendChild(fileInput)

  const nextFid = () => "img-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7)


  /** 从剪贴板里取图片（截图 / 复制的图片文件 / 复制的网页图片） */
  function pickImageFromClipboard(dt: DataTransfer | null): File | null {
    if (!dt) return null
    if (dt.items && dt.items.length) {
      for (const it of Array.from(dt.items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile()
          if (f) return f
        }
      }
    }
    if (dt.files && dt.files.length) {
      for (const f of Array.from(dt.files)) {
        if (f.type.startsWith("image/")) return f
      }
    }
    return null
  }

  /**
   * 粘贴即插图：复制图片（截图 / 右键复制图片）后直接 Ctrl+V。
   * 库里 paste 事件最后会调用 mind.pasteHandler（不处理返回值），所以在这里做副作用。
   */
  /** 是不是在可输入的地方（口令框等）——那里粘贴文字不能被我们拦掉 */
  function isTypingTarget(t: HTMLElement | null): boolean {
    if (!t) return false
    const tag = (t.tagName || "").toLowerCase()
    if (tag === "input") return true
    if (tag === "textarea") return !t.classList.contains("mm-outline-text") // 大纲面板要单独处理
    return !!(t as HTMLElement).isContentEditable
  }

  function onPaste(e: ClipboardEvent) {
    if (mode !== "edit") return
    // 剪贴板里没有图片就什么也不做（文字粘贴照常）
    const file = pickImageFromClipboard((e as any).clipboardData)
    if (!file) return
    // 注意顺序：先确认是「图片 + 可处理的目标」，再 preventDefault，
    // 否则口令输入框这类地方连文字都粘不进去
    const t = (e.target as HTMLElement | null) || null
    const inOutline = !!t && t.tagName.toLowerCase() === "textarea" && t.classList.contains("mm-outline-text")

    if (inOutline) {
      // 在大纲面板里粘贴：插到光标所在那一行对应的节点
      const line = outlineCaretLine(t as HTMLTextAreaElement)
      const node = nodeById(outlineLineNodeIds[line] || "")
      if (!node) {
        setMsg("没定位到大纲这一行的节点：把光标放到某一行内容上再粘贴")
        return
      }
      e.preventDefault()
      e.stopPropagation() // 别让库的粘贴处理再插手
      if (!stageImage(file, String(node.id))) setMsg("图片贴不上去，请重试")
      return
    }

    if (isTypingTarget(t)) return // 口令框等：不抢

    // 画布/节点上：优先用当前选中的节点；没选中就自动建一个节点来放图
    e.preventDefault()
    e.stopPropagation()
    const node = targetNodeForImage()
    const id = String(node?.id || "")
    if (!id) {
      setMsg("没找到可放置图片的节点")
      return
    }
    if (!stageImage(file, id)) setMsg("图片贴不上去，请重试")
  }

  function pickImage() {
    if (mode !== "edit") return
    fileInput.click()
  }

  /** 统一入口：选图 / 右键插入 / 粘贴都走这里（先贴上看，保存时再转 WebP 上传） */
  function addImage(file: File) {
    if (mode !== "edit") return
    const node = targetNodeForImage()
    const id = String(node?.id || "")
    if (!id) {
      setMsg("没找到可放置图片的节点")
      return
    }
    if (!stageImage(file, id)) setMsg("图片贴不上去，请重试")
  }

  /**
   * 选一个用来放图片的节点：
   * 优先当前选中的节点；没选中就自动在中心主题下建一个「图片」节点。
   * （粘贴图片时不必先手动选中，少一步操作）
   */
  function targetNodeForImage(): any | null {
    const cur = selectedNode()
    if (cur) return cur
    try {
      const mindAny = mind as any
      const root = mind.getData()?.nodeData
      if (!root) return null
      mindAny.selectNode?.(mindAny.findEle?.(root.id))
      mindAny.addChild?.() // 库会在当前节点下新建子节点并选中它
      return selectedNode()
    } catch {
      return null
    }
  }

  /** 选中节点：库的 currentNodes 就是当前选中的节点对象 */
  function selectedNode(): any | null {
    const cur = (mind as any).currentNodes
    const n = Array.isArray(cur) && cur.length ? cur[0] : null
    // nodeObj 是数据模型（与 getData 返回的是同一批对象）
    return n?.nodeObj || n || null
  }

  function removeImageFromSelection() {
    if (mode !== "edit") return
    const node = selectedNode()
    if (!node) {
      setMsg("先点选一个节点")
      return
    }
    if (!node.image) {
      setMsg("该节点没有图片")
      return
    }
    delete node.image
    ;(mind as any).refresh(mind.getData())
    dirty = true
    scheduleFit(80)
    setMsg("已移除图片")
  }

  function readFileAsImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(url)
        resolve(img)
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error("图片读取失败"))
      }
      img.src = url
    })
  }

  /** 压缩 + 转 WebP（保留透明通道），返回二进制与体积信息 */
  async function toWebp(img: HTMLImageElement) {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
    const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale))
    const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale))
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("浏览器不支持 canvas")
    ctx.drawImage(img, 0, 0, w, h)
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/webp", WEBP_QUALITY),
    )
    const out = blob && blob.type === "image/webp" ? blob : await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), "image/png"))
    if (!out) throw new Error("图片编码失败")
    return { blob: out, width: w, height: h, webp: out.type === "image/webp" }
  }

  async function uploadImage(blob: Blob, fid: string): Promise<void> {
    const res = await fetch(`/api/excalidraw?action=file&id=${encodeURIComponent(note)}&fid=${encodeURIComponent(fid)}`, {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream", ...authHeaders() },
      body: blob,
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok || d.status !== "success") {
      throw new Error(d.message || `上传失败（${res.status}）`)
    }
  }

  /* ---------- 图片：先贴上看，保存时统一转 WebP 并上传（与白板一致） ---------- */
  const pendingImages: Array<{ id: string; blob: Blob; name: string }> = []
  const pendingBlobUrl = new Map<string, string>()
  /** blob: 地址 → 原始文件（保存时用它做 WebP 转换） */
  const blobByUrl = new Map<string, Blob>()

  /** 把实时数据里所有 blob: 图片地址收集成待上传队列 */
  function collectPendingFromData(): number {
    const data = mind.getData() as any
    let added = 0
    const walk = (n: any) => {
      const u = n?.image?.url
      if (typeof u === "string" && u.startsWith("blob:")) {
        if (!pendingBlobUrl.has(u)) {
          const blob = blobByUrl.get(u)
          if (blob) {
            pendingBlobUrl.set(u, String(n.id))
            pendingImages.push({ id: String(n.id), blob, name: "paste" })
            added++
          }
        }
      }
      ;(n?.children || []).forEach(walk)
    }
    walk(data?.nodeData)
    return added
  }

  /**
   * 粘贴/选图后先只挂上本地图片（blob:），立刻能看到；
   * 真正的 WebP 转换与上传留到保存时统一做（与白板同一套节奏）。
   */
  function stageImage(file: File, targetId: string): boolean {
    try {
      const url = URL.createObjectURL(file)
      blobByUrl.set(url, file)
      const data = mind.getData() as any
      let hit: any = null
      const find = (n: any) => {
        if (!n || hit) return
        if (String(n.id) === targetId) {
          hit = n
          return
        }
        ;(n.children || []).forEach(find)
      }
      find(data?.nodeData)
      if (!hit) return false
      // 先按 320 宽、按需高度占位，取到真实尺寸后再校正
      hit.image = { url, width: 320, height: 200, fit: "contain" }
      ;(mind as any).refresh(data)
      dirty = true
      setMsg("图片已贴在导图上，保存时会统一转 WebP 并上传", true)
      // 异步读真实尺寸，顺便校正节点图片比例
      void readFileAsImage(file)
        .then((img) => {
          const shown = displaySize(img.naturalWidth || 1, img.naturalHeight || 1)
          const d2 = mind.getData() as any
          let h2: any = null
          const f2 = (n: any) => {
            if (!n || h2) return
            if (String(n.id) === targetId) {
              h2 = n
              return
            }
            ;(n.children || []).forEach(f2)
          }
          f2(d2?.nodeData)
          if (h2 && h2.image && h2.image.url === url) {
            h2.image.width = shown.width
            h2.image.height = shown.height
            ;(mind as any).refresh(d2)
          }
        })
        .catch(() => {
          /* 尺寸取不到就保持占位 */
        })
      return true
    } catch {
      return false
    }
  }

  /** 保存前统一处理：转 WebP → 上传 → 把地址换成 fid */
  async function flushPendingImages(): Promise<boolean> {
    collectPendingFromData()
    if (!pendingImages.length) return true
    const total = pendingImages.length
    const failed: string[] = []
    for (let i = 0; i < total; i++) {
      const it = pendingImages[i]
      setMsg(`图片转换上传 ${i + 1}/${total}…`, true)
      try {
        const img = await readFileAsImage(new File([it.blob], it.name, { type: it.blob.type }))
        const { blob } = await toWebp(img)
        if (blob.size > MAX_IMAGE_BYTES) throw new Error("图片过大（上限 5MB）")
        const fid = nextFid()
        await uploadImage(blob, fid)
        const data = mind.getData() as any
        let hit: any = null
        const find = (n: any) => {
          if (!n || hit) return
          if (String(n.id) === it.id) {
            hit = n
            return
          }
          ;(n.children || []).forEach(find)
        }
        find(data?.nodeData)
        if (hit && hit.image && typeof hit.image.url === "string" && hit.image.url.startsWith("blob:")) {
          const oldUrl = hit.image.url
          imageUrls.set(fid, oldUrl) // 已经能显示，不用重新拉
          hit.image.url = fid
          ;(mind as any).refresh(data)
        }
      } catch (e: any) {
        failed.push(it.id + "：" + (e?.message || e))
      }
    }
    pendingImages.length = 0
    pendingBlobUrl.clear()
    if (failed.length) {
      setMsg(`有 ${failed.length}/${total} 张图片没能上传：${failed.join("；")}`)
      return false
    }
    return true
  }

  async function insertImage(file: File, target?: any) {
    const targetId = String((target || selectedNode())?.id || "")
    if (!targetId) {
      setMsg("先点选一个节点，再插入图片")
      return
    }
    const kb = (n: number) => Math.round(n / 1024) + "KB"
    setMsg(`转换中…（原图 ${kb(file.size)}）`, true)
    let fid = ""
    try {
      // 先直接贴在导图上（blob:），转换与上传留到保存时统一做
      const targetIdForStage = targetId
      if (mode === "edit" && targetIdForStage && stageImage(file, targetIdForStage)) return
      const img = await readFileAsImage(file)
      const { blob, width, height, webp } = await toWebp(img)
      if (blob.size > MAX_IMAGE_BYTES) {
        setMsg(`图片过大（${Math.round(blob.size / 1048576 * 10) / 10}MB，上限 5MB）`)
        return
      }
      fid = nextFid()
      setMsg(`已转 WebP ${kb(file.size)} → ${kb(blob.size)}，上传中…`, true)
      await uploadImage(blob, fid)
      const shown = displaySize(width, height)
      const shownUrl = URL.createObjectURL(blob)
      imageUrls.set(fid, shownUrl)
      // 在实时数据里按 id 找到节点再挂图（改副本是不会生效的）
      const data = mind.getData() as any
      let hit: any = null
      const find = (n: any) => {
        if (!n || hit) return
        if (String(n.id) === targetId) {
          hit = n
          return
        }
        ;(n.children || []).forEach(find)
      }
      find(data?.nodeData)
      if (!hit) {
        setMsg("没找到目标节点（可能已被删除），图片未插入")
        return
      }
      hit.image = { url: fid, width: shown.width, height: shown.height, fit: "contain" }
      ;(mind as any).refresh(data)
      dirty = true
      scheduleFit(80)
      setMsg(`已插入图片：${shown.width}×${shown.height} · WebP ${kb(blob.size)}。记得保存导图（Ctrl+S）把图片引用一起存下来`)
      // 图片已在服务器上，但引用要保存导图才会写进数据
      if (mode === "edit") void save(false)
    } catch (e: any) {
      setMsg("图片插入失败：" + (e?.message || e))
    }
  }

  /** 节点里的图片 url 存的是 fid；显示前按需从服务器取回并换成 blob URL（浏览器会缓存） */
  async function resolveImageUrls(data: any) {
    const fids: string[] = []
    const walk = (n: any) => {
      const u = n?.image?.url
      if (typeof u === "string" && !u.startsWith("data:") && !u.startsWith("/") && !u.startsWith("http") && !u.startsWith("blob:")) {
        fids.push(u)
      }
      ;(n?.children || []).forEach(walk)
    }
    walk(data?.nodeData || data)
    const failed: string[] = []
    for (const fid of fids) {
      if (imageUrls.has(fid)) continue
      try {
        const res = await fetch(`/api/excalidraw?action=file&id=${encodeURIComponent(note)}&fid=${encodeURIComponent(fid)}`, { cache: "force-cache" })
        const d = await res.json().catch(() => ({}))
        const dataURL: string = d?.file?.dataURL || ""
        if (dataURL) imageUrls.set(fid, dataURL)
        else failed.push(fid)
      } catch {
        failed.push(fid)
      }
    }
    // 把 fid 换成可直接显示的地址（data: / blob:）
    let changed = false
    const apply = (n: any) => {
      const u = n?.image?.url
      if (typeof u === "string" && imageUrls.has(u)) {
        n.image.url = imageUrls.get(u) as string
        changed = true
      }
      ;(n?.children || []).forEach(apply)
    }
    apply(data?.nodeData || data)
    // 取不回来的（例如服务端没存上）：不要让它继续当 src 用，否则浏览器会去请求 img-xxx 而报 404
    if (failed.length) {
      const strip = (n: any) => {
        const u = n?.image?.url
        if (typeof u === "string" && failed.includes(u)) {
          // 留个占位，让缺图的位置看得出来，而不是一片空白或裂图
          n.image.url = "data:image/svg+xml;utf8," + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="90">' +
            '<rect width="240" height="90" rx="10" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.18)"/>' +
            '<text x="120" y="42" text-anchor="middle" fill="rgba(255,255,255,0.55)" font-size="13">图片未找到</text>' +
            '<text x="120" y="62" text-anchor="middle" fill="rgba(255,255,255,0.35)" font-size="10">' +
            String(u).slice(0, 30) + "</text></svg>",
          )
          imageUrls.set(u, n.image.url)
        }
        ;(n?.children || []).forEach(strip)
      }
      strip(data?.nodeData || data)
      setMsg(`有 ${failed.length} 张图片没取到（导图 ${note}）：${failed.join(", ")}`)
    }
    return changed
  }

  /* ---------------- 加载 ---------------- */
  async function load() {
    setMsg("加载中…", true)
    try {
      const res = await fetch(`/api/mindmap?id=${encodeURIComponent(note)}`, {
        cache: "no-store",
        headers: authHeaders(),
      })
      const d = await res.json().catch(() => ({}))
      const missing = !res.ok || d.status !== "success" || d.code === "not_found"
      if (missing) {
        meta = null
        loadedRev = 0
        mind.init(emptyData())
        applyEditable() // init 会重建节点，编辑开关要重新同步
        scheduleFit(200)
        if (mode === "edit") {
          setMsg(isAdmin() ? "新导图：直接编辑并保存即可创建" : "新导图：仅管理员可创建（请先登录后台）")
        }
        return
      }
      meta = d.meta || null
      loadedRev = meta?.rev ?? null
      // 节点图片存的是 fid，先取回来换成可显示地址，再交给库渲染
      await resolveImageUrls(d.data || {})
      mind.init(d.data || emptyData())
      applyEditable()
      // 加载完成后自适应铺满可视区（只读与编辑模式都适用）
      fitView()
      scheduleFit(320)
      updateKeyBar()
      mountOutlineButton()
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

  /** 保存前把显示用的地址（blob: / data:）还原成 fid，导图数据里只留引用 */
  function toStoredData() {
    const data = mind.getData()
    const walk = (n: any) => {
      const u = n?.image?.url
      if (typeof u === "string") {
        if (u.startsWith("blob:") || u.startsWith("data:")) {
          for (const [fid, shown] of imageUrls) {
            if (shown === u) {
              n.image.url = fid
              break
            }
          }
        }
      }
      ;(n?.children || []).forEach(walk)
    }
    walk(data?.nodeData || data)
    return data
  }

  /* ---------------- 保存 ---------------- */
  async function save(force: boolean): Promise<boolean> {
    if (mode !== "edit" || saving) return false
    flushOutline() // 面板里可能还有未生效的改动
    saving = true
    // 先把贴上的图片统一转 WebP 并上传（与白板同一套流程）
    const imagesOk = await flushPendingImages()
    setMsg("保存中…", true)
    if (!imagesOk) {
      saving = false
      return false
    }
    try {
      const data = toStoredData()
      const body: any = { data, baseRev: loadedRev ?? 0 }
      if (meta?.hasKey && !isAdmin()) body.editKey = keyInput ? keyInput.value : editKey
      if (force) body.force = 1

      const res = await fetch(`/api/mindmap?id=${encodeURIComponent(note)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
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

  /* ---------------- 大纲按钮：图标形式，与库左下工具栏并列（只读时也能看大纲） ---------------- */
  let outlineMountTries = 0
  function mountOutlineButton() {
    // 库的工具条可能带 lt/rb 等方向类，别只认 .lt（否则找不到就整排图标挂不上）
    const ltBar = (el.querySelector(".mind-elixir-toolbar.lt") ||
      el.querySelector(".mind-elixir-toolbar")) as HTMLElement | null
    if (!ltBar) {
      // 工具栏由库的 init() 挂入 DOM，构造后可能还没出现：稍后重试
      if (outlineMountTries < 60) {
        outlineMountTries++
        window.setTimeout(mountOutlineButton, 150)
      } else {
        console.warn("[导图] 未找到工具条，大纲按钮未挂载")
      }
      return
    }
    if (ltBar.querySelector(".mm-outline-btn")) return
    // 与库自带图标同结构：<span><svg class="icon">，尺寸/间距/对齐由库的样式统一负责
    const b = document.createElement("span")
    b.className = "mm-outline-btn"
    b.title = "大纲（左侧写大纲，右侧实时成图）"
    b.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="9" y1="6" x2="21" y2="6"></line>' +
      '<line x1="9" y1="12" x2="21" y2="12"></line>' +
      '<line x1="9" y1="18" x2="21" y2="18"></line>' +
      '<circle cx="4" cy="6" r="1.3" fill="currentColor" stroke="none"></circle>' +
      '<circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none"></circle>' +
      '<circle cx="4" cy="18" r="1.3" fill="currentColor" stroke="none"></circle>' +
      "</svg>"
    b.addEventListener("click", (e) => {
      e.stopPropagation()
      toggleOutline()
    })
    ltBar.appendChild(b)
    outlineBtnEl = b as unknown as HTMLButtonElement
  }

  /* ---------------- 视野适配：交给库自己 ---------------- */
  // 历史教训：自己给 .map-canvas 写 transform、或连调 scaleFit()+toCenter()，
  // 都会和库内部的缩放/位移/连线维护打架（scaleFit 改缩放后 toCenter 仍按旧尺寸算位移，
  // 连线也按旧坐标画）——表现为整体偏移、连线对不上节点。
  // 库在 init() 与 layout() 时会自己居中（alignment: "nodes" 会按内容居中），所以这里不干预。
  function fitView() {
    /* 有意留空：居中与缩放全部由 MindElixir 内部处理 */
  }
  let fitTimer: number | null = null
  function scheduleFit(delay = 260) {
    /* 有意留空：见上 */
    void delay
  }
  window.addEventListener("resize", () => scheduleFit(200))
  // 进退浏览器全屏时视口尺寸会变，必须重新适配，否则导图会偏到看不见
  const onViewportChange = () => {
    scheduleFit(260)
    // 大纲面板的内联尺寸也要跟着视口更新，否则全屏后会露出一截或超出
    if (outlineEl && panelOpen) positionOutlinePanel(outlineEl)
  }
  document.addEventListener("fullscreenchange", onViewportChange)
  document.addEventListener("webkitfullscreenchange", onViewportChange)
  window.addEventListener("resize", () => {
    if (outlineEl && panelOpen) positionOutlinePanel(outlineEl)
  })

  /* ---------------- 大纲面板：左写大纲、右实时成图 ---------------- */
  // 面板默认关闭；打开时导图区让出宽度，右侧实时刷新
  let panelOpen = false
  let outlineEl: HTMLElement | null = null
  let outlineText: HTMLTextAreaElement | null = null

  let uid = 0
  const nextId = () => "n" + ++uid

  /**
   * 大纲解析：把每一行折算成「相对层级」（根 0、一级分支 1……）
   * 三种写法都认：缩进（2 空格或 Tab 一级）、Markdown 列表符（- * + 1.）、# 标题。
   * 层级跳级也安全（逐级找父节点），不会丢行。
   */
  const OUTLINE_INDENT = "  "
  const OUTLINE_BULLET = "· "
  const BULLET_RE = /^\s*(?:[·•▪◦]|[-*+]|\d+[.)])\s+/

  function outlineToData(text: string): any {
    const root: any = { id: "root", topic: "", children: [] }
    const stack: Array<{ level: number; node: any }> = []
    let isFirst = true

    const add = (level: number, topic: string) => {
      if (!topic) return
      if (isFirst) {
        // 第一行永远是中心主题，无论是否带缩进 / 列表符
        root.topic = topic
        isFirst = false
        return
      }
      const node = { id: nextId(), topic, children: [] }
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
      const parent = stack.length ? stack[stack.length - 1].node : root
      parent.children.push(node)
      stack.push({ level, node })
    }

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+$/, "")
      if (!line.trim()) continue

      const heading = line.match(/^\s*#{1,6}\s*(.+)$/)
      if (heading) {
        const level = Math.max(0, (line.match(/^\s*(#{1,6})/) as RegExpMatchArray)[1].length - 1)
        add(level, heading[1].trim())
        continue
      }

      const indent = (line.match(/^[\t ]*/) as RegExpMatchArray)[0].replace(/\t/g, OUTLINE_INDENT).length
      // 去掉前导列表符，方便「· - 内容」这类手滑输入；认 ·、- * +、1. 1)
      let topic = line.trim()
      for (let i = 0; i < 6 && BULLET_RE.test(topic); i++) topic = topic.replace(BULLET_RE, "")
      add(Math.floor(indent / 2), topic.trim())
    }

    if (!root.topic) root.topic = "中心主题"
    if (!root.children.length) root.children.push({ id: nextId(), topic: "分支主题", children: [] })
    return { nodeData: root }
  }

  /** 大纲第 N 行对应哪个节点（用于「在大纲里粘贴图片 → 插到光标所在那行」） */
  let outlineLineNodeIds: string[] = []

  /** 导图 → 大纲文本：根行不带前缀，其余行「2 空格 × 层级 + · 」（也兼容 Markdown 列表写法） */
  function dataToOutline(data: any): string {
    const lines: string[] = []
    outlineLineNodeIds = []
    const walk = (node: any, depth: number) => {
      const topic = String(node?.topic ?? "").replace(/\r?\n/g, " ")
      lines.push(depth === 0 ? topic : OUTLINE_INDENT.repeat(depth - 1) + OUTLINE_BULLET + topic)
      outlineLineNodeIds.push(String(node?.id ?? ""))
      ;(node?.children || []).forEach((c: any) => walk(c, depth + 1))
    }
    walk(data?.nodeData ?? data, 0)
    return lines.join("\n")
  }

  /** 按 id 在导图数据里找节点对象 */
  function nodeById(id: string): any | null {
    if (!id) return null
    const root: any = mind.getData()?.nodeData
    let found: any = null
    const walk = (n: any) => {
      if (!n || found) return
      if (String(n.id) === id) {
        found = n
        return
      }
      ;(n.children || []).forEach(walk)
    }
    walk(root)
    return found
  }

  /** 光标在大纲第几行（0 基） */
  function outlineCaretLine(ta: HTMLTextAreaElement): number {
    const pos = ta.selectionStart || 0
    return String(ta.value || "").slice(0, pos).split("\n").length - 1
  }

  /* ---------------- 大纲编辑手感 ---------------- */
  /** 当前行的缩进空格数（Tab 视为一级缩进） */
  function lineIndent(text: string, pos: number): number {
    const start = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1
    const seg = text.slice(start, pos)
    const ws = (seg.match(/^[\t ]*/) as RegExpMatchArray)[0]
    return ws.replace(/\t/g, OUTLINE_INDENT).length
  }

  /** 该行是否已经带列表符（空行不算） */
  function hasBullet(text: string, pos: number): boolean {
    const start = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1
    const line = text.slice(start)
    return BULLET_RE.test(line) && line.trim() !== ""
  }

  /**
   * 替换选区并把光标放到指定位置，同时抛一次 input 让实时成图生效
   * （textarea 上用 setRangeText 会保持撤销栈，手动改 value 不会）
   */
  function replaceRange(ta: HTMLTextAreaElement, from: number, to: number, text: string, caret: number) {
    try {
      ta.setRangeText(text, from, to, "end")
      ta.selectionStart = ta.selectionEnd = caret
    } catch {
      const v = ta.value
      ta.value = v.slice(0, from) + text + v.slice(to)
      ta.selectionStart = ta.selectionEnd = from + text.length
    }
    ta.dispatchEvent(new Event("input", { bubbles: true }))
  }

  /** 行尾位置（不含行尾空白） */
  function lineEnd(text: string, pos: number): number {
    const nl = text.indexOf("\n", pos)
    return nl === -1 ? text.length : nl
  }

  /** 把某行整行改写（保持光标偏移尽量不变） */
  function rewriteLine(ta: HTMLTextAreaElement, deltaIndent: number) {
    const text = ta.value
    const pos = ta.selectionStart
    const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1
    const end = lineEnd(text, pos)
    let line = text.slice(lineStart, end)
    const bullet = (line.match(/^[\t ]*(?:[·•▪◦]|[-*+]|\d+[.)])\s+/) as RegExpMatchArray | null)?.[0] ?? ""
    const wsLen = (line.match(/^[\t ]*/) as RegExpMatchArray)[0].replace(/\t/g, OUTLINE_INDENT).length
    const level = Math.floor(wsLen / 2)
    const next = Math.max(0, level + deltaIndent)
    const bodyStart = lineStart + bullet.length
    const body = line.trim() === "" ? "" : text.slice(bodyStart, end)
    const prefix = next === 0 ? "" : OUTLINE_INDENT.repeat(next) + OUTLINE_BULLET
    const caretInBody = Math.max(0, pos - bodyStart)
    const newLine = prefix + body
    replaceRange(ta, lineStart, end, newLine, lineStart + Math.min(caretInBody, body.length) + prefix.length)
  }

  function onOutlineKeyDown(e: KeyboardEvent) {
    const ta = outlineText
    if (!ta) return
    const text = ta.value
    const pos = ta.selectionStart

    // Tab / Shift+Tab：降级 / 升级
    if (e.key === "Tab") {
      e.preventDefault()
      rewriteLine(ta, e.shiftKey ? -1 : 1)
      return
    }

    // Enter：自动补「- 」前缀与同级缩进；在空节点上回车则回到上一级
    if (e.key === "Enter" && !e.shiftKey && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault()
      const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1
      const end = lineEnd(text, pos)
      const line = text.slice(lineStart, end)
      const indent = lineIndent(text, pos)
      const body = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim()

      if (body === "" && hasBullet(text, pos)) {
        // 空项目回车 → 清掉列表符并退回上一级（连续两次回车可快速退出列表）
        const next = Math.max(0, Math.floor(indent / 2) - 1)
        const prefix = next === 0 ? "" : OUTLINE_INDENT.repeat(next)
        replaceRange(ta, lineStart, end, prefix, lineStart + prefix.length)
        return
      }
      const prefix = "\n" + OUTLINE_INDENT.repeat(Math.floor(indent / 2)) + OUTLINE_BULLET
      replaceRange(ta, pos, pos, prefix, pos + prefix.length)
      return
    }

    // Backspace：光标在「- 」末尾（节点为空）时删掉整段前缀
    if (e.key === "Backspace" && ta.selectionStart === ta.selectionEnd) {
      const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1
      const before = text.slice(lineStart, pos)
      if (/^[\t ]*(?:[·•▪◦]|[-*+]|\d+[.)])\s+$/.test(before)) {
        e.preventDefault()
        replaceRange(ta, lineStart, pos, "", lineStart)
      }
    }
  }

  /** 输入「·」或「-」后自动补空格，省得手敲分隔符 */
  function onOutlineInput() {
    const ta = outlineText
    if (!ta) return
    const pos = ta.selectionStart
    if (pos !== ta.selectionEnd) return
    const text = ta.value
    const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1
    const before = text.slice(lineStart, pos)
    if (/^[\t ]*[·•▪◦\-*+]$/.test(before)) {
      replaceRange(ta, pos, pos, " ", pos + 1)
    }
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
      "</div>" +
      '<textarea class="mm-outline-text" spellcheck="false" placeholder="中心主题&#10;· 分支一&#10;  · 子节点&#10;    · 孙节点"></textarea>'
    el.appendChild(outlineEl)
    outlineText = outlineEl.querySelector(".mm-outline-text") as HTMLTextAreaElement
    outlineText.addEventListener("input", () => {
      if (mode !== "edit") return // 只读：只看不改
      onOutlineInput()
      scheduleApply()
    })
    outlineText.addEventListener("keydown", (e) => {
      if (mode !== "edit") {
        // 只读：打断修改类按键，只留滚动与复制
        const mod = e.ctrlKey || e.metaKey
        if (!(mod && (e.key === "c" || e.key === "C" || e.key === "a" || e.key === "A"))) e.preventDefault()
        e.stopPropagation()
        return
      }
      onOutlineKeyDown(e)
    })
    outlineText.addEventListener("beforeinput", (e) => {
      if (mode !== "edit") e.preventDefault()
    })
    outlineText.addEventListener("paste", (e) => {
      if (mode !== "edit") e.preventDefault()
    })
    outlineText.addEventListener("cut", (e) => {
      if (mode !== "edit") e.preventDefault()
    })
    outlineText.addEventListener("drop", (e) => {
      if (mode !== "edit") e.preventDefault()
    })
    outlineText.addEventListener("blur", flushOutline)
  }

  let outlineBtnEl: HTMLButtonElement | null = null
  function setOutlineOpen(open: boolean) {
    buildOutline()
    panelOpen = open
    const panel = outlineEl!
    panel.classList.toggle("open", open)
    positionOutlinePanel(panel)
    if (outlineBtnEl) {
      outlineBtnEl.classList.toggle("active", open)
      outlineBtnEl.title = open ? "关闭大纲（左侧写大纲，右侧实时成图）" : "大纲（左侧写大纲，右侧实时成图）"
    }
    // 只读时的大纲：可看不可改
    if (outlineText) outlineText.readOnly = mode !== "edit"
    // 导图区让出左侧空间（右侧实时成图）
    canvasHost.classList.toggle("outline-open", open)
    scheduleFit(320) // 可用宽度变了，重新居中并缩放
    if (open && outlineText) {
      outlineText.value = dataToOutline(mind.getData())
      if (mode === "edit") setTimeout(() => outlineText!.focus(), 80)
    }
    try {
      localStorage.setItem("mindmap_outline_open", open ? "1" : "0")
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 大纲面板铺满视口左侧。
   * 全屏、iframe、后台内嵌几种情况下祖先容器的尺寸/定位都不同，所以除了 CSS 的
   * position:fixed，这里再用内联尺寸兜一层，并且保证它始终挂在最外层容器上。
   */
  function positionOutlinePanel(panel: HTMLElement) {
    // 挂到 document.body 顶层，彻底摆脱 #mm-root 的层叠上下文
    try {
      if (panel.parentNode !== document.body) document.body.appendChild(panel)
    } catch {
      /* 忽略 */
    }
    const w = Math.min(380, Math.round(window.innerWidth * 0.86))
    panel.style.position = "fixed"
    panel.style.left = "0"
    panel.style.top = "0"
    panel.style.width = w + "px"
    panel.style.height = window.innerHeight + "px"
    panel.style.zIndex = "2147483000"
    panel.style.display = panelOpen ? "flex" : "none"
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

  // 挂载大纲按钮：先试一次，再用 MutationObserver 兜底（工具栏出现/重建时自动挂上）
  mountOutlineButton()
  // 只读时工具条也常驻（方向切换 + 大纲入口），所以两种模式都要盯着补挂
  try {
    const mo = new MutationObserver(() => {
      if (el.querySelector(".mm-outline-btn")) return
      mountOutlineButton()
    })
    mo.observe(el, { childList: true, subtree: true })
  } catch {
    /* 忽略 */
  }
  // 粘贴图片：两处都接
  //   a) 库自己的 paste 监听挂在画布容器上，复制「节点」时由它处理；
  //      复制「图片」时它会走到 pasteHandler —— 这里接上。
  //   b) 焦点在大纲面板 / 画布空白处时，事件根本到不了画布容器，所以再在
  //      根元素上补一个 paste 监听（捕获阶段），保证 Ctrl+V 在哪都能插图。
  ;(mind as any).pasteHandler = onPaste
  el.addEventListener("paste", (e) => onPaste(e as ClipboardEvent), true)
  // 供宿主判断"有没有没落盘的改动"（后台编辑页保存前提示用）
  ;(window as any).__mindmapDirty = () => dirty

  void load()
  updateKeyBar()
  applyEditable()
  reportMode()
  // 面板默认关闭；上次开着则恢复（前台文章页里不自动展开，免得一进来就挤掉半屏）
  if (mode === "edit" && !embedded) {
    try {
      if (localStorage.getItem("mindmap_outline_open") === "1") setOutlineOpen(true)
    } catch {
      /* 忽略 */
    }
  }
}
