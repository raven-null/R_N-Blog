/*
 * 节点图 · 节点类型与"拉线新建"（注入位置：post.js 之后，启动已经完成）
 *
 * 两件事：
 *   1. 多类型节点 —— 文本 / 图片 / 代码，按 node.kind 渲染不同内容
 *   2. 从连接点拉线松在空白处 → 弹出节点类型选择，选完就地新建节点并把线接上
 *
 * 不改上游：全部靠覆盖 App 方法 + 监听自己的事件。
 * 覆盖点：App._updateNodeAppearance（节点外观）、App.startSocketDrag（建线手势）。
 */
(function () {
  var App = window.App;
  if (!App) return;

  var qs = new URLSearchParams(location.search);
  var noteId = (qs.get("id") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!noteId) return;
  var isEdit = qs.get("edit") === "1";

  var GRID = 20; // 与上游 GRID 一致（1 格 = 20px）
  var API = "/api/graph";

  /* ══════════ 0. 样式 ══════════ */

  (function injectCss() {
    var css = [
      /* 图片 / 代码节点：body 不再做行内居中与裁切，整块交给内容 */
      ".gg-node-image .node-body,.gg-node-code .node-body{padding:0;display:block;overflow:hidden;align-items:stretch}",
      ".gg-node-image .node-val,.gg-node-code .node-val{height:100%;max-height:none;padding-right:0;overflow:hidden;display:block;text-align:left}",
      ".gg-img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}",
      ".gg-code{margin:0;padding:10px 12px;height:100%;box-sizing:border-box;overflow:auto;",
      "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.6;",
      "white-space:pre;color:#d9e2f2;scrollbar-width:thin}",
      ".gg-code code{font:inherit;color:inherit;background:none;padding:0}",
      ".gg-ph{display:flex;align-items:center;justify-content:center;height:100%;width:100%;",
      "color:rgba(255,255,255,.42);font-size:12px;background:rgba(255,255,255,.03)}",
      /* 类型选择弹窗 */
      ".gg-kp{position:fixed;z-index:2147483200;display:flex;flex-direction:column;gap:4px;padding:8px;",
      "min-width:240px;border-radius:14px;background:rgba(24,24,30,.97);border:1px solid rgba(255,255,255,.14);",
      "box-shadow:0 22px 56px -18px rgba(0,0,0,.8);backdrop-filter:blur(18px) saturate(160%);",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
      ".gg-kp-title{font-size:11.5px;color:rgba(255,255,255,.45);padding:2px 8px 6px;letter-spacing:.4px}",
      ".gg-kp-item{display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:9px 10px;",
      "border-radius:10px;background:transparent;border:0;cursor:pointer;text-align:left;font-family:inherit;",
      "transition:background .14s ease}",
      ".gg-kp-item:hover{background:rgba(255,255,255,.1)}",
      ".gg-kp-item b{font-size:13px;font-weight:600;color:#e8e8ea}",
      ".gg-kp-item i{font-style:normal;font-size:11px;color:rgba(255,255,255,.42)}",
      /* 代码编辑弹窗 */
      ".gg-codeedit{position:fixed;inset:0;z-index:2147483300;display:flex;align-items:center;justify-content:center;",
      "background:rgba(5,5,9,.62);backdrop-filter:blur(6px)}",
      ".gg-ce-box{width:min(680px,92vw);display:flex;flex-direction:column;gap:10px;padding:16px;",
      "border-radius:16px;background:rgba(24,24,30,.98);border:1px solid rgba(255,255,255,.14);",
      "box-shadow:0 30px 70px -20px rgba(0,0,0,.85);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
      ".gg-ce-head{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;color:#e8e8ea}",
      ".gg-ce-ta{width:100%;min-height:240px;resize:vertical;padding:12px;border-radius:10px;box-sizing:border-box;",
      "background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);color:#d9e2f2;outline:none;",
      "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.65}",
      ".gg-ce-ta:focus{border-color:rgba(120,170,255,.55)}",
      ".gg-ce-btns{display:flex;justify-content:flex-end;gap:8px}",
      ".gg-ce-btns button{padding:7px 16px;border-radius:999px;border:1px solid rgba(255,255,255,.14);",
      "background:rgba(255,255,255,.06);color:#e8e8ea;font-family:inherit;font-size:13px;cursor:pointer}",
      ".gg-ce-btns button.p{background:linear-gradient(135deg,rgba(59,130,246,.5),rgba(115,170,255,.4));",
      "border-color:rgba(115,170,255,.5);color:#eaf2ff;font-weight:500}",
      ".gg-ce-btns button:hover{filter:brightness(1.15)}",
    ].join("");
    var s = document.createElement("style");
    s.id = "gg-node-kit-css";
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  })();

  /* ══════════ 1. 通用工具 ══════════ */

  function adminHeaders() {
    var h = {};
    try {
      var k = localStorage.getItem("admin_key") || "";
      if (k) h["X-Admin-Key"] = k;
    } catch (e) {
      /* 忽略 */
    }
    return h;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function toast(msg, kind) {
    try {
      if (App.showToast) App.showToast(msg, kind || "info", 2400);
    } catch (e) {
      /* 忽略 */
    }
  }

  function findNode(id) {
    var list = (App.canvasState && App.canvasState.nodes) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ══════════ 2. 节点类型 ══════════ */

  var KINDS = {
    text: { label: "文本节点", hint: "标题 + 描述，与默认节点相同", w: 180, h: 80 },
    image: { label: "图片节点", hint: "放一张图，按节点大小铺满", w: 360, h: 280 },
    code: { label: "代码节点", hint: "贴一段代码，等宽显示", w: 360, h: 220 },
  };

  function kindOf(node) {
    var k = node && node.kind;
    return k && KINDS[k] ? k : "text";
  }

  /* ── 图片：fid 引用 + 本地缓存 ── */
  var imgCache = {};

  function loadImageUrl(fid) {
    if (imgCache[fid]) return Promise.resolve(imgCache[fid]);
    return fetch(API + "?action=file&id=" + encodeURIComponent(noteId) + "&fid=" + encodeURIComponent(fid), {
      cache: "force-cache",
      headers: adminHeaders(),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        var url = d && d.status === "success" && d.file && d.file.dataURL;
        if (url) imgCache[fid] = url;
        return url || "";
      })
      .catch(function () {
        return "";
      });
  }

  function drawImageBody(nodeEl, node) {
    var val = nodeEl._val;
    if (!val) return;
    var fid = node.data && node.data.fid;
    if (!fid) {
      val.innerHTML = '<div class="gg-ph">双击选择图片</div>';
      return;
    }
    if (imgCache[fid]) {
      val.innerHTML = '<img class="gg-img" alt="">';
      val.firstChild.src = imgCache[fid];
      return;
    }
    val.innerHTML = '<div class="gg-ph">加载中…</div>';
    loadImageUrl(fid).then(function (url) {
      if (!nodeEl._val || !nodeEl.isConnected) return;
      if (!url) {
        nodeEl._val.innerHTML = '<div class="gg-ph">图片读取失败</div>';
        return;
      }
      nodeEl._val.innerHTML = '<img class="gg-img" alt="">';
      var img = nodeEl._val.firstChild;
      if (img) img.src = url;
    });
  }

  function drawCodeBody(nodeEl, node) {
    var val = nodeEl._val;
    if (!val) return;
    var code = (node.data && node.data.code) || "";
    if (!code) {
      val.innerHTML = '<div class="gg-ph">双击编辑代码</div>';
      return;
    }
    val.innerHTML = '<pre class="gg-code"><code>' + esc(code) + "</code></pre>";
  }

  /* ── 覆盖节点外观：上游先画，再按类型补内容 ── */
  var rawAppearance = App._updateNodeAppearance.bind(App);
  App._updateNodeAppearance = function (nodeEl, node) {
    rawAppearance(nodeEl, node);
    var kind = kindOf(node);
    if (nodeEl.classList) {
      nodeEl.classList.toggle("gg-node-image", kind === "image");
      nodeEl.classList.toggle("gg-node-code", kind === "code");
    }
    if (kind === "image") drawImageBody(nodeEl, node);
    else if (kind === "code") drawCodeBody(nodeEl, node);
  };

  /* ══════════ 3. 新建节点（带类型 + 自动连线） ══════════ */

  function createTypedNode(kind, worldX, worldY, fromNodeId, dir) {
    var meta = KINDS[kind] || KINDS.text;
    var id = App._genId();
    // 让新节点的中心落在松手位置
    var x = App._snap(worldX) - Math.round(meta.w / 2 / GRID) * GRID;
    var y = App._snap(worldY) - Math.round(meta.h / 2 / GRID) * GRID;
    var node = {
      id: id,
      label: meta.label,
      desc: "",
      color: App._selectedGenColor || "blue",
      x: x,
      y: y,
      mirrored: false,
      w: meta.w,
      h: meta.h,
      kind: kind,
      data: {},
    };
    App.canvasState.nodes.push(node);

    // 接上刚才那条线：从哪边拉出来，就接到哪一边
    if (fromNodeId) {
      var fromId = dir === "out" ? fromNodeId : id;
      var toId = dir === "out" ? id : fromNodeId;
      var srcNode = findNode(fromId);
      App.canvasState.connections.push(App._createConnection(fromId, toId, { mirrored: !!(srcNode && srcNode.mirrored) }));
    }

    if (typeof App._syncNodeRegionMembership === "function") App._syncNodeRegionMembership(id);
    App.selectedNodeIds.clear();
    App.selectedNodeIds.add(id);
    if (App._nodeZOrder) App._nodeZOrder.push(id);
    App.saveCanvasSnapshot();
    App.renderCanvas();
    if (typeof App._refreshFoldBadges === "function") App._refreshFoldBadges();
    return id;
  }

  /* ══════════ 4. 拉线松在空白处 → 类型选择弹窗 ══════════ */

  var kp = null;

  function closeKindPicker() {
    if (!kp) return;
    kp.remove();
    kp = null;
  }

  function openKindPicker(clientX, clientY, worldX, worldY, fromNodeId, dir) {
    if (!isEdit) return;
    closeKindPicker();
    kp = document.createElement("div");
    kp.className = "gg-kp";
    var html = '<div class="gg-kp-title">在这里新建节点并连上</div>';
    for (var k in KINDS) {
      if (!Object.prototype.hasOwnProperty.call(KINDS, k)) continue;
      html +=
        '<button type="button" class="gg-kp-item" data-kind="' + k + '">' +
        "<b>" + esc(KINDS[k].label) + "</b>" +
        "<i>" + esc(KINDS[k].hint) + "</i>" +
        "</button>";
    }
    kp.innerHTML = html;
    document.body.appendChild(kp);

    // 贴着松手位置展开，超出视口就翻到另一侧
    var rect = kp.getBoundingClientRect();
    var left = clientX + 14;
    var top = clientY + 14;
    if (left + rect.width > window.innerWidth - 12) left = Math.max(12, clientX - rect.width - 14);
    if (top + rect.height > window.innerHeight - 12) top = Math.max(12, clientY - rect.height - 14);
    kp.style.left = left + "px";
    kp.style.top = top + "px";

    kp.addEventListener("mousedown", function (e) {
      e.stopPropagation(); // 别让画布把它当成空白点击
    });
    kp.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("[data-kind]") : null;
      if (!btn) return;
      var kind = btn.getAttribute("data-kind");
      closeKindPicker();
      var newId = createTypedNode(kind, worldX, worldY, fromNodeId, dir);
      if (kind === "image") pickImageForNode(newId);
      else if (kind === "code") openCodeEditor(newId);
    });

    // ESC / 点别处关掉
    setTimeout(function () {
      document.addEventListener("mousedown", onDocDownClose, true);
    }, 0);
  }

  function onDocDownClose(e) {
    if (kp && !kp.contains(e.target)) {
      closeKindPicker();
      document.removeEventListener("mousedown", onDocDownClose, true);
    }
  }

  // 覆盖建线手势：上游处理完（可能建了线、也可能什么也没建）之后再判断
  var rawStartSocketDrag = App.startSocketDrag.bind(App);
  App.startSocketDrag = function (e, nodeId, dir, colorClass) {
    var connBefore = App.canvasState.connections.length;
    var startX = e.clientX;
    var startY = e.clientY;
    rawStartSocketDrag(e, nodeId, dir, colorClass);

    function onDocUp(ev) {
      document.removeEventListener("mouseup", onDocUp, true);
      // 让上游的 onUp 先跑完（它可能在同一个事件里建线）
      setTimeout(function () {
        if (!ev || typeof ev.clientX !== "number") return;
        var moved = Math.abs(ev.clientX - startX) > 8 || Math.abs(ev.clientY - startY) > 8;
        if (!moved) return; // 只是点了一下连接点，不是拖线
        if (App.canvasState.connections.length !== connBefore) return; // 已经连上了
        var wp = App.getWorldPos(ev.clientX, ev.clientY);
        openKindPicker(ev.clientX, ev.clientY, wp.x, wp.y, nodeId, dir);
      }, 0);
    }
    document.addEventListener("mouseup", onDocUp, true);
  };

  /* ══════════ 5. 图片节点：选文件 → 上传 → 存 fid ══════════ */

  function pickImageForNode(nodeId) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (f) uploadImageForNode(nodeId, f);
    });
    input.click();
  }

  /** 按图片宽高比调节点高度（宽度不动），高度吸附到格；拿不到尺寸就保持原样 */
  function fitNodeToImage(node, file) {
    try {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          if (img.width > 0 && img.height > 0) {
            var w = node.w || 360;
            var h = w * (img.height / img.width) + 34; // 34px 是上游标题栏高度
            h = Math.max(140, Math.min(900, h));
            node.h = Math.round(h / GRID) * GRID;
            App.renderCanvas();
          }
        } catch (e) {
          /* 忽略 */
        }
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
          /* 忽略 */
        }
      };
      img.src = url;
    } catch (e) {
      /* 拿不到尺寸就算了，用创建时给的高度 */
    }
  }

  function uploadImageForNode(nodeId, file) {
    var fid = "img-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    var headers = adminHeaders();
    headers["Content-Type"] = file.type || "application/octet-stream";
    toast("图片上传中…", "info");
    fetch(API + "?action=file&id=" + encodeURIComponent(noteId) + "&fid=" + encodeURIComponent(fid), {
      method: "PUT",
      headers: headers,
      body: file,
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || d.status !== "success") throw new Error((d && d.message) || "上传失败");
        var node = findNode(nodeId);
        if (!node) return;
        node.data = node.data || {};
        node.data.fid = fid;
        // 按图片比例把节点调高，避免 object-fit:cover 把图裁掉一块
        fitNodeToImage(node, file);
        App.saveCanvasSnapshot();
        App.renderCanvas();
        toast("图片已放入节点", "success");
      })
      .catch(function (err) {
        toast("图片上传失败：" + ((err && err.message) || err), "error");
      });
  }

  /* ══════════ 6. 代码节点：双击编辑 ══════════ */
  var ceBox = null;

  function closeCodeEditor() {
    if (!ceBox) return;
    ceBox.remove();
    ceBox = null;
  }

  function openCodeEditor(nodeId) {
    if (!isEdit) return;
    var node = findNode(nodeId);
    if (!node) return;
    closeCodeEditor();
    ceBox = document.createElement("div");
    ceBox.className = "gg-codeedit";
    ceBox.innerHTML =
      '<div class="gg-ce-box">' +
      '<div class="gg-ce-head"><span>编辑代码</span><span style="opacity:.5;font-size:11.5px">Ctrl+Enter 保存 · Esc 取消</span></div>' +
      '<textarea class="gg-ce-ta" spellcheck="false" placeholder="在这里粘贴代码…"></textarea>' +
      '<div class="gg-ce-btns"><button type="button" data-act="cancel">取消</button>' +
      '<button type="button" class="p" data-act="ok">保存</button></div>' +
      "</div>";
    document.body.appendChild(ceBox);

    var ta = ceBox.querySelector(".gg-ce-ta");
    ta.value = (node.data && node.data.code) || "";
    setTimeout(function () {
      ta.focus();
    }, 0);

    function save() {
      var cur = findNode(nodeId);
      if (cur) {
        cur.data = cur.data || {};
        cur.data.code = ta.value;
        App.saveCanvasSnapshot();
        App.renderCanvas();
      }
      closeCodeEditor();
    }

    ceBox.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
      if (btn) {
        if (btn.getAttribute("data-act") === "ok") save();
        else closeCodeEditor();
        return;
      }
      if (e.target === ceBox) closeCodeEditor();
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeCodeEditor();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    });
  }

  // 双击节点：图片节点重新选图，代码节点进编辑器（拦住上游的内联改标题）
  document.addEventListener(
    "dblclick",
    function (e) {
      if (!isEdit) return;
      var el = e.target && e.target.closest ? e.target.closest(".node") : null;
      if (!el) return;
      var node = findNode(el.dataset.nodeId);
      if (!node) return;
      var kind = kindOf(node);
      if (kind === "text") return; // 文本节点保持上游行为
      e.preventDefault();
      e.stopPropagation();
      if (kind === "image") pickImageForNode(node.id);
      else if (kind === "code") openCodeEditor(node.id);
    },
    true,
  );

  /* ══════════ 7. 对外 ══════════ */

  window.__ggNodeKit = {
    kinds: KINDS,
    create: createTypedNode,
    pickImage: pickImageForNode,
    editCode: openCodeEditor,
  };
})();
