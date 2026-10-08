/**
 * 编辑器大纲（v1.0.0）
 *
 * 为什么要有它：写长文时看不到结构，想跳到某一段只能靠滚动找。
 *
 * 数据直接取自编辑器 DOM（读 h1~h4），不解析 Markdown —— 编辑器里的标题和
 * 正文里的标题天然一一对应，少一次「Markdown ↔ DOM 对不上」的机会。
 *
 * 形态：编辑区左上角一个浮动小按钮，点开在左侧浮出面板。刻意不放进右侧属性栏：
 * 属性栏本来就长，而且侧栏可以折叠（折叠后大纲就没了），大纲应该始终够得着。
 */
(function () {
    'use strict';

    var BTN_ID = 'eoBtn';
    var PANEL_ID = 'eoPanel';
    var STYLE_ID = 'eo-style';
    var LEVELS = 'h1,h2,h3,h4';

    function $(id) { return document.getElementById(id); }

    function injectStyle() {
        if ($(STYLE_ID)) return;
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = [
            '.ee-editor-card{position:relative}',
            '#' + BTN_ID + '{position:absolute;left:8px;top:8px;z-index:6;display:none;align-items:center;gap:6px;',
            '  padding:5px 10px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;',
            '  background:rgba(20,21,30,.86);border:1px solid rgba(255,255,255,.14);color:#cfd3df;',
            '  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);transition:color .15s,border-color .15s,opacity .15s;',
            '  opacity:.72}',
            '#' + BTN_ID + '.show{display:inline-flex}',
            '#' + BTN_ID + ':hover,#' + BTN_ID + '.active{opacity:1;color:#fff;border-color:rgba(115,170,255,.55)}',
            '#' + BTN_ID + ' svg{width:14px;height:14px;flex:none}',
            '#' + PANEL_ID + '{position:absolute;left:8px;top:44px;z-index:5;width:min(258px,52%);',
            '  max-height:calc(100% - 60px);overflow-y:auto;display:none;padding:8px;border-radius:12px;',
            '  background:rgba(20,21,30,.95);border:1px solid rgba(255,255,255,.14);',
            '  box-shadow:0 20px 50px -16px rgba(0,0,0,.85);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);',
            '  font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif}',
            '#' + PANEL_ID + '.open{display:block}',
            '#' + PANEL_ID + ' .o-item{display:block;width:100%;text-align:left;border:0;background:transparent;',
            '  color:#cfd3df;cursor:pointer;padding:5px 8px;border-radius:7px;font-family:inherit;',
            '  font-size:12.5px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '#' + PANEL_ID + ' .o-item:hover{background:rgba(115,170,255,.18);color:#fff}',
            '#' + PANEL_ID + ' .o-item.active{background:rgba(115,170,255,.24);color:#fff;font-weight:600}',
            '#' + PANEL_ID + ' .o-lv2{padding-left:20px;font-size:12px}',
            '#' + PANEL_ID + ' .o-lv3{padding-left:34px;font-size:12px}',
            '#' + PANEL_ID + ' .o-lv4{padding-left:48px;font-size:12px}',
            '#' + PANEL_ID + ' .o-empty{padding:14px 10px;text-align:center;color:rgba(255,255,255,.5);font-size:12px;line-height:1.7}',
            /* 跳过去之后闪一下，避免「滚过去了但不知道看哪」 */
            '.ee-outline-flash{animation:eoFlash 1.1s ease}',
            '@keyframes eoFlash{0%,100%{box-shadow:none}25%,75%{box-shadow:0 0 0 3px rgba(115,170,255,.55)}}'
        ].join('\n');
        document.head.appendChild(s);
    }

    var vditorRef = null;
    var activeIdx = -1;

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

    function refresh() {
        var btn = $(BTN_ID);
        var panel = $(PANEL_ID);
        if (!btn || !panel) return;
        var hs = headings();
        btn.classList.toggle('show', hs.length > 0);
        if (!hs.length) {
            panel.classList.remove('open');
            btn.classList.remove('active');
            panel.innerHTML = '<div class="o-empty">正文里还没有标题。<br>用顶部工具栏的「标题」按钮加几个吧。</div>';
            return;
        }
        panel.innerHTML = '';
        hs.forEach(function (el, i) {
            var lv = parseInt(String(el.tagName).slice(1), 10) || 1;
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'o-item' + (lv > 1 ? ' o-lv' + Math.min(lv, 4) : '') + (i === activeIdx ? ' active' : '');
            b.textContent = label(el);
            b.title = label(el);
            b.setAttribute('data-idx', String(i));
            b.addEventListener('click', function (e) {
                e.preventDefault();
                jumpTo(i);
            });
            panel.appendChild(b);
        });
    }

    function jumpTo(idx) {
        var hs = headings();
        var el = hs[idx];
        if (!el) return;
        activeIdx = idx;
        try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { el.scrollIntoView(); }
        el.classList.remove('ee-outline-flash');
        void el.offsetWidth;                  // 强制重排，让动画能重复播放
        el.classList.add('ee-outline-flash');
        setTimeout(function () { el.classList.remove('ee-outline-flash'); }, 1200);
        refresh();
        // 跳完就收起来：面板盖着正文，留着反而挡视线
        close();
    }

    function open() {
        var panel = $(PANEL_ID), btn = $(BTN_ID);
        if (!panel || !btn) return;
        refresh();
        panel.classList.add('open');
        btn.classList.add('active');
    }
    function close() {
        var panel = $(PANEL_ID), btn = $(BTN_ID);
        if (panel) panel.classList.remove('open');
        if (btn) btn.classList.remove('active');
    }
    function toggle() {
        var panel = $(PANEL_ID);
        if (panel && panel.classList.contains('open')) close(); else open();
    }

    function build() {
        var host = document.querySelector('.ee-editor-card');
        if (!host) return false;
        injectStyle();
        if (!$(BTN_ID)) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.id = BTN_ID;
            btn.title = '大纲（文档结构）';
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
                'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<path d="M8 6h13M8 12h13M8 18h13"></path><path d="M3 6h.01M3 12h.01M3 18h.01"></path></svg><span>大纲</span>';
            btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggle(); });
            host.appendChild(btn);
        }
        if (!$(PANEL_ID)) {
            var panel = document.createElement('div');
            panel.id = PANEL_ID;
            host.appendChild(panel);
        }
        return true;
    }

    var timer = null;
    function scheduleRefresh() {
        clearTimeout(timer);
        timer = setTimeout(refresh, 500);      // 打字时别每敲一下就重建列表
    }

    function attach(vd) {
        vditorRef = vd;
        if (!build()) return;
        refresh();
        // setValue 是异步渲染的：attach 发生在 after 回调里，此刻正文可能还没落进 DOM，
        // 标题自然是空的。补两次刷新（一次等首次渲染，一次兜慢机器）。
        setTimeout(refresh, 350);
        setTimeout(refresh, 1400);

        var root = editorRoot();
        if (root) root.addEventListener('input', scheduleRefresh);
        // 点面板以外的地方收起来
        document.addEventListener('mousedown', function (e) {
            var panel = $(PANEL_ID), btn = $(BTN_ID);
            if (!panel || !panel.classList.contains('open')) return;
            if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
            close();
        }, true);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') close();
        });
        var card = document.querySelector('.ee-editor-card');
        if (card) card.addEventListener('scroll', close, true);
    }

    window.EditorOutline = { attach: attach, refresh: refresh, scheduleRefresh: scheduleRefresh };
})();
