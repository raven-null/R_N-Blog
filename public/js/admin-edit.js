/**
 * 独立编辑页脚本（admin-edit.html）
 * 用途：对已发布/草稿的文章、随记、白板进行再次编辑，不再占用后台「写文章」页
 * 白板文章额外提供白板管理：访问权限 / 编辑口令 / 白板名称 / 历史版本回滚（v1.3.0）
 * v1.10.0：侧栏新增「本文内嵌画布」清单（显示画布名称，点击定位到正文块）
 * v1.10.1：顶栏重排 —— 字数/保存状态搬进顶栏、删掉类型与状态徽标、「保存并预览」挪进侧栏
 * v1.11.0：发布不再弹窗（侧栏已有状态/标签/封面，缺东西用胶囊提示）；
 *          弹窗里独有的导图编辑口令搬到侧栏「导图口令」卡片
 * v1.12.0：编辑器改造 —— 精简顶部工具栏、接入右键菜单与大纲、侧栏分组、去掉块悬停操作条
 * v1.12.1：标题从编辑区上方搬进侧栏（四种形态统一，白板/导图原本没有写标题的地方）
 * v1.13.0：白板/导图隐藏「本文内嵌画布」；白板去掉独立改名入口（名称跟随标题并自动同步）
 * v1.14.0：侧栏细节 —— 去掉画板 ID 行、口令改行内「添加」（已设置才出现「清除」）、
 *          导图口令卡片去掉标题与说明、信息卡片移到折叠区最后
 */
