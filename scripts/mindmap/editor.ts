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

/* ============ 行内样式标记：**加粗** ==高亮== ~~删除线~~ __下划线__ ============ */
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

type InlineSeg = { text: string; mark: string }

/** 把一行文字按标记切成片段；没闭合的标记按普通文字处理 */
function scanInline(text: string): InlineSeg[] {
  const out: InlineSeg[] = []
  const marks = ["**", "==", "~~", "__"]
  let buf = ""
  let i = 0
  while (i < text.length) {
    const mk = marks.find((m) => text.startsWith(m, i))
    if (mk) {
      const end = text.indexOf(mk, i + mk.length)
      const inner = end >= 0 ? text.slice(i + mk.length, end) : ""
      if (end > i + mk.length && !inner.includes("\n")) {
        if (buf) {
          out.push({ text: buf, mark: "" })
          buf = ""
        }
        out.push({ text: inner, mark: mk })
        i = end + mk.length
        continue
      }
    }
    buf += text[i]
    i++
  }
  if (buf) out.push({ text: buf, mark: "" })
  return out
}

const MARK_CLASS: Record<string, string> = {
  "**": "mm-b",
  "==": "mm-mark",
  "~~": "mm-del",
  "__": "mm-u",
}

/** 待办前缀：`[ ] ` / `[x] ` —— 渲染成真正的方框（大纲里可点，画布上只读展示） */
const TODO_PREFIX_RE = /^\[([ xX])\]\s?/

