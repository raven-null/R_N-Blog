/**
 * 主题管理器
 * 负责主题切换、CSS变量更新和主题持久化
 */
const ThemeManager = {
    // 当前主题标识
    currentTheme: 'dark',

    // 主题配置
    themes: {
        dark: {
            name: 'Dark',
            icon: '◐',
            colors: {
                '--bg-primary': '#0a0a0a',
                '--bg-secondary': '#111111',
                '--bg-tertiary': '#1a1a1a',
                '--bg-card': '#0f0f0f',
                '--text-primary': '#f0f0f0',
                '--text-secondary': '#b0b0b0',
                '--text-muted': '#666666',
                '--accent': '#ffffff',
                '--accent-dim': '#888888',
                '--border': '#222222',
                '--border-light': '#2a2a2a',
                '--shadow': 'rgba(0, 0, 0, 0.5)',
                '--glow': 'rgba(255, 255, 255, 0.05)'
            }
        },
        light: {
            name: 'Light',
            icon: '○',
            colors: {
                '--bg-primary': '#fafafa',
                '--bg-secondary': '#ffffff',
                '--bg-tertiary': '#f0f0f0',
                '--bg-card': '#ffffff',
                '--text-primary': '#111111',
                '--text-secondary': '#555555',
                '--text-muted': '#999999',
                '--accent': '#000000',
                '--accent-dim': '#777777',
                '--border': '#e0e0e0',
                '--border-light': '#d0d0d0',
                '--shadow': 'rgba(0, 0, 0, 0.08)',
                '--glow': 'rgba(0, 0, 0, 0.03)'
            }
        },
        cyberpunk: {
            name: 'Cyberpunk',
            icon: '◈',
            colors: {
                '--bg-primary': '#030712',
                '--bg-secondary': '#0a1128',
                '--bg-tertiary': '#0f172a',
                '--bg-card': '#070e1f',
                '--text-primary': '#e2e8f0',
                '--text-secondary': '#94a3b8',
                '--text-muted': '#6366f1',
                '--accent': '#7C3AED',
                '--accent-dim': '#10B981',
                '--border': '#1e1b4b',
                '--border-light': '#312e81',
                '--shadow': 'rgba(124, 58, 237, 0.2)',
                '--glow': 'rgba(124, 58, 237, 0.1)'
            }
        },
        sepia: {
            name: 'Sepia',
            icon: '◎',
            colors: {
                '--bg-primary': '#f5f0e8',
                '--bg-secondary': '#faf6ee',
                '--bg-tertiary': '#ede6d6',
                '--bg-card': '#faf6ee',
                '--text-primary': '#3d3427',
                '--text-secondary': '#6b5d4f',
                '--text-muted': '#a0917f',
                '--accent': '#b85c38',
                '--accent-dim': '#e07b4f',
                '--border': '#d9cfc0',
                '--border-light': '#c8bba8',
                '--shadow': 'rgba(61, 52, 39, 0.1)',
                '--glow': 'rgba(184, 92, 56, 0.08)'
            }
        },
        neon: {
            name: 'Neon',
            icon: '◆',
            colors: {
                '--bg-primary': '#0d0221',
                '--bg-secondary': '#150538',
                '--bg-tertiary': '#1a0a45',
                '--bg-card': '#120330',
                '--text-primary': '#f0e6ff',
                '--text-secondary': '#c9b8e8',
                '--text-muted': '#7b68a6',
                '--accent': '#ff2d95',
                '--accent-dim': '#00f0ff',
                '--border': '#2d1b69',
                '--border-light': '#3d2580',
                '--shadow': 'rgba(255, 45, 149, 0.15)',
                '--glow': 'rgba(255, 45, 149, 0.1)'
            }
        },
        nord: {
            name: 'Nord',
            icon: '❖',
            colors: {
                '--bg-primary': '#2e3440',
                '--bg-secondary': '#3b4252',
                '--bg-tertiary': '#434c5e',
                '--bg-card': '#353c4a',
                '--text-primary': '#eceff4',
                '--text-secondary': '#d8dee9',
                '--text-muted': '#7b88a1',
                '--accent': '#88c0d0',
                '--accent-dim': '#81a1c1',
                '--border': '#4c566a',
                '--border-light': '#5e6779',
                '--shadow': 'rgba(0, 0, 0, 0.25)',
                '--glow': 'rgba(136, 192, 208, 0.1)'
            }
        },
        dracula: {
            name: 'Dracula',
            icon: '❂',
            colors: {
                '--bg-primary': '#282a36',
                '--bg-secondary': '#343746',
                '--bg-tertiary': '#3e4155',
                '--bg-card': '#303340',
                '--text-primary': '#f8f8f2',
                '--text-secondary': '#cccce0',
                '--text-muted': '#7970a9',
                '--accent': '#bd93f9',
                '--accent-dim': '#ff79c6',
                '--border': '#44475a',
                '--border-light': '#565970',
                '--shadow': 'rgba(0, 0, 0, 0.3)',
                '--glow': 'rgba(189, 147, 249, 0.12)'
            }
        },
        ocean: {
            name: 'Ocean',
            icon: '≋',
            colors: {
                '--bg-primary': '#0a192f',
                '--bg-secondary': '#112240',
                '--bg-tertiary': '#1a3158',
                '--bg-card': '#0d1b33',
                '--text-primary': '#ccd6f6',
                '--text-secondary': '#8892b0',
                '--text-muted': '#5a6a8a',
                '--accent': '#64ffda',
                '--accent-dim': '#57cbff',
                '--border': '#1e3a5f',
                '--border-light': '#2a4a72',
                '--shadow': 'rgba(0, 0, 0, 0.35)',
                '--glow': 'rgba(100, 255, 218, 0.08)'
            }
        },
        forest: {
            name: 'Forest',
            icon: '♧',
            colors: {
                '--bg-primary': '#1a2e1a',
                '--bg-secondary': '#223522',
                '--bg-tertiary': '#2a422a',
                '--bg-card': '#1e321e',
                '--text-primary': '#d4e8d4',
                '--text-secondary': '#a3c4a3',
                '--text-muted': '#6d946d',
                '--accent': '#4ade80',
                '--accent-dim': '#22c55e',
                '--border': '#2d5a2d',
                '--border-light': '#3a6e3a',
                '--shadow': 'rgba(0, 0, 0, 0.3)',
                '--glow': 'rgba(74, 222, 128, 0.1)'
            }
        },
        sunset: {
            name: 'Sunset',
            icon: '☀',
            colors: {
                '--bg-primary': '#1c1017',
                '--bg-secondary': '#2a1520',
                '--bg-tertiary': '#381a2a',
                '--bg-card': '#221218',
                '--text-primary': '#fce4ec',
                '--text-secondary': '#d4a0b0',
                '--text-muted': '#a06878',
                '--accent': '#ff6b9d',
                '--accent-dim': '#ff9f43',
                '--border': '#4a2030',
                '--border-light': '#5e2a40',
                '--shadow': 'rgba(0, 0, 0, 0.3)',
                '--glow': 'rgba(255, 107, 157, 0.12)'
            }
        }
    },

    // 初始化：从本地存储读取主题或使用默认主题
    init() {
        const savedTheme = localStorage.getItem('blog-theme') || 'dark';
        this.setTheme(savedTheme);
    },

    // 设置指定主题并应用CSS变量
    setTheme(themeName) {
        if (!this.themes[themeName]) return;

        this.currentTheme = themeName;
        const theme = this.themes[themeName];

        // 将主题颜色写入CSS变量
        const root = document.documentElement;
        Object.entries(theme.colors).forEach(([property, value]) => {
            root.style.setProperty(property, value);
        });

        // 持久化到本地存储
        localStorage.setItem('blog-theme', themeName);
        this.updateThemeButtons();
    },

    // 切换到下一个主题
    nextTheme() {
        const themeNames = Object.keys(this.themes);
        const currentIndex = themeNames.indexOf(this.currentTheme);
        const nextIndex = (currentIndex + 1) % themeNames.length;
        this.setTheme(themeNames[nextIndex]);
    },

    // 获取当前主题配置
    getCurrentTheme() {
        return this.themes[this.currentTheme];
    },

    // 更新所有主题切换按钮的显示
    updateThemeButtons() {
        document.querySelectorAll('.theme-toggle').forEach(btn => {
            const theme = this.getCurrentTheme();
            btn.innerHTML = theme.icon;
            btn.title = theme.name;
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
    }
};

window.ThemeManager = ThemeManager;
