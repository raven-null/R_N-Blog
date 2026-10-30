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
            if (e.key === 'Escape' && root.classList.contains('reader-focus')) { toggleFocus(); return; }
            if (e.key === 'j' || e.key === 'J') { const el = document.querySelector('#article-navigation .nav-card.next'); if (el) el.click(); return; }
            if (e.key === 'k' || e.key === 'K') { const el = document.querySelector('#article-navigation .nav-card.prev'); if (el) el.click(); return; }
            if (e.key === 't' || e.key === 'T') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
            if (e.key === 'b' || e.key === 'B') { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); return; }
            if (e.key === '/') {
                const inp = document.getElementById('tocSearchInput');
                if (inp) { e.preventDefault(); inp.focus(); }
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
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
