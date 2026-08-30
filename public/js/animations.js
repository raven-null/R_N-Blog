/**
 * 全局动画控制器（Anime.js v4）+ 液态玻璃层（glass.css）
 * 依赖：js/vendor/anime.umd.min.js（本地加载，UMD 全局对象 anime）
 * 负责首页/文章页/聊天窗口的 Anime.js 动效，未加载或系统减少动效时优雅降级
 * 
 * 玻璃层职责（配合 css/glass.css）：
 * - initAurora()   注入环境光斑背景 + 鼠标视差（液态玻璃的"光源"）
 * - initReveal()   滚动入场（blur + slide + spring），动态内容由 MutationObserver 接管
 * - initNavGlass() 导航栏滚动后加深模糊（.scrolled）
 */
const BlogAnimations = {
    // 是否尊重系统"减少动效"设置
    get reducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    },

    // Anime.js 是否就绪
    get ready() {
        return typeof anime !== 'undefined' && !this.reducedMotion;
    },

    // 初始化入口（页面加载后调用）
    init() {
        // 玻璃层总是初始化（reducedMotion 下 CSS 已优雅降级为静态）
        this.initGlass();
        // 非玻璃接管卡片才走 anime 入场（玻璃模式下卡片带 data-reveal，被跳过）
        if (this.ready) {
            this.initCardEntrance();
        }
    },

    /* ==================== 液态玻璃层 ==================== */

    initGlass() {
        const root = document.documentElement;
        root.classList.add('glass-ready');
        this.initAurora();
        if (!this.reducedMotion) {
            this.initReveal();
            this.initNavGlass();
        }
    },

    // 环境光斑：注入 DOM + 鼠标视差（缓动跟随）
    initAurora() {
        if (document.querySelector('.aurora-orb')) return;
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        const orbs = [
            { size: 46, top: -12, left: -8,  color: 'rgba(96, 130, 255, 0.30)' },
            { size: 38, top: 55,  left: 68,  color: 'rgba(190, 90, 255, 0.22)' },
            { size: 42, top: 78,  left: -14, color: 'rgba(0, 210, 190, 0.18)' },
            { size: 30, top: 18,  left: 82,  color: 'rgba(255, 150, 90, 0.16)' }
        ].filter((_, i) => !isMobile || i < 2);

        orbs.forEach((o, i) => {
            const el = document.createElement('div');
            el.className = 'aurora-orb';
            const vh = Math.max(window.innerHeight, 640);
            el.style.width = (o.size / 100 * vh) + 'px';
            el.style.height = el.style.width;
            el.style.top = o.top + 'vh';
            el.style.left = o.left + 'vw';
            el.style.background = 'radial-gradient(circle at 35% 35%, ' + o.color + ', transparent 70%)';
            el.style.animationDuration = [26, 34, 22, 40][i] + 's';
            el.style.animationDelay = [0, -8, -14, -4][i] + 's';
            document.body.appendChild(el);
        });

        // 鼠标视差（桌面端）：光斑随光标轻微漂移，液态感
        if (isMobile || this.reducedMotion) return;
        const items = document.querySelectorAll('.aurora-orb');
        if (!items.length) return;
        let tx = 0, ty = 0, cx = 0, cy = 0, raf = null;

        window.addEventListener('mousemove', (e) => {
            tx = (e.clientX / window.innerWidth - 0.5) * 2;
            ty = (e.clientY / window.innerHeight - 0.5) * 2;
            if (!raf) {
                const tick = () => {
                    cx += (tx - cx) * 0.04;
                    cy += (ty - cy) * 0.04;
                    items.forEach((el, i) => {
                        const depth = (i + 1) * 14;
                        el.style.translate = (cx * depth) + 'px ' + (cy * depth) + 'px';
                    });
                    raf = (Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) ? requestAnimationFrame(tick) : null;
                };
                raf = requestAnimationFrame(tick);
            }
        });
    },

    // 滚动入场：自动标记常见组件 → 进入视口时加 .in-view
    initReveal() {
        const SELECTORS = [
            '.card', '.news-item', '.gallery-item', '.dashboard-card',
            '.dash-panel', '.dash-hero', '.comment-item',
            '.toc-sidebar-inner', '.reader-toolbar', '.article-header', '.article-content',
            '.gallery-tag-item', '.login-box'
        ];
        const DYNAMIC_CONTAINERS = ['#posts', '#galleryGrid', '#newsList', '#dashboardStats',
            '#comment-list', '#article-content', '#tagsDropdownList', '#galleryTagFloatList'];

        const mark = (el) => {
            if (!el.hasAttribute('data-reveal')) el.setAttribute('data-reveal', '');
        };

        // 扫描并标记当前元素
        const scan = () => {
            document.querySelectorAll(SELECTORS.join(',')).forEach(mark);
        };
        scan();

        // 观察动态渲染内容（分页/筛选/文章加载）
        if (typeof MutationObserver !== 'undefined') {
            DYNAMIC_CONTAINERS.forEach(sel => {
                const c = document.querySelector(sel);
                if (c) new MutationObserver(scan).observe(c, { childList: true, subtree: true });
            });
        }

        // 进入视口 → in-view（一次性）
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('in-view');
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

        const observeAll = () => {
            document.querySelectorAll('[data-reveal]:not(.in-view)').forEach(el => observer.observe(el));
        };
        observeAll();

        // 新标记的元素也要被观察
        const observer2 = new MutationObserver(() => {
            scan();
            observeAll();
        });
        if (typeof MutationObserver !== 'undefined') {
            DYNAMIC_CONTAINERS.forEach(sel => {
                const c = document.querySelector(sel);
                if (c) observer2.observe(c, { childList: true, subtree: true });
            });
        }

        // 视图切换（display none → block）时重新检查
        this._revealObserver = observer;
        this._revealObserveAll = observeAll;
    },

    // 视图切换后重新观察（由 app.js 调用）
    reObserveReveals() {
        if (this._revealObserveAll) this._revealObserveAll();
    },

    // 导航栏滚动加深模糊
    initNavGlass() {
        const nav = document.querySelector('.nav-bar');
        if (!nav) return;
        const scroller = document.getElementById('scrollArea') || window;
        const update = () => {
            const top = scroller === window ? window.scrollY : scroller.scrollTop;
            nav.classList.toggle('scrolled', top > 10);
        };
        scroller.addEventListener('scroll', update, { passive: true });
        update();
    },

    /* ==================== 原有 Anime.js 动效 ==================== */

    // 标签面板打开时错峰弹出
    animateTagsPanel() {
        if (!this.ready) return;
        const chips = document.querySelectorAll('.tags-dropdown-list .tag-btn');
        if (!chips.length) return;
        anime.animate(chips, {
            opacity: [0, 1],
            scale: [0.8, 1],
            delay: anime.stagger(25, { from: 'center' }),
            duration: 250,
            ease: 'out(2)'
        });
    },

    // 瀑布流卡片入场（首批完整入场，后续渲染仅快速淡入，避免"刷新"感）
    // 玻璃模式下卡片带 data-reveal，由 CSS 接管入场，这里只处理其余场景
    initCardEntrance() {
        const cards = Array.from(document.querySelectorAll('.card:not([data-reveal]):not([data-anime-entered])'));
        if (!cards.length) return;
        document.documentElement.classList.add('anime-ready');

        let batch = 0;

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const card = entry.target;
                if (card.dataset.fullEnter) {
                    delete card.dataset.fullEnter;
                    anime.animate(card, {
                        opacity: [0, 1],
                        translateY: [40, 0],
                        scale: [0.98, 1],
                        duration: 700,
                        ease: 'out(3)'
                    });
                } else {
                    // 非首次渲染：仅快速淡入
                    anime.animate(card, { opacity: [0, 1], duration: 300, ease: 'out(2)' });
                }
                observer.unobserve(card);
            });
        }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

        const observeCards = () => {
            const found = document.querySelectorAll('.card:not([data-reveal]):not([data-anime-entered])');
            if (!found.length) return;
            batch++;
            const full = batch === 1;
            found.forEach(card => {
                card.dataset.animeEntered = '1';
                if (full) card.dataset.fullEnter = '1';
                observer.observe(card);
            });
        };
        observeCards();

        // 监听动态渲染的卡片（分页/筛选）
        const container = document.getElementById('posts');
        if (container && typeof MutationObserver !== 'undefined') {
            new MutationObserver(observeCards).observe(container, { childList: true, subtree: true });
        }
    },

    // 主题切换过渡（由 theme.js 调用）
    transitionTheme(colors) {
        if (!this.ready) {
            this.applyColors(colors);
            return;
        }
        try {
            const params = {};
            Object.entries(colors).forEach(([p, v]) => {
                // rgba 等非纯色值直接应用，避免动画解析失败
                if (p === '--shadow' || p === '--glow') {
                    document.documentElement.style.setProperty(p, v);
                } else {
                    params[p] = v;
                }
            });
            if (Object.keys(params).length) {
                anime.animate(document.documentElement, {
                    ...params,
                    duration: 400,
                    ease: 'out(2)'
                });
            }
        } catch (e) {
            // 动画失败时直接应用主题色
            this.applyColors(colors);
        }
    },

    // 直接应用主题颜色
    applyColors(colors) {
        const root = document.documentElement;
        Object.entries(colors).forEach(([p, v]) => root.style.setProperty(p, v));
    },

    // 文章内容入场（由 article.html 调用）
    animateArticleContent(container) {
        if (!this.ready || !container) return;
        const children = Array.from(container.children);
        if (!children.length) return;
        anime.animate(children, {
            opacity: [0, 1],
            translateY: [16, 0],
            duration: 500,
            delay: anime.stagger(35),
            ease: 'out(2)'
        });
    },

    // 聊天窗口开关动画开关（由 chat.js 调用）
    isChatAnimeEnabled() {
        return this.ready;
    }
};

window.BlogAnimations = BlogAnimations;

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => BlogAnimations.init());
