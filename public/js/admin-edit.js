/**
 * 独立编辑页脚本（admin-edit.html）
 * 用途：对已发布/草稿的文章、随记、白板、导图进行再次编辑，不再占用后台「写文章」页
 *
 * ---- 版本历史（近期）----
 * v1.10.0：侧栏新增「本文内嵌画布」清单（显示画布名称，点击定位到正文块）
 * v1.10.1：顶栏重排 —— 字数/保存状态搬进顶栏、删掉类型与状态徽标、「保存并预览」挪进侧栏
 * v1.11.0：发布不再弹窗（侧栏已有状态/标签/封面，缺东西用胶囊提示）
 * v1.12.0：编辑器改造 —— 精简顶部工具栏、接入右键菜单与大纲、侧栏分组、去掉块悬停操作条
 * v1.12.1：标题从编辑区上方搬进侧栏
 * v1.13.0：白板/导图隐藏「本文内嵌画布」；白板去掉独立改名入口
 * v1.14.0：侧栏细节 —— 去掉画板 ID 行、口令改行内「添加」、信息卡片移到折叠区最后
 * v1.15.0：侧栏隐藏滚动条；「保存并预览」改成顶栏的「预览」，与发布 / 保存合成一个按钮组
 * v1.15.1：「本文内嵌画布」只给文章用
 * v1.20.0（本轮）：P0 + P1 + P2 一批改造，详见下面分组注释
 *   P0-1 分章保存安全：任一章拉取失败就中止保存（原来会把失败章当空串拼进全文，
 *        保存后服务端重新分块 = 那一章正文被永久清空）；切章也改成「拉取成功才切」
 *   P0-2 本地草稿：编辑时每 2 秒防抖暂存到 localStorage，进页面若发现比线上新就提示恢复
 *   P0-3 提交锁：doSave 期间锁住「保存 / 发布 / 预览」，避免双击发出两次 POST
 *   P0-4 章节并发拉取：缺的章节按 6 个一批并发取，失败即中止（不再串行 20 连发）
 *   P1-5 画布清单改读 DOM 卡片，打字时不再每次全文 getValue()
 *   P1-6 字数改净字数（汉字 + 英文单词，去掉 Markdown 标记），并做 250ms 防抖
 *   P1-7 原生 confirm/alert 换成自绘确认框（EE.confirm）
 *   P1-8 「预览」不再写库：发给本地 /preview.html 渲染，不再先 POST 一次
 *   P1-9 白板标题没变就不打 meta 接口（逻辑在 editor-embed-admin.js）
 *   P1-10 顶栏「?」打开快捷键说明（EE.openShortcuts）
 *   P1-11 请求层统一兜底：非 JSON 响应不再炸链、GET 失败自动重试一次（editor-kit.js）
 *   P1-12 窄屏：属性栏改右侧抽屉、顶栏次要动作收进「⋯」、工具栏横向滚动
 *   P2-16 去掉 Vditor 自带的 content-theme / code-theme，主题只留页面这一套（editor_theme）
 *   P2-17 拆分：基础设施 → editor-kit.js；白板 / 导图管理 → editor-embed-admin.js
 */
