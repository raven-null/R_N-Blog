/**
 * 侧栏「目录」页签（v2.0.0）
 *
 * 为什么改到侧栏：v1.x 是「编辑区左上角浮动按钮 + 浮层面板」，面板直接盖住正文，
 * 而且「点开 → 点标题 → 自己收起」这套交互写长文时要反复做，每跳一次视线就被打断一次。
 * v2.0.0 起它就是右侧栏的第四个页签，和「属性 / 术语 / AI」并列：常驻、可折叠、不挡正文，
 * 侧栏折叠后还能从右侧把手「‹ 目录」直接展开。
 *
 * 数据直接取自编辑器 DOM（读 h1~h4），不解析 Markdown —— 编辑器里的标题和
 * 正文里的标题天然一一对应，少一次「Markdown ↔ DOM 对不上」的机会。
 *
 * 归属：目录只有「文章」形态才有意义（白板 / 导图 / 节点图没有正文，
 * 谈不上结构）。显隐由 admin-edit.js 的 sideAllowed() 统一控制，本文件只负责
 * 把目录画进 #eeSideOutline，不自作主张显示或隐藏页签。
 */
(function () {
    'use strict';

    var HOST_ID = 'eeSideOutline';
    var LIST_ID = 'eoList';
    var LEVELS = 'h1,h2,h3,h4';

    var activeIdx = -1;
    var sig = '';              // 上一次渲染的结构签名：没变就只改高亮，不重建 DOM
    var scrollBound = false;   // 滚动监听只绑一次（attach 可能被调用多次）
    var suppressUntil = 0;     // 主动跳转期间别让滚动同步把高亮改回去

    function $(id) { return document.getElementById(id); }

    /**
     * 真正的编辑区元素。
     * Vditor 的 wysiwyg 有两层：.vditor-wysiwyg 是外层容器，
     * 真正的编辑区是它里面的 pre.vditor-reset。取错层的话，
     * 下面的「排除代码块里的标题」会把编辑区本身当成 pre 而过滤掉全部标题。
     */
    function editorRoot() {
        return document.querySelector('#eeVditor .vditor-wysiwyg > .vditor-reset')
            || document.querySelector('#eeVditor .vditor-wysiwyg > pre')
            || document.querySelector('#eeVditor .vditor-ir > .vditor-reset')
            || document.querySelector('#eeVditor .vditor-ir')
            || document.querySelector('#eeVditor .vditor-sv > .vditor-reset')
            || document.querySelector('#eeVditor .vditor-sv')
            || null;
    }

    /** 取编辑器里的标题元素（跳过代码块里的那几行，它们不是文档结构） */
    function headings() {
        var root = editorRoot();
        if (!root) return [];
        return Array.prototype.filter.call(root.querySelectorAll(LEVELS), function (el) {
            return !el.closest('.vditor-wysiwyg__block[data-type="code-block"]')
                && !el.closest('.vditor-wysiwyg__pre')
                && !el.closest('.vditor-wysiwyg__preview');
        });
    }

    function label(el) {
        var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return t || '(无标题)';
    }

    /**
     * 编辑器真正的滚动容器：从编辑区往外找第一个「内容比自身高、overflow-y 可滚」的祖先。
     * 不写死 .vditor-wysiwyg：Vditor 不同模式下滚动容器换过好几层，写死等于赌版本。
     */
    function scrollHost() {
        var node = editorRoot();
        while (node && node.nodeType === 1 && node !== document.body) {
            var oy = '';
            try { oy = getComputedStyle(node).overflowY; } catch (e) { oy = ''; }
            if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 2) return node;
            node = node.parentElement;
        }
        return null;
    }

    /** 侧栏里的列表容器；页签面板在静态 HTML 里，通常第一次就能拿到 */
    function ensureList() {
        var host = $(HOST_ID);
        if (!host) return null;
        var list = $(LIST_ID);
        if (!list) {
            host.innerHTML = '<div class="eo-list" id="' + LIST_ID + '" role="list"></div>';
            list = $(LIST_ID);
        }
        return list || null;
    }

    function makeItem(el, i) {
        var lv = Math.min(parseInt(String(el.tagName).slice(1), 10) || 1, 4);
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'eo-item' + (lv > 1 ? ' eo-lv' + lv : '');
        b.textContent = label(el);
        b.title = label(el);
        b.setAttribute('data-idx', String(i));
        // 不抢焦点：鼠标点目录不该把光标从正文里拔出来
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            jumpTo(i);
        });
        return b;
    }

    /** 只切高亮，不动 DOM（滚动同步每秒可能触发十几次，重建列表会让鼠标悬停被反复打断） */
    function paintActive() {
        var list = $(LIST_ID);
        if (!list) return;
        Array.prototype.forEach.call(list.querySelectorAll('.eo-item'), function (b, i) {
            b.classList.toggle('active', i === activeIdx);
        });
    }

    function refresh() {
        var list = ensureList();
        if (!list) return;
        var hs = headings();
        var next = hs.map(function (el) {
            return (parseInt(String(el.tagName).slice(1), 10) || 1) + '\u0001' + label(el);
        }).join('\u0002');
        if (next !== sig) {
            sig = next;
            if (activeIdx >= hs.length) activeIdx = hs.length - 1;
            list.innerHTML = '';
            if (!hs.length) {
                list.innerHTML = '<div class="eo-empty">正文还没有标题</div>';
            } else {
                hs.forEach(function (el, i) { list.appendChild(makeItem(el, i)); });
            }
        }
        paintActive();
    }

    function flash(el) {
        el.classList.remove('ee-outline-flash');
        void el.offsetWidth;                      // 强制重排，让动画能重复播放
        el.classList.add('ee-outline-flash');
        setTimeout(function () { el.classList.remove('ee-outline-flash'); }, 1200);
    }

    /**
     * 跳到第 idx 个标题。
     * 优先滚真正的滚动容器并留 12px 顶部余量 —— 直接 scrollIntoView 会把标题顶到
     * 编辑器可视区最上沿，贴着工具栏看不清是哪一个。
     */
    function jumpTo(idx) {
        var el = headings()[idx];
        if (!el) return;
        activeIdx = idx;
        suppressUntil = Date.now() + 600;
        var host = scrollHost();
        try {
            if (host) {
                var top = el.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - 12;
                if (host.scrollTo) host.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
                else host.scrollTop = Math.max(0, top);
            } else {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        } catch (e) {
            try { el.scrollIntoView(); } catch (e2) { /* 老浏览器，忽略 */ }
        }
        flash(el);
        paintActive();
        // 目录比侧栏高时，跳到的那一条也随之滚进视野（只滚目录，不动正文）
        var item = $(LIST_ID) && $(LIST_ID).children[idx];
        if (item && item.scrollIntoView) {
            try { item.scrollIntoView({ block: 'nearest' }); } catch (e3) { /* 忽略 */ }
        }
    }

    /** 滚动正文时同步高亮：可见区里最后一个「顶边已经越过上沿」的标题就是当前章节 */
    function markActive() {
        if (Date.now() < suppressUntil) return;
        var hs = headings();
        if (!hs.length) return;
        var host = scrollHost();
        var base = host ? host.getBoundingClientRect().top : 0;
        var idx = 0;
        for (var i = 0; i < hs.length; i++) {
            if (hs[i].getBoundingClientRect().top - base <= 24) idx = i;
        }
        if (idx !== activeIdx) {
            activeIdx = idx;
            paintActive();
        }
    }

    var timer = null;
    function scheduleRefresh() {
        clearTimeout(timer);
        timer = setTimeout(refresh, 400);   // 打字时别每敲一下就重建列表
    }

    var rafPending = false;
    function scheduleActive() {
        if (rafPending) return;
        rafPending = true;
        var run = function () { rafPending = false; markActive(); };
        if (window.requestAnimationFrame) window.requestAnimationFrame(run);
        else setTimeout(run, 40);
    }

    function bindScroll() {
        if (scrollBound) return false;
        var target = scrollHost() || document.querySelector('#eeVditor');
        if (!target) return false;
        target.addEventListener('scroll', scheduleActive, { passive: true });
        scrollBound = true;
        return true;
    }

    /**
     * 编辑器就绪后接入。
     * 只做「监听 + 首次渲染」两件事：页签的显隐与切换归 admin-edit.js。
     */
    function attach(vd) {
        refresh();
        // setValue 是异步渲染的：attach 发生在 after 回调里，此刻正文可能还没落进 DOM，
        // 标题自然是空的。补两次刷新（一次等首次渲染，一次兜慢机器）。
        setTimeout(refresh, 350);
        setTimeout(refresh, 1400);
        setTimeout(bindScroll, 350);
        setTimeout(bindScroll, 1400);

        // input 事件会冒泡，绑在容器上比绑编辑区更稳（编辑区可能晚一步才建出来）
        var wrap = document.getElementById('eeVditor');
        if (wrap) {
            wrap.addEventListener('input', scheduleRefresh);
            wrap.addEventListener('keyup', scheduleRefresh);
        } else {
            var root = editorRoot();
            if (root) root.addEventListener('input', scheduleRefresh);
        }
        bindScroll();
    }

    /** 页签切到「目录」时调用：这时候才需要最新的结构，顺便把滚动监听补上 */
    function onShow() {
        refresh();
        setTimeout(refresh, 120);
        setTimeout(bindScroll, 60);
    }

    window.EditorOutline = {
        attach: attach,
        refresh: refresh,
        scheduleRefresh: scheduleRefresh,
        onShow: onShow
    };
})();
