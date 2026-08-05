/**
 * 阅读体验增强（文章页）
 * 功能：阅读进度条、字号/行距/字体调节、护眼/夜间模式、专注阅读、键盘快捷键、目录折叠记忆
 */
(function () {
    'use strict';

    const STORE = 'reader-settings';
    const TOC_KEY = 'toc-collapsed';

    const MODES = {
        sepia: {
            '--bg-primary': '#f5f0e8', '--bg-secondary': '#faf6ee', '--bg-card': '#faf6ee',
            '--bg-tertiary': '#ede6d6', '--text-primary': '#3d3427', '--text-secondary': '#6b5d4f',
            '--text-muted': '#a0917f', '--accent': '#b85c38', '--accent-dim': '#e07b4f',
            '--border': '#e6dcc8', '--border-light': '#d9ccb4'
        },
        dark: {
            '--bg-primary': '#0d0d0d', '--bg-secondary': '#141414', '--bg-card': '#111111',
            '--bg-tertiary': '#1c1c1c', '--text-primary': '#ececec', '--text-secondary': '#b8b8b8',
            '--text-muted': '#777777', '--accent': '#ffffff', '--accent-dim': '#a0a0a0',
            '--border': '#262626', '--border-light': '#333333'
        }
    };

    const defaults = { font: 16, line: 1.8, fontFamily: 'sans', mode: 'normal' };

    function loadSettings() {
        try {
            return Object.assign({}, defaults, JSON.parse(localStorage.getItem(STORE) || '{}'));
        } catch (e) {
            return Object.assign({}, defaults);
        }
    }

    let settings = loadSettings();
    const root = document.documentElement;
    // 记录本次由阅读模式设置的变量键，仅清理自己设置过的
    let appliedModeKeys = [];

    function save() {
        try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) { }
    }

    function apply() {
        root.style.setProperty('--reader-font-size', settings.font + 'px');
        root.style.setProperty('--reader-line-height', settings.line);
        root.classList.toggle('reader-serif', settings.fontFamily === 'serif');

        // 清理此前由阅读模式覆盖的主题变量（不影响 theme.js 自身设置的变量）
        appliedModeKeys.forEach(k => root.style.removeProperty(k));
        appliedModeKeys = [];
        if (settings.mode !== 'normal') {
            Object.entries(MODES[settings.mode]).forEach(([k, v]) => {
                root.style.setProperty(k, v);
                appliedModeKeys.push(k);
            });
        }
        root.classList.toggle('reader-mode-sepia', settings.mode === 'sepia');
        root.classList.toggle('reader-mode-dark', settings.mode === 'dark');

        const fs = document.getElementById('readerFontSize');
        if (fs) fs.textContent = settings.font;
        const lh = document.getElementById('readerLineHeight');
        if (lh) lh.textContent = '行距 ' + settings.line.toFixed(1);
        const serif = document.getElementById('readerFontFamily');
        if (serif) serif.textContent = settings.fontFamily === 'serif' ? '无衬线' : '衬线';
        const sepia = document.getElementById('readerModeSepia');
        const dark = document.getElementById('readerModeDark');
        if (sepia) sepia.classList.toggle('active', settings.mode === 'sepia');
        if (dark) dark.classList.toggle('active', settings.mode === 'dark');
    }

    function bind(id, fn) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    }

    function toggleFocus() {
        root.classList.toggle('reader-focus');
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
        bind('readerModeSepia', () => { settings.mode = settings.mode === 'sepia' ? 'normal' : 'sepia'; apply(); save(); });
        bind('readerModeDark', () => { settings.mode = settings.mode === 'dark' ? 'normal' : 'dark'; apply(); save(); });
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

        // 目录折叠记忆（仅应用初始状态 + 监听保存；折叠逻辑由 ArticleApp 处理）
        const collapseBtn = document.getElementById('tocCollapseBtn');
        const containers = document.querySelectorAll('.toc-child-container');
        const parentItems = document.querySelectorAll('.toc-parent');
        if (collapseBtn && localStorage.getItem(TOC_KEY) === '1') {
            collapseBtn.classList.add('collapsed');
            containers.forEach(c => c.classList.add('collapsed'));
            parentItems.forEach(p => p.classList.add('collapsed'));
        }
        if (collapseBtn) {
            new MutationObserver(() => {
                localStorage.setItem(TOC_KEY, collapseBtn.classList.contains('collapsed') ? '1' : '0');
            }).observe(collapseBtn, { attributes: true, attributeFilter: ['class'] });
        }

        apply();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
