/**
 * 阅读体验增强（文章页）
 * 功能：阅读进度条、字号/行距/字体调节、专注阅读、键盘快捷键、目录折叠记忆
 */
(function () {
    'use strict';

    const STORE = 'reader-settings';

    const defaults = { font: 16, line: 1.8, fontFamily: 'sans' };

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
            // 旧的 mode（护眼 / 夜间）已移除，读到时直接丢掉
            if (saved && 'mode' in saved) delete saved.mode;
            return Object.assign({}, defaults, saved);
        } catch (e) {
            return Object.assign({}, defaults);
        }
    }

    let settings = loadSettings();
    const root = document.documentElement;

    function save() {
        try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) { }
    }

    function apply() {
        root.style.setProperty('--reader-font-size', settings.font + 'px');
        root.style.setProperty('--reader-line-height', settings.line);
        root.classList.toggle('reader-serif', settings.fontFamily === 'serif');

        const fs = document.getElementById('readerFontSize');
        if (fs) fs.textContent = settings.font;
        const lh = document.getElementById('readerLineHeight');
        if (lh) lh.textContent = '行距 ' + settings.line.toFixed(1);
        const serif = document.getElementById('readerFontFamily');
        if (serif) serif.textContent = settings.fontFamily === 'serif' ? '无衬线' : '衬线';
    }

    function bind(id, fn) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    }

    function toggleFocus() {
        root.classList.toggle('reader-focus');
        syncFocusUi();
    }

    // 同步移动端悬浮球菜单里的专注按钮状态
    function syncFocusUi() {
        const btn = document.getElementById('mobileFocusToggle');
        if (!btn) return;
        const on = root.classList.contains('reader-focus');
        btn.classList.toggle('active', on);
        btn.title = on ? '退出专注' : '专注阅读';
    }

    // 供移动端功能汇总菜单调用，点完顺手收起菜单
    window.toggleReaderFocus = function () {
        toggleFocus();
        if (typeof window.closeMobileMenu === 'function') window.closeMobileMenu();
    };

    /* ===== 目录折叠（v3.52.1） =====
       收起后整个目录栏消失、正文向左铺开，左边缘留一条竖标签点回来；
       目录栏顶上那排（返回 / 首页 / 主题 / 助手）跟着搬进阅读工具栏的最左边，展开时再搬回去。
       窄屏（≤773px）目录本来就是抽屉，不参与这套，状态也就不写死。 */
    const TOC_STORE = 'article-toc-collapsed';

    // 那排按钮原本身在侧栏何处：搬过去之前先记下，展开时要放回原位
    let topBar = null;
    let topBarParent = null;
    let topBarNext = null;

    function moveTopBar(collapsed) {
        const slot = document.getElementById('readerBarActions');
        if (!topBar || !slot || !topBarParent) return;
        if (collapsed) {
            if (topBar.parentElement !== slot) slot.appendChild(topBar);
        } else if (topBar.parentElement !== topBarParent) {
            topBarParent.insertBefore(topBar, topBarNext);
        }
    }

    function setTocCollapsed(collapsed, remember) {
        document.body.classList.toggle('toc-collapsed', collapsed);
        const btn = document.getElementById('tocSidebarCollapse');
        if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
        const tab = document.getElementById('tocRevealTab');
        if (tab) tab.setAttribute('aria-expanded', String(!collapsed));
        moveTopBar(collapsed);
        // 目录展开回去时，设置那一排本来就全都露着，把「展开」状态清掉，免得下次进来面板卡在打开态
        if (!collapsed && window.__closeReaderFunc) window.__closeReaderFunc();
        if (remember) {
            try { localStorage.setItem(TOC_STORE, collapsed ? '1' : '0'); } catch (e) { }
        }
    }

    function initTocCollapse() {
        const collapseBtn = document.getElementById('tocSidebarCollapse');
        const revealTab = document.getElementById('tocRevealTab');

        topBar = document.getElementById('sidebarTopBar');
        if (topBar) {
            topBarParent = topBar.parentElement;
            topBarNext = topBar.nextElementSibling;
        }

        let saved = false;
        try { saved = localStorage.getItem(TOC_STORE) === '1'; } catch (e) { }
        if (saved) setTocCollapsed(true, false);

        if (collapseBtn) collapseBtn.addEventListener('click', () => setTocCollapsed(true, true));
        if (revealTab) revealTab.addEventListener('click', () => setTocCollapsed(false, true));

        // 跨过 773px 断点：回到宽屏就恢复记住的状态，窄屏一律展开
        const mq = window.matchMedia('(max-width: 773px)');
        const sync = () => {
            if (mq.matches) {
                setTocCollapsed(false, false);
            } else {
                let want = false;
                try { want = localStorage.getItem(TOC_STORE) === '1'; } catch (e) { }
                setTocCollapsed(want, false);
            }
        };
        if (mq.addEventListener) mq.addEventListener('change', sync);
        else if (mq.addListener) mq.addListener(sync);
    }

    window.expandToc = function () {
        if (document.body.classList.contains('toc-collapsed')) setTocCollapsed(false, true);
    };

    /* ===== 阅读工具栏：一个功能按钮收起所有设置（v3.52.1） =====
       点按钮展开，鼠标离开整条工具栏 / 按 Esc / 点外面都收回去。 */
    function initReaderFunc() {
        const bar = document.getElementById('readerToolbar');
        const func = document.getElementById('readerFunc');
        const btn = document.getElementById('readerFuncBtn');
        if (!bar || !func || !btn) return;

        const isOpen = () => func.classList.contains('is-open');
        const setOpen = (open) => {
            func.classList.toggle('is-open', open);
            btn.setAttribute('aria-expanded', String(open));
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(!isOpen());
        });

        // 鼠标移开这条工具栏就收起
        bar.addEventListener('mouseleave', () => { if (isOpen()) setOpen(false); });

        // 触屏 / 键盘：点别处或按 Esc 一样收回去
        document.addEventListener('click', (e) => {
            if (isOpen() && !func.contains(e.target)) setOpen(false);
        });

        window.__closeReaderFunc = () => { if (isOpen()) setOpen(false); };
    }

    function init() {
        // 阅读进度条
        const progress = document.getElementById('articleProgress');
        const updateProgress = () => {
            if (!progress) return;
            const doc = document.documentElement;
            const total = doc.scrollHeight - window.innerHeight;
            progress.style.width = (total > 0 ? (window.scrollY / total * 100) : 0) + '%';
        };
        window.addEventListener('scroll', updateProgress, { passive: true });
        updateProgress();

        // 工具栏
        bind('readerFontUp', () => { settings.font = Math.min(22, settings.font + 1); apply(); save(); });
        bind('readerFontDown', () => { settings.font = Math.max(13, settings.font - 1); apply(); save(); });
        bind('readerLineHeight', () => {
            const levels = [1.6, 1.8, 2.0];
            const cur = levels.indexOf(settings.line);
            settings.line = levels[(cur + 1) % levels.length];
            apply(); save();
        });
        bind('readerFontFamily', () => { settings.fontFamily = settings.fontFamily === 'serif' ? 'sans' : 'serif'; apply(); save(); });
        bind('readerFocus', toggleFocus);

        // 键盘快捷键（避开页面已有的 WASD：w/a/s/d/e/q）
        document.addEventListener('keydown', (e) => {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (e.key === 'Escape' && window.__closeReaderFunc) window.__closeReaderFunc();
            if (e.key === 'Escape' && root.classList.contains('reader-focus')) { toggleFocus(); return; }
            if (e.key === 'j' || e.key === 'J') { const el = document.querySelector('#article-navigation .nav-card.next'); if (el) el.click(); return; }
            if (e.key === 'k' || e.key === 'K') { const el = document.querySelector('#article-navigation .nav-card.prev'); if (el) el.click(); return; }
            if (e.key === 't' || e.key === 'T') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
            if (e.key === 'b' || e.key === 'B') { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); return; }
            if (e.key === '/') {
                const inp = document.getElementById('tocSearchInput');
                if (inp) {
                    e.preventDefault();
                    if (window.expandToc) window.expandToc();
                    inp.focus();
                }
            }
        });

        // 目录折叠：默认始终展开，点击由 ArticleApp 切换（不记忆状态）
        const collapseBtn = document.getElementById('tocCollapseBtn');
        if (collapseBtn) {
            collapseBtn.classList.remove('collapsed');
            document.querySelectorAll('.toc-child-container').forEach(c => c.classList.remove('collapsed'));
            document.querySelectorAll('.toc-parent').forEach(p => p.classList.remove('collapsed'));
        }

        apply();
        syncFocusUi();
        initTocCollapse();
        initReaderFunc();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
