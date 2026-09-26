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
    contextMenu: { locale: zhCN } as any,
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

  /* ---------- 底部居中胶囊：返回 / 导出 / 编辑 · 完成 / 留言 / 信息 / 口令 ---------- */
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

  // 返回博客：放胶囊最左边（最不容易被挤掉），除后台内嵌外无条件出现。
  // 文章页嵌入 → 通知父页面回首页；独立打开 → 直接跳首页。
  if (!fromAdmin) {
    capBtn("bb-view-only cap-back", "返回博客首页", ICON_BACK, "返回", () => {
      if (embedded) tell("back")
      else location.href = "/"
    })
  }
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
    capBtn("bb-view-only", "查看留言", ICON_COMMENT, "留言", () => tell("comments"))
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

  el.appendChild(capsule)

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
  let outlineWasOpen = false
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
      if (locked() && !editKey) {
        // 加密导图：先要口令。可以浏览，但改不了，提示说清楚
        setMsg("此导图已加密：请先输入编辑口令")
      } else {
        setMsg("编辑中：Ctrl + S 保存")
      }
    } else {
      setMsg("已切换到只读浏览")
    }
    // 大纲面板只在编辑态可用；退出时先收起，回来时恢复
    if (!editing && outlineEl?.classList.contains("open")) {
      outlineWasOpen = true
      setOutlineOpen(false)
    } else if (editing && outlineWasOpen) {
      outlineWasOpen = false
      setOutlineOpen(true)
    }
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
      mind.init(d.data || emptyData())
      applyEditable()
      // 加载完成后自适应铺满可视区（只读与编辑模式都适用）
      fitView()
      scheduleFit(320)
      updateKeyBar()
      mountOutlineButton()
      if (mode === "edit") setMsg("Ctrl + S 保存")
      else setMsg("")
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

  /* ---------------- 大纲按钮：图标形式，与库左下工具栏并列 ---------------- */
  let outlineMountTries = 0
  function mountOutlineButton() {
    if (mode !== "edit") return
    const ltBar = el.querySelector(".mind-elixir-toolbar.lt")
    if (!ltBar) {
      // 工具栏由库的 init() 挂入 DOM，构造后可能还没出现：稍后重试
      if (outlineMountTries < 25) {
        outlineMountTries++
        window.setTimeout(mountOutlineButton, 120)
      } else {
        console.warn("[导图] 未找到 .mind-elixir-toolbar.lt，大纲按钮未挂载")
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

  /** 导图 → 大纲文本：根行不带前缀，其余行「2 空格 × 层级 + · 」（也兼容 Markdown 列表写法） */
  function dataToOutline(data: any): string {
    const lines: string[] = []
    const walk = (node: any, depth: number) => {
      const topic = String(node?.topic ?? "").replace(/\r?\n/g, " ")
      lines.push(depth === 0 ? topic : OUTLINE_INDENT.repeat(depth - 1) + OUTLINE_BULLET + topic)
      ;(node?.children || []).forEach((c: any) => walk(c, depth + 1))
    }
    walk(data?.nodeData ?? data, 0)
    return lines.join("\n")
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
      '<span class="mm-outline-tip">回车自动接下一项 · Tab 降级 · Shift+Tab 升级 · 改动实时成图</span>' +
      '<button class="mm-btn" data-act="sync" title="用当前导图内容覆盖大纲">从导图刷新</button>' +
      '<button class="mm-btn" data-act="close">关闭</button>' +
      "</div>" +
      '<textarea class="mm-outline-text" spellcheck="false" placeholder="中心主题&#10;· 分支一&#10;  · 子节点&#10;    · 孙节点"></textarea>'
    el.appendChild(outlineEl)
    outlineText = outlineEl.querySelector(".mm-outline-text") as HTMLTextAreaElement
    outlineText.addEventListener("input", () => {
      onOutlineInput()
      scheduleApply()
    })
    outlineText.addEventListener("keydown", onOutlineKeyDown)
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

  // 挂载大纲按钮：先试一次，再用 MutationObserver 兜底（工具栏出现/重建时自动挂上）
  mountOutlineButton()
  if (mode === "edit") {
    try {
      const mo = new MutationObserver(() => {
        if (el.querySelector(".mm-outline-btn")) return
        mountOutlineButton()
      })
      mo.observe(el, { childList: true, subtree: true })
    } catch {
      /* 忽略 */
    }
  }
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