(function () {
    'use strict';

    // ===== 基础设施（editor-kit.js）=====
    var EE = window.EE;
    var api = EE.api;
    var toast = EE.toast;
    var esc = EE.esc;

    // ===== 页面状态 =====
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
    var saveInFlight = false;   // P0-3：提交锁

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
    /** 画布 id：沿用全站约定 wb- / mm- + 8 位 base36 随机段（与后端 CANVAS_ID_RE 一致） */
    function newCanvasId(t) {
        return (t === 'mindmap' ? 'mm-' : 'wb-') + Math.random().toString(36).slice(2, 10);
    }
    function isCanvasType() { return docType === 'whiteboard' || docType === 'mindmap'; }

    // ===== 标签选择器 =====
    var tagPicker = null;

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
        });
    }

    // ===== 未保存状态 / 本地草稿（P0-2）=====
    window.eeMarkDirty = function () {
        dirty = true;
        $('eeSaved').textContent = '有未保存改动';
        $('eeSaved').style.color = '#ffb020';
        scheduleDraftSave();
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

    // ---- 本地草稿 ----
    var draftKey = '';
    var draftTimer = null;
    var lastDraftHint = 0;

    function draftKeyFor() {
        return docId ? ('doc:' + docId) : ('new:' + normalizeType(newTypeParam));
    }

    /**
     * 快照的可比较签名。
     * 不直接 JSON.stringify 整个快照：分章文章的 chunks 里会有「还没加载」的 null，
     * 上次暂存时可能加载了 3 章、这次只加载了 1 章，长度不同但内容其实一致 ——
     * 直接比较会误报「有本地草稿」。
     * 这里把尾部 null 去掉再比，并且不比较当前章号（章号不同不算内容不同）。
     */
    function draftSignature(snap) {
        if (!snap) return '';
        var chapters = null;
        if (Array.isArray(snap.chapters)) {
            chapters = snap.chapters.filter(function (c) { return typeof c === 'string'; });
        }
        return JSON.stringify({
            title: snap.title || '',
            tags: snap.tags || [],
            excerpt: snap.excerpt || '',
            image: snap.image || '',
            status: snap.status || '',
            chunked: !!snap.chunked,
            canvasRefs: snap.canvasRefs || [],
            relatedIds: snap.relatedIds || [],
            terms: snap.terms || [],
            content: snap.content || '',
            chapters: chapters
        });
    }

    /** 当前页面的一份快照（本地草稿 / 恢复比对都用它） */
    function draftSnapshot() {
        var snap = {
            title: $('eeTitle').value,
            tags: currentTags(),
            excerpt: $('eeExcerpt').value,
            image: $('eeImage').value,
            status: $('eeStatusSel').value,
            chunked: !!chunkEdit,
            canvasRefs: relatedCanvases.slice(),
            relatedIds: relatedPosts.slice(),
            terms: terms.map(termForSave),
            content: isCanvasType() ? '' : getEditorContent()
        };
        if (chunkEdit) {
            snap.chapter = chunkEdit.current;
            snap.total = chunkEdit.total;
            // 只存已经拿到的章节（null 表示还没加载，恢复时保持未加载）
            snap.chapters = chunkEdit.chunks.slice();
        }
        return snap;
    }

    function scheduleDraftSave() {
        if (!EE.draft.available()) return;
        clearTimeout(draftTimer);
        // 2 秒防抖：写字时别每敲一下就序列化一遍
        draftTimer = setTimeout(saveDraftNow, 2000);
    }

    function saveDraftNow() {
        if (!dirty || !EE.draft.available()) return;
        draftKey = draftKey || draftKeyFor();
        var ok = EE.draft.save(draftKey, draftSnapshot());
        if (!ok) return;
        // 顶栏提示做成「已暂存」，与「已保存（已提交）」区分开，颜色也不同
        var now = new Date().toLocaleTimeString();
        var el = $('eeSaved');
        if (el && dirty) {
            el.textContent = '已暂存本地 ' + now;
            el.title = '改动已存到浏览器本地，未提交到服务器。Ctrl+S 保存';
            el.style.color = '#ffb020';
        }
        lastDraftHint = Date.now();
    }

    /**
     * 载入完成后调用：若本地草稿与刚载入的内容不同，就问要不要恢复。
     * 相同则静默丢弃（上一次保存后没清掉的残留）。
     */
    function maybeRestoreDraft() {
        draftKey = draftKeyFor();
        var rec = EE.draft.load(draftKey);
        if (!rec || !rec.data) return;
        var base = draftSignature(draftSnapshot());
        if (draftSignature(rec.data) === base) { EE.draft.clear(draftKey); return; }

        var when = rec.savedAt ? new Date(rec.savedAt).toLocaleString() : '上次';
        var hasContent = !!String(rec.data.content || '').length ||
            (Array.isArray(rec.data.chapters) && rec.data.chapters.some(function (c) { return !!c; }));
        if (!hasContent && !rec.data.title) { EE.draft.clear(draftKey); return; }

        EE.confirm({
            title: '恢复本地草稿',
            message: '检测到 ' + when + ' 自动暂存的本地草稿（未提交）。恢复后会覆盖当前编辑器内容；丢弃则保持服务器上的版本。',
            okText: '恢复草稿',
            cancelText: '丢弃'
        }).then(function (yes) {
            if (!yes) { EE.draft.clear(draftKey); return; }
            applyDraft(rec.data);
            dirty = true;
            $('eeSaved').textContent = '已恢复本地草稿（未提交）';
            $('eeSaved').style.color = '#ffb020';
            toast('已恢复草稿，记得 Ctrl+S 保存', 'success');
        });
    }

    function applyDraft(d) {
        if (!d) return;
        if (typeof d.title === 'string') $('eeTitle').value = d.title;
        if (d.tags && tagPicker) tagPicker.setTags(d.tags, true);
        $('eeExcerpt').value = d.excerpt || '';
        $('eeImage').value = d.image || '';
        window.eeRenderCover();
        if (d.status) $('eeStatusSel').value = d.status;
        if (d.chunked && chunkEdit) {
            // 章节结构变了就不做局部恢复，避免把内容写进错误的章
            if (d.total === chunkEdit.total && Array.isArray(d.chapters)) {
                for (var i = 0; i < chunkEdit.total; i++) {
                    if (typeof d.chapters[i] === 'string') chunkEdit.chunks[i] = d.chapters[i];
                }
                var idx = Number(d.chapter);
                if (Number.isInteger(idx) && idx >= 0 && idx < chunkEdit.total) {
                    chunkEdit.current = idx;
                    $('eeChapterSel').value = String(idx);
                    setEditorContent(chunkEdit.chunks[idx] || '');
                }
            } else {
                toast('本地草稿与当前分章结构不一致，只恢复了属性', 'error');
            }
        } else if (typeof d.content === 'string' && !isCanvasType()) {
            setEditorContent(d.content);
        }
        if (Array.isArray(d.canvasRefs)) {
            relatedCanvases = d.canvasRefs.filter(function (r) {
                return r && (r.kind === 'board' || r.kind === 'map') && r.id;
            }).map(function (r) { return { kind: r.kind, id: String(r.id) }; });
            renderRelatedPanel();
        }
        if (Array.isArray(d.relatedIds)) {
            relatedPosts = d.relatedIds.map(String);
            renderRelatedPostsPanel();
        }
        if (Array.isArray(d.terms)) {
            terms = d.terms.filter(function (t) { return t && t.word; })
                .map(termFromRecord);
            renderTermsPanel();
        }
    }

    // ===== 编辑器 =====
    function applyTheme() {
        var theme = localStorage.getItem('editor_theme') || 'sepia';
        var t = editorThemes[theme] || editorThemes.sepia;
        var el = $('eeVditor');
        if (!el) return;
        THEME_CLASSES.forEach(function (c) { el.classList.remove(c); });
        el.classList.add('vditor-theme-' + (editorThemes[theme] ? theme : 'sepia'));
        el.style.setProperty('--editor-bg', t.bg);
        el.style.setProperty('--editor-text', t.text);
        el.style.setProperty('--editor-pre-bg', t.pre);
    }
    function editorHeight() {
        var col = $('eeEditorCol');
        var h = col ? col.clientHeight : 0;
        // 标题卡在侧栏，这里只剩「分章」条会占高度（而且只在分章文章里出现），
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

    // ===== 侧栏折叠（桌面）/ 抽屉（窄屏，P1-12）=====
    var SIDE_KEY = 'ee_side_collapsed';
    function sideCollapsed() {
        try { return localStorage.getItem(SIDE_KEY) === '1'; } catch (e) { return false; }
    }
    function isNarrow() {
        return window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
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
        // 窄屏下抽屉默认收起（点顶栏「属性」打开）
        if (isNarrow() && !main.classList.contains('side-drawer-open')) {
            $('eeSide').classList.remove('open');
        }
        // 编辑区宽度变了，让编辑器重新贴合。
        // v3.44.0 起折叠是 280ms 的宽度过渡，所以要等过渡结束再贴一次，
        // 否则编辑器会在动画中途按旧宽度算高/宽，收尾时留一条缝。
        setTimeout(fitEditor, 60);
        setTimeout(fitEditor, 320);
    }

    // ===== 侧栏三个页签：属性 / 术语 / AI（v3.44.0 起，v3.45.0 加术语；同一列只有一个可见）=====
    var SIDE_MODE_KEY = 'ee_side_mode';
    var SIDE_MODES = ['props', 'terms', 'ai'];
    function sideMode() {
        try {
            var m = localStorage.getItem(SIDE_MODE_KEY);
            return SIDE_MODES.indexOf(m) >= 0 ? m : 'props';
        } catch (e) { return 'props'; }
    }
    /** 只做 DOM 同步（不抢焦点）：页签高亮 + 三个面板的显隐 + 折叠把手上的当前页签 */
    function applySideMode() {
        var mode = sideMode();
        var main = document.querySelector('.ee-main');
        if (main) main.setAttribute('data-side-mode', mode);
        var tabs = { props: $('eeTabProps'), terms: $('eeTabTerms'), ai: $('eeTabAi') };
        Object.keys(tabs).forEach(function (k) {
            var t = tabs[k];
            if (!t) return;
            t.classList.toggle('active', k === mode);
            t.setAttribute('aria-selected', k === mode ? 'true' : 'false');
            t.tabIndex = k === mode ? 0 : -1;
        });
        // 折叠后的边缘把手也分「属性 / 术语 / AI」三个入口，标一下当前停在哪个
        var handleBtns = { props: $('eeSideOpenProps'), terms: $('eeSideOpenTerms'), ai: $('eeSideOpenAi') };
        Object.keys(handleBtns).forEach(function (k) {
            var b = handleBtns[k];
            if (b) b.classList.toggle('active', k === mode);
        });
        var panels = { props: $('eeSideProps'), terms: $('eeSideTerms'), ai: $('eeSideAi') };
        Object.keys(panels).forEach(function (k) {
            var p = panels[k];
            if (p) p.hidden = k !== mode;
        });
    }
    /**
     * 切到某个页签。顺带保证「切过去就能看到」：
     * 桌面端折叠着就展开，窄屏抽屉关着就滑出 —— 否则点了像没反应。
     */
    window.eeSideMode = function (mode) {
        mode = SIDE_MODES.indexOf(mode) >= 0 ? mode : 'props';
        try { localStorage.setItem(SIDE_MODE_KEY, mode); } catch (e) { /* 隐私模式，忽略 */ }
        if (isNarrow()) {
            var side = $('eeSide');
            if (side && !side.classList.contains('open')) window.eeToggleSideDrawer();
        } else if (document.querySelector('.ee-main.side-collapsed')) {
            try { localStorage.setItem(SIDE_KEY, '0'); } catch (e) { /* 忽略 */ }
            applySideCollapsed();
        }
        applySideMode();
        if (mode === 'ai' && window.WriteAi && window.WriteAi.onShow) window.WriteAi.onShow();
        if (mode === 'terms' && window.TermEditor && window.TermEditor.onShow) window.TermEditor.onShow();
    };
    /** 顶栏「AI」按钮：一键到 AI 页签 */
    window.eeOpenAi = function () { window.eeSideMode('ai'); };
    /** 一键到术语页签（右键菜单「编辑解释」也走这里） */
    window.eeOpenTerms = function (word) {
        window.eeSideMode('terms');
        if (word && window.TermEditor && window.TermEditor.edit) window.TermEditor.edit(word);
    };
    /**
     * 折叠后右侧把手上的两个入口（属性 / AI）：展开侧栏并切到对应页签。
     * 桌面端折叠态要先取消折叠；窄屏则保证抽屉是开的。
     */
    window.eeOpenSide = function (mode) {
        window.eeSideMode(SIDE_MODES.indexOf(mode) >= 0 ? mode : 'props');
    };
    window.eeToggleSide = function () {
        var main = document.querySelector('.ee-main');
        if (!main) return;
        if (isNarrow()) { window.eeToggleSideDrawer(); return; }
        var next = !main.classList.contains('side-collapsed');
        try { localStorage.setItem(SIDE_KEY, next ? '1' : '0'); } catch (e) { /* 隐私模式等，忽略 */ }
        applySideCollapsed();
        toast(next ? '侧栏已折叠（Ctrl+. 展开）' : '侧栏已展开');
    };
    /** 窄屏：右侧抽屉的开关 */
    window.eeToggleSideDrawer = function () {
        var side = $('eeSide');
        var main = document.querySelector('.ee-main');
        if (!side) return;
        var open = !side.classList.contains('open');
        side.classList.toggle('open', open);
        if (main) main.classList.toggle('side-drawer-open', open);
        var mask = $('eeSideMask');
        if (mask) mask.classList.toggle('open', open);
        if (open) {
            // 抽屉里第一个该聚焦的东西：属性页签聚焦标题，AI 页签聚焦提问框
            setTimeout(function () {
                try {
                    if (sideMode() === 'ai') {
                        if (window.WriteAi && window.WriteAi.onShow) window.WriteAi.onShow();
                    } else {
                        $('eeTitle').focus();
                    }
                } catch (e) { /* 忽略 */ }
            }, 220);
        }
    };
    // Ctrl/Cmd + . 切换；用捕获阶段，避免被 Vditor 的快捷键吞掉
    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === '.' || e.code === 'Period')) {
            e.preventDefault();
            window.eeToggleSide();
        }
    }, true);

    // ===== 顶栏「⋯」更多菜单（窄屏把次要动作收进来）=====
    window.eeOpenShortcuts = function () { EE.openShortcuts(); };

    /**
     * 「⋯」菜单的定位。菜单挂在 <body> 上（见 initMoreMenu），所以坐标要自己算：
     * 贴住 ⋯ 按钮右缘往下 8px；下方放不下就翻到上方；左右都夹在视口内。
     */
    function placeMoreMenu() {
        var box = $('eeMoreMenu');
        var btn = $('eeMoreBtn');
        if (!box || !btn) return;
        box.style.visibility = 'hidden';
        box.classList.add('open');          // 先显示才能量到尺寸
        var br = btn.getBoundingClientRect();
        var bw = box.offsetWidth;
        var bh = box.offsetHeight;
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var gap = 8;
        var left = br.right - bw;           // 右缘对齐按钮
        if (left < 8) left = 8;
        if (left + bw > vw - 8) left = Math.max(8, vw - bw - 8);
        var top = br.bottom + gap;
        if (top + bh > vh - 8) {            // 下方不够 → 翻到按钮上方
            top = br.top - bh - gap;
            if (top < 8) top = Math.max(8, vh - bh - 8);
        }
        box.style.left = Math.round(left) + 'px';
        box.style.top = Math.round(top) + 'px';
        box.style.visibility = '';
    }

    /**
     * 把「⋯」菜单挪到 <body> 末尾。
     * 必须挪：.ee-top 有 backdrop-filter + z-index:10，自己就是层叠上下文，
     * 菜单留在里面时 z-index 再大也只能在顶栏那层里比较，会被 .ee-main(20) /
     * 编辑器正文(3000) 压住 —— 表现就是「点了 ⋯ 菜单看不见」。
     */
    function initMoreMenu() {
        var box = $('eeMoreMenu');
        if (!box || box.parentNode === document.body) return;
        document.body.appendChild(box);
    }

    window.eeToggleMore = function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        var box = $('eeMoreMenu');
        if (!box) return;
        initMoreMenu();
        if (box.classList.contains('open')) { box.classList.remove('open'); return; }
        placeMoreMenu();
    };
    document.addEventListener('click', function (e) {
        var box = $('eeMoreMenu');
        if (!box || !box.classList.contains('open')) return;
        if (!box.contains(e.target)) box.classList.remove('open');
    });
    // 位置是按按钮算的，滚动/缩放后会错位，直接收起
    window.addEventListener('scroll', function () {
        var box = $('eeMoreMenu');
        if (box) box.classList.remove('open');
    }, { passive: true, capture: true });
    window.addEventListener('resize', function () {
        var box = $('eeMoreMenu');
        if (box) box.classList.remove('open');
    });
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var box = $('eeMoreMenu');
        if (box && box.classList.contains('open')) box.classList.remove('open');
    }, true);

    // ===== 字数（P1-6：净字数 + 防抖）=====
    var infoTimer = null;
    function scheduleInfo() {
        clearTimeout(infoTimer);
        infoTimer = setTimeout(updateInfo, 250);
    }
    function updateInfo() {
        var el = $('eeInfo');
        if (!el) return;
        var raw = getEditorContent();
        var c = EE.countWords(raw);
        el.textContent = c.words.toLocaleString() + ' 字';
        el.title = '净字数：汉字 + 英文单词，不含 Markdown 标记\n源码 ' + raw.length + ' 字符';
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
            // 代码块高亮主题（v3.44.13）：Vditor 默认注入它自带的 github **浅色**主题
            // （vendor/vditor/dist/js/highlight.js/styles/github.min.css），浅色令牌压在
            // 深色代码块上几乎看不清。显式指定 github-dark 后，它会加载同目录的
            // github-dark.min.css，令牌颜色才和深色底配套。
            preview: {
                hljs: { style: 'github-dark', lineNumber: false },
            },
            placeholder: '正文内容……支持 Markdown，粘贴/拖拽图片会自动上传',
            // 顶部只留常用的：其余（删除线 / 行内代码 / 任务 / 缩进 / 分割线 /
            // 编辑模式 / 导出…）都进了右键菜单，见 /js/editor-menu.js。
            // 表格故意留在工具栏：它点开会弹「几行几列」的面板，那个面板是贴着
            // 工具栏按钮定位的，从右键菜单里调用会让面板跑到顶部去。
            // P2-16：more 里不再给 content-theme / code-theme —— 页面有一套 editor_theme
            // （顶部工具栏 + localStorage），Vditor 自带那套会把同一批 CSS 变量改回去，
            // 两套开关互相覆盖，表现为「换了主题又变回去」。
            // v1.21.0：工具栏不再有「插入画布」。白板 / 导图改成文章的**关联**（见侧栏
            // 「关联画布」面板），正文保持纯 Markdown —— 前后台都不再需要渲染内嵌块。
            toolbar: [
                'headings', 'bold', 'italic', 'link',
                '|', 'list', 'ordered-list', 'quote',
                '|', 'code', 'table', 'upload',
                '|', 'undo', 'redo',
                { name: 'more', toolbar: ['strike', 'inline-code', 'check', 'outdent', 'indent', 'line', 'edit-mode', 'export', 'help'] }
            ],
            upload: {
                accept: 'image/*',
                multiple: true,
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
            input: function () {
                scheduleInfo();
                scheduleTermDecorations();   // 术语高亮跟着内容走（防抖）
                window.eeMarkDirty();
            },
            after: function () {
                vditorReady = true;
                applyTheme();
                if (pendingMd !== null) {
                    vditor.setValue(pendingMd);
                    pendingMd = null;
                }
                updateInfo();
                fitEditor();
                stripVditorPopover();
                // 右键菜单（剪贴板 / 格式 / 插入 / 段落操作），见 /js/editor-menu.js
                if (window.EditorMenu) window.EditorMenu.attach(vditor);
                // 大纲（正文结构导航），见 /js/editor-outline.js
                if (window.EditorOutline) window.EditorOutline.attach(vditor);
                // 代码块 IDE 手感（Tab 缩进 / Shift+Tab 反缩进 / Enter 自动缩进），见 /js/code-editor.js
                if (window.CodeEditor) window.CodeEditor.attach(vditor);
                // 正文渲染完成后才扫得到文本节点：补一次术语面板刷新（出现次数 + 编辑区高亮）
                renderTermsPanel();
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
        scheduleTermDecorations();   // 整篇换了内容，术语高亮要重算
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

    // ===== 渲染 =====
    // 封面：缩略图预览 + 上传 / 从图库选 / 移除（页面上不展示 URL 文本）
    window.eeRenderCover = function () {
        var url = $('eeImage').value.trim();
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
            var r = await EE.request('/api/article-image', {
                method: 'POST',
                body: JSON.stringify({ data: d.base64, mime: d.mime, name: file.name }),
                headers: { 'Content-Type': 'application/json', 'X-Admin-Key': EE.adminKey() }
            });
            if (r.status === 'success' && r.url) return r.url;
            toast('图片上传失败：' + (r.message || '未知原因'), 'error');
        } catch (e) {
            toast('图片上传失败：' + (e.message || e), 'error');
        }
        return null;
    }
    async function eeUploadCover(file) {
        if (!file) return;
        var d, r;
        try {
            d = await fileToBase64(file);
            r = await EE.request('/api/article-image', {
                method: 'POST',
                body: JSON.stringify({ data: d.base64, mime: d.mime, name: file.name }),
                headers: { 'Content-Type': 'application/json', 'X-Admin-Key': EE.adminKey() }
            });
        } catch (e) {
            toast('上传失败：' + (e.message || e), 'error');
            return;
        }
        if (r.status === 'success' && r.url) {
            $('eeImage').value = r.url;
            window.eeRenderCover();
            window.eeMarkDirty();
            toast('封面已上传', 'success');
        } else {
            toast(r.message || '上传失败', 'error');
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

    // ===== 加载 =====
    async function load() {
        if (!EE.adminKey()) { location.replace('/admin.html'); return; }
        if (!docId) { toast('缺少文章 ID', 'error'); return; }
        var r = await api('action=articles&id=' + encodeURIComponent(docId) + '&_=' + Date.now());
        if (r.status !== 'success' || !r.data) {
            toast('加载失败：' + (r.message || '文章不存在'), 'error');
            return;
        }
        doc = r.data;
        // 长文章（分章存储）：按章加载编辑，避免一次把全文塞进编辑器
        if (doc && doc.chunked) {
            var toc = await api('action=article-toc&id=' + encodeURIComponent(docId) + '&_=' + Date.now());
            if (toc && toc.status === 'success' && toc.data) {
                chunkEdit = {
                    total: toc.data.total || 0,
                    chapters: toc.data.chapters || [],
                    current: 0,
                    chunks: []
                };
                var c0 = await fetchChunkText(0);
                if (c0 === null) {
                    chunkEdit = null;
                    toast('首章读取失败，已按普通文章载入（草稿与保存已做保护，可重试）', 'error');
                } else {
                    chunkEdit.chunks[0] = c0;
                    doc.content = c0;
                }
            }
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
        if (!EE.adminKey()) { location.replace('/admin.html'); return; }
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
        if (!isNew || !isCanvasType()) return;
        var isBoard = docType === 'whiteboard';
        var sawDirty = false;
        var timer = setInterval(function () {
            if (savedOnce || !isNew) { clearInterval(timer); return; }
            var frame = document.querySelector(isBoard ? '#eeBoardHost iframe' : '#eeMindmapHost iframe');
            var d;
            try {
                var fn = frame && frame.contentWindow && frame.contentWindow[isBoard ? '__excalidrawDirty' : '__mindmapDirty'];
                if (typeof fn !== 'function') return;
                d = fn();
            } catch (e) { return; } // 还没挂载好 / 拿不到：下一轮再看
            if (d === true) { sawDirty = true; return; }
            if (sawDirty && d === false) {
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
        // 顶栏不再显示内容 id（作者不需要看到这串字符；要复制地址栏里就有）
        $('eeTitle').value = doc.title || '';
        initTagPickers();
        if (tagPicker) tagPicker.setTags(doc.tags || [], true);
        loadTagSuggestions();
        $('eeExcerpt').value = doc.excerpt || '';
        $('eeImage').value = doc.image || '';
        $('eeStatusSel').value = doc.status || (isNew ? 'draft' : 'published');
        window.eeRenderCover();
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
        // 关联画布：从记录里读出关联列表（白板 / 导图形态与随记不显示这块面板，见 renderRelatedPanel）
        relatedCanvases = (Array.isArray(doc.canvasRefs) ? doc.canvasRefs : []).filter(function (r) {
            return r && (r.kind === 'board' || r.kind === 'map') && r.id;
        }).map(function (r) { return { kind: r.kind, id: String(r.id) }; });
        renderRelatedPanel(true);
        // 关联文章（v3.36.0）：单向列表，随记没有详情页所以不显示面板
        relatedPosts = (Array.isArray(doc.relatedIds) ? doc.relatedIds : []).map(String);
        wireRelatedPostsSearch();
        renderRelatedPostsPanel(true);
        // 本篇术语（v3.37.0）：只存记录里，面板列出词条与锚点状态
        terms = (Array.isArray(doc.terms) ? doc.terms : [])
            .filter(function (t) { return t && t.word; })
            .map(termFromRecord);
        renderTermsPanel();
        if (docType === 'mindmap') $('eeViewBtn').textContent = '前台查看';
        // 新建：还没有记录可删、也还没法从前台打开。
        // 反过来，打开一篇已存在的内容时必须把这两项显出来 —— 原来只有「新建时隐藏」、
        // 没有「已有文档时显示」，导致从列表点进一篇文章后 ⋯ 菜单里只剩「快捷键」，
        // 得先随便保存一次才能看到「前台查看 / 删除」。
        if (isNew) {
            if ($('eeDeleteBtn')) $('eeDeleteBtn').style.display = 'none';
            if ($('eeViewBtn')) $('eeViewBtn').style.display = 'none';
            // 新建时给个占位引导就够，「必填」这类说明放在 label 旁的「?」里，不摆长句
            if ($('eeTitle')) $('eeTitle').placeholder = '给这' + typeLabel(docType) + '起个名字';
        } else {
            if ($('eeDeleteBtn')) $('eeDeleteBtn').style.display = '';
            if ($('eeViewBtn')) $('eeViewBtn').style.display = '';
        }
        if (docType === 'whiteboard') {
            $('eeEditorCol').style.display = 'none'; // 白板不用富文本编辑器，画布直接占左侧编辑位
            $('eeSide').style.display = 'flex';      // 右侧功能区（状态/标签/封面/信息）始终保持
            if ($('eeMindmap')) $('eeMindmap').style.display = 'none';
            $('eeBoard').style.display = 'flex';
            window.EEEmbed.mountBoard();
            window.eeLoadBoardAdmin();
        } else if (docType === 'mindmap') {
            $('eeEditorCol').style.display = 'none'; // 导图同样用整块画布区
            $('eeSide').style.display = 'flex';
            if ($('eeBoard')) $('eeBoard').style.display = 'none';
            $('eeMindmap').style.display = 'flex';
            window.EEEmbed.mountMindmap();
            window.EEEmbed.refreshMapKeyCard();
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

    // ===== 长文章按章编辑（避免一次载入全文）=====
    var chunkEdit = null; // { total, chapters, current, chunks }

    /**
     * 取一章正文。
     * @returns {Promise<string|null>} null 明确表示「失败」，空串表示「这一章本来就是空的」
     * 这个区分是 P0 的关键：以前失败也返回 null，调用方 `text || ''` 一兜底就成了空串，
     * 保存时把空串拼进全文 → 服务端重新分块 → 那一章正文被永久清空。
     */
    async function fetchChunkText(i) {
        var r = await api('action=article-chunk&id=' + encodeURIComponent(docId) + '&i=' + i + '&_=' + Date.now());
        if (r && r.status === 'success' && r.data && typeof r.data.content === 'string') return r.data.content;
        return null;
    }

    /** 并发把缺失的章节补齐；有一章失败就整批失败（保存必须全量一致） */
    async function loadMissingChunks(list) {
        var BATCH = 6;
        var failed = [];
        for (var i = 0; i < list.length; i += BATCH) {
            var batch = list.slice(i, i + BATCH);
            var res = await Promise.all(batch.map(function (idx) {
                return fetchChunkText(idx).then(function (t) { return { idx: idx, t: t }; });
            }));
            res.forEach(function (x) {
                if (x.t === null) failed.push(x.idx + 1);
                else chunkEdit.chunks[x.idx] = x.t;
            });
            if (failed.length) break;   // 已经有失败：剩下的不用再请求
        }
        return failed;
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
        var toc = await api('action=article-toc&id=' + encodeURIComponent(docId) + '&_=' + Date.now());
        if (!toc || toc.status !== 'success' || !toc.data) return;
        chunkEdit.total = toc.data.total || chunkEdit.total;
        chunkEdit.chapters = toc.data.chapters || chunkEdit.chapters;
        // 保存后服务端会重新分章，边界可能变：未在编辑的章节缓存作废，按需重取
        for (var i = 0; i < chunkEdit.chunks.length; i++) {
            if (i !== chunkEdit.current) chunkEdit.chunks[i] = null;
        }
        renderChapterBar();
    }
    window.eeSwitchChapter = async function (i) {
        if (!chunkEdit) return;
        i = Number(i);
        if (!Number.isInteger(i) || i === chunkEdit.current) return;
        var sel = $('eeChapterSel');
        // 先把当前章收进内存（保存时统一提交）
        chunkEdit.chunks[chunkEdit.current] = getEditorContent();
        // 目标章没加载过就先取：**只有成功才切**，失败时编辑区仍是当前章，不会出现空白覆盖
        if (chunkEdit.chunks[i] == null) {
            var text = await fetchChunkText(i);
            if (text === null) {
                toast('第 ' + (i + 1) + ' 章读取失败，已取消切换（当前内容未改动）', 'error');
                if (sel) sel.value = String(chunkEdit.current);
                return;
            }
            chunkEdit.chunks[i] = text;
        }
        setEditorContent(chunkEdit.chunks[i] || '');
        chunkEdit.current = i;
        if (sel) sel.value = String(i);
        scheduleTermDecorations();
        toast('已切换到第 ' + (i + 1) + ' 章（原内容已暂存）', 'success');
    };

    // ===== 保存 =====
    /**
     * 拼出待提交的正文。
     * 分章文章：缺的章节按批并发取回，任一章失败就抛 ChunkFetchError ——
     * 调用方（doSave / 预览）必须中止，绝不提交半篇。
     */
    async function assembleContent() {
        if (isCanvasType()) return '';   // 画布类没有富文本正文：别为拿正文去初始化 Vditor
        if (!chunkEdit) return getEditorContent();

        chunkEdit.chunks[chunkEdit.current] = getEditorContent();
        var missing = [];
        for (var i = 0; i < chunkEdit.total; i++) {
            if (chunkEdit.chunks[i] == null) missing.push(i);
        }
        if (missing.length) {
            var failed = await loadMissingChunks(missing);
            if (failed.length) {
                var err = new Error('第 ' + failed.join('、') + ' 章读取失败');
                err.code = 'chunk-fetch-failed';
                err.chapters = failed;
                throw err;
            }
        }
        var parts = [];
        for (var k = 0; k < chunkEdit.total; k++) parts.push(chunkEdit.chunks[k] || '');
        return parts.join('\n\n');
    }

    async function collect() {
        var title = $('eeTitle').value.trim();
        var tags = currentTags();
        var content = await assembleContent();

        // ===== 内容形态 =====
        // v1.21.0：形态只由作者当初选的那一种决定（文章 / 随记 / 白板 / 导图），
        // 不再从正文里「推断」—— 正文已经不内嵌画布了，推断的依据没有了。
        var finalType = docType;

        // 画布关联：白板 / 导图挂在文章的 canvasRefs 上（关联面板里维护）。
        // boardId / mapId 只对「白板 / 导图形态」的内容有意义（那类内容本身就是一整块画布）。
        var boardId = (doc && doc.boardId) || '';
        var mapId = (doc && doc.mapId) || '';

        var body = {
            id: doc ? doc.id : docId,
            title: title,
            tags: tags,
            excerpt: finalType === 'article' ? $('eeExcerpt').value.trim() : '',
            image: finalType === 'card' ? '' : $('eeImage').value.trim(),
            status: $('eeStatusSel').value,
            type: finalType,
            boardId: finalType === 'whiteboard' ? boardId : '',
            content: content,
            author: (doc && doc.author) || '',
            // 显式提交关联列表：空数组表示「作者把关联都解除了」，
            // 服务端据此不再回退去正文里猜（见 admin.ts 的 normalizeCanvasRefs）。
            // 顺带把画布名字写进去：前台「相关画布」区直接用它展示，不必为每块画布多打一次接口。
            canvasRefs: finalType === 'article' ? relatedCanvases.map(function (r) {
                var name = (canvasNameCache[r.kind] || {})[r.id] || '';
                return name ? { kind: r.kind, id: r.id, name: name } : { kind: r.kind, id: r.id };
            }) : [],
            // 关联文章（v3.36.0）：单向列表，服务端会去重、去掉自己、限 12 条。
            relatedIds: relatedPosts.slice(),
            // 本篇术语（v3.37.0）：服务端会去重、限 30 条、限词长。
            terms: terms.map(termForSave)
        };
        if (finalType === 'mindmap' && mapId) body.mapId = mapId;
        return body;
    }

    /** 提交期间锁住三个动作按钮：双击「发布」不会再发两次 POST（P0-3） */
    function setBusy(on) {
        [['eeSaveBtn', '保存中…'], ['eePublishBtn', '发布中…'], ['eePreviewBtn', '']].forEach(function (pair) {
            var b = $(pair[0]);
            if (!b) return;
            b.disabled = !!on;
            if (on && pair[1]) { b.dataset.label = b.textContent; b.textContent = pair[1]; }
            else if (!on && b.dataset.label) { b.textContent = b.dataset.label; delete b.dataset.label; }
        });
        var st = $('eeStatusSel');
        if (st) st.disabled = !!on;
    }

    async function doSave(silent) {
        if (saveInFlight) { toast('正在保存，请稍候…'); return false; }
        saveInFlight = true;
        setBusy(true);
        try {
            var body;
            try {
                body = await collect();
            } catch (e) {
                if (e && e.code === 'chunk-fetch-failed') {
                    toast('已取消保存：' + e.message + '（避免用不完整的内容覆盖文章）。请检查网络后重试', 'error');
                    return false;
                }
                toast('保存失败：' + ((e && e.message) || e), 'error');
                return false;
            }

            if (!body.title) { toast('请填写标题', 'error'); return false; }
            if (body.type !== 'whiteboard' && body.type !== 'mindmap' && !body.content) { toast('请填写正文内容', 'error'); return false; }

            // 以前这里要先把正文里内嵌的画布落盘（画布与正文两套存储，画布失败就得阻断）。
            // v1.21.0 起正文不再内嵌画布，关联只是一条 id 记录，不存在「画布没存上」的情况，
            // 所以这段 flush 一并删掉了。

            var r = await api('action=articles', { method: 'POST', body: JSON.stringify(body), retry: 0 });
            if (r.status !== 'success') { toast('保存失败：' + (r.message || ''), 'error'); return false; }

            // 首次保存：服务端生成记录 id（新建模式下 collect() 传的是空串；白板/导图则用已有的画布 id）。
            // 落库成功后这个页面就从「新建」变成「编辑已有」，地址栏同步换掉，
            // 这样刷新 / 转发链接都能直接回到这篇内容，也避免再点保存又建一篇。
            var wasNew = isNew;
            if (!doc) doc = {};
            if (r.data && r.data.id) {
                if (!doc.id) doc.createdAt = r.data.date || '';
                doc.id = r.data.id;
                doc.filename = r.data.filename || (doc.id + '.md');
            }
            if (!savedOnce) {
                savedOnce = true;
                isNew = false;
                docId = doc.id || docId;
                try {
                    history.replaceState(null, '', '/admin-edit.html?id=' + encodeURIComponent(doc.id));
                } catch (e) { /* 忽略：地址栏换不掉不影响功能 */ }
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
            // 已提交成功：本地草稿没用了。新建落库后 key 从 new:* 换成 doc:*，两个都清
            if (wasNew) EE.draft.clear(draftKeyFor());
            EE.draft.clear(draftKey);
            draftKey = draftKeyFor();
            if (chunkEdit) refreshChunkToc();
            // 白板名称跟随标题（侧栏没有单独的改名入口）。标题没变则不发请求。
            window.EEEmbed.syncTitle(body.type, body.title);
            var now = new Date().toLocaleTimeString();
            $('eeSaved').textContent = '已保存 ' + now;
            $('eeSaved').style.color = '#7bd88f';
            notifyChanged();
            if (!silent) toast('已保存', 'success');
            return true;
        } finally {
            saveInFlight = false;
            setBusy(false);
        }
    }
    window.eeSave = function () { return doSave(false); };

    // ===== 预览（P1-8：不写库）=====
    var previewPayload = null;
    var previewWin = null;

    /**
     * 预览 = 把当前编辑器内容发给本地 /preview.html 渲染。
     * 以前是「先 POST 保存再打开前台」，等于点一次预览就改一次线上文章
     * （已发布的文章会把半成品直接推上线）。现在完全不碰数据库。
     */
    window.eePreview = async function () {
        if (saveInFlight) { toast('正在保存，请稍候…'); return; }
        var content;
        saveInFlight = true;
        setBusy(true);
        try {
            content = await assembleContent();
        } catch (e) {
            if (e && e.code === 'chunk-fetch-failed') toast('预览失败：' + e.message, 'error');
            else toast('预览失败：' + ((e && e.message) || e), 'error');
            return;
        } finally {
            saveInFlight = false;
            setBusy(false);
        }
        previewPayload = {
            title: $('eeTitle').value.trim() || '（无标题）',
            tags: currentTags(),
            excerpt: $('eeExcerpt').value.trim(),
            image: $('eeImage').value.trim(),
            status: $('eeStatusSel').value,
            statusText: $('eeStatusSel').value === 'draft' ? '草稿' : '已发布',
            content: content,
            canvasRefs: docType === 'article' ? relatedCanvases.slice() : [],
            words: EE.countWords(content).words,
            at: Date.now()
        };
        previewWin = window.open('/preview.html', 'ee_preview');
        if (!previewWin) {
            toast('浏览器拦截了新窗口，请允许弹窗后重试', 'error');
            previewPayload = null;
            return;
        }
        toast('已打开预览（未保存、未发布）', 'success');
    };
    // 预览页加载完会来要数据（postMessage 只认同源）
    window.addEventListener('message', function (e) {
        if (e.origin !== location.origin) return;
        if (!e.data || e.data.type !== 'ee-preview-ready') return;
        if (!previewPayload) return;
        try {
            e.source.postMessage({ type: 'ee-preview-data', payload: previewPayload }, location.origin);
        } catch (err) { /* 忽略 */ }
    });

    // ===== 状态 / 删除 / 前台 =====
    /**
     * 发布：不再弹窗。
     * 状态、标签、封面都在侧栏，弹窗只是把同样的东西再问一遍。
     * 缺东西（没标题 / 没正文 / 引用的画布没落盘）由 doSave() 用胶囊提示拦下。
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
        if (!(await EE.confirm({
            title: word + '这篇文章',
            message: '确定' + word + '「' + (doc.title || doc.id) + '」？',
            okText: word
        }))) return;
        var r = await api('action=articles', { method: 'PATCH', body: JSON.stringify({ id: doc.id, status: next }), retry: 0 });
        if (r.status !== 'success') { toast(word + '失败：' + (r.message || ''), 'error'); return; }
        doc.status = next;
        $('eeStatusSel').value = next;
        notifyChanged();
        toast('已' + word, 'success');
    };
    window.eeDelete = async function () {
        if (!doc || !doc.id) { toast('还没保存，无需删除', 'error'); return; }
        if (!(await EE.confirm({
            title: '删除内容',
            message: '确定删除「' + (doc.title || doc.id) + '」？删除后不可恢复。',
            okText: '删除', danger: true
        }))) return;
        var r = await api('action=articles&id=' + encodeURIComponent(doc.id), { method: 'DELETE', retry: 0 });
        if (r.status !== 'success') { toast('删除失败：' + (r.message || ''), 'error'); return; }
        dirty = false;
        EE.draft.clear(draftKey);
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

    // ===== 侧栏：关联画布（v1.21.0）=====
    // 白板 / 导图不再「插入正文」，改成跟文章建立**关联**：
    //   - 关联存在文章的 canvasRefs 字段（记录与索引各存一份），保存时随文章一起提交；
    //   - 后台列表卡片据此给出「直接去改这块画布」的直达链接；
    //   - 前台文章页据此在文末渲染「相关画布」区。
    // 正文因此保持纯 Markdown：编辑器不用再渲染卡片、不用再 flush 画布、也不用再从正文里猜关联。
    var relatedCanvases = [];                      // [{kind:'board'|'map', id}]
    var canvasNameCache = { board: null, map: null };

    function canvasKindLabel(kind) { return kind === 'map' ? '导图' : '白板'; }
    function hasRelated(kind, id) {
        return relatedCanvases.some(function (r) { return r.kind === kind && r.id === id; });
    }

    /** 画布名字表（侧栏要显示「这块白板叫什么」），结果缓存住，避免每次重画都请求 */
    function loadCanvasNames(force) {
        var kinds = ['board', 'map'].filter(function (k) { return force || canvasNameCache[k] === null; });
        if (!kinds.length) return Promise.resolve();
        return Promise.all(kinds.map(function (k) {
            var url = k === 'map' ? '/api/mindmap?action=list' : '/api/excalidraw?action=list';
            return EE.request(url, { headers: { 'X-Admin-Key': EE.adminKey() } })
                .then(function (d) {
                    var items = (d && d.status === 'success' && (d.items || d.data)) || [];
                    // 接口返回的不是数组（比如直接给了个对象）时按空表处理：
                    // 这里抛异常会顺着 Promise.all 冒出去，连带把整个 applyDoc 拖死
                    if (!Array.isArray(items)) items = [];
                    var map = {};
                    items.forEach(function (it) { if (it && it.id) map[it.id] = it.title || ''; });
                    canvasNameCache[k] = map;
                });
        }));
    }

    /** 两个下拉：只列还没关联的画布 */
    function fillRelatedSelects() {
        [
            ['eeRelatedBoardSel', 'board', '选择一块白板…'],
            ['eeRelatedMapSel', 'map', '选择一张导图…']
        ].forEach(function (conf) {
            var sel = $(conf[0]);
            if (!sel) return;
            var names = canvasNameCache[conf[1]] || {};
            var opts = Object.keys(names)
                .filter(function (id) { return !hasRelated(conf[1], id); })
                .map(function (id) {
                    var name = names[id] || '未命名';
                    return '<option value="' + esc(id) + '">' + esc(name) + '（' + esc(id) + '）</option>';
                });
            var prev = sel.value;
            sel.innerHTML = '<option value="">' + conf[2] + (opts.length ? '' : '（还没有可关联的）') + '</option>' + opts.join('');
            if (prev && opts.length) sel.value = prev;
        });
    }

    function paintRelatedList() {
        var box = $('eeRelatedList');
        if (!box) return;
        if (!relatedCanvases.length) {
            // v3.44.4：空态只说状态，怎么用写在 label 旁的「?」里，不在这里摆解释长句
            box.innerHTML = '<div class="ee-related-empty">还没有关联画布</div>';
            return;
        }
        box.innerHTML = relatedCanvases.map(function (r) {
            var name = (canvasNameCache[r.kind] || {})[r.id];
            return '<div class="ee-canvas-item" data-kind="' + r.kind + '" data-id="' + esc(r.id) + '">' +
                '<span class="k">' + canvasKindLabel(r.kind) + '</span>' +
                '<span class="n' + (name ? '' : ' unnamed') + '">' + (name ? esc(name) : '未命名') + '</span>' +
                '<button type="button" class="ee-canvas-unlink" data-unlink="1" title="解除关联">×</button>' +
                '</div>';
        }).join('');
        Array.prototype.forEach.call(box.querySelectorAll('.ee-canvas-item'), function (row) {
            row.addEventListener('click', function (e) {
                var kind = this.getAttribute('data-kind');
                var id = this.getAttribute('data-id');
                if (e.target && e.target.getAttribute && e.target.getAttribute('data-unlink')) {
                    e.stopPropagation();
                    unlinkCanvas(kind, id);
                    return;
                }
                // 点整行 = 去前台看 / 改这块画布（新窗口，不离开写作页）
                var url = kind === 'map'
                    ? '/mindmap.html?note=' + encodeURIComponent(id) + '&edit=1&from=admin'
                    : '/excalidraw.html?note=' + encodeURIComponent(id) + '&edit=1';
                window.open(url, '_blank');
            });
        });
    }

    function renderRelatedPanel(forceNames) {
        var card = $('eeRelatedCard');
        if (!card) return;
        // 关联只对「文章」有意义：白板 / 导图形态本身就是一整块画布，随记是短内容
        if (docType !== 'article') { card.style.display = 'none'; return; }
        card.style.display = '';
        paintRelatedList();
        loadCanvasNames(!!forceNames).then(function () {
            fillRelatedSelects();
            paintRelatedList();
        });
    }

    function linkCanvas(kind, id) {
        id = String(id || '').trim();
        if (!id) { toast('先选一张画布', 'error'); return; }
        if (hasRelated(kind, id)) { toast('已经关联过了'); return; }
        relatedCanvases.push({ kind: kind, id: id });
        window.eeMarkDirty();
        renderRelatedPanel();
        toast('已关联' + canvasKindLabel(kind), 'success');
    }

    function unlinkCanvas(kind, id) {
        relatedCanvases = relatedCanvases.filter(function (r) { return !(r.kind === kind && r.id === id); });
        window.eeMarkDirty();
        renderRelatedPanel();
        toast('已解除关联（保存后生效）', 'success');
    }

    window.eeLinkCanvas = function (kind) {
        var sel = $(kind === 'map' ? 'eeRelatedMapSel' : 'eeRelatedBoardSel');
        var v = sel ? sel.value : '';
        linkCanvas(kind, v);
        if (sel) sel.value = '';
    };

    /**
     * 旧文章清理：正文里还有 ```embed / ```excalidraw 内嵌块的，提示把它们**删掉**
     * （v3.35.0 的需求：不再往正文里插画布，历史残留一律清掉，不转成关联）。
     * 画布本体不受影响 —— 它们还在「白板管理 / 导图管理」里，要挂到本文点侧栏「关联画布」即可。
     * 选「保持原样」就不动正文（前台仍按旧方式渲染），下次打开还会问。
     */
    function offerStripLegacyEmbeds() {
        if (docType !== 'article' || isNew || !doc) return;
        var legacy = EE.parseLegacyCanvasRefs(getEditorContent());
        if (!legacy.length) return;
        var list = legacy.map(function (r) { return canvasKindLabel(r.kind) + ' ' + r.id; }).join('、');
        EE.confirm({
            title: '清理正文里的内嵌画布',
            message: '这篇的正文里还有 ' + legacy.length + ' 段内嵌画布（' + list + '）。' +
                '现在白板 / 导图不再插进正文，这些块会被**直接删掉**（不转成关联）。' +
                '画布本体还在白板 / 导图管理里，想挂到本文可以点侧栏「关联画布」重新关联。',
            okText: '删掉这些块',
            cancelText: '保持原样',
            danger: true
        }).then(function (yes) {
            if (!yes) return;
            setEditorContent(EE.stripCanvasBlocks(getEditorContent()));
            window.eeMarkDirty();
            toast('已移出正文，记得保存', 'success');
        });
    }


    // ===== 侧栏：关联文章（v3.36.0）=====
    // 文章 ↔ 文章 的关联。**单向存储**：只在自己这篇里存「我关联了谁」（relatedIds），
    // 前台展示时再按全量索引反查「谁关联了我」，合并成双向 —— 这样不会有
    // 「A 存了 B、B 没存上 A」的不一致，删文章时也不用回来清对方的引用。
    // 选择方式：一次拉回索引，搜索是纯前端过滤，不打接口。
    var relatedPosts = [];        // string[]，我关联的文章 id
    var articleIndexCache = null; // [{id,title,date,type,filename}]

    function canLinkPosts() { return docType !== 'card'; }

    /** 拉一次文章索引（列出可关联的目标）。只保留有详情页的形态 */
    function loadArticleIndex(force) {
        if (articleIndexCache && !force) return Promise.resolve(articleIndexCache);
        return api('action=articles').then(function (r) {
            var list = (r && r.status === 'success' && Array.isArray(r.data)) ? r.data : [];
            articleIndexCache = list
                .filter(function (a) {
                    var t = a.type || 'article';
                    return t === 'article' || t === 'whiteboard' || t === 'mindmap';   // 随记没有详情页
                })
                .map(function (a) {
                    return {
                        id: a.id,
                        title: a.title || '(未命名)',
                        date: a.date || '',
                        type: a.type || 'article',
                        filename: a.filename || (a.id + '.md')
                    };
                });
            return articleIndexCache;
        });
    }

    function postById(id) {
        var list = articleIndexCache || [];
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }

    function hasRelatedPost(id) { return relatedPosts.indexOf(id) >= 0; }

    function postTypeLabel(t) { return t === 'whiteboard' ? '白板' : (t === 'mindmap' ? '导图' : '文章'); }

    function paintRelatedPosts() {
        var box = $('eeRelatedPostsList');
        if (!box) return;
        if (!relatedPosts.length) {
            box.innerHTML = '<div class="ee-related-empty">还没有关联文章</div>';
        } else {
            box.innerHTML = relatedPosts.map(function (id) {
                var p = postById(id);
                var title = p ? p.title : id + '（已删除或不可见）';
                var meta = p ? (postTypeLabel(p.type) + (p.date ? ' · ' + p.date : '')) : '已失效';
                return '<div class="ee-canvas-item" data-id="' + esc(id) + '">' +
                    '<span class="k">' + (p ? esc(postTypeLabel(p.type).slice(0, 2)) : '失效') + '</span>' +
                    '<span class="n' + (p ? '' : ' unnamed') + '" title="' + esc(meta) + '">' + esc(title) + '</span>' +
                    '<button type="button" class="ee-canvas-unlink" data-unlink="1" title="解除关联">×</button>' +
                    '</div>';
            }).join('');
            Array.prototype.forEach.call(box.querySelectorAll('.ee-canvas-item'), function (row) {
                row.addEventListener('click', function (e) {
                    if (e.target && e.target.getAttribute && e.target.getAttribute('data-unlink')) {
                        e.stopPropagation();
                        unlinkPost(this.getAttribute('data-id'));
                    }
                });
            });
        }
        paintRelatedPostResults();
    }

    /** 搜索结果：按标题过滤，已关联的排除 */
    function paintRelatedPostResults() {
        var box = $('eeRelatedPostsResults');
        if (!box) return;
        var kw = (($('eeRelatedPostsSearch') || {}).value || '').trim().toLowerCase();
        var list = (articleIndexCache || []).filter(function (p) {
            if (p.id === (doc && doc.id)) return false;         // 不列自己
            if (hasRelatedPost(p.id)) return false;             // 已关联的不再列
            if (!kw) return true;
            return p.title.toLowerCase().indexOf(kw) >= 0 || p.id.toLowerCase().indexOf(kw) >= 0;
        });
        if (!articleIndexCache) {
            box.innerHTML = '<div class="ee-related-empty">正在读取文章列表…</div>';
            return;
        }
        if (!list.length) {
            box.innerHTML = '<div class="ee-related-empty">' + (kw ? '没有匹配的文章' : '没有可关联的文章了') + '</div>';
            return;
        }
        var CAP = 20;
        box.innerHTML = list.slice(0, CAP).map(function (p) {
            return '<button type="button" class="ee-rel-result" data-id="' + esc(p.id) + '">' +
                '<span class="t">' + esc(postTypeLabel(p.type)) + '</span>' +
                '<span class="n">' + esc(p.title) + '</span>' +
                '<span class="d">' + esc(p.date || '') + '</span>' +
                '<span class="plus">+</span>' +
                '</button>';
        }).join('') + (list.length > CAP ? '<div class="ee-related-empty">还有 ' + (list.length - CAP) + ' 篇，输入关键词继续搜</div>' : '');
        Array.prototype.forEach.call(box.querySelectorAll('.ee-rel-result'), function (btn) {
            btn.addEventListener('click', function () { linkPost(this.getAttribute('data-id')); });
        });
    }

    function renderRelatedPostsPanel(force) {
        var card = $('eeRelatedPostsCard');
        if (!card) return;
        if (!canLinkPosts()) { card.style.display = 'none'; return; }
        card.style.display = '';
        paintRelatedPosts();
        if (!articleIndexCache || force) {
            loadArticleIndex(force).then(function () { paintRelatedPosts(); });
        }
    }

    function linkPost(id) {
        id = String(id || '').trim();
        if (!id) return;
        if (hasRelatedPost(id)) { toast('已经关联过了'); return; }
        if (doc && id === doc.id) { toast('不能关联自己', 'error'); return; }
        relatedPosts.push(id);
        window.eeMarkDirty();
        renderRelatedPostsPanel();
        toast('已关联', 'success');
    }

    function unlinkPost(id) {
        relatedPosts = relatedPosts.filter(function (x) { return x !== id; });
        window.eeMarkDirty();
        renderRelatedPostsPanel();
        toast('已解除关联（保存后生效）', 'success');
    }

    window.eeLinkPost = function (id) { linkPost(id); };
    window.eeUnlinkPost = function (id) { unlinkPost(id); };

    // 搜索框：300ms 防抖，纯前端过滤
    var relatedPostsTimer = null;
    function wireRelatedPostsSearch() {
        var inp = $('eeRelatedPostsSearch');
        if (!inp || inp.dataset.wired) return;
        inp.dataset.wired = '1';
        inp.addEventListener('input', function () {
            clearTimeout(relatedPostsTimer);
            relatedPostsTimer = setTimeout(paintRelatedPostResults, 300);
        });
    }

    // ===== 侧栏：本篇术语（v3.37.0）=====
    // 文内术语回链：正文里某个词从**第二次出现**起自动链回它的定义处。
    //   - 标记方式：编辑器里选中文字 → 右键「标记为术语」（见 editor-menu.js）；
    //   - 定义锚点：默认 = 该词首次出现的那一段；也可以在面板里点「锚到当前段落」改锚点
    //     （存的是那一段开头若干字作为「段落指纹」，渲染时按前缀匹配定位）；
    //   - 数据随文章 POST 提交（terms），只写进记录、不进索引。
    var terms = [];   // [{word, anchor, def?, quote?}]

    var MAX_TERMS_CLIENT = 30;
    var MAX_TERM_WORD_CLIENT = 24;
    var MAX_TERM_ANCHOR_CLIENT = 48;
    var MAX_TERM_DEF_CLIENT = 300;
    var MAX_TERM_QUOTE_CLIENT = 240;

    /** 词条 → 存库形态（def / quote 为空就不写，保持老记录形状干净） */
    function termForSave(t) {
        var o = { word: t.word, anchor: t.anchor || 'first' };
        if (t.def) o.def = String(t.def).slice(0, MAX_TERM_DEF_CLIENT);
        if (t.quote) o.quote = String(t.quote).slice(0, MAX_TERM_QUOTE_CLIENT);
        return o;
    }

    /** 记录 → 内存形态（老数据只有 word/anchor，def/quote 让它们保持 undefined） */
    function termFromRecord(t) {
        var o = { word: String(t.word), anchor: String(t.anchor || 'first') };
        if (t.def) o.def = String(t.def);
        if (t.quote) o.quote = String(t.quote);
        return o;
    }

    function normalizeWord(w) {
        return String(w || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_TERM_WORD_CLIENT);
    }

    /** 当前编辑器光标所在段落的「指纹」（去空白后的前 48 字） */
    function caretBlockFingerprint() {
        try {
            var sel = window.getSelection();
            if (!sel || !sel.rangeCount) return '';
            var node = sel.getRangeAt(0).startContainer;
            var el = node && (node.nodeType === 1 ? node : node.parentElement);
            if (!el) return '';
            var block = el.closest('p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6');
            if (!block) return '';
            var text = String(block.textContent || '').replace(/\s+/g, ' ').trim();
            return text.slice(0, MAX_TERM_ANCHOR_CLIENT);
        } catch (e) { return ''; }
    }

    function termIndex(word) {
        for (var i = 0; i < terms.length; i++) if (terms[i].word === word) return i;
        return -1;
    }

    function markTerm(rawWord) {
        var word = normalizeWord(rawWord);
        if (!word) { toast('先选中要标成术语的文字', 'error'); return; }
        if (termIndex(word) >= 0) { toast('「' + word + '」已经是术语了'); return; }
        if (terms.length >= MAX_TERMS_CLIENT) { toast('术语最多 ' + MAX_TERMS_CLIENT + ' 个', 'error'); return; }
        terms.push({ word: word, anchor: 'first' });
        window.eeMarkDirty();
        renderTermsPanel();
        toast('已标记术语「' + word + '」', 'success');
    }

    function unmarkTerm(word, opts) {
        terms = terms.filter(function (t) { return t.word !== word; });
        window.eeMarkDirty();
        renderTermsPanel();
        if (!opts || !opts.silent) toast('已移除术语「' + word + '」', 'success');
    }

    /** 把某个术语的定义锚点改到「编辑器当前光标所在段落」 */
    function anchorTermToCaret(word) {
        var i = termIndex(word);
        if (i < 0) return;
        var fp = caretBlockFingerprint();
        if (!fp) { toast('先把光标放到要当定义的那一段里', 'error'); return; }
        terms[i].anchor = fp;
        window.eeMarkDirty();
        renderTermsPanel();
        toast('「' + word + '」的定义锚点已设为当前段落', 'success');
    }

    /** 把锚点改回「首次出现」 */
    function resetTermAnchor(word) {
        var i = termIndex(word);
        if (i < 0) return;
        terms[i].anchor = 'first';
        window.eeMarkDirty();
        renderTermsPanel();
        toast('「' + word + '」的锚点已改回首次出现');
    }

    // ===== 编辑区里的术语高亮（v3.39.0）=====
    // 术语是元数据，正文本身是纯文本 —— 所以作者在编辑器里看不出哪里标了。
    // 这里用 **CSS Custom Highlight API**（CSS.highlights + Range）做非侵入式高亮：
    //   · 不往正文塞 span，不动 DOM 结构，也就不会污染 Markdown 源码
    //   · 定义锚点（首次出现处）用一种颜色，其余出现用另一种
    // 浏览器不支持时静默降级（面板里仍有出现次数与「定位」按钮）。
    var TERM_HL_LINK = 'ee-term-link';
    var TERM_HL_ANCHOR = 'ee-term-anchor';
    var termDecorTimer = null;
    var termDecorBusy = false;
    var TERM_DECOR_MAX_CHARS = 300000;   // 超长正文跳过编辑期高亮（前台不受影响）

    function supportsHighlightApi() {
        return !!(window.CSS && CSS.highlights && typeof Highlight === 'function' && window.Range);
    }

    /** 扫一个容器的文本节点（跳过代码块 / 链接 / 标题等） */
    function decorTextNodes(root) {
        var out = [];
        if (!root || !document.createTreeWalker) return out;
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var n;
        while ((n = walker.nextNode())) {
            var t = n.nodeValue || '';
            if (!t.trim()) continue;
            var el = n.parentElement;
            if (!el) continue;
            // 注意：Vditor 的正文根本身就是 <pre class="vditor-reset">，
            // 这里**不能**把 pre 一概跳过（否则一个节点都扫不到，高亮永远为空）。
            // 真正的代码块在 WYSIWYG 里是 .vditor-wysiwyg__block[data-type="code-block"]，内含 <code>。
            if (el.closest('code, a, kbd, samp, svg, .vditor-ir__marker, .vditor-wysiwyg__preview, .vditor-wysiwyg__block[data-type="code-block"], .vditor-wysiwyg__pre')) continue;
            out.push(n);
        }
        return out;
    }

    function matcherOf(word) {
        var w = String(word || '');
        if (!w) return null;
        if (/^[A-Za-z0-9_\-\s]+$/.test(w)) {
            var body = w.trim().split(/\s+/).map(function (p) {
                return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }).join('\\s+');
            return new RegExp('\\b(' + body + ')\\b', 'gi');
        }
        return new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'g');
    }

    /**
     * 重算编辑区里的术语高亮。
     * @returns {{ok:boolean, reason?:string, counts?:object}}
     */
    function refreshTermDecorations() {
        var host = document.querySelector('#eeVditor .vditor-wysiwyg') ||
            document.querySelector('#eeVditor .vditor-ir');
        if (!host || !terms.length) { clearTermDecorations(); return { ok: false, reason: 'none' }; }
        if (!supportsHighlightApi()) { return { ok: false, reason: 'unsupported' }; }
        if ((getEditorContent() || '').length > TERM_DECOR_MAX_CHARS) {
            clearTermDecorations();
            return { ok: false, reason: 'toolong' };
        }

        var nodes = decorTextNodes(host);
        var anchorRanges = [];
        var linkRanges = [];
        var counts = {};

        terms.forEach(function (term) {
            var re = matcherOf(term.word);
            if (!re) return;
            var hits = [];
            for (var i = 0; i < nodes.length && hits.length < 500; i++) {
                var text = nodes[i].nodeValue || '';
                re.lastIndex = 0;
                var m;
                while ((m = re.exec(text))) {
                    hits.push({ node: nodes[i], start: m.index, end: m.index + m[0].length });
                    if (hits.length >= 500) break;
                    if (m.index === re.lastIndex) re.lastIndex++;
                }
            }
            counts[term.word] = hits.length;
            if (!hits.length) return;
            // 锚点：自定义指纹优先，否则首次出现
            var anchorIdx = 0;
            if (term.anchor && term.anchor !== 'first') {
                var fp = String(term.anchor).replace(/\s+/g, ' ').trim();
                for (var k = 0; k < hits.length; k++) {
                    var blk = hits[k].node.parentElement &&
                        hits[k].node.parentElement.closest('p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6');
                    var bt = blk ? String(blk.textContent || '').replace(/\s+/g, ' ').trim() : '';
                    if (bt.indexOf(fp) === 0) { anchorIdx = k; break; }
                }
            }
            hits.forEach(function (h, idx) {
                try {
                    var r = document.createRange();
                    r.setStart(h.node, h.start);
                    r.setEnd(h.node, h.end);
                    (idx === anchorIdx ? anchorRanges : linkRanges).push(r);
                } catch (e) { /* 节点可能刚被替换，忽略 */ }
            });
        });

        try {
            CSS.highlights.delete(TERM_HL_LINK);
            CSS.highlights.delete(TERM_HL_ANCHOR);
            if (linkRanges.length) {
                var h1 = new Highlight();
                linkRanges.forEach(function (r) { h1.add(r); });
                CSS.highlights.set(TERM_HL_LINK, h1);
            }
            if (anchorRanges.length) {
                var h2 = new Highlight();
                anchorRanges.forEach(function (r) { h2.add(r); });
                CSS.highlights.set(TERM_HL_ANCHOR, h2);
            }
        } catch (e) {
            return { ok: false, reason: 'error' };
        }
        return { ok: true, counts: counts };
    }

    function clearTermDecorations() {
        if (!(window.CSS && CSS.highlights)) return;
        try {
            CSS.highlights.delete(TERM_HL_LINK);
            CSS.highlights.delete(TERM_HL_ANCHOR);
        } catch (e) { /* 忽略 */ }
    }

    /** 输入时防抖重算（不必每敲一个字都扫） */
    function scheduleTermDecorations() {
        if (!terms.length) { clearTermDecorations(); return; }
        clearTimeout(termDecorTimer);
        termDecorTimer = setTimeout(function () {
            if (termDecorBusy) return;
            termDecorBusy = true;
            try { refreshTermDecorations(); } finally { termDecorBusy = false; }
        }, 450);
    }

    /** 把某个词的出现位置滚到视野里并闪一下（面板「定位」用） */
    function locateTerm(word) {
        var host = document.querySelector('#eeVditor .vditor-wysiwyg') ||
            document.querySelector('#eeVditor .vditor-ir');
        if (!host) return false;
        var re = matcherOf(word);
        if (!re) return false;
        var nodes = decorTextNodes(host);
        for (var i = 0; i < nodes.length; i++) {
            re.lastIndex = 0;
            if (!re.test(nodes[i].nodeValue || '')) continue;
            var el = nodes[i].parentElement;
            var block = el && el.closest('p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6');
            var target = block || el;
            if (!target) continue;
            try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            catch (e) { target.scrollIntoView(); }
            target.classList.remove('ee-term-flash');
            void target.offsetWidth;
            target.classList.add('ee-term-flash');
            setTimeout(function () { target.classList.remove('ee-term-flash'); }, 1400);
            return true;
        }
        toast('正文里没找到「' + word + '」', 'error');
        return false;
    }

    /**
     * 术语面板的「总刷新」：重算编辑区高亮 / 出现次数，并让 term-editor.js 重画列表。
     * v3.45.0 起面板 UI 全在 term-editor.js 里（搜索、列表、单条编辑），这里只负责数据与高亮。
     */
    function renderTermsPanel() {
        if (docType === 'card') { clearTermDecorations(); if (window.TermEditor) window.TermEditor.refresh(); return; }
        if (!terms.length) {
            clearTermDecorations();
            if (window.TermEditor) window.TermEditor.refresh();
            return;
        }
        var decor = refreshTermDecorations();
        if (window.TermEditor) window.TermEditor.refresh(decor);
    }

    /** 词在正文里出现了几次（面板的「n 处」和快捷搜索都用它） */
    function countTermInContent(word) {
        var host = document.querySelector('#eeVditor .vditor-wysiwyg') ||
            document.querySelector('#eeVditor .vditor-ir');
        if (!host) return 0;
        var re = matcherOf(word);
        if (!re) return 0;
        var nodes = decorTextNodes(host);
        var n = 0;
        for (var i = 0; i < nodes.length; i++) {
            re.lastIndex = 0;
            var text = nodes[i].nodeValue || '';
            var m;
            while ((m = re.exec(text))) {
                n++;
                if (m.index === re.lastIndex) re.lastIndex++;
                if (n > 500) return n;
            }
        }
        return n;
    }

    /** 编辑器里当前选中的文字（「用正文选中的语句当解释」用） */
    function editorSelectionText() {
        try {
            var sel = window.getSelection();
            if (!sel || !sel.rangeCount || sel.isCollapsed) return '';
            var host = $('eeVditor');
            var node = sel.getRangeAt(0).startContainer;
            var el = node && (node.nodeType === 1 ? node : node.parentElement);
            if (!host || !el || !host.contains(el)) return '';
            return String(sel).replace(/\s+/g, ' ').trim().slice(0, MAX_TERM_QUOTE_CLIENT);
        } catch (e) { return ''; }
    }

    /** 保存某个词的解释（自写文本 + 正文语句），不改正文、只改元数据 */
    function setTermDefinition(word, patch) {
        var i = termIndex(word);
        if (i < 0) return false;
        var def = String((patch && patch.def) || '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_TERM_DEF_CLIENT);
        var quote = String((patch && patch.quote) || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM_QUOTE_CLIENT);
        if (def) terms[i].def = def; else delete terms[i].def;
        if (quote) terms[i].quote = quote; else delete terms[i].quote;
        window.eeMarkDirty();
        renderTermsPanel();
        toast(def || quote ? '「' + word + '」的解释已保存' : '「' + word + '」已清空解释', 'success');
        return true;
    }

    // 右键菜单（editor-menu.js）通过这个入口回调
    window.EETerms = {
        mark: function (word) {
            markTerm(word);
            // 标完立刻高亮 + 滚到锚点，省得还要自己找
            setTimeout(function () { refreshTermDecorations(); locateTerm(normalizeWord(word)); }, 80);
        },
        /** 选中的词是不是已标记的术语（右键菜单据此决定「取消术语标记」是否可点） */
        has: function (word) {
            return termIndex(normalizeWord(word)) >= 0;
        },
        /** 取消术语标记（与面板里的 × 等价，只是入口更近；silent 时不弹提示，给合并取消用） */
        unmark: function (word, opts) {
            var w = normalizeWord(word);
            if (termIndex(w) < 0) { toast('「' + w + '」不是术语', 'error'); return; }
            unmarkTerm(w, opts);
        },
        /** 打开术语页签并进入这条术语的编辑（右键菜单「编辑解释」用） */
        edit: function (word) {
            var w = normalizeWord(word);
            if (termIndex(w) < 0) { toast('「' + w + '」还不是术语', 'error'); return; }
            window.eeOpenTerms(w);
        },
        /** 当前某词的解释文本（
         *  自写解释 > 正文语句 > 空），外部只读用 */
        definition: function (word) {
            var i = termIndex(normalizeWord(word));
            if (i < 0) return '';
            var t = terms[i];
            return t.def || t.quote || '';
        }
    };

    // ===== 插入链接：站内文章 / 本文标题（v3.38.0）=====
    // 正文里的链接是纯 Markdown（`[文字](地址)`），难点只有两个：
    //   1) 站内文章的地址要带 filename + id，手打记不住；
    //   2) 页内锚点要知道标题 slug，而 slug 是渲染时按标题文字算的。
    // 所以这里做一个「选一下就好」的面板：列表可搜索，选中后自动写出 Markdown。
    // 与「关联文章」共用同一份文章索引缓存（articleIndexCache），不额外请求。
    var linkPickerMode = null;   // 'article' | 'heading'
    var linkPickerText = '';     // 选中文字（有就当作链接文字，否则用目标标题）
    var linkPickerItems = [];
    var savedCaretRange = null;  // 打开面板前编辑器里的选区（插入前要还原）

    /** 收集当前正文里的标题（按渲染顺序算 slug，保证与前台锚点一致） */
    function collectHeadings() {
        var md = getEditorContent() || '';
        var lines = md.split('\n');
        var used = {};
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var m = lines[i].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
            if (!m) continue;
            var text = m[2].replace(/[`*_~\[\]()#>!]/g, '').trim();
            if (!text) continue;
            var slug = (window.MarkdownConfig && window.MarkdownConfig.slugify)
                ? window.MarkdownConfig.slugify(text)
                : text.toLowerCase().replace(/\s+/g, '-');
            var n = (used[slug] || 0) + 1;
            used[slug] = n;
            var id = n === 1 ? slug : slug + '-' + n;
            out.push({ level: m[1].length, text: text, id: id });
        }
        return out;
    }

    function paintLinkPicker() {
        var box = $('eeLinkPickerList');
        if (!box) return;
        var kw = (($('eeLinkPickerSearch') || {}).value || '').trim().toLowerCase();
        var items = linkPickerItems.filter(function (it) {
            if (!kw) return true;
            return (it.text || '').toLowerCase().indexOf(kw) >= 0 ||
                (it.sub || '').toLowerCase().indexOf(kw) >= 0;
        });
        if (!items.length) {
            box.innerHTML = '<div class="ee-related-empty">' + (linkPickerItems.length ? '没有匹配项' : '没有可选内容') + '</div>';
            return;
        }
        box.innerHTML = items.slice(0, 60).map(function (it, i) {
            return '<button type="button" class="ee-rel-result" data-i="' + i + '">' +
                '<span class="t">' + esc(it.tag || '') + '</span>' +
                '<span class="n">' + esc(it.text) + '</span>' +
                '<span class="d">' + esc(it.sub || '') + '</span>' +
                '<span class="plus">↗</span>' +
                '</button>';
        }).join('');
        var list = items.slice(0, 60);
        Array.prototype.forEach.call(box.querySelectorAll('.ee-rel-result'), function (btn) {
            btn.addEventListener('click', function () {
                var it = list[Number(this.getAttribute('data-i'))];
                if (it) applyLinkPicker(it);
            });
        });
    }

    /** 选中后把 Markdown 链接插到光标处 */
    function applyLinkPicker(item) {
        if (!item) return;
        var text = (linkPickerText || '').trim() || item.text;
        // 链接文字里的方括号会破坏语法，转义掉
        text = text.replace(/[[\]]/g, '');
        var md = '[' + text + '](' + item.url + ')';
        try {
            // 还原打开面板前的选区：不还原的话 insertValue 会把链接插到文档开头
            if (savedCaretRange) {
                var host = $('eeVditor');
                var okRange = host && document.contains(savedCaretRange.startContainer);
                if (okRange) {
                    host.querySelector('.vditor-wysiwyg, .vditor-ir').focus();
                    var sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(savedCaretRange);
                }
            }
            if (vditor && typeof vditor.insertValue === 'function') vditor.insertValue(md);
            else toast('编辑器还没就绪，请稍后重试', 'error');
        } catch (e) {
            toast('插入失败：' + ((e && e.message) || e), 'error');
        }
        savedCaretRange = null;
        window.eeMarkDirty();
        closeLinkPicker();
        toast('已插入链接：' + item.text, 'success');
    }

    function closeLinkPicker() {
        var box = $('eeLinkPicker');
        if (box) box.classList.remove('open');
        linkPickerMode = null;
    }
    window.eeCloseLinkPicker = closeLinkPicker;

    window.eeOpenLinkPicker = function (mode, selectedText) {
        linkPickerMode = mode === 'heading' ? 'heading' : 'article';
        linkPickerText = String(selectedText || '');
        var box = $('eeLinkPicker');
        if (!box) { toast('链接面板未加载，请刷新重试', 'error'); return; }
        // 关键：面板一打开焦点就给了搜索框，编辑器里的选区会丢，
        // vditor.insertValue 会把链接插到文档开头（还会把第一行标题并进段落）。
        // 所以先把当前选区存下来，插入前再还原。
        savedCaretRange = null;
        try {
            var sel = window.getSelection();
            if (sel && sel.rangeCount) {
                var r = sel.getRangeAt(0);
                var host = $('eeVditor');
                if (host && host.contains(r.startContainer)) savedCaretRange = r.cloneRange();
            }
        } catch (e) { savedCaretRange = null; }
        $('eeLinkPickerTitle').textContent = linkPickerMode === 'heading' ? '链接到本文标题' : '插入站内链接';
        $('eeLinkPickerSearch').value = '';
        $('eeLinkPickerSearch').placeholder = linkPickerMode === 'heading' ? '搜索标题…' : '搜索文章标题或 id…';
        $('eeLinkPickerThumb').textContent = linkPickerText ? ('链接文字：' + linkPickerText) : '未选中文字时用目标标题作为链接文字';
        box.classList.add('open');
        $('eeLinkPickerList').innerHTML = '<div class="ee-related-empty">加载中…</div>';

        if (linkPickerMode === 'heading') {
            linkPickerItems = collectHeadings().map(function (h) {
                return {
                    text: h.text,
                    sub: 'H' + h.level,
                    tag: '#' + h.level,
                    url: '#' + h.id
                };
            });
            paintLinkPicker();
            setTimeout(function () { try { $('eeLinkPickerSearch').focus(); } catch (e) { } }, 60);
            return;
        }

        loadArticleIndex(false).then(function (list) {
            linkPickerItems = (list || [])
                .filter(function (p) { return !doc || p.id !== doc.id; })   // 不链自己
                .map(function (p) {
                    return {
                        text: p.title,
                        sub: p.date || '',
                        tag: postTypeLabel(p.type).slice(0, 2),
                        url: '/article.html?post=' + encodeURIComponent(p.filename) + '&blob=' + encodeURIComponent(p.id)
                    };
                });
            paintLinkPicker();
            setTimeout(function () { try { $('eeLinkPickerSearch').focus(); } catch (e) { } }, 60);
        });
    };

    // 搜索框：输入即过滤（纯前端）
    function wireLinkPickerSearch() {
        var inp = $('eeLinkPickerSearch');
        if (!inp || inp.dataset.wired) return;
        inp.dataset.wired = '1';
        inp.addEventListener('input', paintLinkPicker);
        var mask = $('eeLinkPickerMask');
        if (mask) mask.addEventListener('click', closeLinkPicker);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && $('eeLinkPicker') && $('eeLinkPicker').classList.contains('open')) closeLinkPicker();
        }, true);
    }

    // ===== 划词悬浮按钮组（v3.43.0）=====
    // 在编辑器里选中一段文字，选区上方浮出一排快捷按钮，直接对上顶部工具栏里最
    // 常用的那批：加粗 / 斜体 / 删除线 / 行内代码 | H1 H2 H3 | 无序列表 / 有序列表 /
    // 引用 / 代码块 | 插入链接 / 标记术语（已是术语则显示「取消标记」）。
    // 点按钮不会丢选区（按钮的 mousedown 已 preventDefault，见 selection-toolbar.js）。
    function toolbarBtn(name) {
        var btn = document.querySelector('#eeVditor .vditor-toolbar [data-type="' + name + '"]');
        if (btn) { btn.click(); return true; }
        return false;
    }

    // 标题不是「点一下就是开关」：点 headings 会先展开一个层级面板，得再点面板里的
    // button[data-tag="h2"] 才真正应用。面板是异步插进 DOM 的，所以轮询几十毫秒
    // （实测 1~2 轮就拿到，最多等 ~1.2s 就放弃，避免留下一个张着的面板）。
    // 注意「more」那个面板也是 .vditor-hint，必须按可见性筛掉。
    // 排查用：控制台执行 window.__eeDebug = true 后可看 window.__ehLog。
    function ehLog(entry) {
        if (!window.__eeDebug) return;
        (window.__ehLog = window.__ehLog || []).push(entry);
    }

    function findHintBtn(tag) {
        var hints = document.querySelectorAll('#eeVditor .vditor-hint');
        var seen = [];
        for (var i = 0; i < hints.length; i++) {
            var st = window.getComputedStyle(hints[i]);
            var shown = st.display !== 'none' && st.visibility !== 'hidden';
            var btn = hints[i].querySelector('button[data-tag="' + tag + '"]');
            seen.push((shown ? 'visible' : 'hidden') + ':' + hints[i].querySelectorAll('button[data-tag]').length);
            if (shown && btn) return btn;
        }
        ehLog({ phase: 'find', tag: tag, total: hints.length, seen: seen.join(' ') });
        return null;
    }

    function applyHeading(level) {
        ehLog({ phase: 'start', level: level });
        if (!toolbarBtn('headings')) return false;
        var tries = 0;
        (function attempt() {
            var btn = findHintBtn('h' + level);
            if (btn) { ehLog({ phase: 'hit', level: level, tries: tries }); btn.click(); return; }
            if (++tries < 30) setTimeout(attempt, 40);
            else ehLog({ phase: 'giveup', level: level });
        })();
        return true;
    }

    function buildSelectionActions(selText) {
        var text = String(selText || '').trim();
        var actions = [
            { id: 'bold', label: 'B', title: '加粗', strong: true, run: function () { toolbarBtn('bold'); } },
            { id: 'italic', label: 'I', title: '斜体', strong: true, run: function () { toolbarBtn('italic'); } },
            { id: 'strike', label: 'S', title: '删除线', strong: true, run: function () { toolbarBtn('strike'); } },
            { id: 'inlineCode', label: '&lt;/&gt;', title: '行内代码', strong: true, run: function () { toolbarBtn('inline-code'); } },
            { sep: true },
            { id: 'h1', label: 'H1', title: '一级标题', run: function () { applyHeading(1); } },
            { id: 'h2', label: 'H2', title: '二级标题', run: function () { applyHeading(2); } },
            { id: 'h3', label: 'H3', title: '三级标题', run: function () { applyHeading(3); } },
            { sep: true },
            { id: 'list', label: '•', title: '无序列表', run: function () { toolbarBtn('list'); } },
            { id: 'orderedList', label: '1.', title: '有序列表', run: function () { toolbarBtn('ordered-list'); } },
            { id: 'quote', label: '❝', title: '引用', run: function () { toolbarBtn('quote'); } },
            { id: 'codeBlock', label: '{ }', title: '代码块', run: function () { toolbarBtn('code'); } },
            { sep: true },
            {
                id: 'link', label: '🔗', title: '插入站点内 / 本文标题的链接',
                run: function () { if (window.eeOpenLinkPicker) window.eeOpenLinkPicker('article', text); }
            }
        ];
        if (!text) return actions;
        var isTerm = !!(window.EETerms && typeof window.EETerms.has === 'function' && window.EETerms.has(text));
        if (!isTerm) {
            actions.push({
                id: 'term', label: '术语', title: '把「' + text + '」标记为术语',
                run: function () { if (window.EETerms) window.EETerms.mark(text); }
            });
        } else {
            actions.push({
                id: 'cancel', label: '取消标记', title: '取消「' + text + '」的链接与术语标记', danger: true,
                run: function () { if (window.eeCancelLinkAndTerm) window.eeCancelLinkAndTerm(text); }
            });
        }
        return actions;
    }

    function initSelectionToolbar() {
        if (!window.SelectionToolbar) return;
        window.SelectionToolbar.attach({
            host: $('eeVditor'),
            selectors: '.vditor-wysiwyg, .vditor-ir',
            resolve: function (selText) { return buildSelectionActions(selText); }
        });
    }

    // ===== 启动 =====
    var booted = false;
    function boot() {
        if (booted) return;
        booted = true;
        // 侧栏折叠状态先应用（不依赖接口，避免加载慢时侧栏先闪一下再收起）
        applySideCollapsed();
        // 画布/导图管理模块：注入上下文（它不自己读全局状态）
        if (window.EEEmbed) {
            window.EEEmbed.init({
                getDoc: function () { return doc; },
                getDocType: function () { return docType; },
                toast: toast,
                notify: notifyChanged,
                setType: function (t) {
                    docType = normalizeType(t);
                    if (window.EEEmbed) window.EEEmbed.refreshMapKeyCard();
                }
            });
        }
        // 标题改动同样计入未保存状态
        var t = $('eeTitle');
        if (t) t.addEventListener('input', window.eeMarkDirty);
        var excerpt = $('eeExcerpt');
        if (excerpt) excerpt.addEventListener('input', window.eeMarkDirty);
        var coverFile = $('eeCoverFile');
        if (coverFile) coverFile.addEventListener('change', function () {
            eeUploadCover(this.files && this.files[0]);
            this.value = '';
        });
        var statusSel = $('eeStatusSel');
        if (statusSel) statusSel.addEventListener('change', window.eeMarkDirty);
        // 窄屏：抽屉遮罩点一下收起
        var mask = $('eeSideMask');
        if (mask) mask.addEventListener('click', window.eeToggleSideDrawer);

        // 侧栏页签（属性 / AI）：先把持久化的模式应用上，再初始化 AI 面板。
        // AI 面板只在页签切过去时才渲染内容，这里初始化是为了切页签不再有延迟。
        applySideMode();
        // 术语面板（v3.45.0）：数据仍在这里，界面交给 term-editor.js
        if (window.TermEditor) {
            window.TermEditor.init({
                host: $('eeSideTerms'),
                getTerms: function () { return terms; },
                markTerm: function (w) { window.EETerms.mark(w); },
                removeTerm: function (w) { unmarkTerm(w); },
                setTerm: setTermDefinition,
                findInContent: countTermInContent,
                locate: locateTerm,
                selectionText: editorSelectionText,
                anchorToCaret: anchorTermToCaret,
                resetAnchor: resetTermAnchor,
                toast: toast
            });
        }
        if (window.WriteAi) window.WriteAi.init({ host: $('eeSideAi') });
        // 顶栏「⋯」菜单搬到 <body>：脱离顶栏的层叠上下文，才能压过编辑器
        initMoreMenu();

        // 「?」打开快捷键说明（输入框里不抢键）
        document.addEventListener('keydown', function (e) {
            if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
            var tag = (e.target && e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
            e.preventDefault();
            EE.openShortcuts();
        });

        (isNew ? initNewDoc() : load()).then(function () {
            setTimeout(fitEditor, 120);
            // 关联面板（画布 / 文章 / 术语）；旧文章正文里若还有内嵌块，问一次要不要转成关联
            renderRelatedPanel(true);
            wireRelatedPostsSearch();
            renderRelatedPostsPanel(true);
            renderTermsPanel();
            wireLinkPickerSearch();
            initSelectionToolbar();
            offerStripLegacyEmbeds();
            maybeRestoreDraft();
        });
    }
    window.addEventListener('resize', function () {
        setTimeout(function () { fitEditor(); applySideCollapsed(); }, 80);
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