/** 标记文本 → HTML（换行转 <br>）；大纲与画布共用 */
function renderInline(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const todo = line.match(TODO_PREFIX_RE)
      const box = todo
        ? '<input type="checkbox" class="mm-todo"' + (todo[1].toLowerCase() === "x" ? " checked" : "") + ">"
        : ""
      const body = todo ? line.slice(todo[0].length) : line
      const html = scanInline(body)
        .map((seg) => {
          const inner = escapeHtml(seg.text)
          return seg.mark ? '<span class="' + MARK_CLASS[seg.mark] + '">' + inner + "</span>" : inner
        })
        .join("")
      return box + html
    })
    .join("<br>")
}

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
      // 选中描边：改成中性白，不再和文字颜色混看
      "--main-color": "rgba(255, 255, 255, 0.55)",
      "--main-bgcolor": "#141418",
      // 普通节点文字
      "--color": "#e8e8ea",
      // 根节点（中心主题）文字：与普通节点统一，不再一个白一个灰
      "--root-color": "#e8e8ea",
      "--root-border-color": "rgba(255, 255, 255, 0.4)",
      "--bgcolor": "#0b0b0e",
      // 选中高亮：低饱和深灰蓝，不再是暖橙
      "--selected": "#3a4152",
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
    // 画布节点也按样式渲染（库用 textContent 时只会显示 **加粗** 这类原始标记）。
    // 库在 init / 编辑结束 / 摘要等处都会调它，正好复用大纲那一套渲染。
    markdown: (topic: string) => renderInline(String(topic ?? "")),
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
  /** 大纲行右键「插入图片」时记住目标行，文件选完后贴到这一行（库默认用画布选中的节点） */
  let pendingOutlineImageRow = ""

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
    // 行式大纲：光标所在行就是要贴图的那一行
    const inOutlineRow = !!t?.closest?.(".mm-oline")

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

    if (inOutlineRow) {
      const curRow = currentRow()
      settlePendingRowText(curRow) // 先把这一行的文字落进数据，保证按 id 找得到节点
      const rowId = curRow?.dataset.node || ""
      if (!rowId) {
        setMsg("没定位到大纲这一行的节点：把光标放到某一行内容上再粘贴")
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (!stageImage(file, rowId)) setMsg("图片贴不上去，请重试")
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
    if (pendingOutlineImageRow) {
      const pid = pendingOutlineImageRow
      pendingOutlineImageRow = ""
      if (!stageImage(file, pid)) setMsg("图片贴不上去，请重试")
      return
    }
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
      updateOutlineImageCount(data)
      // 行列表也同步一份并重建大纲：别等下一次整表重建（那要靠回车之类的操作才触发）
      outlineRows = collectRows(mind.getData())
      renderOutlineTree()
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
            updateOutlineImageCount(d2)
            outlineRows = collectRows(mind.getData())
            renderOutlineTree()
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
          updateOutlineImageCount(data)
          outlineRows = collectRows(mind.getData())
          renderOutlineTree() // 上传完立刻把行内缩略图刷成最终状态
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
        refreshTakenIds()
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
      refreshTakenIds()
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
  /** 工具条上的「导入」按钮（把 Markdown / 纯文本大纲变成分级节点） */
  function mountImportButton(ltBar: HTMLElement) {
    if (ltBar.querySelector(".mm-import-btn")) return
    const b = document.createElement("span")
    b.className = "mm-import-btn"
    b.title = "导入 Markdown / 纯文本大纲"
    b.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M4 20h16"></path>' +
      "</svg>"
    b.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      openImport()
    })
    ltBar.appendChild(b)
  }

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
    if (ltBar.querySelector(".mm-outline-btn")) {
      mountImportButton(ltBar)
      return
    }
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
  // 数据里已经占用的节点 id。默认数据里就有 "n1"，而计数器也从 n1 起步，
  // 直接撞车会让 applyRowsToData 的 byId 互相覆盖，表现为「刚写的节点消失、多出重复节点」。
  const takenIds = new Set<string>()
  const nextId = () => {
    let id = ""
    do {
      id = "n" + ++uid
    } while (takenIds.has(id))
    takenIds.add(id)
    return id
  }

  /** 重新登记数据里已有的 id（载入 / 重建数据后调用） */
  function refreshTakenIds() {
    takenIds.clear()
    const walk = (n: any) => {
      if (!n) return
      if (n.id !== undefined) takenIds.add(String(n.id))
      ;(n.children || []).forEach(walk)
    }
    walk((mind.getData() as any)?.nodeData)
  }

  /*
   * 大纲解析：把 Markdown / 纯文本折成「相对层级」。两种文档形态都要对：
   *
   *  A. 幕布导出（混合）：无符号的独立行 = 一级分类；`- ` 项跟着分类走、比它深一级；
   *     缩进 2 空格的**无符号**行是上一个节点的补充说明（例如「要求：…」），挂在它下面。
   *  B. 纯缩进大纲：所有行都没符号，缩进直接决定层级。
   *
   * 另外：叠在一起写的符号（幕布会导出 `- 1. 学习顺序…`）要一层层剥净；
   * `- [ ]` / `- [x]` 这类待办前缀保留原样；空行忽略；跳级安全。
   */
  const OUTLINE_INDENT = "  "
  const OUTLINE_BULLET = "· "
  /** 列表符号：`- ` `* ` `+ ` `1. ` `· ` 等（只在行首匹配，正文里的「1.」不受影响） */
  const BULLET_RE = /^(?:[-*+]|\d+[.)]|[·•▪◦])\s+/
  /** 幕布待办项前缀 `[ ] ` / `[x] ` */
  const TODO_RE = /^\[[ xX]\]\s+/

  function outlineToData(text: string): any {
    const root: any = { id: "root", topic: "", children: [] }
    const stack: Array<{ level: number; node: any }> = []
    let isFirst = true
    /** 第一行（中心主题）的缩进，用于判断后面的行是它的子级还是同级 */
    let firstLineIndent = 0

    /* 预扫描：判断是「分类 + 列表」形态（幕布）还是「纯缩进」形态，并取缩进基准 */
    let bulletAtTop = false
    let bulletIndented = false
    let minIndentDepth = 0
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine.trim()) continue
      if (/^\s*#{1,6}\s+/.test(rawLine)) continue
      const indent = (rawLine.match(/^[\t ]*/) || [""])[0]
      const d = Math.floor(indent.replace(/\t/g, OUTLINE_INDENT).length / OUTLINE_INDENT.length)
      if (rawLine.trim().match(BULLET_RE)) {
        if (d === 0) bulletAtTop = true
        else bulletIndented = true
      }
      if (d > 0 && (minIndentDepth === 0 || d < minIndentDepth)) minIndentDepth = d
    }
    // 缩进基准：取文档里「有缩进的行」的最小缩进（没有缩进行时为 0）
    const base = minIndentDepth

    /** 上一个节点的层级（缩进说明行兜底用） */
    let prevLevel: number | null = null
    /** 最近一个「顶格无符号行」（幕布里的分类行）的层级与缩进，用于推断它下面各行的层级 */
    let pendingClassLevel: number | null = null
    let pendingClassIndent = 0
    /** 最近的列表项层级：它下面缩进的无符号行是它的子级（幕布的「要求：…」） */
    let lastBulletLevel: number | null = null

    const add = (level: number, topic: string): number | null => {
      const body = String(topic || "").trim()
      if (!body) return null
      if (isFirst) {
        root.topic = body
        isFirst = false
        stack.push({ level: 0, node: root })
        return 0
      }
      const node = { id: nextId(), topic: body, children: [] }
      const lv = Math.max(1, level)
      while (stack.length > 1 && stack[stack.length - 1].level >= lv) stack.pop()
      const parent = stack.length ? stack[stack.length - 1].node : root
      parent.children.push(node)
      stack.push({ level: lv, node })
      return lv
    }

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+$/, "")
      if (!line.trim()) continue
      const indent = (line.match(/^[\t ]*/) || [""])[0]
      const depth = Math.floor(indent.replace(/\t/g, OUTLINE_INDENT).length / OUTLINE_INDENT.length)
      const indented = depth > 0
      const body0 = line.trim()
      if (isFirst) firstLineIndent = depth // 中心主题的缩进：判断后面各行的相对层级要用
      const hadBullet = !!body0.match(BULLET_RE)
      let rest = body0

      const heading = rest.match(/^(#{1,6})\s+/)
      if (heading) {
        const lvl = Math.max(0, heading[1].length - 1)
        const used = add(lvl, rest.slice(heading[0].length).trim())
        if (used !== null) pendingClassLevel = used >= 1 ? used : null
        continue
      }

      // 叠在一起的符号（`- 1. xxx`）一层层剥干净，否则剩下的 `1.` 会被当成新的一行
      let guard = 0
      for (;;) {
        const bullet = rest.match(BULLET_RE)
        if (!bullet || guard++ > 6) break
        rest = rest.slice(bullet[0].length).trim()
      }
      // 幕布待办：`[ ]` / `[x]` 当正文前缀留着，勾选状态不丢
      const todo = rest.match(TODO_RE)
      if (todo) rest = todo[0].trimEnd() + " " + rest.slice(todo[0].length)

      let level: number
      if (!hadBullet && !indented && bulletAtTop) {
        // 幕布形态里顶格的无符号行 = 分类行 → 一级分类
        // （纯缩进大纲不走这条：那里「顶格」就是最外层，缩进才是层级）
        level = 1
        pendingClassLevel = 1
        pendingClassIndent = 0
      } else if (!hadBullet) {
        if (lastBulletLevel !== null) {
          // 幕布那种「要求：…」：上一个列表项的子级；再缩进就再深一层
          level = lastBulletLevel + 1 + Math.max(0, depth - base - 1)
        } else {
          // 纯缩进大纲：按「全局最小的缩进」折算；首行若与基准同层就直接作它的子级
          const step = Math.max(0, depth - base)
          level = step === 0 && firstLineIndent <= base ? 1 : 1 + Math.max(1, step)
        }
      } else if (bulletAtTop) {
        // 幕布形态：列表项跟着分类走；缩进的列表项是上一个列表项的子级
        if (indented && prevLevel !== null && prevLevel >= 1) {
          level = prevLevel + 1 + Math.max(0, depth - Math.max(1, base) - 0)
        } else if (pendingClassLevel !== null) {
          level = pendingClassLevel + 1
        } else {
          level = 1 + depth
        }
      } else {
        // 纯缩进 / 平铺列表：由缩进决定
        level = 1 + Math.max(0, depth - base)
      }
      const used = add(level, rest)
      if (used !== null) {
        prevLevel = used
        if (hadBullet) {
          lastBulletLevel = used // 列表项：它下面缩进的无符号行是它的子级
        } else if (!indented) {
          lastBulletLevel = null // 分类行：后面的缩进行按「相对分类」算
        }
      }
    }
    if (!root.topic) root.topic = "中心主题"
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
      // 带图片的节点在大纲里标一下，方便一眼看出哪几项有图
      const img = node?.image
      const mark = img ? `  [图片${img.width && img.height ? ` ${img.width}×${img.height}` : ""}]` : ""
      lines.push((depth === 0 ? topic : OUTLINE_INDENT.repeat(depth - 1) + OUTLINE_BULLET + topic) + mark)
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
      renderOutlineThumbs(mind.getData())
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

  /* ---------------- 大纲：行式列表（幕布手感） ----------------
     每行是一个独立元素：折叠三角 + 可编辑文字 + 行内缩略图。
     折叠、拖拽、多选都建立在"行"之上；文字用 contenteditable 单行编辑，
     回车/Tab 在行之间操作，不依赖任何富文本解析。 */

  /**
   * 调试开关：默认安静，排查问题时在网址后面加 ?mmdebug=1 才会往控制台打这些日志。
   * （之前为定位折叠/按键/图片那几个 bug 留了不少日志，平时不该打扰使用）
   */
  const MM_DEBUG = (() => {
    try {
      const q = new URLSearchParams(window.location.search)
      return q.get("mmdebug") === "1"
    } catch {
      return false
    }
  })()
  const dbg = (...args: any[]) => {
    if (MM_DEBUG) console.log(...args)
  }

  type OutlineRow = {
    id: string
    level: number
    topic: string
    imgUrl: string
    imgW: number
    imgH: number
    kids: number
    expanded: boolean
    /** 节点备注（幕布式：不占正文，鼠标悬停或点小图标才看到） */
    note: string
  }

  let outlineRows: OutlineRow[] = []
  /** 多选：被选中的行 id（空 = 没有多选） */
  const selectedRows = new Set<string>()
  /** 大纲内部的剪贴板：每行一个节点（不含 children），复制/剪切共用；只在同一页面内有效 */
  let outlineClip: { nodes: any[] } | null = null
  let outlineHost: HTMLElement | null = null
  let outlineEditing = false
  // 行内文字是边打边提交的（防抖 300ms）。但回车/删除/Tab 会整表重建，
  // 若此时待提交的文字还没进数据，重建就会用旧文本把刚打的字盖掉。
  // 所以结构操作前必须先「结算」待提交的文字。
  let pendingRowEl: HTMLElement | null = null
  let pendingTimer: number | null = null
  /** 判断鼠标是「单击」还是「拖动划选」用（拖动时要让浏览器自己做选择） */
  let dragStartX = 0
  let dragStartY = 0
  let dragRowEl: HTMLElement | null = null

  /** 数据 → 行列表（折叠的节点：子项不生成行，符合"收起后看不到"） */
  function collectRows(data: any): OutlineRow[] {
    const rows: OutlineRow[] = []
    const walk = (node: any, level: number) => {
      const kids = (node?.children || []).length
      const img = node?.image
      rows.push({
        id: String(node?.id ?? ""),
        level,
        topic: String(node?.topic ?? ""),
        imgUrl: img && typeof img.url === "string" ? img.url : "",
        imgW: Number(img?.width) || 0,
        imgH: Number(img?.height) || 0,
        kids,
        expanded: node?.expanded !== false,
        note: String(node?.note ?? ""),
      })
      if (node?.expanded === false) return // 收起：子项不显示
      ;(node?.children || []).forEach((c: any) => walk(c, level + 1))
    }
    walk(data?.nodeData ?? data, 0)
    return rows
  }

  function rowEls(): HTMLElement[] {
    if (!outlineHost) return []
    return Array.from(outlineHost.querySelectorAll<HTMLElement>(".mm-oline"))
  }

  function renderOutlineTree() {
    if (!outlineHost) return
    hideNoteTip()
    // 编辑能力只看当前模式，不再依赖"是否点过"的标志（那个标志一旦卡住就整块不能编辑）
    const editing = mode === "edit"
    outlineHost.innerHTML = outlineRows
      .map((r, i) => {
        const cls = "mm-oline" + (r.level === 0 ? " lv0" : "")
        const tri =
          r.kids > 0
            ? '<button type="button" class="mm-tri' + (r.expanded ? "" : " collapsed") + '" data-act="fold" title="' +
              (r.expanded ? "收起子项" : "展开子项") + '">' + (r.expanded ? "▾" : "▸") + "</button>"
            : '<span class="mm-tri empty"></span>'
        // 行首小圆点 = 拖拽手柄（只有它开启原生拖拽，行内其它位置留给文字编辑）
        const drag =
          mode === "edit" && i > 0
            ? '<span class="mm-oline-drag" draggable="true" title="按住拖动，可改上下顺序与层级"></span>'
            : '<span class="mm-oline-drag off"></span>'
        const img = r.imgUrl
          ? '<img class="mm-oline-img" src="' + r.imgUrl + '" alt="" draggable="false" data-node="' + r.id + '">'
          : ""
        // 编辑态也渲染成样式：用户永远不用看到 ** == 这类符号（改样式走选区工具栏）
        const text = renderInline(r.topic)
        // 有备注的行尾挂一个小方块；没有备注时极淡，鼠标划过才显形，方便随时添加
        const note =
          '<span class="mm-oline-note' +
          (r.note ? " has" : "") +
          '" data-act="note" title="' +
          (r.note ? "点击编辑备注" : "点击添加备注") +
          '">' +
          (r.note ? "▪" : "+") +
          "</span>"
        const noteText = r.note
          ? '<span class="mm-oline-notetext">' +
            r.note
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/\n/g, "<br>") +
            "</span>"
          : ""
        return (
          '<div class="' + cls + '" data-line="' + i + '" data-node="' + r.id + '"' +
          ' style="padding-left:' +
          (8 + r.level * 18) + 'px">' +
          tri +
          drag +
          '<span class="mm-oline-topic"' + (editing ? ' contenteditable="true" spellcheck="false"' : "") + '>' + text + "</span>" +
          note +
          img +
          noteText +
          "</div>"
        )
      })
      .join("")
  }

  /* ---------------- 行内样式标记（工具函数见文件顶部） ---------------- */

  /** 从行的 DOM 里读回文字：把样式 span 还原成标记，<br> 还原成换行 */
  function readTopic(root: HTMLElement): string {
    let out = ""
    const walk = (node: Node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue || ""
          continue
        }
        if (!(child instanceof HTMLElement)) continue
        if (child.tagName === "BR") {
          out += "\n"
          continue
        }
        if (child.tagName === "IMG") continue
        if (child.tagName === "INPUT") {
          out += (child as HTMLInputElement).checked ? "[x] " : "[ ] "
          continue
        }
        const cls = child.className || ""
        const mark = cls.includes("mm-mark") ? "==" : cls.includes("mm-b") ? "**" : cls.includes("mm-del") ? "~~" : cls.includes("mm-u") ? "__" : ""
        if (!mark) {
          walk(child)
          continue
        }
        const inner = (child.textContent || "").replace(/\s+/g, " ").trim()
        if (inner) out += mark + inner + mark
      }
    }
    walk(root)
    return out
  }

  /** 行内容改回数据：只改文字（图片、层级、顺序由各自的操作负责） */
  function commitRowText(rowEl: HTMLElement) {
    const id = rowEl.dataset.node || ""
    const textEl = rowEl.querySelector(".mm-oline-topic") as HTMLElement | null
    if (!id || !textEl) return
    // 用 readTopic 而不是 textContent：样式 span 要还原成 ** == 之类的标记
    const text = readTopic(textEl).replace(/[ \t\u00a0]+/g, " ").trim()
    const node = nodeByIdInData(id)
    const data = mind.getData() as any
    const target = findNodeIn(data?.nodeData, id)
    if (!target) {
      void node
      return
    }
    if (String(target.topic) === text) return
    target.topic = text || "新主题"
    mind.refresh(data)
    dirty = true
    outlineRows = collectRows(mind.getData())
  }

  /** 把行上正在编辑的文字立刻写进数据（并同步行列表），返回写了哪一行 */
  function settlePendingRowText(rowEl?: HTMLElement | null): HTMLElement | null {
    if (pendingTimer !== null) {
      window.clearTimeout(pendingTimer)
      pendingTimer = null
    }
    const row = rowEl || pendingRowEl
    pendingRowEl = null
    if (!row) return null
    commitRowText(row)
    return row
  }

  /** 切换折叠（写进数据；渲染状态与导图视图同步） */
  function toggleFold(id: string, collapse: boolean) {
    const data = mind.getData() as any
    const target = findNodeIn(data?.nodeData, id)
    if (!target) return
    target.expanded = !collapse
    mind.refresh(data)
    dirty = true
    // 兜底：把画布 DOM 对齐到数据里的 expanded。
    // 注意 me-parent 的子元素顺序是 [me-tpc, me-epd, me-children]，判断要按元素名找，
    // 不能按 children[1] 的 className 猜（那正是之前把折叠改坏的原因）。
    try {
      const tpc = (mind as any).findEle?.(id)
      const parent = tpc?.parentNode as HTMLElement | null
      if (parent) {
        const epd = parent.querySelector(":scope > me-epd") as HTMLElement | null
        if (epd) {
          const wantFold = !collapse
          ;(epd as any).expanded = wantFold
          epd.className = wantFold ? "minus" : ""
        }
      }
    } catch {
      /* 节点被收起后 findEle 会抛「maybe it is collapsed」，这正是收起的正常结果 */
    }
    outlineRows = collectRows(mind.getData())
    renderOutlineTree()
  }

  /** 在大纲里定位节点（用 getData 的克隆数据） */
  function findNodeIn(root: any, id: string): any | null {
    if (!root) return null
    if (String(root.id) === id) return root
    for (const c of root.children || []) {
      const hit = findNodeIn(c, id)
      if (hit) return hit
    }
    return null
  }
  function nodeByIdInData(id: string): any | null {
    return findNodeIn(mind.getData()?.nodeData, id)
  }

  /** 当前光标落在哪一行 */
  function currentRow(): HTMLElement | null {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return null
    let n: Node | null = sel.getRangeAt(0).startContainer
    while (n && n !== outlineHost) {
      if (n instanceof HTMLElement && n.classList.contains("mm-oline")) return n
      n = n.parentNode
    }
    return null
  }
  /** 当前光标所在行的节点 id（粘贴图片时按行定位用） */
  function outlineNodeIdAtCaret(): string {
    return currentRow()?.dataset.node || ""
  }

  function caretToTextEnd(el: HTMLElement) {
    try {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      el.focus()
    } catch {
      /* 忽略 */
    }
  }

  /** 顶层入口：数据变了就重建行列表 */
  function syncOutlineFromData() {
    if (!outlineHost) return
    outlineRows = collectRows(mind.getData())
    renderOutlineTree()
  }

  function buildOutline() {
    if (outlineEl) return
    outlineEl = document.createElement("div")
    outlineEl.className = "mm-outline"
    outlineEl.innerHTML =
      '<div class="mm-outline-head">' +
      '<span class="mm-outline-title">大纲<span class="cnt" id="mmOutlineImgCnt"></span></span>' +
      "</div>" +
      '<div class="mm-outline-images" id="mmOutlineImages" hidden></div>' +
      '<div class="mm-outline-tree" contenteditable="false"></div>'
    el.appendChild(outlineEl)
    outlineHost = outlineEl.querySelector(".mm-outline-tree") as HTMLElement | null
    outlineRows = collectRows(mind.getData())
    renderOutlineTree()
    outlineEl.querySelector(".mm-outline-tree")?.addEventListener("click", (e) => {
      const t = e.target as HTMLElement | null
      if (t?.classList.contains("mm-tri") && t.dataset.act === "fold") {
        e.preventDefault()
        e.stopPropagation()
        const row = t.closest(".mm-oline") as HTMLElement | null
        const id = row?.dataset.node || ""
        const willCollapse = !t.classList.contains("collapsed")
        try {
          dbg("[mm] 点了折叠三角", { id, willCollapse, rows: outlineRows.length, editable: (mind as any).editable })
        } catch {
          /* 忽略 */
        }
        if (row) toggleFold(id, willCollapse)
        try {
          const after = mind.getData() as any
          const n = nodeByIdInData(id)
          void after
          dbg("[mm] 折叠后节点 expanded =", n?.expanded)
        } catch {
          /* 忽略 */
        }
        return
      }
      // 点行内缩略图 → 看大图（顺带在画布上定位到该节点）
      if (t?.classList.contains("mm-oline-img")) {
        const src = t.getAttribute("src") || ""
        if (src) showImageView(src)
        try {
          const mindAny = mind as any
          const tpc = mindAny.findEle?.(t.dataset.node || "")
          if (tpc) {
            mindAny.selectNode?.(tpc)
            mindAny.scrollIntoView?.(tpc, true)
          }
        } catch {
          /* 忽略 */
        }
      }
    })
    buildOutlineBindings()
  }

  /** 行顺序/层级 → 写回数据（Tab 调级走这里） */
  function applyRowsToData(rows: OutlineRow[], data?: any) {
    const src = data || (mind.getData() as any)
    const oldRoot = src?.nodeData
    if (!oldRoot) return
    const byId = new Map<string, any>()
    const collect = (n: any) => {
      byId.set(String(n.id), n)
      ;(n.children || []).forEach(collect)
    }
    collect(oldRoot)
    const root: any = { ...(byId.get(rows[0]?.id || "") || oldRoot), children: [] }
    const stack: Array<{ level: number; node: any }> = [{ level: 0, node: root }]
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      const old = byId.get(r.id)
      const node: any = { ...(old || {}), id: r.id || nextId(), topic: r.topic || "新主题", children: [] }
      while (stack.length > 1 && stack[stack.length - 1].level >= r.level) stack.pop()
      const parent = stack.length ? stack[stack.length - 1].node : root
      parent.children.push(node)
      stack.push({ level: r.level, node })
    }
    mind.refresh({ nodeData: root } as any)
    dirty = true
    outlineRows = collectRows(mind.getData())
    refreshTakenIds()
    updateOutlineImageCount()
  }

  /** 把 fromId 这一行（连同子项）搬到 toId 的前面 / 里面 / 后面 */
  function moveRowTo(fromId: string, toId: string, mode: "before" | "in" | "after") {
    if (!fromId || !toId || fromId === toId) return
    const fromIdx = outlineRows.findIndex((r) => r.id === fromId)
    const toIdx = outlineRows.findIndex((r) => r.id === toId)
    if (fromIdx < 0 || toIdx < 0) return
    if (fromIdx === 0) {
      setMsg("中心主题不能移动")
      return
    }
    // 连同子项一起搬：取到这一行之后、层级更深的连续行
    const srcLevel = outlineRows[fromIdx].level
    let end = fromIdx + 1
    while (end < outlineRows.length && outlineRows[end].level > srcLevel) end++
    const moving = outlineRows.slice(fromIdx, end)
    if (moving.some((r) => r.id === toId)) {
      setMsg("不能把节点拖到它自己的子项里")
      return
    }
    const rest = outlineRows.slice(0, fromIdx).concat(outlineRows.slice(end))
    const targets = rest.map((r) => r.id)
    const baseIdx = targets.indexOf(toId)
    if (baseIdx < 0) return
    // 变成子项时，目标若本来是收起的，搬完就看不见了 —— 自动展开，让用户看到结果
    if (mode === "in") {
      const t = rest[baseIdx]
      if (t) t.expanded = true
    }
    const delta = rest[baseIdx].level + (mode === "in" ? 1 : 0) - srcLevel
    const moved = moving.map((r) => ({ ...r, level: Math.max(1, r.level + delta) }))
    const insertAt = mode === "before" ? baseIdx : baseIdx + 1
    const out = rest.slice(0, insertAt).concat(moved, rest.slice(insertAt))
    // 后一件的层级不能跳太多（保持树合法）
    const fixed: OutlineRow[] = []
    out.forEach((r, i) => {
      if (i === 0) {
        fixed.push({ ...r, level: 0 })
        return
      }
      const prevLv = fixed[i - 1].level
      fixed.push({ ...r, level: Math.min(r.level, prevLv + 1) })
    })
    outlineRows = fixed
    applyRowsToData(outlineRows)
    renderOutlineTree()
    setMsg("已调整层级")
  }

  /** 该行是否「整行被选中」（内容全选或没内容），用来区分「复制文字」还是「复制节点」 */
  function rowFullySelected(): boolean {
    const row = currentRow()
    if (!row) return false
    const topic = row.querySelector(".mm-oline-topic") as HTMLElement | null
    if (!topic) return false
    const text = (topic.textContent || "").trim()
    if (!text) return true
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return true
    return (sel.toString() || "").replace(/\s+/g, "") === text.replace(/\s+/g, "")
  }

  /** 要操作的行的 id：有多选就用多选，否则用光标所在行 */
  function targetRowIds(): string[] {
    const ids: string[] = []
    outlineRows.forEach((r) => {
      if (selectedRows.has(r.id)) ids.push(r.id)
    })
    if (ids.length) return ids
    const cur = currentRow()?.dataset.node
    return cur ? [cur] : []
  }

  /**
   * 把选中的行归并成「块」：每块 = 该行 + 它的全部子项（行序上层级更深的连续行）。
   * 剪贴板里只存每一行自己的节点数据（去掉 children）——每行本来就对应一个节点，
   * 带上 children 再逐行发 id 会把同一棵子树复制多份。
   */
  function copyRowBlocks(ids: string[]) {
    const blocks: Array<{ start: number; end: number }> = []
    for (const id of ids) {
      const i = outlineRows.findIndex((r) => r.id === id)
      if (i < 0) continue
      const lv = outlineRows[i].level
      let end = i + 1
      while (end < outlineRows.length && outlineRows[end].level > lv) end++
      if (!blocks.some((b) => i >= b.start && i < b.end)) blocks.push({ start: i, end })
    }
    blocks.sort((a, b) => a.start - b.start)
    const top = blocks.filter((b, k) => k === 0 || b.start >= blocks[k - 1].end)
    const data = mind.getData() as any
    return top.map((b) => ({
      start: b.start,
      end: b.end,
      nodes: outlineRows.slice(b.start, b.end).map((r) => {
        const n: any = findNodeIn(data?.nodeData, r.id) || {}
        const { children, ...rest } = n
        void children
        return { ...JSON.parse(JSON.stringify(rest)), level: r.level }
      }),
    }))
  }

  /** 复制（cut = true 时同时从大纲里摘掉） */
  function copyRows(cut: boolean): number {
    const ids = targetRowIds()
    if (!ids.length) return 0
    if (ids.includes(outlineRows[0]?.id || "")) {
      setMsg(cut ? "中心主题不能剪切" : "中心主题不能复制")
      return -1
    }
    const blocks = copyRowBlocks(ids)
    if (!blocks.length) return 0
    outlineClip = { nodes: blocks.flatMap((b) => b.nodes) }
    try {
      ;(window as any).__mmClipboard = outlineClip
    } catch {
      /* 忽略 */
    }
    if (cut) {
      const drop = new Set<string>()
      for (const b of blocks) for (let i = b.start; i < b.end; i++) drop.add(outlineRows[i].id)
      outlineRows = outlineRows.filter((r) => !drop.has(r.id))
      selectedRows.clear()
      applyRowsToData(outlineRows)
      renderOutlineTree()
    }
    const total = blocks.reduce((n, b) => n + b.end - b.start, 0)
    setMsg((cut ? "已剪切 " : "已复制 ") + total + " 项（含子项）")
    return total
  }

  /** 粘贴到当前行下面（同级）；多选复制来的会保持彼此的相对层级 */
  function pasteRows(): boolean {
    if (!outlineClip?.nodes?.length) return false
    const targetId = currentRow()?.dataset.node || ""
    const tIdx = outlineRows.findIndex((r) => r.id === targetId)
    if (tIdx < 0) {
      setMsg("先把光标放到要粘贴的位置")
      return true
    }
    const nodes = outlineClip.nodes
    const tLevel = outlineRows[0]?.id === targetId ? 0 : outlineRows[tIdx].level + 1
    const base = Number(nodes[0]?.level) || 0
    const insert: OutlineRow[] = []
    nodes.forEach((n: any) => {
      const lv = Math.max(tLevel, tLevel + (Number(n.level) || 0) - base)
      insert.push({
        id: nextId(),
        level: lv,
        topic: String(n.topic ?? ""),
        imgUrl: n.image?.url || "",
        imgW: Number(n.image?.width) || 0,
        imgH: Number(n.image?.height) || 0,
        kids: 0,
        expanded: n.expanded !== false,
        note: String(n.note ?? ""),
      })
    })
    const out = outlineRows.slice(0, tIdx + 1).concat(insert, outlineRows.slice(tIdx + 1))
    const fixed: OutlineRow[] = []
    out.forEach((r, i) => {
      if (i === 0) {
        fixed.push({ ...r, level: 0 })
        return
      }
      fixed.push({ ...r, level: Math.min(r.level, fixed[i - 1].level + 1) })
    })
    outlineRows = fixed
    applyRowsToData(outlineRows)
    renderOutlineTree()
    const next = rowEls()[tIdx + 1]?.querySelector(".mm-oline-topic") as HTMLElement | null
    if (next) caretToTextEnd(next)
    setMsg("已粘贴 " + insert.length + " 项")
    return true
  }

  /** 点方框：把这一行开头的 `[ ]` / `[x]` 对调，并写回数据 */
  function toggleTodoInRow(rowEl: HTMLElement) {
    if (mode !== "edit") {
      setMsg("只读模式下不能勾选")
      return
    }
    const id = rowEl.dataset.node || ""
    if (!id) return
    const data = mind.getData() as any
    const node = findNodeIn(data?.nodeData, id)
    if (!node) return
    const body = String(node.topic || "")
    const m = body.match(TODO_PREFIX_RE)
    if (!m) return
    const done = m[1].toLowerCase() === "x"
    node.topic = (done ? "[ ] " : "[x] ") + body.slice(m[0].length)
    ;(mind as any).refresh(data)
    dirty = true
    outlineRows = collectRows(mind.getData())
    renderOutlineTree()
    setMsg(done ? "已取消勾选" : "已完成")
  }

  /** 写备注：只改 note 字段，不动其它内容 */
  function setRowNote(id: string, note: string) {
    if (!id) return
    const data = mind.getData() as any
    const node = findNodeIn(data?.nodeData, id)
    if (!node) return
    const next = (note || "").trim()
    if (String(node.note || "") === next) return
    if (next) node.note = next
    else delete node.note
    ;(mind as any).refresh(data)
    dirty = true
    outlineRows = collectRows(mind.getData())
    renderOutlineTree()
    setMsg(next ? "备注已保存" : "备注已清除")
  }

  let notePanelEl: HTMLElement | null = null
  let noteTargetId = ""
  let noteTipEl: HTMLElement | null = null

  function hideNoteTip() {
    noteTipEl?.classList.remove("show")
  }

  /** 悬停备注小方块时浮出气泡显示全文（不占行高，免得把大纲挤乱） */
  function showNoteTip(icon: HTMLElement, text: string) {
    if (!text) return
    if (!noteTipEl) {
      const tip = document.createElement("div")
      tip.className = "mm-notetip"
      document.body.appendChild(tip)
      noteTipEl = tip
    }
    const tip = noteTipEl
    tip.textContent = text
    tip.classList.add("show")
    const r = icon.getBoundingClientRect()
    const w = tip.offsetWidth || 240
    const h = tip.offsetHeight || 60
    tip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px"
    tip.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - h - 8)) + "px"
  }

  function closeNotePanel() {
    notePanelEl?.classList.remove("show")
    noteTargetId = ""
  }

  function ensureNotePanel(): HTMLElement {
    if (notePanelEl) return notePanelEl
    const box = document.createElement("div")
    box.className = "mm-notebox"
    box.innerHTML =
      '<div class="mm-notebox-head">节点备注<span>Ctrl+Enter 保存 · Esc 取消</span></div>' +
      '<textarea class="mm-notebox-ta" placeholder="给这个节点写点说明（回车换行）"></textarea>' +
      '<div class="mm-notebox-btns">' +
      '<button type="button" data-act="note-clear">清除备注</button>' +
      '<button type="button" data-act="note-cancel">取消</button>' +
      '<button type="button" class="primary" data-act="note-save">保存</button>' +
      "</div>"
    document.body.appendChild(box)
    const ta = box.querySelector(".mm-notebox-ta") as HTMLTextAreaElement
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault()
        closeNotePanel()
        return
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setRowNote(noteTargetId, ta.value)
        closeNotePanel()
      }
    })
    box.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement | null)?.closest?.("[data-act]")?.getAttribute("data-act") || ""
      if (!act) return
      if (act === "note-cancel") {
        closeNotePanel()
        return
      }
      if (act === "note-clear") {
        setRowNote(noteTargetId, "")
        closeNotePanel()
        return
      }
      if (act === "note-save") {
        setRowNote(noteTargetId, ta.value)
        closeNotePanel()
      }
    })
    notePanelEl = box
    return box
  }

  function openNotePanel(id: string, anchor: HTMLElement) {
    const box = ensureNotePanel()
    noteTargetId = id
    const row = outlineRows.find((r) => r.id === id)
    const ta = box.querySelector(".mm-notebox-ta") as HTMLTextAreaElement
    ta.value = row?.note || ""
    box.classList.add("show")
    const r = anchor.getBoundingClientRect()
    const w = box.offsetWidth || 300
    const h = box.offsetHeight || 180
    box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px"
    box.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - h - 8)) + "px"
    window.setTimeout(() => {
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
    }, 0)
  }

  /* ---------------- 第 6 步：Markdown / 纯文本导入 ---------------- */
  let importEl: HTMLElement | null = null

  function closeImport() {
    importEl?.classList.remove("show")
  }

  function ensureImport(): HTMLElement {
    if (importEl) return importEl
    const box = document.createElement("div")
    box.className = "mm-importbox"
    box.innerHTML =
      '<div class="mm-notebox-head">导入大纲<span>用缩进、- 或 1. 表示层级</span></div>' +
      '<textarea class="mm-notebox-ta mm-import-ta" placeholder="把 Markdown 或纯文本大纲粘进来，例如：\n一级主题\n  子主题\n    更深的子主题"></textarea>' +
      '<div class="mm-notebox-btns">' +
      '<button type="button" data-act="imp-cancel">取消</button>' +
      '<button type="button" class="primary" data-act="imp-do">导入为分级节点</button>' +
      "</div>"
    document.body.appendChild(box)
    const ta = box.querySelector(".mm-import-ta") as HTMLTextAreaElement
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault()
        closeImport()
        return
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        importOutline(ta.value)
      }
    })
    box.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement | null)?.closest?.("[data-act]")?.getAttribute("data-act") || ""
      if (act === "imp-cancel") closeImport()
      if (act === "imp-do") importOutline(ta.value)
    })
    importEl = box
    return box
  }

  function openImport() {
    if (mode !== "edit") {
      setMsg("只读模式下不能导入")
      return
    }
    const box = ensureImport()
    box.classList.add("show")
    const w = box.offsetWidth || 340
    const h = box.offsetHeight || 240
    box.style.left = Math.max(8, (window.innerWidth - w) / 2) + "px"
    box.style.top = Math.max(8, (window.innerHeight - h) / 2) + "px"
    const ta = box.querySelector(".mm-import-ta") as HTMLTextAreaElement
    window.setTimeout(() => ta.focus(), 0)
  }

  /** 把解析出来的树拍平成行（第一行当作新分支，不碰原来的中心主题） */
  function flattenImport(root_: any): OutlineRow[] {
    const rows: OutlineRow[] = []
    const walk = (n: any, level: number) => {
      rows.push({
        id: nextId(),
        level,
        topic: String(n.topic || ""),
        imgUrl: "",
        imgW: 0,
        imgH: 0,
        kids: (n.children || []).length,
        expanded: true,
        note: "",
      })
      ;(n.children || []).forEach((c: any) => walk(c, level + 1))
    }
    walk(root_, 1)
    return rows
  }

  function importOutline(rawText: string) {
    if (mode !== "edit") return
    const src = String(rawText || "").trim()
    if (!src) {
      setMsg("先粘点内容进来")
      return
    }
    const parsed = outlineToData(src)
    const rows = flattenImport(parsed?.nodeData)
    if (!rows.length) {
      setMsg("没解析出内容，检查一下缩进或列表符号")
      return
    }
    settlePendingRowText(null)
    const current = collectRows(mind.getData())
    const merged = current.concat(rows)
    const fixed: OutlineRow[] = []
    merged.forEach((r, i) => {
      if (i === 0) {
        fixed.push({ ...r, level: 0 })
        return
      }
      fixed.push({ ...r, level: Math.min(r.level, fixed[i - 1].level + 1) })
    })
    outlineRows = fixed
    applyRowsToData(outlineRows)
    refreshTakenIds()
    renderOutlineTree()
    closeImport()
    setMsg("已导入 " + rows.length + " 个节点（挂在中心主题下）")
  }

  /** 把多选状态画到行上 */
  function paintRowSelection() {
    rowEls().forEach((el) => {
      const id = el.dataset.node || ""
      el.classList.toggle("selected-row", selectedRows.size > 0 && selectedRows.has(id))
    })
  }

  function bindRowDrag(host: HTMLElement) {
    let dragId: string | null = null
    let dragSource: HTMLElement | null = null
    let lastMode = ""
    const clearMarks = () => {
      host.querySelectorAll(".mm-oline").forEach((el) => {
        el.classList.remove("dragging", "drop-before", "drop-in", "drop-after")
        // draggable 只在拖动期间挂在圆点上，收尾要摘掉，避免残留拖拽状态
        if (el !== dragSource) el.querySelector(".mm-oline-drag")?.removeAttribute("draggable")
      })
    }

    host.addEventListener("dragstart", (e) => {
      if (mode !== "edit") return
      const t = e.target as HTMLElement | null
      if (!t?.closest?.(".mm-oline-drag")) return
      const row = t.closest?.(".mm-oline") as HTMLElement | null
      if (!row) return
      if (String(row.dataset.line) === "0") {
        e.preventDefault()
        return
      }
      dragId = row.dataset.node || null
      dragSource = row
      row.classList.add("dragging")
      try {
        // 故意不用 text/plain：带文本类型时，拖到某些位置松开会被浏览器当成「用这段文字搜索」，
        // 直接弹搜索框。这里只放一个自定义类型（Firefox 要求必须 setData 才允许拖）。
        e.dataTransfer?.setData("application/x-mm-row", dragId || "")
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"
      } catch {
        /* 忽略 */
      }
    })
    host.addEventListener("dragover", (e) => {
      if (!dragId) return
      const row = (e.target as HTMLElement | null)?.closest?.(".mm-oline") as HTMLElement | null
      if (!row || row.dataset.node === dragId) return
      e.preventDefault()
      const rect = row.getBoundingClientRect()
      const rel = (e.clientY - rect.top) / Math.max(1, rect.height)
      // 中间一大片（30%~70%）都给「变成它的子项」，上下两成才是插到前面/后面。
      // 之前中间太窄，想降到下一级很难命中，感觉像「只能拖回上一级」。
      const mode = rel < 0.22 ? "before" : rel > 0.78 ? "after" : "in"
      clearMarks()
      row.classList.add("dragging")
      row.classList.add("drop-" + mode)
      // 实时告诉用户「松手会变成什么」，免得拖完才发现不是想要的效果
      if (lastMode !== mode) {
        lastMode = mode
        setMsg(
          mode === "in"
            ? "松手：变成「" + (outlineRows.find((r) => r.id === row.dataset.node)?.topic || "") + "」的子项"
            : "松手：插到「" + (outlineRows.find((r) => r.id === row.dataset.node)?.topic || "") + (mode === "before" ? "」的前面" : "」的后面"),
        )
      }
    })
    host.addEventListener("drop", (e) => {
      if (!dragId) return
      const row = (e.target as HTMLElement | null)?.closest?.(".mm-oline") as HTMLElement | null
      if (!row) return
      e.preventDefault()
      e.stopPropagation()
      const mode = row.classList.contains("drop-before") ? "before" : row.classList.contains("drop-after") ? "after" : "in"
      const src = dragId
      dragId = null
      dragSource = null
      lastMode = ""
      clearMarks()
      moveRowTo(src, row.dataset.node || "", mode as "before" | "in" | "after")
    })
    host.addEventListener("dragend", () => {
      dragId = null
      dragSource = null
      lastMode = ""
      clearMarks()
      setMsg("")
    })
  }

  /** 焦点（光标）是否已经在大纲面板里 */
  function caretInOutline(): boolean {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return false
    return !!outlineEl?.contains(sel.getRangeAt(0).startContainer)
  }

  /**
   * 拦住会「漏到画布」的按键：Tab 与 Enter。
   * 库的快捷键表里 Tab = addChild()、Enter = insertSibling()，焦点一旦不在大纲行里，
   * 这两个键就会被画布吃掉去新建节点。
   */
  function swallowOutlineKey(e: KeyboardEvent) {
    if (mode !== "edit") return
    if (e.isComposing) return // 输入法组合中（回车在选字）不要拦
    if (e.key !== "Tab" && e.key !== "Enter") return
    if (e.key === "Enter" && e.shiftKey) return // Shift+Enter 留给行内换行
    try {
      dbg("[mm] 拦下按键", { key: e.key, shift: e.shiftKey, composing: e.isComposing, inOutline: caretInOutline() })
    } catch {
      /* 忽略 */
    }
    e.preventDefault()
    e.stopPropagation()
  }

  function buildOutlineBindings() {
    const host = outlineHost
    if (!host) return
    bindRowDrag(host)

    // 选中文字 → 浮出样式工具栏（不再需要手写 ** == 之类）。
    // 只在鼠标划完选词时出现：键盘选词、点空白处都不会弹出来打扰。
    host.addEventListener("mouseup", () => window.setTimeout(syncFmtBar, 0))
    document.addEventListener("selectionchange", () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) hideFmtBar()
    })
    window.addEventListener("scroll", hideFmtBar, true)
    document.addEventListener("mousedown", (e) => {
      if (fmtBarEl?.contains(e.target as Node)) return
      hideFmtBar()
    })

    // 备注：鼠标滑到小方块上浮出气泡，点它打开编辑面板
    host.addEventListener("mouseover", (e) => {
      const icon = (e.target as HTMLElement | null)?.closest?.(".mm-oline-note") as HTMLElement | null
      if (!icon) return
      const row = icon.closest(".mm-oline") as HTMLElement | null
      const note = outlineRows.find((r) => r.id === (row?.dataset.node || ""))?.note || ""
      if (note) showNoteTip(icon, note)
    })
    host.addEventListener("mouseout", (e) => {
      if ((e.target as HTMLElement | null)?.closest?.(".mm-oline-note")) hideNoteTip()
    })
    host.addEventListener("scroll", hideNoteTip, true)
    host.addEventListener("mousedown", (e) => {
      if (mode !== "edit") return
      const icon = (e.target as HTMLElement | null)?.closest?.(".mm-oline-note") as HTMLElement | null
      if (!icon) return
      e.preventDefault()
      e.stopPropagation()
      const row = icon.closest(".mm-oline") as HTMLElement | null
      const id = row?.dataset.node || ""
      if (id) openNotePanel(id, icon)
    })

    // 大纲行右键菜单：画布的右键菜单只作用于画布节点，大纲行上没有插图入口。
    host.addEventListener("contextmenu", (e) => {
      if (mode !== "edit") return
      const row = (e.target as HTMLElement | null)?.closest?.(".mm-oline") as HTMLElement | null
      if (!row) return
      e.preventDefault()
      e.stopPropagation()
      openRowMenu(row, e.clientX, e.clientY)
    })
    document.addEventListener("mousedown", (e) => {
      if (!rowMenuEl) return
      if (rowMenuEl.contains(e.target as Node)) return
      closeRowMenu()
    })
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeRowMenu()
        closeImageView()
        closeNotePanel()
      }
    })

    // 大纲面板挂在 body 下，不在 #mm-root 里，根元素上的 paste 监听收不到它。
    // 这里补一个捕获阶段的 paste：在大纲行里贴图能落到那一行。
    host.addEventListener("paste", (e) => onPaste(e as ClipboardEvent), true)

    // Tab 必须留在面板里（不然焦点会顺着 Tab 走到画布上，而画布的 Tab 快捷键正好是
    // 「新建子节点」），但这里**只能 preventDefault**：一旦在捕获阶段 stopPropagation，
    // 下面冒泡阶段那套「回车建行 / Tab 调级 / 删除」就全收不到事件了。
    host.addEventListener(
      "keydown",
      (e) => {
        if (mode !== "edit") return
        if (e.isComposing) return
        if (e.key !== "Tab" && e.key !== "Enter") return
        if (e.key === "Enter" && e.shiftKey) return
        e.preventDefault()
      },
      true,
    )

    // 全局兜底：焦点根本不在大纲里时（点过画布、点过面板空白），Tab/Enter 也不能漏到画布上。
    // 注意：焦点在大纲里时不要在这里拦，否则会挡住我们自己的回车/调级处理。
    document.addEventListener(
      "keydown",
      (e) => {
        if (!panelOpen) return
        if (caretInOutline()) return
        // 只收拾「焦点落在画布上」这一种情况：画布才是那个把 Tab 当新建子节点的家伙。
        // 范围不收窄的话，面板开着时对话框里的回车也会被吞掉。
        if (!canvasHost.contains(e.target as Node)) return
        swallowOutlineKey(e)
      },
      true,
    )

    // 点击行（三角与缩略图除外）→ 光标直接落到这一行文字里，省得精准点字
    host.addEventListener("mousedown", (e) => {
      if (mode !== "edit") return
      const t = e.target as HTMLElement | null
      if (t?.classList.contains("mm-tri") || t?.classList.contains("mm-oline-img")) return
      if (t?.closest?.(".mm-oline-note")) return // 备注图标有自己的处理
      // 方框：切换勾选状态（不再往下走，免得把光标抢走）
      if (t?.closest?.(".mm-todo")) {
        e.preventDefault()
        e.stopPropagation()
        const todoRow = t.closest(".mm-oline") as HTMLElement | null
        if (todoRow) toggleTodoInRow(todoRow)
        return
      }
      // 圆点手柄是拖拽用的，按住它交给原生 DnD，不要抢成「放光标」
      if (t?.closest?.(".mm-oline-drag")) return
      const row = t?.closest?.(".mm-oline") as HTMLElement | null
      if (!row) return

      // 按住 Shift / Ctrl → 多选（切换选中，不进编辑）
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        e.preventDefault()
        if (String(row.dataset.line) === "0") {
          setMsg("中心主题不能参与多选")
          return
        }
        const id = row.dataset.node || ""
        if (selectedRows.has(id)) selectedRows.delete(id)
        else selectedRows.add(id)
        paintRowSelection()
        setMsg(selectedRows.size ? `已选 ${selectedRows.size} 项（Delete 批量删除、Tab 批量调级）` : "已取消多选")
        return
      }

      if (selectedRows.size) {
        selectedRows.clear()
        paintRowSelection()
      }
      const topic = row.querySelector(".mm-oline-topic") as HTMLElement | null
      if (!topic) return

      // 记住按下的位置与这一行：松手时判断这是「单击」还是「拖动划选」
      dragStartX = e.clientX
      dragStartY = e.clientY
      dragRowEl = row
      // 注意这里**不能** preventDefault：划选文字要靠浏览器的默认行为
    })

    // 松手：单击才把光标放到行尾（省得精准点字），拖动则保留用户选中的文字
    host.addEventListener("mouseup", (e) => {
      if (mode !== "edit") return
      const row = dragRowEl
      const sx = dragStartX
      const sy = dragStartY
      dragRowEl = null
      if (!row) return
      const moved = Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 4
      if (moved) return // 拖动划选：交给浏览器，别动光标
      if ((e.target as HTMLElement | null)?.closest?.(".mm-oline-drag, .mm-oline-note, .mm-oline-img, .mm-tri")) return
      const topic = row.querySelector(".mm-oline-topic") as HTMLElement | null
      if (!topic) return
      // 先聚焦再放光标（反过来某些浏览器会把光标重置掉，currentRow() 就找不到行）
      try {
        topic.focus({ preventScroll: true })
      } catch {
        /* 忽略 */
      }
      caretToTextEnd(topic)
    })

    // 大纲 → 导图：边打边同步（防抖 300ms，不依赖失焦）
    host.addEventListener("input", (e) => {
      if (mode !== "edit") return
      const row = (e.target as HTMLElement | null)?.closest?.(".mm-oline") as HTMLElement | null
      if (!row) return
      pendingRowEl = row
      if (pendingTimer !== null) window.clearTimeout(pendingTimer)
      pendingTimer = window.setTimeout(() => {
        pendingTimer = null
        pendingRowEl = null
        commitRowText(row)
      }, 300)
    })
    // 失焦兜底提交
    host.addEventListener(
      "focusout",
      (e) => {
        const target = e.target as HTMLElement | null
        if (target?.closest?.(".mm-oline-drag")) return
        const row = target?.closest?.(".mm-oline") as HTMLElement | null
        if (!row) return
        settlePendingRowText(row)
        // 提交完把这一行从「显示标记」换成「渲染样式」
        const topic = row.querySelector(".mm-oline-topic") as HTMLElement | null
        if (topic) {
          topic.innerHTML = renderInline(readTopic(topic).replace(/[ \t\u00a0]+/g, " ").trim())
        }
      },
      true,
    )

    // 键盘：Tab 调级；回车吃掉（大纲不换行）
    host.addEventListener("keydown", (e) => {
      if (mode !== "edit") return
      const row = currentRow()
      if (!row) return
      const id = row.dataset.node || ""
      const idx = outlineRows.findIndex((r) => r.id === id)
      try {
        if (["Tab", "Enter", "Backspace", "Delete"].includes(e.key)) {
          dbg("[mm] 大纲按键", { key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, idx, id, level: outlineRows[idx]?.level, selected: selectedRows.size })
        }
      } catch {
        /* 忽略 */
      }
      if (idx < 0) {
        try {
          dbg("[mm] 按键时找不到当前行（光标不在大纲行里）", { key: e.key, 光标在大纲内: caretInOutline() })
        } catch {
          /* 忽略 */
        }
        return
      }

      const mod = e.ctrlKey || e.metaKey

      // Ctrl+C / Ctrl+X：整行（连同子项）复制、剪切；选中了行内文字时让给浏览器复制文字
      if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
        if (!rowFullySelected()) return
        e.preventDefault()
        e.stopPropagation()
        copyRows(e.key.toLowerCase() === "x")
        return
      }

      // Ctrl+V：把剪贴板里的节点贴到当前行下面（同级）
      if (mod && e.key.toLowerCase() === "v") {
        if (!outlineClip?.nodes?.length) return
        e.preventDefault()
        e.stopPropagation()
        pasteRows()
        return
      }

      if (e.key === "Enter") {
        // 回车：在下面新建一项（同级），光标落到新行
        // Shift+Enter：这一项里换行（大纲里不常用，但保留）
        if (e.shiftKey) return
        e.preventDefault()
        e.stopPropagation()
        // 关键：先把这一行正在打的字落到数据里，否则重建会把上一行的文字盖回旧值
        settlePendingRowText(row)
        const cur = outlineRows[idx]
        if (!cur) return
        const fresh: OutlineRow = {
          id: nextId(),
          level: cur.level,
          topic: "",
          imgUrl: "",
          imgW: 0,
          imgH: 0,
          kids: 0,
          expanded: true,
          note: "",
        }
        outlineRows.splice(idx + 1, 0, fresh)
        applyRowsToData(outlineRows)
        renderOutlineTree()
        const next = rowEls()[idx + 1]?.querySelector(".mm-oline-topic") as HTMLElement | null
        if (next) caretToTextEnd(next)
        try {
          dbg("[mm] 回车建了新行", { idx, 新行数: outlineRows.length, 光标落到新行: !!next })
        } catch {
          /* 忽略 */
        }
        return
      }

      // 多选状态：Delete/Backspace 批量删除
      if ((e.key === "Backspace" || e.key === "Delete") && selectedRows.size) {
        e.preventDefault()
        e.stopPropagation()
        const before = outlineRows.length
        outlineRows = outlineRows.filter((r) => !selectedRows.has(r.id))
        const removed = before - outlineRows.length
        selectedRows.clear()
        applyRowsToData(outlineRows)
        renderOutlineTree()
        setMsg(`已删除 ${removed} 项`)
        return
      }

      // 多选状态：Tab / Shift+Tab 批量调级
      if (e.key === "Tab" && selectedRows.size) {
        e.preventDefault()
        e.stopPropagation()
        const sign = e.shiftKey ? -1 : 1
        outlineRows = outlineRows.map((r) =>
          selectedRows.has(r.id) ? { ...r, level: Math.max(1, r.level + sign) } : r,
        )
        // 修正越级
        const fixed: OutlineRow[] = []
        outlineRows.forEach((r, i) => {
          if (i === 0) {
            fixed.push({ ...r, level: 0 })
            return
          }
          fixed.push({ ...r, level: Math.min(r.level, (fixed[i - 1]?.level ?? 0) + 1) })
        })
        outlineRows = fixed
        applyRowsToData(outlineRows)
        renderOutlineTree()
        paintRowSelection()
        setMsg(`${selectedRows.size} 项已${sign > 0 ? "降级" : "升级"}`)
        return
      }

      if (e.key === "Backspace" || e.key === "Delete") {
        // 删除这一项（含它的子项）；中心主题不能删
        const topicEl = row.querySelector(".mm-oline-topic") as HTMLElement | null
        const textNow = (topicEl?.textContent || "").replace(/\s+/g, " ").trim()
        const sel = window.getSelection()
        const selectedAll = !!sel && !sel.isCollapsed && (sel.toString() || "").length > 0
        // 内容为空，或当前选中了内容 → 视为删整行；否则交给浏览器删字符
        if (!textNow || selectedAll) {
          e.preventDefault()
          e.stopPropagation()
          // 删行同样会整表重建，先结算待提交的文字
          settlePendingRowText(row)
          if (idx === 0) {
            setMsg("中心主题不能删除")
            return
          }
          const cur = outlineRows[idx]
          const removed = cur ? cur.kids + 1 : 1
          outlineRows.splice(idx, 1)
          applyRowsToData(outlineRows)
          renderOutlineTree()
          const prev = rowEls()[Math.max(0, idx - 1)]?.querySelector(".mm-oline-topic") as HTMLElement | null
          if (prev) caretToTextEnd(prev)
          setMsg(removed > 1 ? `已删除该节点及其 ${removed - 1} 个子项` : "已删除该节点")
        }
        return
      }

      if (e.key === "Tab") {
        e.preventDefault()
        e.stopPropagation()
        // 调级会整表重建，先结算待提交的文字
        settlePendingRowText(row)
        const cur = outlineRows[idx]
        if (!cur || idx === 0) return // 中心主题不动
        if (e.shiftKey) {
          cur.level = Math.max(1, cur.level - 1)
        } else {
          const prev = outlineRows[idx - 1]
          const maxLevel = prev ? prev.level + 1 : 1
          if (cur.level >= maxLevel) {
            setMsg("已经是上一项的子级了")
            return
          }
          cur.level = Math.min(maxLevel, cur.level + 1)
        }
        applyRowsToData(outlineRows)
        renderOutlineTree()
        const topic = rowEls()[idx]?.querySelector(".mm-oline-topic") as HTMLElement | null
        if (topic) caretToTextEnd(topic)
        setMsg("已调为第 " + (cur.level + 1) + " 级")
        return
      }
    })
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
    // 导图区让出左侧空间（右侧实时成图）
    canvasHost.classList.toggle("outline-open", open)
    scheduleFit(320) // 可用宽度变了，重新居中并缩放
    if (open) {
      refreshOutline()
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
  /** 大纲标题旁的图片数量 + 缩略图区（点缩略图会选中对应节点） */
  /** 面板整体刷新：行列表 + 缩略图条 + 计数 */
  function refreshOutline() {
    if (!outlineEl) return
    outlineRows = collectRows(mind.getData())
    renderOutlineTree()
    renderOutlineThumbs(mind.getData())
    updateOutlineImageCount()
  }

  /* ---------------- 行内图片的大图预览 ---------------- */
  let imgViewEl: HTMLElement | null = null

  function closeImageView() {
    imgViewEl?.classList.remove("show")
  }

  function showImageView(src: string) {
    if (!src) return
    if (!imgViewEl) {
      const box = document.createElement("div")
      box.id = "mm-imgview"
      box.innerHTML = '<img alt=""><div class="tip">点击任意处关闭</div>'
      box.addEventListener("click", closeImageView)
      document.body.appendChild(box)
      imgViewEl = box
    }
    const img = imgViewEl.querySelector("img") as HTMLImageElement | null
    if (img) img.src = src
    imgViewEl.classList.add("show")
  }

  /* ---------------- 大纲行的右键菜单（插入 / 移除图片） ---------------- */
  let rowMenuEl: HTMLElement | null = null
  let rowMenuTarget: HTMLElement | null = null

  function closeRowMenu() {
    rowMenuEl?.classList.remove("show")
    rowMenuTarget = null
  }

  function ensureRowMenu(): HTMLElement {
    if (rowMenuEl) return rowMenuEl
    const menu = document.createElement("div")
    menu.className = "mm-rowmenu"
    menu.innerHTML =
      '<button type="button" data-act="img-add">插入图片<span>或直接 Ctrl+V</span></button>' +
      '<button type="button" data-act="img-remove">移除这一行的图片</button>' +
      '<button type="button" data-act="img-view">查看图片</button>'
    document.body.appendChild(menu)
    menu.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement | null)?.closest?.("[data-act]") as HTMLElement | null
      const act = btn?.dataset.act || ""
      const row = rowMenuTarget
      const id = row?.dataset.node || ""
      closeRowMenu()
      if (!id || !act) return
      if (act === "img-add") {
        pendingOutlineImageRow = id
        pickImage()
        return
      }
      if (act === "img-remove") {
        removeImageById(id)
        return
      }
      if (act === "img-view") {
        const url = row?.querySelector(".mm-oline-img")?.getAttribute("src") || ""
        if (url) window.open(url, "_blank")
      }
    })
    rowMenuEl = menu
    return menu
  }

  function openRowMenu(row: HTMLElement, x: number, y: number) {
    const menu = ensureRowMenu()
    rowMenuTarget = row
    const hasImg = !!row.querySelector(".mm-oline-img")
    const viewBtn = menu.querySelector('[data-act="img-view"]') as HTMLButtonElement | null
    const rmBtn = menu.querySelector('[data-act="img-remove"]') as HTMLButtonElement | null
    if (viewBtn) viewBtn.style.display = hasImg ? "flex" : "none"
    if (rmBtn) rmBtn.disabled = !hasImg
    menu.classList.add("show")
    const w = menu.offsetWidth || 220
    const h = menu.offsetHeight || 110
    menu.style.left = Math.min(x, window.innerWidth - w - 8) + "px"
    menu.style.top = Math.min(y, window.innerHeight - h - 8) + "px"
  }

  /** 按节点 id 移除图片（大纲右键菜单用） */
  function removeImageById(id: string) {
    if (mode !== "edit" || !id) return
    const data = mind.getData() as any
    const node = findNodeIn(data?.nodeData, id)
    if (!node) return
    if (!node.image) {
      setMsg("这一行没有图片")
      return
    }
    delete node.image
    ;(mind as any).refresh(data)
    dirty = true
    outlineRows = collectRows(mind.getData())
    renderOutlineTree()
    setMsg("已移除图片")
  }

  /** 同步图片计数（顶部标题旁） */
  function updateOutlineImageCount(data?: any) {
    const cnt = outlineEl?.querySelector("#mmOutlineImgCnt") as HTMLElement | null
    if (!cnt) return
    let n = 0
    const walk = (node: any) => {
      if (node?.image) n++
      ;(node?.children || []).forEach(walk)
    }
    walk((data || mind.getData())?.nodeData)
    cnt.textContent = n ? ` · 图片 ${n}` : ""
  }

  /** 缩略图条：面板顶部（保留原有能力） */
  function renderOutlineThumbs(data: any) {
    const box = outlineEl?.querySelector("#mmOutlineImages") as HTMLElement | null
    if (!box) return
    const items: Array<{ id: string; topic: string; url: string }> = []
    const walk = (node: any) => {
      const img = node?.image
      const url = typeof img?.url === "string" ? img.url : ""
      if (url) items.push({ id: String(node.id ?? ""), topic: String(node.topic ?? "").slice(0, 24), url })
      ;(node?.children || []).forEach(walk)
    }
    walk(data?.nodeData ?? data)
    if (!items.length) {
      box.hidden = true
      box.innerHTML = ""
      return
    }
    box.hidden = false
    box.innerHTML = items
      .map(
        (it) =>
          '<button type="button" class="mm-oimg" data-node="' + it.id + '" title="' + it.topic + '">' +
          '<img src="' + it.url + '" alt="" loading="lazy">' +
          '<span class="t">' + (it.topic || "未命名") + "</span></button>",
      )
      .join("")
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
  // 折叠相关的现场诊断：控制台执行 __mmFoldDiag() 会打印所有关键状态
  ;(window as any).__mmFoldDiag = () => {
    const host = document.querySelector(".mm-outline-tree") as HTMLElement | null
    const tris = Array.from(document.querySelectorAll(".mm-outline-tree .mm-tri")) as HTMLElement[]
    const mepd = Array.from(document.querySelectorAll("me-epd"))
    const first = tris.find((x) => !x.classList.contains("empty")) || tris[0] || null
    const cs = first ? getComputedStyle(first) : null
    const out = {
      有大纲容器: !!host,
      大纲行数: document.querySelectorAll(".mm-outline-tree .mm-oline").length,
      三角个数: tris.length,
      画布展开按钮个数: mepd.length,
      第一个三角: first
        ? {
            text: first.textContent,
            cls: first.className,
            pointerEvents: cs?.pointerEvents,
            display: cs?.display,
            visibility: cs?.visibility,
            opacity: cs?.opacity,
            size: cs ? cs.width + "x" + cs.height : "",
            rect: first.getBoundingClientRect().toJSON(),
          }
        : null,
      导图可编辑: (mind as any).editable,
      数据里的折叠状态: outlineRows.map((r) => ({ id: r.id, kids: r.kids, expanded: r.expanded })),
    }
    dbg("[mm] 折叠诊断", out)
    return out
  }
  // 图片专项诊断：控制台执行 __mmImgDiag()
  ;(window as any).__mmImgDiag = () => {
    const data = mind.getData() as any
    const nodes: any[] = []
    const walk = (n: any, lv: number) => {
      if (!n) return
      if (n.image) {
        const u = String(n.image.url || "")
        nodes.push({
          层级: lv,
          id: n.id,
          主题: String(n.topic || "").slice(0, 18),
          图片地址: u.slice(0, 64),
          地址类型: u.startsWith("blob:") ? "blob(未上传)" : u.startsWith("data:") ? "data" : u.startsWith("img-") ? "fid(需解析)" : u.startsWith("/") ? "路径" : "其它",
          尺寸: (n.image.width || 0) + "x" + (n.image.height || 0),
        })
      }
      ;(n.children || []).forEach((c: any) => walk(c, lv + 1))
    }
    walk(data?.nodeData, 0)
    const imgs = Array.from(document.querySelectorAll(".mm-outline-tree .mm-oline-img")) as HTMLImageElement[]
    const out = {
      数据里有图的节点数: nodes.length,
      节点明细: nodes,
      大纲行数: document.querySelectorAll(".mm-outline-tree .mm-oline").length,
      行内缩略图个数: imgs.length,
      缩略图明细: imgs.map((im) => {
        const r = im.getBoundingClientRect()
        const cs = getComputedStyle(im)
        return {
          src: (im.getAttribute("src") || "").slice(0, 48),
          已加载: im.complete && im.naturalWidth > 0,
          原始尺寸: im.naturalWidth + "x" + im.naturalHeight,
          显示尺寸: Math.round(r.width) + "x" + Math.round(r.height),
          在视口内: r.top < window.innerHeight && r.bottom > 0,
          样式: cs.display + "/" + cs.visibility + "/opacity" + cs.opacity,
        }
      }),
      大纲面板是否打开: panelOpen,
      当前模式: mode,
    }
    dbg("[mm] 图片诊断", out)
    return out
  }

  // 连线诊断：控制台执行 __mmLinkDiag()，确认连线/概要数据还在、画布也画出来了
  ;(window as any).__mmLinkDiag = () => {
    const data = mind.getData() as any
    const canvas = document.querySelector("#mm-root .map-container") || document.querySelector(".map-container")
    const arrows = Array.isArray(data?.arrows) ? data.arrows : []
    const summaries = Array.isArray(data?.summaries) ? data.summaries : []
    const out = {
      连线数据条数: arrows.length,
      连线明细: arrows.map((a: any) => ({ from: a.from, to: a.to, label: a.label || "" })).slice(0, 20),
      概要数据条数: summaries.length,
      画布连线节点数: canvas ? canvas.querySelectorAll(".topiclinks > g, #topiclinks > g, svg .topiclinks g").length : -1,
      画布svg数: canvas ? canvas.querySelectorAll("svg").length : -1,
      连线容器存在: !!(canvas && canvas.querySelector(".topiclinks, .subLines, .lines")),
      当前模式: mode,
    }
    dbg("[mm] 连线诊断", out)
    console.log("[mm] 连线诊断", out)
    return out
  }

  // 直接跑一次折叠（不经过点击），用来区分「点击没生效」还是「折叠本身没生效」
  ;(window as any).__mmFoldTest = () => {
    const tri = document.querySelector(".mm-outline-tree .mm-tri:not(.empty)") as HTMLElement | null
    if (!tri) {
      dbg("[mm] 没有可折叠的三角：当前大纲里所有节点都没有子项")
      return null
    }
    const row = tri.closest(".mm-oline") as HTMLElement | null
    const id = row?.dataset.node || ""
    const before = outlineRows.find((r) => r.id === id)
    dbg("[mm] 折叠前", { id, expanded: before?.expanded, kids: before?.kids })
    const btn = tri as HTMLElement
    btn.click()
    const after = outlineRows.find((r) => r.id === id)
    dbg("[mm] 折叠后", { id, expanded: after?.expanded, rows: outlineRows.length })
    return { id, before: before?.expanded, after: after?.expanded, rows: outlineRows.length }
  }

  // 粘贴图片：库把 paste 交给 mind.pasteHandler；再在根元素补一个捕获监听
  ;(mind as any).pasteHandler = onPaste
  el.addEventListener("paste", (e) => onPaste(e as ClipboardEvent), true)

  /* ---------------- 按住鼠标中键拖动画布 ---------------- */
  try {
    let panning = false
    let panX = 0
    let panY = 0
    let panMoved = 0

    const onPanDown = (e: PointerEvent) => {
      if (e.button !== 1) return // 中键
      if (e.ctrlKey || e.metaKey) return // Ctrl+中键 交给缩放
      panning = true
      panX = e.clientX
      panY = e.clientY
      panMoved = 0
      // 中键还有「自动滚动」的默认行为，必须掐掉；库只处理左键，这里不会和它打架
      e.preventDefault()
      e.stopPropagation()
      canvasHost.classList.add("mm-panning")
      try {
        canvasHost.setPointerCapture(e.pointerId)
      } catch {
        /* 忽略 */
      }
    }

    const onPanMove = (e: PointerEvent) => {
      if (!panning) return
      e.preventDefault()
      e.stopPropagation()
      const dx = e.clientX - panX
      const dy = e.clientY - panY
      panX = e.clientX
      panY = e.clientY
      panMoved += Math.abs(dx) + Math.abs(dy)
      try {
        // 用库自己的 move：它会做边界夹取并更新内联 transform，缩放/高亮都不会乱
        ;(mind as any).move?.(dx, dy)
      } catch {
        /* 忽略 */
      }
    }

    const onPanUp = () => {
      if (!panning) return
      panning = false
      canvasHost.classList.remove("mm-panning")
      dbg("[mm] 中键平移结束", { 移动距离: Math.round(panMoved) })
    }

    canvasHost.addEventListener("pointerdown", onPanDown, true)
    canvasHost.addEventListener("pointermove", onPanMove, true)
    canvasHost.addEventListener("pointerup", onPanUp, true)
    canvasHost.addEventListener("pointercancel", onPanUp, true)
    window.addEventListener("pointerup", onPanUp, true)
    // 中键点下去浏览器可能弹「自动滚动」圆盘，压掉它
    canvasHost.addEventListener("auxclick", (e) => {
      if (e.button === 1) e.preventDefault()
    })
    window.addEventListener("blur", onPanUp)
  } catch {
    /* 忽略：拖动只是便利功能，不行也不影响别的 */
  }

  /* ---------------- 按住 Ctrl 拖动鼠标缩放 ---------------- */
  try {
    let zooming = false
    let zStartX = 0
    let zStartY = 0
    let zStartScale = 1
    let zTx = 0
    let zTy = 0

    const mapEl = () => canvasHost.querySelector(".map-canvas") as HTMLElement | null
    /** 从内联 transform 里取出平移量（库自己解析时也是只认 translate3d 的前两个参数） */
    const parseT = (el: HTMLElement) => {
      const m = /translate3d\(([^,]+),\s*([^,]+)/.exec(el.style.transform || "")
      return { x: m ? parseFloat(m[1]) : 0, y: m ? parseFloat(m[2]) : 0 }
    }

    /** 以 (px,py) 为中心缩放到 newScale：与库内部算法一致，这样库后续的平移/缩放不会跳 */
    const applyZoom = (newScale: number, px: number, py: number) => {
      const el = mapEl()
      if (!el) return
      const s = Math.max(0.2, Math.min(2.2, newScale))
      const rect = canvasHost.getBoundingClientRect()
      // 与库内部的 scale 算法一致：以「相对容器中心」的偏移为基准做补偿，
      // 这样缩放后库自己的平移/滚轮缩放不会跳位。
      const ox = px - rect.left - rect.width / 2
      const oy = py - rect.top - rect.height / 2
      const k = 1 - s / zStartScale
      const tx = zTx - (-ox + zTx) * k
      const ty = zTy - (-oy + zTy) * k
      el.style.transform = "translate3d(" + tx + "px, " + ty + "px, 0) scale(" + s + ")"
      ;(mind as any).scaleVal = s
      dbg("[mm] ctrl 拖动缩放", { 目标: Number(s.toFixed(3)), 起点: Number(zStartScale.toFixed(3)) })
    }

    const onDown = (e: PointerEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      if (e.button !== 0) return
      const el = mapEl()
      if (!el) return
      zooming = true
      zStartX = e.clientX
      zStartY = e.clientY
      zStartScale = Number((mind as any).scaleVal) || 1
      const t = parseT(el)
      zTx = t.x
      zTy = t.y
      // 捕获阶段就掐掉：库的 mousedown 是后注册的，这样它连开始都做不到
      e.preventDefault()
      e.stopPropagation()
      canvasHost.classList.add("mm-zooming")
      dbg("[mm] ctrl 按下", { 起点缩放: zStartScale, 平移: t })
      try {
        canvasHost.setPointerCapture(e.pointerId)
      } catch {
        /* 忽略 */
      }
    }

    const onMove = (e: PointerEvent) => {
      if (!zooming) return
      e.preventDefault()
      e.stopPropagation()
      // 横向 260px 约等于缩放一倍；纵向做少量微调（更好控制）
      const delta = (e.clientX - zStartX) / 260 + (e.clientY - zStartY) / 900
      applyZoom(zStartScale * (1 + delta), zStartX, zStartY)
    }

    const onUp = () => {
      if (!zooming) return
      zooming = false
      canvasHost.classList.remove("mm-zooming")
    }

    canvasHost.addEventListener("pointerdown", onDown, true)
    canvasHost.addEventListener("pointermove", onMove, true)
    canvasHost.addEventListener("pointerup", onUp, true)
    canvasHost.addEventListener("pointercancel", onUp, true)
    // 指针跑出容器也要收尾
    window.addEventListener("pointerup", onUp, true)

    // 按住 Ctrl 时给个「可缩放」的光标提示
    document.addEventListener("keydown", (e) => {
      if (e.key === "Control" || e.key === "Meta") canvasHost.classList.add("mm-zoom-ready")
    })
    document.addEventListener("keyup", (e) => {
      if (e.key === "Control" || e.key === "Meta") canvasHost.classList.remove("mm-zoom-ready")
    })
    window.addEventListener("blur", () => {
      onUp()
      canvasHost.classList.remove("mm-zoom-ready")
    })
  } catch {
    /* 忽略：缩放只是便利功能，不行也不影响别的 */
  }
  /* ---------------- 选区工具栏：选中文字后浮出来套样式 ---------------- */
  let fmtBarEl: HTMLElement | null = null
  const FMT_BTNS: Array<{ mark: string; label: string; title: string }> = [
    { mark: "**", label: "粗", title: "加粗" },
    { mark: "==", label: "高", title: "高亮" },
    { mark: "~~", label: "删", title: "删除线" },
    { mark: "__", label: "下", title: "下划线" },
    { mark: "todo", label: "框", title: "加单选框（待办）" },
  ]

  function hideFmtBar() {
    fmtBarEl?.classList.remove("show")
  }

  function ensureFmtBar(): HTMLElement {
    if (fmtBarEl) return fmtBarEl
    const bar = document.createElement("div")
    bar.className = "mm-fmtbar"
    bar.innerHTML = FMT_BTNS.map((b) =>
      '<button type="button" data-mark="' + b.mark + '" title="' + b.title + '">' + b.label + "</button>",
    ).join("")
    bar.addEventListener("mousedown", (e) => {
      // 别让工具栏自己的点击把选区清掉
      e.preventDefault()
      e.stopPropagation()
    })
    bar.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement | null)?.closest?.("[data-mark]") as HTMLElement | null
      const mark = btn?.dataset.mark || ""
      if (mark) applyMark(mark)
    })
    document.body.appendChild(bar)
    fmtBarEl = bar
    return bar
  }

  /** 读到当前选择区文本（在行内且非折叠时返回） */
  function readSelInRow(): { rowId: string; selText: string; mark: string } | null {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    const range = sel.getRangeAt(0)
    const row = (range.startContainer instanceof HTMLElement
      ? range.startContainer
      : range.startContainer.parentElement)?.closest?.(".mm-oline") as HTMLElement | null
    if (!row) return null
    const topic = row.querySelector(".mm-oline-topic") as HTMLElement | null
    if (!topic || !topic.contains(range.commonAncestorContainer)) return null
    const selText = (sel.toString() || "").trim()
    if (!selText) return null
    // 选区是否已经包在某个样式里（决定按钮是否高亮）
    const host = (range.startContainer instanceof HTMLElement
      ? range.startContainer
      : range.startContainer.parentElement) as HTMLElement | null
    const holder = host?.closest?.(".mm-b, .mm-mark, .mm-del, .mm-u") as HTMLElement | null
    const cls = holder?.className || ""
    const mark = cls.includes("mm-mark") ? "==" : cls.includes("mm-b") ? "**" : cls.includes("mm-del") ? "~~" : cls.includes("mm-u") ? "__" : ""
    return { rowId: row.dataset.node || "", selText, mark }
  }

  /** 选区字符偏移（相对整行文字） */
  function selOffsets(topic: HTMLElement): { start: number; end: number } | null {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return null
    const range = sel.getRangeAt(0)
    const before = document.createRange()
    before.selectNodeContents(topic)
    try {
      before.setEnd(range.startContainer, range.startOffset)
    } catch {
      return null
    }
    const start = before.toString().length
    const len = (sel.toString() || "").length
    return { start, end: start + len }
  }

  /** 给当前行（或选中的行）加单选框前缀；已有就去掉 */
  function addTodoToRow() {
    if (mode !== "edit") return
    const row = currentRow() || lastFmtRowEl
    if (!row) {
      setMsg("先把光标放到某一行")
      return
    }
    const id = row.dataset.node || ""
    if (!id) return
    const data = mind.getData() as any
    const node = findNodeIn(data?.nodeData, id)
    if (!node) return
    const body = String(node.topic || "")
    const has = TODO_PREFIX_RE.test(body)
    node.topic = has ? body.replace(TODO_PREFIX_RE, "") : "[ ] " + body
    ;(mind as any).refresh(data)
    dirty = true
    outlineRows = collectRows(mind.getData())
    renderOutlineTree()
    hideFmtBar()
    setMsg(has ? "已去掉单选框" : "已加单选框")
  }

  /** 给选区套/去标记 */
  function applyMark(mark: string) {
    if (mode !== "edit") return
    if (mark === "todo") {
      addTodoToRow()
      return
    }
    const sel = readSelInRow()
    if (!sel) return
    const topic = currentRow()?.querySelector(".mm-oline-topic") as HTMLElement | null
    if (!topic) return
    const off = selOffsets(topic)
    if (!off) return
    const full = readTopic(topic)
    const seg = full.slice(off.start, off.end)
    if (!seg) return
    const already = seg.startsWith(mark) && seg.endsWith(mark) && seg.length > mark.length * 2
    const next = already
      ? full.slice(0, off.start) + seg.slice(mark.length, seg.length - mark.length) + full.slice(off.end)
      : full.slice(0, off.start) + mark + seg + mark + full.slice(off.end)
    topic.innerHTML = renderInline(next)
    const rowEl = currentRow() || lastFmtRowEl
    if (rowEl) commitRowText(rowEl)
    hideFmtBar()
    setMsg(already ? "已取消样式" : "已套用样式")
  }

  let lastFmtRowEl: HTMLElement | null = null

  /** 根据选区更新工具栏显示 */
  function syncFmtBar() {
    if (mode !== "edit") {
      hideFmtBar()
      return
    }
    const row = currentRow()
    if (row) lastFmtRowEl = row
    const info = readSelInRow()
    if (!info) {
      hideFmtBar()
      return
    }
    const bar = ensureFmtBar()
    bar.querySelectorAll<HTMLElement>("[data-mark]").forEach((b) => {
      b.classList.toggle("on", b.dataset.mark === info.mark)
    })
    const r = window.getSelection()?.getRangeAt(0).getBoundingClientRect()
    if (!r) return
    bar.classList.add("show")
    const w = bar.offsetWidth || 200
    const h = bar.offsetHeight || 40
    bar.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + "px"
    bar.style.top = Math.max(8, r.top - h - 8) + "px"
  }

  /* ---------------- 专注模式：只在画布上盯着一个分支看 ---------------- */
  let focusBarEl: HTMLElement | null = null

  function hideFocusBar() {
    focusBarEl?.classList.remove("show")
  }

  function showFocusBar() {
    if (!focusBarEl) {
      const wrap = document.createElement("div")
      wrap.className = "mm-focusbar"
      wrap.innerHTML =
        '<span class="txt">专注模式：画布上只显示这一个分支</span>' +
        '<button type="button">退出专注</button>'
      wrap.addEventListener("click", (e) => {
        if (!(e.target as HTMLElement | null)?.closest?.("button")) return
        e.preventDefault()
        e.stopPropagation()
        exitFocus()
      })
      document.body.appendChild(wrap)
      focusBarEl = wrap
    }
    focusBarEl.classList.add("show")
  }

  /** 退出专注：先拿完整数据再取消，避免取消后拿到的是子树 */
  function exitFocus() {
    try {
      const full = (mind as any).getData?.()
      ;(mind as any).cancelFocus?.()
      // cancelFocus 内部会 refresh 一次完整数据；这里不额外写回，免得盖掉它自己的恢复
      void full
    } catch {
      /* 忽略 */
    }
    hideFocusBar()
    setMsg("已退出专注")
  }

  /*
   * 点带图片的节点开始改文字时，库会执行 `e.style.opacity = "0"` 把整个节点内容
   * （图片也在一起）隐藏掉，所以看起来像「一点图片就没了」。
   * 这里在 beginEdit 之后把节点内容恢复成半透明：图片留着当参照，编辑框照常压在上面，
   * 输入的文字依然清晰可读。编辑结束时库自己会把透明度恢复成 1。
   */
  // 专注模式没有事件可用（库只在 focusNode/cancelFocus 里改 isFocusMode），
  // 所以盯画布的 DOM：进/出专注都会重排，变化后同步一次提示条。
  try {
    let focusCheckTimer: number | null = null
    const syncFocusBar = () => {
      if (focusCheckTimer !== null) window.clearTimeout(focusCheckTimer)
      focusCheckTimer = window.setTimeout(() => {
        focusCheckTimer = null
        try {
          if ((mind as any).isFocusMode) showFocusBar()
          else hideFocusBar()
        } catch {
          /* 忽略 */
        }
      }, 260)
    }
    new MutationObserver(syncFocusBar).observe(canvasHost, { childList: true, subtree: true })
  } catch {
    /* 忽略 */
  }

  try {
    ;(mind as any).bus?.addListener?.("operation", (ev: any) => {
      if (ev?.name === "finishEdit") {
        // 编辑结束：库会把节点内容恢复成不透明，这里顺手清掉临时标记
        try {
          document.querySelectorAll("me-tpc").forEach((el) => {
            const h = el as HTMLElement
            delete (h as any)._mmEditingOpaque
            if (h.style.getPropertyPriority("opacity") === "important") h.style.removeProperty("opacity")
          })
        } catch {
          /* 忽略 */
        }
        return
      }
      if (ev?.name !== "beginEdit") return
      const node = ev.obj
      if (!node?.image) return
      // 编辑框要等库挂上去之后再找
      window.setTimeout(() => {
        try {
          // 从光标所在元素往上找这一次的编辑框，避免误伤别的节点
          let box: HTMLElement | null = (document.activeElement as HTMLElement | null) || null
          while (box && box.id !== "input-box") box = box.parentElement
          if (!box) box = document.querySelector("#input-box") as HTMLElement | null
          if (!box) return
          const tpc = box.parentElement?.querySelector("me-tpc") as HTMLElement | null
          if (!tpc) return
          (tpc as any)._mmEditingOpaque = "0"
          tpc.style.setProperty("opacity", "0.28", "important")
        } catch {
          /* 忽略 */
        }
      }, 0)
    })
  } catch {
    /* 忽略 */
  }

  // 导图内部一变（拖节点、右键操作、快捷键），把大纲也刷新一遍
  try {
    ;(mind as any).bus?.addListener?.("operation", () => {
      if (panelOpen) refreshOutline()
    })
  } catch {
    /* 忽略 */
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
