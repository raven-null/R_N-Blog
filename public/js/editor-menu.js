/**
 * 编辑器右键菜单增强（v1.0.0）
 *
 * 为什么要有它：顶部工具栏塞不下所有功能，塞满了又占地方、又难找。
 * 这里把「不常用但确实要用」的那批收进右键菜单，顶部只留常用的。
 *
 * 覆盖三类：
 *   1. 剪贴板：剪切 / 复制 / 粘贴 / 全选
 *      —— 右键被我们自己接管后，浏览器自带的菜单就没了，所以这几项必须自己补，
 *         否则你右键想粘一段文字时会发现没有粘贴项（这是接管右键最大的坑）。
 *         粘贴走 navigator.clipboard.readText()：浏览器不允许 JS 直接读剪贴板，
 *         只能读纯文本，失败时提示用 Ctrl+V，不影响原有习惯。
 *   2. 格式：加粗 / 斜体 / 删除线 / 行内代码 / 链接
 *      —— 直接触发 Vditor 工具栏里对应的按钮（click() 对隐藏元素同样有效），
 *         这样行为与点工具栏完全一致，不用重写一遍格式化逻辑。
 *   3. 插入：白板·导图 / 图片
 *   4. 块操作：上移 / 下移 / 复制 / 删除当前段落
 *      —— 原来在 Vditor 的「块悬停操作条」里（鼠标移到段落旁左侧冒出的小条），
 *         那个条已按需求去掉，能力搬到这里，顺带补了复制。
 *
 * 关键细节：右键点在哪，操作就该作用在哪。浏览器右键默认**不会**移动光标，
 * 所以显示菜单前先用 caretRangeFromPoint 把光标挪到点击处，否则会出现
 * 「我在第三段右键，结果加粗加到了第一段」。
 */
