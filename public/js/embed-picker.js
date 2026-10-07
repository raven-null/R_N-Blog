/**
 * 插入画布面板（白板 / 思维导图）—— 后台写文章页与文章编辑页共用（v1.8.0）
 * ===========================================================================
 * 职责：
 *   · 自己注入样式与弹窗 DOM（两个页面只需引入本文件 + 一个工具栏按钮）
 *   · 拉取画布列表（白板 /api/excalidraw?action=list、导图 /api/mindmap?action=list）
 *   · 选中或新建后，把内嵌块声明插入到调用方给的 Vditor 实例
 *
 * 正文里存的是纯 Markdown：
 *   ```embed board:<画布ID>
 *   ```embed map:<导图ID>            （可选 :h=520 :caption="说明"）
 * 由 public/js/markdown-config.js 在前台渲染成内嵌块（article-app.js 的 mountEmbeds 挂载）。
 *
 * 对外接口：
 *   window.EmbedPicker.open(vditor)            打开面板
 *   window.EmbedPicker.insert(vditor, kind, id) 直接插入
 *   window.EmbedPicker.bindToolbar(vditor)      给工具栏按钮补图标并绑定点击
 */
(function () {
    'use strict';

    var STYLE_ID = 'embed-picker-style';
    var MODAL_ID = 'embedPickerModal';
    var kind = 'board';
    var cache = { board: null, map: null };
    var activeVditor = null;

    function adminKey() {
        try { return localStorage.getItem('admin_key') || ''; } catch (e) { return ''; }
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // parseEmbed 定义在 markdown-config.js（前台渲染与编辑器共用同一套解析）
    function parseEmbed(raw) {
        var mc = window.MarkdownConfig;
        if (!mc || typeof mc.parseEmbed !== 'function') return null;
        try { return mc.parseEmbed(raw); } catch (e) { return null; }
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = [
            /* 弹层统一取「顶层」数值（2147483000 档）：宿主页会为了抬高 Vditor 下拉面板，
               把编辑器祖先链设成 z-index:3000（见 admin-edit.html），普通小数值（如 2600）
               会被编辑器正文整块盖住，点工具栏按钮就像没反应。这里直接用同档最大值，
               并让抽屉比弹窗再高一级、提示比两者都高。 */
            '#embedPickerModal{position:fixed;inset:0;z-index:2147483000;display:none}',
            '#embedPickerModal.open{display:flex;align-items:center;justify-content:center}',
            '#embedPickerModal .ep-mask{position:absolute;inset:0;background:rgba(5,5,9,.6);',
            '  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}',
            '#embedPickerModal .ep-box{position:relative;display:flex;flex-direction:column;width:min(460px,92vw);',
            '  max-height:82vh;overflow:hidden;padding:22px;border-radius:20px;',
            '  background:linear-gradient(145deg,rgba(34,34,42,.97),rgba(18,18,24,.96));',
            '  border:1px solid rgba(255,255,255,.13);box-shadow:0 30px 90px -20px rgba(0,0,0,.8);',
            '  font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif}',
            '#embedPickerModal h3{font-size:16px;font-weight:700;color:#4fc3f7;margin:0 0 6px}',
            '#embedPickerModal .ep-sub{font-size:12.5px;color:rgba(255,255,255,.6);line-height:1.7;margin-bottom:14px}',
            '#embedPickerModal .ep-tabs{display:flex;gap:6px;margin-bottom:12px;flex:none}',
            '#embedPickerModal .ep-tabs button{flex:1;padding:8px 10px;border-radius:999px;',
            '  border:1px solid rgba(255,255,255,.14);background:transparent;color:rgba(255,255,255,.6);',
            '  font-size:13px;font-family:inherit;cursor:pointer;transition:all .15s}',
            '#embedPickerModal .ep-tabs button:hover{border-color:rgba(255,255,255,.4)}',
            '#embedPickerModal .ep-tabs button.active{background:#4fc3f7;color:#0b0b10;',
            '  border-color:#4fc3f7;font-weight:600}',
            '#embedPickerModal .ep-list{flex:1;min-height:120px;overflow-y:auto;border-radius:8px;',
            '  border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.22);padding:6px}',
            '#embedPickerModal .ep-item{display:flex;align-items:center;gap:10px;padding:9px 10px;',
            '  border-radius:8px;cursor:pointer;transition:background .12s}',
            '#embedPickerModal .ep-item:hover{background:rgba(255,255,255,.07)}',
            '#embedPickerModal .ep-item .t{flex:1;min-width:0;font-size:13px;color:#e8e8ea;',
            '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '#embedPickerModal .ep-item .id{flex:none;font-size:11px;color:rgba(255,255,255,.45);',
            "  font-family:'Courier New',monospace}",
            '#embedPickerModal .ep-item.locked .t::after{content:" · 有口令";color:#ffa726;font-size:11px}',
            '#embedPickerModal .ep-hint{padding:16px 10px;text-align:center;font-size:12.5px;',
            '  color:rgba(255,255,255,.5);line-height:1.7}',
            '#embedPickerModal .ep-foot{flex:none;display:flex;gap:8px;margin-top:10px}',
            '#embedPickerModal .ep-new{flex:1;padding:10px;border-radius:8px;border:1px dashed rgba(255,255,255,.2);',
            '  background:transparent;color:#4fc3f7;font-size:13px;font-family:inherit;cursor:pointer;transition:all .15s}',
            '#embedPickerModal .ep-new:hover{border-color:#4fc3f7;background:rgba(79,195,247,.08)}',
            '#embedPickerModal .ep-close{padding:10px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.14);',
            '  background:transparent;color:rgba(255,255,255,.6);font-size:13px;font-family:inherit;cursor:pointer}',
            '#embedPickerModal .ep-close:hover{color:#fff}',
            '#embedPickerModal .ep-quota{margin-top:9px;font-size:12px;color:rgba(255,255,255,.5)}',
            '#embedPickerModal .ep-quota.full{color:#ffa726}',
            '.ep-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483100;',
            '  max-width:min(560px,92vw);padding:10px 16px;border-radius:10px;font-size:13px;line-height:1.7;',
            '  background:rgba(20,20,28,.96);color:#fff;border:1px solid rgba(255,255,255,.16);',
            '  box-shadow:0 18px 50px -12px rgba(0,0,0,.8)}',
            /* 编辑器内直接渲染的画布块（与阅读页同一套渲染，不是卡片占位） */
            '.ep-canvas-card{display:block;margin:14px 0;border-radius:10px;overflow:hidden;',
            '  border:1px solid rgba(79,195,247,.3);background:#0b0b0e;',
            '  font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif}',
            '.ep-canvas-bar{display:flex;align-items:center;gap:10px;padding:7px 12px;',
            '  background:rgba(79,195,247,.09);border-bottom:1px solid rgba(79,195,247,.2)}',
            '.ep-canvas-tag{flex:none;font-size:12px;font-weight:600;color:#4fc3f7}',
            '.ep-canvas-id{flex:none;font-size:11.5px;color:rgba(255,255,255,.45);',
            "  font-family:'Courier New',monospace}",
            '.ep-canvas-cap{flex:1;min-width:0;font-size:12px;color:rgba(255,255,255,.6);',
            '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.ep-canvas{position:relative;height:480px;background:#fff}',
            '.ep-canvas .ep-inline-board{position:absolute;inset:0}',
            '.ep-inline-frame{display:block;width:100%;height:100%;border:0}',
            '.ep-canvas-loading{display:flex;align-items:center;justify-content:center;height:100%;',
            '  padding:16px;text-align:center;font-size:13px;line-height:1.8;',
            '  color:rgba(255,255,255,.6);background:#0b0b0e}',
            '@media (max-width:773px){.ep-canvas{height:60vh}}',
            '.ep-card{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:10px;',
            '  background:linear-gradient(135deg,rgba(79,195,247,.10),rgba(79,195,247,.04));',
            '  border:1px solid rgba(79,195,247,.32);user-select:none;cursor:default;',
            '  font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif}',
            '.ep-card-icon{flex:none;font-size:22px;line-height:1}',
            '.ep-card-body{flex:1;min-width:0}',
            '.ep-card-title{font-size:13.5px;font-weight:600;color:#e8e8ea}',
            '.ep-card-id{font-size:11.5px;color:rgba(255,255,255,.5);',
            "  font-family:'Courier New',monospace;margin-top:2px}",
            '.ep-card-badge{flex:none;font-size:11px;padding:3px 9px;border-radius:999px;',
            '  background:rgba(79,195,247,.18);color:#4fc3f7}',
            '.ep-card.hint{border-style:dashed;border-color:rgba(255,255,255,.22);',
            '  background:rgba(255,255,255,.03)}',
            '.ep-card.hint .ep-card-title{color:rgba(255,255,255,.55);font-weight:500}',
            '.ep-edit-btn{flex:none;padding:5px 12px;border-radius:999px;cursor:pointer;',
            '  border:1px solid rgba(79,195,247,.5);background:rgba(79,195,247,.12);color:#4fc3f7;',
            '  font-size:12px;font-family:inherit;transition:background .15s}',
            '.ep-edit-btn:hover{background:rgba(79,195,247,.24)}',
            /* 画布编辑抽屉 */
            '.ep-drawer-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(5,5,9,.5);',
            '  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);display:none}',
            '.ep-drawer-mask.open{display:block}',
            '.ep-drawer{position:fixed;top:0;right:0;bottom:0;width:min(980px,94vw);z-index:2147483001;',
            '  display:flex;flex-direction:column;background:#0b0b0e;',
            '  border-left:1px solid rgba(255,255,255,.14);box-shadow:-24px 0 60px -20px rgba(0,0,0,.8);',
            '  transform:translateX(103%);transition:transform .3s cubic-bezier(.22,1,.36,1);',
            '  font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif}',
            '.ep-drawer.open{transform:none}',
            '.ep-drawer-head{flex:none;display:flex;align-items:center;gap:10px;padding:12px 16px;',
            '  border-bottom:1px solid rgba(255,255,255,.1);background:rgba(20,20,28,.9)}',
            '.ep-drawer-title{flex:1;min-width:0;font-size:14px;font-weight:600;color:#e8e8ea;',
            '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.ep-drawer-id{font-size:11.5px;color:rgba(255,255,255,.45);',
            "  font-family:'Courier New',monospace}",
            '.ep-drawer-head button{padding:6px 14px;border-radius:8px;cursor:pointer;',
            '  border:1px solid rgba(255,255,255,.16);background:transparent;color:rgba(255,255,255,.75);',
            '  font-size:13px;font-family:inherit;transition:all .15s}',
            '.ep-drawer-head button:hover{color:#fff;border-color:rgba(255,255,255,.4)}',
            '#epDrawerHost{flex:1;min-height:0;position:relative}',
            '#epDrawerHost iframe{width:100%;height:100%;border:0;display:block;background:#0b0b0e}',
            '.ep-drawer-loading{position:absolute;inset:0;display:flex;align-items:center;',
            '  justify-content:center;padding:20px;text-align:center;font-size:13px;line-height:1.8;',
            '  color:rgba(255,255,255,.6);background:#0b0b0e}'
        ].join('\n');
        document.head.appendChild(s);
    }

    function buildModal() {
        if (document.getElementById(MODAL_ID)) return;
        var wrap = document.createElement('div');
        wrap.id = MODAL_ID;
        wrap.innerHTML =
            '<div class="ep-mask"></div>' +
            '<div class="ep-box">' +
            '<h3>插入画布</h3>' +
            '<div class="ep-sub">选择一块白板或一张导图插入到正文光标处，插入后可以继续写说明文字。</div>' +
            '<div class="ep-tabs">' +
            '<button type="button" data-kind="board" class="active">白板</button>' +
            '<button type="button" data-kind="map">思维导图</button>' +
            '</div>' +
            '<div class="ep-list" id="epList"><div class="ep-hint">正在加载…</div></div>' +
            '<div class="ep-foot">' +
            '<button type="button" class="ep-new" id="epNew">＋ 新建空白画布并插入</button>' +
            '<button type="button" class="ep-close" id="epClose">关闭</button>' +
            '</div>' +
            '<div class="ep-quota" id="epQuota"></div>' +
            '</div>';
        document.body.appendChild(wrap);

        wrap.querySelector('.ep-mask').addEventListener('click', close);
        wrap.querySelector('#epClose').addEventListener('click', close);
        wrap.querySelector('#epNew').addEventListener('click', onCreate);

        var tabs = wrap.querySelectorAll('.ep-tabs button');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].addEventListener('click', function () { switchTab(this.getAttribute('data-kind')); });
        }
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && wrap.classList.contains('open')) close();
        });
    }

    function switchTab(k) {
        kind = k === 'map' ? 'map' : 'board';
        var wrap = document.getElementById(MODAL_ID);
        if (!wrap) return;
        var tabs = wrap.querySelectorAll('.ep-tabs button');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle('active', tabs[i].getAttribute('data-kind') === kind);
        }
        var box = document.getElementById('epList');
        if (box) box.innerHTML = '<div class="ep-hint">正在加载…</div>';
        loadList(kind);
    }

    function api(k) {
        return k === 'map' ? '/api/mindmap?action=list' : '/api/excalidraw?action=list';
    }

    function loadList(k) {
        if (cache[k]) { render(k); return Promise.resolve(); }
        return fetch(api(k), {
            headers: { 'X-Admin-Key': adminKey() },
            cache: 'no-store'
        }).then(function (r) { return r.json(); }).then(function (d) {
            cache[k] = (d && d.status === 'success' && (d.items || d.data)) || [];
            render(k);
        }).catch(function () {
            cache[k] = [];
            render(k, '列表加载失败，请确认已登录后台或稍后重试');
        });
    }

    function render(k, errMsg) {
        if (k !== kind) return;
        var box = document.getElementById('epList');
        if (!box) return;
        if (errMsg) { box.innerHTML = '<div class="ep-hint">' + esc(errMsg) + '</div>'; return; }
        var items = cache[k] || [];
        if (!items.length) {
            box.innerHTML = '<div class="ep-hint">还没有' + (k === 'map' ? '思维导图' : '白板') +
                '。<br>点下方「新建并插入」创建一块，再切到对应的「' +
                (k === 'map' ? '导图' : '白板') + '」形态绘制并保存。</div>';
            return;
        }
        box.innerHTML = items.map(function (it) {
            var id = it.id || '';
            var title = it.title || (k === 'map' ? '未命名导图' : '未命名白板');
            return '<div class="ep-item' + (it.hasKey ? ' locked' : '') + '" data-id="' + esc(id) + '">' +
                '<span class="t">' + esc(title) + '</span>' +
                '<span class="id">' + esc(id) + '</span>' +
                '</div>';
        }).join('');
        var rows = box.querySelectorAll('.ep-item');
        for (var i = 0; i < rows.length; i++) {
            rows[i].addEventListener('click', function () {
                insert(activeVditor, kind, this.getAttribute('data-id'));
            });
        }
    }

    /**
     * 编辑器内的卡片渲染（注册给 Vditor 的 customRenders）。
     * render(el, vditor) 的 el 是 `<pre class="vditor-wysiwyg__pre">`（wysiwyg 模式下渲染后的预览层），
     * 直接把它的内容换成卡片即可 —— 源码仍保留在 Vditor 内部，点击后仍可回到源码编辑。
     *
     * 注意：只处理 language === 'embed'，其它语言（js/python/excalidraw…）返回 undefined，
     * Vditor 会走它自己的代码高亮，不影响既有文章里的代码块。
     */
    function cardRender(el, v) {
        if (!el || el.tagName !== 'PRE') return;

        var code = el.querySelector('code');
        var cls = code ? (code.className || '') : '';
        var lm = cls.match(/language-([\w-]+)/);
        if (!lm || lm[1] !== 'embed') return;

        var stored = code.textContent || '';
        // 兼容一行式（语言行带声明）：源码文本为空但有代码块标题时，从标题里取
        if (!stored.trim()) {
            var holder = el.parentElement;
            if (holder) {
                var titleEl = holder.querySelector('.vditor-wysiwyg__block[data-type=code-block] .vditor-wysiwyg__preview code');
                if (titleEl && titleEl.textContent) stored = titleEl.textContent;
            }
        }

        var conf = parseEmbed(stored);

        function paint(node) { el.innerHTML = ''; el.appendChild(node); }

        if (!conf) {
            var warn = document.createElement('div');
            warn.className = 'ep-card hint';
            warn.innerHTML = '<div class="ep-card-icon">⚠️</div><div class="ep-card-body">' +
                '<div class="ep-card-title">内嵌块未指定画布</div>' +
                '<div class="ep-card-id">点击本块可编辑源码，或在工具栏点「插入画布」</div></div>';
            paint(warn);
            return;
        }

        var isMap = conf.kind === 'map';
        var card = document.createElement('div');
        card.className = 'ep-canvas-card';
        card.setAttribute('contenteditable', 'false');
        card.dataset.kind = conf.kind;
        card.dataset.id = conf.id;

        // 顶部细条：类型 / id / 图注 / 编辑入口（画布本身在下方铺满）
        var bar = document.createElement('div');
        bar.className = 'ep-canvas-bar';
        bar.setAttribute('contenteditable', 'false');
        bar.innerHTML = '<span class="ep-canvas-tag">' + (isMap ? '思维导图' : '白板') + '</span>' +
            '<span class="ep-canvas-id">' + esc(conf.id) + '</span>' +
            (conf.caption ? '<span class="ep-canvas-cap">' + esc(conf.caption) + '</span>' : '');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ep-edit-btn';
        btn.textContent = '在抽屉中编辑';
        btn.setAttribute('contenteditable', 'false');
        btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var holder = btn.closest ? btn.closest('.ep-canvas-card') : null;
            var c = (holder && holder.__epConf) || conf;
            openDrawer(c);
        });
        bar.appendChild(btn);
        card.appendChild(bar);

        // 画布本体：白板用 bundle 直挂（与阅读页同一套 data-excalidraw + ExcalidrawMount），
        // 导图用 iframe 复用现成页面 —— 编辑页与阅读页看到的是同一个渲染结果。
        var canvas = document.createElement('div');
        canvas.className = 'ep-canvas';
        canvas.setAttribute('contenteditable', 'false');
        if (conf.height) canvas.style.height = conf.height + 'px';
        initInlineCanvas(canvas, conf);
        card.appendChild(canvas);

        card.__epConf = conf;
        // 阻止画布内的键盘事件冒泡到 Vditor：否则在画布里按 Del / 输入会被当成正文编辑
        card.addEventListener('keydown', function (e) {
            if (e.target && e.target.closest && e.target.closest('.excalidraw, iframe')) e.stopPropagation();
        }, true);
        card.addEventListener('keypress', function (e) {
            if (e.target && e.target.closest && e.target.closest('.excalidraw, iframe')) e.stopPropagation();
        }, true);
        paint(card);
    }

    /** 在编辑器内直接挂载画布（阅读页的内嵌方式，编辑页复用） */
    function initInlineCanvas(host, conf) {
        if (!host) return;
        // 先放占位，滚到可见时才真正挂载 —— 一篇文章可能引用多个画布，
        // 白板 bundle 4.27MB，若全部立即挂载会拖垮编辑页的打开与滚动。
        host.innerHTML = '<div class="ep-canvas-loading">滚动到这里时加载' +
            (conf.kind === 'map' ? '思维导图' : '白板') + '…</div>';
        observeCanvas(host, conf);
    }

    var mountedCanvas = {};      // 本次页面内已挂载过的画布（Vditor 重渲染换 DOM 时用来判断重挂）
    var canvasObserver = null;

    function getCanvasObserver() {
        if (canvasObserver || typeof IntersectionObserver === 'undefined') return canvasObserver;
        canvasObserver = new IntersectionObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
                if (!entries[i].isIntersecting) continue;
                var host = entries[i].target;
                canvasObserver.unobserve(host);
                mountInlineCanvas(host);
            }
        }, { root: null, rootMargin: '320px 0px' });  // 提前 320px 预挂，滚动时已经就绪
        return canvasObserver;
    }

    /** 真正把画布挂进容器（幂等：已挂过就只让 bundle 重扫新容器） */
    function mountInlineCanvas(host) {
        var conf = host.__epConf;
        if (!conf) return;
        var id = conf.kind + ':' + conf.id;
        if (mountedCanvas[id]) {
            // 该画布挂过，但 Vditor 重渲染换掉了 DOM → 让 bundle 重新挂到新容器
            if (conf.kind === 'board') {
                if (window.ExcalidrawMount) window.ExcalidrawMount();
                else loadExcalidrawBundleFor();
            } else {
                renderInlineFrame(host, conf);
            }
            return;
        }
        if (conf.kind === 'map') {
            renderInlineFrame(host, conf);
        } else {
            renderInlineBoard(host, conf);
            loadExcalidrawBundleFor();
        }
        mountedCanvas[id] = 1;
    }

    function renderInlineFrame(host, conf) {
        host.innerHTML = '<iframe class="ep-inline-frame" title="思维导图" loading="lazy" src="' +
            '/mindmap.html?note=' + encodeURIComponent(conf.id) + '"></iframe>';
    }

    function renderInlineBoard(host, conf) {
        host.innerHTML = '';
        var el = document.createElement('div');
        el.className = 'ep-inline-board';
        el.setAttribute('data-excalidraw', '');
        el.setAttribute('data-note', conf.id);
        el.setAttribute('data-mode', 'view');
        host.appendChild(el);
    }

    function observeCanvas(host, conf) {
        host.__epConf = conf;
        var io = getCanvasObserver();
        if (!io) { mountInlineCanvas(host); return; }  // 不支持 IntersectionObserver 时直接挂载
        io.observe(host);
    }

    /** 编辑器内嵌白板也要用到 bundle；与 admin-edit.js / admin-app.js 各自的加载器共用同一份产物 */
    function loadExcalidrawBundleFor() {
        if (window.ExcalidrawMount) { window.ExcalidrawMount(); return; }
        if (document.querySelector('script[data-excalidraw-bundle-embed]')) return;
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '/js/vendor/excalidraw/excalidraw-editor.v30.css';
        css.dataset.excalidrawBundleEmbed = '1';
        document.head.appendChild(css);
        var s = document.createElement('script');
        s.src = '/js/vendor/excalidraw/excalidraw-editor.v30.js';
        s.dataset.excalidrawBundleEmbed = '1';
        s.onload = function () { if (window.ExcalidrawMount) window.ExcalidrawMount(); };
        s.onerror = function () {
            document.querySelectorAll('.ep-inline-board').forEach(function (el) {
                el.innerHTML = '<div class="ep-canvas-loading">白板组件加载失败，请刷新重试</div>';
            });
        };
        document.head.appendChild(s);
    }

    /**
     * 把正文里引用的所有画布先落盘。
     *
     * 为什么必须做：内嵌块的真实内容存在画布自己的 store（excalidraw / mindmaps），
     * 与文章正文是两套存储。若文章先提交而画布改动未落盘，就会「文章存了、画布丢了」。
     *
     * 依据的钩子（由画布编辑器暴露给宿主页）：
     *   __excalidrawSave(showTip) -> Promise<boolean>   __excalidrawDirty() -> boolean
     *   __mindmapSave()          -> Promise<boolean>   __mindmapDirty()    -> boolean
     *
     * 返回 { ok, failed: [] }。只有「找到编辑器且保存被拒」才算失败；
     * 未挂载（元素不存在）视为无需保存，不阻断文章提交。
     */
    /**
     * 画布 id 形状校验。
     * 画布 id 由前端生成（wb- / mm- 前缀，含 base36 随机段），据此过滤掉
     * 普通正文里恰好写成 `board: 某某` 的句子，避免误触发画布保存。
     */
    function looksLikeCanvasId(id) {
        return /^(?:wb|mm|map)-[A-Za-z0-9_-]{3,}$/.test(id) || /^(?:wb|mm)-[A-Za-z0-9_-]+$/.test(id);
    }

    /**
     * 从正文提取内嵌块引用（供保存前落盘、以及内容形态判定共用）。
     * 返回 [{ kind: 'board'|'map', id }]
     */
    function extractBlockRefs(md) {
        if (!md) return [];
        // 三种写法（允许行首反引号与 ≤4 空格缩进）：
        //   1) 内容行         ```embed + 次行 board:xxx   （当前写入格式）
        //   2) 代码块语言行   ```embed board:xxx          （历史语法）
        //   3) 代码块语言行   ```excalidraw + 次行 id     （历史语法）
        // 叠加 looksLikeCanvasId 形状校验，避免把普通正文里的「board:」当成引用。
        var patterns = [
            /^[ \t]{0,4}(?:`{3,})?(?:board|map)\s*:\s*([A-Za-z0-9_.\u4e00-\u9fa5-]{1,64})/gm,
            /^[ \t]{0,4}(?:`{3,})?embed[ \t]+(?:board|map)\s*:\s*([A-Za-z0-9_.\u4e00-\u9fa5-]{1,64})/gm,
            /^[ \t]{0,4}(?:`{3,})?(?:excalidraw|mindmap)[ \t]*\n[ \t]{0,4}([A-Za-z0-9_.\u4e00-\u9fa5-]{1,64})/gm
        ];
        var out = [], seen = {};
        for (var pi = 0; pi < patterns.length; pi++) {
            patterns[pi].lastIndex = 0;
            var m;
            while ((m = patterns[pi].exec(md))) {
                var id = m[1];
                if (!id || seen[id] || !looksLikeCanvasId(id)) continue;
                seen[id] = 1;
                out.push({ kind: id.indexOf('mm-') === 0 ? 'map' : 'board', id: id });
            }
        }
        return out;
    }

    /**
     * 去掉内嵌块标记后，是否还剩正文文字。
     * 关键在于把「代码块整体」剥掉（含语言行与内容行的画布 id），否则
     * ```excalidraw + 次行 id 这种历史写法会把 id 当成正文，导致形态判定失效。
     */
    function hasProse(md) {
        if (!md) return false;
        var ID = '[A-Za-z0-9_.\\u4e00-\\u9fa5-]{1,64}';
        var stripped = md
            // 一行式：```embed board:xxx
            .replace(new RegExp('^[ \\t]{0,4}(?:`{3,})?embed[ \\t]+(?:board|map)\\s*:\\s*' + ID + '[ \\t]*$', 'gm'), '')
            // 内容行：```embed + 次行 board:xxx
            .replace(new RegExp('^[ \\t]{0,4}(?:`{3,})?embed[ \\t]*\\n[ \\t]{0,4}(?:board|map)\\s*:\\s*' + ID + '[ \\t]*$', 'gm'), '')
            // 历史语法：```excalidraw / ```mindmap + 次行 id
            .replace(new RegExp('^[ \\t]{0,4}(?:`{3,})?(?:excalidraw|mindmap)[ \\t]*\\n[ \\t]{0,4}' + ID + '[ \\t]*$', 'gm'), '')
            // 残留的单独 fence 行
            .replace(/^[ \t]{0,4}`{3,}[ \t]*$/gm, '');
        return stripped.replace(/\s/g, '').length > 0;
    }

    /**
     * 内容形态判定（方案 5.2 的规则）：
     *   正文去掉块标记后为空 且 只引用了一个块  → 保留独立画布形态（整页展示）
     *   否则                                  → article（阅读页内联渲染）
     *
     * 两个刻意的例外（避免误判）：
     *   1) 用户已明确选择 card（随记）→ 保持随记
     *   2) 用户显式选了 whiteboard/mindmap 却还没插入任何块 → 保持其选择，
     *      以免仅因「正文暂时为空」就把类型改掉
     */
    function deriveContentType(currentType, md) {
        if (currentType === 'card') return 'card';
        // 用户显式选了画布形态（写文章页的形态切换器）→ 尊重其选择，不因正文暂时为空而改类型
        if (currentType === 'whiteboard' || currentType === 'mindmap') return currentType;
        var refs = extractBlockRefs(md);
        var prose = hasProse(md);
        if (!prose && refs.length === 1) {
            return refs[0].kind === 'map' ? 'mindmap' : 'whiteboard';
        }
        return 'article';
    }

    async function flushEmbeds(vd) {
        var md = '';
        try { md = vd && typeof vd.getValue === 'function' ? vd.getValue() : ''; } catch (e) { md = ''; }
        if (!md) return { ok: true, failed: [] };

        var blocks = extractBlockRefs(md);
        if (!blocks.length) return { ok: true, failed: [] };

        var failed = [];
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            var w = findCanvasWindow(b.id, b.kind);
            if (!w) continue; // 该画布未挂载在页面上：无改动需要落盘
            var isMap = b.kind === 'map';
            var saver = w[isMap ? '__mindmapSave' : '__excalidrawSave'];
            var dirtyFn = w[isMap ? '__mindmapDirty' : '__excalidrawDirty'];
            if (typeof saver !== 'function') continue;
            try {
                if (typeof dirtyFn === 'function' && !dirtyFn()) continue; // 无改动，避免多出新版本
            } catch (e) { /* 忽略，继续尝试保存 */ }
            var ok = false;
            try {
                // 白板的 save 接受 showTip 参数，宿主触发时不要弹它自己的提示
                ok = isMap ? !!(await saver()) : !!(await saver(false));
            } catch (e) {
                ok = false;
            }
            if (!ok) failed.push(b.kind + ':' + b.id);
        }
        return { ok: failed.length === 0, failed: failed };
    }

    /** 找到承载指定画布的编辑器 iframe 的 contentWindow */
    function findCanvasWindow(id, kind) {
        if (!id) return null;
        // 优先：按 kind 选对应容器的 iframe（后台编辑页 / 写文章页的挂载点）
        var preferred = kind === 'map'
            ? ['[id$="MapHost"] iframe', '#epDrawerHost iframe', '#mmMapHost iframe', '#eeMindmapHost iframe']
            : ['[id$="BoardHost"] iframe', '#epDrawerHost iframe', '#wbBoardHost iframe', '#eeBoardHost iframe'];
        // 兜底：任何 src 里带该画布 id 的 iframe（不限容器）
        var fallbacks = ['iframe[src*="' + id + '"]'];

        var groups = [preferred, fallbacks];
        for (var g = 0; g < groups.length; g++) {
            for (var s = 0; s < groups[g].length; s++) {
                var list = null;
                try { list = document.querySelectorAll(groups[g][s]); } catch (e) { list = null; }
                if (!list || !list.length) continue;
                for (var i = 0; i < list.length; i++) {
                    try {
                        var w = list[i].contentWindow;
                        if (!w || !w.document) continue;
                        if (w.document.readyState === 'uninitialized') continue;
                        return w;
                    } catch (e) { /* 跨域：跳过 */ }
                }
            }
        }
        return null;
    }

    /* =====================================================================
     * 画布编辑抽屉
     * 点编辑器内卡片上的「编辑 / 查看」→ 右侧抽屉内嵌完整画布编辑器，
     * 与后台既有的编辑器同源同参数（白板 from=admin&capsule=0，导图 from=admin）。
     * 关闭时先把改动落盘，避免「关了抽屉、改动丢了」。
     * ===================================================================== */
    var DRAWER_ID = 'epDrawer';
    var drawerConf = null;

    function buildDrawer() {
        if (document.getElementById(DRAWER_ID)) return;
        var mask = document.createElement('div');
        mask.className = 'ep-drawer-mask';
        var box = document.createElement('aside');
        box.id = DRAWER_ID;
        box.className = 'ep-drawer';
        box.innerHTML =
            '<div class="ep-drawer-head">' +
            '<div class="ep-drawer-title" id="epDrawerTitle">画布</div>' +
            '<div class="ep-drawer-id" id="epDrawerId"></div>' +
            '<button type="button" id="epDrawerClose">完成</button>' +
            '</div>' +
            '<div id="epDrawerHost"></div>';
        document.body.appendChild(mask);
        document.body.appendChild(box);

        mask.addEventListener('click', function () { closeDrawer(); });
        box.querySelector('#epDrawerClose').addEventListener('click', function () { closeDrawer(); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && box.classList.contains('open')) closeDrawer();
        });
    }

    function openDrawer(conf) {
        if (!conf || !conf.id) return;
        injectStyle();
        buildDrawer();
        drawerConf = conf;
        var isMap = conf.kind === 'map';
        var title = document.getElementById('epDrawerTitle');
        var idEl = document.getElementById('epDrawerId');
        var host = document.getElementById('epDrawerHost');
        if (title) title.textContent = (isMap ? '思维导图' : '白板') + (conf.caption ? ' · ' + conf.caption : '');
        if (idEl) idEl.textContent = conf.id;
        if (host) {
            host.innerHTML = '<iframe title="' + (isMap ? '导图编辑器' : '白板编辑器') + '" src="' +
                (isMap
                    ? '/mindmap.html?note=' + encodeURIComponent(conf.id) + '&edit=1&from=admin'
                    : '/excalidraw.html?note=' + encodeURIComponent(conf.id) + '&edit=1&from=admin&capsule=0') +
                '"></iframe>';
            // 画布编辑器体积大（白板 bundle 4MB+），弱网下可能迟迟不出现。
            // 给一个延迟提示，避免用户看到一片空白以为坏了。
            var tipTimer = setTimeout(function () {
                var fr = host.querySelector('iframe');
                if (!fr) return;
                var hint = document.createElement('div');
                hint.className = 'ep-drawer-loading';
                hint.textContent = '画布编辑器加载中…（首次打开需要下载组件，弱网会慢一些）';
                host.appendChild(hint);
                fr.addEventListener('load', function () { hint.remove(); }, { once: true });
            }, 1200);
            var frameEl = host.querySelector('iframe');
            if (frameEl) frameEl.addEventListener('load', function () { clearTimeout(tipTimer); }, { once: true });
        }
        document.querySelector('.ep-drawer-mask').classList.add('open');
        document.getElementById(DRAWER_ID).classList.add('open');
    }

    async function closeDrawer() {
        var box = document.getElementById(DRAWER_ID);
        if (!box || !box.classList.contains('open')) return;
        var conf = drawerConf;
        drawerConf = null;
        // 先把抽屉里画布的未落盘改动存掉，避免直接关闭丢改动
        if (conf) {
            var res = await saveDrawerCanvas(conf);
            if (!res.ok) {
                toast('画布保存未完成（' + res.reason + '），已保留抽屉以免丢失改动', 5200);
                return; // 不关闭，让用户自己处理
            }
            if (res.saved) toast('画布改动已保存', 2200);
        }
        var mask = document.querySelector('.ep-drawer-mask');
        if (mask) mask.classList.remove('open');
        box.classList.remove('open');
        var host = document.getElementById('epDrawerHost');
        if (host) host.innerHTML = ''; // 卸载 iframe，释放画布资源
    }

    /**
     * 保存抽屉当前画布。
     * 返回 { ok, saved, reason }：ok=false 表示保存失败（调用方应保留抽屉）；
     * saved 表示确实发生了保存（否则只是没有改动，无需提示）。
     */
    async function saveDrawerCanvas(conf) {
        var w = findCanvasWindow(conf.id, conf.kind);
        if (!w) return { ok: true, saved: false, reason: '未挂载' };
        var isMap = conf.kind === 'map';
        var saver = w[isMap ? '__mindmapSave' : '__excalidrawSave'];
        var dirtyFn = w[isMap ? '__mindmapDirty' : '__excalidrawDirty'];
        if (typeof saver !== 'function') return { ok: true, saved: false, reason: '编辑器未就绪' };
        var dirty = true;
        try { if (typeof dirtyFn === 'function') dirty = !!dirtyFn(); } catch (e) { dirty = true; }
        if (!dirty) return { ok: true, saved: false, reason: '无改动' };
        try {
            var ok = isMap ? !!(await saver()) : !!(await saver(false));
            return ok ? { ok: true, saved: true } : { ok: false, reason: '保存被拒（口令或权限）' };
        } catch (e) {
            return { ok: false, reason: (e && e.message) || '网络错误' };
        }
    }

    function toast(msg, ms) {
        var t = document.createElement('div');
        t.className = 'ep-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, ms || 3200);
    }

    // 单篇文章允许引用的画布数量上限。
    // 目的是保护打开与滚动性能：白板 bundle 4.27MB，即使有懒挂载，
    // 一块白板展开后仍要占内存与 GPU，数量失控会拖垮编辑与阅读。
    var MAX_CANVAS_PER_ARTICLE = 5;

    /** 正文里已有的画布引用数 */
    function countRefsInEditor() {
        var md = '';
        try { md = activeVditor && typeof activeVditor.getValue === 'function' ? activeVditor.getValue() : ''; } catch (e) { md = ''; }
        return extractBlockRefs(md).length;
    }

    /**
     * 额度检查。
     * 返回 { ok, used, max, reason }：ok=false 时调用方应提示并中止插入。
     * 只在「插入新的块」时校验；已有文章的历史内容不受影响（避免打不开老文章）。
     */
    function checkQuota() {
        var used = countRefsInEditor();
        if (used >= MAX_CANVAS_PER_ARTICLE) {
            return {
                ok: false, used: used, max: MAX_CANVAS_PER_ARTICLE,
                reason: '一篇文章最多引用 ' + MAX_CANVAS_PER_ARTICLE + ' 个画布（当前已有 ' + used +
                    ' 个）。请先删掉不用的内嵌块，或在独立页面里发布新的白板 / 导图。'
            };
        }
        return { ok: true, used: used, max: MAX_CANVAS_PER_ARTICLE };
    }

    function insert(vd, k, id) {
        if (!id) return;
        // 先记住目标编辑器，checkQuota 与后续插入必须针对同一个编辑器（否则会读错正文里的引用数）
        if (vd) activeVditor = vd;
        var q = checkQuota();
        if (!q.ok) { toast(q.reason, 5200); return; }
        // 注意：声明必须放在「内容行」。若写成 ```embed map:xxx（语言行带参数），
        // Vditor 会把语言行之后的内容当作代码块标题，getValue() 往返时 id 会丢失。
        var block = '```embed\n' + k + ':' + id + '\n```\n';
        if (vd && typeof vd.insertValue === 'function') {
            try { vd.insertValue(block); } catch (e) { /* 忽略 */ }
        }
        if (typeof window.eeMarkDirty === 'function') window.eeMarkDirty();
        close();
        toast('已插入' + (k === 'map' ? '思维导图' : '白板') + '，保存后在文章里显示');
    }

    /** 新建一块画布并直接插入（不再只是插一个空引用，见 createAndInsert） */
    function onCreate() {
        var k = kind;
        var isMap = k === 'map';
        var label = isMap ? '思维导图' : '白板';
        var q = checkQuota();
        if (!q.ok) { toast(q.reason, 5200); return; }

        var name = '';
        try {
            name = (window.prompt('给新建的' + label + '起个名字（可留空）', '') || '').trim().slice(0, 60);
        } catch (e) { name = ''; }

        var newId = (isMap ? 'mm-' : 'wb-') + Math.random().toString(36).slice(2, 10);
        var conf = { kind: k, id: newId, title: name, caption: '' };
        insert(activeVditor, k, newId);
        toast('已插入新' + label + (name ? '「' + name + '」' : '') +
            '。点该块上的「在抽屉中编辑」开始绘制，关闭抽屉时会自动保存。', 6500);
        // 直接打开抽屉让用户马上开始画（新建的画布本来就是空的）
        setTimeout(function () { openDrawer(conf); }, 120);
    }

    function updateQuota() {
        var el = document.getElementById('epQuota');
        if (!el) return;
        var q = checkQuota();
        el.textContent = q.ok
            ? '本文已引用 ' + q.used + ' / ' + q.max + ' 个画布'
            : '已达上限 ' + q.max + ' 个（当前 ' + q.used + ' 个）—— 请先删掉不用的内嵌块';
        el.classList.toggle('full', !q.ok);
    }

    function open(vd) {
        injectStyle();
        buildModal();
        activeVditor = vd || activeVditor;
        var wrap = document.getElementById(MODAL_ID);
        if (!wrap) return;
        wrap.classList.add('open');
        switchTab('board');
        updateQuota();
    }

    function close() {
        var wrap = document.getElementById(MODAL_ID);
        if (wrap) wrap.classList.remove('open');
    }

    /**
     * 给工具栏按钮补图标。
     * 点击行为由工具栏项自己的 click 方法负责（见 EmbedPickerToolbarItem），
     * 这里**不再额外绑定事件**，否则会与 click 重复触发（打开两次面板）。
     */
    function bindToolbar(vd) {
        var btn = null;
        try {
            btn = document.querySelector('[data-type="eeEmbedPick"]') ||
                (vd && vd.toolbar && vd.toolbar.elements && vd.toolbar.elements.eeEmbedPick);
        } catch (e) { /* 忽略 */ }
        if (!btn || btn.dataset.epIcon) return;
        btn.dataset.epIcon = '1';
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="3" y="3" width="18" height="18" rx="2"></rect>' +
            '<path d="M8 12h8M12 8v8"></path></svg>';
        btn.setAttribute('aria-label', '插入白板 / 思维导图');
    }

    /**
     * 工具栏项定义（供两个编辑器复用）。
     *
     * 关键：Vditor 的工具栏项构造函数会**直接调用** `n.click(e, t)` 且不判空——
     *     r.element.children[0].addEventListener(事件, function (e) {
     *         e.preventDefault(), 已禁用 || n.click(e, t)
     *     })
     * 因此自定义按钮必须提供 click 方法，否则点击时报
     * `Uncaught TypeError: n.click is not a function`。
     */
    window.EmbedPickerToolbarItem = {
        name: 'eeEmbedPick',
        tip: '插入白板 / 思维导图',
        click: function () { open(activeVditor); }
    };

    window.EmbedPicker = {
        open: open,
        close: close,
        insert: insert,
        bindToolbar: bindToolbar,
        setVditor: function (vd) { activeVditor = vd; },
        /** 把正文引用的所有画布先落盘（保存文章前调用，避免画布改动丢失） */
        flushEmbeds: flushEmbeds,
        /** 从正文提取内嵌块引用（保存前落盘 / 内容形态判定共用） */
        extractBlockRefs: extractBlockRefs,
        /** 内容形态判定：返回 'article' | 'whiteboard' | 'mindmap' | 'card' */
        deriveContentType: deriveContentType,
        /** 单篇文章的画布数量上限与当前用量检查 */
        MAX_CANVAS_PER_ARTICLE: MAX_CANVAS_PER_ARTICLE,
        checkQuota: checkQuota,
        /** 画布编辑抽屉：openDrawer({kind,id,caption}) / closeDrawer() */
        openDrawer: openDrawer,
        closeDrawer: closeDrawer,
        /** 注册给 Vditor 的 customRenders，让内嵌块在编辑器里显示为卡片 */
        customRenders: [{ language: 'embed', render: cardRender }]
    };
})();