(function () {
    'use strict';

    var EXC_BUNDLE_VERSION = 'v30'; // 与 scripts/build-excalidraw.mjs 的 BUNDLE_VERSION 保持一致
    var adminKey = localStorage.getItem('admin_key') || '';
    var params = new URLSearchParams(location.search);
    var docId = params.get('id') || '';
    // 新建模式：/admin-edit.html?new=1&type=article|card|whiteboard|mindmap
    // 与「编辑已有」用同一个页面，区别只在数据来源（新建时不拉取记录）。
    var isNew = params.get('new') === '1';
    var newTypeParam = params.get('type') || 'article';
    var savedOnce = false;   // 本页是否已经落库过一次（落库后「新建」就变成「编辑已有」）
    var doc = null;          // 当前文章数据（新建模式下是一个尚未落库的空壳）
    var docType = 'article'; // article | card | whiteboard | mindmap
    var vditor = null;
    var vditorReady = false;
    var pendingMd = null;
    var dirty = false;
    var savedTimer = null;

    var editorThemes = {
        dark: { bg: 'rgba(26,26,26,.8)', text: '#fff', pre: 'rgba(8,8,8,.6)' },
        light: { bg: 'rgba(255,255,255,.95)', text: '#1a1a1a', pre: '#f0f0f0' },
        sepia: { bg: 'rgba(244,236,216,.95)', text: '#3e332a', pre: 'rgba(210,195,170,.5)' },
        green: { bg: 'rgba(199,237,204,.9)', text: '#1a3a1a', pre: 'rgba(170,210,175,.5)' },
        blue: { bg: 'rgba(220,232,245,.9)', text: '#1a2a3a', pre: 'rgba(190,205,225,.5)' }
    };
    var THEME_CLASSES = ['vditor-theme-dark', 'vditor-theme-light', 'vditor-theme-sepia', 'vditor-theme-green', 'vditor-theme-blue'];

    // ===== 基础工具 =====
    function $(id) { return document.getElementById(id); }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function toast(msg, type) {
        var t = $('eeToast');
        t.textContent = msg;
        t.className = 'ee-toast show' + (type ? ' ' + type : '');
        clearTimeout(t._timer);
        t._timer = setTimeout(function () { t.className = 'ee-toast'; }, 2600);
    }
    function api(query, opts) {
        opts = opts || {};
        return fetch('/api/admin?' + query, {
            method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
            body: opts.body,
            cache: 'no-store'
        }).then(function (r) { return r.json(); });
    }
    function notifyChanged() {
        try { var bc = new BroadcastChannel('blog-articles'); bc.postMessage({ type: 'articles-changed' }); bc.close(); } catch (e) { }
    }
    function typeLabel(t) {
        return t === 'whiteboard' ? '白板' : (t === 'mindmap' ? '导图' : (t === 'card' ? '随记' : '文章'));
    }
    /** 把任意输入收敛到四种内容形态之一 */
    function normalizeType(t) {
        return (t === 'whiteboard' || t === 'mindmap' || t === 'card') ? t : 'article';
    }
    /** 画布 id：沿用全站约定 wb- / mm- + 8 位 base36 随机段（见 embed-picker.js） */
    function newCanvasId(t) {
        return (t === 'mindmap' ? 'mm-' : 'wb-') + Math.random().toString(36).slice(2, 10);
    }

    // ===== 标签选择器（与后台写文章页同款：chips + 下拉建议 + 回车确认）=====
    var tagPicker = null;      // 侧栏标签（发布弹窗已去掉，现在只有这一个）

    function currentTags() { return tagPicker ? tagPicker.getTags() : []; }

    function initTagPickers() {
        if (!window.TagPicker) return;
        if (!tagPicker && $('eeTagsPicker')) {
            tagPicker = window.TagPicker.create($('eeTagsPicker'), {
                placeholder: '添加标签，回车确认…',
                onChange: function () { window.eeMarkDirty(); }
            });
        }
    }

    // 已有标签作为下拉建议（失败时忽略，不影响自由输入）
    function loadTagSuggestions() {
        api('action=tags').then(function (r) {
            if (!r || r.status !== 'success') return;
            var names = (r.data || []).map(function (t) { return t.name; }).filter(Boolean);
            if (tagPicker) tagPicker.setSuggestions(names);
        }).catch(function () { /* 忽略 */ });
    }

    // ===== 未保存提示 =====
    var canvasListTimer = null;
    function scheduleCanvasListRefresh() {
        clearTimeout(canvasListTimer);
        canvasListTimer = setTimeout(refreshCanvasList, 600);   // 打字时别每敲一下就重画侧栏
    }
    window.eeMarkDirty = function () {
        dirty = true;
        $('eeSaved').textContent = '有未保存改动';
        $('eeSaved').style.color = '#ffb020';
        scheduleCanvasListRefresh();
    };
    window.addEventListener('beforeunload', function (e) {
        if (!dirty) return;
        e.preventDefault();
        e.returnValue = '';
    });
    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            eeSave();
        }
    });

    // ===== 编辑器 =====
    function applyTheme() {
        var theme = localStorage.getItem('editor_theme') || 'sepia';
        var t = editorThemes[theme] || editorThemes.sepia;
        var el = $('eeVditor');
        if (!el) return;
        THEME_CLASSES.forEach(function (c) { el.classList.remove(c); });
        el.classList.add('vditor-theme-' + theme);
        el.style.setProperty('--editor-bg', t.bg);
        el.style.setProperty('--editor-text', t.text);
        el.style.setProperty('--editor-pre-bg', t.pre);
    }
    function editorHeight() {
        var col = $('eeEditorCol');
        var h = col ? col.clientHeight : 0;
        // 标题卡已经搬到侧栏，这里只剩「分章」条会占高度（而且只在分章文章里出现），
        // 所以按它实际高度动态扣，而不是像以前那样写死减一个数。
        var bar = $('eeChapterBar');
        if (bar && bar.offsetParent !== null) h -= (bar.offsetHeight + 10);
        return Math.max(360, h);
    }
    function fitEditor() {
        var el = $('eeVditor');
        if (!el || el.classList.contains('vditor--fullscreen')) return;
        el.style.height = editorHeight() + 'px';
    }

    // ===== 侧栏折叠 =====
    // 折叠状态存在 localStorage，刷新后保持。显隐由 .ee-main.side-collapsed 这个类控制
    // （CSS 里带 !important，因为 applyDoc() 会直接写 style.display='flex'）。
    var SIDE_KEY = 'ee_side_collapsed';
    function sideCollapsed() {
        try { return localStorage.getItem(SIDE_KEY) === '1'; } catch (e) { return false; }
    }
    function applySideCollapsed() {
        var main = document.querySelector('.ee-main');
        if (!main) return;
        var collapsed = sideCollapsed();
        main.classList.toggle('side-collapsed', collapsed);
        var btn = $('eeSideToggle');
        if (btn) {
            btn.innerHTML = collapsed ? '展开 <span class="chev">‹</span>' : '折叠 <span class="chev">›</span>';
            btn.title = (collapsed ? '展开' : '折叠') + '侧栏（Ctrl+.）';
        }
        var handle = $('eeSideOpen');
        if (handle) handle.setAttribute('aria-hidden', collapsed ? 'false' : 'true');
        // 编辑区宽度变了，让编辑器重新贴合
        setTimeout(fitEditor, 60);
    }
    window.eeToggleSide = function () {
        var main = document.querySelector('.ee-main');
        if (!main) return;
        var next = !main.classList.contains('side-collapsed');
        try { localStorage.setItem(SIDE_KEY, next ? '1' : '0'); } catch (e) { /* 隐私模式等，忽略 */ }
        applySideCollapsed();
        toast(next ? '侧栏已折叠（Ctrl+. 展开）' : '侧栏已展开');
    };
    // Ctrl/Cmd + . 切换；用捕获阶段，避免被 Vditor 的快捷键吞掉
    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === '.' || e.code === 'Period')) {
            e.preventDefault();
            window.eeToggleSide();
        }
    }, true);
    function updateInfo() {
        if (!vditor) return;
        var v = vditor.getValue() || '';
        $('eeInfo').textContent = v.length + ' 字';
    }
    function initEditor() {
        if (vditor) return vditor;
        var host = $('eeVditor');
        if (typeof Vditor === 'undefined') {
            host.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#8c8fa8;font-size:13px">编辑器加载失败，请刷新重试</div>';
            return null;
        }
        vditor = new Vditor('eeVditor', {
            height: editorHeight(),
            cdn: 'js/vendor/vditor',
            mode: 'wysiwyg',
            theme: 'dark',
            lang: 'zh_CN',
            placeholder: '正文内容……支持 Markdown，粘贴/拖拽图片会自动上传',
            // 顶部只留常用的：其余（删除线 / 行内代码 / 任务 / 缩进 / 分割线 /
            // 编辑模式 / 主题 / 导出…）都进了右键菜单，见 /js/editor-menu.js。
            // 表格故意留在工具栏：它点开会弹「几行几列」的面板，那个面板是贴着
            // 工具栏按钮定位的，从右键菜单里调用会让面板跑到顶部去。
            toolbar: [
                'headings', 'bold', 'italic', 'link',
                '|', 'list', 'ordered-list', 'quote',
                '|', 'code', 'table', 'upload',
                '|', window.EmbedPickerToolbarItem || { name: 'eeEmbedPick', tip: '插入白板 / 思维导图', click: function () {} },
                '|', 'undo', 'redo',
                { name: 'more', toolbar: ['strike', 'inline-code', 'check', 'outdent', 'indent', 'line', 'edit-mode', 'code-theme', 'content-theme', 'export', 'help'] }
            ],
            // 内嵌画布块在编辑器内显示为卡片（逻辑在 /js/embed-picker.js）
            customRenders: window.EmbedPicker ? window.EmbedPicker.customRenders : [],
            upload: {
                accept: 'image/*',
                multiple: true,
                // 自定义上传：走 JSON 通道（与后台一致），前端先压缩
                handler: function (files) {
                    (async function () {
                        for (var i = 0; i < files.length; i++) {
                            var url = await eeUploadImage(files[i]);
                            if (!url) continue;
                            if (vditor) vditor.insertValue('![' + (files[i].name || '图片') + '](' + url + ')');
                        }
                    })();
                }
            },
            cache: { enable: false },
            input: function () { updateInfo(); window.eeMarkDirty(); },
            after: function () {
                vditorReady = true;
                applyTheme();
                if (pendingMd !== null) {
                    vditor.setValue(pendingMd);
                    pendingMd = null;
                }
                updateInfo();
                fitEditor();
                // 工具栏「插入画布」按钮：面板与逻辑在 /js/embed-picker.js（与写文章页共用）
                if (window.EmbedPicker) {
                    window.EmbedPicker.setVditor(vditor);
                    window.EmbedPicker.bindToolbar(vditor);
                }
                // 正文就位后再刷一次侧栏画布清单（setValue 是异步渲染的）
                refreshCanvasList();
                stripVditorPopover();
                // 右键菜单（剪贴板 / 格式 / 插入 / 段落操作），见 /js/editor-menu.js
                if (window.EditorMenu) window.EditorMenu.attach(vditor);
                // 大纲（正文结构导航），见 /js/editor-outline.js
                if (window.EditorOutline) window.EditorOutline.attach(vditor);
            }
        });
        return vditor;
    }
    /**
     * 摘掉 Vditor 的「块悬停操作条」（.vditor-panel--none，里面是上移 / 下移 / 删除）。
     * 功能已经并进右键菜单，所以整条不要了。
     * 除了 CSS 隐藏，这里再从 DOM 摘一次：Vditor 处理 ⇧⌘X 时是
     *     wysiwyg.popover.querySelector('[data-type="remove"]')
     * 拿到按钮才调 click()，摘掉之后那个快捷键会自然失效而不是「看不见却能删」。
     */
    function stripVditorPopover() {
        var pops = document.querySelectorAll('#eeVditor .vditor-panel--none');
        for (var i = 0; i < pops.length; i++) {
            if (pops[i].parentNode) pops[i].parentNode.removeChild(pops[i]);
        }
    }

    function setEditorContent(md) {
        var ed = initEditor();
        if (!ed) return;
        md = md || '';
        if (!vditorReady) { pendingMd = md; return; }
        ed.setValue(md);
        updateInfo();
    }
    function getEditorContent() {
        var ed = initEditor();
        if (!ed) return '';
        // Vditor 的 getValue() 在初始化完成前会抛
        // TypeError: Cannot read properties of undefined (reading 'currentMode')
        // ——页面刚打开就点保存、或本类型根本没用编辑器时都会踩到。等到 after 回调再取。
        if (!vditorReady) return pendingMd || '';
        try { return ed.getValue() || ''; } catch (e) { return pendingMd || ''; }
    }

    // ===== 白板 =====
    function loadExcBundle() {
        if (window.ExcalidrawMount) { window.ExcalidrawMount(); return; }
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '/js/vendor/excalidraw/excalidraw-editor.' + EXC_BUNDLE_VERSION + '.css';
        document.head.appendChild(css);
        var s = document.createElement('script');
        s.src = '/js/vendor/excalidraw/excalidraw-editor.' + EXC_BUNDLE_VERSION + '.js';
        s.onload = function () { if (window.ExcalidrawMount) window.ExcalidrawMount(); };
        s.onerror = function () { $('eeBoardHost').innerHTML = '<div class="ee-hint">白板组件加载失败，请刷新重试</div>'; };
        document.head.appendChild(s);
    }
    function mountBoard() {
        var host = $('eeBoardHost');
        var bid = (doc && doc.boardId) || '';
        if (!bid) {
            host.innerHTML = '<div class="ee-hint">这篇文章还没有绑定画板，无法内嵌编辑；可在此页下方新建画板，或在写文章页切到「白板」形态新建。</div>';
            return;
        }
        var openBtn = null; // 顶栏已无此入口，保留变量以便将来恢复
        if (openBtn) openBtn.href = '/excalidraw.html?note=' + encodeURIComponent(bid) + '&edit=1';
        // iframe 内嵌独立白板页：与编辑页样式/布局隔离，避免相互干扰
        host.innerHTML = '<iframe class="ee-frame" title="白板编辑器" src="/excalidraw.html?note=' + encodeURIComponent(bid) + '&edit=1"></iframe>';
    }
    // ===== 思维导图 =====
    function mapId() { return (doc && doc.mapId) || ''; }
    function mmApi(query, opts, retry) {
        opts = opts || {};
        if (retry === undefined) retry = 1;
        return fetch('/api/mindmap?' + query, {
            method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
            body: opts.body,
            cache: 'no-store'
        }).then(function (r) {
            if (r.status >= 500) throw new Error('HTTP ' + r.status);
            return r.json();
        }).catch(function (err) {
            if (retry > 0) {
                return new Promise(function (res) { setTimeout(res, 700); }).then(function () {
                    return mmApi(query, opts, retry - 1);
                });
            }
            throw err;
        });
    }
    document.addEventListener('DOMContentLoaded', function () { wireMindmapBind(); });
    function mountMindmap() {
        var host = $('eeMindmapHost');
        var mid = mapId();
        if (!host) return;
        if (!mid) {
            // 没绑定：直接给出「选一张已有的 / 新建一张」的入口
            var bar = $('eeMindmapBar');
            if (bar) bar.style.display = 'flex';
            host.innerHTML = '<div class="ee-hint">这篇文章还没绑定导图。选一张已有的，或用「新建一张导图」——' +
                '绑定后这里会直接显示可编辑的导图，图片与内容就存在一起了。</div>';
            void fillMindmapPicker();
            return;
        }
        var bar2 = $('eeMindmapBar');
        if (bar2) bar2.style.display = 'none';
        // iframe 内嵌导图页（与白板同一套交互：底部胶囊、右侧留言抽屉）
        // from=admin 让导图页收起自己的胶囊，由这里顶栏的按钮统一控制
        host.innerHTML = '<iframe class="ee-frame" title="导图编辑器" src="/mindmap.html?note=' +
            encodeURIComponent(mid) + '&edit=1&from=admin"></iframe>';
    }
    /* ===== 文章 → 导图 绑定 ===== */
    function mmListApi() {
        return fetch('/api/mindmap?action=list', {
            headers: { 'X-Admin-Key': adminKey },
            cache: 'no-store'
        }).then(function (r) { return r.json(); });
    }
    function fillMindmapPicker() {
        var sel = $('eeMindmapPick');
        if (!sel || sel.dataset.loaded === '1') return Promise.resolve();
        return mmListApi().then(function (d) {
            if (!d || d.status !== 'success') return;
            var items = d.items || [];
            sel.innerHTML = '<option value="">— 选择一张已有导图 —</option>' +
                items.map(function (it) {
                    return '<option value="' + it.id + '">' +
                        (it.title || '未命名导图').replace(/[<>&]/g, '') +
                        '（' + it.id + (it.hasKey ? '·有口令' : '') + '）</option>';
                }).join('');
            sel.dataset.loaded = '1';
        }).catch(function () { /* 列表拿不到就不显示选项 */ });
    }
    /** 把 doc.mapId 换成新值，并刷新导图区 */
    function bindMindmap(newId) {
        if (!doc) return;
        doc.mapId = newId;
        if (newId && doc.type !== 'mindmap') {
            doc.type = 'mindmap';
            if (typeof window.eeSetType === 'function') window.eeSetType('mindmap');
        }
        mountMindmap();
    }
    function wireMindmapBind() {
        var sel = $('eeMindmapPick');
        var btn = $('eeMindmapBind');
        var nw = $('eeMindmapNew');
        if (btn && !btn.dataset.wired) {
            btn.dataset.wired = '1';
            btn.addEventListener('click', function () {
                var v = sel ? sel.value : '';
                if (!v) { alert('先选一张导图'); return; }
                bindMindmap(v);
            });
        }
        if (nw && !nw.dataset.wired) {
            nw.dataset.wired = '1';
            nw.addEventListener('click', function () {
                // 新建：给一个不会撞车的 id，导图保存时会自动创建
                var nid = 'map-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
                bindMindmap(nid);
            });
        }
    }
    window.eeSaveMindmap = async function () {
        var frame = document.querySelector('#eeMindmapHost iframe.ee-frame');
        var saver = null, dirtyFn = null;
        try {
            saver = frame && frame.contentWindow && frame.contentWindow.__mindmapSave;
            dirtyFn = frame && frame.contentWindow && frame.contentWindow.__mindmapDirty;
        } catch (e) { saver = null; dirtyFn = null; }
        if (typeof saver !== 'function') return true; // 还没挂载好：不阻塞后续保存
        // 没有未落盘的改动就不用打一次保存（避免每次都产生新版本）
        try {
            if (typeof dirtyFn === 'function' && !dirtyFn()) return true;
        } catch (e) { /* 忽略 */ }
        return !!(await saver());
    };

    // ===== 白板管理（移植自后台「白板管理」：权限 / 口令 / 名称 / 历史回滚）=====
    function excApi(query, opts, retry) {
        opts = opts || {};
        if (retry === undefined) retry = 1; // 网络层失败（部署中 / 连接被关闭）自动重试一次
        return fetch('/api/excalidraw?' + query, {
            method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
            body: opts.body,
            cache: 'no-store'
        }).then(function (r) {
            if (r.status >= 500) throw new Error('HTTP ' + r.status);
            return r.json();
        }).catch(function (err) {
            if (retry > 0) {
                return new Promise(function (res) { setTimeout(res, 700); }).then(function () {
                    return excApi(query, opts, retry - 1);
                });
            }
            throw err;
        });
    }
    function boardId() { return (doc && doc.boardId) || ''; }

    // 同步「开放编辑 / 设为只读」按钮的选中高亮（-1 表示未知/读取失败，两个都不亮）
    function markEditableButtons(state) {
        var on = $('eeBaEditOn'), off = $('eeBaEditOff');
        if (on) on.classList.toggle('active', state === 1);
        if (off) off.classList.toggle('active', state === 0);
    }

    // 修改白板 meta（标题 / 权限 / 口令）
    async function boardMetaSet(body, okMsg) {
        var bid = boardId();
        if (!bid) { toast('该文章还没有绑定画板', 'error'); return false; }
        var d = await excApi('action=meta&id=' + encodeURIComponent(bid), {
            method: 'POST',
            body: JSON.stringify(body)
        });
        if (d.status !== 'success') { toast(d.message || '操作失败', 'error'); return false; }
        if (okMsg) toast(okMsg, 'success');
        window.eeLoadBoardAdmin();
        notifyChanged();
        return true;
    }

    // ===== 导图口令（原来只在发布弹窗里能设，弹窗去掉后搬到侧栏）=====
    async function refreshMapKeyCard() {
        var card = $('eeMapKeyCard');
        if (!card) return;
        var mid = mapId();
        if (docType !== 'mindmap' || !mid) { card.style.display = 'none'; return; }
        card.style.display = '';
        try {
            var d = await mmApi('id=' + encodeURIComponent(mid) + '&metaOnly=1');
            var hasKey = !!(d && d.status === 'success' && d.meta && d.meta.hasKey);
            $('eeMapKey').textContent = hasKey ? '已设置' : '未设置';
            // 只有设过口令才给「清除」按钮 —— 没设过时它点了也没意义
            var clr = $('eeMapKeyClear');
            if (clr) clr.style.display = hasKey ? '' : 'none';
        } catch (e) {
            $('eeMapKey').textContent = '读取失败';   // 接口不可用时降级，不抛未捕获异常
            var clr2 = $('eeMapKeyClear');
            if (clr2) clr2.style.display = 'none';
        }
    }
    async function mapMetaSet(body, okMsg) {
        var mid = mapId();
        if (!mid) { toast('导图还没保存，先保存一次', 'error'); return false; }
        var d = await mmApi('action=meta&id=' + encodeURIComponent(mid), {
            method: 'POST',
            body: JSON.stringify(body)
        });
        if (!d || d.status !== 'success') { toast((d && d.message) || '操作失败', 'error'); return false; }
        if (okMsg) toast(okMsg, 'success');
        refreshMapKeyCard();
        notifyChanged();
        return true;
    }
    window.eeSaveMapKey = async function () {
        var k = ($('eeMapKeyInput').value || '').trim();
        if (k.length < 4) { toast('口令至少 4 位', 'error'); return; }
        if (await mapMetaSet({ editKey: k }, '导图口令已设置')) $('eeMapKeyInput').value = '';
    };
    window.eeClearMapKey = async function () {
        if (!window.confirm('确定清除这张导图的编辑口令？清除后任何人都能编辑它。')) return;
        mapMetaSet({ editKey: '' }, '导图口令已清除');
    };

    window.eeLoadBoardAdmin = async function () {
        var card = $('eeBoardAdminCard');
        if (!card) return;
        var bid = boardId();
        if (docType !== 'whiteboard' || !bid) { card.style.display = 'none'; return; }
        card.style.display = '';
        try {
            var d = await excApi('id=' + encodeURIComponent(bid) + '&metaOnly=1');
            if (d.status === 'success' && d.meta) {
                $('eeBaEditable').textContent = d.meta.editable === 1 ? '公开可编辑' : '只读';
                $('eeBaKey').textContent = d.meta.hasKey ? '已设置' : '未设置';
                markEditableButtons(d.meta.editable === 1 ? 1 : 0);
                // 只有设过口令才给「清除」按钮 —— 没设过时它点了也没意义
                var clr = $('eeBaKeyClear');
                if (clr) clr.style.display = d.meta.hasKey ? '' : 'none';
            } else {
                $('eeBaEditable').textContent = '画板不存在';
                $('eeBaKey').textContent = '—';
                markEditableButtons(-1);
                var clr2 = $('eeBaKeyClear');
                if (clr2) clr2.style.display = 'none';
            }
        } catch (e) {
            // 接口不可用（部署中 / 连接被关闭）时降级显示，不抛未捕获异常
            $('eeBaEditable').textContent = '读取失败';
            $('eeBaKey').textContent = '—';
            $('eeBaRev').textContent = '接口暂时不可用';
            markEditableButtons(-1);
            var clr3 = $('eeBaKeyClear');
            if (clr3) clr3.style.display = 'none';
            toast('白板信息读取失败（网络或部署中），可点「刷新历史」重试', 'error');
        }
        window.eeLoadBoardHistory();
    };

    window.eeSetBoardEditable = function (v) {
        boardMetaSet({ editable: v }, v === 1 ? '已开放编辑' : '已设为只读');
    };

    // 白板名称不再是独立入口：它就是侧栏顶部的「标题」，
    // 保存文章时由 syncBoardTitleFromArticle() 同步到白板 meta.title。
    /**
     * 把文章标题同步成白板的 meta.title。
     * 只在白板上做：导图那边后端 meta 支不支持 title 没确认，不冒险；
     * 而且导图侧栏本来也没有第二个改名入口，不存在两处打架的问题。
     */
    async function syncBoardTitleFromArticle(type, title) {
        if (type !== 'whiteboard' || !title) return;
        if (!boardId()) return;
        try { await boardMetaSet({ title: title }); } catch (e) { /* 忽略：同步失败不回收文章保存 */ }
    }

    window.eeSaveBoardKey = async function () {
        var k = ($('eeBaKeyInput').value || '').trim();
        if (k.length < 4) { toast('口令至少 4 位', 'error'); return; }
        var ok = await boardMetaSet({ editKey: k }, '口令已设置');
        if (ok) $('eeBaKeyInput').value = '';
    };

    window.eeClearBoardKey = function () {
        boardMetaSet({ editKey: '' }, '口令已清除');
    };

    window.eeLoadBoardHistory = async function () {
        var bid = boardId();
        var sel = $('eeBaRevSel');
        if (!sel || !bid) return;
        sel.innerHTML = '<option value="">加载中…</option>';
        try {
            var d = await excApi('action=history&id=' + encodeURIComponent(bid));
            if (d.status !== 'success') { sel.innerHTML = '<option value="">读取失败</option>'; return; }
            var revs = d.revs || [];
            if (!revs.length) {
                sel.innerHTML = '<option value="">暂无历史版本</option>';
                $('eeBaRev').textContent = '当前 rev ' + (d.current || 0) + ' · 暂无快照';
                return;
            }
            sel.innerHTML = revs.map(function (r) {
                return '<option value="' + r + '">rev ' + r + (r === d.current ? '（当前）' : '') + '</option>';
            }).join('');
            $('eeBaRev').textContent = '当前 rev ' + (d.current || 0) + ' · 共 ' + revs.length + ' 个快照';
        } catch (e) {
            sel.innerHTML = '<option value="">读取失败</option>';
        }
    };

    window.eeRollbackBoard = async function () {
        var bid = boardId();
        var sel = $('eeBaRevSel');
        var rev = sel ? sel.value : '';
        if (!bid || rev === '') { toast('请先选择要回滚到的版本', 'error'); return; }
        if (!window.confirm('确定把画布回滚到 rev ' + rev + '？当前画布会被该快照覆盖，当前版本仍保留在历史中。')) return;
        var d = await excApi('action=rollback&id=' + encodeURIComponent(bid) + '&rev=' + encodeURIComponent(rev), { method: 'POST' });
        if (d.status !== 'success') { toast(d.message || '回滚失败', 'error'); return; }
        toast('已回滚到 rev ' + rev, 'success');
        mountBoard();          // 重建 iframe，载入回滚后的画布
        window.eeLoadBoardAdmin();
        notifyChanged();
    };

    window.eeSaveBoard = async function () {
        var frame = document.querySelector('#eeBoardHost iframe.ee-frame');
        var saver = null;
        try { saver = frame && frame.contentWindow && frame.contentWindow.__excalidrawSave; } catch (e) { saver = null; }
        if (typeof saver !== 'function') { toast('白板编辑器还在加载，请稍候', 'error'); return; }
        var ok = await saver();
        toast(ok ? '画板已保存' : '画板保存未完成（口令/空画布/网络？）', ok ? 'success' : 'error');
        if (ok) notifyChanged();
    };

    // ===== 渲染 =====
    function renderCover() {
        window.eeRenderCover();
    }
    // 封面：缩略图预览 + 上传 / 从图库选 / 移除（页面上不展示 URL 文本）
    window.eeRenderCover = function () {
        var url = $('eeImage').value.trim();
        // 侧栏封面卡（发布弹窗已去掉，不再有第二处封面预览要同步）
        var img = $('eeCoverImg');
        var empty = $('eeCoverEmpty');
        var clear = $('eeCoverClear');
        if (url) {
            img.src = url;
            img.style.display = 'block';
            if (empty) empty.style.display = 'none';
            if (clear) clear.style.display = '';
        } else {
            img.removeAttribute('src');
            img.style.display = 'none';
            if (empty) empty.style.display = '';
            if (clear) clear.style.display = 'none';
        }
    };
    function fileToBase64(file) {
        return new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () {
                var s = String(fr.result || '');
                var i = s.indexOf(',');
                resolve({ base64: i >= 0 ? s.slice(i + 1) : s, mime: file.type || 'image/png' });
            };
            fr.onerror = function () { reject(new Error('读取文件失败')) };
            fr.readAsDataURL(file);
        });
    }
    // 文中图片上传（编辑器粘贴/拖拽/上传按钮共用）
    async function eeUploadImage(file) {
        try {
            var d = await fileToBase64(file);
            var res = await fetch('/api/article-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
                body: JSON.stringify({ data: d.base64, mime: d.mime, name: file.name })
            });
            var r = await res.json();
            if (r.status === 'success' && r.url) return r.url;
            toast('图片上传失败：' + (r.message || '未知原因'), 'error');
        } catch (e) {
            toast('图片上传失败：' + (e.message || e), 'error');
        }
        return null;
    }
    async function eeUploadCover(file) {
        if (!file) return;
        try {
            var d = await fileToBase64(file);
            var res = await fetch('/api/article-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
                body: JSON.stringify({ data: d.base64, mime: d.mime, name: file.name })
            });
            var r = await res.json();
            if (r.status === 'success' && r.url) {
                $('eeImage').value = r.url;
                window.eeRenderCover();
                window.eeMarkDirty();
                toast('封面已上传', 'success');
            } else {
                toast(r.message || '上传失败', 'error');
            }
        } catch (e) {
            toast('上传失败：' + (e.message || e), 'error');
        }
    }
    window.eeClearCover = function () {
        $('eeImage').value = '';
        window.eeRenderCover();
        window.eeMarkDirty();
        toast('封面已移除', 'success');
    };
    window.eePickCover = async function () {
        var box = $('eePicker');
        var grid = $('eePickerGrid');
        if (!box || !grid) return;
        grid.innerHTML = '<div class="ee-picker-empty">加载中…</div>';
        box.classList.add('open');
        try {
            var r = await api('action=images&_=' + Date.now());
            var list = (r && r.status === 'success' && Array.isArray(r.data)) ? r.data : [];
            if (!list.length) {
                grid.innerHTML = '<div class="ee-picker-empty">图库暂无图片，可到「图片管理」上传</div>';
                return;
            }
            window.__eePickList = list;
            grid.innerHTML = list.map(function (img, i) {
                var thumb = img.thumb || img.url || '';
                return '<div class="ee-picker-item" onclick="eeChooseCover(' + i + ')">' +
                    '<img src="' + esc(thumb) + '" loading="lazy" alt="">' +
                    '<span>' + esc(img.key || '') + '</span></div>';
            }).join('');
        } catch (e) {
            grid.innerHTML = '<div class="ee-picker-empty">加载失败：' + esc(e.message || e) + '</div>';
        }
    };
    window.eeClosePicker = function () {
        var box = $('eePicker');
        if (box) box.classList.remove('open');
    };
    window.eeChooseCover = function (i) {
        var img = (window.__eePickList || [])[i];
        if (!img) return;
        $('eeImage').value = img.url || '';
        window.eeRenderCover();
        window.eeClosePicker();
        window.eeMarkDirty();
        toast('封面已设置', 'success');
    };
    function renderMeta() {
        if (!doc) return;
        var rows = [
            ['类型', typeLabel(docType)],
            ['ID', '<span style="font-family:ui-monospace,Menlo,monospace">' + esc(doc.id || '保存后生成') + '</span>'],
            ['文件名', esc(doc.filename || '—')],
            ['创建', esc(doc.createdAt || '—')],
            ['更新', esc(doc.updatedAt || doc.update || '—')]
        ];
        $('eeMeta').innerHTML = rows.map(function (r) {
            return '<span>' + r[0] + '：<b>' + r[1] + '</b></span>';
        }).join('');
    }
    // 顶栏那两个「文章 / 草稿」徽标已按需求删掉，状态看侧栏的「状态」下拉即可。

    // ===== 加载 =====
    async function load() {
        if (!adminKey) { location.replace('/admin.html'); return; }
        if (!docId) { toast('缺少文章 ID', 'error'); return; }
        var r = await api('action=articles&id=' + encodeURIComponent(docId) + '&_=' + Date.now());
        if (r.status !== 'success' || !r.data) {
            toast('加载失败：' + (r.message || '文章不存在'), 'error');
            return;
        }
        doc = r.data;
        // 长文章（分章存储）：按章加载编辑，避免一次把全文塞进编辑器
        if (doc && doc.chunked) {
            try {
                var toc = await api('action=article-toc&id=' + encodeURIComponent(docId) + '&_=' + Date.now());
                if (toc && toc.status === 'success' && toc.data) {
                    chunkEdit = {
                        total: toc.data.total || 0,
                        chapters: toc.data.chapters || [],
                        current: 0,
                        chunks: []
                    };
                    var c0 = await fetchChunkText(0);
                    chunkEdit.chunks[0] = c0 || '';
                    doc.content = chunkEdit.chunks[0];
                }
            } catch (e) { chunkEdit = null; }
        }
        docType = normalizeType(doc.type);
        await applyDoc();
    }

    /**
     * 新建模式：/admin-edit.html?new=1&type=article|card|whiteboard|mindmap
     * 不拉取任何记录，先在内存里造一个空壳，第一次保存时才真正落库。
     * 画布类（白板 / 导图）此时就已经确定了画布 id：画布有独立的 store，
     * 与文章记录是两条数据，id 先定下来，打开就能画、画完保存即创建。
     */
    async function initNewDoc() {
        if (!adminKey) { location.replace('/admin.html'); return; }
        docType = normalizeType(newTypeParam);
        var id = '';
        var bId = '';
        var mId = '';
        if (docType === 'whiteboard') { bId = newCanvasId('whiteboard'); id = bId; }
        else if (docType === 'mindmap') { mId = newCanvasId('mindmap'); id = mId; }
        doc = {
            id: id,                 // 空串表示「还没落库」：由服务端在首次保存时生成
            filename: '',
            title: '',
            tags: [],
            author: '',
            excerpt: '',
            image: '',
            content: '',
            status: 'draft',
            type: docType,
            boardId: bId,
            mapId: mId
        };
        // 从后台「导入 .md」跳过来：内容暂存在 sessionStorage（整篇塞 URL 会超长）
        if (params.get('import') === '1') {
            try {
                var raw = sessionStorage.getItem('ee_import');
                sessionStorage.removeItem('ee_import');
                if (raw) {
                    var imp = JSON.parse(raw) || {};
                    doc.title = imp.title || doc.title;
                    doc.excerpt = imp.excerpt || '';
                    doc.image = imp.image || '';
                    doc.tags = Array.isArray(imp.tags) ? imp.tags : [];
                    doc.content = imp.content || '';
                }
            } catch (e) { /* 解析失败就当空文档，不阻塞 */ }
        }
        await applyDoc();
        watchNewCanvasSave();
    }

    /**
     * 新建白板 / 导图时盯着画布：画布自己保存成功后，若这篇内容还没落库，就自动补一条草稿记录。
     * 画板数据（excalidraw / mindmaps 两个 store）与文章记录是两套存储，只存画板不存文章，
     * 结果就是「画了半天，文章管理页里什么都没有」。这里只在「确实画过」时建档：
     * dirty 由 true 变 false 才算保存过，单纯打开看一眼不会建记录。
     */
    function watchNewCanvasSave() {
        if (!isNew || (docType !== 'whiteboard' && docType !== 'mindmap')) return;
        var isBoard = docType === 'whiteboard';
        var sawDirty = false;
        var timer = setInterval(function () {
            if (savedOnce || !isNew) { clearInterval(timer); return; }
            var frame = document.querySelector(isBoard ? '#eeBoardHost iframe' : '#eeMindmapHost iframe');
            var dirty;
            try {
                var fn = frame && frame.contentWindow && frame.contentWindow[isBoard ? '__excalidrawDirty' : '__mindmapDirty'];
                if (typeof fn !== 'function') return;
                dirty = fn();
            } catch (e) { return; } // 还没挂载好 / 拿不到：下一轮再看
            if (dirty === true) { sawDirty = true; return; }
            if (sawDirty && dirty === false) {
                clearInterval(timer);
                autoAdoptCanvas();
            }
        }, 1500);
    }
    async function autoAdoptCanvas() {
        if (savedOnce) return;
        var t = $('eeTitle');
        if (t && !t.value.trim()) t.value = '未命名' + typeLabel(docType);
        var ok = await doSave(true);
        if (ok) {
            toast('画板已保存，已自动建好文章记录（草稿）——可在文章管理里找到，发布前记得改标题', 'success');
        }
    }

    /** 把 doc 渲染到页面上（编辑已有 / 新建 共用） */
    async function applyDoc() {
        document.title = (isNew ? '新建' : '编辑') + typeLabel(docType) + ' · ' + (doc.title || doc.id || '未命名');
        $('eeIdText').textContent = doc.id || (isNew ? '尚未保存' : '');
        $('eeTitle').value = doc.title || '';
        initTagPickers();
        if (tagPicker) tagPicker.setTags(doc.tags || [], true);
        loadTagSuggestions();
        $('eeExcerpt').value = doc.excerpt || '';
        $('eeImage').value = doc.image || '';
        $('eeStatusSel').value = doc.status || (isNew ? 'draft' : 'published');
        renderCover();
        renderMeta();
        if (docType === 'card') $('eeViewBtn').textContent = '首页查看';
        // 随记没有封面图；摘要只有文章有（白板保留封面图）
        if (docType === 'card') {
            var coverCard = $('eeCoverCard');
            if (coverCard) coverCard.style.display = 'none';
        }
        if (docType !== 'article') {
            var excerptCard = $('eeExcerptCard');
            if (excerptCard) excerptCard.style.display = 'none';
        }
        // 白板 / 导图本身就是一块画布，「本文内嵌画布」这个清单对它们没有意义
        if (docType === 'whiteboard' || docType === 'mindmap') {
            var canvasCard = $('eeCanvasCard');
            if (canvasCard) canvasCard.style.display = 'none';
        }
        if (docType === 'mindmap') $('eeViewBtn').textContent = '前台查看';
        // 新建：还没有记录可删、也还没法从前台打开
        if (isNew) {
            if ($('eeDeleteBtn')) $('eeDeleteBtn').style.display = 'none';
            if ($('eeViewBtn')) $('eeViewBtn').style.display = 'none';
            if ($('eeTitle')) $('eeTitle').placeholder = '给这' + typeLabel(docType) + '起个名字（必填）';
        }
        if (docType === 'whiteboard') {
            $('eeEditorCol').style.display = 'none'; // 白板不用富文本编辑器，画布直接占左侧编辑位
            $('eeSide').style.display = 'flex';      // 右侧功能区（状态/标签/封面/信息）始终保持
            if ($('eeMindmap')) $('eeMindmap').style.display = 'none';
            $('eeBoard').style.display = 'flex';
            mountBoard();
            window.eeLoadBoardAdmin();
        } else if (docType === 'mindmap') {
            $('eeEditorCol').style.display = 'none'; // 导图同样用整块画布区
            $('eeSide').style.display = 'flex';
            if ($('eeBoard')) $('eeBoard').style.display = 'none';
            $('eeMindmap').style.display = 'flex';
            mountMindmap();
            refreshMapKeyCard();
        } else {
            if ($('eeBoard')) $('eeBoard').style.display = 'none';
            if ($('eeMindmap')) $('eeMindmap').style.display = 'none';
            $('eeEditorCol').style.display = 'flex';
            $('eeSide').style.display = 'flex';

            if (chunkEdit) renderChapterBar();
            setEditorContent(doc.content || '');
        }
        dirty = false;
        $('eeSaved').textContent = isNew ? '尚未保存' : '已载入';
        $('eeSaved').style.color = isNew ? '#ffb020' : '#7bd88f';
    }

    // ===== 长文章按章编辑（避免一次载入全文） =====
    var chunkEdit = null; // { total, chapters, current, chunks }
    async function fetchChunkText(i) {
        try {
            var r = await api('action=article-chunk&id=' + encodeURIComponent(docId) + '&i=' + i + '&_=' + Date.now());
            if (r && r.status === 'success' && r.data) return r.data.content || '';
        } catch (e) { /* 拉取失败返回 null，由调用方兜底 */ }
        return null;
    }
    function renderChapterBar() {
        var bar = $('eeChapterBar');
        var sel = $('eeChapterSel');
        if (!bar || !sel || !chunkEdit) return;
        bar.style.display = '';
        sel.innerHTML = (chunkEdit.chapters || []).map(function (ch) {
            var k = Math.max(1, Math.round((ch.words || 0) / 1000));
            return '<option value="' + ch.i + '">' + (ch.i + 1) + '. ' + esc(ch.title || '') + '（约 ' + k + 'k 字）</option>';
        }).join('');
        sel.value = String(chunkEdit.current);
    }
    async function refreshChunkToc() {
        if (!chunkEdit) return;
        try {
            var toc = await api('action=article-toc&id=' + encodeURIComponent(docId) + '&_=' + Date.now());
            if (toc && toc.status === 'success' && toc.data) {
                chunkEdit.total = toc.data.total || chunkEdit.total;
                chunkEdit.chapters = toc.data.chapters || chunkEdit.chapters;
                // 分章结构可能变化：未在编辑的章节缓存作废，重新按需拉取
                for (var i = 0; i < chunkEdit.chunks.length; i++) {
                    if (i !== chunkEdit.current) chunkEdit.chunks[i] = null;
                }
                renderChapterBar();
            }
        } catch (e) { /* 忽略 */ }
    }
    window.eeSwitchChapter = async function (i) {
        if (!chunkEdit) return;
        i = Number(i);
        if (!Number.isInteger(i) || i === chunkEdit.current) return;
        // 切换前把当前章内容暂存内存（保存时统一提交）
        chunkEdit.chunks[chunkEdit.current] = getEditorContent();
        var text = chunkEdit.chunks[i];
        if (text == null) {
            setEditorContent('');
            text = await fetchChunkText(i);
            chunkEdit.chunks[i] = text || '';
        }
        setEditorContent(text || '');
        chunkEdit.current = i;
        $('eeChapterSel').value = String(i);
        toast('已切换到第 ' + (i + 1) + ' 章（原内容已暂存）', 'success');
    };

    // ===== 保存 =====
    async function collect() {
        var title = $('eeTitle').value.trim();
        var tags = currentTags();

        // 先取正文（分章文章需按顺序拼全文）。
        // 白板 / 导图没有富文本编辑器：这类文档的正文恒为空，
        // 千万不要为了拿正文去初始化 Vditor——既拖慢保存，也会在初始化完成前 getValue() 抛错。
        var content;
        if (docType === 'whiteboard' || docType === 'mindmap') {
            content = '';
        } else if (chunkEdit) {
            chunkEdit.chunks[chunkEdit.current] = getEditorContent();
            var parts = [];
            for (var i = 0; i < chunkEdit.total; i++) {
                var text = chunkEdit.chunks[i];
                if (text == null) {
                    text = await fetchChunkText(i);
                    chunkEdit.chunks[i] = text || '';
                }
                parts.push(text || '');
            }
            content = parts.join('\n\n');
        } else {
            content = getEditorContent();
        }

        // ===== 内容形态判定 =====
        // 规则：正文去掉块标记后为空、且只引用了一个块 → 保留独立画布形态（阅读页整页展示）；
        // 否则按 article（阅读页内联渲染）。已在 embed-picker.js 里实现，含两个例外：
        // 随记保持随记；写文章页显式选了白板/导图形态时尊重该选择。
        var finalType = docType;
        if (window.EmbedPicker && typeof window.EmbedPicker.deriveContentType === 'function') {
            try { finalType = window.EmbedPicker.deriveContentType(docType, content); } catch (e) { finalType = docType; }
        }

        // 关联 id：优先用正文里引用的块（单块）→ 独立画布形态；
        // 否则沿用原有关联（白板/导图文章照常）。mapId 不传空串——服务端在 type=mindmap 时用它覆盖，等于清掉关联。
        var boardId = (doc && doc.boardId) || '';
        var mapId = (doc && doc.mapId) || '';
        if (window.EmbedPicker && typeof window.EmbedPicker.extractBlockRefs === 'function') {
            var refs = [];
            try { refs = window.EmbedPicker.extractBlockRefs(content) || []; } catch (e) { refs = []; }
            if (finalType === 'whiteboard' && refs.length === 1 && refs[0].kind === 'board') boardId = refs[0].id;
            if (finalType === 'mindmap' && refs.length === 1 && refs[0].kind === 'map') mapId = refs[0].id;
        }

        var body = {
            id: doc ? doc.id : docId,
            title: title,
            tags: tags,
            excerpt: finalType === 'article' ? $('eeExcerpt').value.trim() : '',
            image: finalType === 'card' ? '' : $('eeImage').value.trim(),
            status: $('eeStatusSel').value,
            type: finalType,
            boardId: finalType === 'whiteboard' ? boardId : ((doc && doc.boardId) || ''),
            content: content,
            author: (doc && doc.author) || ''
        };
        if (finalType === 'mindmap' && mapId) body.mapId = mapId;
        return body;
    }
    async function doSave(silent) {
        var body = await collect();
        if (!body.title) { toast('请填写标题', 'error'); return false; }
        if (body.type !== 'whiteboard' && body.type !== 'mindmap' && !body.content) { toast('请填写正文内容', 'error'); return false; }
        // 内嵌块的真实内容在画布自己的 store（excalidraw / mindmaps），与文章正文是两套存储。
        // 若画布保存失败仍提交文章，就会出现「文章存了、画布改动丢了」——故此处必须阻断。
        var flush = { ok: true, failed: [] };
        if (window.EmbedPicker && typeof window.EmbedPicker.flushEmbeds === 'function') {
            try {
                flush = await window.EmbedPicker.flushEmbeds(vditor);
            } catch (e) { flush = { ok: true, failed: [] }; }
        }
        if (!flush.ok) {
            toast('引用的画布保存失败：' + flush.failed.join('、') +
                '。文章未提交，请处理后重试（常见原因：画布设有编辑口令未通过、网络中断）', 'error');
            return false;
        }
        var btn = $('eeSaveBtn');
        btn.disabled = true;
        var r = await api('action=articles', { method: 'POST', body: JSON.stringify(body) });
        btn.disabled = false;
        if (r.status !== 'success') { toast('保存失败：' + (r.message || ''), 'error'); return false; }
        // 首次保存：服务端生成记录 id（新建模式下 collect() 传的是空串；白板/导图则用已有的画布 id）。
        // 落库成功后这个页面就从「新建」变成「编辑已有」，地址栏同步换掉，
        // 这样刷新 / 转发链接都能直接回到这篇内容，也避免再点保存又建一篇。
        if (!doc) doc = {};
        if (r.data && r.data.id) {
            if (!doc.id) doc.createdAt = r.data.date || '';
            doc.id = r.data.id;
            doc.filename = r.data.filename || (doc.id + '.md');
        }
        if (!savedOnce) {
            savedOnce = true;
            isNew = false;
            try {
                history.replaceState(null, '', '/admin-edit.html?id=' + encodeURIComponent(doc.id));
            } catch (e) { /* 忽略：地址栏换不掉不影响功能 */ }
            $('eeIdText').textContent = doc.id || '';
            if ($('eeDeleteBtn')) $('eeDeleteBtn').style.display = '';
            if ($('eeViewBtn')) $('eeViewBtn').style.display = '';
            document.title = '编辑' + typeLabel(docType) + ' · ' + (body.title || doc.id);
        }
        if (doc && r.data) {
            doc.status = body.status;
            doc.title = body.title;
            // 后端可能追加固定标签（如随记的「随记」），以返回值为准回填
            doc.tags = Array.isArray(r.data.tags) ? r.data.tags : body.tags;
            doc.excerpt = body.excerpt;
            doc.image = body.image;
            doc.updatedAt = r.data.update || doc.updatedAt;
            if (tagPicker) tagPicker.setTags(doc.tags || [], true);
            renderMeta();
        }
        dirty = false;
        if (chunkEdit) refreshChunkToc();
        // 白板名称跟随标题：侧栏已经去掉单独的改名入口，这里顺手同步到白板 meta.title
        // （后台「白板管理」列表读的是那个）。同步失败不影响文章已保存这个事实。
        syncBoardTitleFromArticle(body.type, body.title);
        var now = new Date().toLocaleTimeString();
        $('eeSaved').textContent = '已保存 ' + now;
        $('eeSaved').style.color = '#7bd88f';
        notifyChanged();
        if (!silent) toast('已保存', 'success');
        return true;
    }
    window.eeSave = function () { doSave(false); };
    window.eeSavePreview = async function () {
        var ok = await doSave(true);
        if (!ok) return;
        toast('已保存，正在打开前台预览', 'success');
        eeOpenFront();
    };

    // ===== 状态 / 删除 / 前台 =====
    /**
     * 发布：不再弹窗。
     * 状态、标签、封面都在侧栏，弹窗只是把同样的东西再问一遍。
     * 缺东西（没标题 / 没正文 / 引用的画布没落盘）由 doSave() 用胶囊提示拦下，
     * 所以这里不需要自己再校验一遍。
     */
    window.eePublishNow = async function () {
        var sel = $('eeStatusSel');
        if (sel) sel.value = 'published';
        window.eeMarkDirty();
        var ok = await doSave(true);      // silent：成功提示统一由下面这条「已发布」给
        if (!ok) return;                  // 失败原因 doSave 已经提示过了
        toast('已发布', 'success');
    };
    window.eeToggleStatus = async function () {
        if (!doc || !doc.id) { toast('先保存一次再切换状态', 'error'); return; }
        var cur = doc.status || 'published';
        var next = cur === 'published' ? 'draft' : 'published';
        var word = next === 'published' ? '发布' : '下架';
        if (!confirm('确定' + word + '「' + (doc.title || doc.id) + '」？')) return;
        var r = await api('action=articles', { method: 'PATCH', body: JSON.stringify({ id: doc.id, status: next }) });
        if (r.status !== 'success') { toast(word + '失败：' + (r.message || ''), 'error'); return; }
        doc.status = next;
        $('eeStatusSel').value = next;
        notifyChanged();
        toast('已' + word, 'success');
    };
    window.eeDelete = async function () {
        if (!doc || !doc.id) { toast('还没保存，无需删除', 'error'); return; }
        if (!confirm('确定删除「' + (doc.title || doc.id) + '」？删除后不可恢复！')) return;
        var r = await api('action=articles&id=' + encodeURIComponent(doc.id), { method: 'DELETE' });
        if (r.status !== 'success') { toast('删除失败：' + (r.message || ''), 'error'); return; }
        dirty = false;
        notifyChanged();
        toast('已删除，正在返回后台', 'success');
        setTimeout(function () { location.href = '/admin.html'; }, 600);
    };
    window.eeOpenFront = function () {
        if (!doc || !doc.id) { toast('先保存一次再查看前台效果', 'error'); return; }
        // 随记（card）没有独立详情页，前台查看走首页（随记区在那里展示）
        if (docType === 'card') { window.open('/', '_blank'); return; }
        var name = encodeURIComponent(doc.filename || ((doc.id || docId) + '.md'));
        window.open('/article.html?post=' + name + '&blob=' + encodeURIComponent(doc.id || docId), '_blank');
    };

    // ===== 侧栏：本文内嵌画布清单 =====
    // 把正文里引用的白板 / 导图列出来（显示画布名称），点一下滚动定位到正文里那个块。
    // 名称走与「插入画布」面板同一个列表接口；结果缓存住，避免每次刷新清单都重新请求。
    var canvasNameCache = { board: null, map: null };

    function loadCanvasNames() {
        var kinds = ['board', 'map'].filter(function (k) { return canvasNameCache[k] === null; });
        if (!kinds.length) return Promise.resolve();
        return Promise.all(kinds.map(function (k) {
            var url = k === 'map' ? '/api/mindmap?action=list' : '/api/excalidraw?action=list';
            return fetch(url, { headers: { 'X-Admin-Key': adminKey }, cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    var items = (d && d.status === 'success' && (d.items || d.data)) || [];
                    var map = {};
                    items.forEach(function (it) { if (it && it.id) map[it.id] = it.title || ''; });
                    canvasNameCache[k] = map;
                })
                .catch(function () { canvasNameCache[k] = {}; });
        }));
    }

    /** 正文里引用的画布（顺序 = 在正文里出现的顺序） */
    function currentCanvasRefs() {
        // 用页面自己的 getEditorContent()（Vditor 未就绪时会回落到 pendingMd），
        // 不要写成 Vditor 实例的 getValue() —— 那个名字在这个作用域里不存在。
        var md = '';
        try { md = getEditorContent() || ''; } catch (e) { md = ''; }
        try {
            return (window.EmbedPicker && window.EmbedPicker.extractBlockRefs(md)) || [];
        } catch (e) { return []; }
    }

    /** 在正文编辑器里找到这块画布的卡片（不用属性选择器：画布 id 可能含中文等字符） */
    function findCanvasCard(id) {
        var list = document.querySelectorAll('.vditor-wysiwyg .ep-canvas-card');
        for (var i = 0; i < list.length; i++) {
            if (list[i].getAttribute('data-id') === id) return list[i];
        }
        return null;
    }

    function paintCanvasList(refs) {
        var box = $('eeCanvasList');
        if (!box) return;
        box.innerHTML = refs.map(function (r) {
            var name = (canvasNameCache[r.kind] || {})[r.id];
            return '<div class="ee-canvas-item" data-kind="' + r.kind + '" data-id="' + esc(r.id) + '">' +
                '<span class="k">' + (r.kind === 'map' ? '导图' : '白板') + '</span>' +
                '<span class="n' + (name ? '' : ' unnamed') + '">' + (name ? esc(name) : '未命名') + '</span>' +
                '</div>';
        }).join('');
        Array.prototype.forEach.call(box.querySelectorAll('.ee-canvas-item'), function (row) {
            row.addEventListener('click', function () {
                var id = this.getAttribute('data-id');
                var el = findCanvasCard(id);
                if (!el) { toast('正文里没找到这块画布，可能已被删除'); return; }
                try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { el.scrollIntoView(); }
                el.classList.remove('ee-canvas-flash');
                void el.offsetWidth;                       // 强制重排，让动画能重复播放
                el.classList.add('ee-canvas-flash');
                setTimeout(function () { el.classList.remove('ee-canvas-flash'); }, 1300);
            });
        });
    }

    function refreshCanvasList() {
        var box = $('eeCanvasList');
        if (!box) return;
        var refs = currentCanvasRefs();
        if (!refs.length) {
            box.innerHTML = '<div class="ee-hint">正文里还没有白板 / 导图。工具栏点「插入画布」加一块。</div>';
            return;
        }
        paintCanvasList(refs);                             // 先用缓存里的名字画出来，不阻塞
        if (canvasNameCache.board === null || canvasNameCache.map === null) {
            loadCanvasNames().then(function () { paintCanvasList(currentCanvasRefs()); });
        }
    }

    // ===== 启动 =====
    var booted = false;
    function boot() {
        if (booted) return;
        booted = true;
        // 侧栏折叠状态先应用（不依赖接口，避免加载慢时侧栏先闪一下再收起）
        applySideCollapsed();
        // 标题改动同样计入未保存状态
        var t = $('eeTitle');
        if (t) t.addEventListener('input', window.eeMarkDirty);
        var coverFile = $('eeCoverFile');
        if (coverFile) coverFile.addEventListener('change', function () {
            eeUploadCover(this.files && this.files[0]);
            this.value = '';
        });
        (isNew ? initNewDoc() : load()).then(function () {
            setTimeout(fitEditor, 120);
            refreshCanvasList();
        });
    }
    window.addEventListener('resize', function () { setTimeout(fitEditor, 80); });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
