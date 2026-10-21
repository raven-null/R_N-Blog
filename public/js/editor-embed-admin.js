/**
 * 写作页 · 画布与导图管理（从 admin-edit.js 拆出）
 * ------------------------------------------------------------------
 * v1.0.0
 *   含两块原本挤在主文件里的领域逻辑：
 *   1) 白板：内嵌 iframe 挂载、访问权限、编辑口令、历史版本回滚、标题同步
 *   2) 思维导图：内嵌挂载、绑定已有 / 新建、编辑口令
 *
 *   拆出来的原因：admin-edit.js 原来是「编辑器 + 保存 + 白板 + 导图 + 清单」
 *   五套职责堆在一个 IIFE 里（1280 行），改保存容易碰到画布，改画布容易碰到保存。
 *   这两块共用 doc/boardId/mapId 和提示，所以用 init(ctx) 注入上下文，不各自读全局。
 *
 * 对外（全部挂到 window.EEEmbed）：
 *   init(ctx)             ctx = {getDoc, getDocType, toast, notify, setType}
 *   mountBoard()          按 doc.boardId 挂 iframe（没绑定就给提示）
 *   mountMindmap()        按 doc.mapId 挂 iframe；没绑定就露出「绑定导图」条
 *   syncTitle(type,title)  把文章标题同步成白板 meta.title（标题没变不发请求）
 *   saveBoard() / saveMindmap()  让 iframe 里的画布落盘（保存文章前用）
 *
 * 以及页面 onclick 直接调用的：eeLoadBoardAdmin / eeSetBoardEditable /
 * eeSaveBoardKey / eeClearBoardKey / eeLoadBoardHistory / eeRollbackBoard /
 * eeSaveBoard / eeSaveMapKey / eeClearMapKey / eeSaveMindmap
 */
