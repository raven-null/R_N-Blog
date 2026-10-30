/**
 * 主题管理器
 * ------------------------------------------------------------
 * 一套骨架 × {浅色, 深色} × 强调色 = 十个主题。
 * 主题只负责两件事：换骨架（纸白 / 冷黑）和换强调色（阳光金系）。
 * 尺寸、圆角、阴影层级全部来自 css/tokens.css，不在这里重复。
 */
const ThemeManager = {
    currentTheme: 'paper',

    /* ---------- 两套骨架 ---------- */
    skeletons: {
        light: {
            bg: '#fbf8f1',
            bgSub: '#f6f2e8',
            surface: '#fffefb',
            surface2: '#fbf7ef',
            surface3: '#f3eee1',
            text: '#1c1a16',
            textSec: '#56514a',
            textMuted: '#8a8479',
            border: '#e9e3d5',
            borderStrong: '#d6cebb',
        },
        dark: {
            bg: '#0b0f17',
            bgSub: '#0e131c',
            surface: '#121822',
            surface2: '#18202c',
            surface3: '#1f2836',
            text: '#e8edf5',
            textSec: '#a3aebd',
            textMuted: '#6f7d8f',
            border: '#222b38',
            borderStrong: '#33404f',
        },
    },

    /* ---------- 强调色（阳光系 + 一个冷色备选） ---------- */
    accents: {
        sun: {
            light: { fill: '#f0a20c', hover: '#d98f06', strong: '#a15c00', soft: '#fdf2da' },
            dark: { fill: '#ffc02e', hover: '#ffcf5c', strong: '#ffd166', soft: '#3a2c08' },
            on: '#2a1a02',
        },
        amber: {
            light: { fill: '#f59e0b', hover: '#db8b05', strong: '#a65e00', soft: '#fdf3dc' },
            dark: { fill: '#fbbf24', hover: '#fcd34d', strong: '#fcd34d', soft: '#3b2d06' },
            on: '#2a1a02',
        },
        gold: {
            light: { fill: '#d4af37', hover: '#bd9a2c', strong: '#7d6210', soft: '#faf4dd' },
            dark: { fill: '#e8c65a', hover: '#f0d47c', strong: '#f0d47c', soft: '#332b0d' },
            on: '#241c02',
        },
        ember: {
            light: { fill: '#f97316', hover: '#e0650c', strong: '#9c3d00', soft: '#fdece0' },
            dark: { fill: '#ff8a3d', hover: '#ffa066', strong: '#ffa066', soft: '#3a1c07' },
            on: '#2b1102',
        },
        indigo: {
            light: { fill: '#6366f1', hover: '#4f46e5', strong: '#4338ca', soft: '#ececfd' },
            dark: { fill: '#8b8df5', hover: '#a3a5f8', strong: '#a3a5f8', soft: '#1c1f3d' },
            on: '#ffffff',
        },
    },

    /* ---------- 十个主题：骨架 + 强调色 ---------- */
    themes: {
        paper: { name: '日光', icon: '○', scheme: 'light', accent: 'sun' },
        dawn: { name: '晨光', icon: '◎', scheme: 'light', accent: 'amber' },
        sand: { name: '沙丘', icon: '◍', scheme: 'light', accent: 'gold' },
        sunset: { name: '落日', icon: '◒', scheme: 'light', accent: 'ember' },
        sky: { name: '晴空', icon: '◌', scheme: 'light', accent: 'indigo' },
        night: { name: '夜色', icon: '◐', scheme: 'dark', accent: 'sun' },
        amber: { name: '琥珀', icon: '◉', scheme: 'dark', accent: 'amber' },
        gilt: { name: '镀金', icon: '✦', scheme: 'dark', accent: 'gold' },
        ember: { name: '余烬', icon: '✷', scheme: 'dark', accent: 'ember' },
        midnight: { name: '子夜', icon: '●', scheme: 'dark', accent: 'indigo' },
    },

    /* 老主题名映射到新主题，避免老用户本地存的名字失效 */
    aliases: {
        dark: 'night',
        light: 'paper',
        cyberpunk: 'midnight',
        sepia: 'dawn',
        neon: 'ember',
        nord: 'sky',
        dracula: 'midnight',
        ocean: 'sky',
        forest: 'sand',
        gold: 'gilt',
        terracotta: 'paper',
        violet: 'sky',
        cyan: 'sky',
        green: 'sand',
        orange: 'sunset',
        pink: 'sunset',
    },

    // 把「骨架 + 强调色」算成一组 CSS 变量（新名字 + 老名字桥接）
    buildColors(themeName) {
        const key = this.aliases[themeName] || themeName;
        const theme = this.themes[key];
        if (!theme) return null;
        const sk = this.skeletons[theme.scheme];
        const ac = this.accents[theme.accent];
        const pal = ac[theme.scheme] || ac.light;

        return {
            // 新令牌
            '--bg': sk.bg,
            '--bg-subtle': sk.bgSub,
            '--surface': sk.surface,
            '--surface-2': sk.surface2,
            '--surface-3': sk.surface3,
            '--text': sk.text,
            '--text-secondary': sk.textSec,
            '--text-muted': sk.textMuted,
            '--accent': pal.fill,
            '--accent-hover': pal.hover,
            '--accent-strong': pal.strong,
            '--accent-soft': pal.soft,
            '--text-on-accent': ac.on,
            '--border': sk.border,
            '--border-strong': sk.borderStrong,
            // 老名字（老样式直接用这些）
            '--bg-primary': sk.bg,
            '--bg-secondary': sk.bgSub,
            '--bg-tertiary': sk.surface3,
            '--bg-card': sk.surface,
            '--text-primary': sk.text,
            '--accent-dim': sk.textMuted,
            '--border-light': sk.borderStrong,
        };
    },

    // 初始化：读本地存储，老主题名自动迁移
    mode: 'auto',
    init() {
        try { this.mode = localStorage.getItem('blog-theme-mode') || 'auto'; } catch (_) {}
        this.followPeriod();
        if (!this.bound) {
            this.bound = true;
            document.addEventListener('daylightchange', () => { if (this.mode === 'auto') this.followPeriod(); });
        }
    },
    followPeriod() {
        const period = document.documentElement.dataset.period || 'day';
        const key = this.mode === 'dark' ? 'night' : this.mode === 'light' ? 'paper'
            : ({ dawn: 'dawn', day: 'paper', dusk: 'ember', night: 'midnight' }[period] || 'paper');
        this.setTheme(key, { animate: false, automatic: true });
        document.documentElement.dataset.themeMode = this.mode;
        document.querySelectorAll('[data-theme-mode-select]').forEach(el => { el.value = this.mode; });
    },
    setMode(mode) {
        if (!['auto', 'light', 'dark'].includes(mode)) return;
        this.mode = mode;
        try { localStorage.setItem('blog-theme-mode', mode); } catch (_) {}
        this.followPeriod();
    },

    setTheme(themeName, opts = {}) {
        const key = this.aliases[themeName] || themeName;
        if (!this.themes[key]) return;

        if (!opts.automatic) {
            this.mode = this.themes[key].scheme;
            try { localStorage.setItem('blog-theme-mode', this.mode); } catch (_) {}
        }
        this.currentTheme = key;
        const theme = this.themes[key];
        const colors = this.buildColors(key);

        // 骨架与强调色也写到 html 上，方便 CSS 层（tokens.css / ui.css）判断
        const root = document.documentElement;
        root.setAttribute('data-theme', theme.scheme);
        root.setAttribute('data-accent', theme.accent);

        if (opts.animate !== false && window.BlogAnimations && window.BlogAnimations.ready) {
            window.BlogAnimations.transitionTheme(colors);
        } else {
            this.applyColors(colors);
        }

        if (window.Tone) window.Tone.refresh();

        try { localStorage.setItem('blog-theme', key); } catch (_) {}
        this.updateThemeButtons();
    },

    // 直接应用主题颜色到 CSS 变量
    applyColors(colors) {
        const root = document.documentElement;
        Object.entries(colors).forEach(([property, value]) => {
            root.style.setProperty(property, value);
        });
    },

    // 切换到下一个主题
    nextTheme() {
        this.setMode(({ auto: 'light', light: 'dark', dark: 'auto' })[this.mode] || 'auto');
    },

    // 主题清单（给主题面板用）
    themeList() {
        return Object.entries(this.themes).map(([key, t]) => ({
            key,
            name: t.name,
            icon: t.icon,
            scheme: t.scheme,
            accent: t.accent,
        }));
    },

    getCurrentTheme() {
        return this.themes[this.currentTheme];
    },

    // 更新所有主题切换按钮的显示
    updateThemeButtons() {
        document.querySelectorAll('.theme-toggle').forEach((btn) => {
            const theme = this.getCurrentTheme();
            btn.innerHTML = theme.icon;
            btn.title = theme.name;
        });
        document.querySelectorAll('.home-theme-btn').forEach((btn) => {
            const theme = this.getCurrentTheme();
            btn.innerHTML = `<span class="home-theme-icon">${theme.icon}</span><span class="home-theme-name">${theme.name}</span>`;
            btn.title = `切换主题（当前：${theme.name}）`;
            btn.setAttribute('aria-label', `切换主题，当前 ${theme.name}`);
        });
    },

    // 创建主题切换按钮并添加到页面
    createThemeToggle(container) {
        const toggle = document.createElement('button');
        toggle.className = 'theme-toggle';
        toggle.innerHTML = this.getCurrentTheme().icon;
        toggle.title = this.getCurrentTheme().name;
        toggle.addEventListener('click', () => this.nextTheme());
        (container || document.body).appendChild(toggle);
        return toggle;
    },
};

window.ThemeManager = ThemeManager;

ThemeManager.init();
