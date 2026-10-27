/*
 * 节点图 · 宿主补丁（注入位置：Weave 主脚本末尾，启动完成后执行）
 *
 * 职责：
 *   1. 接管存储——Weave 原本把存档写 localStorage，这里换成博客后端的 /api/graph
 *   2. 只读 / 编辑两种模式（?edit=1 才是编辑）
 *   3. 保存结果反馈（toast + 与父页面通信）
 *
 * 注入方式见 scripts/build-graph.mjs：上游 Weave 一行不改，靠覆盖 App 方法实现。
 *
 * 覆盖点（上游若重命名这几个方法，构建脚本会报错，不会静默产出坏页面）：
 *   App._lsGet / App._lsGetJson / App._lsSet   —— 存储三件套
 *   App._prepareSerializedData / App._commitSerialized —— 数据装入（导入同一条路径）
 */
(function () {
  var App = window.App;
  if (!App) return;

  var qs = new URLSearchParams(location.search);
  var noteId = (qs.get("id") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  // 不带 id：当作单纯的 Weave 在线工具用（存档留在本地 localStorage），完全不接管
  if (!noteId) return;

  var isEdit = qs.get("edit") === "1";
  var embedded = window.parent !== window;

  /* ── 存档键 ──
     只接管节点图这一份（flow_data）。时序图（flow_data_seq）本期不开放：
     写入直接丢弃、读取返回空，并隐藏模式切换入口，避免把两种文档混进同一份存档。 */
  var DOC_KEY = "flow_data";
  var SEQ_KEY = "flow_data_seq";

  var st = {
    loaded: false, // 服务端数据是否已装入（未装入前禁止写回，否则空画布会覆盖线上数据）
    saving: false,
    dirty: false,
    baseRev: 0,
    meta: null,
    editKey: "",
    graphDoc: null, // 节点图存档（flow_data）
    seqDoc: null, // 时序图存档（flow_data_seq）
    timer: 0
  };

  /* ══════════ 1. 存储接管 ══════════ */

  /**
   * 后台登录后 localStorage 里有 admin_key（与 mindmap / excalidraw 同一套约定）。
   * 本页是后台编辑页的同源 iframe，能直接读到它；不带这个头，服务端会把我们当匿名访客，
   * 新建节点图时直接回「仅管理员可创建新节点图」，已存在的图也只能在「公开可编辑且无口令」时才写得动。
   */
  function adminHeaders() {
    var h = {};
    try {
      var k = localStorage.getItem("admin_key") || "";
      if (k) h["X-Admin-Key"] = k;
    } catch (e) {
      /* 隐私模式读不到就算了 */
    }
    return h;
  }

  var rawLsGet = App._lsGet.bind(App);
  var rawLsGetJson = App._lsGetJson.bind(App);
  var rawLsSet = App._lsSet.bind(App);

  // 存档键一律当作"本地没有"：数据只从服务端来，避免读到上一个节点图的残留。
  App._lsGet = function (key) {
    if (key === DOC_KEY || key === SEQ_KEY) return null;
    return rawLsGet(key);
  };
  // _lsGetJson 内部直接读 localStorage，不经过 _lsGet，所以必须单独覆盖。
  App._lsGetJson = function (key) {
    if (key === DOC_KEY || key === SEQ_KEY) return null;
    return rawLsGetJson(key);
  };
  // 写入：存档键只**暂存并标记未保存**，不自动上传。
  // 保存是手动的（后台右侧侧边栏的「保存」按钮）—— 自动保存会在每次拖动后产生一串历史快照。
  // 设置类键（语言、键位、自定义色）仍走本地。
  //
  // 两种画布模式各持一份文档：flow_data = 节点图，flow_data_seq = 时序图。
  // 分别暂存，保存时合并成一份提交（服务端只认一个 data 对象）。
  App._lsSet = function (key, value) {
    if (key !== DOC_KEY && key !== SEQ_KEY) return rawLsSet(key, value);
    if (!isEdit) return true; // 只读态不产生任何写入
    if (!st.loaded) return true; // 数据还没装进来，先把写入丢掉，防止空画布覆盖线上
    stageSave(key, value);
    return true; // 乐观返回：Weave 的 saveCanvas 据此认为"存住了"，真正结果由保存按钮反馈
  };

  /* ══════════ 2. 保存（手动触发） ══════════ */

  /** 按模式暂存待保存内容，并标记未保存 */
  function stageSave(key, jsonText) {
    var parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return; // 解析不了就别传上去
    }
    if (key === SEQ_KEY) st.seqDoc = parsed;
    else st.graphDoc = parsed;
    st.dirty = true;
    updateSaveBtn();
  }

  /**
   * 组装提交体：节点图放在顶层（与老数据同一位置，向后兼容），时序图放进 sequence 字段。
   * 两份都带上，避免"只改了时序图"时把节点图覆盖成空。
   */
  function buildPayload() {
    var base = st.graphDoc ? JSON.parse(JSON.stringify(st.graphDoc)) : { nodes: [], connections: [], regions: [] };
    if (st.seqDoc) base.sequence = st.seqDoc;
    else if (st.seqDoc === null && base.sequence) delete base.sequence;
    return base;
  }

  /**
   * 真正发请求保存。返回 Promise<boolean>：true = 已存 / 无需保存，false = 失败。
   * 宿主（后台编辑页）的「保存」按钮依赖这个返回值决定要不要继续存文章记录。
   */
  function flush(force) {
    if (!st.dirty || st.saving) return Promise.resolve(true);
    st.dirty = false;
    var body = { data: buildPayload(), baseRev: st.baseRev };
    if (st.meta && st.meta.hasKey && st.editKey) body.editKey = st.editKey;
    if (force) body.force = 1;
    st.saving = true;
    setStatus("保存中…");
    updateSaveBtn();

    return fetch("/api/graph?id=" + encodeURIComponent(noteId), {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, adminHeaders()),
      body: JSON.stringify(body),
      // 离开页面时的那次保存要能发出去
      keepalive: !!force,
    })
      .then(function (res) {
        return res.json().then(function (d) {
          return { status: res.status, d: d };
        });
      })
      .then(function (r) {
        st.saving = false;
        if (r.status === 409) {
          // 别人先存过：拉最新 rev 后强制覆盖（与导图同一套策略）
          st.baseRev = Number(r.d.latestRev) || st.baseRev;
          st.dirty = true;
          toast("检测到他人更新，正在以当前内容覆盖…", "warning");
          return flush(true);
        }
        if (r.status !== 200 || r.d.status !== "success") {
          st.dirty = true;
          var msg = (r.d && r.d.message) || "保存失败（" + r.status + "）";
          // 权限问题给出可操作的提示：这是后台登录态才该出现的分支
          if (r.status === 401 || r.status === 403) {
            msg += "　（后台登录可能已过期，回到后台重新登录后再保存）";
          }
          toast(msg, "error");
          setStatus("保存失败：" + msg);
          updateSaveBtn();
          post({ type: "graph-save", ok: false, message: msg, id: noteId });
          return false;
        }
        st.baseRev = Number(r.d.rev) || st.baseRev;
        var t = new Date().toLocaleTimeString();
        setStatus("已保存 rev " + st.baseRev + " · " + t);
        toast("已保存 rev " + st.baseRev, "success");
        updateSaveBtn();
        post({ type: "graph-save", ok: true, rev: st.baseRev, id: noteId });
        return true;
      })
      .catch(function (err) {
        st.saving = false;
        st.dirty = true;
        var msg = "网络错误：" + ((err && err.message) || err);
        toast(msg, "error");
        setStatus("保存失败：" + msg);
        updateSaveBtn();
        post({ type: "graph-save", ok: false, message: msg, id: noteId });
        return false;
      });
  }

  /* ══════════ 1.5 保存状态（画布上不显示任何常驻提示） ══════════
     保存按钮不在画布里：后台编辑页右侧侧边栏本来就有「预览 / 发布 / 保存」，
     那里才是唯一入口（admin-edit.js 的 doSave 会调用 EEEmbed.saveGraph()）。
     画布这边只在真正保存时给一句短提示；「有未保存改动」不显示横幅，
     那个状态用后台保存按钮右上角的橙点表示（通过 postMessage 告知父页面）。
  */

  function updateSaveBtn() {
    if (!isEdit) return;
    if (st.saving) setStatus("保存中…");
    post({ type: "graph-dirty", dirty: !!(st.dirty || st.saving), id: noteId });
  }

  /* ══════════ 3. 只读态 ══════════ */

  if (!isEdit) {
    App.readOnly = true;
    var stage = document.getElementById("canvasStage");
    if (stage) stage.classList.add("read-only");
    var roBtn = document.getElementById("sidebarReadOnlyBtn");
    if (roBtn) roBtn.classList.add("active");
    // 只读时导出、缩放、平移照常可用，只是不让改内容
    document.documentElement.setAttribute("data-graph-mode", "view");
  } else {
    document.documentElement.setAttribute("data-graph-mode", "edit");
  }

  // 时序图已启用：顶栏的模式切换按钮（节点图 / 时序图）保持原样。
  // 两份文档各存一份 —— 节点图在 data 顶层，时序图在 data.sequence，保存时一起提交。

  /* ══════════ 4. 装入服务端数据 ══════════ */

  /* ══════════ 4. 装入服务端数据（节点图 + 时序图两份） ══════════ */

  /**
   * 把时序图存档预先装进模式槽，不切换、不渲染。
   * 复刻 Weave 自己 _loadStoredDoc() 的落槽逻辑：用户点顶栏切模式时，
   * _setMode 直接从槽里取，因此这里只需把 state / historyIndex / viewport 摆好。
   */
  function primeSequenceSlot(seqDoc) {
    if (!seqDoc) return false;
    var prep = App._prepareSerializedData(seqDoc);
    if (!prep) return false;
    if (typeof App._ensureModeStore === "function") App._ensureModeStore();
    if (!App._modeStore || !App._modeStore.sequence) return false;
    App._modeStore.sequence.state = {
      nodes: prep.candidate.nodes,
      connections: prep.candidate.connections,
      regions: prep.candidate.regions,
      history: [],
    };
    App._modeStore.sequence.historyIndex = -1;
    App._modeStore.sequence.viewport = prep.viewport;
    return true;
  }

  function load() {
    setStatus("加载中…");
    fetch("/api/graph?id=" + encodeURIComponent(noteId), { cache: "no-store", headers: adminHeaders() })
      .then(function (res) {
        return res.json();
      })
      .then(function (d) {
        st.meta = (d && d.meta) || null;
        st.baseRev = (st.meta && Number(st.meta.rev)) || 0;
        if (d && d.status === "success" && d.data) {
          var data = d.data;
          // 时序图放在 sequence 字段里；节点图仍在顶层（老数据没有这个字段 → 时序图为空）
          var seqDoc = data.sequence && typeof data.sequence === "object" ? data.sequence : null;
          // 暂存两份，保存时整份提交，避免"只改了时序图"把节点图覆盖成空
          st.graphDoc = Object.assign({}, data);
          delete st.graphDoc.sequence;
          st.seqDoc = seqDoc;

          // 与"导入"走同一条装入路径：先校验 + 格→像素换算，再提交渲染。
          // 不走 _loadFromData，因为它会拒绝只读态。
          var prepared = App._prepareSerializedData(st.graphDoc);
          if (prepared) {
            App._commitSerialized(prepared, { emptyToOrigin: false });
            setStatus("已加载 rev " + st.baseRev);
          } else {
            setStatus("存档格式不认识，已按空画布打开");
            toast("存档格式无法识别，请检查数据", "error");
          }
          primeSequenceSlot(seqDoc);
        } else if (d && d.code === "not_found") {
          // 新图：空画布开张
          setStatus(isEdit ? "新建节点图" : "这张节点图还没有内容");
        } else {
          var m = (d && d.message) || "加载失败";
          setStatus(m);
          toast(m, "error");
        }
        st.loaded = true;
        updateSaveBtn();
        post({ type: "graph-ready", id: noteId, ok: !!(d && d.status === "success") });
      })
      .catch(function (err) {
        // 加载失败：允许编辑（否则用户连重试的机会都没有），但提示明确
        st.loaded = true;
        updateSaveBtn();
        var msg = "加载失败：" + ((err && err.message) || err);
        setStatus(msg);
        toast(msg, "error");
        post({ type: "graph-ready", id: noteId, ok: false, message: msg });
      });
  }

  /* ══════════ 5. 顶部状态条 ══════════ */

  var barEl = null;
  var barMsg = null;

  function ensureBar() {
    if (barEl) return;
    barEl = document.createElement("div");
    barEl.id = "gg-statusbar";
    barEl.style.cssText =
      "position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:9999;" +
      "display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;" +
      "font-size:12px;line-height:1;color:#e8e8ea;pointer-events:none;" +
      "background:rgba(20,20,24,.86);border:1px solid rgba(255,255,255,.12);" +
      "backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);" +
      "box-shadow:0 6px 20px rgba(0,0,0,.35);opacity:0;transition:opacity .25s ease;";
    barMsg = document.createElement("span");
    barEl.appendChild(barMsg);
    document.body.appendChild(barEl);
  }

  var barTimer = 0;
  function setStatus(text, sticky) {
    ensureBar();
    barMsg.textContent = text;
    barEl.style.opacity = "1";
    clearTimeout(barTimer);
    if (!sticky) {
      barTimer = setTimeout(function () {
        barEl.style.opacity = "0";
      }, 2200);
    }
  }

  /* ══════════ 6. 提示与父页面通信 ══════════ */

  function toast(text, kind) {
    try {
      if (App.showToast) App.showToast(text, kind || "info", 2600);
    } catch (e) {
      /* 忽略 */
    }
  }

  function post(msg) {
    if (!embedded) return;
    try {
      msg.note = noteId;
      window.parent.postMessage(msg, location.origin);
    } catch (e) {
      /* 跨域忽略 */
    }
  }

  /* ══════════ 7. 收尾钩子 ══════════ */

  // 手动保存模式下不在离开时偷偷发请求：改为拦住并提示，存不存由用户自己决定。
  // Weave 自己挂的 beforeunload 只会调 saveCanvas → _lsSet → stageSave（标脏），不会上传。
  window.addEventListener("beforeunload", function (e) {
    if (!isEdit || !st.loaded || !st.dirty) return;
    e.preventDefault();
    e.returnValue = "";
    return "";
  });

  // 供宿主页面（admin-edit 等）判断是否有未保存改动
  window.__graphDirty = function () {
    return !!(st.dirty || st.saving);
  };
  // 宿主用它触发保存，并据返回值决定要不要继续存文章记录
  window.__graphSave = function () {
    return flush(false);
  };

  /* ══════════ 启动 ══════════ */

  load();
})();
