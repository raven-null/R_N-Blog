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
    var SUBBOX_ID = 'eeCtxSub';
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
            /* 二级菜单（v3.41.0）：顶层只放最高频的几项，其余收进子菜单。
               子菜单是绝对定位的小面板，挂在触发行旁边；空间不够时翻到左边。 */
            '#' + MENU_ID + ' .m-item.m-sub::after{content:"›";margin-left:auto;font-size:14px;color:rgba(255,255,255,.45)}',
            '#' + MENU_ID + ' .m-item.m-sub.active{background:rgba(115,170,255,.20);color:#fff}',
            '.m-subbox{position:fixed;z-index:2147483001;display:none;min-width:172px;',
            '  padding:6px;border-radius:12px;background:rgba(24,25,34,.98);',
            '  border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 48px -14px rgba(0,0,0,.85);',
            '  backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);',
            '  font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif;font-size:13px}',
            '.m-subbox.open{display:block}',
            '.m-subbox .m-item{display:flex;align-items:center;gap:10px;width:100%;',
            '  padding:7px 10px;border-radius:8px;cursor:pointer;border:0;background:transparent;',
            '  color:#dfe3f5;font-family:inherit;font-size:13px;text-align:left}',
            '.m-subbox .m-item:hover{background:rgba(115,170,255,.20);color:#fff}',
            '.m-subbox .m-item[disabled]{opacity:.38;cursor:default}',
            '.m-subbox .m-item[disabled]:hover{background:transparent;color:#dfe3f5}',
            '.m-subbox .m-key{margin-left:auto;font-size:11.5px;color:rgba(255,255,255,.38)}',
            '.m-subbox .m-sep{height:1px;margin:5px 6px;background:rgba(255,255,255,.11)}',
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

    /** 套高亮（v3.48.0）：实现在 admin-edit.js 里（window.eeHighlight） */
    function hl(color) {
        if (window.eeHighlight && window.eeHighlight.apply) {
            if (!window.eeHighlight.apply(color)) toast('先选中要高亮的文字', 'error');
            return;
        }
        toast('高亮功能未加载，请刷新重试', 'error');
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

    /** 光标所在的链接元素（没有就 null）——「取消链接」用 */
    function closestAnchor() {
        var root = editorEl();
        if (!root) return null;
        var sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        var node = sel.getRangeAt(0).startContainer;
        var el = node && (node.nodeType === 1 ? node : node.parentElement);
        if (!el || !root.contains(el)) return null;
        var a = el.closest ? el.closest('a') : null;
        return (a && root.contains(a)) ? a : null;
    }

    /**
     * 把光标所在的 <a> 拆成它的子节点（文字与内部格式保留）。
     * @returns {boolean|null} true=取消了；null=光标不在链接里；false=失败
     */
    function unwrapAnchor() {
        var a = closestAnchor();
        if (!a) return null;
        try {
            var parent = a.parentNode;
            if (!parent) return false;
            // 先把子节点收起来，替换后好把光标放回文字末尾
            var kids = Array.prototype.slice.call(a.childNodes);
            var frag = document.createDocumentFragment();
            kids.forEach(function (k) { frag.appendChild(k); });
            parent.replaceChild(frag, a);
            if (parent.normalize) parent.normalize();
            var last = kids[kids.length - 1];
            if (last) {
                try {
                    var r = document.createRange();
                    r.selectNodeContents(last);
                    r.collapse(false);
                    var sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(r);
                } catch (e) { /* 光标放不回去也不影响结果 */ }
            }
            notifyEdited();
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * 取消链接 + 取消术语标记（v3.40.0）。
     * 一次把「选中的这段内容」上的两样标记都清掉：
     *   · 光标在链接里 → 拆掉链接（文字保留）
     *   · 选中的词是已标记的术语 → 取消术语
     * @param {string} selText 右键时刻/划词时刻的选中文字
     * @returns {string[]} 实际取消掉的东西（用于提示）
     */
    function cancelLinkAndTerm(selText) {
        var did = [];
        var unwrapped = unwrapAnchor();
        if (unwrapped === true) did.push('链接');
        var text = String(selText || '').trim();
        if (text && window.EETerms && typeof window.EETerms.has === 'function' && window.EETerms.has(text)) {
            if (typeof window.EETerms.unmark === 'function') {
                // unmark 自己会 toast 一次，这里用静默版避免连着弹两条
                window.EETerms.unmark(text, { silent: true });
                did.push('术语标记');
            }
        }
        if (!did.length) toast('选中的内容既不是链接也不是术语', 'error');
        else toast('已取消：' + did.join(' + '));
        return did;
    }
    window.eeCancelLinkAndTerm = cancelLinkAndTerm;

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
        /**
         * 取消链接（v3.39.1）：把 <a> 拆成它的子节点，**文字保留**、链接去掉。
         * 与「上移这一段」同一套做法：改 DOM + notifyEdited()，不派发 input
         * （派发了 Vditor 会把 DOM 打回原样，见 notifyEdited 的注释）。
         */
        unlink: function () {
            var okUnlink = unwrapAnchor();
            if (okUnlink === null) { toast('把光标放到链接上再取消'); return false; }
            if (okUnlink === false) { toast('取消链接失败'); return false; }
            toast('已取消链接（文字保留）');
            return true;
        },
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

    /** 二级菜单项（v3.41.0）：hover / 点一下 / → 键展开 */
    function sub(label, rows) {
        return { label: label, sub: rows };
    }

    var openSub = null;   // 当前展开的子菜单面板

    /** 调试埋点（仅当 window.__subDebug 为真时记录，生产环境不产生开销） */
    function subLog(what) {
        if (!window.__subDebug) return;
        (window.__subLog = window.__subLog || []).push(Date.now() % 100000 + ' ' + what);
    }

    function closeSub(reason) {
        subLog('closeSub ' + (reason || ''));
        if (openSub) {
            openSub.classList.remove('open');
            openSub = null;
        }
        Array.prototype.forEach.call(document.querySelectorAll('#' + MENU_ID + ' .m-item.m-sub.active'), function (el) {
            el.classList.remove('active');
        });
    }

    /**
     * 在指定容器里渲染一排菜单项（顶层与子菜单共用）
     * @param {HTMLElement} box 容器
     * @param {Array} rows 菜单行
     * @param {boolean} inSub true = 渲染在子菜单面板里
     *   关键区别：只有**顶层**的普通项才绑「移上去就收起子菜单」。
     *   早期版本没区分容器，子菜单里的项也绑了这条 —— 鼠标一进子菜单就把它自己关掉了，
     *   表现就是「二级菜单移不进去」。
     */
    function renderInto(box, rows, inSub) {
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
            b.className = 'm-item' + (row.sub ? ' m-sub' : '');
            b.innerHTML = '<span>' + row.label + '</span>' + (row.key ? '<span class="m-key">' + row.key + '</span>' : '');
            if (row.disabled) b.setAttribute('disabled', 'disabled');
            b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 别让编辑器丢焦点

            if (row.sub) {
                // 二级菜单：桌面 hover 展开，触屏 / 键盘也能点开
                b.addEventListener('mouseenter', function () { openSubmenu(b, row.sub); });
                b.addEventListener('click', function (e) {
                    e.preventDefault();
                    if (openSub && openSub._owner === b) { closeSub('click-toggle'); return; }
                    openSubmenu(b, row.sub);
                });
                b.addEventListener('keydown', function (e) {
                    if (e.key === 'ArrowRight') { e.preventDefault(); openSubmenu(b, row.sub); }
                });
            } else {
                // 只在顶层：移到普通项上收起子菜单（子菜单内的项不能绑这条）
                if (!inSub) b.addEventListener('mouseenter', function () { closeSub('hover-other-item'); });
                b.addEventListener('click', function (e) {
                    e.preventDefault();
                    if (row.disabled) return;
                    hide();
                    try { row.fn(ctx); } catch (err) { toast('操作失败：' + ((err && err.message) || err)); }
                });
            }
            box.appendChild(b);
        });
    }

    /** 展开某个子菜单：贴在触发行右侧；右侧放不下翻到左边 */
    function openSubmenu(trigger, rows) {
        closeSub('reopen');
        var panel = document.getElementById(SUBBOX_ID);
        if (!panel) {
            panel = document.createElement('div');
            panel.id = SUBBOX_ID;
            panel.className = 'm-subbox';
            panel.setAttribute('role', 'menu');
            document.body.appendChild(panel);
            panel.addEventListener('mousedown', function (e) { e.preventDefault(); });
            // 鼠标离开面板 → 收起。注意这里**不能**看触发行的 :hover：
            // 从触发行往子菜单移动时触发行必然先失去 hover，看了就永远收不起来。
            // 改成「离开后 220ms 内没有再回到面板，且指针也不在面板上」才关，
            // 给斜着移动留出余量。
            panel.addEventListener('mouseleave', function () {
                setTimeout(function () {
                    if (!panel.classList.contains('open')) return;
                    if (panel.matches && panel.matches(':hover')) return;
                    closeSub('panel-mouseleave');
                }, 220);
            });
        }
        renderInto(panel, rows, true);
        trigger.classList.add('active');
        panel.classList.add('open');
        openSub = panel;
        panel._owner = trigger;

        var r = trigger.getBoundingClientRect();
        var pr = panel.getBoundingClientRect();
        // 与触发行**重叠 1px**：两元素之间留空会让指针在空隙里"掉出去"，
        // 一旦斜着移动就会先命中别的行、把子菜单关掉。
        var left = r.right - 1;
        if (left + pr.width > window.innerWidth - 8) left = r.left - pr.width + 1;   // 翻到左边
        if (left < 8) left = 8;
        var top = r.top - 4;
        if (top + pr.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - pr.height - 8);
        panel.style.left = Math.round(left) + 'px';
        panel.style.top = Math.round(Math.max(8, top)) + 'px';
    }

    function render(rows) {
        closeSub('render');
        renderInto($(MENU_ID), rows);
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
        closeSub('hide');
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
            var selText = '';
            try {
                var s = window.getSelection();
                hasSel = !!(s && s.rangeCount > 0 && !s.isCollapsed);
                selText = String(s || '').trim();
            } catch (err) { /* 忽略 */ }
            var inBlock = !!currentBlock(vd);
            // 取消类操作的状态：光标是否在链接里、选中的词是不是已标记的术语
            var inLink = !!closestAnchor();
            var termHit = (selText && window.EETerms && typeof window.EETerms.has === 'function' && window.EETerms.has(selText))
                ? selText : '';

            // 顶层只放最高频的动作，其余收进二级菜单（v3.41.0：25 行 → 12 行）
            render([
                item('剪切', 'Ctrl+X', actions.cut, !hasSel),
                item('复制', 'Ctrl+C', actions.copy, !hasSel),
                item('粘贴', 'Ctrl+V', actions.paste, false),
                item('全选', 'Ctrl+A', actions.selectAll, false),
                '-',
                // 格式：原来平铺 5 项，现在收成一层
                sub('格式', [
                    item('加粗', 'Ctrl+B', function () { clickToolbar('bold'); }, !hasSel),
                    item('斜体', 'Ctrl+I', function () { clickToolbar('italic'); }, !hasSel),
                    item('删除线', '', function () { clickToolbar('strike'); }, !hasSel),
                    item('行内代码', '', function () { clickToolbar('inline-code'); }, !hasSel)
                ]),
                // 高亮（v3.48.0）：七种颜色 + 清除。黄用短写 ==文字==，其它是 =={color}文字==
                sub('高亮', [
                    item('黄色', '', function () { hl('yellow'); }, !hasSel),
                    item('橙色', '', function () { hl('orange'); }, !hasSel),
                    item('红色', '', function () { hl('red'); }, !hasSel),
                    item('绿色', '', function () { hl('green'); }, !hasSel),
                    item('蓝色', '', function () { hl('blue'); }, !hasSel),
                    item('紫色', '', function () { hl('purple'); }, !hasSel),
                    item('灰色', '', function () { hl('gray'); }, !hasSel),
                    item('更多颜色…', '', function () {
                        if (window.eeHighlight) window.eeHighlight.openMenu(null);
                        else toast('高亮功能未加载，请刷新重试', 'error');
                    }, !hasSel),
                    item('清除高亮', '', function () {
                        if (window.eeHighlight) window.eeHighlight.clear();
                    }, false)
                ]),
                // 链接：插入（Vditor 原生 / 站内文章 / 本文标题）+ 取消
                sub('链接', [
                    item('插入链接…', '', function () { clickToolbar('link'); }, !hasSel),
                    item('插入站内链接…', '', function () {
                        if (window.eeOpenLinkPicker) window.eeOpenLinkPicker('article', selText);
                        else toast('链接面板未加载，请刷新重试', 'error');
                    }, false),
                    item('链接到本文标题…', '', function () {
                        if (window.eeOpenLinkPicker) window.eeOpenLinkPicker('heading', selText);
                        else toast('链接面板未加载，请刷新重试', 'error');
                    }, false),
                    '-',
                    // 光标在链接里时可用：去掉链接、保留文字
                    item('取消链接', '', actions.unlink, !inLink)
                ]),
                // 术语：标记 / 取消（取消项同时清掉链接，v3.40.0 合并过）
                sub('术语', [
                    item('标记为术语', '', function () {
                        if (!selText) { toast('先选中要标成术语的文字'); return; }
                        if (window.EETerms && typeof window.EETerms.mark === 'function') window.EETerms.mark(selText);
                        else toast('术语功能未加载，请刷新重试', 'error');
                    }, !hasSel),
                    item('取消链接和术语标记', '', function () {
                        cancelLinkAndTerm(termHit || selText);
                    }, !(inLink || termHit))
                ]),
                item('插入图片', '', function () { clickToolbar('upload'); }, false),
                // 段落：移动 / 复制 / 删除
                sub('段落', [
                    item('上移这一段', '', actions.moveUp, !inBlock),
                    item('下移这一段', '', actions.moveDown, !inBlock),
                    item('复制这一段', '', actions.dupBlock, !inBlock),
                    item('删除这一段', '', actions.delBlock, !inBlock)
                ]),
                '-',
                item(toolbarCollapsed() ? '展开顶部工具栏' : '收起顶部工具栏', '', toggleToolbar, false)
            ]);
            showAt(e.clientX, e.clientY);
        });

        document.addEventListener('mousedown', function (e) {
            var box = $(MENU_ID);
            var subbox = $(SUBBOX_ID);
            if (!box || !box.classList.contains('open')) return;
            // 点子菜单里的项不算「点外面」
            if (box.contains(e.target) || (subbox && subbox.contains(e.target))) return;
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
