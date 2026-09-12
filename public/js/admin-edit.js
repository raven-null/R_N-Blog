/**
 * 独立编辑页脚本（admin-edit.html）
 * 用途：对已发布/草稿的文章、随记、白板进行再次编辑，不再占用后台「写文章」页
 */
(function () {
    'use strict';

    var EXC_BUNDLE_VERSION = 'v13'; // 与 scripts/build-excalidraw.mjs 的 BUNDLE_VERSION 保持一致
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
                '|', 'undo', 'redo',
                { name: 'more', toolbar: ['code-theme', 'content-theme', 'export', 'help'] }
            ],
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
        // iframe 内嵌独立白板页：与编辑页样式/布局隔离，避免相互干扰
        host.innerHTML = '<iframe class="ee-frame" title="白板编辑器" src="/excalidraw.html?note=' + encodeURIComponent(bid) + '&edit=1"></iframe>';
    }
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
        // 右栏封面卡与发布弹窗内的封面预览同步
        var img = $('eeCoverImg');
        var empty = $('eeCoverEmpty');
        var clear = $('eeCoverClear');
        var pImg = $('eePubCoverImg');
        var pEmpty = $('eePubCoverEmpty');
        if (pImg) { if (url) { pImg.src = url; pImg.style.display = 'block'; } else { pImg.removeAttribute('src'); pImg.style.display = 'none'; } }
        if (pEmpty) pEmpty.style.display = url ? 'none' : '';
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
        // 顶部按钮固定为「发布」（下拉里选草稿即为下架），不再随状态改文案
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
        // 长文章主记录不存全文（分章存储）：编辑时取回拼好的全文
        if (doc && doc.chunked && !doc.content) {
            try {
                var full = await api('action=article-full&id=' + encodeURIComponent(docId) + '&_=' + Date.now());
                if (full && full.status === 'success' && full.data) doc = Object.assign({}, doc, full.data);
            } catch (e) { /* 取全文失败时按空内容处理 */ }
        }
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
        // 随记没有封面图；摘要只有文章有（白板保留封面图）
        if (docType === 'card') {
            var coverCard = $('eeCoverCard');
            if (coverCard) coverCard.style.display = 'none';
        }
        if (docType !== 'article') {
            var excerptCard = $('eeExcerptCard');
            if (excerptCard) excerptCard.style.display = 'none';
        }
        if (docType === 'whiteboard') {
            $('eeEditorCol').style.display = 'none'; // 白板不用富文本编辑器，画布直接占左侧编辑位
            $('eeSide').style.display = 'flex';      // 右侧功能区（状态/标签/封面/信息）始终保持
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
            image: docType === 'card' ? '' : $('eeImage').value.trim(),
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
    // 发布弹窗：状态 / 标签 / 封面，确认后保存
    window.eeOpenPublish = function () {
        var s = $('eePubStatus'), t = $('eePubTags');
        if (s) s.value = ($('eeStatusSel').value || 'published');
        if (t) t.value = ($('eeTags').value || '');
        window.eeRenderCover();
        var tip = $('eePubTip'); if (tip) tip.textContent = '';
        var box = $('eePublishModal'); if (box) box.classList.add('open');
    };
    window.eeClosePublish = function () {
        var box = $('eePublishModal'); if (box) box.classList.remove('open');
    };
    window.eeConfirmPublish = async function () {
        var tip = $('eePubTip');
        if (tip) tip.textContent = '';
        var status = ($('eePubStatus') && $('eePubStatus').value) || 'published';
        $('eeStatusSel').value = status;
        if ($('eePubTags')) $('eeTags').value = $('eePubTags').value;
        window.eeMarkDirty();
        var ok = await doSave(true);
        if (!ok) { if (tip) tip.textContent = '保存失败，请检查标题与内容后重试'; return; }
        window.eeClosePublish();
        renderStatusBadge();
        toast(status === 'draft' ? '已存为草稿（下架）' : '已发布', 'success');
    };
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
        var coverFile = $('eeCoverFile');
        if (coverFile) coverFile.addEventListener('change', function () {
            eeUploadCover(this.files && this.files[0]);
            this.value = '';
        });
        var pubCoverFile = $('eePubCoverFile');
        if (pubCoverFile) pubCoverFile.addEventListener('change', function () {
            eeUploadCover(this.files && this.files[0]);
            this.value = '';
        });
        load().then(function () { setTimeout(fitEditor, 120); });
    }
    window.addEventListener('resize', function () { setTimeout(fitEditor, 80); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
