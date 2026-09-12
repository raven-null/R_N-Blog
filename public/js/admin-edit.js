/**
 * 独立编辑页脚本（admin-edit.html）
 * 用途：对已发布/草稿的文章、随记、白板进行再次编辑，不再占用后台「写文章」页
 */
(function () {
    'use strict';

    var EXC_BUNDLE_VERSION = 'v11'; // 与 scripts/build-excalidraw.mjs 的 BUNDLE_VERSION 保持一致
    var adminKey = localStorage.getItem('admin_key') || '';
    var params = new URLSearchParams(location.search);
    var docId = params.get('id') || '';
    var doc = null;          // 当前文章数据
    var docType = 'article'; // article | card | whiteboard
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
        return t === 'whiteboard' ? '白板' : (t === 'card' ? '随记' : '文章');
    }

    // ===== 未保存提示 =====
    window.eeMarkDirty = function () {
        dirty = true;
        $('eeSaved').textContent = '有未保存改动';
        $('eeSaved').style.color = '#ffb020';
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
        h = h - 76; // 标题卡 + 底栏 + 间距
        return Math.max(360, h);
    }
    function fitEditor() {
        var el = $('eeVditor');
        if (!el || el.classList.contains('vditor--fullscreen')) return;
        el.style.height = editorHeight() + 'px';
    }
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
            toolbar: [
                'emoji', 'headings', 'bold', 'italic', 'strike', 'link',
                '|', 'list', 'ordered-list', 'check', 'outdent', 'indent',
                '|', 'quote', 'line', 'code', 'inline-code', 'table',
                '|', 'upload', 'edit-mode',
                '|', 'undo', 'redo', 'more'
            ],
            upload: {
                url: '/api/article-image',
                fieldName: 'file',
                max: 10 * 1024 * 1024,
                accept: 'image/*',
                format: function (files, responseText) {
                    var resp = JSON.parse(responseText);
                    if (resp.status === 'success' && resp.data) {
                        return JSON.stringify({ msg: '', code: 0, data: { src: [resp.data.url], alt: [files[0] ? files[0].name : '图片'] } });
                    }
                    return JSON.stringify({ msg: '上传失败', code: 1, data: { src: [] } });
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
            }
        });
        return vditor;
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
        return ed ? ed.getValue() : '';
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
            host.innerHTML = '<div class="ee-hint">这篇文章还没有绑定画板，无法内嵌编辑；可到「白板管理」新建画板后发布文章。</div>';
            return;
        }
        $('eeBoardOpen').href = '/excalidraw.html?note=' + encodeURIComponent(bid) + '&edit=1';
        host.innerHTML = '<div style="height:100%" data-excalidraw data-note="' + esc(bid) + '" data-mode="edit"></div>';
        loadExcBundle();
    }
    window.eeSaveBoard = async function () {
        var saver = window.__excalidrawSave;
        if (!saver) { toast('画板尚未初始化完成', 'error'); return; }
        var ok = await saver();
        toast(ok ? '画板已保存' : '画板保存未完成（口令/空画布/网络？）', ok ? 'success' : 'error');
        if (ok) notifyChanged();
    };

    // ===== 渲染 =====
    function renderCover() {
        var url = $('eeImage').value.trim();
        var box = $('eeCover');
        if (url) {
            box.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
            box.textContent = '';
        } else {
            box.style.backgroundImage = '';
            box.textContent = '无封面';
        }
    }
    function renderMeta() {
        if (!doc) return;
        var rows = [
            ['类型', typeLabel(docType)],
            ['ID', '<span style="font-family:ui-monospace,Menlo,monospace">' + esc(doc.id || '') + '</span>'],
            ['文件名', esc(doc.filename || '')],
            ['创建', esc(doc.createdAt || '')],
            ['更新', esc(doc.updatedAt || doc.update || '')]
        ];
        $('eeMeta').innerHTML = rows.map(function (r) {
            return '<span>' + r[0] + '：<b>' + r[1] + '</b></span>';
        }).join('');
    }
    function renderStatusBadge() {
        var st = doc ? (doc.status || 'published') : 'published';
        var badge = $('eeStatusBadge');
        badge.textContent = st === 'published' ? '已发布' : '草稿';
        badge.className = 'ee-badge ' + (st === 'published' ? 'status-pub' : 'status-draft');
        $('eeToggleBtn').textContent = st === 'published' ? '下架' : '发布';
    }

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
        docType = doc.type === 'whiteboard' ? 'whiteboard' : (doc.type === 'card' ? 'card' : 'article');
        document.title = '编辑' + typeLabel(docType) + ' · ' + (doc.title || doc.id);
        $('eeTypeBadge').textContent = typeLabel(docType);
        $('eeIdText').textContent = doc.id || '';
        $('eeTitle').value = doc.title || '';
        $('eeTags').value = (doc.tags || []).join(', ');
        $('eeExcerpt').value = doc.excerpt || '';
        $('eeImage').value = doc.image || '';
        $('eeStatusSel').value = doc.status || 'published';
        renderCover();
        renderMeta();
        renderStatusBadge();
        if (docType === 'card') $('eeViewBtn').textContent = '首页查看';
        // 随记与白板没有封面图：隐藏封面卡片（保存时也不写 image，清掉存量随机封面）
        if (docType !== 'article') {
            var coverCard = $('eeCoverCard');
            if (coverCard) coverCard.style.display = 'none';
            var excerptCard = $('eeExcerptCard');
            if (excerptCard) excerptCard.style.display = 'none';
        }
        if (docType === 'whiteboard') {
            $('eeEditorCol').style.display = 'none';
            $('eeSide').style.display = 'none';
            $('eeBoard').style.display = 'flex';
            mountBoard();
        } else {
            $('eeBoard').style.display = 'none';
            $('eeEditorCol').style.display = 'flex';
            $('eeSide').style.display = 'flex';
            setEditorContent(doc.content || '');
        }
        dirty = false;
        $('eeSaved').textContent = '已载入';
        $('eeSaved').style.color = '#7bd88f';
    }

    // ===== 保存 =====
    function collect() {
        var title = $('eeTitle').value.trim();
        var tags = $('eeTags').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
        var body = {
            id: doc ? doc.id : docId,
            title: title,
            tags: tags,
            excerpt: docType === 'article' ? $('eeExcerpt').value.trim() : '',
            image: docType === 'article' ? $('eeImage').value.trim() : '',
            status: $('eeStatusSel').value,
            type: docType,
            boardId: (doc && doc.boardId) || '',
            author: (doc && doc.author) || ''
        };
        // 白板文章的正文不是编辑器内容：原样回传，避免保存元信息时清空
        if (docType !== 'whiteboard') body.content = getEditorContent();
        else body.content = (doc && doc.content) || '';
        return body;
    }
    async function doSave(silent) {
        var body = collect();
        if (!body.title) { toast('请填写标题', 'error'); return false; }
        if (docType !== 'whiteboard' && !body.content) { toast('请填写正文内容', 'error'); return false; }
        var btn = $('eeSaveBtn');
        btn.disabled = true;
        var r = await api('action=articles', { method: 'POST', body: JSON.stringify(body) });
        btn.disabled = false;
        if (r.status !== 'success') { toast('保存失败：' + (r.message || ''), 'error'); return false; }
        if (doc && r.data) {
            doc.status = body.status;
            doc.title = body.title;
            // 后端可能追加固定标签（如随记的「随记」），以返回值为准回填
            doc.tags = Array.isArray(r.data.tags) ? r.data.tags : body.tags;
            doc.excerpt = body.excerpt;
            doc.image = body.image;
            doc.updatedAt = r.data.update || doc.updatedAt;
            $('eeTags').value = (doc.tags || []).join(', ');
            renderMeta();
        }
        dirty = false;
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
    window.eeToggleStatus = async function () {
        if (!doc) return;
        var cur = doc.status || 'published';
        var next = cur === 'published' ? 'draft' : 'published';
        var word = next === 'published' ? '发布' : '下架';
        if (!confirm('确定' + word + '「' + (doc.title || doc.id) + '」？')) return;
        var r = await api('action=articles', { method: 'PATCH', body: JSON.stringify({ id: doc.id, status: next }) });
        if (r.status !== 'success') { toast(word + '失败：' + (r.message || ''), 'error'); return; }
        doc.status = next;
        $('eeStatusSel').value = next;
        renderStatusBadge();
        notifyChanged();
        toast('已' + word, 'success');
    };
    window.eeDelete = async function () {
        if (!doc) return;
        if (!confirm('确定删除「' + (doc.title || doc.id) + '」？删除后不可恢复！')) return;
        var r = await api('action=articles&id=' + encodeURIComponent(doc.id), { method: 'DELETE' });
        if (r.status !== 'success') { toast('删除失败：' + (r.message || ''), 'error'); return; }
        dirty = false;
        notifyChanged();
        toast('已删除，正在返回后台', 'success');
        setTimeout(function () { location.href = '/admin.html'; }, 600);
    };
    window.eeOpenFront = function () {
        if (!doc) return;
        // 随记（card）没有独立详情页，前台查看走首页（随记区在那里展示）
        if (docType === 'card') { window.open('/', '_blank'); return; }
        var name = encodeURIComponent(doc.filename || ((doc.id || docId) + '.md'));
        window.open('/article.html?post=' + name + '&blob=' + encodeURIComponent(doc.id || docId), '_blank');
    };

    // ===== 启动 =====
    var booted = false;
    function boot() {
        if (booted) return;
        booted = true;
        // 标题改动同样计入未保存状态
        var t = $('eeTitle');
        if (t) t.addEventListener('input', window.eeMarkDirty);
        load().then(function () { setTimeout(fitEditor, 120); });
    }
    window.addEventListener('resize', function () { setTimeout(fitEditor, 80); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
