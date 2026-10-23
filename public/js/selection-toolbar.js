/**
 * 划词悬浮按钮组（v1.0.0）
 * ------------------------------------------------------------------
 * 在编辑器里选中一段文字后，选区上方浮出一排快捷按钮（加粗 / 斜体 / 行内代码 /
 * 插入链接 / 标记术语 / 取消…），点完自动收起。
 *
 * 设计要点：
 *   - **不抢焦点、不破坏选区**：按钮的 mousedown 一律 preventDefault，
 *     否则点一下选区就没了，后续操作（加粗、取选中文字）全部失效。
 *   - 按钮列表**按上下文生成**：attach 时传入 resolve()，每次划词重新算一遍，
 *     所以「标记为术语」在已是术语时会变成「取消术语」。
 *   - 只在指定容器内的选区才出现（避免在侧栏、弹窗里选中文字也弹出来）。
 *   - 选区折叠 / 滚动 / 缩放 / Esc / 点别处 → 收起。
 *
 * 用法：
 *     SelectionToolbar.attach({
 *         host: document.getElementById('eeVditor'),
 *         selectors: '.vditor-wysiwyg, .vditor-ir',       // 选区必须落在这些元素里
 *         resolve: function (selText, ctx) {
 *             return [{ id:'bold', label:'B', title:'加粗', run: function(){...} }, ...];
 *         }
 *     });
 */
(function () {
    'use strict';

    var BAR_ID = 'eeSelBar';
    var GAP = 8;               // 与选区的垂直间距
    var MIN_EDGE = 8;          // 距视口边缘的最小距离

    var bar = null;
    var host = null;
    var resolveActions = null;
    var allowedSelectors = '.vditor-wysiwyg, .vditor-ir';
    var hideTimer = null;
    var lastSelText = '';

    function buildBar() {
        if (bar && bar.parentNode) return bar;
        bar = document.createElement('div');
        bar.id = BAR_ID;
        bar.className = 'ee-selbar';
        bar.setAttribute('role', 'toolbar');
        bar.style.display = 'none';
        // 关键：按下按钮时不要抢走选区
        bar.addEventListener('mousedown', function (e) { e.preventDefault(); });
        document.body.appendChild(bar);
        return bar;
    }

    function hide() {
        if (!bar) return;
        bar.style.display = 'none';
        bar.innerHTML = '';
    }

    function currentSelectionInfo() {
        var sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
        var text = String(sel).trim();
        if (!text) return null;
        var range = sel.getRangeAt(0);
        var node = range.startContainer;
        var el = node && (node.nodeType === 1 ? node : node.parentElement);
        if (!el || !host || !host.contains(el)) return null;
        if (allowedSelectors && el.closest && !el.closest(allowedSelectors)) return null;
        var rect = range.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) {
            // 跨行的选区拿 range 的矩形可能为 0，退回选区最后一个矩形
            var rects = range.getClientRects();
            rect = rects.length ? rects[0] : null;
        }
        if (!rect) return null;
        return { text: text, range: range, rect: rect, anchorEl: el };
    }

    function place(rect, barH, barW) {
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var top = rect.top - barH - GAP;
        if (top < MIN_EDGE) top = rect.bottom + GAP;               // 上方放不下 → 放到下方
        if (top + barH > vh - MIN_EDGE) top = Math.max(MIN_EDGE, vh - barH - MIN_EDGE);
        var left = rect.left + rect.width / 2 - barW / 2;
        if (left < MIN_EDGE) left = MIN_EDGE;
        if (left + barW > vw - MIN_EDGE) left = Math.max(MIN_EDGE, vw - barW - MIN_EDGE);
        bar.style.top = Math.round(top) + 'px';
        bar.style.left = Math.round(left) + 'px';
    }

    function render(info) {
        var actions = [];
        try { actions = resolveActions ? (resolveActions(info.text, info) || []) : []; } catch (e) { actions = []; }
        if (!actions.length) { hide(); return; }
        var b = buildBar();
        b.innerHTML = actions.map(function (a, i) {
            var cls = 'ee-selbar-btn' + (a.danger ? ' danger' : '') + (a.primary ? ' primary' : '');
            var label = a.icon || a.label || '';
            var hint = a.title || a.label || '';
            return '<button type="button" class="' + cls + '" data-i="' + i + '" title="' + escapeAttr(hint) + '"' +
                ' aria-label="' + escapeAttr(hint) + '">' + label + '</button>';
        }).join('');
        Array.prototype.forEach.call(b.querySelectorAll('.ee-selbar-btn'), function (btn) {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var act = actions[Number(this.getAttribute('data-i'))];
                hide();
                if (act && typeof act.run === 'function') {
                    try { act.run(info.text, info); } catch (err) { /* 单项失败不影响其它 */ }
                }
            });
        });
        b.style.display = 'flex';
        // 量出真实尺寸再定位（内容不同宽度不同）
        place(info.rect, b.offsetHeight || 34, b.offsetWidth || 200);
    }

    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function maybeShow() {
        clearTimeout(hideTimer);
        var info = currentSelectionInfo();
        if (!info) { hide(); return; }
        lastSelText = info.text;
        render(info);
    }

    function scheduleShow() {
        // 等浏览器把选区状态更新完（mouseup 之后 DOM 里才有 range）
        clearTimeout(hideTimer);
        hideTimer = setTimeout(maybeShow, 10);
    }

    var SelectionToolbar = {};

    SelectionToolbar.attach = function (options) {
        options = options || {};
        host = options.host || null;
        resolveActions = options.resolve || null;
        if (options.selectors) allowedSelectors = options.selectors;
        if (!host) return false;
        buildBar();

        document.addEventListener('mouseup', function (e) {
            // 点在按钮组自己身上不处理（按钮有自己的 click）
            if (bar && bar.contains(e.target)) return;
            scheduleShow();
        });
        // 键盘选中（Shift+方向键 / Ctrl+A）也要能弹
        document.addEventListener('keyup', function (e) {
            if (!e.shiftKey && e.key !== 'a' && e.key !== 'A') return;
            scheduleShow();
        });
        document.addEventListener('selectionchange', function () {
            var sel = window.getSelection();
            if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !String(sel).trim()) {
                // 选区没了就收起，但别和 mouseup 抢时序
                setTimeout(function () {
                    var s2 = window.getSelection();
                    if (!s2 || s2.rangeCount === 0 || s2.isCollapsed || !String(s2).trim()) hide();
                }, 30);
            }
        });
        window.addEventListener('scroll', function () { hide(); }, { passive: true });
        window.addEventListener('resize', function () { hide(); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') hide();
        }, true);
        return true;
    };

    SelectionToolbar.hide = hide;
    SelectionToolbar.lastText = function () { return lastSelText; };

    window.SelectionToolbar = SelectionToolbar;
})();