(function () {
    'use strict';

    var E = {};
    var ctx = null;
    var lastSyncedBoardTitle = null;   // 上次同步到白板 meta 的标题，用于「没变就别发请求」

    function $(id) { return document.getElementById(id); }
    function toast(m, t) { (ctx && ctx.toast ? ctx.toast : window.EE.toast)(m, t); }
    function doc() { return ctx && ctx.getDoc ? ctx.getDoc() : null; }
    function docType() { return ctx && ctx.getDocType ? ctx.getDocType() : 'article'; }
    function boardId() { var d = doc(); return (d && d.boardId) || ''; }
    function mapId() { var d = doc(); return (d && d.mapId) || ''; }

    function adminHeaders() {
        return { 'Content-Type': 'application/json', 'X-Admin-Key': window.EE.adminKey() };
    }

    // ===== 接口（失败不抛：统一由调用方看 status）=====
    function excApi(query, opts) {
        opts = opts || {};
        return window.EE.request('/api/excalidraw?' + query, {
            method: opts.method, body: opts.body, headers: adminHeaders(), retry: opts.retry
        });
    }
    function mmApi(query, opts) {
        opts = opts || {};
        return window.EE.request('/api/mindmap?' + query, {
            method: opts.method, body: opts.body, headers: adminHeaders(), retry: opts.retry
        });
    }

    // ===== 白板：挂载 =====
    E.mountBoard = function () {
        var host = $('eeBoardHost');
        if (!host) return;
        var bid = boardId();
        if (!bid) {
            host.innerHTML = '<div class="ee-hint">这篇文章还没有绑定画板，无法内嵌编辑；可在此页下方新建画板，或在写文章页切到「白板」形态新建。</div>';
            return;
        }
        // iframe 内嵌独立白板页：与编辑页样式/布局隔离，避免相互干扰
        host.innerHTML = '<iframe class="ee-frame" title="白板编辑器" src="/excalidraw.html?note=' +
            encodeURIComponent(bid) + '&edit=1"></iframe>';
    };

    // ===== 导图：挂载 =====
    E.mountMindmap = function () {
        var host = $('eeMindmapHost');
        if (!host) return;
        var mid = mapId();
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
        // from=admin 让导图页收起自己的胶囊，由这里顶栏的按钮统一控制
        host.innerHTML = '<iframe class="ee-frame" title="导图编辑器" src="/mindmap.html?note=' +
            encodeURIComponent(mid) + '&edit=1&from=admin"></iframe>';
    };

    // ===== 文章 → 导图 绑定 =====
    function fillMindmapPicker() {
        var sel = $('eeMindmapPick');
        if (!sel || sel.dataset.loaded === '1') return Promise.resolve();
        return mmApi('action=list', { retry: 1 }).then(function (d) {
            if (!d || d.status !== 'success') return;
            var items = d.items || [];
            sel.innerHTML = '<option value="">— 选择一张已有导图 —</option>' +
                items.map(function (it) {
                    return '<option value="' + window.EE.esc(it.id) + '">' +
                        window.EE.esc(it.title || '未命名导图') +
                        '（' + window.EE.esc(it.id) + (it.hasKey ? '·有口令' : '') + '）</option>';
                }).join('');
            sel.dataset.loaded = '1';
        });
    }

    /** 把 doc.mapId 换成新值，并刷新导图区 */
    function bindMindmap(newId) {
        var d = doc();
        if (!d) return;
        d.mapId = newId;
        if (newId && d.type !== 'mindmap') {
            d.type = 'mindmap';
            if (ctx && ctx.setType) ctx.setType('mindmap');
        }
        E.mountMindmap();
    }

    function wireMindmapBind() {
        var sel = $('eeMindmapPick');
        var btn = $('eeMindmapBind');
        var nw = $('eeMindmapNew');
        if (btn && !btn.dataset.wired) {
            btn.dataset.wired = '1';
            btn.addEventListener('click', function () {
                var v = sel ? sel.value : '';
                if (!v) { toast('先选一张导图', 'error'); return; }
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

    // ===== 白板管理：权限 / 口令 / 历史 =====
    function markEditableButtons(state) {
        var on = $('eeBaEditOn'), off = $('eeBaEditOff');
        if (on) on.classList.toggle('active', state === 1);
        if (off) off.classList.toggle('active', state === 0);
    }

    async function boardMetaSet(body, okMsg) {
        var bid = boardId();
        if (!bid) { toast('该文章还没有绑定画板', 'error'); return false; }
        var d = await excApi('action=meta&id=' + encodeURIComponent(bid), {
            method: 'POST', body: JSON.stringify(body)
        });
        if (!d || d.status !== 'success') { toast((d && d.message) || '操作失败', 'error'); return false; }
        if (okMsg) toast(okMsg, 'success');
        window.eeLoadBoardAdmin();
        if (ctx && ctx.notify) ctx.notify();
        return true;
    }

    window.eeLoadBoardAdmin = async function () {
        var card = $('eeBoardAdminCard');
        if (!card) return;
        var bid = boardId();
        if (docType() !== 'whiteboard' || !bid) { card.style.display = 'none'; return; }
        card.style.display = '';
        var d = await excApi('id=' + encodeURIComponent(bid) + '&metaOnly=1', { retry: 1 });
        if (d && d.status === 'success' && d.meta) {
            $('eeBaEditable').textContent = d.meta.editable === 1 ? '公开可编辑' : '只读';
            $('eeBaKey').textContent = d.meta.hasKey ? '已设置' : '未设置';
            markEditableButtons(d.meta.editable === 1 ? 1 : 0);
            // 只有设过口令才给「清除」按钮 —— 没设过时它点了也没意义
            var clr = $('eeBaKeyClear');
            if (clr) clr.style.display = d.meta.hasKey ? '' : 'none';
        } else {
            // 接口不可用（部署中 / 连接被关闭）时降级显示，不抛未捕获异常
            $('eeBaEditable').textContent = d && d.httpStatus === 404 ? '画板不存在' : '读取失败';
            $('eeBaKey').textContent = '—';
            var clr2 = $('eeBaKeyClear');
            if (clr2) clr2.style.display = 'none';
            markEditableButtons(-1);
        }
        window.eeLoadBoardHistory();
    };

    window.eeSetBoardEditable = function (v) {
        boardMetaSet({ editable: v }, v === 1 ? '已开放编辑' : '已设为只读');
    };

    window.eeSaveBoardKey = async function () {
        var k = ($('eeBaKeyInput').value || '').trim();
        if (k.length < 4) { toast('口令至少 4 位', 'error'); return; }
        var ok = await boardMetaSet({ editKey: k }, '口令已设置');
        if (ok) $('eeBaKeyInput').value = '';
    };

    window.eeClearBoardKey = async function () {
        if (!(await window.EE.confirm({
            title: '清除白板口令',
            message: '清除后任何人拿到链接都能编辑这块白板。',
            okText: '清除', danger: true
        }))) return;
        boardMetaSet({ editKey: '' }, '口令已清除');
    };

    window.eeLoadBoardHistory = async function () {
        var bid = boardId();
        var sel = $('eeBaRevSel');
        if (!sel || !bid) return;
        sel.innerHTML = '<option value="">加载中…</option>';
        var d = await excApi('action=history&id=' + encodeURIComponent(bid), { retry: 1 });
        if (!d || d.status !== 'success') { sel.innerHTML = '<option value="">读取失败</option>'; return; }
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
    };

    window.eeRollbackBoard = async function () {
        var bid = boardId();
        var sel = $('eeBaRevSel');
        var rev = sel ? sel.value : '';
        if (!bid || rev === '') { toast('请先选择要回滚到的版本', 'error'); return; }
        if (!(await window.EE.confirm({
            title: '回滚画布',
            message: '把画布回滚到 rev ' + rev + '？当前画布会被该快照覆盖（当前版本仍保留在历史中）。',
            okText: '回滚', danger: true
        }))) return;
        var d = await excApi('action=rollback&id=' + encodeURIComponent(bid) + '&rev=' + encodeURIComponent(rev), { method: 'POST' });
        if (!d || d.status !== 'success') { toast((d && d.message) || '回滚失败', 'error'); return; }
        toast('已回滚到 rev ' + rev, 'success');
        E.mountBoard();          // 重建 iframe，载入回滚后的画布
        window.eeLoadBoardAdmin();
        if (ctx && ctx.notify) ctx.notify();
    };

    window.eeSaveBoard = async function () {
        var ok = await E.saveBoard();
        toast(ok ? '画板已保存' : '画板保存未完成（口令/空画布/网络？）', ok ? 'success' : 'error');
    };

    /** 让 iframe 里的白板落盘；没有保存函数（还没挂载好）时视为成功 */
    E.saveBoard = function () {
        var frame = document.querySelector('#eeBoardHost iframe.ee-frame');
        var saver = null;
        try { saver = frame && frame.contentWindow && frame.contentWindow.__excalidrawSave; } catch (e) { saver = null; }
        if (typeof saver !== 'function') return Promise.resolve(true);
        return Promise.resolve(saver()).then(function (ok) { return !!ok; }, function () { return false; });
    };

    /** 让 iframe 里的导图落盘；没有未落盘改动就不发保存（避免每次产生新版本） */
    E.saveMindmap = function () {
        var frame = document.querySelector('#eeMindmapHost iframe.ee-frame');
        var saver = null, dirtyFn = null;
        try {
            saver = frame && frame.contentWindow && frame.contentWindow.__mindmapSave;
            dirtyFn = frame && frame.contentWindow && frame.contentWindow.__mindmapDirty;
        } catch (e) { saver = null; dirtyFn = null; }
        if (typeof saver !== 'function') return Promise.resolve(true);
        try {
            if (typeof dirtyFn === 'function' && !dirtyFn()) return Promise.resolve(true);
        } catch (e) { /* 忽略 */ }
        return Promise.resolve(saver()).then(function (ok) { return !!ok; }, function () { return false; });
    };
    window.eeSaveMindmap = function () { return E.saveMindmap(); };

    /**
     * 把文章标题同步成白板的 meta.title（后台「白板管理」列表读的是那个）。
     * 标题没变就不发请求：原来每次保存白板文章都打一次 meta 接口。
     * 只在白板上做：导图侧栏没有第二个改名入口，不存在两处打架。
     */
    E.syncTitle = function (type, title) {
        if (type !== 'whiteboard' || !title) return Promise.resolve(false);
        if (!boardId()) return Promise.resolve(false);
        if (lastSyncedBoardTitle === title) return Promise.resolve(false);
        lastSyncedBoardTitle = title;
        return boardMetaSet({ title: title }).then(function (ok) {
            if (!ok) lastSyncedBoardTitle = null;   // 失败就允许下次再试
            return ok;
        });
    };

    // ===== 导图口令 =====
    E.refreshMapKeyCard = async function () {
        var card = $('eeMapKeyCard');
        if (!card) return;
        var mid = mapId();
        if (docType() !== 'mindmap' || !mid) { card.style.display = 'none'; return; }
        card.style.display = '';
        var d = await mmApi('id=' + encodeURIComponent(mid) + '&metaOnly=1', { retry: 1 });
        var hasKey = !!(d && d.status === 'success' && d.meta && d.meta.hasKey);
        $('eeMapKey').textContent = (d && d.status === 'success') ? (hasKey ? '已设置' : '未设置') : '读取失败';
        var clr = $('eeMapKeyClear');
        if (clr) clr.style.display = hasKey ? '' : 'none';
    };

    async function mapMetaSet(body, okMsg) {
        var mid = mapId();
        if (!mid) { toast('导图还没保存，先保存一次', 'error'); return false; }
        var d = await mmApi('action=meta&id=' + encodeURIComponent(mid), {
            method: 'POST', body: JSON.stringify(body)
        });
        if (!d || d.status !== 'success') { toast((d && d.message) || '操作失败', 'error'); return false; }
        if (okMsg) toast(okMsg, 'success');
        E.refreshMapKeyCard();
        if (ctx && ctx.notify) ctx.notify();
        return true;
    }

    window.eeSaveMapKey = async function () {
        var k = ($('eeMapKeyInput').value || '').trim();
        if (k.length < 4) { toast('口令至少 4 位', 'error'); return; }
        if (await mapMetaSet({ editKey: k }, '导图口令已设置')) $('eeMapKeyInput').value = '';
    };

    window.eeClearMapKey = async function () {
        if (!(await window.EE.confirm({
            title: '清除导图口令',
            message: '清除后任何人都能编辑这张导图。',
            okText: '清除', danger: true
        }))) return;
        mapMetaSet({ editKey: '' }, '导图口令已清除');
    };

    // ===== 对外 =====
    E.init = function (c) {
        ctx = c || {};
        wireMindmapBind();
    };
    E.fillMindmapPicker = fillMindmapPicker;
    E.bindMindmap = bindMindmap;

    window.EEEmbed = E;
})();
