/**
 * 全局动画控制器（Anime.js v4）
 * 依赖：js/vendor/anime.umd.min.js（本地加载，UMD 全局对象 anime）
 * 负责首页/文章页/聊天窗口的 Anime.js 动效，未加载或系统减少动效时优雅降级
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
        if (!this.ready) return;
        // 首页：#posts 为静态容器，卡片异步渲染，由 MutationObserver 接管
        if (document.getElementById('posts') || document.querySelector('.card')) {
            this.initCardEntrance();
        }
        if (document.querySelector('.hero')) {
            this.initHeroEntrance();
            this.initCtaHover();
        }
    },

    // Hero 入场时间轴（品牌标签 → 副标题 → SVG 装饰线 → CTA → 滚动指示）
    initHeroEntrance() {
        document.documentElement.classList.add('anime-ready');

        const tag = document.querySelector('.hero-tag');
        const subtitle = document.querySelector('.hero-subtitle');
        const cta = document.querySelector('.hero-cta');
        const indicator = document.querySelector('.scroll-indicator');

        try {
            const timeline = anime.createTimeline({ defaults: { ease: 'out(3)' } });
            if (tag) timeline.add(tag, { opacity: [0, 1], translateY: [14, 0], duration: 500 });
            if (subtitle) timeline.add(subtitle, { opacity: [0, 1], translateY: [10, 0], duration: 500 }, '-=250');

            // SVG 装饰线淡入（不启用描边绘制，避免 drawable 解析问题）
            const underline = document.querySelector('.hero-underline');
            if (underline) timeline.add(underline, { opacity: [0, 1], duration: 400 }, '-=150');

            if (cta) timeline.add(cta, { opacity: [0, 1], scale: [0.92, 1], duration: 450 }, '-=250');
            if (indicator) timeline.add(indicator, { opacity: [0, 1], duration: 600 }, '-=150');
        } catch (e) {
            // 时间轴失败时回退：逐个淡入
            [tag, subtitle, cta, indicator].forEach((el, i) => {
                if (el) anime.animate(el, { opacity: [0, 1], duration: 500, delay: i * 200, ease: 'out(3)' });
            });
        }
    },

    // CTA 按钮弹簧 hover
    initCtaHover() {
        const cta = document.querySelector('.hero-cta');
        if (!cta) return;
        cta.addEventListener('mouseenter', () => {
            try {
                anime.animate(cta, { scale: [1, 1.05], duration: 400, ease: anime.spring({ bounce: 0.6 }) });
            } catch (e) {
                anime.animate(cta, { scale: [1, 1.05], duration: 300, ease: 'out(3)' });
            }
        });
        cta.addEventListener('mouseleave', () => {
            try {
                anime.animate(cta, { scale: [1.05, 1], duration: 400, ease: anime.spring({ bounce: 0.6 }) });
            } catch (e) {
                anime.animate(cta, { scale: [1.05, 1], duration: 300, ease: 'out(3)' });
            }
        });
    },

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
    initCardEntrance() {
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
            const cards = document.querySelectorAll('.card:not([data-anime-entered])');
            if (!cards.length) return;
            batch++;
            const full = batch === 1;
            cards.forEach(card => {
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