(function () {
    'use strict';

    var MENU_ID = 'eeCtxMenu';
    var STYLE_ID = 'ee-ctxmenu-style';

    function $(id) { return document.getElementById(id); }

    function injectStyle() {
        if ($(STYLE_ID)) return;
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = [
            '#' + MENU_ID + '{position:fixed;z-index:2147483000;display:none;min-width:208px;',
            '  padding:6px;border-radius:12px;background:rgba(24,25,34,.97);',
            '  border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 48px -14px rgba(0,0,0,.85);',
            '  backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);',
            '  font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif;font-size:13px}',
            '#' + MENU_ID + '.open{display:block}',
            '#' + MENU_ID + ' .m-item{display:flex;align-items:center;gap:10px;width:100%;',
            '  padding:7px 10px;border-radius:8px;cursor:pointer;border:0;background:transparent;',
            '  color:#dfe3f5;font-family:inherit;font-size:13px;text-align:left}',
            '#' + MENU_ID + ' .m-item:hover{background:rgba(115,170,255,.20);color:#fff}',
            '#' + MENU_ID + ' .m-item[disabled]{opacity:.38;cursor:default}',
            '#' + MENU_ID + ' .m-item[disabled]:hover{background:transparent;color:#dfe3f5}',
            '#' + MENU_ID + ' .m-key{margin-left:auto;font-size:11.5px;color:rgba(255,255,255,.38)}',
            '#' + MENU_ID + ' .m-sep{height:1px;margin:5px 6px;background:rgba(255,255,255,.11)}',
            /* 「收起顶部工具栏」：右键菜单里切换，状态记在 localStorage。
               收起后格式化全走右键菜单，写作时顶部一整条都不占地方。 */
            '.ee-toolbar-collapsed .vditor-toolbar{display:none!important}'
        ].join('\n');
        document.head.appendChild(s);
    }

    // ===== 顶部工具栏收起状态 =====
    var TOOLBAR_KEY = 'ee_toolbar_collapsed';
    function toolbarCollapsed() {
        try { return localStorage.getItem(TOOLBAR_KEY) === '1'; } catch (e) { return false; }
    }
    function applyToolbarCollapsed(v) {
        var el = vditorRoot();
        if (el) el.classList.toggle('ee-toolbar-collapsed', !!v);
        try { localStorage.setItem(TOOLBAR_KEY, v ? '1' : '0'); } catch (e) { /* 忽略 */ }
    }
    function toggleToolbar() {
        var next = !toolbarCollapsed();
        applyToolbarCollapsed(next);
        toast(next ? '顶部工具栏已收起 —— 右键菜单里可以再展开' : '顶部工具栏已展开');
    }

    /**
     * 真正的编辑区元素。
     *
     * Vditor 的 wysiwyg 是两层的：
     *     .vditor-wysiwyg            ← 外层容器，没有 contenteditable
     *       └ pre.vditor-reset       ← 真正的编辑区，各段落/标题都是它的子元素
     * 之前直接取 .vditor-wysiwyg，拿到的是外层容器 —— 它只有一个 <pre> 子元素，
     * 于是「当前块」永远找不到、段落上下移和光标定位全部静默失效。
     * 所以这里必须取到里面那层。
     */
    function editorEl() {
        return document.querySelector('#eeVditor .vditor-wysiwyg > .vditor-reset')
            || document.querySelector('#eeVditor .vditor-wysiwyg > pre')
            || document.querySelector('#eeVditor .vditor-ir > .vditor-reset')
            || document.querySelector('#eeVditor .vditor-ir')
            || document.querySelector('#eeVditor .vditor-sv > .vditor-reset')
            || document.querySelector('#eeVditor .vditor-sv')
            || null;
    }

    /** Vditor 根元素（收起工具栏时挂类用）。有的版本类在 #eeVditor 自己身上。 */
    function vditorRoot() {
        var host = document.getElementById('eeVditor');
        if (!host) return null;
        if (host.classList.contains('vditor')) return host;
        return host.querySelector('.vditor') || host;
    }

    /** 把光标挪到右键点击处（浏览器右键不会自己移光标） */
    function moveCaretTo(x, y, root) {
        if (!root) return;
        var range = null;
        try {
            range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y)
                : (document.caretPositionFromPoint ? (function () {
                    var p = document.caretPositionFromPoint(x, y);
                    if (!p) return null;
                    var r = document.createRange();
                    r.setStart(p.offsetNode, p.offset);
                    r.collapse(true);
                    return r;
                })() : null);
        } catch (e) { range = null; }
        if (!range) return;
        if (!root.contains(range.startContainer)) return;   // 点在编辑器外面就别动光标
        var sel = window.getSelection();
        if (!sel) return;
        // 点在已有选区内 → 保留选区（用户多半想对选中内容操作）
        if (sel.rangeCount > 0 && !sel.isCollapsed) {
            try { if (sel.containsNode(range.startContainer, true)) return; } catch (e) { /* 忽略 */ }
        }
        sel.removeAllRanges();
        sel.addRange(range);
    }

    /** 命中工具栏按钮（Vditor 的按钮 click() 对隐藏元素同样有效） */
    function clickToolbar(name) {
        var btn = document.querySelector('#eeVditor .vditor-toolbar [data-type="' + name + '"]')
            || document.querySelector('#eeVditor [data-type="' + name + '"]');
        if (btn) { btn.click(); return true; }
        return false;
    }

    /** 光标所在的最外层块（wysiwyg 的直接子元素） */
    function currentBlock(vd) {
        var root = editorEl();
        if (!root) return null;
        var sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        var node = sel.getRangeAt(0).startContainer;
        if (!root.contains(node)) return null;
        var cur = node.nodeType === 1 ? node : node.parentElement;
        while (cur && cur.parentElement && cur.parentElement !== root) cur = cur.parentElement;
        return (cur && cur.parentElement === root) ? cur : null;
    }

    /**
     * 改了编辑区 DOM 之后要通知一声。
     *
     * 刻意**不派发 input 事件**：实测（headless Chrome）纯 DOM 交换段落顺序能保持
     * 900ms 以上不变，而只要补一个 input 事件，Vditor 就会把顺序打回原样 ——
     * 「上移这一段」点了没反应就是这么来的。
     * getValue() 在 wysiwyg 下是实时遍历 DOM 生成 markdown 的，不依赖 Vditor 的
     * 内部缓存，所以只要自己标一下「有未保存改动」就够，正文不会丢改动。
     */
    function notifyEdited() {
        if (typeof window.eeMarkDirty === 'function') window.eeMarkDirty();
    }

    function toast(msg, kind) {
        // 复用编辑页的胶囊提示；没有就退回一个临时条
        var box = document.getElementById('eeToast');
        if (box) {
            box.textContent = msg;
            box.className = 'ee-toast show' + (kind ? ' ' + kind : '');
            clearTimeout(box._timer);
            box._timer = setTimeout(function () { box.className = 'ee-toast'; }, 2600);
        }
    }

    // ===== 各项动作 =====
    var actions = {
        cut: function () {
            var ok = false;
            try { ok = document.execCommand('cut'); } catch (e) { ok = false; }
            if (!ok) toast('剪切失败，请用 Ctrl+X');
        },
        copy: function () {
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            if (!ok) toast('复制失败，请用 Ctrl+C');
        },
        paste: function (ctx) {
            // 浏览器不给 JS 直接读剪贴板，只能读纯文本，且要用户手势（右键算）
            if (!navigator.clipboard || !navigator.clipboard.readText) { toast('这个浏览器不支持，请用 Ctrl+V'); return; }
            navigator.clipboard.readText().then(function (text) {
                if (!text) return;
                if (ctx.vditor && typeof ctx.vditor.insertValue === 'function') ctx.vditor.insertValue(text);
            }).catch(function () {
                toast('读不到剪贴板内容，请用 Ctrl+V 粘贴（或图片请拖进来）');
            });
        },
        selectAll: function (c) {
            var root = editorEl();
            if (!root) return;
            var range = document.createRange();
            range.selectNodeContents(root);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        },
        moveUp: function (ctx) { moveBlock(ctx, -1); },
        moveDown: function (ctx) { moveBlock(ctx, 1); },
        dupBlock: function (ctx) {
            var blk = currentBlock(ctx.vditor);
            if (!blk) { toast('先把光标放到要复制的段落里'); return; }
            var clone = blk.cloneNode(true);
            blk.parentNode.insertBefore(clone, blk.nextSibling);
            notifyEdited();
        },
        delBlock: function (ctx) {
            var blk = currentBlock(ctx.vditor);
            if (!blk) { toast('先把光标放到要删除的段落里'); return; }
            var root = editorEl();
            blk.parentNode.removeChild(blk);
            // 删完给个落点，不然光标悬空、后续操作会「找不到块」
            if (root && root.childNodes.length === 0) {
                var p = document.createElement('p');
                p.appendChild(document.createElement('br'));
                root.appendChild(p);
            }
            var sel = window.getSelection();
            if (sel) {
                var r = document.createRange();
                r.setStart(root, 0);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
            }
            notifyEdited();
        }
    };

    function moveBlock(ctx, dir) {
        var blk = currentBlock(ctx.vditor);
        if (!blk) { toast('先把光标放到要移动的段落里'); return; }
        var ref = dir < 0 ? blk.previousElementSibling : blk.nextElementSibling;
        if (!ref) { toast(dir < 0 ? '已经是第一段了' : '已经是最后一段了'); return; }
        var parent = blk.parentNode;
        if (dir < 0) parent.insertBefore(blk, ref);
        else parent.insertBefore(ref, blk);
        notifyEdited();
        try { blk.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 忽略 */ }
    }

    // ===== 菜单 =====
    var ctx = { vditor: null };
    var built = false;

    function buildMenu() {
        if (built) return;
        injectStyle();
        var box = document.createElement('div');
        box.id = MENU_ID;
        box.setAttribute('role', 'menu');
        document.body.appendChild(box);
        built = true;
    }

    function item(label, key, fn, disabled) {
        return { label: label, key: key, fn: fn, disabled: disabled };
    }

    function render(rows) {
        var box = $(MENU_ID);
        box.innerHTML = '';
        rows.forEach(function (row) {
            if (row === '-') {
                var sep = document.createElement('div');
                sep.className = 'm-sep';
                box.appendChild(sep);
                return;
            }
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'm-item';
            b.innerHTML = '<span>' + row.label + '</span>' + (row.key ? '<span class="m-key">' + row.key + '</span>' : '');
            if (row.disabled) b.setAttribute('disabled', 'disabled');
            b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 别让编辑器丢焦点
            b.addEventListener('click', function (e) {
                e.preventDefault();
                if (row.disabled) return;
                hide();
                try { row.fn(ctx); } catch (err) { toast('操作失败：' + ((err && err.message) || err)); }
            });
            box.appendChild(b);
        });
    }

    function showAt(x, y) {
        var box = $(MENU_ID);
        box.classList.add('open');
        // 先量再定位，避免超出视口
        var rect = box.getBoundingClientRect();
        var left = x, top = y;
        if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
        if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - rect.height - 8);
        box.style.left = Math.max(8, left) + 'px';
        box.style.top = Math.max(8, top) + 'px';
    }

    function hide() {
        var box = $(MENU_ID);
        if (box) box.classList.remove('open');
    }

    /**
     * 挂到编辑器上。
     * @param {object} vd Vditor 实例
     */
    function attach(vd) {
        if (!vd) return;
        ctx.vditor = vd;
        buildMenu();
        applyToolbarCollapsed(toolbarCollapsed());   // 恢复上次的收起状态

        var host = document.getElementById('eeVditor');
        if (!host) return;

        host.addEventListener('contextmenu', function (e) {
            var root = editorEl();
            if (!root) return;
            // 白板 / 导图卡片自己有右键行为（Excalidraw 的菜单），别抢
            if (e.target && e.target.closest && e.target.closest('.ep-canvas-card, .excalidraw, iframe, .vditor-toolbar, .vditor-panel')) return;
            if (!root.contains(e.target)) return;

            e.preventDefault();
            moveCaretTo(e.clientX, e.clientY, root);

            var hasSel = false;
            try { var s = window.getSelection(); hasSel = !!(s && s.rangeCount > 0 && !s.isCollapsed); } catch (err) { /* 忽略 */ }
            var inBlock = !!currentBlock(vd);

            render([
                item('剪切', 'Ctrl+X', actions.cut, !hasSel),
                item('复制', 'Ctrl+C', actions.copy, !hasSel),
                item('粘贴', 'Ctrl+V', actions.paste, false),
                item('全选', 'Ctrl+A', actions.selectAll, false),
                '-',
                item('加粗', 'Ctrl+B', function () { clickToolbar('bold'); }, !hasSel),
                item('斜体', 'Ctrl+I', function () { clickToolbar('italic'); }, !hasSel),
                item('删除线', '', function () { clickToolbar('strike'); }, !hasSel),
                item('行内代码', '', function () { clickToolbar('inline-code'); }, !hasSel),
                item('链接', '', function () { clickToolbar('link'); }, !hasSel),
                '-',
                item('插入白板 / 导图', '', function () { clickToolbar('eeEmbedPick'); }, false),
                item('插入图片', '', function () { clickToolbar('upload'); }, false),
                '-',
                item('上移这一段', '', actions.moveUp, !inBlock),
                item('下移这一段', '', actions.moveDown, !inBlock),
                item('复制这一段', '', actions.dupBlock, !inBlock),
                item('删除这一段', '', actions.delBlock, !inBlock),
                '-',
                item(toolbarCollapsed() ? '展开顶部工具栏' : '收起顶部工具栏', '', toggleToolbar, false)
            ]);
            showAt(e.clientX, e.clientY);
        });

        document.addEventListener('mousedown', function (e) {
            var box = $(MENU_ID);
            if (!box || !box.classList.contains('open')) return;
            if (box.contains(e.target)) return;
            hide();
        }, true);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') hide();
        });
        window.addEventListener('blur', hide);
        window.addEventListener('resize', hide);
        // 滚动时菜单会「悬」在原地指向错误位置，直接收起来更不容易误操作
        host.addEventListener('scroll', hide, true);
    }

    window.EditorMenu = { attach: attach, hide: hide };
})();
