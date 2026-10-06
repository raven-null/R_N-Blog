/**
 * 插入画布面板（白板 / 思维导图）—— 后台写文章页与文章编辑页共用
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

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = [
            '#embedPickerModal{position:fixed;inset:0;z-index:2600;display:none}',
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
            '.ep-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2700;',
            '  max-width:min(560px,92vw);padding:10px 16px;border-radius:10px;font-size:13px;line-height:1.7;',
            '  background:rgba(20,20,28,.96);color:#fff;border:1px solid rgba(255,255,255,.16);',
            '  box-shadow:0 18px 50px -12px rgba(0,0,0,.8)}'
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
            '<button type="button" class="ep-new" id="epNew">＋ 新建并插入</button>' +
            '<button type="button" class="ep-close" id="epClose">关闭</button>' +
            '</div>' +
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

    function toast(msg, ms) {
        var t = document.createElement('div');
        t.className = 'ep-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, ms || 3200);
    }

    function insert(vd, k, id) {
        if (!id) return;
        var block = '```embed ' + k + ':' + id + '\n```\n';
        if (vd && typeof vd.insertValue === 'function') {
            try { vd.insertValue(block); } catch (e) { /* 忽略 */ }
        }
        if (typeof window.eeMarkDirty === 'function') window.eeMarkDirty();
        close();
        toast('已插入' + (k === 'map' ? '思维导图' : '白板') + '，保存后在文章里显示');
    }

    function onCreate() {
        var k = kind;
        var isMap = k === 'map';
        var newId = (isMap ? 'mm-' : 'wb-') + Math.random().toString(36).slice(2, 10);
        var label = isMap ? '思维导图' : '白板';
        insert(activeVditor, k, newId);
        toast('已插入新' + label + '引用（' + newId + '）。请切到「' + label +
            '」形态绘制并保存——只插入引用而不绘制，前台会显示为空' + label + '。', 6500);
    }

    function open(vd) {
        injectStyle();
        buildModal();
        activeVditor = vd || activeVditor;
        var wrap = document.getElementById(MODAL_ID);
        if (!wrap) return;
        wrap.classList.add('open');
        switchTab('board');
    }

    function close() {
        var wrap = document.getElementById(MODAL_ID);
        if (wrap) wrap.classList.remove('open');
    }

    /** 给工具栏按钮补图标并绑定点击（Vditor 对未知按钮名不渲染图标） */
    function bindToolbar(vd) {
        var btn = null;
        try {
            btn = document.querySelector('[data-type="eeEmbedPick"]') ||
                (vd && vd.toolbar && vd.toolbar.elements && vd.toolbar.elements.eeEmbedPick);
        } catch (e) { /* 忽略 */ }
        if (!btn || btn.dataset.epBound) return;
        btn.dataset.epBound = '1';
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="3" y="3" width="18" height="18" rx="2"></rect>' +
            '<path d="M8 12h8M12 8v8"></path></svg>';
        btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            open(activeVditor || vd);
        });
    }

    window.EmbedPicker = {
        open: open,
        close: close,
        insert: insert,
        bindToolbar: bindToolbar,
        setVditor: function (vd) { activeVditor = vd; }
    };
})();
