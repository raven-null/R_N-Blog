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
      /* 图片 / 代码节点：body 不再做行内居中与裁切，整块交给内容。
         背景必须钉死成深色 —— 上游的 body 颜色跟随节点配色与选中态变浅，
         浅底配浅字等于看不见（图片占位提示与代码正文都吃过这个亏）。 */
      ".gg-node-image .node-body,.gg-node-code .node-body{padding:0;display:block;overflow:hidden;",
      "align-items:stretch;background:#111116!important}",
      ".gg-node-image .node-val,.gg-node-code .node-val{height:100%;max-height:none;padding-right:0;",
      "overflow:hidden;display:block;text-align:left;background:transparent!important}",
      ".gg-img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}",
      /* 代码：高对比正文 + 自动换行（长行不被切掉，节点小也能读全） */
      ".gg-code{margin:0;padding:10px 12px;height:100%;box-sizing:border-box;overflow:auto;",
      "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.65;",
      "white-space:pre-wrap;word-break:break-word;color:#eaf0fb;scrollbar-width:thin;",
      "scrollbar-color:rgba(255,255,255,.18) transparent}",
      ".gg-code code{font:inherit;color:inherit;background:none;padding:0}",
      /* 轻量语法着色：注释 / 字符串 / 数字 / 关键字 */
      ".gg-cm{color:#6f7b8a;font-style:italic}",
      ".gg-str{color:#e5c07b}",
      ".gg-num{color:#d19a66}",
      ".gg-kw{color:#7aa2f7}",
      ".gg-ph{display:flex;align-items:center;justify-content:center;height:100%;width:100%;",
      "color:rgba(255,255,255,.62);font-size:12px;background:transparent}",
      /* 边中点手柄：上游只给了四角，这里补上上下左右四条边（data-dir 用 n/s/e/w，
         _bindResizeHandles 是按 dir 里的方向字符算的，单边天然支持） */
      ".node .rsz-handle.n{left:50%;top:-5px;margin-left:-5px;cursor:ns-resize}",
      ".node .rsz-handle.s{left:50%;bottom:-5px;margin-left:-5px;cursor:ns-resize}",
      ".node .rsz-handle.e{right:-5px;top:50%;margin-top:-5px;cursor:ew-resize}",
      ".node .rsz-handle.w{left:-5px;top:50%;margin-top:-5px;cursor:ew-resize}",
      /* 代码节点的 × 没用（它清的是 desc，代码节点不靠 desc）→ 去掉 */
      ".gg-node-code .node-clear{display:none!important}",
      /* 左上角「放大到合适大小」按钮：默认半透明，悬停节点时亮起来 */
      ".gg-fit-btn{position:absolute;left:-11px;top:-11px;z-index:6;width:22px;height:22px;",
      "display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;",
      "font-size:12px;line-height:1;color:rgba(255,255,255,.75);background:rgba(28,28,34,.92);",
      "border:1px solid rgba(255,255,255,.16);box-shadow:0 4px 12px -4px rgba(0,0,0,.7);",
      "opacity:0;transition:opacity .15s ease,background .15s ease}",
      ".node:hover .gg-fit-btn{opacity:1}",
      ".gg-fit-btn:hover{background:rgba(255,159,10,.92);color:#16161a}",
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
    // 用 createElement 而不是 innerHTML，好把滚轮监听挂到 pre 上
    var pre = document.createElement("pre");
    pre.className = "gg-code";
    var codeEl = document.createElement("code");
    codeEl.innerHTML = highlight(code);
    pre.appendChild(codeEl);
    // 悬停在代码上滚动就滚代码，不缩放画布。
    // 画布的滚轮是 container.onwheel（冒泡阶段），这里 stop 住即可；
    // 内容没超出时不拦，滚轮照常缩放画布。
    pre.onwheel = function (e) {
      if (pre.scrollHeight > pre.clientHeight + 1) e.stopPropagation();
    };
    val.innerHTML = "";
    val.appendChild(pre);
  }

  /* 轻量语法着色（不引第三方库）：
     先把注释与字符串换成占位符（避免它们里面的关键字/数字被二次着色），
     再给数字与关键字上色，最后还原占位符。输入已做 HTML 转义，标签不会被吃。 */
  var KEYWORDS =
    /\b(package|import|public|private|protected|static|final|abstract|class|interface|enum|extends|implements|new|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|throws|void|int|long|double|float|boolean|char|byte|short|true|false|null|this|super|function|const|let|var|def|fn|struct|async|await|export|from|type|end)\b/g;

  function highlight(code) {
    var out = esc(code);
    var store = [];
    // 占位符必须**不含数字**：后面数字与关键字着色是按正则扫全文的，
    // 占位符里只要有数字就会被当成数字再包一层 span，把标记撕碎（踩过）。
    // 用 Unicode 私有区的两个字符表示，'\uE000' + n 个 '\uE001' + '\uE000'。
    function stash(html) {
      store.push(html);
      return "\uE000" + new Array(store.length).join("\uE001") + "\uE000";
    }
    // 1) 注释
    out = out.replace(/\/\/[^\n]*/g, function (m) {
      return stash('<span class="gg-cm">' + m + "</span>");
    });
    out = out.replace(/\/\*[\s\S]*?\*\//g, function (m) {
      return stash('<span class="gg-cm">' + m + "</span>");
    });
    // 2) 字符串
    out = out.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, function (m) {
      return stash('<span class="gg-str">' + m + "</span>");
    });
    // 3) 数字（同样走占位符：直接插 <span class="gg-num"> 的话，
    //    标签里的 class 会被下一步的关键字正则再包一层，结构就碎了）
    out = out.replace(/\b\d+(?:\.\d+)?\b/g, function (m) {
      return stash('<span class="gg-num">' + m + "</span>");
    });
    // 4) 关键字
    out = out.replace(KEYWORDS, function (m) {
      return '<span class="gg-kw">' + m + "</span>";
    });
    // 5) 还原
    return out.replace(/\uE000(\uE001*)\uE000/g, function (_, bars) {
      return store[bars.length] || "";
    });
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
    // 每条节点都要的两件外挂：边中点缩放手柄 + 左上角自适应按钮
    ensureEdgeHandles(nodeEl, node);
    ensureFitButton(nodeEl, node);
    // 图片节点的 × 语义不同：不是清空描述，而是换一张图（取消则保留原图）
    if (kind === "image") bindImageClear(nodeEl, node);
  };

  /** 补四条边中点手柄（上游只给了四角）。_bindResizeHandles 按 data-dir 解析方向，单边天然支持。 */
  function ensureEdgeHandles(nodeEl, node) {
    if (!nodeEl || !nodeEl.querySelector) return;
    if (nodeEl.querySelector(".rsz-handle.e")) return; // 已经补过
    var dirs = ["n", "s", "e", "w"];
    for (var i = 0; i < dirs.length; i++) {
      var h = document.createElement("div");
      h.className = "rsz-handle " + dirs[i];
      h.dataset.dir = dirs[i];
      nodeEl.appendChild(h);
    }
    if (typeof App._bindResizeHandles === "function") App._bindResizeHandles(nodeEl, node.id);
  }

  /** 左上角「放大到合适大小」按钮 */
  function ensureFitButton(nodeEl, node) {
    if (!nodeEl) return;
    if (nodeEl._ggFitBtn) return;
    var b = document.createElement("div");
    b.className = "gg-fit-btn";
    b.setAttribute("role", "button");
    b.title = "放大到适合内容的大小";
    b.textContent = "⤢";
    b.addEventListener("mousedown", function (e) {
      e.stopPropagation();
      e.preventDefault();
    });
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      autoFitNode(node.id);
    });
    nodeEl.appendChild(b);
    nodeEl._ggFitBtn = b;
  }

  /** 图片节点的 × ：换一张图。没选新图就什么都不做，原图保留。 */
  function bindImageClear(nodeEl, node) {
    if (!nodeEl || !nodeEl._clear) return;
    nodeEl._clear.title = "换一张图";
    // 上游在 _bindNodeEvents 里用 onmousedown 绑了「清空 desc」，这里整个替换掉
    nodeEl._clear.onmousedown = function (e) {
      e.stopPropagation();
      e.preventDefault();
      if (App.readOnly) return;
      pickImageForNode(node.id); // 取消选择就不会走到上传，原图不动
    };
  }

  /* ══════════ 2.5 放大到适合内容的大小 ══════════ */

  /** 把节点尺寸吸附到格并重绘 */
  function applyNodeSize(node, w, h) {
    var nw = Math.max(180, Math.round(w / GRID) * GRID);
    var nh = Math.max(80, Math.round(h / GRID) * GRID);
    node.w = nw;
    node.h = nh;
    App.saveCanvasSnapshot();
    App.renderCanvas();
  }

  function autoFitNode(nodeId) {
    var node = findNode(nodeId);
    if (!node) return;
    var kind = kindOf(node);

    if (kind === "image") {
      var fid = node.data && node.data.fid;
      var url = fid ? imgCache[fid] : "";
      if (!url) {
        toast("这张图还没加载好，稍后再试", "info");
        return;
      }
      var img = new Image();
      img.onload = function () {
        if (!img.width) return;
        // 宽度取 480（够看清），高度按比例 + 34px 标题栏
        applyNodeSize(node, 480, (480 * img.height) / img.width + 34);
      };
      img.src = url;
      return;
    }

    if (kind === "code") {
      var code = String((node.data && node.data.code) || "");
      var lines = code.split("\n");
      // 每行约 7.2px（12px 等宽字），高度按行数算；都夹在合理区间
      var longest = 0;
      for (var i = 0; i < lines.length; i++) longest = Math.max(longest, lines[i].length);
      var w = Math.min(960, Math.max(360, longest * 7.4 + 32));
      var h = Math.min(960, Math.max(160, lines.length * 20 + 56));
      applyNodeSize(node, w, h);
      return;
    }

    // 文本节点：按标题与描述长度估一估
    var label = String(node.label || "");
    var desc = String(node.desc || "");
    var w2 = Math.min(560, Math.max(180, Math.max(label.length * 15, desc.length * 7) + 40));
    var h2 = Math.min(400, Math.max(80, 80 + (desc.length > 60 ? 40 : 0)));
    applyNodeSize(node, w2, h2);
  }

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
      // 只有真的选了文件才换图；取消 / 关闭选择框 → 什么都不做，原图保留
      if (f) uploadImageForNode(nodeId, f);
    });
    if (typeof input.click === "function") input.click();
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

  // 双击节点：
  //   代码节点 → 弹出代码编辑框（就是新建代码节点时那个框）
  //   图片节点 → 什么都不做（换图入口统一到 × 上）
  //   文本节点 → 保持上游的内联改标题
  //
  // 注意：上游的双击判定**不是靠 dblclick 事件**，而是自己用 mousedown 记时
  // （App._dblClickTarget：250ms 内、位移 ≤ 容差）。所以监听 dblclick 已经太晚 ——
  // 上游早在第二次 mousedown 里就把内联编辑框打开了。这里用同样的规则在
  // capture 阶段抢先拦住第二次 mousedown。
  var lastNodeDown = { time: 0, x: 0, y: 0, id: "" };
  var DBL_MS = 320;
  var DBL_PX = 6;

  document.addEventListener(
    "mousedown",
    function (e) {
      if (!isEdit || e.button !== 0) return;
      var el = e.target && e.target.closest ? e.target.closest(".node") : null;
      if (!el) {
        lastNodeDown = { time: 0, x: 0, y: 0, id: "" };
        return;
      }
      var node = findNode(el.dataset.nodeId);
      if (!node) return;
      var kind = kindOf(node);
      if (kind === "text") return; // 文本节点：让上游照常进内联编辑

      var now = Date.now();
      var isDbl =
        lastNodeDown.id === node.id &&
        now - lastNodeDown.time < DBL_MS &&
        Math.abs(e.clientX - lastNodeDown.x) <= DBL_PX &&
        Math.abs(e.clientY - lastNodeDown.y) <= DBL_PX;

      if (!isDbl) {
        lastNodeDown = { time: now, x: e.clientX, y: e.clientY, id: node.id };
        return;
      }
      // 第二次按下：吃掉这个事件，上游就收不到双击了
      lastNodeDown = { time: 0, x: 0, y: 0, id: "" };
      e.preventDefault();
      e.stopPropagation();
      if (kind === "code") openCodeEditor(node.id);
      // 图片节点：有意什么都不做
    },
    true,
  );

  // 兜底：万一浏览器仍派发了 dblclick（触控 / 某些输入法），别让它落到上游
  document.addEventListener(
    "dblclick",
    function (e) {
      if (!isEdit) return;
      var el = e.target && e.target.closest ? e.target.closest(".node") : null;
      if (!el) return;
      var node = findNode(el.dataset.nodeId);
      if (!node || kindOf(node) === "text") return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  /* ══════════ 9. 双击空白处：同样是新建节点，但先选出类型 ══════════ */

  // 上游双击空白会直接建一个默认文本节点（_addNodeAt）。
  // 这里拦下来，改成先弹类型选择 —— 选完才建，取消就什么也不建。
  if (typeof App._onCanvasDblClick === "function") {
    var rawCanvasDblClick = App._onCanvasDblClick.bind(App);
    App._onCanvasDblClick = function (e) {
      if (!isEdit || App.readOnly) return rawCanvasDblClick(e);
      var t = e && e.target;
      // 节点 / 坐标 HUD / 选区层上的双击不归这里管
      if (t && t.closest && (t.closest(".node") || t.closest(".coord") || t.closest(".sel-overlay"))) {
        return rawCanvasDblClick(e);
      }
      var wp = App.getWorldPos(e.clientX, e.clientY);
      openKindPicker(e.clientX, e.clientY, wp.x, wp.y, null, null);
    };
  }

  /* ══════════ 7. 对外 ══════════ */

  window.__ggNodeKit = {
    kinds: KINDS,
    create: createTypedNode,
    pickImage: pickImageForNode,
    editCode: openCodeEditor,
    highlight: highlight, // 供冒烟测试
  };
})();
