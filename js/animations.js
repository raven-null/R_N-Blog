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
            this.initCardHover();
        }
    },

    // Hero 标题逐字动画（由 index.html 调用，替代原打字机效果）
    animateHeroTitle(el) {
        if (!this.ready || !el) return;
        const text = el.dataset.text || 'Hello World!';
        el.innerHTML = text.split('').map(c => `<span class="hero-char">${c === ' ' ? '&nbsp;' : c}</span>`).join('');
        anime.animate('.hero-char', {
            opacity: [0, 1],
            scale: [2, 1],
            translateY: [18, 0],
            duration: 600,
            delay: anime.stagger(45, { from: 'center' }),
            ease: 'out(3)'
        });
    },

    // 统计数字动画（由 index.html 调用，替代原 animateCounter）
    animateStats(posts, tags, wordsK) {
        if (!this.ready) return;
        const counter = { value: 0 };
        anime.animate(counter, {
            value: [0, 1],
            duration: 1500,
            ease: 'out(2)',
            onUpdate: () => {
                const v = counter.value;
                document.getElementById('statPosts').textContent = Math.round(posts * v);
                document.getElementById('statTags').textContent = Math.round(tags * v);
                document.getElementById('statWords').textContent = Math.round(wordsK * v) + 'k';
            }
        });
    },

    // 瀑布流卡片错峰入场
    initCardEntrance() {
        document.documentElement.classList.add('anime-ready');

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const card = entry.target;
                anime.animate(card, {
                    opacity: [0, 1],
                    translateY: [40, 0],
                    scale: [0.98, 1],
                    duration: 700,
                    ease: 'out(3)'
                });
                observer.unobserve(card);
            });
        }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

        const observeCards = () => {
            document.querySelectorAll('.card:not([data-anime-entered])').forEach(card => {
                card.dataset.animeEntered = '1';
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

    // 卡片 hover 微交互
    initCardHover() {
        const setup = (card) => {
            if (card.dataset.hoverAnim) return;
            card.dataset.hoverAnim = '1';
            card.addEventListener('mouseenter', () => {
                anime.animate(card, { translateY: [0, -6], scale: [1, 1.02], duration: 300, ease: 'out(3)' });
            });
            card.addEventListener('mouseleave', () => {
                anime.animate(card, { translateY: [-6, 0], scale: [1.02, 1], duration: 300, ease: 'out(3)' });
            });
        };
        document.querySelectorAll('.card').forEach(setup);

        const container = document.getElementById('posts');
        if (container && typeof MutationObserver !== 'undefined') {
            new MutationObserver(() => document.querySelectorAll('.card:not([data-hover-anim])').forEach(setup))
                .observe(container, { childList: true, subtree: true });
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
            Object.entries(colors).forEach(([p, v]) => { params[p] = v; });
            anime.animate(document.documentElement, {
                ...params,
                duration: 400,
                ease: 'out(2)'
            });
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
