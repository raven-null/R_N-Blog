/**
 * 博客首页核心逻辑
 * 负责文章加载、标签筛选、搜索、分页和渲染
 */
const BlogApp = {
    // 配置项
    config: {
        postsDirectory: 'posts',
        // 后端 API 地址（同源）
        apiBase: '',
        // 图库数据源：独立的 r-gallery 站点（博客不再自己存图）
        galleryBase: 'https://r-gallery.netlify.app'
    },

    // 所有文章
    posts: [],
    // 筛选后的文章
    filteredPosts: [],
    // 当前选中的标签
    currentTag: null,
    currentType: null, // 内容形态筛选：null | 'board'（白板）| 'mindmap'（导图）| 'graph'（节点图）| 'article'（文章）
    // 当前视图（主页 / 博客 / 图库 / 每日新闻）
    currentView: 'home',
    // 图库图片清单缓存
    galleryImages: null,

    // 初始化应用
    async init() {
        ThemeManager.init();
        // 浮动主题圆钮已移除：主题切换在主页身份区（#homeThemeBtn）和文章页侧栏
        await this.loadPosts();
        this.renderPostWall();
        this.render();
        // 主页为默认视图时，渲染统计概览与最新文章
        if (this.currentView === 'home') this.renderHome();
        // 顶部筛选导航（全部 / 文章 / 白板…）只在文章视图显示
        const navBar = document.getElementById('navBar');
        if (navBar) navBar.style.display = this.currentView === 'blog' ? '' : 'none';
        this.setupEventListeners();
        this.bindPagePrefetch();
        this.handleRoute();
        this.startAutoRefresh();
        // 任务 + 日记：仅后台登录后显示
        this.initLife();
        // 左列「文章 / 照片」切换
        this.bindStageTabs();
        // 主页盒子的自由交互：堆叠切换 / 缩放 / 交换
        // Editorial home uses normal flow instead of stacked card gestures.
        // 赛博猫娘对话
        // 首页手写开关（时钟旁第二个小圆钮）
        document.getElementById('hvHandBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.applyHandBody(!document.documentElement.classList.contains('hand-body'));
        });

        // 首页背景切换（手写体左边那颗）：默认天空插画 → 图库图池里的横图，轮着换
        document.getElementById('hvBgBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.cycleHeroBg();
        });
        this.restoreHeroBg();

        // 首页主题切换（时钟旁的小圆钮）：只切「日间 / 夜间」两档。
        // 原来走 nextTheme() 是 auto → light → dark，白天在 auto 下按一次等于没变，要按两次才黑
        document.getElementById('hvThemeBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!window.ThemeManager) return;
            const mode = ThemeManager.mode;
            const scheme = mode === 'dark' ? 'dark'
                : mode === 'light' ? 'light'
                    : (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
            ThemeManager.setMode(scheme === 'dark' ? 'light' : 'dark');
            this.syncHvThemeIcon();
        });
        this.syncHvThemeIcon();

        // 灵动岛开关（时间下面那排按钮里的第三个）
        this.bindIslandToggle();
        // 时间 / 按钮 上下翻：滚轮切换，移开自动回到时间
        this.bindClockFlip();


        // 正文手写开关（记忆在 localStorage）
        this.applyHandBody();

        this.initDeskPet();
        // 桌宠心智：看页面 / 主动说话 / 接 AI / 语音
        if (window.PetMind) {
            window.PetMind.start();
        }

        // 身份区时钟（每分钟刷新一次显示）
        this.renderHvClock();
        clearInterval(this.hvClockTimer);
        this.hvClockTimer = setInterval(() => { if (!document.hidden) this.renderHvClock(); }, 60000);
        this.initHomeCanvas();
        // 后台退出登录联动：admin_key / gallery_key 被清除时，前台图库 R18 恢复锁定
        window.addEventListener('storage', (e) => {
            if ((e.key === 'admin_key' || e.key === 'gallery_key') && !e.newValue) {
                if (this.galleryImages) {
                    this.galleryImages = null;
                    const grid = document.getElementById('galleryGrid');
                    if (grid) grid.dataset.rendered = '';
                    this.renderGallery();
                }
            }
        });
    },

    // 加载所有文章（仅从 Blobs 后台加载）
    // force=true 时跳过 sessionStorage 缓存，强制从服务器重新拉取
    async loadPosts(force = false) {
        try {
            const CACHE_KEY = 'blog-posts-data-v16';
            const CACHE_TTL = 15 * 1000; // 缓存有效期 15 秒（缩短，保证改动后尽快可见）
            const cachedRaw = sessionStorage.getItem(CACHE_KEY);
            if (!force && cachedRaw) {
                try {
                    const cached = JSON.parse(cachedRaw);
                    // 检查缓存是否过期（存有时间戳）
                    if (cached.t && Date.now() - cached.t < CACHE_TTL && Array.isArray(cached.posts)) {
                        this.posts = cached.posts;
                        this.filteredPosts = [...this.posts];
                        return;
                    }
                } catch (e) { /* 解析失败则重新加载 */ }
            }

            // 清除旧版本缓存
            sessionStorage.removeItem('blog-posts-data-v11');
            sessionStorage.removeItem('blog-posts-data-v12');
            sessionStorage.removeItem('blog-posts-data-v13');
            sessionStorage.removeItem('blog-posts-data-v14');
            sessionStorage.removeItem('blog-posts-data-v15');

            this.posts = [];

            // 仅从 Blobs 加载文章
            const blobResults = await this.loadBlobPosts();
            this.posts = blobResults.filter(p => p !== null);

            // 按日期降序排序
            this.posts.sort((a, b) => new Date(b.date) - new Date(a.date));
            this.filteredPosts = [...this.posts];

            // 缓存结果（含时间戳）
            try {
                const cacheData = {
                    t: Date.now(),
                    posts: this.posts.map(p => ({
                        id: p.id,
                        filename: p.filename,
                        title: p.title,
                        date: p.date,
                        tags: p.tags,
                        author: p.author,
                        excerpt: p.excerpt,
                        image: p.image,
                        wordCount: p.wordCount || 0,
                        type: p.type || 'article',
                        content: p.content || '',
                    }))
                };
                sessionStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));
            } catch (e) {
                /* 静默：属于正常回退路径，不刷控制台 */
            }
        } catch (error) {
            console.error('加载文章失败:', error);
        }
    },

    // 加载 Blobs 后台文章
    async loadBlobPosts() {
        try {
            const res = await fetch('/api/admin?action=articles', { cache: 'no-store' });
            const data = await res.json();
            if (data.status !== 'success' || !Array.isArray(data.data)) return [];
            return data.data
                .filter(a => a.status === 'published')
                .map(a => ({
                    id: a.id,
                    filename: a.filename || `${a.id}.md`,
                    title: a.title,
                    date: a.date,
                    tags: a.tags || [],
                    author: a.author || '博主',
                    excerpt: a.excerpt || '',
                    image: a.image || this.getRandomBgImage(a.id),
                    wordCount: a.wordCount || 0,
                    type: a.type || 'article',
                    content: '', // 列表不加载正文
                }));
        } catch { return []; }
    },

    // ===== 文章实时刷新机制 =====
    // 服务器索引指纹（null = 尚未初始化）
    _lastFingerprint: null,
    _pollTimer: null,
    _bc: null,
    // 连续失败计数与冷却时间：接口不稳时不再死缠，避免控制台反复报网络错误
    _failCount: 0,
    _cooldownUntil: 0,

    // 生成文章索引指纹（id + 日期 + 标题，任一变化即视为改动）
    _articlesFingerprint(index) {
        return index
            .filter(a => a.status === 'published')
            .map(a => `${a.id}|${a.date}|${a.update || ''}|${a.title}`)
            .join('§');
    },

    // 静默检查：与服务器索引比对，有变化才重新加载并渲染
    async refreshIfChanged() {
        // 失败后按次数退避（30s → 60s → 120s，最长 5 分钟），避免频繁报错
        if (Date.now() < this._cooldownUntil) return;
        try {
            const res = await fetch('/api/admin?action=articles', { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (data.status !== 'success' || !Array.isArray(data.data)) return;
            this._failCount = 0;
            this._cooldownUntil = 0;
            const fp = this._articlesFingerprint(data.data);
            // 首次调用只记录指纹，不做无谓刷新
            if (this._lastFingerprint === null) {
                this._lastFingerprint = fp;
                return;
            }
            if (fp !== this._lastFingerprint) {
                this._lastFingerprint = fp;
                await this.loadPosts(true);
                this.render();
            }
        } catch (e) {
            // 静默失败：累计次数并进入冷却，下次轮询再试
            this._failCount = (this._failCount || 0) + 1;
            const backoff = Math.min(30000 * Math.pow(2, this._failCount - 1), 300000);
            this._cooldownUntil = Date.now() + backoff;
        }
    },

    // 启动实时刷新：30 秒轮询 + 标签页可见时立即检查 + 后台广播即时通知
    startAutoRefresh() {
        // 轮询（页面可见时生效，避免后台标签页空转）
        this._pollTimer = setInterval(() => {
            if (document.visibilityState === 'visible') this.refreshIfChanged();
        }, 30 * 1000);

        // 从其他标签页切回首页时立即检查
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.refreshIfChanged();
        });

        // 同浏览器后台修改后即时广播通知（后台 admin.html 保存/删除后触发）
        if (typeof BroadcastChannel !== 'undefined') {
            this._bc = new BroadcastChannel('blog-articles');
            this._bc.onmessage = (e) => {
                if (e.data && e.data.type === 'articles-changed') {
                    this.refreshIfChanged();
                }
            };
        }
    },

    // 默认封面图片（用于无图文章的默认封面）
    bgImages: [
        'images/Default/web-logo.webp', 'images/Default/web-logo.webp', 'images/Default/web-logo.webp',
        'images/Default/web-logo.webp', 'images/Default/web-logo.webp', 'images/Default/web-logo.webp',
        'images/Default/web-logo.webp', 'images/Default/web-logo.webp', 'images/Default/web-logo.webp',
        'images/Default/web-logo.webp', 'images/Default/web-logo.webp', 'images/Default/web-logo.webp',
        'images/Default/web-logo.webp', 'images/Default/web-logo.webp', 'images/Default/web-logo.webp',
        'images/Default/web-logo.webp', 'images/Default/web-logo.webp', 'images/Default/web-logo.webp',
        'images/Default/web-logo.webp', 'images/Default/web-logo.webp', 'images/Default/web-logo.webp',
        'images/Default/web-logo.webp', 'images/Default/web-logo.webp', 'images/Default/web-logo.webp',
        'images/Default/web-logo.webp', 'images/Default/web-logo.webp', 'images/Default/web-logo.webp',
        'images/Default/web-logo.webp'
    ],

    // 根据文件名生成固定随机索引
    getRandomBgImage(filename) {
        let hash = 0;
        for (let i = 0; i < filename.length; i++) {
            hash = ((hash << 5) - hash) + filename.charCodeAt(i);
            hash = hash & hash;
        }
        const index = Math.abs(hash) % this.bgImages.length;
        return this.bgImages[index];
    },

    // 渲染页面（文章）
    render() {
        this.renderPosts();
    },

    // 渲染文章瀑布流（一次性渲染全部）
    renderPosts() {
        const postsContainer = document.getElementById('posts');
        if (!postsContainer) return;

        if (this.filteredPosts.length === 0) {
            postsContainer.innerHTML = `
                <div style="text-align:center;padding:80px 20px;color:var(--text-muted);">
                    <div style="font-size:48px;margin-bottom:16px;opacity:0.3;">∅</div>
                    <p>暂无文章</p>
                </div>
            `;
            this.renderBlogBar();
            return;
        }

        const postsHTML = this.filteredPosts.map(post => this.renderPostCard(post)).join('');
        postsContainer.innerHTML = `<div class="waterfall">${postsHTML}</div>`;
        this.renderBlogBar();
        if (typeof this.renderPostWall === 'function') this.renderPostWall();
        if (typeof this.renderHvPosts === 'function') this.renderHvPosts();
    },

    // 文章页顶部条：篇数 + 热门标签快捷筛选 + 搜索（把原来那块空白用起来）
    renderBlogBar() {
        const countEl = document.getElementById('blogBarCount');
        if (countEl) countEl.textContent = `${this.filteredPosts.length} 篇`;

        const tagsWrap = document.getElementById('blogBarTags');
        if (tagsWrap) {
            const counts = new Map();
            (this.posts || []).forEach(p => (p.tags || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
            const topTags = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
            // 只露 3 个热门标签，其余收进「更多 ▾」；当前选中的标签一定要露出来
            const shown = topTags.slice(0, 3);
            if (this.currentTag && !shown.includes(this.currentTag)) shown.push(this.currentTag);
            const chip = (tag, label, on) =>
                `<button class="blog-tag${on ? ' is-on' : ''}" type="button" data-blog-tag="${this.escAttr(tag)}">${this.esc(label)}</button>`;
            tagsWrap.innerHTML = chip('', '全部', !this.currentTag)
                + shown.map(t => chip(t, t, this.currentTag === t)).join('');
            if (!tagsWrap.dataset.bound) {
                tagsWrap.dataset.bound = '1';
                tagsWrap.addEventListener('click', (e) => {
                    const btn = e.target.closest('[data-blog-tag]');
                    if (!btn) return;
                    this.filterByTag(btn.dataset.blogTag || null);
                });
            }
        }

        const input = document.getElementById('blogBarSearch');
        if (input && !input.dataset.bound) {
            input.dataset.bound = '1';
            input.addEventListener('input', () => this.searchPosts(input.value));
        }

        const moreBtn = document.getElementById('blogMoreBtn');
        if (moreBtn && !moreBtn.dataset.bound) {
            moreBtn.dataset.bound = '1';
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleBlogTagPanel();
            });
        }

        // 点「更多」外面自动收起（只绑一次）
        if (!document.body.dataset.tagsOutsideBound) {
            document.body.dataset.tagsOutsideBound = '1';
            document.addEventListener('click', (e) => {
                const panel = document.getElementById('blogTagPanel');
                if (!panel || panel.hidden) return;
                if (e.target.closest('#blogTagPanel') || e.target.closest('#blogMoreBtn')) return;
                this.toggleBlogTagPanel(false);
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') this.toggleBlogTagPanel(false);
            });
        }
    },

    // 文章页「更多 ▾」：展开 / 收起全部标签面板
    toggleBlogTagPanel(force) {
        const panel = document.getElementById('blogTagPanel');
        const btn = document.getElementById('blogMoreBtn');
        if (!panel) return;
        const open = force === undefined ? panel.hidden : !!force;
        panel.hidden = !open;
        if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) this.renderBlogTagPanel();
    },

    // 全部标签（带文章数），点一个就筛选并收起面板
    renderBlogTagPanel() {
        const list = document.getElementById('blogTagPanelList');
        if (!list) return;
        const counts = new Map();
        (this.posts || []).forEach(p => (p.tags || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
        const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const chip = (tag, label, extra, on) =>
            `<button class="blog-tag${on ? ' is-on' : ''}" type="button" data-blog-tag="${this.escAttr(tag)}">${this.esc(label)}${extra ? `<span class="blog-tag-count">${extra}</span>` : ''}</button>`;
        list.innerHTML = chip('', '全部', '', !this.currentTag)
            + tags.map(([t, c]) => chip(t, t, c, this.currentTag === t)).join('');
        if (!list.dataset.bound) {
            list.dataset.bound = '1';
            list.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-blog-tag]');
                if (!btn) return;
                this.toggleBlogTagPanel(false);
                this.filterByTag(btn.dataset.blogTag || null);
            });
        }
    },

    // 作者头像：卡片上的名字一律显示站长名（见 getAuthorName），头像也就跟着用站长的，
    // 否则会出现「名字是站长、头像却是默认」的错位（新发的书作者写的是原作者名，就中招了）
    getAuthorAvatar(author) {
        const name = (author || '').trim();
        const settings = this.getBlogSettings();
        const avatar = settings ? settings.avatar : '';
        if (name === 'AI') return avatar || 'images/Default/profile -picture.webp';
        return avatar || 'images/Default/profile -picture.webp';
    },

    // 根据作者名字返回显示名（卡片用户名始终跟随设置中的用户名）
    getAuthorName(author) {
        const name = (author || '').trim();
        const settings = this.getBlogSettings();
        const authorName = settings ? settings.authorName : '';
        // AI 作者保持显示 AI
        if (name === 'AI') return 'AI';
        // 其他作者一律显示设置中的用户名
        return authorName || name || '博主';
    },

    // 渲染单个文章卡片
    renderPostCard(post) {
        const gradientColors = this.getGradientColors(post.tags || []);
        const dateFormatted = this.formatDate(post.date);
        const avatarImg = this.getAuthorAvatar(post.author);
        const authorName = this.getAuthorName(post.author);

        // 卡片右下角形态文字：白板「交互白板」、导图「思维导图」、节点图「节点图」、其余「博客文章」
        const readingLabel = post.type === 'whiteboard' ? '交互白板'
            : post.type === 'mindmap' ? '思维导图'
            : post.type === 'graph' ? '节点图'
            : '博客文章';

        return `
            <div class="card" data-href="article.html?post=${this.escAttr(post.filename)}&blob=${this.escAttr(post.id || '')}" onclick="BlogApp.openPost('${this.escAttr(post.filename)}', '${this.escAttr(post.id || '')}')">
                ${post.image ? `
                    <div class="card-img" style="height: ${this.getCardHeight(post)}px;">
                        <img src="${this.escAttr(post.image)}" alt="${this.esc(post.title)}" class="img-placeholder" decoding="async"
                             referrerpolicy="no-referrer"
                             data-g1="${gradientColors[0]}" data-g2="${gradientColors[1]}" data-icon="${this.getCardIcon(post.tags || [])}"
                             onload="BlogApp.handleCoverLoad(this)"
                             onerror="BlogApp.handleCoverError(this)">
                    </div>
                ` : `
                    <div class="card-img" style="height: ${this.getCardHeight(post)}px; background: linear-gradient(145deg, ${gradientColors[0]}, ${gradientColors[1]});">
                        <div class="big-text">${this.getCardIcon(post.tags || [])}</div>
                    </div>
                `}
                <div class="card-body">
                    <div class="card-author">
                        <div class="card-avatar" style="background-image:url('${avatarImg}');"></div>
                        <span class="card-username">${authorName}</span>
                    </div>
                    <div class="card-tag">${(post.tags || []).map(tag => `<span>${tag}</span>`).join(' ')}</div>
                    <div class="card-title">${post.title}</div>
                    ${(post.excerpt && post.type !== 'whiteboard') ? `<div class="card-desc">${post.excerpt}</div>` : ''}
                    <div class="card-meta">
                        <span class="card-date">${dateFormatted}</span>
                        <span class="card-reading">${readingLabel}</span>
                    </div>
                </div>
            </div>
        `;
    },

    // 白板文章卡片：网格底 / 封面图 + 交互白板标识（点击进入整页白板）
    renderBoardCard(post) {
        const dateFormatted = this.formatDate(post.date);
        const avatarImg = this.getAuthorAvatar(post.author);
        const authorName = this.getAuthorName(post.author);
        const tags = (post.tags || []).map(tag => `<span>${this.esc(tag)}</span>`).join(' ');
        const cover = post.image
            ? `<div class="board-cover has-img">
                    <img src="${this.escAttr(post.image)}" alt="${this.esc(post.title)}" decoding="async" referrerpolicy="no-referrer" onerror="BlogApp.handleCoverError(this)">
                    <span class="board-chip">交互白板</span>
               </div>`
            : `<div class="board-cover">
                    <svg class="board-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 12h10M12 7v10"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/></svg>
                    <span class="board-chip">交互白板</span>
               </div>`;
        return `
            <div class="card card-board" data-href="article.html?post=${this.escAttr(post.filename)}&blob=${this.escAttr(post.id || '')}" onclick="BlogApp.openPost('${this.escAttr(post.filename)}', '${this.escAttr(post.id || '')}')">
                ${cover}
                <div class="card-body">
                    <div class="card-author">
                        <div class="card-avatar" style="background-image:url('${avatarImg}');"></div>
                        <span class="card-username">${authorName}</span>
                    </div>
                    <div class="card-tag">${tags}</div>
                    <div class="card-title">${post.title}</div>
                    <div class="card-meta">
                        <span class="card-date">${dateFormatted}</span>
                        <span class="card-reading">可交互</span>
                    </div>
                </div>
            </div>`;
    },

    // hover 预取：鼠标悬停文章/白板卡片时后台预取目标页，点击后几乎瞬时打开（不阻塞主线程）
    bindPagePrefetch() {
        if (this._pfBound) return;
        this._pfBound = true;
        document.addEventListener('mouseover', (e) => {
            const card = e.target && e.target.closest ? e.target.closest('.card[data-href]') : null;
            if (!card || card.dataset.pf) return;
            card.dataset.pf = '1';
            try {
                const l = document.createElement('link');
                l.rel = 'prefetch';
                l.href = card.dataset.href;
                document.head.appendChild(l);
            } catch (err) { /* ignore */ }
        }, { passive: true });
    },

    // 按标签筛选文章（tag 传 null 即「全部」：标签与形态一起清空）
    filterByTag(tag) {
        this.currentTag = tag || null;
        this.currentType = null; // 走标签入口（含「全部」）一律清掉形态筛选，否则「全部」看不出效果
        this.applyFilter();
    },

    // 按内容形态筛选（白板 / 导图 / 节点图 / 文章）
    filterByType(type) {
        this.currentType = type || null;
        if (!this.currentType) this.currentTag = null; // 形态传 null 时同样回到全部
        else this.currentTag = null;
        this.applyFilter();
    },

    // 统一应用筛选条件并重绘
    applyFilter() {
        let list = [...this.posts];
        if (this.currentType === 'board') list = list.filter(post => post.type === 'whiteboard');
        // 普通文章：既非白板也非画布类（后端 type 缺省即 article，这里一并兼容）
        else if (this.currentType === 'mindmap') list = list.filter(post => post.type === 'mindmap');
        else if (this.currentType === 'graph') list = list.filter(post => post.type === 'graph');
        else if (this.currentType === 'article') list = list.filter(post => post.type !== 'whiteboard' && post.type !== 'mindmap' && post.type !== 'graph');
        if (this.currentTag) list = list.filter(post => (post.tags || []).includes(this.currentTag));

        this.filteredPosts = list;
        this.renderPosts();
        this.updateNavActive();
        this.updateURL();
        this.closeTagsPanel();
    },

    // 更新导航栏链接的激活状态（形态 / 标签 / 全部）
    updateNavActive() {
        const type = this.currentType;
        const tag = this.currentTag;
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
            const onclick = link.getAttribute('onclick') || '';
            if (type && onclick.includes(`filterByType('${type}')`)) { link.classList.add('active'); return; }
            if (!type && tag && onclick.includes(`'${tag}'`)) { link.classList.add('active'); return; }
            if (!type && !tag && (onclick.includes('filterByTag(null)') || onclick.includes('filterByType(null)'))) {
                link.classList.add('active');
            }
        });
    },

    // 打开文章：在首页里盖一层 iframe 加载 article.html。
    // 这样主文档（和里面的音乐播放器 iframe）不会因为跳页被销毁，翻文章时歌不会停。
    openPost(filename, id) {
        const url = id
            ? `article.html?post=${encodeURIComponent(filename)}&blob=${encodeURIComponent(id)}`
            : `article.html?post=${encodeURIComponent(filename)}`;
        const overlay = document.getElementById('articleOverlay');
        const frame = document.getElementById('articleFrame');
        // 没有覆盖层（老页面 / 被别的页面复用）就退回原来的整页跳转
        if (!overlay || !frame) {
            window.location.href = url;
            return;
        }

        // 记下主页滚到哪儿了，关掉时滚回原处
        const scroller = document.getElementById('scrollArea');
        this._articleScrollTop = scroller ? scroller.scrollTop : window.scrollY;

        frame.src = url;
        overlay.hidden = false;
        requestAnimationFrame(() => overlay.classList.add('is-open'));
        document.body.classList.add('article-open');
        this.articleOverlayOpen = true;

        // 入栈一条历史：浏览器返回键也能关掉这一层
        try { history.pushState({ articleOverlay: true }, '', location.href); } catch (e) { /* 忽略 */ }
        this._articlePushedHistory = true;

        this.bindArticleOverlay();
    },

    // 关掉文章覆盖层（按钮 / Esc / 浏览器返回 / article.html 里点的返回）
    closeArticle(fromHistory) {
        const overlay = document.getElementById('articleOverlay');
        const frame = document.getElementById('articleFrame');
        if (!overlay || !this.articleOverlayOpen) return;
        this.articleOverlayOpen = false;

        overlay.classList.remove('is-open');
        document.body.classList.remove('article-open');
        const restore = () => {
            overlay.hidden = true;
            if (frame) frame.src = 'about:blank';
            const scroller = document.getElementById('scrollArea');
            if (scroller && typeof this._articleScrollTop === 'number') scroller.scrollTop = this._articleScrollTop;
        };
        setTimeout(restore, 260);

        if (!fromHistory && this._articlePushedHistory) {
            this._articlePushedHistory = false;
            try { history.back(); } catch (e) { /* 忽略 */ }
        }
    },

    // 只绑一次：返回按钮 / Esc / 浏览器返回 / 文章页发来的关闭消息
    bindArticleOverlay() {
        if (this._articleOverlayBound) return;
        this._articleOverlayBound = true;

        const backBtn = document.getElementById('articleOverlayBack');
        if (backBtn) backBtn.addEventListener('click', () => this.closeArticle());

        document.addEventListener('keydown', (e) => {
            if (!this.articleOverlayOpen) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                this.closeArticle();
            }
        });

        window.addEventListener('popstate', () => {
            if (!this.articleOverlayOpen) return;
            this._articlePushedHistory = false;
            this.closeArticle(true);
        });

        // article.html 被嵌在这一层里时，它自己的返回按钮会发这条消息过来
        window.addEventListener('message', (e) => {
            if (e.origin !== location.origin) return;
            if (e.data && e.data.type === 'blog:close-article') this.closeArticle();
        });
    },

    // 切换搜索框显示（打开时自动关闭标签面板，避免重叠）
    toggleSearch() {
        const dropdown = document.getElementById('searchDropdown');
        if (!dropdown) return;
        const willShow = !dropdown.classList.contains('show');
        if (willShow) this.closeTagsPanel();
        dropdown.classList.toggle('show', willShow);
        if (willShow) {
            setTimeout(() => document.getElementById('searchInput').focus({ preventScroll: true }), 100);
        } else {
            // 关闭时仅当有搜索内容才清空并重置渲染（避免空搜索重绘导致瀑布流位移）
            const input = document.getElementById('searchInput');
            if (input && input.value) {
                input.value = '';
                this.searchPosts('');
            }
        }
    },

    // 切换标签面板（打开时自动关闭搜索框，避免重叠）
    toggleTagsPanel() {
        const panel = document.getElementById('tagsDropdown');
        if (!panel) return;
        const willShow = !panel.classList.contains('show');
        if (willShow) {
            this.closeSearch();
            this.renderTagsPanel();
        }
        panel.classList.toggle('show', willShow);
    },

    // 渲染标签面板（全部标签 + 文章数）
    renderTagsPanel() {
        const list = document.getElementById('tagsDropdownList');
        if (!list) return;
        const counts = {};
        this.posts.forEach(p => (p.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
        const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        list.innerHTML = tags.map(tag => `
            <button class="tag-btn ${this.currentTag === tag ? 'active' : ''}"
                    onclick="BlogApp.filterByTag('${tag}');">
                ${tag}<span class="tag-count">${counts[tag]}</span>
            </button>
        `).join('');

        // 标签面板错峰弹出（Anime.js 就绪时）
        if (window.BlogAnimations && window.BlogAnimations.ready) {
            window.BlogAnimations.animateTagsPanel();
        }
    },

    // 关闭标签面板
    closeTagsPanel() {
        const panel = document.getElementById('tagsDropdown');
        if (panel) panel.classList.remove('show');
    },

    // 关闭搜索框（仅在已打开时生效，避免重复渲染触发入场动画）
    closeSearch() {
        const dropdown = document.getElementById('searchDropdown');
        if (!dropdown || !dropdown.classList.contains('show')) return;
        dropdown.classList.remove('show');
        const input = document.getElementById('searchInput');
        if (input && input.value) {
            input.value = '';
            this.searchPosts('');
        }
    },

    // 关闭所有面板（搜索框 + 标签面板）
    closePanels() {
        this.closeTagsPanel();
        this.closeSearch();
    },

    // 切换视图（主页 / 博客 / 图库 / 项目 / 音乐）
    switchView(view) {
        const valid = ['home', 'blog', 'gallery', 'projects', 'music'];
        if (!valid.includes(view) || this.currentView === view) return;

        // 检查该视图是否被设置禁用
        const settings = this.getBlogSettings();
        const views = (settings && settings.views) || {};
        if (views[view] === false) {
            // 如果禁用，跳转到第一个可见视图
            const visible = valid.find(v => views[v] !== false);
            if (visible && visible !== view) return this.switchView(visible);
            return;
        }

        this.currentView = view;

        // 按钮激活态
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
        // 移动端导航面板里的同名项也跟着高亮
        this.syncWheelActive?.();

        // 滑块指示器动画
        this.moveIndicator(view);

        // 标签导航仅博客视图展示
        const navBar = document.getElementById('navBar');
        if (navBar) navBar.style.display = view === 'blog' ? '' : 'none';

        // 图库分类按钮仅在图库视图显示
        document.body.classList.toggle('view-gallery-active', view === 'gallery');
        // 文章页铺满左右：首页那条 1200px 限宽（renewal.css）只该管首页
        document.body.classList.toggle('view-blog-active', view === 'blog');
        // 音乐视图：铺满滚动区、不要 main-content 的限宽与内边距（见 css/music.css）
        document.body.classList.toggle('view-music-active', view === 'music');
        // 项目页铺宽一点：一行能放下 4 张卡（见 css/style.css）
        document.body.classList.toggle('view-projects-active', view === 'projects');
        // 音乐视图里顶栏浮在播放器上（position: fixed + pointer-events: none），
        // 展开/收起由 js/music-view.js 按鼠标位置驱动；切到别的视图时把残留的展开态收掉
        const topBarPill = document.getElementById('topBarPill');
        if (topBarPill && view !== 'music') topBarPill.classList.remove('is-open');
        // 切换视图时隐藏分类面板
        const tagPanel = document.getElementById('galleryTagFloatPanel');
        if (tagPanel) tagPanel.classList.remove('show');

        // 视图显隐
        document.querySelectorAll('.view').forEach(v => {
            v.style.display = v.id === 'view-' + view ? '' : 'none';
        });

        // 首次进入渲染内容
        if (view === 'home') this.renderHome();
        if (view === 'gallery') {
            // 画布墙走 app.js 这一套 —— 它是参考项目 private-gallery 的完整移植：
            // 整块布局 + 无限平铺 + 视口虚拟化，单击就地放大成 2×2、周围的照片整片顺移挤开。
            // js/gallery-wall.js 是早期简化版（格子取模、点击只给自己加个类、邻居不动），
            // 属于「没抄全」，所以不再优先接管。
            this.initGalleryWall();
        }
        if (view === 'projects') this.renderProjects();
        // 音乐视图：iframe 的预加载/遮罩/降级由 js/music-view.js 管，切进来时让它重新对齐高度
        if (view === 'music' && window.MusicView) window.MusicView.onShow();

        // 入场动画
        const activeView = document.getElementById('view-' + view);
        if (activeView && typeof anime !== 'undefined') {
            anime.animate(activeView, { opacity: [0, 1], duration: 350, ease: 'out(2)' });
        }

        window.scrollTo(0, 0);
        const scroller = document.getElementById('scrollArea');
        if (scroller) scroller.scrollTop = 0;
    },

    // 滑块指示器移动到指定视图按钮（Anime.js 动画）
    moveIndicator(view) {
        const indicator = document.getElementById('viewIndicator');
        const btn = document.querySelector('.view-btn[data-view="' + view + '"]');
        if (!indicator || !btn) return;
        const wrap = indicator.parentElement;
        const wrapRect = wrap.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        const left = btnRect.left - wrapRect.left;
        const width = btnRect.width;

        if (typeof anime !== 'undefined') {
            anime.animate(indicator, {
                left: [parseFloat(indicator.style.left) || left, left],
                width: [parseFloat(indicator.style.width) || width, width],
                duration: 350,
                ease: 'out(3)'
            });
        } else {
            indicator.style.left = left + 'px';
            indicator.style.width = width + 'px';
        }
    },

    // 渲染图库（从 r-gallery 拉取图片，瀑布流布局）
    async renderGallery() {
        const grid = document.getElementById('galleryGrid');
        if (!grid || grid.dataset.rendered) return;
        grid.dataset.rendered = '1';
        try {
            const images = await this.loadGalleryImages();
            // 「全部」视图：按 renderGalleryByTag 过滤（不显示 R18）
            this.galleryTag = 'all';
            this.renderGalleryByTag();
            // 加载图库分类标签（从完整数据提取，管理员可见 R18 分类）
            this.renderGalleryTags();
        } catch (e) {
            grid.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">图库加载失败</p>';
        }
    },

    // 图片 URL 归一化：旧的动态接口 URL → 新的缓存友好 URL（.webp 结尾，CDN 可缓存）
    normalizeImageUrl(u) {
        if (!u) return u;
        if (u.startsWith('/api/admin-image?key=')) {
            // 兼容旧格式（含 &thumb=1）
            const isThumb = u.includes('&thumb=1');
            const key = u.slice('/api/admin-image?key='.length).split('&')[0];
            return (isThumb ? '/images/t/' : '/images/g/') + key;
        }
        if (u.startsWith('/images/g-thumb/')) {
            // 旧缩略图路径 → 新高清缩略图路径
            return '/images/t/' + u.slice('/images/g-thumb/'.length);
        }
        if (u.startsWith('/api/article-image?key=')) {
            return '/images/a/' + u.slice('/api/article-image?key='.length).split('&')[0];
        }
        if (u.startsWith('/api/image?key=')) {
            const rest = u.slice('/api/image?key='.length);
            const key = rest.split('&')[0];
            const mime = (rest.match(/mime=image\/(\w+)/) || [])[1];
            return '/images/c/' + key + (key.includes('.') ? '' : (mime ? '.' + mime : '.png'));
        }
        return u;
    },

    // 加载图库图片：数据源为 r-gallery 站点（博客自己不再存图）
    // - 观光模式：?safe=1，服务端已剔除 R16/R18；
    // - 管理员：带图库密码（gallery_key 或后台 admin_key）拉全量，图片 URL 也带 token 才能取字节。
    // - 并发调用共享同一次请求（主页要缩略图的同时入口要照片数），避免重复拉取
    async loadGalleryImages() {
        if (this.galleryImages) return this.galleryImages;
        if (this.galleryPromise) return this.galleryPromise;
        this.galleryPromise = this.fetchGalleryList();
        try {
            return await this.galleryPromise;
        } finally {
            this.galleryPromise = null;
        }
    },

    // 真正拉取图库清单
    // 管理员（有凭据）走直连拉全量；观光模式优先读会话缓存 → 后端 /api/gallery（Blobs 缓存）→ 直连兜底
    async fetchGalleryList() {
        const base = this.config.galleryBase;
        const token = this.galleryViewKey();

        if (token) {
            try {
                const list = await this.fetchGalleryPages(base, { token });
                this.galleryImages = this.mapGalleryPhotos(list, token);
                return this.galleryImages;
            } catch (e) {
                /* 凭据失效就退回观光模式 */
            }
        }

        const CACHE_KEY = 'blog-gallery-list-v1';
        const CACHE_TTL = 10 * 60 * 1000;
        try {
            const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
            if (cached && Array.isArray(cached.list) && Date.now() - cached.t < CACHE_TTL) {
                this.galleryImages = cached.list;
                return this.galleryImages;
            }
        } catch (e) { /* 忽略缓存异常 */ }

        let photos = null;
        try {
            const res = await fetch(`${this.config.apiBase}/api/gallery?limit=1000`, { cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.photos)) photos = data.photos;
            }
        } catch (e) { /* 后端不可用，走直连 */ }

        if (!photos) {
            try {
                photos = await this.fetchGalleryPages(base, { safe: true });
            } catch (e) {
                photos = [];
            }
        }

        this.galleryImages = this.mapGalleryPhotos(photos, '');
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), list: this.galleryImages }));
        } catch (e) { /* 存不下就算了 */ }
        return this.galleryImages;
    },

    // 统一映射成前端使用的图片对象（后端代理已给绝对地址，直连兜底时自己拼）
    mapGalleryPhotos(list, token) {
        const base = this.config.galleryBase;
        const tokenQ = token ? 'token=' + encodeURIComponent(token) : '';
        const rawQ = tokenQ ? '?' + tokenQ : '';
        const thumbQ = tokenQ ? '?' + tokenQ + '&v=2' : '?v=2';
        return (list || []).map(p => ({
            id: p.id,
            title: p.title || '',
            rating: p.rating || 'general',
            tags: p.tags || [],
            categories: p.categories || [],
            // 原始宽高：接口是给的，用它就能在下载前就判断横竖（首页两处按方向分图的依据）
            width: Number(p.width) || 0,
            height: Number(p.height) || 0,
            url: p.url || base + '/api/photos/' + encodeURIComponent(p.id) + '/raw' + rawQ,
            thumb: p.thumb || base + '/api/photos/' + encodeURIComponent(p.id) + '/thumb' + thumbQ,
        }));
    },

    // 分页拉取 r-gallery 的照片列表（limit 上限 500，按 cursor 循环取完）
    async fetchGalleryPages(base, opts) {
        const out = [];
        let cursor = '';
        for (let round = 0; round < 20; round++) {
            const params = new URLSearchParams();
            params.set('limit', '500');
            if (opts.safe) params.set('safe', '1');
            else params.set('token', opts.token);
            if (cursor) params.set('cursor', cursor);
            const res = await fetch(base + '/api/photos?' + params.toString());
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const photos = Array.isArray(data.photos) ? data.photos : [];
            out.push(...photos);
            cursor = data.cursor || '';
            if (!cursor || !photos.length) break;
        }
        return out;
    },

    // 读取本地管理员密钥（后台登录后写入 localStorage；前台验证通过后存 sessionStorage）
    getAdminKey() {
        try { return localStorage.getItem('admin_key') || ''; } catch (e) { return ''; }
    },

    // 当前可用的图库查看密钥：后台登录密钥（admin_key）优先，其次前台验证过的密钥（gallery_key）
    galleryViewKey() {
        try {
            const adminKey = localStorage.getItem('admin_key');
            if (adminKey) return adminKey;
            return localStorage.getItem('gallery_key') || '';
        } catch (e) { return ''; }
    },

    // 判断图片是否成人向（R16 / R18）——只有管理员身份可见
    isR18Image(img) {
        return !!(img && (img.rating === 'r18' || img.rating === 'r16'));
    },

    // 给图库中所有成人向图片的 URL 附加图库密码（验证通过后调用）
    applyR18Keys(key) {
        const q = 'token=' + encodeURIComponent(key);
        (this.galleryImages || []).forEach(img => {
            if (!this.isR18Image(img)) return;
            if (img.url && !img.url.includes('token=')) img.url += (img.url.includes('?') ? '&' : '?') + q;
            if (img.thumb && !img.thumb.includes('token=')) img.thumb += (img.thumb.includes('?') ? '&' : '?') + q;
        });
    },

    // 点击 R16/R18 图片时的密码验证：输入图库访问密码，验证通过后本会话可直接查看
    async requestR18Key() {
        const existing = this.galleryViewKey();
        if (existing) {
            // 已有凭据（后台登录的 admin_key 或本会话验证过的 gallery_key）：先验证，再决定是否弹窗
            try {
                const res = await fetch(this.config.galleryBase + '/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: existing }),
                });
                if (res.ok) {
                    this.applyR18Keys(existing);
                    return true;
                }
            } catch (e) { /* 网络失败时回退到弹窗 */ }
        }
        const key = window.prompt('R16 / R18 内容仅管理员可见，请输入图库访问密码：');
        if (!key || !key.trim()) return false;
        try {
            const res = await fetch(this.config.galleryBase + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: key.trim() }),
            });
            if (!res.ok) {
                alert('密码错误，无法查看 R16 / R18 图片');
                return false;
            }
        } catch (e) {
            alert('验证失败，请重试');
            return false;
        }
        localStorage.setItem('gallery_key', key.trim());
        // 解锁后重新拉全量（此时列表里才包含 R16/R18）
        this.galleryImages = null;
        const grid = document.getElementById('galleryGrid');
        if (grid) grid.dataset.rendered = '';
        await this.renderGallery();
        return true;
    },

    // 当前图库筛选标签（'all' 表示全部）
    galleryTag: 'all',

    // 图库分类切换
    setGalleryTag(tag) {
        const next = tag || 'all';
        // 成人档且当前列表里没有成人图（观光身份）：先验证图库密码，通过后重新加载
        if ((next === 'r18' || next === 'r16') && !(this.galleryImages || []).some(img => this.isR18Image(img))) {
            this.requestR18Key().then((ok) => { if (ok) this.setGalleryTag(next); });
            return;
        }
        this.galleryTag = next;
        this.renderGalleryByTag();
        // 更新分类按钮状态
        document.querySelectorAll('.gallery-tag-item').forEach(el => {
            el.classList.toggle('active', el.dataset.tag === this.galleryTag);
        });
        // 更新悬浮按钮图标为当前标签首字（按钮已删，保留逻辑给可能的复活；null 安全）
        const btn = document.getElementById('galleryTagBtn');
        if (btn) {
            if (this.galleryTag === 'all') {
                btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
            } else if (this.galleryTag === 'r18' || this.galleryTag === 'r16') {
                btn.textContent = this.galleryTag.toUpperCase();
            } else {
                // 主分类名通常 3-4 个字，按钮上显示前 2 个字
                btn.textContent = this.galleryTag.slice(0, 2);
            }
        }
        const panel = document.getElementById('galleryTagFloatPanel');
        if (panel) panel.classList.remove('show');
    },

    // 图库图片：加载完成后把真实宽高比写回卡片。
    // 服务端没有记录图片尺寸，所以卡片先用 CSS 的 4:3 占位；比例写回后多列布局基本稳定，不再因图片撑开而大幅重排。
    syncGalleryRatios(grid) {
        if (!grid) return;
        grid.querySelectorAll('.gallery-item img').forEach(img => {
            const apply = () => {
                const w = img.naturalWidth, h = img.naturalHeight;
                if (!w || !h) return;
                const item = img.closest('.gallery-item');
                if (item) item.style.aspectRatio = w + ' / ' + h;
            };
            if (img.complete) apply();
            else img.addEventListener('load', apply, { once: true });
        });
    },

    // 根据当前分类渲染图库（分批渲染：首屏 60 张，滚动接近底部时自动追加）
    renderGalleryByTag() {
        const grid = document.getElementById('galleryGrid');
        if (!grid) return;
        const allImages = (this.galleryImages && this.galleryImages.length) ? this.galleryImages : [];
        // 「全部」视图不显示成人向；R16/R18 仅在对应档位下可见（未解锁时显示锁定占位卡片）
        let filtered;
        if (this.galleryTag === 'all') {
            filtered = allImages.filter(img => !this.isR18Image(img));
        } else if (this.galleryTag === 'r18' || this.galleryTag === 'r16') {
            filtered = allImages.filter(img => img.rating === this.galleryTag);
        } else {
            // 分类面板显示的是 r-gallery 的「主分类」，按 categories 匹配
            filtered = allImages.filter(img => (img.categories || []).includes(this.galleryTag));
        }
        // window.__galleryImages 设为当前筛选结果（灯箱在筛选结果内导航）
        window.__galleryImages = filtered;
        this.galleryFiltered = filtered;
        this.galleryRenderIdx = 0;
        grid.innerHTML = '';
        if (!filtered.length) {
            grid.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">该分类暂无图片</p>';
            return;
        }
        this.renderGalleryBatch();
        this.bindGalleryInfiniteScroll();
    },

    // 图库网格分批渲染参数
    galleryBatchSize: 60,
    galleryRenderIdx: 0,
    galleryFiltered: null,

    // 渲染下一批（默认 60 张）：首屏只请求少量缩略图，滚动到底部附近再继续
    renderGalleryBatch() {
        const grid = document.getElementById('galleryGrid');
        const filtered = this.galleryFiltered || [];
        if (!grid || this.galleryRenderIdx >= filtered.length) return;
        const start = this.galleryRenderIdx;
        const end = Math.min(start + this.galleryBatchSize, filtered.length);
        const html = filtered.slice(start, end).map((img, k) => {
            const i = start + k; // 全局索引（灯箱在完整筛选结果里导航）
            // 成人向且未解锁：显示锁定占位卡片（不加载任何图片内容）
            const locked = this.isR18Image(img) && !(img.url || '').includes('token=');
            if (locked) {
                return `<figure class="gallery-item gallery-item-locked" title="${img.rating === 'r16' ? 'R16' : 'R18'} 内容，点击输入图库密码查看"
                     onclick="openGalleryLightbox('${img.url}', ${i})">
                    <div class="gallery-lock-badge">${img.rating === 'r16' ? 'R16' : 'R18'}</div>
                </figure>`;
            }
            return `<figure class="gallery-item">
                <img src="${img.thumb || img.url}" alt="图片 ${i + 1}" loading="lazy" decoding="async"
                     onclick="openGalleryLightbox('${img.url}', ${i})">
            </figure>`;
        }).join('');
        grid.insertAdjacentHTML('beforeend', html);
        this.galleryRenderIdx = end;
        this.syncGalleryRatios(grid);
    },

    // 滚动接近底部时继续加载下一批（仅图库视图生效）
    bindGalleryInfiniteScroll() {
        if (this.__galleryScrollBound) return;
        this.__galleryScrollBound = true;
        window.addEventListener('scroll', () => {
            if (this.currentView !== 'gallery') return;
            const filtered = this.galleryFiltered || [];
            if (this.galleryRenderIdx >= filtered.length) return;
            const doc = document.documentElement;
            if (window.innerHeight + window.scrollY >= doc.scrollHeight - 1200) this.renderGalleryBatch();
        }, { passive: true });
    },

    // 切换图库分类面板
    toggleGalleryTagPanel() {
        const panel = document.getElementById('galleryTagFloatPanel');
        if (!panel) return;
        panel.classList.toggle('show');
    },

    // 图库标签/主分类配置（来自 r-gallery 的 /api/tags），分类面板直接用它的「主分类」
    galleryConfig: null,
    async loadGalleryConfig() {
        if (this.galleryConfig) return this.galleryConfig;
        let cfg = { categories: [], groups: [], tags: [] };
        try {
            const res = await fetch(this.config.galleryBase + '/api/tags');
            if (res.ok) cfg = await res.json();
        } catch (e) { /* 拿不到配置就用空分类 */ }
        this.galleryConfig = cfg;
        return cfg;
    },

    // 加载并渲染图库分类面板：显示 r-gallery 的「主分类」（颜色圆点 + 张数），与图库站点一致
    async renderGalleryTags() {
        const list = document.getElementById('galleryTagFloatList');
        if (!list) return;
        try {
            const images = this.galleryImages || [];
            const cfg = await this.loadGalleryConfig();
            const cats = (cfg.categories || []).slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
            const countOf = (name) => images.filter(img => (img.categories || []).includes(name)).length;
            const btn = (tag, label, color, count) => {
                const dot = color ? `<span class="gallery-tag-dot" style="background:${color}"></span>` : '';
                const num = (count === undefined) ? '' : `<span class="gallery-tag-count">${count}</span>`;
                return `<button class="gallery-tag-item${this.galleryTag === tag ? ' active' : ''}" data-tag="${tag}" onclick="BlogApp.setGalleryTag('${tag}')">${dot}${label}${num}</button>`;
            };
            let html = btn('all', '全部');
            // 成人向档位只有管理员（能拿到 R16/R18）才显示
            if (images.some(img => img.rating === 'r18')) html += btn('r18', 'R18', '', images.filter(img => img.rating === 'r18').length);
            if (images.some(img => img.rating === 'r16')) html += btn('r16', 'R16', '', images.filter(img => img.rating === 'r16').length);
            // 管理员身份（后台已登录）但凭据还不能解锁成人图时，给一个入口去输入图库密码
            if (!images.some(img => this.isR18Image(img)) && this.getAdminKey()) html += btn('r18', 'R16/R18');
            // 主分类（与 r-gallery 站点同一套：二次元-女 / 插画-风景 / 表情包 …）
            html += cats.map(c => btn(c.name, c.name, c.color, countOf(c.name))).join('');
            list.innerHTML = html;
        } catch (e) {
            list.innerHTML = '<button class="gallery-tag-item active" data-tag="all" onclick="BlogApp.setGalleryTag(\'all\')">全部</button>';
        }
    },

    // 加载资讯数据（优先后端 NewsNow 资讯 API，失败回退本地 recommendations.json）
    async loadNews() {
        // 后端 API（NewsNow 聚合资讯）
        try {
            const res = await fetch(`${this.config.apiBase}/api/news?flat=1&limit=100`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.status === 'success' && Array.isArray(data.items)) {
                    return data.items.map(item => {
                        let date = item.date || '';
                        if (date && typeof date !== 'string') date = new Date(date).toISOString().slice(0, 10);
                        return {
                            id: item.id,
                            title: item.title,
                            date,
                            category: item.category,
                            source: item.source,
                            summary: item.summary || '',
                            url: item.url || ''
                        };
                    });
                }
            }
        } catch (e) {
            /* 静默：属于正常回退路径，不刷控制台 */
        }

        // 回退：本地 recommendations.json
        const res = await fetch('data/recommendations.json');
        if (!res.ok) throw new Error('news load failed');
        const text = await res.text();
        let items;
        try {
            items = JSON.parse(text);
        } catch (e) {
            throw new Error('news parse failed');
        }
        return Array.isArray(items) ? items : [];
    },

    // 渲染主页「今日简报」（无限下滑：初始一批，滚到底继续追加）
    async renderHomeNews() {
        const list = document.getElementById('hv3News');
        if (!list || list.dataset.rendered) return;
        list.dataset.rendered = '1';
        // 首屏遮罩在等这块内容：请求一结束（不管成败）就放行，别让人对着遮罩干等
        const markNewsReady = () => {
            try {
                document.body.classList.add('news-ready');
                document.dispatchEvent(new CustomEvent('blog:news-ready'));
            } catch (e) { }
        };
        try {
            const items = await this.loadNews();
            this.newsItems = items;
            this.newsPool = items;
            this.newsShown = items.length;
            this.startNewsTicker(list, items);
            markNewsReady();
        } catch (e) {
            console.error('资讯加载失败:', e);
            list.innerHTML = '<div class="hv3-empty">资讯加载失败，稍后再试</div>';
            markNewsReady();
        }
    },

    // 今日拾光：默认自动滚（JS 推 scrollTop，内容复制一份可无限循环）；
    // 用户滚轮/触摸/拖拽一碰就暂停自动、交给手动；离开几秒后从当前位置接着自动。
    startNewsTicker(list, items) {
        if (!list) return;
        const pool = (items || []).filter((it) => it && it.title);
        if (!pool.length) {
            list.innerHTML = '<div class="hv3-empty">暂无资讯</div>';
            return;
        }
        // 循环播放只取最近的一批：全部塞进去时线上实测有 600 多条 × 2 份 = 8 万多像素，
        // 滚一整轮要二十多分钟，看着就像「不循环」。40 条约半分钟一轮，才像在循环。
        const LOOP_MAX = 40;
        const loopPool = pool.slice(0, LOOP_MAX);
        const loopHtml = loopPool.map((it) => this.hv3NewsItemHTML(it)).join('');
        // 复制两份：滚过一半时把 scrollTop 减回去，接缝看不出来
        list.innerHTML = '<div class="hv3-ticker-track">' + loopHtml + loopHtml + '</div>';
        const track = list.firstElementChild;
        if (!track) return;

        // 每 16ms 推进 0.5px ≈ 31px/s：比 17px/s 那版看得出在动，又不至于读不完标题
        const SPEED = 0.5;
        // 用固定间隔推进（和日历旁的项目条一致）：rAF 在后台/无渲染时会被挂起，容易「看着不滚」
        let timer = 0;
        let paused = false;
        let resumeTimer = 0;
        let acc = 0;
        // 内容不到一屏就不用滚
        let half = 0;
        const measure = () => { half = track.scrollHeight / 2; };
        measure();
        window.addEventListener('resize', measure, { passive: true });

        const tick = () => {
            if (paused || document.hidden) return;
            if (half <= 6 || half <= list.clientHeight + 6) return;
            // scrollTop 只认真数像素：先攒够 1px 再加，不然小数每帧都被吞掉
            acc += SPEED;
            if (acc < 1) return;
            const stepPx = Math.floor(acc);
            acc -= stepPx;
            list.scrollTop += stepPx;
            // 滚过一半（第二份开头 ≈ 第一份开头）就悄悄减回去，无限循环
            if (list.scrollTop >= half) list.scrollTop -= half;
        };
        const play = () => {
            if (timer || paused || document.hidden) return;
            timer = setInterval(tick, 16);
        };
        const stop = () => {
            if (timer) { clearInterval(timer); timer = 0; }
        };
        const pause = (hold) => {
            paused = true;
            stop();
            if (resumeTimer) clearTimeout(resumeTimer);
            // hold=true：用户正在交互（滚轮/触摸），不自动恢复，等 pointerleave
            if (!hold) resumeTimer = setTimeout(() => { paused = false; play(); }, 2500);
        };

        // 手动滚动：滚轮/触摸/键盘都算；交互期间不自动恢复
        list.addEventListener('wheel', () => pause(true), { passive: true });
        list.addEventListener('touchstart', () => pause(true), { passive: true });
        list.addEventListener('pointerdown', () => pause(true), { passive: true });
        list.addEventListener('keydown', () => pause(true));
        // 鼠标悬停也暂停（读标题），移开后恢复
        list.addEventListener('pointerenter', () => pause(true));
        list.addEventListener('pointerleave', () => { paused = false; play(); });
        list.addEventListener('focusin', () => pause(true));
        list.addEventListener('focusout', () => { paused = false; play(); });
        document.addEventListener('visibilitychange', () => (document.hidden ? stop() : play()));

        // 看门狗：切标签页 / 切视图后 pointerleave 可能根本收不到，暂停就永久卡住 —— 定期自检
        setInterval(() => {
            if (document.hidden) return;
            if (!paused) {
                if (!timer) play();
                return;
            }
            if (list.matches(':hover') || list.matches(':focus-within')) return;   // 真在交互，别打断
            paused = false;
            play();
        }, 2000);

        play();
    },

    // 首页简报条目的 HTML（hv3 结构，与新闻视图的 news-item 互不影响）
    hv3NewsItemHTML(it) {
        return '<a class="hv3-news-item" href="' + this.escAttr(it.url || '#') + '" target="_blank" rel="noopener">'
            + '<span class="hv3-news-cat">' + this.esc(it.source || it.category || '资讯') + '</span>'
            + '<span class="hv3-news-title">' + this.esc(it.title) + '</span>'
            + '<span class="hv3-news-meta">' + this.esc(it.source || '') + (it.date ? ' · ' + this.formatDate(it.date) : '') + '</span>'
            + '</a>';
    },

    // 简报：鼠标悬停时自动缓慢滚动（来回走，不会卡在底）
    bindNewsHoverScroll() {
        const list = document.getElementById('newsList');
        if (!list || list.dataset.hoverBound) return;
        list.dataset.hoverBound = '1';

        let raf = 0;
        let dir = 1;
        let hovering = false;

        const step = () => {
            if (!hovering) { raf = 0; return; }
            raf = requestAnimationFrame(step);
            const max = list.scrollHeight - list.clientHeight;
            if (max <= 4) return;
            list.scrollTop += 2.4 * dir;
            if (list.scrollTop >= max - 1) dir = -1;
            if (list.scrollTop <= 0) dir = 1;
        };

        const start = () => {
            hovering = true;
            if (!raf) raf = requestAnimationFrame(step);
        };
        const stop = () => {
            hovering = false;
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
        };

        list.addEventListener('mouseenter', start);
        list.addEventListener('mouseleave', stop);
        list.addEventListener('pointerenter', start);
        list.addEventListener('pointerleave', stop);
        // 手指/触屏按住也能滚
        list.addEventListener('touchstart', start, { passive: true });
        list.addEventListener('touchend', stop);
    },

    // 每条资讯的 HTML（列表与追加共用）
    newsItemHTML(it) {
        return `
            <a class="news-item" href="${this.escAttr(it.url || '#')}" target="_blank" rel="noopener">
                <span class="news-item-cat">${this.esc(it.source || it.category || '资讯')}</span>
                <span class="news-item-title">${this.esc(it.title)}</span>
                <span class="news-item-meta">${this.esc(it.source || '')}${it.date ? ' · ' + this.formatDate(it.date) : ''}</span>
            </a>
        `;
    },

    // 追加下一批资讯（每次 8 条），池子见底后给出提示
    renderMoreNews() {
        const list = document.getElementById('newsList');
        if (!list) return;
        const pool = this.newsPool || [];
        const batch = 8;

        if (this.newsShown >= pool.length) {
            if (!list.querySelector('.news-end')) {
                const end = document.createElement('div');
                end.className = 'news-end';
                end.textContent = pool.length ? `已显示全部 ${pool.length} 条` : '暂无资讯';
                list.appendChild(end);
            }
            return;
        }

        const next = pool.slice(this.newsShown, this.newsShown + batch);
        this.newsShown += next.length;
        list.insertAdjacentHTML('beforeend', next.map(it => this.newsItemHTML(it)).join(''));

        // 新追加的条目做个淡入，避免突兀
        if (typeof anime !== 'undefined') {
            const items = list.querySelectorAll('.news-item');
            const fresh = [...items].slice(-next.length);
            anime.animate(fresh, {
                opacity: [0, 1],
                translateX: [16, 0],
                duration: 320,
                delay: anime.stagger(20),
                ease: 'out(2)'
            });
        }
    },

    // 列表内无限下滑：接近底部就再追加一批
    bindNewsInfiniteScroll(list) {
        if (!list || list.dataset.scrollBound) return;
        list.dataset.scrollBound = '1';
        let ticking = false;
        list.addEventListener('scroll', () => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                ticking = false;
                if (list.scrollTop + list.clientHeight >= list.scrollHeight - 60) {
                    this.renderMoreNews();
                }
            });
        }, { passive: true });
    },

    // 内容不足一屏（没有滚动条就没有滚动事件）时继续补，直到能滚或池子见底
    fillNewsIfShort(list) {
        let guard = 0;
        while (guard++ < 30) {
            const hasMore = (this.newsPool || []).length > (this.newsShown || 0);
            if (!hasMore) {
                this.renderMoreNews(); // 池子已空：补上「已显示全部」提示
                return;
            }
            if (list.scrollHeight > list.clientHeight + 4) return;
            this.renderMoreNews();
        }
    },

    // 筛选资讯（保留给旧缓存页面兜底；主页已不展示来源按钮）
    filterNews(src) {
        const buttons = document.querySelectorAll('#newsFilter .news-filter-btn');
        buttons.forEach(b => {
            b.classList.toggle('active', b.dataset.cat === src);
        });
        const items = src === 'all' ? this.newsItems : this.newsItems.filter(it => it.source === src);
        this.renderNewsList(items);
    },

    // 一次性渲染资讯列表（筛选兜底用）
    renderNewsList(items) {
        const list = document.getElementById('newsList');
        if (!list) return;
        const rows = items.slice(0, 8);
        if (!rows.length) {
            list.innerHTML = '<div class="home-empty">暂无资讯</div>';
            return;
        }
        list.innerHTML = rows.map(it => this.newsItemHTML(it)).join('');
    },

    // HTML 转义（用于卡片文本）
    esc(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    // HTML 属性转义（额外转义单引号，用于 onclick 等单引号属性）
    escAttr(str) {
        return this.esc(str).replace(/'/g, '&#39;');
    },

    // 封面加载完成：把卡片高度完全按图片真实比例设好 —— 图完整铺满、不留白也不裁切
    handleCoverLoad(img) {
        try {
            if (!img) return;
            const w = img.naturalWidth || 0;
            const h = img.naturalHeight || 0;
            if (!w || !h) return;
            const box = img.parentElement;
            if (!box || !box.classList.contains('card-img')) return;
            const cardW = box.clientWidth || 320;
            // 高度 = 按真实宽高比算出来的高度，不再夹取区间：卡片多长都行
            const height = Math.max(80, Math.round(cardW * h / w));
            box.style.height = height + 'px';
            // 宽高比已对齐，cover 即完整显示；resize 后也不会像 fill 那样被拉伸变形
            img.style.objectFit = 'cover';
        } catch (e) { /* 兜底异常忽略 */ }
    },

    // 封面加载失败兜底：先重试默认封面，仍失败则退化为标签渐变底 + 图标
    handleCoverError(img) {
        try {
            if (!img) return;
            if (!img.dataset.retried) {
                img.dataset.retried = '1';
                img.src = 'images/Default/web-logo.webp';
                return;
            }
            img.style.display = 'none';
            const parent = img.parentElement;
            if (parent) {
                parent.style.background = `linear-gradient(145deg, ${img.dataset.g1 || '#151515'}, ${img.dataset.g2 || '#222222'})`;
                if (!parent.querySelector('.big-text')) {
                    const icon = document.createElement('div');
                    icon.className = 'big-text';
                    icon.textContent = img.dataset.icon || '□';
                    parent.appendChild(icon);
                }
            }
        } catch (e) { /* 兜底异常忽略 */ }
    },

    // 获取博客设置（由 index.html 的 loadBlogSettings 填充）
    getBlogSettings() {
        if (typeof blogSettings !== 'undefined' && blogSettings) return blogSettings;
        return null;
    },

    // 主页文章封面轮播：封面铺满盒子，底部毛玻璃遮罩显示标题与标签
    renderHomePostStage() {
        const stage = document.getElementById('homePostStage');
        const img = document.getElementById('homePostImg');
        if (!stage || !img) return;

        const posts = (this.posts || []).filter(p => p && p.filename);
        if (!posts.length) {
            stage.removeAttribute('href');
            const titleEl = document.getElementById('homePostTitle');
            if (titleEl) titleEl.textContent = '还没有文章';
            this.stopHomePostTimer();
            return;
        }

        this.homePosts = posts;
        // 悬停暂停，移开继续
        if (!stage.dataset.hoverBound) {
            stage.dataset.hoverBound = '1';
            stage.addEventListener('mouseenter', () => this.stopHomePostTimer());
            stage.addEventListener('mouseleave', () => this.startHomePostTimer());
        }

        this.showHomePost(0);
        this.startHomePostTimer();
    },

    // 显示第 i 篇文章封面（越界循环）并预加载下一张
    showHomePost(i) {
        const posts = this.homePosts || [];
        if (!posts.length) return;
        const idx = ((i % posts.length) + posts.length) % posts.length;
        this.homePostIndex = idx;
        const post = posts[idx];

        const stage = document.getElementById('homePostStage');
        const img = document.getElementById('homePostImg');
        const titleEl = document.getElementById('homePostTitle');
        const tagsEl = document.getElementById('homePostTags');
        const badgeEl = document.getElementById('homePostBadge');
        if (!stage || !img) return;

        const cover = post.image || 'images/Default/web-logo.webp';
        if (img.getAttribute('src') !== cover) {
            img.classList.remove('is-in');
            img.setAttribute('src', cover);
            img.alt = post.title || '文章封面';
            requestAnimationFrame(() => img.classList.add('is-in'));
        }
        if (titleEl) titleEl.textContent = post.title || '';
        if (tagsEl) {
            tagsEl.innerHTML = (post.tags || []).slice(0, 3)
                .map(t => `<span class="home-post-tag">${this.esc(t)}</span>`).join('');
        }
        if (badgeEl) {
            badgeEl.textContent = post.type === 'whiteboard' ? '交互白板'
                : post.type === 'mindmap' ? '思维导图'
                : post.type === 'graph' ? '节点图' : '博客文章';
        }
        stage.setAttribute('href', `article.html?post=${this.escAttr(post.filename)}&blob=${this.escAttr(post.id || '')}`);

        // 预加载下一张封面
        const next = posts[(idx + 1) % posts.length];
        if (next && next.image) {
            const pre = new Image();
            pre.src = next.image;
        }
    },

    startHomePostTimer() {
        this.stopHomePostTimer();
        if (!this.homePosts || this.homePosts.length < 2) return;
        this.homePostTimer = setInterval(() => {
            if (document.hidden) return;
            this.showHomePost(this.homePostIndex + 1);
        }, 60000);
    },

    stopHomePostTimer() {
        if (this.homePostTimer) {
            clearInterval(this.homePostTimer);
            this.homePostTimer = null;
        }
    },

    // 身份区右侧的实时时钟
    startHvClock() {
        this.renderHvClock();
        if (this.hvClockTimer) clearInterval(this.hvClockTimer);
        this.hvClockTimer = setInterval(() => { if (!document.hidden) this.renderHvClock(); }, 60000);
    },

    renderHvClock() {
        const t = document.getElementById('hvClockTime');
        if (!t) return;
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const text = hh + ':' + mm;
        if (t.textContent !== text) {
            t.textContent = text;
            const d = document.getElementById('hvClockDate');
            if (d) {
                const names = ['日', '一', '二', '三', '四', '五', '六'];
                d.textContent = (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日 · 周' + names[now.getDay()];
            }
        }
    },
    // 主页身份区：头像 / 名字 / 简介跟随博客设置
    renderHomeIdentity() {
        const settings = this.getBlogSettings && this.getBlogSettings();
        const nameEl = document.querySelector('.hv3-name');
        const bioEl = document.querySelector('.hv3-bio');
        const avatarEl = document.querySelector('.hv3-avatar');
        const name = (settings && (settings.authorName || settings.name)) || "博主";
        if (nameEl && nameEl.textContent !== name) {
            nameEl.textContent = name;
            document.title = name + " · 个人博客";
        }
        if (bioEl) {
            const bio = (settings && (settings.bio || settings.description || settings.tagline)) || "欢迎来到我的博客";
            if (bioEl.textContent !== bio) bioEl.textContent = bio;
        }
        if (avatarEl) {
            const src = (settings && settings.avatar) || "images/Default/profile -picture.webp";
            if (avatarEl.getAttribute("src") !== src) avatarEl.src = src;
            avatarEl.alt = name;
        }
    },

    // ---------- 图库图片墙：无限画布 · 拖拽平移 · 缩放 · 视野虚拟化 ----------

    gw: { x: 0, y: 0, s: 1, dragging: false, moved: 0, vx: 0, vy: 0, raf: 0, inertia: 0, inited: false, panTimer: 0 },

    get gwMinS() { return 0.2; },
    get gwMaxS() { return 2.2; },

    initGalleryWall() {
        const wall = document.getElementById('galleryWall');
        if (!wall) return;

        if (!this.gw.inited) {
            this.gw.inited = true;
            this.bindGalleryWallEvents(wall);

            // 工具条
            document.getElementById('gwHud')?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-gw]');
                if (!btn) return;
                e.stopPropagation();
                const act = btn.dataset.gw;
                if (act === 'view') {
                    this.wallSetView(this.photoWallView === 'grid' ? 'masonry' : 'grid');
                    this.syncWallViewBtn();
                    this.gwFit();
                } else if (act === 'shuffle') {
                    this.wallShuffle();
                    this.gwFit();
                } else if (act === 'fit') {
                    this.gwFit();
                } else if (act === 'all') {
                    this.gwFitAll();
                }
            });

            this.bindPhotoWall();
            this.syncWallViewBtn();

            // 提示 4.5 秒后淡出
            setTimeout(() => document.getElementById('gwHint')?.classList.add('gone'), 4500);
        }

        // 加载照片 → 布局 → 渲染 → 适应屏幕
        this.loadPhotoWall().then(() => {
            this.wallComputeLayout();
            this.wallRender();
            this.gwFit();
        });
    },

    bindGalleryWallEvents(wall) {
        let startX = 0;
        let startY = 0;
        let originX = 0;
        let originY = 0;
        let lastX = 0;
        let lastY = 0;
        let lastT = 0;

        const down = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            // 注意：这里不能排除 button —— 照片本身是 <button class="gw-tile">，
            // 一旦把它排除，指针落在照片上就拖不动墙了（只有空隙能拖，手感像坏了）。
            // 工具条按钮都在 .gw-hud 里，已经被排除掉了。
            if (e.target.closest('.gw-hud, .gw-hint, .gw-tip, a, input')) return;
            this.stopGwInertia();
            this.gw.dragging = true;
            this.gw.moved = 0;
            startX = e.clientX;
            startY = e.clientY;
            originX = this.gw.x;
            originY = this.gw.y;
            lastX = e.clientX;
            lastY = e.clientY;
            lastT = Date.now();
            this.gw.vx = 0;
            this.gw.vy = 0;
            wall.classList.add('is-dragging');
        };

        const move = (e) => {
            if (!this.gw.dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            this.gw.moved = Math.max(this.gw.moved, Math.abs(dx) + Math.abs(dy));
            this.gw.x = originX + dx;
            this.gw.y = originY + dy;
            const now = Date.now();
            const dt = Math.max(1, now - lastT);
            this.gw.vx = (e.clientX - lastX) / dt;
            this.gw.vy = (e.clientY - lastY) / dt;
            lastX = e.clientX;
            lastY = e.clientY;
            lastT = now;
            this.wallSchedule();
        };

        const up = () => {
            if (!this.gw.dragging) return;
            this.gw.dragging = false;
            wall.classList.remove('is-dragging');
            if (Math.hypot(this.gw.vx, this.gw.vy) > 0.15) this.startGwInertia();
        };

        wall.addEventListener('pointerdown', down);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);

        // 双指捏合缩放（以两指中点为中心，同时支持两指拖动平移）
        let pinch = null;
        const touchDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        wall.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                this.stopGwInertia();
                this.gw.dragging = false;
                wall.classList.remove('is-dragging');
                this.gw.moved = 99;
                const [a, b] = e.touches;
                pinch = {
                    d0: Math.max(1, touchDist(a, b)),
                    s0: this.gw.s,
                    x0: this.gw.x,
                    y0: this.gw.y,
                    mx: (a.clientX + b.clientX) / 2,
                    my: (a.clientY + b.clientY) / 2,
                };
            }
        }, { passive: true });
        wall.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2 && pinch) {
                const [a, b] = e.touches;
                const d = touchDist(a, b);
                const mx = (a.clientX + b.clientX) / 2;
                const my = (a.clientY + b.clientY) / 2;
                const next = Math.min(this.gwMaxS, Math.max(this.gwMinS, pinch.s0 * (d / pinch.d0)));
                const k = next / pinch.s0;
                this.gw.x = mx - (pinch.mx - pinch.x0) * k;
                this.gw.y = my - (pinch.my - pinch.y0) * k;
                this.gw.s = next;
                this.wallSchedule();
            }
        }, { passive: true });
        wall.addEventListener('touchend', () => { pinch = null; });
        wall.addEventListener('touchcancel', () => { pinch = null; });

        // 滚轮缩放（以指针为中心）
        wall.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = wall.getBoundingClientRect();
            this.gwZoomAt(
                e.clientX - rect.left,
                e.clientY - rect.top,
                Math.max(0.7, Math.min(1.4, Math.exp(-e.deltaY * 0.0012)))
            );
        }, { passive: false });

        // 双击空白回到整墙视角
        wall.addEventListener('dblclick', (e) => {
            if (e.target.closest('.gw-tile')) return;
            this.gwFit();
        });

        window.addEventListener('resize', () => {
            if (this.gw.inited && this.currentView === 'gallery') this.wallRender();
        }, { passive: true });
    },

    gwApply() {
        const plane = document.getElementById('gwPlane');
        if (!plane) return;
        plane.style.transform = 'translate3d(' + this.gw.x + 'px, ' + this.gw.y + 'px, 0) scale(' + this.gw.s + ')';
        this.wallSchedule();
    },

    gwZoomAt(px, py, factor) {
        const next = Math.min(this.gwMaxS, Math.max(this.gwMinS, this.gw.s * factor));
        if (Math.abs(next - this.gw.s) < 1e-4) return;
        this.gw.x = px - ((px - this.gw.x) / this.gw.s) * next;
        this.gw.y = py - ((py - this.gw.y) / this.gw.s) * next;
        this.gw.s = next;
        this.wallSchedule();
    },

    // 适应宽度（默认视角）：整排照片刚好铺满屏幕宽，从顶上开始看
    gwFit() {
        const wall = document.getElementById('galleryWall');
        const layout = this.photoWallLayout;
        if (!wall || !layout) return;
        const vw = wall.clientWidth || window.innerWidth;
        const s = Math.min(1.4, (vw - 48) / Math.max(1, layout.blockW));
        this.gw.s = Math.max(this.gwMinS, s);
        this.gw.x = Math.round((vw - layout.blockW * this.gw.s) / 2);
        this.gw.y = 32;
        this.gwApply();
    },

    // 看全墙：整面墙塞进屏幕（会很小，用来瞄一眼总量）
    gwFitAll() {
        const wall = document.getElementById('galleryWall');
        const layout = this.photoWallLayout;
        if (!wall || !layout) return;
        const vw = wall.clientWidth || window.innerWidth;
        const vh = wall.clientHeight || window.innerHeight;
        const s = Math.min((vw - 48) / Math.max(1, layout.blockW), (vh - 48) / Math.max(1, layout.blockH));
        this.gw.s = Math.max(this.gwMinS, s);
        this.gw.x = Math.round((vw - layout.blockW * this.gw.s) / 2);
        this.gw.y = Math.round((vh - layout.blockH * this.gw.s) / 2);
        this.gwApply();
    },

    startGwInertia() {
        const step = () => {
            this.gw.inertia = 0;
            if (this.gw.dragging) return;
            this.gw.vx *= 0.94;
            this.gw.vy *= 0.94;
            if (Math.abs(this.gw.vx) < 0.02 && Math.abs(this.gw.vy) < 0.02) return;
            this.gw.x += this.gw.vx * 16;
            this.gw.y += this.gw.vy * 16;
            this.wallRender();
            this.gw.inertia = requestAnimationFrame(step);
        };
        this.gw.inertia = requestAnimationFrame(step);
    },

    stopGwInertia() {
        if (this.gw.inertia) {
            cancelAnimationFrame(this.gw.inertia);
            this.gw.inertia = 0;
        }
    },

    // ---------- 主页仪表盘：精选文章 / 照片带 ----------

    // 文章位：全部「有封面图」的文章轮流播放（封面和标题一体，没图的文章不参与）
    renderHvPosts() {
        const track = document.getElementById('hv3Track');
        if (!track) return;
        // 没有封面图的文章两边都不出现：文章位不播它（图和标题是一体的，没图就没内容可播），
        // 图片位那边也拿不到它的图，自然也不会出现。
        const posts = (Array.isArray(this.posts) ? this.posts : []).filter((p) => p && p.image);
        if (!posts.length) {
            if (!track.dataset.empty) {
                track.innerHTML = '<div class="hv3-empty">还没有带封面的文章</div>';
                track.dataset.empty = '1';
            }
            return;
        }
        track.dataset.empty = '';

        /* 从别的页面切回主页时 renderHome 会再跑一遍。如果文章列表没变，就不要再重建 DOM：
           重建会把封面 <img> 丢掉重插，图片要重新解码，中间空出一帧 —— 就是用户看到的「先黑一下」。
           内容真变了（新增/删除文章、换封面）才重建。 */
        const sig = posts.map((p) => [p.image || '', p.title || '', p.filename || '', p.date || ''].join('|')).join('\n');
        if (track.dataset.sig === sig && track.querySelector('.hv3-item')) {
            this._postPlay = { posts: posts, idx: this._postPlay ? (this._postPlay.idx || 0) : 0 };
            this.syncCarouselHeight();
            this.bindPostPlay();
            this.startPostPlay();
            // 保险：万一还有卡片没图上（当时图片池是空的），补一次
            const naked = [...track.querySelectorAll('.hv3-item.is-generic')].filter((it) => {
                const im = it.querySelector('.hv3-cover-img.is-front');
                return !im || !im.getAttribute('src');
            });
            if (naked.length) this.fillCoverPlay(naked);
            return;
        }
        track.dataset.sig = sig;

        track.innerHTML = posts.map((post, i) => {
            const href = 'article.html?post=' + encodeURIComponent(post.filename || '');
            const title = this.esc(post.title || '无标题');
            const date = this.formatDate ? this.formatDate(post.date) : (post.date || '');
            const tag = (post.tags && post.tags[0]) ? '<span class="hv3-tag">' + this.esc(post.tags[0]) + '</span>' : '';
            // 封面固定两层：和生活切片一样靠交叉淡入换图（swapCoverPlay 往里灌图）
            // 第一张是要立刻显示的，用 eager 抢优先级；其余懒加载
            const eager = i === 0 ? 'eager' : 'lazy';
            const img0 = post.image
                ? '<img class="hv3-cover-img is-front" src="' + this.escAttr(post.image) + '" alt="" loading="' + eager + '" decoding="async" referrerpolicy="no-referrer" fetchpriority="high">'
                : '<img class="hv3-cover-img is-front" alt="" loading="' + eager + '" decoding="async" referrerpolicy="no-referrer">';
            const cover = '<span class="hv3-cover">' + img0 + '<img class="hv3-cover-img" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>';
            return '<a class="hv3-item' + (i === 0 ? ' is-front' : '') + '" href="' + href + '" data-has-cover="' + (post.image ? '1' : '') + '">'
                + cover
                + '<span class="hv3-body">'
                + '<span class="hv3-item-title">' + title + '</span>'
                + '<span class="hv3-item-meta"><span>' + date + '</span>' + tag + '</span>'
                + '</span>'
                + '</a>';
        }).join('');

        /* 每张卡的封面按方向决定「怎么播」：
           · 自带封面是竖图 → 一直用它（静态显示），标题跟着这张图显示
           · 自带封面是横图 → 图和标题一起让给「生活切片」播，这张卡改播图库竖图、标题不再显示
           · 没有封面 → 同样改播图库竖图、不显示标题
           （标题和封面是一体的：图在文章位就显示标题，换成通用图就不该再挂着这篇的标题） */
        const playCards = [];
        track.querySelectorAll('.hv3-item').forEach((item) => {
            const img = item.querySelector('.hv3-cover-img.is-front');
            const markPlay = () => {
                item.classList.add('is-generic');
                // 这张卡以后显示的是图库竖图，点开看大图而不是进文章 —— 去掉链接就没有跳转
                item.removeAttribute('href');
                item.setAttribute('role', 'button');
                // 自带的封面如果根本没加载出来（坏图/404），把 src 清掉，
                // 否则下面补图时会被「这一层已经有 src」挡住，卡片一直空着
                const cur = item.querySelector('.hv3-cover-img.is-front');
                if (cur && cur.getAttribute('src') && !cur.naturalWidth) cur.removeAttribute('src');
                playCards.push(item);
                // 立刻补图：判定是异步的（要等封面加载完才知道方向），
                // 如果只靠下面 400ms 那次批量填充，判定晚一步的卡就再没人管 = 空白。
                this.scheduleFillCover([item]);
            };
            if (!img || !img.getAttribute('src')) { markPlay(); return; }
            const decide = () => {
                const w = img.naturalWidth;
                const h = img.naturalHeight;
                if (!w || !h) return;
                if (w >= h) {
                    // 横图：图和标题一起交给图片区，这张卡换成竖图播放且不显示标题
                    img.removeAttribute('src');
                    img.classList.remove('is-front');
                    markPlay();
                } else {
                    item.style.setProperty('--cover-ratio', String(w / h));
                    this.syncCarouselHeight();
                }
            };
            if (img.complete && img.naturalWidth) decide();
            else img.addEventListener('load', decide, { once: true });
            img.addEventListener('error', () => { markPlay(); }, { once: true });
        });

        this._postPlay = { posts: posts, idx: 0 };
        this.syncCarouselHeight();
        setTimeout(() => this.syncCarouselHeight(), 300);
        setTimeout(() => this.syncCarouselHeight(), 1200);

        this.bindPostPlay();
        this.startPostPlay();
        // 等方向判定完再补竖图封面（延迟一拍，让自带的竖图封面先落位）
        setTimeout(() => this.fillCoverPlay(playCards), 400);
    },

    /* ===== 文章位：整张卡交叉淡入播放 =====
       · 封面和标题是一张卡的两个部分，切换时一起淡出淡入（用户要的「两边一起切」）
       · 5 秒一篇，全部文章轮流过；没有左右按钮和页码圆点，纯自动播放
       · 鼠标停上去暂停，走开继续 */
    bindPostPlay() {
        const car = document.getElementById('hv3Car');
        if (!car || car.dataset.playBound) return;
        car.dataset.playBound = '1';
        // 鼠标停上去就暂停自动切换，走开再继续
        car.addEventListener('mouseenter', () => this.stopPostPlay());
        car.addEventListener('mouseleave', () => this.startPostPlay());
        // 窗口尺寸变了：文章盒子宽高要重算，右列（切片 + 简报）也跟着重新对齐 ——
        // 盒子变高时简报要一起撑高，变矮时一起缩，两边底边始终齐平。
        if (!this._postResizeBound) {
            this._postResizeBound = true;
            window.addEventListener('resize', () => {
                clearTimeout(this._postResizeTimer);
                this._postResizeTimer = setTimeout(() => this.syncCarouselHeight(), 120);
            }, { passive: true });
        }
        // 卡片上显示的是「图库竖图」（is-generic）时，点开就该看大图，不能跳到文章去 ——
        // 那张图和文章本来就不对应。显示自己封面的卡照旧进文章。
        car.addEventListener('click', (e) => {
            const item = e.target.closest('.hv3-item');
            if (!item || !item.classList.contains('is-generic')) return;
            e.preventDefault();
            const front = item.querySelector('.hv3-cover-img.is-front') || item.querySelector('.hv3-cover-img');
            const src = front ? (front.currentSrc || front.src || '') : '';
            if (!src) return;
            this.portraitPool().then((pool) => {
                if (!pool || !pool.length) {
                    if (typeof window.openGalleryLightbox === 'function') window.openGalleryLightbox(src, 0);
                    return;
                }
                window.__galleryImages = pool;
                /* 池里存的是相对路径（/api/photos/xxx/thumb?v=2），卡片上取到的是绝对 URL，
                   直接比字符串永远不等，灯箱就会从第一张开始 —— 看着就是「显示 A、点开是 B」。 */
                const idx = this.matchGalleryIndex(pool, src);
                if (typeof window.openGalleryLightbox === 'function') {
                    // 传池子里的原样地址，灯箱内部拿它定位就不会再对不上
                    const pick = idx >= 0 ? pool[idx] : null;
                    window.openGalleryLightbox(pick ? String(pick.thumb || pick.url) : src, idx >= 0 ? idx : 0);
                }
            }).catch(() => {
                if (typeof window.openGalleryLightbox === 'function') window.openGalleryLightbox(src, 0);
            });
        });
    },

    startPostPlay() {
        this.stopPostPlay();
        // 一分钟一篇：慢一点，看清封面再翻
        this._postTimer = setInterval(() => {
            if (document.hidden) return;
            const car = document.getElementById('hv3Car');
            // 面板被切走时这框是 display:none，别白白切
            if (!car || !car.clientWidth) return;
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            this.gotoPost((this._postPlay ? this._postPlay.idx : 0) + 1);
        }, 60000);
    },

    stopPostPlay() {
        if (this._postTimer) { clearInterval(this._postTimer); this._postTimer = 0; }
    },

    gotoPost(i) {
        const st = this._postPlay;
        if (!st || !st.posts.length) return;
        const n = ((i % st.posts.length) + st.posts.length) % st.posts.length;
        st.idx = n;
        const items = [...document.querySelectorAll('#hv3Track .hv3-item')];
        items.forEach((el, k) => el.classList.toggle('is-front', k === n));
        this.syncCarouselHeight();
    },

    /* 把「待补图」的卡攒一下再补：一屏可能同时有好几张卡判定为需要换图，
       逐张补会重复跑池子逻辑。80ms 内的合并成一批。 */
    scheduleFillCover(cards) {
        this._pendingCoverCards = (this._pendingCoverCards || []).concat(cards || []);
        clearTimeout(this._coverFillTimer);
        this._coverFillTimer = setTimeout(() => {
            this._coverFillTimer = 0;
            const list = this._pendingCoverCards || [];
            this._pendingCoverCards = [];
            if (list.length) this.fillCoverPlay(list);
        }, 80);
    },

    /* 横图封面和没有封面的卡：用竖图补一张封面。
       图库接口给了 width/height，所以竖图池是「确定」的，不是猜的 ——
       宁可多等一会儿池子攒好，也不拿横图凑数（左竖右横是硬规则）。
       关键是「一定要有图」：池子还没好就挂个占位、隔一会儿接着补，不放弃。 */
    fillCoverPlay(cards) {
        const live = (cards || []).filter((el) => el && el.isConnected);
        if (!live.length) return;
        // 先把还没图的卡打上占位（避免一大块空白）
        live.forEach((el) => {
            const f = el.querySelector('.hv3-cover-img.is-front');
            if (!f || !f.getAttribute('src')) el.classList.add('is-waiting-cover');
        });
        this.portraitPool().then((pool) => {
            if (pool.length) {
                live.forEach((el) => this.swapCoverPlay(el, pool));
                live.forEach((el) => {
                    const f = el.querySelector('.hv3-cover-img.is-front');
                    if (f && f.getAttribute('src')) el.classList.remove('is-waiting-cover');
                });
                return;
            }
            // 一张竖图都还没有：过一会儿再来（图库可能还在路上/这次超时了）
            if (this._coverRetry) clearTimeout(this._coverRetry);
            this._coverRetry = setTimeout(() => {
                this._coverRetry = 0;
                // 清掉「空池」缓存，下次重新去图库要一次
                this._orientPools = null;
                this._portraitCache = null;
                this.fillCoverPlay(live);
            }, 2500);
        }).catch(() => { /* 图库整个拿不到：占位留着，不影响页面 */ });
    },

    /* 把所有能用上的图按方向分成两池，左（文章）只用竖图、右（生活切片）只用横图。
       方向优先看接口给的 width/height，缺尺寸的（老图、文章封面）才实际加载量一遍。
       严格二选一：量不出来的直接丢掉，不塞进任何一边。
       注意：空结果不缓存 —— 图库还没回来时缓存了空池，就永远补不上图了。 */
    async orientationPools() {
        if (this._orientPools && (this._orientPools.portrait.length || this._orientPools.landscape.length)) {
            return this._orientPools;
        }
        if (this._orientPoolsPromise) return this._orientPoolsPromise;
        const orient = this._shotOrient = this._shotOrient || new Map();
        this._orientPoolsPromise = (async () => {
            let gallery = [];
            try { gallery = (await this.loadGalleryImages()) || []; } catch (e) { gallery = []; }

            // 文章的封面也算图源：横图封面去生活切片，竖图封面留在文章位
            const postCovers = (Array.isArray(this.posts) ? this.posts : [])
                .filter((p) => p && p.image)
                .map((p) => ({
                    id: 'post:' + (p.filename || p.title || ''),
                    thumb: p.image,
                    url: p.image,
                    __cap: p.title || '',
                }));

            const portrait = [];
            const landscape = [];
            const square = [];
            const unknown = [];
            // 按宽高比三分类：接近正方形的（0.85 ~ 1.18）单独给方图盒子，
            // 明显更宽的给生活切片，更窄的给文章位 —— 三类互不重叠
            const kindOf = (w, h) => {
                const r = w / h;
                if (r >= 0.85 && r <= 1.18) return 'square';
                return r > 1.18 ? 'landscape' : 'portrait';
            };
            const pushKind = (p, kind) => {
                if (kind === 'square') square.push(p);
                else if (kind === 'landscape') landscape.push(p);
                else portrait.push(p);
            };
            const seen = new Set();
            for (const p of postCovers.concat(gallery)) {
                const key = String((p && (p.thumb || p.url)) || '');
                if (!key || seen.has(key)) continue;
                if (this.isR18Image(p)) continue;
                seen.add(key);
                const w = Number(p.width) || 0;
                const h = Number(p.height) || 0;
                if (w > 0 && h > 0) {
                    const kind = kindOf(w, h);
                    pushKind(p, kind);
                    orient.set(p.id, kind);
                    continue;
                }
                const known = orient.get(p.id);
                if (known === 'square' || known === 'portrait' || known === 'landscape') pushKind(p, known);
                else unknown.push(p);
            }

            // 缺尺寸的并发量一遍（文章封面基本都在这里，数量很少）
            let cursor = 0;
            const probeOne = (p) => new Promise((resolve) => {
                const im = new Image();
                im.onload = () => {
                    const kind = kindOf(im.naturalWidth, im.naturalHeight);
                    orient.set(p.id, kind);
                    resolve(kind);
                };
                im.onerror = () => resolve('');
                im.src = String(p.thumb || p.url);
            });
            const worker = async () => {
                while (cursor < unknown.length) {
                    const p = unknown[cursor++];
                    const kind = await probeOne(p);
                    if (kind) pushKind(p, kind);
                }
            };
            await Promise.all(new Array(8).fill(0).map(worker));

            const pools = { portrait, landscape, square };
            // 空池不缓存：图库还没回来时缓存了空结果，后面就再也补不上图
            if (portrait.length || landscape.length || square.length) this._orientPools = pools;
            return pools;
        })();
        try {
            return await this._orientPoolsPromise;
        } finally {
            this._orientPoolsPromise = null;
        }
    },

    // 竖图池：文章位用（同样不缓存空结果）
    async portraitPool() {
        if (this._portraitCache && this._portraitCache.length) return this._portraitCache;
        const pools = await this.orientationPools();
        if (pools.portrait.length) this._portraitCache = pools.portrait;
        return pools.portrait;
    },

    swapCoverPlay(item, pool) {
        const imgs = [...item.querySelectorAll('.hv3-cover-img')];
        if (imgs.length < 2) return;
        const front = imgs.find((i) => i.classList.contains('is-front')) || imgs[0];
        // 已经有「真的加载出来」的图就不再动（重试只补空着/挂掉的）
        if (front && front.getAttribute('src') && front.naturalWidth) return;
        const back = imgs.find((i) => i !== front) || imgs[1];
        const p = pool[Math.floor(Math.random() * pool.length)];
        const src = String(p && (p.thumb || p.url) || '');
        if (!src || back.dataset.src === src) return;
        back.dataset.src = src;
        // 这张图马上要显示，别走懒加载的观察队列
        back.loading = 'eager';
        let done = false;
        const swap = () => {
            if (done) return;
            done = true;
            back.classList.add('is-front');
            front.classList.remove('is-front');
            const w = back.naturalWidth;
            const h = back.naturalHeight;
            if (w && h) item.style.setProperty('--cover-ratio', String(w / h));
            // 图真的上来了才摘占位（之前在这里同步判断 src，图片还没加载完就摘不掉）
            item.classList.remove('is-waiting-cover');
            // 换上去的图比例可能和上一张差很多：盒子宽高要跟着重算，
            // 否则竖图会被塞进一个横向的框里、缩成一条
            this.syncCarouselHeight();
        };
        back.addEventListener('load', swap, { once: true });
        // 这张图加载失败：从池子里另挑一张重试（最多 3 次），别让卡片停在空白
        let tries = 0;
        back.addEventListener('error', function retry() {
            if (tries >= 3 || !pool.length) return;
            tries++;
            const next = pool[Math.floor(Math.random() * pool.length)];
            const nextSrc = String(next && (next.thumb || next.url) || '');
            if (!nextSrc) return;
            back.dataset.src = nextSrc;
            back.addEventListener('load', swap, { once: true });
            back.addEventListener('error', retry, { once: true });
            back.src = nextSrc;
        }, { once: true });
        back.src = src;
        if (back.complete && back.naturalWidth) swap();
    },

    // 图库预热：页面一进来就拉列表，并把前几张竖图/横图的缩略图先下进浏览器缓存。
    // 首页那两块（文章位竖图、生活切片横图）渲染时就直接命中缓存，不用干等下载。
    // 注意这里用的 URL 必须和渲染时完全一致（都是 p.thumb 原样），否则命中不了缓存。
    warmGallery() {
        if (this._galleryWarm) return;
        this._galleryWarm = true;
        this.loadGalleryImages().then((list) => {
            if (!Array.isArray(list) || !list.length) return;
            const sized = list.filter((p) => p && Number(p.width) > 0 && Number(p.height) > 0 && (p.thumb || p.url));
            const take = (arr, n) => arr.slice(0, n).forEach((p) => {
                const src = String(p.thumb || p.url || '');
                if (!src) return;
                const img = new Image();
                img.decoding = 'async';
                img.referrerPolicy = 'no-referrer';
                img.src = src;
            });
            take(sized.filter((p) => Number(p.height) > Number(p.width)), 12);   // 备给文章位
            take(sized.filter((p) => Number(p.width) >= Number(p.height)), 4);   // 备给生活切片
            take(sized.filter((p) => {
                const r = Number(p.width) / Number(p.height);
                return r >= 0.85 && r <= 1.18;                                    // 备给方图盒子
            }), 4);
        }).catch(() => { /* 预热失败不影响正常加载 */ });
    },

    // 方图盒子和左边的横图等高：把横图的实际高度写成方盒的宽度（方形）
    syncSquareSize() {
        const shot = document.getElementById('hv3Shots');
        const sq = document.getElementById('hv3Square');
        if (!shot || !sq) return;
        const h = Math.round(shot.getBoundingClientRect().height);
        if (h > 0) sq.style.width = Math.min(h, 240) + 'px';
    },

    // 整块轮播的尺寸跟着当前封面走：竖图窄而高、横图宽而扁（宽高都由封面比例算）
    syncCarouselHeight() {
        const carousel = document.getElementById('hv3Car');
        const track = document.getElementById('hv3Track');
        if (!carousel || !track) return;
        const items = [...track.querySelectorAll('.hv3-item')];
        if (!items.length) return;
        // 可用宽度取整行（.hv3-row-main）的宽度。
        // 不能用 carousel.parentElement / track —— 左边那张卡的宽度正是下面算出来的
        // --car-w，拿它当基准就是自己算自己，会一直塌到 0。
        const row = document.querySelector('.hv3-row-main');
        // 视图被 display:none 时整行宽度是 0：这时候别算，否则会拿 innerWidth 兜底，
        // 把盒子算成一个临时尺寸，切回来再改一次 —— 看着就是"闪一下"
        if (row && !row.clientWidth) return;
        const rowW = (row && row.clientWidth) || window.innerWidth;
        // 当前是第几张由播放器决定（不再是横向滚动位置）
        const idx = this._postPlay ? this._postPlay.idx : 0;
        const card = items[Math.min(items.length - 1, Math.max(0, idx))] || items[0];
        if (!card) return;
        // --cover-ratio = 宽 / 高（renderHvPosts 按封面原始尺寸写入，缺省 1.6）
        // 不夹比例：极窄的竖图也得按真实比例摆，否则盒子比图宽、contain 之后两侧露白边
        const rawRatio = Number((card.style.getPropertyValue('--cover-ratio') || '').trim()) || 1.6;
        const ratio = Math.max(0.2, Math.min(4, rawRatio));

        let w;
        let h;
        if (window.innerWidth <= 900) {
            // 手机上文章位只播竖图，纵向空间金贵、横向更宽裕：
            // 先按「占满可用宽度」摆（盒子比原来大得多），太高再收窄；
            // 配合 CSS 里同一断点的 object-fit: contain，整张竖图完整可见、不裁边。
            const maxH = Math.min(window.innerHeight * 0.72, 620);
            w = Math.round(rowW);
            h = Math.round(w / ratio);
            if (h > maxH) { h = Math.round(maxH); w = Math.round(h * ratio); }
        } else {
            // 桌面：先定高度基准，宽度按封面比例算 ——
            // 竖图越窄，左边卡片越窄，右边那块（flex:1）就自动变长；
            // 宽度上限按整行宽度减掉右列底线来算，别把右边挤没了。
            const baseH = Math.min(window.innerHeight * 0.62, 560);
            h = Math.round(baseH);
            w = Math.round(h * ratio);
            const maxW = Math.max(220, rowW - 260);
            if (w > maxW) { w = maxW; h = Math.round(w / ratio); }
        }
        if (h < 120 || w < 120) return;

        if (Math.abs(w - Number(carousel.dataset.w || 0)) > 1 || Math.abs(h - Number(carousel.dataset.h || 0)) > 1) {
            carousel.style.setProperty('--car-w', w + 'px');
            carousel.style.setProperty('--car-h', h + 'px');
            carousel.dataset.w = String(w);
            carousel.dataset.h = String(h);
        }
        // 左边盒子高度变了，右边（切片 + 简报）跟着对齐
        this.syncMainRowHeight();
    },

    /* 第二行右侧（生活切片 + 今日拾光）的总高度 = 左边文章盒子的高度：
       文章盒子因为封面比例变矮时，简报那块跟着缩、内容在内部滚，
       不会把整行撑高、也不会在左下留一块空白。 */
    syncMainRowHeight() {
        const car = document.getElementById('hv3Car');
        const col = document.querySelector('.hv3-row-main .hv3-col-right');
        if (!car || !col) return;
        if (window.innerWidth <= 900) {
            col.style.maxHeight = '';
            return;
        }
        const h = Math.round(car.getBoundingClientRect().height);
        col.style.maxHeight = h > 0 ? h + 'px' : '';
        // 简报可能被挤得很小 —— 那样就把它挪到日历旁边去（见 syncTodaySideSlot）
        this.syncTodaySideSlot();
    },

    // 轮播：按钮翻页 + 自动播放（尊重系统"减少动效"，tab 隐藏时暂停）
    bindCarousel() {
        const track = document.getElementById('hv3Track');
        if (!track || track.dataset.carBound) return;
        track.dataset.carBound = '1';

        const motionMq = window.matchMedia
            ? window.matchMedia('(prefers-reduced-motion: reduce)')
            : null;
        const reduced = () => !!(motionMq && motionMq.matches);
        const scrollBehavior = () => (reduced() ? 'auto' : 'smooth');

        // 滚动过程中用 rAF 跟手同步高度（平滑滚动期间也能跟上）+ 指示点
        let rafPending = false;
        track.addEventListener('scroll', () => {
            if (rafPending) return;
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                this.syncCarouselHeight();
                this.syncCarouselDots();
            });
        }, { passive: true });

        // 视口变化后可用宽度变了，尺寸要重算（宽高都跟封面走，不能只靠 CSS）
        let resizePending = false;
        window.addEventListener('resize', () => {
            if (resizePending) return;
            resizePending = true;
            requestAnimationFrame(() => {
                resizePending = false;
                this.syncCarouselHeight();
            });
        }, { passive: true });

        const step = () => {
            const first = track.querySelector('.hv3-item');
            const w = first ? first.getBoundingClientRect().width : track.clientWidth / 2;
            return Math.max(120, w);
        };

        const slide = (dir) => {
            const w = step();
            const max = track.scrollWidth - track.clientWidth;
            if (max <= 4) return;
            let next = track.scrollLeft + dir * w;
            if (next > max - 4) next = 0;            // 到底回开头，循环
            if (next < 0) next = max;
            track.scrollTo({ left: next, behavior: scrollBehavior() });
            setTimeout(() => this.syncCarouselHeight(), 260);
            setTimeout(() => this.syncCarouselHeight(), 620);
            setTimeout(() => this.syncCarouselDots(), 260);
        };

        // 跳到第 i 张（指示点点击）
        const goTo = (i) => {
            const items = [...track.querySelectorAll('.hv3-item')];
            if (!items[i]) return;
            track.scrollTo({ left: items[i].offsetLeft, behavior: scrollBehavior() });
            setTimeout(() => this.syncCarouselHeight(), 260);
            setTimeout(() => this.syncCarouselDots(), 260);
        };

        document.getElementById('hv3Car')?.addEventListener('click', (e) => {
            const dot = e.target.closest('[data-car-index]');
            if (dot) {
                e.preventDefault();
                goTo(Number(dot.dataset.carIndex) || 0);
                restartAuto();
                return;
            }
            const btn = e.target.closest('[data-car-dir]');
            if (!btn) return;
            e.preventDefault();
            slide(Number(btn.dataset.carDir) || 1);
            restartAuto();
        });

        // 自动播放：8 秒一张；悬停/聚焦暂停；reduced-motion 与 tab 隐藏不播
        let timer = 0;
        let hoverPaused = false;
        const startAuto = () => {
            clearInterval(timer);
            if (reduced() || hoverPaused || document.hidden) return;
            timer = setInterval(() => {
                // 面板被切到「照片」时轮播是 display:none，别白白翻页
                const t = document.getElementById('hv3Track');
                if (t && t.clientWidth) slide(1);
            }, 60000);
        };
        const restartAuto = () => startAuto();
        const carousel = document.getElementById('hv3Car');
        if (carousel) {
            carousel.addEventListener('mouseenter', () => { hoverPaused = true; clearInterval(timer); });
            carousel.addEventListener('mouseleave', () => { hoverPaused = false; startAuto(); });
            carousel.addEventListener('focusin', () => { hoverPaused = true; clearInterval(timer); });
            carousel.addEventListener('focusout', (e) => {
                if (carousel.contains(e.relatedTarget)) return;
                hoverPaused = false;
                startAuto();
            });
        }
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) clearInterval(timer);
            else startAuto();
        });
        // 用户中途改系统"减少动效"设置也立即生效
        if (motionMq && motionMq.addEventListener) {
            motionMq.addEventListener('change', () => startAuto());
        }
        startAuto();
    },

    // 分页指示点：按当前卡片数重建（单张隐藏），滚动后高亮当前张
    syncCarouselDots() {
        const track = document.getElementById('hv3Track');
        const dotsWrap = document.getElementById('hv3Dots');
        if (!track || !dotsWrap) return;
        const items = [...track.querySelectorAll('.hv3-item')];
        if (items.length < 2) {
            dotsWrap.hidden = true;
            dotsWrap.innerHTML = '';
            return;
        }
        dotsWrap.hidden = false;
        // 数量变了才重建，避免每次滚动刷 DOM
        if (dotsWrap.childElementCount !== items.length) {
            dotsWrap.innerHTML = items.map((_, i) =>
                '<button type="button" class="hv3-dot" data-car-index="' + i
                + '" aria-label="第 ' + (i + 1) + ' 张，共 ' + items.length + ' 张"></button>'
            ).join('');
        }
        const idx = Math.round(track.scrollLeft / (track.clientWidth || 1));
        const active = Math.min(items.length - 1, Math.max(0, idx));
        dotsWrap.querySelectorAll('.hv3-dot').forEach((d, i) => {
            d.setAttribute('aria-current', i === active ? 'true' : 'false');
        });
    },

    // 生活切片：从整个图库里随机抽图，一直播（双层交叉淡入，点一下看大图）
    async renderHvPhotos() {
        const stage = document.getElementById('hv3Shots');
        if (!stage || stage.dataset.loaded) return;
        stage.dataset.loaded = '1';

        let photos = [];
        try {
            // 只播横图池：竖图一律留给左边的文章位（左竖右横，不再有模糊地带）。
            // 池子是「确定」的（方向来自接口的 width/height），宁可等它攒好，也不拿竖图凑数。
            const pools = await Promise.race([
                this.orientationPools(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000)),
            ]);
            photos = pools.landscape.slice();
        } catch (e) {
            photos = [];
        }

        if (!photos.length) {
            // 没有横图：就一直停着等（不拿竖图/方图凑数），5 秒后再看一眼池子
            stage.dataset.waiting = '1';
            clearTimeout(this._hvPhotosRetry);
            this._hvPhotosRetry = setTimeout(() => {
                stage.dataset.loaded = '';
                this._orientPools = null;
                this.renderHvPhotos();
            }, 5000);
            return;
        }
        stage.dataset.waiting = '';

        const layers = [...stage.querySelectorAll('.hv3-shot-img')];
        if (layers.length < 2) return;
        // 面板切换回来时靠它重算尺寸
        this._shotStage = stage;
        this._shotFrontImg = null;
        const meta = document.getElementById('hv3ShotMeta');
        const total = photos.length;
        let front = 0;
        let cur = -1;
        // 图片方向缓存（id → 'landscape' | 'portrait'）：图库里没有宽高元数据，
        // 只能等图片加载出来量 naturalWidth/Height。量过一次就记住，后面挑图直接跳过竖图。
        this._shotOrient = this._shotOrient || new Map();
        const orient = this._shotOrient;
        // 竖图连续跳过太多次（说明图库几乎全是竖图）就认栽，别死循环
        let skips = 0;

        // 尺寸算出来之前先把盒子藏住，避免用兜底比例先闪一下"大空框"
        stage.style.visibility = 'hidden';
        let revealed = false;
        const revealBox = () => {
            if (revealed) return;
            revealed = true;
            stage.style.visibility = '';
        };
        setTimeout(revealBox, 6000);

        // 盒子宽高严格等于当前图的真实像素比例（不 clamp ratio，否则会裁掉一边）：
        // 在列宽与高度上限内尽量放大，放不下就等比缩小 —— 图永远完整可见
        const fitShotBox = (img) => {
            if (this.fitShotBoxTo(stage, img) !== false) revealBox();
        };

        const show = (idx) => {
            const p = photos[idx];
            if (!p) return;
            const prev = layers[front];
            const next = layers[1 - front];
            const src = String(p.thumb || p.url);
            let done = false;
            const swap = () => {
                if (done) return;
                done = true;
                skips = 0;
                next.classList.add('is-front');
                prev.classList.remove('is-front');
                front = 1 - front;
                fitShotBox(next);
                this._shotFrontImg = next;
                // 播到「某篇文章的横图封面」时，把那篇文章的标题一起带过来；
                // 普通图库照片没有标题，这个文字块就收起来
                const capEl = document.getElementById('hv3ShotCap');
                if (capEl) {
                    const cap = p.__cap || '';
                    capEl.textContent = cap;
                    capEl.hidden = !cap;
                }
            };
            // 图片已经加载完（或本来就在这一层）才判方向：
            // 竖图统一让给文章卡片的封面位，这里只播横图（宽 ≥ 高）。
            const accept = () => {
                if (done) return;
                const nw = next.naturalWidth;
                const nh = next.naturalHeight;
                if (nw && nh) {
                    const r = nw / nh;
                    const kind = r >= 0.85 && r <= 1.18 ? 'square' : (r > 1.18 ? 'landscape' : 'portrait');
                    orient.set(p.id, kind);
                    // 池子里本来就只有横图，这里是兜底：量出来不是横图就换下一张，
                    // 绝不将就着把竖图/方图放到这块横图位上
                    if (kind !== 'landscape') {
                        skips++;
                        if (skips < Math.max(4, total)) nextShot();
                        return;
                    }
                }
                skips = 0;
                swap();
            };
            if (next.dataset.src === src) { accept(); return; }
            next.dataset.src = src;
            next.addEventListener('load', accept, { once: true });
            next.addEventListener('error', () => {
                // 坏图直接跳过，换下一张（节流避免连续失败刷屏）
                setTimeout(() => { if (!done) nextShot(); }, 600);
            }, { once: true });
            next.src = src;
            if (next.complete && next.naturalWidth) accept();
        };

        const nextShot = () => {
            if (total === 1) { show(0); return; }
            // 已经量过方向的横图够多就只在它们里面挑，省掉「加载出来发现是竖图再跳过」的空转
            const known = [];
            for (let i = 0; i < total; i++) {
                if (orient.get(photos[i].id) === 'landscape') known.push(i);
            }
            let n;
            if (known.length >= 8) {
                n = known[Math.floor(Math.random() * known.length)];
            } else {
                n = Math.floor(Math.random() * total);
            }
            // 别连着放同一张
            for (let i = 0; i < 6 && n === cur; i++) n = Math.floor(Math.random() * total);
            cur = n;
            show(cur);
        };

        nextShot();
        // 面板切到「文章」时这块是 display:none（宽度 0），不白白换图
        const timer = setInterval(() => {
            if (document.hidden) return;
            if (!stage.clientWidth) return;
            nextShot();
        }, 60000);

        // 视口变化后可用宽度变了，尺寸要重算（与轮播 resize 一致）
        let resizePending = false;
        window.addEventListener('resize', () => {
            if (resizePending) return;
            resizePending = true;
            requestAnimationFrame(() => {
                resizePending = false;
                const frontImg = layers[front];
                if (frontImg && frontImg.naturalWidth) fitShotBox(frontImg);
            });
        }, { passive: true });

        stage.addEventListener('click', () => {
            const p = photos[cur];
            if (!p) return;
            window.__galleryImages = photos;
            if (typeof window.openGalleryLightbox === 'function') {
                window.openGalleryLightbox(p.url || p.thumb, cur);
            }
        });
        stage.title = '点击看大图';
        stage.dataset.timer = String(timer);
    },

    // 生活切片：把盒子宽高设成图片真实比例（可用宽 × 高度上限内等比内切）
    // 返回 false 表示这次算不了（图没加载 / 面板被隐藏宽度为 0）
    fitShotBoxTo(stage, img) {
        if (!stage || !img) return false;
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        if (!nw || !nh) return false;
        const parent = stage.parentElement;
        let availW = (parent && parent.clientWidth) || stage.clientWidth;
        // 右边还有个方图盒子：可用宽度要把它和间距扣掉，否则横图会顶到它身上
        const sq = document.getElementById('hv3Square');
        if (sq && sq.getBoundingClientRect().width > 0) {
            availW -= sq.getBoundingClientRect().width + 14;
        }
        if (!availW || availW <= 0) availW = stage.clientWidth;
        if (!availW) return false;
        const ratio = nw / nh; // 真实宽高比，不 clamp
        // 高度上限与 CSS 的 --shot-max-h 保持一致（窄屏收一档），否则 max-height 会把比例压歪
        const maxH = window.innerWidth <= 900
            ? Math.min(window.innerHeight * 0.52, 380)
            : Math.min(window.innerHeight * 0.56, 430);

        let w = availW;
        let h = Math.round(w / ratio);
        if (h > maxH) {
            h = Math.round(maxH);
            w = Math.round(h * ratio);
        }
        if (h < 60 || w < 60) return false;
        if (w === Number(stage.dataset.w) && h === Number(stage.dataset.h)) {
            this.syncSquareSize();
            return true;
        }

        stage.style.setProperty('--shot-w', w + 'px');
        stage.style.setProperty('--shot-h', h + 'px');
        // 原始比例给 CSS 兜底：JS 尺寸没生效时盒子形状也还是这张图的比例
        stage.style.setProperty('--shot-ar', String(Math.round(ratio * 10000) / 10000));
        stage.dataset.w = String(w);
        stage.dataset.h = String(h);
        // 方图盒子和它等高
        this.syncSquareSize();
        return true;
    },

    // 面板切回来时重算当前那张图的尺寸（隐藏期间宽度是 0，算不了）
    refitShotBox() {
        if (this._shotStage && this._shotFrontImg) {
            this.fitShotBoxTo(this._shotStage, this._shotFrontImg);
        }
    },

    // 左列「文章 / 照片」切换：一次只露一个
    bindStageTabs() {
        const body = document.getElementById('hv3StageBody');
        const tabs = [...document.querySelectorAll('.hv3-stage-tab')];
        if (!body || !tabs.length || body.dataset.tabsBound) return;
        body.dataset.tabsBound = '1';
        tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                const stage = tab.dataset.stage;
                if (!stage || body.dataset.stage === stage) return;
                body.dataset.stage = stage;
                tabs.forEach((t) => {
                    const on = t === tab;
                    t.classList.toggle('is-on', on);
                    t.setAttribute('aria-selected', on ? 'true' : 'false');
                });
                // 面板刚显示出来才有宽度，尺寸要重算
                requestAnimationFrame(() => {
                    if (stage === 'shots') this.refitShotBox();
                    else this.syncCarouselHeight();
                });
            });
        });
    },

    /* 方图盒子：只播「接近正方形」的图（宽高比 0.85~1.18）。
       一张方图都没有时挂占位一直等，不拿横图/竖图凑数 —— 有图才播。 */
    async renderHvSquare() {
        const box = document.getElementById('hv3Square');
        if (!box || box.dataset.ready) return;
        box.dataset.ready = '1';
        const layers = [...box.querySelectorAll('.hv3-square-img')];
        if (layers.length < 2) return;

        let pool = [];
        try {
            const pools = await this.orientationPools();
            pool = pools.square || [];
        } catch (e) { pool = []; }

        if (!pool.length) {
            box.dataset.waiting = '1';
            clearTimeout(this._squareRetry);
            this._squareRetry = setTimeout(() => {
                box.dataset.ready = '';
                this._orientPools = null;
                this.renderHvSquare();
            }, 5000);
            return;
        }
        box.dataset.waiting = '';

        let front = 0;
        const show = () => {
            if (document.hidden) return;
            const p = pool[Math.floor(Math.random() * pool.length)];
            const src = String((p && (p.thumb || p.url)) || '');
            if (!src) return;
            const prev = layers[front];
            const next = layers[1 - front];
            if (next.dataset.src === src) return;
            next.dataset.src = src;
            next.loading = 'eager';
            let done = false;
            const swap = () => {
                if (done) return;
                done = true;
                next.classList.add('is-front');
                prev.classList.remove('is-front');
                front = 1 - front;
            };
            next.addEventListener('load', swap, { once: true });
            next.src = src;
            if (next.complete && next.naturalWidth) swap();
        };
        show();
        clearInterval(this._squareTimer);
        this._squareTimer = setInterval(show, 60000);

        box.onclick = () => {
            const cur = layers[front];
            const src = cur ? (cur.currentSrc || cur.src || '') : '';
            if (!src) return;
            window.__galleryImages = pool;
            const idx = this.matchGalleryIndex(pool, src);
            if (typeof window.openGalleryLightbox === 'function') {
                const pick = idx >= 0 ? pool[idx] : null;
                window.openGalleryLightbox(pick ? String(pick.thumb || pick.url) : src, idx >= 0 ? idx : 0);
            }
        };
    },

    // 卡片上的绝对 URL ↔ 图库池里的相对路径：统一成绝对 URL 找到对应下标
    matchGalleryIndex(pool, src) {
        if (!Array.isArray(pool) || !pool.length) return -1;
        const abs = (u) => {
            try { return new URL(String(u || ''), location.href).href; } catch (e) { return String(u || ''); }
        };
        const want = abs(src);
        let idx = pool.findIndex((p) => abs(p && (p.thumb || p.url)) === want);
        if (idx < 0) {
            const bare = want.split('?')[0];
            idx = pool.findIndex((p) => abs(p && (p.thumb || p.url)).split('?')[0] === bare);
        }
        return idx;
    },

    // 无限滚动：滚过一半时悄悄把位置减回去，看起来永远滚不完
    makeLoopScroll(el) {
        if (!el || el.dataset.loopBound) return;
        el.dataset.loopBound = '1';
        el.addEventListener('scroll', () => {
            const half = el.scrollHeight / 2;
            if (half <= 0) return;
            if (el.scrollTop >= half) {
                el.scrollTop -= half;
            } else if (el.scrollTop < 2) {
                // 往上滚到头也接回来
                el.scrollTop += half;
            }
        }, { passive: true });
    },

    // 渲染主页（入口数字 + 今日简报 + 图库轮播 + 文章封面轮播 + 项目）
    async renderHome(force = false) {
        // 仪表盘：身份 / 数字 / 精选文章 / 照片带 / 简报 / 项目
        this.renderHomeIdentity();
        this.startHvClock();
        setTimeout(function () { BlogApp.renderHomeIdentity(); }, 1200);
        this.renderHomeNews();
        this.renderHvPosts();
        this.renderHvPhotos();
        this.renderHvSquare();
        this.renderHomeProjects();
        // 后台「项目管理」里维护的列表（见 loadProjectsData），先渲染内置那几项再替换
        this.loadProjectsData();
        this.renderHomeCta(force);


    },

    // 首页入口数字：文章数 / 图库照片数 / GitHub 项目数（接口慢或离线时显示占位）
    async renderHomeCta(force = false) {
        const postsEl = document.getElementById('homeCtaPosts');
        const photosEl = document.getElementById('homeCtaPhotos');
        const projectsEl = document.getElementById('homeCtaProjects');
        if (!postsEl && !photosEl && !projectsEl) return;

        if (postsEl && (!postsEl.dataset.rendered || force)) {
            postsEl.textContent = this.posts.length;
            postsEl.dataset.rendered = '1';
        }

        if (projectsEl && (!projectsEl.dataset.rendered || force)) {
            projectsEl.dataset.rendered = '1';
            try {
                const repos = await this.loadGithubRepos();
                projectsEl.textContent = (repos || []).length || '—';
            } catch (e) {
                projectsEl.textContent = '—';
            }
        }

        if (photosEl && (!photosEl.dataset.rendered || force)) {
            photosEl.dataset.rendered = '1';
            try {
                // 图库来自外部站点，给个上限，避免一直停在占位
                const list = await Promise.race([
                    this.loadGalleryImages(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('图库接口超时')), 15000)),
                ]);
                photosEl.textContent = (list || []).length;
            } catch (e) {
                photosEl.textContent = '—';
            }
        }
    },

    // 按发布时间倒序的文章列表
    postsSorted() {
        return [...this.posts].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    },

    // 主页文章区：最新一篇的封面大卡
    renderHomeArticles() {
        this.renderHomeFeatured(this.postsSorted()[0]);
    },

    // 封面大卡：最新一篇（横向：封面 + 文字，窄屏自动堆叠）
    renderHomeFeatured(post) {
        const box = document.getElementById('homeFeatured');
        if (!box) return;

        if (!post) {
            box.removeAttribute('href');
            box.innerHTML = '<div class="home-empty">还没有文章</div>';
            return;
        }

        const date = this.formatDate(post.date);
        const typeLabel = post.type === 'whiteboard' ? '交互白板'
            : post.type === 'mindmap' ? '思维导图'
            : post.type === 'graph' ? '节点图'
            : '博客文章';
        const tags = (post.tags || []).slice(0, 3).map(t => `<span class="home-tag">${this.esc(t)}</span>`).join('');
        const gradient = this.getGradientColors(post.tags || []);
        const icon = this.getCardIcon(post.tags || []);

        box.setAttribute('href', `article.html?post=${this.escAttr(post.filename)}&blob=${this.escAttr(post.id || '')}`);
        box.innerHTML = `
            <div class="home-feature-cover" style="background: linear-gradient(145deg, ${gradient[0]}, ${gradient[1]});">
                ${post.image
                    ? `<img src="${this.escAttr(post.image)}" alt="${this.esc(post.title)}" decoding="async" referrerpolicy="no-referrer" onerror="BlogApp.handleCoverError(this)">`
                    : `<span class="home-feature-icon">${this.esc(icon)}</span>`}
                <span class="home-feature-badge">${typeLabel}</span>
            </div>
            <div class="home-feature-body">
                <div class="home-feature-meta">${date}${tags ? ' · ' + tags : ''}</div>
                <div class="home-feature-title">${this.esc(post.title)}</div>
                <div class="home-feature-excerpt">${this.esc(post.excerpt || '')}</div>
            </div>
            <div class="home-feature-foot">阅读全文 <span class="home-feature-arrow">→</span></div>
        `;
    },

    // 主页图库轮播（一次一张，全部循环播放；观光安全：不展示 R16/R18 内容）
    async renderHomePhotos() {
        const wrap = document.getElementById('homeSlideshow');
        const panel = document.getElementById('homePhotos');
        if (!wrap || wrap.dataset.rendered) return;
        wrap.dataset.rendered = '1';

        let photos = [];
        try {
            const list = await Promise.race([
                this.loadGalleryImages(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('图库接口超时')), 15000)),
            ]);
            photos = (list || []).filter(p => !this.isR18Image(p));
        } catch (e) {
            photos = [];
        }

        // 拿不到图片就整块隐藏，避免主页出现空卡片
        if (!photos.length) {
            if (panel) panel.style.display = 'none';
            return;
        }

        this.homeSlides = photos;
        wrap.classList.remove('is-loading');
        wrap.innerHTML = `
            <a class="home-slide" id="homeSlideLink" href="#">
                <img class="home-slide-img" id="homeSlideImg" alt="" decoding="async" referrerpolicy="no-referrer">
            </a>
        `;
        const link = document.getElementById('homeSlideLink');
        if (link) link.addEventListener('click', (e) => { e.preventDefault(); this.goView('gallery'); });
        // 鼠标停在上面就暂停轮播，移开继续
        wrap.addEventListener('mouseenter', () => this.stopHomeSlideTimer());
        wrap.addEventListener('mouseleave', () => this.startHomeSlideTimer());

        this.showHomeSlide(0);
        this.startHomeSlideTimer();
    },

    // 显示第 i 张（越界自动循环），并预加载下一张
    showHomeSlide(i) {
        const photos = this.homeSlides || [];
        if (!photos.length) return;
        const idx = ((i % photos.length) + photos.length) % photos.length;
        this.homeSlideIndex = idx;

        const img = document.getElementById('homeSlideImg');
        if (!img) return;

        const photo = photos[idx];
        const src = photo.thumb || photo.url;
        if (img.getAttribute('src') !== src) {
            img.classList.remove('is-in');
            img.setAttribute('src', src);
            img.alt = photo.title || '图库图片';
            // 下一帧加类触发淡入
            requestAnimationFrame(() => img.classList.add('is-in'));
        }

        // 预加载下一张：切换时基本不用等网络（浏览器缓存命中）
        const next = photos[(idx + 1) % photos.length];
        if (next) {
            const pre = new Image();
            pre.src = next.thumb || next.url;
        }
    },

    startHomeSlideTimer() {
        this.stopHomeSlideTimer();
        if (!this.homeSlides || this.homeSlides.length < 2) return;
        this.homeSlideTimer = setInterval(() => {
            if (document.hidden) return; // 页面不可见时跳过，省流量
            this.showHomeSlide(this.homeSlideIndex + 1);
        }, 60000);
    },

    stopHomeSlideTimer() {
        if (this.homeSlideTimer) {
            clearInterval(this.homeSlideTimer);
            this.homeSlideTimer = null;
        }
    },

    // ===================== 任务 + 日记（仅后台登录可见） =====================

    lifeState: { month: '', date: '', tasks: [], journals: [], journalTimer: null },

    // 后台登录凭据（后台登录后写入 localStorage）
    lifeAdminKey() {
        try { return localStorage.getItem('admin_key') || ''; } catch (e) { return ''; }
    },

    formatDateKey(d) {
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },

    // 初始化：没登录就把任务/日记都藏起来（日历滚轮切月不受登录限制）
    async initLife() {
        // 任务 / 日记已经删掉了：这里只负责日历本身（点日期看万年历）
        const panel = document.getElementById('hv3TodayPanel');
        this.bindCalendarWheel();
        this.bindCalendarClicks();
        if (!panel) return;

        const today = this.formatDateKey(new Date());
        this.lifeState.date = today;
        this.lifeState.month = today.slice(0, 7);
        this._calViewMonth = this.lifeState.month;

        // 日历不用等登录：万年历全是本地算的，谁点都能看
        if (this.lifeAdminKey()) {
            await this.loadLifeMonth(this.lifeState.month);
        }

        // 窗口尺寸变了，日历高度跟着变，右栏的上限也要重算
        if (!this._todaySideResizeBound) {
            this._todaySideResizeBound = true;
            window.addEventListener('resize', () => this.syncTodaySideHeight(), { passive: true });
        }
        this.syncTodaySideHeight();
    },

    // 日历滚轮切换月份：登录时连带切换任务/日记归档，未登录只翻日历
    bindCalendarWheel() {
        const cal = document.getElementById('homeCalendar');
        if (!cal || cal.dataset.wheelBound) return;
        cal.dataset.wheelBound = '1';
        this._calWheelAt = 0;

        cal.addEventListener('wheel', (e) => {
            e.preventDefault();
            const now = Date.now();
            if (now - (this._calWheelAt || 0) < 320) return;
            this._calWheelAt = now;

            const delta = e.deltaY > 0 ? 1 : -1;
            const loggedIn = !!this.lifeAdminKey();

            if (loggedIn) {
                this.changeLifeMonth(delta);
                return;
            }
            // 未登录：只翻日历视图
            const base = this._calViewMonth || this.formatDateKey(new Date()).slice(0, 7);
            const [y, m] = base.split('-').map(Number);
            const d = new Date(y, m - 1 + delta, 1);
            this._calViewMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            if (typeof window.renderCalendar === 'function') window.renderCalendar(this._calViewMonth);
        }, { passive: false });
    },

    // 统一请求（自动带 X-Admin-Key）
    async lifeApi(path, options = {}) {
        const headers = { 'X-Admin-Key': this.lifeAdminKey(), ...(options.headers || {}) };
        if (options.body) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${this.config.apiBase}/api/life${path}`, {
            ...options,
            headers,
            cache: 'no-store',
        });
        if (res.status === 401) return { unauthorized: true };
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    },

    // 加载某个月（按月归档）
    async loadLifeMonth(month) {
        try {
            const data = await this.lifeApi(`?month=${encodeURIComponent(month)}`);
            if (!data || data.unauthorized) return false;
            this.lifeState.month = month;
            this.lifeState.tasks = Array.isArray(data.tasks) ? data.tasks : [];
            this.lifeState.journals = Array.isArray(data.journals) ? data.journals : [];
            this.renderLife();
            // 日历跟随归档月份重建（选中态用 lifeState.date）
            if (typeof window.renderCalendar === 'function') window.renderCalendar(month);
            return true;
        } catch (e) {
            const list = document.getElementById('lifeTaskList');
            if (list) list.innerHTML = '<div class="home-empty">加载失败，稍后再试</div>';
            return false;
        }
    },

    renderLife() {
        this.updateTodayHeader();
        this.renderAlmanac();
        this.syncTodaySideHeight();
    },

    /* ===== 万年历（点日历随时看那天） =====
       农历靠浏览器自带的 chinese 历（Intl），干支/生肖/星座/节日在本地算；
       宜忌是按十二建除做的简化推荐，图个氛围，别当黄历用。 */
    renderAlmanac() {
        const box = document.getElementById('hv3Almanac');
        if (!box) return;
        const date = this.lifeState.date || this.formatDateKey(new Date());
        const a = this.almanacInfo(date);
        box.innerHTML = `
            <div class="al-head">
                <span class="al-solar">${a.month} 月 ${a.day} 日</span>
                <span class="al-week">周${a.week} · 第 ${a.weekNo} 周</span>
            </div>
            <div class="al-lunar">${a.lunar}</div>
            <div class="al-sub">${a.ganzhiYear} · ${a.zodiac}年 · ${a.sign}</div>
            ${a.festival ? `<div class="al-fest">${a.festival}</div>` : ''}
            <div class="al-yiji">
                <div class="al-row al-yi"><b>宜</b><span>${a.yi}</span></div>
                <div class="al-row al-ji"><b>忌</b><span>${a.ji}</span></div>
            </div>
            <div class="al-foot">${a.dayMaster}</div>
        `;
    },

    almanacInfo(dateKey) {
        const [y, m, d] = String(dateKey).split('-').map(Number);
        const date = new Date(y, m - 1, d);
        const weekNames = ['日', '一', '二', '三', '四', '五', '六'];

        // 农历（浏览器原生 chinese 历）：优先 formatToParts，拿不到再退回整串匹配
        let lunar = '农历 —';
        let lunarMonth = 0;
        let lunarDay = 0;
        let lunarYear = y;
        let yearName = '';
        try {
            const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
                year: 'numeric', month: 'long', day: 'numeric',
            });
            let monthText = '';
            let dayText = '';
            try {
                fmt.formatToParts(date).forEach((p) => {
                    if (p.type === 'year' || p.type === 'relatedYear') lunarYear = Number(String(p.value).replace(/\D/g, '')) || lunarYear;
                    if (p.type === 'yearName') yearName = String(p.value);
                    if (p.type === 'month') monthText = String(p.value);
                    if (p.type === 'day') dayText = String(p.value);
                });
            } catch (e2) {
                const text = fmt.format(date);
                const m2 = text.match(/([正二三四五六七八九十冬腊]{1,3}月)/);
                const d2 = text.match(/月([初十廿卅\d一二三四五六七八九]{1,3})/);
                if (m2) monthText = m2[1];
                if (d2) dayText = d2[1];
            }
            lunarMonth = this.lunarMonthNumber(monthText);
            lunarDay = this.lunarDayNumber(dayText);
            lunar = '农历 ' + String(monthText).replace(/\d/g, '') + this.lunarDayLabel(lunarDay);
        } catch (e) { /* 老浏览器没有 chinese 历，就只显示公历 */ }

        // 干支年 + 生肖（Intl 直接给了 yearName 就用它）
        const yearGanZhi = yearName || this.ganzhiOf(lunarYear);
        const zodiac = '鼠牛虎兔龙蛇马羊猴鸡狗猪'[(((lunarYear - 4) % 12) + 12) % 12];

        // 星座
        const signs = [[1, 20, '水瓶座'], [2, 19, '双鱼座'], [3, 21, '白羊座'], [4, 20, '金牛座'], [5, 21, '双子座'], [6, 22, '巨蟹座'],
            [7, 23, '狮子座'], [8, 23, '处女座'], [9, 23, '天秤座'], [10, 24, '天蝎座'], [11, 23, '射手座'], [12, 22, '摩羯座']];
        let sign = '摩羯座';
        for (const [sm, sd, name] of signs) {
            if (m > sm || (m === sm && d >= sd)) sign = name;
        }

        // 节日：先看农历，再看公历
        const lunarFest = {
            '1-1': '春节', '1-15': '元宵节', '2-2': '龙抬头', '5-5': '端午节',
            '7-7': '七夕', '7-15': '中元节', '8-15': '中秋节', '9-9': '重阳节', '12-8': '腊八节',
        };
        const solarFest = {
            '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '4-1': '愚人节', '5-1': '劳动节',
            '5-4': '青年节', '6-1': '儿童节', '9-10': '教师节', '10-1': '国庆节', '12-24': '平安夜', '12-25': '圣诞节',
        };
        const festival = lunarFest[`${lunarMonth}-${lunarDay}`] || solarFest[`${m}-${d}`] || '';

        // 第几周（ISO 近似：按该年第一天算）
        const start = new Date(y, 0, 1);
        const weekNo = Math.ceil((((date - start) / 86400000) + start.getDay() + 1) / 7);

        // 十二建除（简化：按公历日序推），配通用宜忌
        const JIAN = [
            { name: '建', yi: '出行、上任、会友', ji: '动土、开仓' },
            { name: '除', yi: '扫舍、疗病、除旧', ji: '求财、嫁娶' },
            { name: '满', yi: '祈福、开市、交易', ji: '安葬、服药' },
            { name: '平', yi: '修饰、平治、修整', ji: '栽种、开渠' },
            { name: '定', yi: '订盟、纳采、安床', ji: '诉讼、出行' },
            { name: '执', yi: '祭祀、捕捉、立约', ji: '开市、搬迁' },
            { name: '破', yi: '破屋、求医、解除', ji: '嫁娶、开市' },
            { name: '危', yi: '安床、祭祀、静养', ji: '登高、远行' },
            { name: '成', yi: '嫁娶、开市、签约', ji: '诉讼、破土' },
            { name: '收', yi: '纳财、收纳、收账', ji: '出行、安葬' },
            { name: '开', yi: '祈福、开市、出行', ji: '安葬、动土' },
            { name: '闭', yi: '筑堤、埋穴、静修', ji: '开市、出行' },
        ];
        const dayNo = Math.floor(date.getTime() / 86400000);
        const jian = JIAN[((dayNo % 12) + 12) % 12];

        return {
            month: m,
            day: d,
            week: weekNames[date.getDay()],
            weekNo,
            lunar,
            ganzhiYear: yearGanZhi + '年',
            zodiac,
            sign,
            festival,
            yi: jian.yi,
            ji: jian.ji,
            dayMaster: `${jian.name}日 · 宜忌仅供参考`,
        };
    },

    // 数字 → 中文农历日（初八 / 廿三 / 三十）
    lunarDayLabel(n) {
        const num = Number(n);
        const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
        if (!num || num < 1) return '';
        if (num === 10) return '初十';
        if (num < 10) return '初' + digits[num];
        if (num < 20) return '十' + digits[num - 10];
        if (num === 20) return '二十';
        if (num < 30) return '廿' + digits[num - 20];
        return '三十';
    },

    // 农历月份文本 → 数字（十月 / 正月 / 腊月 / 11月…）
    lunarMonthNumber(text) {
        const t = String(text || '').replace(/月/g, '').trim();
        if (!t) return 0;
        if (/^\d+$/.test(t)) return Number(t);
        const map = { 正: 1, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 冬: 11, 十二: 12, 腊: 12 };
        return map[t] || 0;
    },

    // 中文农历日 → 数字（初一…三十；Intl 有时直接给阿拉伯数字）
    lunarDayNumber(text) {
        const t = String(text || '').trim();
        const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
        if (!t) return 0;
        if (/^\d+$/.test(t)) return Number(t);
        if (t[0] === '初') return digits[t[1]] || 0;
        if (t[0] === '十') return 10 + (digits[t[1]] || 0);
        if (t[0] === '廿') return 20 + (digits[t[1]] || 0);
        if (t[0] === '卅') return 30;
        return digits[t] || 0;
    },

    // 年份 → 干支
    ganzhiOf(year) {
        const gan = '甲乙丙丁戊己庚辛壬癸';
        const zhi = '子丑寅卯辰巳午未申酉戌亥';
        const n = ((year - 4) % 60 + 60) % 60;
        return gan[n % 10] + zhi[n % 12];
    },

    /* 右栏（任务 + 日记）不能比左边日历高：把日历实际高度写进 max-height，
       超出的部分留给任务区/日记区自己滚。 */
    syncTodaySideHeight() {
        const panel = document.getElementById('hv3TodayPanel');
        if (!panel) return;
        const cal = document.getElementById('homeCalendar');
        const side = panel.querySelector('.hv3-today-side');
        if (!cal || !side) return;
        // 手机上是竖排，不需要限高
        if (window.innerWidth <= 900 || panel.classList.contains('is-guest')) {
            side.style.height = '';
            side.style.maxHeight = '';
            return;
        }
        // 点日期后右栏换成万年历：内容比日历高，再按日历高度锁死就会把内容压变形
        const dayPane = document.getElementById('hv3DayPane');
        if (dayPane && !dayPane.hidden) {
            side.style.height = '';
            side.style.maxHeight = '';
            return;
        }
        const h = Math.round(cal.getBoundingClientRect().height);
        // 同时写 height 和 max-height：只写 max-height 时右栏的 height 仍是 auto，
        // 里面「日记展开占 52%」这类百分比 flex-basis 会失效（变成按内容高度）。
        side.style.height = h > 0 ? h + 'px' : '';
        side.style.maxHeight = h > 0 ? h + 'px' : '';
    },

    // 「今天」卡头部的日期（日历选中哪天就写哪天）
    updateTodayHeader() {
        const el = document.getElementById('todayDateLabel');
        if (!el) return;
        const date = this.lifeState.date || this.formatDateKey(new Date());
        el.textContent = this.formatDateLabel(date);
    },

    formatDateLabel(date) {
        if (!date) return '';
        const [y, m, d] = date.split('-');
        const weekday = new Date(`${date}T00:00:00`).getDay();
        const names = ['日', '一', '二', '三', '四', '五', '六'];
        return `${Number(m)} 月 ${Number(d)} 日 · 周${names[weekday]}`;
    },

    // 任务展示盒子：没有任务就整块折叠
    renderLifeTasks() {
        const box = document.getElementById('homeLife');
        const list = document.getElementById('lifeTaskList');
        const countEl = document.getElementById('lifeTaskCount');
        if (!box || !list) return;

        const tasks = (this.lifeState.tasks || []).filter(t => t.date === this.lifeState.date);
        if (countEl) {
            const done = tasks.filter(t => t.done).length;
            countEl.textContent = tasks.length ? `${done}/${tasks.length}` : '';
        }

        if (!tasks.length) {
            // 这天没有任务就整块收起，不放占位文案
            box.style.display = 'none';
            list.innerHTML = '';
            return;
        }

        box.style.display = '';
        list.innerHTML = tasks.map(t => `
            <div class="life-task${t.done ? ' is-done' : ''}" data-id="${this.escAttr(t.id)}">
                <button class="life-task-check" type="button" title="切换完成">${t.done ? '✓' : ''}</button>
                <span class="life-task-title">${this.esc(t.title)}</span>
                <button class="life-task-del" type="button" title="删除">×</button>
            </div>
        `).join('');
    },

    // 日记：当月所有日记叠成一摞（和「项目」同一套文件堆叠），滚轮翻，点最上面那张编辑
    renderJournalStack() {
        const box = document.getElementById('hv3Journals');
        const wrap = document.getElementById('homeJournalBox');
        if (!box) return;
        const month = this.lifeState.month || '';
        const monthEl = document.getElementById('journalMonthLabel');
        if (monthEl) {
            const [y, m] = month.split('-');
            monthEl.textContent = y ? `${y} 年 ${Number(m)} 月` : '';
        }
        if (wrap && !month) {
            wrap.style.display = 'none';
            return;
        }

        // 只显示「当前选中那天」的日记，不再把整月做成文件摞
        const date = this.lifeState.date || '';
        const item = (this.lifeState.journals || []).find(j => j && j.date === date && j.content);
        // 这天没日记就整块不显示（原来那张「这天还没写日记」的空卡不要了）：
        // 想写日记点日历左边的「日记」按钮
        if (!item) {
            box.innerHTML = '';
            if (wrap) wrap.style.display = 'none';
            return;
        }
        box.innerHTML = this.journalCard(item);
        if (wrap) wrap.style.display = '';
    },

    // 单篇日记卡：日期 + 摘要（4 行截断）+ 字数
    journalCard(j) {
        const text = String(j.content || '');
        const len = text.replace(/\s+/g, '').length;
        const brief = text.replace(/\n+/g, ' ').trim().slice(0, 160);
        return `<button class="hv3-journal" type="button" data-journal-date="${this.escAttr(j.date)}">
            <div class="hv3-journal-head">
                <span class="hv3-journal-date">${this.esc(this.formatDateLabel(j.date))}</span>
                <span class="hv3-journal-len">${len} 字</span>
            </div>
            <div class="hv3-journal-body">${this.esc(brief)}${text.length > 160 ? '…' : ''}</div>
            <div class="hv3-journal-foot">点开编辑</div>
        </button>`;
    },

    // 让日记堆叠翻到指定日期那一张（堆叠里没有这天就保持不动）
    syncJournalStack(date) {
        const box = document.getElementById('hv3Journals');
        if (!box || typeof box.hvStackGoTo !== 'function') return;
        const cards = [...box.children];
        const idx = cards.findIndex(c => c.dataset.journalDate === date);
        if (idx >= 0) box.hvStackGoTo(idx);
    },

    // 选择日期（日历点击）：右边换成「任务 + 当天日记」；再点同一天就收起来
    selectLifeDate(date) {
        if (!date) return;

        const day = document.getElementById('hv3DayPane');
        const paneOpen = !!day && !day.hidden;
        // 再点一次已经选中的那天：收起右栏、左边两个按钮消失、右边回到项目栏
        if (paneOpen && date === this.lifeState.date) {
            this.closeEditor();
            this.showDayPane(false);
            this.updateSelectedCalCell();
            return;
        }

        const month = date.slice(0, 7);
        this.lifeState.date = date;
        this.showDayPane(true);
        const after = () => {
            this.renderLife();
            this.updateSelectedCalCell();
            // 不再自动弹出「任务 / 日记」选择层：写东西走日历左边那两个按钮
        };
        if (month !== this.lifeState.month) {
            // 万年历是本地算的：换月的数据没拿到也照样渲染
            this.loadLifeMonth(month).catch(() => { }).then(() => after());
            return;
        }
        after();
    },

    /* 日历右边那块地方切换：
       on=true  → 显示「任务 + 日记」（点日期之后）
       on=false → 显示项目栏（默认） */
    showDayPane(on) {
        const proj = document.getElementById('hv3ProjectsBox');
        const day = document.getElementById('hv3DayPane');
        if (!proj || !day) return;
        proj.hidden = !!on;
        day.hidden = !on;
        // 卡片上的标记：点过日期后右栏切成万年历
        const panel = document.getElementById('hv3TodayPanel');
        if (panel) panel.classList.toggle('is-day-pane', !!on);
        this.syncTodaySideHeight();
        if (!on) this.syncTodaySideSlot();
    },

    /* 日历右边那块地方到底放什么：
       · 用户点了日期 → 放「任务 + 当天日记」（showDayPane 负责）
       · 没点日期时 → 默认放项目栏；
         但如果第二行的简报被挤得非常小（高度 < 140px），说明右边这列高度不够用了，
         就把简报挪进来，让它在日历旁边铺开 —— 比缩成一条缝好看。 */
    syncTodaySideSlot() {
        const side = document.querySelector('.hv3-today-side');
        const row = document.querySelector('.hv3-row-bottom');
        const proj = document.getElementById('hv3ProjectsBox');
        const day = document.getElementById('hv3DayPane');
        const news = document.querySelector('.hv3-news');
        if (!side || !row || !proj || !day || !news) return;
        if (!day.hidden) return;   // 点了日期，交给任务/日记

        /* 判断依据只用「跟简报位置无关」的量：
           · 文章卡高度（= 右列 max-height，JS 写在 style 上）
           · 上半部分（横图 + 方盒）的实际高度
           · 一条新闻的高度
           这样搬进搬出都不会让判断值跟着变，不会来回抽搐。
           只有连一条都放不下（可用高度 < 单条高度）才算"被遮挡"，才搬。 */
        const col = document.querySelector('.hv3-row-main .hv3-col-right');
        const colMax = col ? (parseInt(col.style.maxHeight || '0', 10) || 0) : 0;
        const topRow = col ? col.querySelector('.hv3-top-row') : null;
        const topH = topRow ? topRow.getBoundingClientRect().height : 0;
        const firstItem = news.querySelector('.hv3-news-item');
        const itemH = firstItem ? firstItem.getBoundingClientRect().height : 0;
        const availForNews = colMax - topH - 18;   // 18 = 右列的 gap
        const cramped = colMax > 0 && itemH > 0 && availForNews < itemH + 4;
        if (this._crampedNews === cramped) return;   // 状态没变就别反复搬 DOM
        this._crampedNews = cramped;

        if (cramped) {
            // 连一条新闻都露不出来 → 挪到日历右边铺开；项目栏让到日历卡下面，别凭空消失
            if (!this._newsHome) this._newsHome = { parent: news.parentElement, next: news.nextSibling };
            side.appendChild(news);
            proj.hidden = false;
            if (proj.parentElement !== row) row.appendChild(proj);
        } else {
            // 能露出至少一条 → 简报留在原位；项目栏回到日历右边
            if (proj.parentElement !== side) side.insertBefore(proj, side.firstChild);
            proj.hidden = false;
            if (this._newsHome && news.parentElement === side) {
                this._newsHome.parent.insertBefore(news, this._newsHome.next);
            }
        }
        // 右栏高度跟着重算（搬进/搬出简报后都要）
        this.syncTodaySideHeight();
    },

    // 更新日历选中态
    updateSelectedCalCell() {
        document.querySelectorAll('#homeCalendar .cal-day').forEach(el => {
            el.classList.toggle('is-selected', el.dataset.date === this.lifeState.date);
        });
    },

    // 日历底部的「＋任务 / ✎日记」：跳过"选类型"这一步，直接打开对应表单
    // 日期 = 当前选中那天（没选过就是今天；翻到归档月就是那月 1 号）
    openLifeEditor(kind) {
        if (!this.lifeAdminKey()) return;
        const wrap = document.getElementById('homeEditorWrap');
        if (!this.lifeState.date) {
            this.lifeState.date = this.formatDateKey(new Date());
            this.lifeState.month = this.lifeState.date.slice(0, 7);
        }
        const open = () => {
            this.renderLife();
            this.updateSelectedCalCell();
            this.openEditor();
            this.chooseEditorKind(kind);
        };
        const month = this.lifeState.date.slice(0, 7);
        if (month !== this.lifeState.month) {
            // 换月的数据没拿到也照样把编辑器打开：不然点了按钮毫无反馈
            this.loadLifeMonth(month).catch(() => { }).then(() => open());
            return;
        }
        if (!wrap) return;
        open();
    },

    // 打开编写盒子（第一步：选「任务 / 日记」）
    openEditor() {
        if (!this.lifeAdminKey()) return;
        const wrap = document.getElementById('homeEditorWrap');
        if (!wrap) return;
        const taskForm = document.getElementById('editorTaskForm');
        const journalForm = document.getElementById('editorJournalForm');
        if (taskForm) taskForm.style.display = 'none';
        if (journalForm) journalForm.style.display = 'none';

        // 小弹窗：绝对定位浮在日历下方，不参与布局
        wrap.classList.add('is-open');
        // 日历常常在视口下半部分，弹窗一开就落在屏幕外面 —— 看着像「点了没反应」，先把它滚进来
        setTimeout(() => {
            if (!wrap.classList.contains('is-open')) return;
            const r = wrap.getBoundingClientRect();
            if (r.bottom > window.innerHeight - 12 || r.top < 12) {
                try { wrap.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { wrap.scrollIntoView(); }
            }
        }, 80);
    },

    // 点「任务 / 日记」→ 换成对应编写表单
    chooseEditorKind(kind) {
        const taskForm = document.getElementById('editorTaskForm');
        const journalForm = document.getElementById('editorJournalForm');

        if (kind === 'task') {
            if (journalForm) journalForm.style.display = 'none';
            if (taskForm) taskForm.style.display = '';
            const input = document.getElementById('editorTaskInput');
            if (input) {
                input.value = '';
                setTimeout(() => input.focus(), 40);
            }
            return;
        }

        if (taskForm) taskForm.style.display = 'none';
        if (journalForm) journalForm.style.display = '';
        const entry = (this.lifeState.journals || []).find(j => j.date === this.lifeState.date);
        // 只有这天已经写过日记，才出现「删除」
        const del = journalForm ? journalForm.querySelector('[data-journal-delete]') : null;
        if (del) del.hidden = !(entry && entry.content);
        const ta = document.getElementById('editorJournalInput');
        if (ta) {
            ta.value = entry ? entry.content : '';
            setTimeout(() => ta.focus(), 40);
        }
    },

    // 关闭编写盒子（提交或 ×）：高度收回，下方内容回弹
    closeEditor() {
        const wrap = document.getElementById('homeEditorWrap');
        if (wrap) wrap.classList.remove('is-open');
    },

    // 提交任务
    async submitEditorTask() {
        const input = document.getElementById('editorTaskInput');
        const title = (input && input.value ? input.value : '').trim();
        if (!title) {
            this.closeEditor();
            return;
        }
        try {
            const data = await this.lifeApi('', {
                method: 'POST',
                body: JSON.stringify({ type: 'task', date: this.lifeState.date, title }),
            });
            if (data && data.task) this.lifeState.tasks.push(data.task);
        } catch (err) {
            return; // 失败保留输入
        }
        if (input) input.value = '';
        this.renderLife();
        this.closeEditor();
    },

    // 提交日记
    async submitEditorJournal() {
        const ta = document.getElementById('editorJournalInput');
        const content = ta ? ta.value : '';
        try {
            const data = await this.lifeApi('', {
                method: 'POST',
                body: JSON.stringify({ type: 'journal', date: this.lifeState.date, content }),
            });
            if (!data || data.unauthorized) return;
            const list = this.lifeState.journals;
            const idx = list.findIndex(j => j.date === this.lifeState.date);
            if (data.journal) {
                if (idx >= 0) list[idx] = data.journal;
                else list.push(data.journal);
            } else if (idx >= 0) {
                list.splice(idx, 1);
            }
        } catch (err) {
            return;
        }
        this.renderLife();
        this.closeEditor();
    },

    // 删除当天日记（编辑器里的「删除」，删完关窗）
    async deleteJournal() {
        const date = this.lifeState.date;
        if (!date) return;
        let data;
        try {
            data = await this.lifeApi(`?type=journal&date=${encodeURIComponent(date)}`, { method: 'DELETE' });
        } catch (err) {
            return; // 失败保留窗口，用户可以再试
        }
        if (data && data.unauthorized) return;
        this.lifeState.journals = (this.lifeState.journals || []).filter(j => j.date !== date);
        this.renderJournalStack();
        this.closeEditor();
    },

    // 任务列表的完成 / 删除
    async onLifeTaskClick(e) {
        const row = e.target.closest('.life-task');
        if (!row) return;
        const id = row.dataset.id;
        const task = this.lifeState.tasks.find(t => t.id === id);
        if (!task) return;

        if (e.target.closest('.life-task-del')) {
            try {
                await this.lifeApi(`?type=task&date=${task.date}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
                this.lifeState.tasks = this.lifeState.tasks.filter(t => t.id !== id);
                this.renderLifeTasks();
            } catch (err) { /* 忽略 */ }
            return;
        }

        if (e.target.closest('.life-task-check')) {
            const done = !task.done;
            try {
                await this.lifeApi('', {
                    method: 'POST',
                    body: JSON.stringify({ type: 'task', id, date: task.date, done }),
                });
                task.done = done;
                this.renderLifeTasks();
            } catch (err) { /* 忽略 */ }
        }
    },

    // 切换月份浏览归档
    async changeLifeMonth(delta) {
        const [y, m] = this.lifeState.month.split('-').map(Number);
        const d = new Date(y, m - 1 + delta, 1);
        const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const today = this.formatDateKey(new Date());
        this.lifeState.date = month === today.slice(0, 7) ? today : `${month}-01`;
        this._calViewMonth = month;
        await this.loadLifeMonth(month);
    },

    // 日历点击（登录前也绑上：未登录时点日期至少给提示，别让人以为日历坏了）
    bindCalendarClicks() {
        const panel = document.getElementById('hv3TodayPanel') || document.getElementById('homeCalendar');
        if (!panel || panel.dataset.clickBound) return;
        panel.dataset.clickBound = '1';
        panel.addEventListener('click', (e) => {
            const cell = e.target.closest('.cal-day');
            if (!cell || !cell.dataset.date) return;
            // 万年历是本地算的，登不登录都能看
            this.selectLifeDate(cell.dataset.date);
        });
    },

    bindLifeEvents() {
        const box = document.getElementById('homeLife');
        if (!box || box.dataset.bound) return;
        box.dataset.bound = '1';

        // 任务展示列表：勾选完成 / 删除
        document.getElementById('lifeTaskList')?.addEventListener('click', (e) => this.onLifeTaskClick(e));

        // 编写盒子：关闭（×）
        const editor = document.getElementById('homeEditor');
        if (editor && !editor.dataset.bound) {
            editor.dataset.bound = '1';
            editor.addEventListener('click', (e) => {
                if (e.target.closest('[data-close]')) this.closeEditor();
            });
        }
        document.getElementById('editorTaskForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.submitEditorTask();
        });
        document.getElementById('editorJournalForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.submitEditorJournal();
        });

        // 日记表单里的「删除」：确认后删掉这天的日记
        document.getElementById('editorJournalForm')?.addEventListener('click', (e) => {
            if (!e.target.closest('[data-journal-delete]')) return;
            const label = this.formatDateLabel(this.lifeState.date);
            if (!window.confirm(`删掉 ${label} 的日记？删除后不能恢复。`)) return;
            this.deleteJournal();
        });

        // 归档月份切换
        document.getElementById('lifePrevMonth')?.addEventListener('click', () => this.changeLifeMonth(-1));
        document.getElementById('lifeNextMonth')?.addEventListener('click', () => this.changeLifeMonth(1));

        // 删除当天日记
        document.getElementById('journalDeleteBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteJournal();
        });

        // 日记堆叠：点最上面那张 → 翻到那天并打开日记编辑器；空卡 → 直接写选中那天
        document.getElementById('hv3Journals')?.addEventListener('click', (e) => {
            const card = e.target.closest('[data-journal-date]');
            if (card) {
                const date = card.dataset.journalDate;
                if (date && date !== this.lifeState.date) {
                    this.lifeState.date = date;
                    this.updateSelectedCalCell();
                    this.renderLifeTasks();
                    if (typeof window.renderCalendar === 'function') window.renderCalendar(this.lifeState.month);
                }
                this.openLifeEditor('journal');
                return;
            }
            if (e.target.closest('[data-journal-new]')) this.openLifeEditor('journal');
        });

        // 日历点击联动已挪到 bindCalendarClicks（未登录也要能提示）

        // 点窗户外面 / 按 Esc：自动收起编写弹窗
        document.addEventListener('click', (e) => {
            const wrap = document.getElementById('homeEditorWrap');
            if (!wrap || !wrap.classList.contains('is-open')) return;
            if (e.target.closest('#homeEditorWrap')) return;
            // 点日历 / 点日记堆叠自己会重开，不在这里抢着关
            if (e.target.closest('#homeCalendar') || e.target.closest('#hv3Journals')) return;
            this.closeEditor();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            this.closeEditor();
        });

        // 日记可以收起来：默认一行标题，点开才是那一摞
        this.bindJournalToggle();
    },

    // 日记折叠开关（默认收起：点日期先看任务，想写再点开）
    bindJournalToggle() {
        const wrap = document.getElementById('homeJournalBox');
        const btn = document.getElementById('journalToggle');
        if (!wrap || !btn || wrap.dataset.toggleBound) return;
        wrap.dataset.toggleBound = '1';

        const apply = (open) => {
            wrap.classList.toggle('is-collapsed', !open);
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        };

        apply(false);

        btn.addEventListener('click', () => apply(wrap.classList.contains('is-collapsed')));
    },

    // ===================== 主页盒子的自由交互 =====================
    // 所有 .dash-panel 都能：⤢ 放大 / 还原，⠿ 拖动时与同层盒子换位（带位移动画）

    bindBoxPlay() {
        // 堆叠：图库 / 文章封面叠成「堆叠文件」，点下层翻到上面
        const stack = document.getElementById('homeStack');
        if (stack && !stack.dataset.bound) {
            stack.dataset.bound = '1';
            stack.addEventListener('click', (e) => {
                const card = e.target.closest('.stack-card');
                if (!card) return;
                if (this.stackIsTop(card)) return;
                e.preventDefault();
                stack.classList.toggle('is-swapped');
            });
        }

        // 给主页里所有盒子装手柄（含动态出现的任务 / 日记盒子）
        this.refreshFreeBoxes();
        // 内容变化后再次扫描（任务/日记盒子是按需显示的）
        const observer = new MutationObserver(() => this.refreshFreeBoxes());
        const dash = document.querySelector('.view-home .dashboard');
        if (dash) observer.observe(dash, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    },

    // 收集所有盒子并装上交互手柄（同时标记为正方形网格卡片）
    refreshFreeBoxes() {
        const boxes = document.querySelectorAll('.view-home .dash-panel, .view-home .home-hero-row .home-hero');
        boxes.forEach(el => {
            if (el.dataset.freeHandles) return;
            if (el.classList.contains('home-editor')) return; // 编写盒子不加手柄
            el.dataset.freeHandles = '1';
            el.classList.add('free-box', 'grid-card');

            const zoom = document.createElement('button');
            zoom.type = 'button';
            zoom.className = 'free-box-btn free-box-zoom';
            zoom.title = '放大 / 还原（会挤压其他盒子）';
            zoom.textContent = '⤢';
            zoom.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.toggleBoxZoom(el, zoom);
            });

            const drag = document.createElement('button');
            drag.type = 'button';
            drag.className = 'free-box-btn free-box-drag';
            drag.title = '按住拖动，与同层盒子换位';
            drag.textContent = '⠿';
            this.bindFreeDrag(drag, el);

            el.appendChild(zoom);
            el.appendChild(drag);
        });
    },

    // 拖动换位：监听手柄上的指针事件
    bindFreeDrag(handle, el) {
        let dragging = false;
        let startX = 0;
        let startY = 0;

        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            e.stopPropagation();
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            el.classList.add('is-dragging');
            try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        });

        handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            e.preventDefault();
            el.style.setProperty('transform', `translate(${e.clientX - startX}px, ${e.clientY - startY}px)`, 'important');
        });

        const finish = (e) => {
            if (!dragging) return;
            dragging = false;
            el.classList.remove('is-dragging');
            el.style.removeProperty('transform');
            const target = this.findDropTarget(el, e.clientX, e.clientY);
            if (target) this.swapBoxes(el, target);
        };
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
    },

    // 找落点：鼠标位置落在哪个「同层」盒子里
    findDropTarget(el, x, y) {
        const parent = el.parentNode;
        if (!parent) return null;
        const siblings = [...parent.children].filter(
            c => c !== el && c.classList && c.classList.contains('free-box'),
        );
        for (const sib of siblings) {
            const r = sib.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return sib;
        }
        return null;
    },

    // 交换两个同层盒子的位置，并播放位移动画（类似互相挤压）
    swapBoxes(a, b) {
        const parent = a.parentNode;
        if (!parent || b.parentNode !== parent) return;

        const boxes = [...parent.children].filter(c => c.classList && c.classList.contains('free-box'));
        const before = new Map(boxes.map(el => [el, el.getBoundingClientRect()]));

        const aNext = a.nextSibling === b ? a : a.nextSibling;
        parent.insertBefore(a, b);
        if (aNext && aNext !== b) parent.insertBefore(b, aNext);
        else parent.insertBefore(b, aNext === b ? a.nextSibling : null);

        // FLIP：用上一次的位置做过渡
        boxes.forEach(el => {
            const b0 = before.get(el);
            if (!b0) return;
            const b1 = el.getBoundingClientRect();
            const dx = b0.left - b1.left;
            const dy = b0.top - b1.top;
            if (!dx && !dy) return;
            el.animate(
                [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
                { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
            );
        });
    },

    // 放大 / 还原：真实改变网格占位（2×2），并让邻居平滑让位
    toggleBoxZoom(el, btn) {
        const dash = document.querySelector('.view-home .dashboard');
        const boxes = dash ? [...dash.children] : [];
        // 记录变化前的位置，用于 FLIP
        const before = new Map(boxes.map(b => [b, b.getBoundingClientRect()]));

        el.classList.toggle('is-zoomed');
        if (btn) btn.textContent = el.classList.contains('is-zoomed') ? '⤡' : '⤢';

        // 下一帧再量一次，播放位移动画
        requestAnimationFrame(() => {
            boxes.forEach(b => {
                const b0 = before.get(b);
                if (!b0) return;
                const b1 = b.getBoundingClientRect();
                const dx = b0.left - b1.left;
                const dy = b0.top - b1.top;
                const dw = b0.width - b1.width;
                if (Math.abs(dx) < 2 && Math.abs(dy) < 2 && Math.abs(dw) < 2) return;
                b.animate(
                    [
                        { transform: `translate(${dx}px, ${dy}px)`, width: b0.width + 'px' },
                        { transform: 'translate(0, 0)', width: b1.width + 'px' },
                    ],
                    { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
                );
            });
        });
    },

    // 堆叠中某张卡是否在最上层（默认文章在上，交换后照片在上）
    stackIsTop(card) {
        const stack = document.getElementById('homeStack');
        if (!stack) return true;
        const swapped = stack.classList.contains('is-swapped');
        const isPhotos = card.id === 'homePhotos';
        return swapped ? isPhotos : !isPhotos;
    },

    // ===================== 桌面宠物 =====================
    // 形象与交互收口在 pet-core.js（引擎 / 拖拽惯性 / 睡眠 / 位置 / 气泡），
    // 说话内容在 pet-mind.js。这里只留同名薄包装，老调用点（如后台未登录提示
    // 的 this.petSay）继续可用。

    get petEngine() {
        return (window.PetCore && window.PetCore.engine) || null;
    },

    get petSleeping() {
        return !!(window.PetCore && window.PetCore.sleeping);
    },

    initDeskPet() {
        const core = window.PetCore;
        if (core) { core.init(); return; }
        // 首页的桌宠脚本是空闲时注入的：等它起来再初始化
        window.addEventListener('pet:engine', () => {
            if (window.PetCore) window.PetCore.init();
        }, { once: true });
    },

    petSay(text, ms) {
        if (window.PetCore) window.PetCore.say(text, ms);
    },

    petPlay(state, backMs) {
        if (window.PetCore) window.PetCore.setState(state, backMs);
    },

    petReact() {
        if (window.PetCore) window.PetCore.react();
    },

    placePetBubble() {
        if (window.PetCore) window.PetCore.placeBubble();
    },

    movePet(x, y) {
        if (window.PetCore) window.PetCore.moveTo(x, y);
    },

    savePetPos() {
        if (window.PetCore) window.PetCore.savePos();
    },

    restorePetPos() {
        if (window.PetCore) window.PetCore.restorePos();
    },

    togglePetSleep(force) {
        return window.PetCore ? window.PetCore.toggleSleep(force) : false;
    },

    startPetIdle() {
        if (window.PetCore) window.PetCore.scheduleIdle();
    },

    // 眼睛跟随由引擎的 followPointer 接管，这里为空实现（保留调用兼容）
    aimPetEyes() {},

    // ===================== 主页：无限画布 =====================
    // 世界坐标：主页本体左上角 (0,0)，宽 1280；左 = 图片墙，右 = 文章墙，上 / 下留白待开发。

    CANVAS_CORE_W: 1280,
    CANVAS_MIN_S: 0.26,
    CANVAS_MAX_S: 2.2,

    canvasOn: false,
    canvasX: 0,
    canvasY: 0,
    canvasS: 1,
    canvasDragging: false,
    canvasMoved: 0,
    canvasVelX: 0,
    canvasVelY: 0,
    canvasInertia: 0,
    canvasMq: null,
    canvasUserMoved: false,
    canvasCapsuleRaf: 0,
    canvasCapsuleZone: '',
    photoWallPhotos: [],
    photoWallLoading: false,
    photoWallBatch: 0,

    initHomeCanvas() {
        const canvas = document.getElementById('homeCanvas');
        const plane = document.getElementById('canvasPlane');
        if (!canvas || !plane || canvas.dataset.bound) return;
        canvas.dataset.bound = '1';

        this.canvasMq = window.matchMedia('(min-width: 901px)');
        const applyMode = () => {
            this.canvasOn = this.canvasMq.matches;
            document.body.classList.toggle('canvas-on', this.canvasOn);
            if (this.canvasOn) {
                this.layoutCanvasNodes();
                this.fitCanvas();
            } else {
                plane.style.transform = '';
            }
        };
        applyMode();
        if (this.canvasMq.addEventListener) this.canvasMq.addEventListener('change', applyMode);

        this.bindCanvasDrag(canvas);
        this.bindCanvasZoom(canvas);

        canvas.addEventListener('dblclick', (e) => {
            if (!this.canvasOn) return;
            if (e.target.closest('.canvas-core, .canvas-wall')) return;
            this.fitCanvas();
        });

        window.addEventListener('resize', () => {
            if (!this.canvasOn) return;
            this.layoutCanvasNodes();
            this.applyCanvas();
            this.wallComputeLayout();
            this.wallRender();
        });

        document.getElementById('canvasHud')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-canvas-act]');
            if (!btn) return;
            const act = btn.dataset.canvasAct;
            if (act === 'reset') { this.canvasUserMoved = false; this.fitCanvas(); }
            else if (act === 'zoom-in') this.canvasZoomCenter(1.2);
            else if (act === 'zoom-out') this.canvasZoomCenter(1 / 1.2);
        });

        // 底部胶囊：按当前聚焦的区域显示对应功能
        document.getElementById('canvasCapsule')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-cap]');
            if (!btn) return;
            e.stopPropagation();
            const act = btn.dataset.cap;
            if (act === 'view') this.wallSetView(this.photoWallView === 'grid' ? 'masonry' : 'grid');
            else if (act === 'shuffle') this.wallShuffle();
            else if (act === 'posts') this.goView('blog');
            this.syncCanvasCapsule(true);
        });

        this.bindPhotoWall();
        this.syncWallViewBtn();
        this.renderPostWall();
        this.loadPhotoWall();
        // 卡片、新闻渲染完主页会变高，等数据落地后再对一次焦（用户没动过才动）
        [600, 1800, 3200].forEach((ms) => setTimeout(() => {
            if (this.canvasOn && !this.canvasUserMoved) {
                this.layoutCanvasNodes();
                this.fitCanvas();
            }
        }, ms));
    },

    // 各节点在世界坐标里的位置（下占位依赖主页实际高度，每次重排）
    layoutCanvasNodes() {
        const core = document.getElementById('canvasCore');
        const photoWall = document.getElementById('canvasPhotoWall');
        const postWall = document.getElementById('canvasPostWall');
        const north = document.getElementById('canvasHoldNorth');
        const south = document.getElementById('canvasHoldSouth');
        if (!core) return;

        const coreH = core.offsetHeight || 1080;
        const PHOTO_W = 2400;
        const PHOTO_H = this.photoWallContentH || 1700;
        const POST_W = 1080;
        const POST_H = 1500;
        const GAP_X = 320;
        const GAP_Y = 240;

        core.style.left = '0px';
        core.style.top = '0px';

        if (photoWall) {
            photoWall.style.width = PHOTO_W + 'px';
            photoWall.style.height = PHOTO_H + 'px';
            photoWall.style.left = (-GAP_X - PHOTO_W) + 'px';
            photoWall.style.top = Math.round(coreH / 2 - PHOTO_H / 2) + 'px';
        }
        if (postWall) {
            postWall.style.width = POST_W + 'px';
            postWall.style.height = POST_H + 'px';
            postWall.style.left = (this.CANVAS_CORE_W + GAP_X) + 'px';
            postWall.style.top = '-120px';
        }
        if (north) {
            north.style.left = '0px';
            north.style.top = (-GAP_Y - 460) + 'px';
        }
        if (south) {
            south.style.left = '0px';
            south.style.top = (coreH + GAP_Y) + 'px';
        }
    },

    // 让主页本体整块落在视野中央
    fitCanvas() {
        const canvas = document.getElementById('homeCanvas');
        const core = document.getElementById('canvasCore');
        if (!canvas || !core) return;
        const vw = canvas.clientWidth || window.innerWidth;
        const vh = canvas.clientHeight || window.innerHeight;
        const coreH = core.offsetHeight || 1080;
        const s = Math.max(
            this.CANVAS_MIN_S,
            Math.min((vw - 96) / this.CANVAS_CORE_W, (vh - 72) / coreH, 1)
        );
        this.canvasS = s;
        this.canvasX = Math.round((vw - this.CANVAS_CORE_W * s) / 2);
        this.canvasY = Math.round((vh - coreH * s) / 2);
        this.applyCanvas();
    },

    applyCanvas() {
        const plane = document.getElementById('canvasPlane');
        if (!plane) return;
        plane.style.transform = `translate3d(${this.canvasX}px, ${this.canvasY}px, 0) scale(${this.canvasS})`;
        if (this.canvasCapsuleRaf) cancelAnimationFrame(this.canvasCapsuleRaf);
        this.canvasCapsuleRaf = requestAnimationFrame(() => {
            this.canvasCapsuleRaf = 0;
            this.syncCanvasCapsule();
        });
    },

    // 视角中心落在哪块区域，就在底部弹出那块的胶囊
    syncCanvasCapsule(force) {
        const canvas = document.getElementById('homeCanvas');
        const capsule = document.getElementById('canvasCapsule');
        if (!canvas || !capsule) return;
        if (!this.canvasOn) {
            capsule.classList.remove('is-show');
            this.canvasCapsuleZone = '';
            return;
        }
        const cr = canvas.getBoundingClientRect();
        const cx = cr.left + cr.width / 2;
        const cy = cr.top + cr.height / 2;
        const inside = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
        };

        let zone = '';
        if (inside(document.getElementById('canvasPhotoWall'))) zone = 'photos';
        else if (inside(document.getElementById('canvasPostWall'))) zone = 'posts';
        else if (inside(document.getElementById('canvasCore'))) zone = 'home';

        if (!force && zone === this.canvasCapsuleZone) {
            if (zone === 'photos' || zone === 'posts') this.fillCanvasCapsule(zone);
            return;
        }
        this.canvasCapsuleZone = zone;

        if (zone === 'photos' || zone === 'posts') {
            this.fillCanvasCapsule(zone);
            capsule.classList.add('is-show');
        } else {
            capsule.classList.remove('is-show');
        }
    },

    fillCanvasCapsule(zone) {
        const capsule = document.getElementById('canvasCapsule');
        if (!capsule) return;
        const count = this.photoWallPool.length;
        const posts = Array.isArray(this.posts) ? this.posts.length : 0;
        const html = zone === 'photos'
            ? `<span class="capsule-label">图片墙</span>`
              + `<span class="capsule-sub">${count} 张</span>`
              + `<span class="capsule-divider"></span>`
              + `<button type="button" class="capsule-btn" data-cap="view">${this.photoWallView === 'grid' ? '瀑布流' : '方格'}</button>`
              + `<button type="button" class="capsule-btn" data-cap="shuffle">换一批</button>`
            : `<span class="capsule-label">文章墙</span>`
              + `<span class="capsule-sub">${posts} 篇</span>`
              + `<span class="capsule-divider"></span>`
              + `<button type="button" class="capsule-btn" data-cap="posts">去文章页</button>`;
        if (capsule.dataset.htm !== html) {
            capsule.innerHTML = html;
            capsule.dataset.htm = html;
        }
    },

    canvasZoomAt(px, py, factor) {
        const next = Math.min(this.CANVAS_MAX_S, Math.max(this.CANVAS_MIN_S, this.canvasS * factor));
        if (Math.abs(next - this.canvasS) < 1e-4) return;
        this.canvasX = px - ((px - this.canvasX) / this.canvasS) * next;
        this.canvasY = py - ((py - this.canvasY) / this.canvasS) * next;
        this.canvasS = next;
        this.applyCanvas();
    },

    canvasZoomCenter(factor) {
        const canvas = document.getElementById('homeCanvas');
        if (!canvas) return;
        this.canvasZoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
    },

    bindCanvasDrag(canvas) {
        // 这些元素自己要用鼠标：拖把手、横向滚动条、新闻列表等，别抢
        const SKIP = 'button, a, input, textarea, select, label, .free-box-drag, .free-box-zoom, .home-news-list, .home-projects-grid, .life-task-list, .post-wall-item, .photo-wall-item';
        let startX = 0;
        let startY = 0;
        let origX = 0;
        let origY = 0;
        let lastX = 0;
        let lastY = 0;
        let lastT = 0;

        const down = (e) => {
            if (!this.canvasOn) return;
            if (e.button !== undefined && e.button !== 0) return;
            if (e.target.closest(SKIP)) return;
            // 别让浏览器顺手开始「选文字 / 拖图片」，否则拖动时会出现蓝色高亮遮罩
            if (e.cancelable) e.preventDefault();
            const sel = window.getSelection && window.getSelection();
            if (sel && sel.rangeCount) sel.removeAllRanges();
            this.stopCanvasInertia();
            this.canvasUserMoved = true;
            this.canvasDragging = true;
            this.canvasMoved = 0;
            startX = e.clientX;
            startY = e.clientY;
            origX = this.canvasX;
            origY = this.canvasY;
            lastX = e.clientX;
            lastY = e.clientY;
            lastT = Date.now();
            this.canvasVelX = 0;
            this.canvasVelY = 0;
            canvas.classList.add('is-dragging');
        };

        const move = (e) => {
            if (!this.canvasDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            this.canvasMoved = Math.max(this.canvasMoved, Math.abs(dx) + Math.abs(dy));
            this.canvasX = origX + dx;
            this.canvasY = origY + dy;
            const now = Date.now();
            const dt = Math.max(1, now - lastT);
            this.canvasVelX = (e.clientX - lastX) / dt;
            this.canvasVelY = (e.clientY - lastY) / dt;
            lastX = e.clientX;
            lastY = e.clientY;
            lastT = now;
            this.applyCanvas();
        };

        const up = () => {
            if (!this.canvasDragging) return;
            this.canvasDragging = false;
            canvas.classList.remove('is-dragging');
            if (Math.hypot(this.canvasVelX, this.canvasVelY) > 0.15) this.startCanvasInertia();
        };

        canvas.addEventListener('pointerdown', down);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        canvas.addEventListener('dragstart', (e) => e.preventDefault());
    },

    startCanvasInertia() {
        const step = () => {
            this.canvasInertia = 0;
            if (this.canvasDragging) return;
            this.canvasVelX *= 0.94;
            this.canvasVelY *= 0.94;
            if (Math.abs(this.canvasVelX) < 0.02 && Math.abs(this.canvasVelY) < 0.02) return;
            this.canvasX += this.canvasVelX * 16;
            this.canvasY += this.canvasVelY * 16;
            this.applyCanvas();
            this.canvasInertia = requestAnimationFrame(step);
        };
        this.canvasInertia = requestAnimationFrame(step);
    },

    stopCanvasInertia() {
        if (this.canvasInertia) {
            cancelAnimationFrame(this.canvasInertia);
            this.canvasInertia = 0;
        }
    },

    bindCanvasZoom(canvas) {
        const SCROLLY = '.home-news-list, .life-task-list, .home-projects-grid, .dash-panel-body';
        canvas.addEventListener('wheel', (e) => {
            if (!this.canvasOn) return;
            if (e.target.closest(SCROLLY)) return;      // 列表自己滚
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            this.canvasZoomAt(
                e.clientX - rect.left,
                e.clientY - rect.top,
                Math.max(0.72, Math.min(1.38, Math.exp(-e.deltaY * 0.0012)))
            );
        }, { passive: false });

        let pinch = null;
        const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        canvas.addEventListener('touchstart', (e) => {
            if (!this.canvasOn || e.touches.length !== 2) return;
            this.stopCanvasInertia();
            this.canvasDragging = false;
            const [a, b] = e.touches;
            pinch = {
                d0: Math.max(1, dist(a, b)),
                s0: this.canvasS,
                x0: this.canvasX,
                y0: this.canvasY,
                mx: (a.clientX + b.clientX) / 2,
                my: (a.clientY + b.clientY) / 2,
            };
        }, { passive: true });
        canvas.addEventListener('touchmove', (e) => {
            if (!this.canvasOn || !pinch || e.touches.length !== 2) return;
            const [a, b] = e.touches;
            const next = Math.min(this.CANVAS_MAX_S, Math.max(this.CANVAS_MIN_S, pinch.s0 * (dist(a, b) / pinch.d0)));
            const k = next / pinch.s0;
            this.canvasS = next;
            this.canvasX = (a.clientX + b.clientX) / 2 - (pinch.mx - pinch.x0) * k;
            this.canvasY = (a.clientY + b.clientY) / 2 - (pinch.my - pinch.y0) * k;
            this.applyCanvas();
        }, { passive: true });
        canvas.addEventListener('touchend', () => { pinch = null; });
        canvas.addEventListener('touchcancel', () => { pinch = null; });
    },

    // ---------- 左：图片墙（方格 / 瀑布流，规矩对齐 private-gallery） ----------

    WALL_CELL: 200,
    WALL_GAP: 12,

    photoWallPool: [],
    photoWallLayout: null,
    photoWallTiles: new Map(),
    photoWallById: new Map(),
    photoWallRatio: new Map(),      // id → 真实高宽比（图片加载后测得）
    photoWallView: 'grid',          // grid | masonry
    photoWallSeed: 1,
    photoWallExpandedId: null,
    photoWallShrunk: new Set(),
    photoWallLoading: false,
    photoWallClickTimer: null,
    photoWallRelayoutTimer: null,
    photoWallBatch: 0,

    async loadPhotoWall() {
        if (this.photoWallLoading) return;
        if (this.photoWallPool.length) {
            this.wallComputeLayout();
            this.wallRender();
            return;
        }
        this.photoWallLoading = true;
        const sub = document.getElementById('gwCount');
        if (sub) sub.textContent = '加载中…';
        try {
            const list = await Promise.race([
                this.loadGalleryImages(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
            ]);
            this.photoWallPool = (list || []).filter((p) => p && (p.thumb || p.url) && !this.isR18Image(p));
            this.wallShuffle(false);
            this.wallRender();
        } catch (e) {
            if (sub) sub.textContent = '图片没加载出来';
        } finally {
            this.photoWallLoading = false;
        }
    },

    // 换一批：错开起点 + 换随机种子（决定哪几张被随机放大）
    wallShuffle(render = true) {
        const pool = this.photoWallPool;
        if (!pool.length) return;
        this.photoWallBatch++;
        const start = (this.photoWallBatch * 37) % pool.length;
        this.photoWallPool = pool.slice(start).concat(pool.slice(0, start));
        this.photoWallSeed = (Math.random() * 1e9) | 0;
        this.photoWallExpandedId = null;
        this.photoWallShrunk.clear();
        this.wallComputeLayout();
        if (render) this.wallRender();
        const sub = document.getElementById('gwCount');
        if (sub) sub.textContent = `${this.photoWallPool.length} 张`;
    },

    wallSetView(view) {
        const next = view === 'masonry' ? 'masonry' : 'grid';
        if (next === this.photoWallView) return;
        this.photoWallView = next;
        this.photoWallExpandedId = null;
        this.photoWallShrunk.clear();
        this.wallComputeLayout();
        this.wallRender();
        this.syncWallViewBtn();
    },

    syncWallViewBtn() {
        const btn = document.querySelector('[data-gw="view"]');
        if (btn) btn.textContent = this.photoWallView === 'grid' ? '瀑布流' : '方格';
    },

    // 确定性小随机（mulberry32）：重排时其它随机放大不会乱跳
    wallRnd() {
        let seed = this.photoWallSeed | 0;
        return () => {
            seed = (seed + 0x6D2B79F5) | 0;
            let t = seed;
            t = Math.imul(t ^ (t >>> 15), 1 | t);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    },

    // 缩略图按格子大小要小图（?w= 变体），别下全尺寸 —— 首屏更快、流量更省
    wallTileSrc(p, big) {
        const base = p ? (p.thumb || p.url) : '';
        if (!base) return '';
        const w = big ? 480 : 320;
        return base + (base.includes('?') ? '&' : '?') + 'w=' + w;
    },

    // 记下图片真实高宽比（naturalWidth/Height 是唯一可信来源，元数据可能缺尺寸或 EXIF 旋转）
    wallNoteNatRatio(id, img) {
        if (!id || !img.naturalWidth) return;
        const ratio = img.naturalHeight / img.naturalWidth;
        const prev = this.photoWallRatio.get(id);
        if (prev && Math.abs(prev - ratio) < 0.02) return;
        this.photoWallRatio.set(id, ratio);
        // 比例变了就防抖重排一次，瀑布流错落才接近真实形状
        clearTimeout(this.photoWallRelayoutTimer);
        this.photoWallRelayoutTimer = setTimeout(() => {
            if (!this.gw.inited) return;
            this.wallComputeLayout();
            this.wallRender();
        }, 220);
    },

    // 高宽比：优先用图片加载后测到的；还没有就按元数据；再没有按 id 稳定编一个
    wallPhotoRatio(p) {
        const known = this.photoWallRatio.get(p.id);
        if (known) return known;
        const w = Number(p && p.width) || 0;
        const h = Number(p && p.height) || 0;
        if (w > 0 && h > 0) return h / w;
        const s = String(p.id || '');
        let h2 = 0;
        for (let i = 0; i < s.length; i++) h2 = (h2 * 31 + s.charCodeAt(i)) % 1000;
        return 0.62 + (h2 % 100) / 100 * 0.85;   // 0.62 ~ 1.47
    },

    wallComputeLayout() {
        const body = document.getElementById('gwBody');
        const pool = this.photoWallPool;
        if (!body || !pool.length) {
            this.photoWallLayout = null;
            return;
        }
        // 列宽按「一块 ≈ 视口宽」算，块在画布上无限平铺
        const W = body.clientWidth || window.innerWidth || 1200;
        if (this.photoWallView === 'masonry') this.wallComputeMasonry(W);
        else this.wallComputeGrid(W);
    },

    /* 方格：把整池照片全部铺开（不再只铺一块），随机放大照旧，
       墙面按行逐格填满、最后补齐成完整矩形，一张都不落下。 */
    wallComputeGrid(W) {
        const GAP = this.WALL_GAP;
        const cols = Math.max(3, Math.round((W + GAP) / (this.WALL_CELL + GAP)));
        const cellW = (W - (cols - 1) * GAP) / cols;
        const cellH = cellW;
        const pool = this.photoWallPool;
        if (!pool.length) {
            this.photoWallLayout = null;
            return;
        }

        // 被点开的那张排在最前面，好让它出现在第一块区域
        let order = pool;
        if (this.photoWallExpandedId && !this.photoWallShrunk.has(this.photoWallExpandedId)) {
            const exp = pool.find((p) => p.id === this.photoWallExpandedId);
            if (exp) order = [exp].concat(pool.filter((p) => p.id !== exp.id));
        }

        const rnd = this.wallRnd();
        const bigEvery = 8;
        const bigOffset = Math.floor(rnd() * bigEvery);

        const filled = new Set();
        const items = [];
        this.photoWallById.clear();
        const cellKey = (r, c) => r + ',' + c;
        const free = (r, c) => !filled.has(cellKey(r, c));
        const canBig = (r, c) => c + 1 < cols
            && free(r, c) && free(r, c + 1) && free(r + 1, c) && free(r + 1, c + 1);
        const markBig = (r, c) => {
            filled.add(cellKey(r, c));
            filled.add(cellKey(r, c + 1));
            filled.add(cellKey(r + 1, c));
            filled.add(cellKey(r + 1, c + 1));
        };

        let pi = 0;
        let rows = 1;
        while (pi < order.length) {
            for (let c = 0; c < cols && pi < order.length; c++) {
                if (!free(rows - 1, c)) continue;
                const p = order[pi];
                const isExpanded = p.id === this.photoWallExpandedId;
                const wantBig = isExpanded
                    || (((pi + bigOffset) % bigEvery) === 0 && !this.photoWallShrunk.has(p.id));
                pi++;
                const r = rows - 1;
                if (wantBig && canBig(r, c)) {
                    markBig(r, c);
                    items.push({
                        id: p.id, key: p.id,
                        x: c * (cellW + GAP), y: r * (cellH + GAP),
                        w: cellW * 2 + GAP, h: cellH * 2 + GAP,
                        big: true, expanded: isExpanded,
                    });
                } else {
                    filled.add(cellKey(r, c));
                    items.push({
                        id: p.id, key: p.id,
                        x: c * (cellW + GAP), y: r * (cellH + GAP),
                        w: cellW, h: cellH,
                        big: false, expanded: false,
                    });
                }
                this.photoWallById.set(p.id, p);
            }
            rows++;
        }

        // 收尾：把最后几块空位补上（照片循环取，墙面保持完整矩形）
        let filler = 0;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (!free(r, c)) continue;
                const p = pool[filler++ % pool.length];
                filled.add(cellKey(r, c));
                items.push({
                    id: p.id, key: 'pad-' + r + '-' + c + '-' + p.id,
                    x: c * (cellW + GAP), y: r * (cellH + GAP),
                    w: cellW, h: cellH,
                    big: false, filler: true,
                });
                this.photoWallById.set(p.id, p);
            }
        }

        // 块宽高必须**含尾部那道间隙**，否则块与块平铺时上一块的右/下边缘正好压住
        // 下一块的左/上边缘 —— 屏幕上就是「照片互相贴住、没有空隙」。
        // 块内最后一列右缘 = (cols-1)*step + cellW = cols*step - GAP，
        // 所以块宽取 cols*step，块高取 rows*step，接缝处才留得出一个 GAP。
        const step = cellW + GAP;
        const blockH = rows * (cellH + GAP);
        this.photoWallLayout = { items, cols, cellW, cellH, blockW: cols * step, blockH };
    },

    // 瀑布流：同样把整池照片全部排出来，最后把各列补齐到同一高度
    wallComputeMasonry(W) {
        const GAP = this.WALL_GAP;
        const cols = Math.max(3, Math.round((W + GAP) / (this.WALL_CELL + GAP)));
        const cellW = (W - (cols - 1) * GAP) / cols;
        const step = cellW + GAP;
        const pool = this.photoWallPool;
        if (!pool.length) {
            this.photoWallLayout = null;
            return;
        }
        let order = pool;
        if (this.photoWallExpandedId && !this.photoWallShrunk.has(this.photoWallExpandedId)) {
            const exp = pool.find((p) => p.id === this.photoWallExpandedId);
            if (exp) order = [exp].concat(pool.filter((p) => p.id !== exp.id));
        }

        const colH = new Array(cols).fill(0);
        const items = [];
        const gaps = [];
        this.photoWallById.clear();
        const shortest = () => {
            let c = 0;
            for (let i = 1; i < cols; i++) if (colH[i] < colH[c]) c = i;
            return c;
        };

        for (let i = 0; i < order.length; i++) {
            const p = order[i];
            const ratio = this.wallPhotoRatio(p);
            const isExpanded = p.id === this.photoWallExpandedId;
            const randBig = (i % 8 === 0) && cols >= 2 && !this.photoWallShrunk.has(p.id);
            const wantBig = cols >= 2 && (isExpanded || randBig);

            if (wantBig) {
                const c = shortest();
                const left = c + 1 < cols ? c : c - 1;
                const spanW = cellW * 2 + GAP;
                const h = Math.round(spanW * ratio);
                const y = Math.max(colH[left], colH[left + 1]);
                const shortCol = colH[left] < colH[left + 1] ? left : left + 1;
                const gapH = Math.abs(colH[left] - colH[left + 1]) - GAP;
                if (gapH > 24) gaps.push({ col: shortCol, y: Math.min(colH[left], colH[left + 1]), h: gapH });
                items.push({
                    id: p.id, key: p.id, x: left * step, y, w: spanW, h,
                    big: true, expanded: isExpanded,
                });
                this.photoWallById.set(p.id, p);
                colH[left] = y + h + GAP;
                colH[left + 1] = y + h + GAP;
                continue;
            }

            const h = Math.round(cellW * ratio);
            let filledGap = false;
            for (const g of gaps) {
                if (h + GAP <= g.h) {
                    items.push({ id: p.id, key: p.id, x: g.col * step, y: g.y, w: cellW, h, big: false });
                    this.photoWallById.set(p.id, p);
                    g.y += h + GAP;
                    g.h -= h + GAP;
                    filledGap = true;
                    break;
                }
            }
            if (filledGap) continue;

            const c = shortest();
            items.push({ id: p.id, key: p.id, x: c * step, y: colH[c], w: cellW, h, big: false });
            this.photoWallById.set(p.id, p);
            colH[c] += h + GAP;
        }

        // 收尾：各列高度拉齐（补位块用循环照片），块底齐平
        const blockH = Math.max.apply(null, colH);
        let n = 0;
        for (let c = 0; c < cols; c++) {
            const remain = blockH - colH[c];
            if (remain <= 14) continue;
            const p = pool[n++ % pool.length];
            items.push({
                id: p.id, key: 'pad-' + c + '-' + n + '-' + p.id,
                x: c * step, y: colH[c], w: cellW, h: remain - GAP,
                big: false, filler: true,
            });
            this.photoWallById.set(p.id, p);
            colH[c] = blockH;
        }

        /* gallery 原版 v1.07：把「列内残留的空档」也填平 ——
           多张大图跨列时，后续照片不一定填得严丝合缝，剩下的缝隙在这里
           用一个高度正好的补位块补掉（图片按 cover 裁切），于是放大/跨列之后
           不会留下明显的空洞。 */
        {
            const perCol = Array.from({ length: cols }, () => []);
            for (const it of items) {
                const span = it.w > cellW + 1 ? 2 : 1;
                const c0 = Math.round(it.x / step);
                for (let k = 0; k < span; k++) {
                    const c = c0 + k;
                    if (c >= 0 && c < cols) perCol[c].push(it);
                }
            }
            let fillN = 0;
            const fillGap = (c, y, h) => {
                if (h <= 10) return;
                const p = pool[fillN++ % pool.length];
                items.push({
                    id: p.id, key: 'gap-' + c + '-' + y + '-' + fillN + '-' + p.id,
                    x: c * step, y, w: cellW, h,
                    big: false, filler: true,
                });
                this.photoWallById.set(p.id, p);
            };
            for (let c = 0; c < cols; c++) {
                const list = perCol[c].sort((a, b) => (a.y - b.y) || (b.h - a.h));
                let y = 0;
                for (const it of list) {
                    if (it.y - y > 10) fillGap(c, y, it.y - GAP - y);
                    y = Math.max(y, it.y + it.h);
                }
            }
        }

        // 同方格那边：块宽高都要含尾部间隙，块与块平铺才留得出空隙
        this.photoWallLayout = { items, cols, cellW, blockW: cols * step, blockH };
    },

    /* 渲染：块（blockW×blockH）在画布上无限平铺，只创建/保留视野内的 tile（虚拟化）。
       几千张图也不卡；拖到哪一块就渲染哪一块。 */
    wallRender() {
        const wall = document.getElementById('galleryWall');
        const plane = document.getElementById('gwPlane');
        const body = document.getElementById('gwBody');
        const layout = this.photoWallLayout;
        if (!wall || !plane || !body || !layout) return;
        body.classList.toggle('is-masonry', this.photoWallView === 'masonry');

        const vw = wall.clientWidth || window.innerWidth || 1200;
        const vh = wall.clientHeight || window.innerHeight || 800;
        const s = this.gw.s;
        // 视野在画布坐标里的矩形（留一圈余量，减少边缘闪现）
        const pad = 80 / s;
        const x0 = -this.gw.x / s - pad;
        const x1 = (vw - this.gw.x) / s + pad;
        const y0 = -this.gw.y / s - pad;
        const y1 = (vh - this.gw.y) / s + pad;
        const blockW = Math.max(1, layout.blockW);
        const blockH = Math.max(1, layout.blockH);

        const alive = new Set();
        const k0 = Math.floor(x0 / blockW);
        const k1 = Math.floor(x1 / blockW);
        const m0 = Math.floor(y0 / blockH);
        const m1 = Math.floor(y1 / blockH);
        for (let k = k0; k <= k1; k++) {
            for (let m = m0; m <= m1; m++) {
                const bx = k * blockW;
                const by = m * blockH;
                if (by > y1 || by + blockH < y0) continue;
                for (let i = 0; i < layout.items.length; i++) {
                    const it = layout.items[i];
                    const wy = by + it.y;
                    if (wy > y1 || wy + it.h < y0) continue;
                    const wx = bx + it.x;
                    if (wx > x1 || wx + it.w < x0) continue;
                    const key = k + ',' + m + ',' + (it.key || i);
                    alive.add(key);
                    let el = this.photoWallTiles.get(key);
                    if (!el) {
                        el = document.createElement('button');
                        el.type = 'button';
                        el.className = 'gw-tile';
                        el.dataset.key = key;
                        el.dataset.id = it.id;
                        const img = document.createElement('img');
                        img.loading = 'lazy';
                        img.decoding = 'async';
                        img.referrerPolicy = 'no-referrer';
                        img.alt = '';
                        img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
                        img.addEventListener('load', () => this.wallNoteNatRatio(it.id, img));
                        el.appendChild(img);
                        body.appendChild(el);
                        this.photoWallTiles.set(key, el);
                    }
                    const p = this.photoWallById.get(it.id);
                    const img = el.firstElementChild;
                    const src = this.wallTileSrc(p, it.big);
                    if (src && img.getAttribute('src') !== src) img.src = src;
                    el.style.left = wx + 'px';
                    el.style.top = wy + 'px';
                    el.style.width = it.w + 'px';
                    el.style.height = it.h + 'px';
                    el.classList.toggle('is-big', !!it.big);
                    el.classList.toggle('is-expanded', !!it.expanded);
                }
            }
        }
        this.photoWallTiles.forEach((el, key) => {
            if (alive.has(key)) return;
            el.remove();
            this.photoWallTiles.delete(key);
        });
        plane.style.transform = 'translate3d(' + this.gw.x + 'px, ' + this.gw.y + 'px, 0) scale(' + s + ')';
        const sub = document.getElementById('gwCount');
        if (sub) sub.textContent = `${this.photoWallPool.length} 张`;
    },

    // rAF 节流：拖拽/惯性期间每帧最多渲一次
    wallSchedule() {
        if (this.gw.raf) return;
        this.gw.raf = requestAnimationFrame(() => {
            this.gw.raf = 0;
            this.wallRender();
        });
    },

    bindPhotoWall() {
        const body = document.getElementById('gwBody');
        if (!body || body.dataset.bound) return;
        body.dataset.bound = '1';

        // 单击：就地放大 / 收回（等 260ms 确认不是双击）
        body.addEventListener('click', (e) => {
            const tile = e.target.closest('.gw-tile');
            if (!tile) return;
            if (this.gwMoved > 6) return;          // 刚拖过墙，不算点击
            const id = tile.dataset.id;
            clearTimeout(this.photoWallClickTimer);
            this.photoWallClickTimer = setTimeout(() => this.wallToggleBig(id), 260);
        });

        // 双击：进灯箱
        body.addEventListener('dblclick', (e) => {
            const tile = e.target.closest('.gw-tile');
            if (!tile) return;
            clearTimeout(this.photoWallClickTimer);
            this.wallOpenLightbox(tile.dataset.id);
        });
    },

    // 点开某张：它占 2×2，周围整片让开；再点收回（并记住它别再随机放大）
    wallToggleBig(id) {
        const layout = this.photoWallLayout;
        if (!layout) return;
        const item = layout.items.find((it) => it.id === id && !it.filler);
        if (!item) return;
        if (this.photoWallExpandedId === id || item.expanded) {
            this.photoWallExpandedId = null;
            this.photoWallShrunk.add(id);
        } else {
            this.photoWallExpandedId = id;
            this.photoWallShrunk.delete(id);
        }
        this.wallComputeLayout();
        this.wallRender();
        if (this.photoWallExpandedId) {
            const tile = this.photoWallTiles.get(id);
            if (tile) this.wallKeepInView(tile);
        }
    },

    // 让某个格子留在视野里（画布坐标换算）
    wallKeepInView(tile) {
        const canvas = document.getElementById('homeCanvas');
        const wall = document.getElementById('canvasPhotoWall');
        if (!canvas || !wall) return;
        const cr = canvas.getBoundingClientRect();
        const wr = wall.getBoundingClientRect();
        const s = this.canvasS;
        const tileLeft = wr.left + parseFloat(tile.style.left || '0') * s;
        const tileTop = wr.top + parseFloat(tile.style.top || '0') * s;
        const tileW = parseFloat(tile.style.width || '0') * s;
        const tileH = parseFloat(tile.style.height || '0') * s;
        const pad = 60;
        let dx = 0;
        let dy = 0;
        if (tileLeft < cr.left + pad) dx = cr.left + pad - tileLeft;
        else if (tileLeft + tileW > cr.right - pad) dx = cr.right - pad - (tileLeft + tileW);
        if (tileTop < cr.top + pad) dy = cr.top + pad - tileTop;
        else if (tileTop + tileH > cr.bottom - pad) dy = cr.bottom - pad - (tileTop + tileH);
        if (!dx && !dy) return;
        this.canvasX += dx;
        this.canvasY += dy;
        this.applyCanvas();
    },

    // 双击进灯箱：用图片墙这批照片当导航序列
    wallOpenLightbox(id) {
        const pool = this.photoWallPool;
        const idx = pool.findIndex((p) => p.id === id);
        const target = idx >= 0 ? idx : 0;
        const photo = pool[target];
        if (!photo) return;
        window.__galleryImages = pool;
        if (typeof window.openGalleryLightbox === 'function') {
            window.openGalleryLightbox(photo.url || photo.thumb, target);
        }
    },

    // ---------- 右：文章墙 ----------

    renderPostWall() {
        const body = document.getElementById('postWallBody');
        const sub = document.getElementById('postWallSub');
        if (!body) return;
        const posts = Array.isArray(this.posts) ? this.posts : [];
        if (!posts.length) {
            body.innerHTML = '<div class="canvas-wall-empty">文章还在路上…</div>';
            if (sub) sub.textContent = '';
            return;
        }
        const esc = (s) => (this.escHtml ? this.escHtml(String(s)) : String(s));
        const list = posts.slice(0, 60).map((post) => {
            const title = esc(post.title || '无标题');
            const date = this.formatDate ? this.formatDate(post.date) : (post.date || '');
            const tags = (post.tags || []).slice(0, 2)
                .map((t) => `<span class="post-wall-tag">${esc(t)}</span>`).join('');
            const excerpt = post.excerpt ? esc(String(post.excerpt).slice(0, 90)) : '';
            const cover = post.image
                ? `<span class="post-wall-cover"><img src="${esc(post.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></span>`
                : '';
            const href = `article.html?post=${encodeURIComponent(post.filename || '')}`;
            return `<a class="post-wall-item${cover ? ' has-cover' : ''}" href="${href}">`
                + cover
                + `<span class="post-wall-title">${title}</span>`
                + (excerpt ? `<span class="post-wall-excerpt">${excerpt}</span>` : '')
                + `<span class="post-wall-meta">`
                + `<span class="post-wall-date">${date}</span>`
                + (tags ? `<span class="post-wall-tags">${tags}</span>` : '')
                + `</span>`
                + `</a>`;
        }).join('');
        body.innerHTML = list;
        if (sub) sub.textContent = `${posts.length} 篇`;
        // 一排横向：按住可拖、自己慢慢滚、循环不停（和日历旁项目条同一套）
        if (body._loopTimer) { clearInterval(body._loopTimer); body._loopTimer = 0; }
        body.dataset.loopBound = '';
        this.bindProjectsDragScroll(body);
        this.initProjectsLoopScroll(body, '.post-wall-item', { auto: true, speed: 0.3 });
        this.layoutCanvasNodes();
    },

    // 主页入口：切到指定视图（可选再按内容形态筛选）
    goView(view, type) {
        if (this.currentView !== view) this.switchView(view);
        if (type) this.filterByType(type);
        else if (view === 'blog') this.filterByTag(null);
    },

    // 滚动到主页内的某个区块（如今日简报）
    scrollToSection(id) {
        const el = document.getElementById(id);
        if (!el) return;
        const scroller = document.getElementById('scrollArea');
        if (scroller) {
            const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16;
            scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        } else {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    },

    // ===================== 移动端导航面板 =====================

    wheelOpen: false,

    // 打开 / 收起导航
    toggleWheel() {
        if (this.wheelOpen) this.closeWheel();
        else this.openWheel();
    },

    openWheel() {
        const layer = document.getElementById('wheelLayer');
        const trigger = document.getElementById('wheelTrigger');
        if (!layer) return;
        layer.classList.add('open');
        this.wheelOpen = true;
        if (trigger) {
            trigger.classList.add('active');
            trigger.setAttribute('aria-expanded', 'true');
        }
        document.body.classList.add('wheel-open');
        this.syncWheelActive();

        // 焦点进导航（键盘用户可用 Tab / 方向遍历），并记住来处以便关闭时归还
        this._wheelPrevFocus = document.activeElement;
        const firstItem = layer.querySelector('.site-nav-btn, .site-nav-close');
        if (firstItem && firstItem.focus) firstItem.focus();

        // Escape 关闭；打开期间把 Tab 圈在菜单内（简易焦点陷阱）
        if (!this._wheelKeyBound) {
            this._wheelKeyBound = true;
            document.addEventListener('keydown', (e) => {
                if (!this.wheelOpen) return;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.closeWheel();
                    return;
                }
                if (e.key !== 'Tab') return;
                const wheel = document.getElementById('wheel');
                if (!wheel) return;
                const focusables = [...wheel.querySelectorAll('button')];
                if (!focusables.length) return;
                const first = focusables[0];
                const last = focusables[focusables.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                } else if (!wheel.contains(document.activeElement)) {
                    e.preventDefault();
                    first.focus();
                }
            });
        }
    },

    closeWheel() {
        const layer = document.getElementById('wheelLayer');
        const trigger = document.getElementById('wheelTrigger');
        this.wheelOpen = false;
        if (layer) layer.classList.remove('open');
        if (trigger) {
            trigger.classList.remove('active');
            trigger.setAttribute('aria-expanded', 'false');
        }
        document.body.classList.remove('wheel-open');
        // 焦点归还触发按钮（键盘用户不会掉回页面顶部）
        const prev = this._wheelPrevFocus;
        this._wheelPrevFocus = null;
        const target = (prev && document.contains(prev) && prev.focus) ? prev : trigger;
        if (target && target.focus) target.focus();
    },

    // 高亮当前视图对应的导航项（与顶部导航栏的 .view-btn 同一套视图 id）
    syncWheelActive() {
        const layer = document.getElementById('wheelLayer');
        if (!layer) return;
        layer.querySelectorAll('.site-nav-btn').forEach(el => {
            el.classList.toggle('is-active', el.dataset.view === this.currentView);
        });
    },

    // 加载 GitHub 仓库列表（后端 /api/github，失败返回空数组）
    async loadGithubRepos() {
        const CACHE_KEY = 'blog-github-repos';
        const CACHE_TTL = 10 * 60 * 1000;
        try {
            const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
            if (cached && Array.isArray(cached.items) && Date.now() - cached.t < CACHE_TTL) return cached.items;
        } catch (e) { /* 忽略缓存异常 */ }

        try {
            const res = await fetch(`${this.config.apiBase}/api/github?limit=12`, { cache: 'no-store' });
            if (!res.ok) {
                let msg = 'HTTP ' + res.status;
                try {
                    const errBody = await res.json();
                    if (errBody && errBody.message) msg = errBody.message;
                } catch (e) { /* 忽略解析失败 */ }
                throw new Error(msg);
            }
            const data = await res.json();
            const items = data && Array.isArray(data.items) ? data.items : [];
            try {
                sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), items }));
            } catch (e) { /* 忽略写入失败 */ }
            return items;
        } catch (e) {
            /* 静默：属于正常回退路径，不刷控制台 */
            return [];
        }
    },

    // 渲染主页「创造与探索」：已上线站点两列小卡（封面 + 名称 + 域名）
    async renderHomeProjects() {
        const box = document.getElementById('hv3Projects');
        if (!box || box.dataset.rendered) return;
        box.dataset.rendered = '1';

        const items = this.deployedProjects || [];
        if (!items.length) {
            box.innerHTML = '<div class="hv3-empty">暂无已上线项目</div>';
            return;
        }

        box.innerHTML = items.map(p => this.hv3DeployedCard(p)).join('');
        // 横向一条：鼠标按住可拖动，滚动条藏起来；和简报一样自己慢慢滚（这里是左右）
        this.bindProjectsDragScroll(box);
        this.initProjectsLoopScroll(box, '.hv3-project', { auto: true, speed: 0.35 });
    },

    // 首页已上线项目卡片：封面截图 + 名称/标签 + 域名
    hv3DeployedCard(p) {
        const cover = p.cover
            ? `<div class="hv3-project-cover"><img src="${this.escAttr(p.cover)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.closest('.hv3-project-cover')?.remove()"></div>`
            : '';
        const tag = p.tag ? `<span class="hv3-project-tag">${this.esc(p.tag)}</span>` : '';
        return `
            <a class="hv3-project" href="${this.escAttr(p.url)}" target="_blank" rel="noopener" title="${this.escAttr(p.desc || '')}">
                ${cover}
                <div class="hv3-project-head">
                    <span class="hv3-project-name">${this.esc(p.name)}</span>
                    ${tag}
                </div>
                <span class="hv3-project-host">${this.esc(p.host || '')}</span>
            </a>
        `;
    },

    // 项目横向列表：鼠标按住拖拽滚动（触屏走原生滑动，不显示滚动条）
    bindProjectsDragScroll(grid) {
        if (!grid || grid.dataset.dragBound) return;
        grid.dataset.dragBound = '1';

        let dragging = false;
        let moved = false;
        let startX = 0;
        let startLeft = 0;

        grid.addEventListener('pointerdown', (e) => {
            if (e.pointerType !== 'mouse' || e.button !== 0) return;
            // 别让浏览器顺手把卡片文字选中、把封面图拖出个幽灵图（拖动时那层蓝底就是选框）
            e.preventDefault();
            dragging = true;
            moved = false;
            startX = e.clientX;
            startLeft = grid.scrollLeft;
        });

        grid.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            if (!moved && Math.abs(dx) > 4) {
                moved = true;
                grid.classList.add('is-dragging');
            }
            if (moved) {
                e.preventDefault();
                grid.scrollLeft = startLeft - dx;
            }
        });

        const stop = () => {
            dragging = false;
            grid.classList.remove('is-dragging');
        };
        grid.addEventListener('pointerup', stop);
        grid.addEventListener('pointerleave', stop);
        grid.addEventListener('pointercancel', stop);

        // 刚拖拽过就不要触发卡片跳转
        grid.addEventListener('click', (e) => {
            if (moved) {
                e.preventDefault();
                e.stopPropagation();
                moved = false;
            }
        }, true);
    },

    // 单个 GitHub 仓库卡片（主页与项目页共用）
    githubRepoCard(repo) {
        const color = this.escAttr(repo.languageColor || '#8b8b8b');
        const lang = repo.language
            ? `<span class="home-project-lang"><i style="background:${color}"></i>${this.esc(repo.language)}</span>`
            : '';
        const stars = Number(repo.stars) > 0 ? `<span class="home-project-star">★ ${Number(repo.stars)}</span>` : '';
        return `
            <a class="home-project" href="${this.escAttr(repo.htmlUrl)}" target="_blank" rel="noopener">
                <div class="home-project-head">
                    <span class="home-project-name">${this.esc(repo.name)}</span>
                    ${stars}
                </div>
                <div class="home-project-desc">${this.esc(repo.description || '暂无描述')}</div>
                <div class="home-project-foot">
                    ${lang}
                    <span class="home-project-time">${this.relativeTime(repo.updatedAt)}</span>
                </div>
            </a>
        `;
    },

    // ===================== 项目视图 =====================

    // 已部署的站点（后台「项目管理」里改过的那份优先；这里是没配过时的内置默认值。
    //  新站跑一次 scripts/build-project-covers.mjs 生成封面）
    deployedProjects: [
        {
            name: '渡鸦 NULL',
            desc: '博客本体：日光与暮色之间的个人空间，文章、图库、音乐和项目都在这一个站里。',
            url: 'https://ravennull.work/',
            host: 'ravennull.work',
            icon: '❖',
            tag: 'JavaScript',
            cover: 'images/projects/ravennull.webp',
        },
        {
            name: '个人图床',
            desc: '图片托管与图库站点：分类浏览、灯箱查看、幻灯放映，支持访问密码与分级内容。',
            url: 'https://pic.ravennull.work/',
            host: 'pic.ravennull.work',
            icon: '▦',
            tag: 'JavaScript',
            cover: 'images/projects/pic.webp',
        },
        {
            name: '个人数据库',
            desc: '资源与文档集中存放，按类目检索，随手取用。',
            url: 'https://db.ravennull.work/',
            host: 'db.ravennull.work',
            icon: '▤',
            tag: 'JavaScript',
            cover: 'images/projects/db.webp',
        },
        {
            name: '绳网模拟',
            desc: '绳网社区的项目模拟开发，界面与交互用 Vue 实现。',
            url: 'https://interknot.netlify.app/',
            host: 'interknot.netlify.app',
            icon: '◇',
            tag: 'Vue',
            cover: 'images/projects/interknot.webp',
        },
        {
            name: '游戏中心',
            desc: '长夜城 · 网页游戏，TypeScript 构建的世界。',
            url: 'https://game.ravennull.work/',
            host: 'game.ravennull.work',
            icon: '◈',
            tag: 'TypeScript',
            cover: 'images/projects/game.webp',
        },
        {
            name: '音乐播放器',
            desc: '站内的播放器本体：歌单、歌词与灵动岛的数据都来自这里。',
            url: 'https://music.ravennull.work/',
            host: 'music.ravennull.work',
            icon: '♪',
            tag: 'React',
            cover: 'images/projects/music.webp',
        },
    ],

    // 项目视图：已上线站点 + GitHub 仓库
    renderProjects() {
        this.renderDeployedProjects();
        this.renderGithubProjects();
    },

    // 已上线站点卡片（封面截图 + 名称 / 描述 / 域名）
    renderDeployedProjects() {
        const box = document.getElementById('deployedProjects');
        if (!box || box.dataset.rendered) return;
        box.dataset.rendered = '1';

        // 标题旁的数字
        const countEl = document.getElementById('deployedCount');
        if (countEl) countEl.textContent = String((this.deployedProjects || []).length);

        if (!this.deployedProjects.length) {
            box.innerHTML = '<div class="home-empty">暂无已上线项目</div>';
            return;
        }

        box.innerHTML = this.deployedProjects.map(p => {
            const cover = p.cover
                ? `<div class="project-card-cover"><img src="${this.escAttr(p.cover)}" alt="${this.esc(p.name)}" loading="lazy" decoding="async" onerror="BlogApp.onProjectCoverError(this)"></div>`
                : '';
            return `
            <a class="project-card" href="${this.escAttr(p.url)}" target="_blank" rel="noopener">
                ${cover}
                <div class="project-card-body">
                    <div class="project-card-head">
                        <span class="project-card-icon">${this.esc(p.icon || '◆')}</span>
                        <span class="project-card-name">${this.esc(p.name)}</span>
                        ${p.tag ? `<span class="project-card-tag">${this.esc(p.tag)}</span>` : ''}
                    </div>
                    <div class="project-card-desc">${this.esc(p.desc)}</div>
                    <div class="project-card-foot">
                        <span class="project-card-host">${this.esc(p.host)}</span>
                        <span class="project-card-visit">访问 →</span>
                    </div>
                </div>
            </a>
        `;
        }).join('');

        // 一排摆开，按住左右拖（跟主页项目条同一套拖拽逻辑）
        this.bindProjectsDragScroll(box);
        // 横向无限循环：内容复制两份，滚出一份宽度就悄悄挪回去，看着永远滚不完
        this.initProjectsLoopScroll(box);
    },

    // 项目条横向无限滚动（配合 bindProjectsDragScroll 用）
    initProjectsLoopScroll(grid, cardSel = '.project-card', opts = {}) {
        if (!grid || grid.dataset.loopBound) return;
        grid.dataset.loopBound = '1';

        const origin = [...grid.querySelectorAll(cardSel)];
        if (!origin.length) return;

        const cloneCopy = () => {
            const frag = document.createDocumentFragment();
            origin.forEach((el) => {
                const c = el.cloneNode(true);
                c.setAttribute('aria-hidden', 'true');
                c.dataset.loopCopy = '1';
                frag.appendChild(c);
            });
            grid.appendChild(frag);
        };
        cloneCopy();
        cloneCopy();

        // 一份内容的宽度（第一张和第二份的第一张之间的间距）
        const oneW = () => {
            const cards = grid.querySelectorAll(cardSel);
            const first = cards[0];
            const second = cards[origin.length];
            return (first && second) ? (second.offsetLeft - first.offsetLeft) : 0;
        };

        // 先挪过一份，左右都留出余量，两边都能一直拖
        const w0 = oneW();
        if (w0 > 0) grid.scrollLeft = w0;

        const wrap = () => {
            const w = oneW();
            if (w <= 0) return;
            if (grid.scrollLeft >= w * 2) grid.scrollLeft -= w;
            else if (grid.scrollLeft <= 0) grid.scrollLeft += w;
        };

        grid.addEventListener('scroll', wrap, { passive: true });
        // 拖完松手也可能停在越界位置，补一次纠正
        grid.addEventListener('pointerup', () => setTimeout(wrap, 0), { passive: true });

        // 慢慢自动往右滚（和简报一样自己走；鼠标停上去暂停，离开继续）
        if (opts.auto) {
            const speed = Number(opts.speed) || 0.5;
            let paused = false;
            let acc = 0;
            grid.addEventListener('pointerenter', () => { paused = true; }, { passive: true });
            grid.addEventListener('pointerleave', () => { paused = false; }, { passive: true });
            grid.addEventListener('pointerdown', () => { paused = true; }, { passive: true });
            // 同上：离开事件丢了也要能自己恢复
            setInterval(() => {
                if (document.hidden) return;
                if (!paused) return;
                if (grid.matches(':hover') || grid.matches(':focus-within')) return;
                paused = false;
            }, 2000);
            if (grid._loopTimer) clearInterval(grid._loopTimer);
            grid._loopTimer = setInterval(() => {
                if (document.hidden || paused) return;
                if (!grid.clientWidth) return;
                if (oneW() <= 0) return;
                // scrollLeft 只认真数像素：先攒够 1px 再加，不然 0.5 这种小数每帧都被吞掉
                acc += speed;
                if (acc < 1) return;
                const step = Math.floor(acc);
                acc -= step;
                grid.scrollLeft += step;
            }, 16);
        }
    },

    // 封面加载失败：退化成图标底（不影响卡片可用）
    onProjectCoverError(img) {
        const wrap = img.parentElement;
        if (!wrap) return;
        img.remove();
        wrap.classList.add('is-empty');
        wrap.innerHTML = '<span class="project-card-cover-icon">▣</span>';
    },

    // GitHub 仓库卡片（项目视图）
    async renderGithubProjects() {
        const box = document.getElementById('projectsGithubGrid');
        if (!box || box.dataset.rendered) return;
        box.dataset.rendered = '1';

        const items = await this.loadGithubRepos();
        // 标题旁的数字
        const countEl = document.getElementById('repoCount');
        if (countEl) countEl.textContent = String(items.length || 0);
        if (!items.length) {
            box.innerHTML = '<div class="home-empty">仓库列表暂时不可用</div>';
            return;
        }

        box.innerHTML = items.map(repo => this.githubRepoCard(repo)).join('');
        // 跟「已上线」一样：一排横向拖动 + 无限循环
        this.bindProjectsDragScroll(box);
        this.initProjectsLoopScroll(box, '.home-project');
    },

    // 相对时间：刚刚 / 12 分钟前 / 3 天前 / 2 个月前
    relativeTime(iso) {
        const t = new Date(iso).getTime();
        if (!t || isNaN(t)) return '';
        const diff = Date.now() - t;
        if (diff < 0) return '刚刚';
        const minute = 60 * 1000;
        const hour = 60 * minute;
        const day = 24 * hour;
        if (diff < hour) return Math.max(1, Math.round(diff / minute)) + ' 分钟前';
        if (diff < day) return Math.round(diff / hour) + ' 小时前';
        if (diff < 30 * day) return Math.round(diff / day) + ' 天前';
        if (diff < 365 * day) return Math.round(diff / (30 * day)) + ' 个月前';
        return Math.round(diff / (365 * day)) + ' 年前';
    },

    // 执行导航面板里的选项（与顶部导航栏的按钮走同一套视图切换）
    runWheelAction(action) {
        this.closeWheel();
        switch (action) {
            case 'home':
                this.goView('home');
                break;
            case 'blog':
                this.goView('blog');
                break;
            case 'gallery':
                this.goView('gallery');
                break;
            case 'music':
                this.goView('music');
                break;
            case 'projects':
                this.goView('projects');
                break;
            case 'news':
                // 简报已并入主页：切回主页并滚到简报卡
                this.goView('home');
                setTimeout(() => this.scrollToSection('homeNews'), 80);
                break;
            case 'theme':
                if (typeof ThemeManager !== 'undefined' && typeof ThemeManager.nextTheme === 'function') {
                    ThemeManager.nextTheme();
                }
                break;
            case 'top': {
                const scroller = document.getElementById('scrollArea');
                if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
                else window.scrollTo({ top: 0, behavior: 'smooth' });
                break;
            }
        }
    },

    // ===================== 留言区（我的视图） =====================

    // 初始化留言区
    async initComments(postId) {
        const section = document.getElementById('comment-section');
        if (!section || section.dataset.ready) return;
        section.dataset.ready = '1';
        this.commentPostId = postId;
        await this.loadComments();
        const form = document.getElementById('comment-form');
        if (form) form.addEventListener('submit', (e) => this.submitComment(e));
        this.commentImageData = null;
        const fileInput = document.getElementById('comment-image');
        if (fileInput) fileInput.addEventListener('change', (e) => this.onCommentImageSelect(e));
        const removeBtn = document.getElementById('comment-image-remove');
        if (removeBtn) removeBtn.addEventListener('click', () => this.clearCommentImage());
    },

    // 选择图片 → 本地预览（待提交时再上传）
    onCommentImageSelect(e) {
        const file = e.target.files && e.target.files[0];
        const tip = document.getElementById('comment-tip');
        if (!file) return;
        const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!validTypes.includes(file.type)) {
            if (tip) tip.textContent = '仅支持 jpg / png / gif / webp 图片';
            e.target.value = '';
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            if (tip) tip.textContent = '图片过大（限 2MB）';
            e.target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            this.commentImageData = reader.result;
            const preview = document.getElementById('comment-image-preview');
            const thumb = document.getElementById('comment-image-thumb');
            if (preview) preview.style.display = 'flex';
            if (thumb) thumb.src = reader.result;
            if (tip) tip.textContent = '';
        };
        reader.readAsDataURL(file);
    },

    // 移除已选图片
    clearCommentImage() {
        this.commentImageData = null;
        const preview = document.getElementById('comment-image-preview');
        if (preview) preview.style.display = 'none';
        const fileInput = document.getElementById('comment-image');
        if (fileInput) fileInput.value = '';
    },

    // 上传图片到后端，返回图片 URL
    async uploadCommentImage() {
        if (!this.commentImageData) return '';
        const mime = (this.commentImageData.match(/^data:(.+?);base64/) || [])[1] || 'image/png';
        const base64 = this.commentImageData.replace(/^data:.+?;base64,/, '');
        const res = await fetch(`${this.config.apiBase}/api/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: base64, mime })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.status !== 'success' || !data.url) {
            throw new Error((data && data.message) || '图片上传失败');
        }
        return data.url;
    },

    // 加载留言
    async loadComments() {
        const list = document.getElementById('comment-list');
        if (!list) return;
        try {
            const res = await fetch(`${this.config.apiBase}/api/comments?postId=${encodeURIComponent(this.commentPostId)}`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const comments = (data && Array.isArray(data.comments)) ? data.comments : [];
            if (!comments.length) {
                list.innerHTML = '<div class="comment-empty">还没有留言，来抢沙发~</div>';
                return;
            }
            list.innerHTML = comments.map(c => `
                <div class="comment-item">
                    <div class="comment-item-head">
                        <div class="comment-item-name">
                            <span class="avatar">${this.escName(c.name || '客')}</span>
                            <span>${this.esc(c.name || '匿名')}</span>
                        </div>
                        <span class="comment-item-time">${this.formatCommentDate(c.createdAt)}</span>
                    </div>
                    <div class="comment-item-content">${this.esc(c.content)}</div>
                    ${c.image ? `<img class="comment-item-image" src="${this.esc(this.commentImageSrc(c.image))}" alt="留言图片" loading="lazy" onclick="openCommentImageLightbox(this)" style="cursor:zoom-in">` : ''}
                </div>
            `).join('');
        } catch (e) {
            /* 静默：属于正常回退路径，不刷控制台 */
            list.innerHTML = '<div class="comment-empty">留言功能暂时不可用</div>';
            const form = document.getElementById('comment-form');
            if (form) form.style.display = 'none';
        }
    },

    // 提交留言
    async submitComment(e) {
        e.preventDefault();
        const nameInput = document.getElementById('comment-name');
        const contentInput = document.getElementById('comment-content');
        const submitBtn = document.getElementById('comment-submit');
        const tip = document.getElementById('comment-tip');
        const name = (nameInput.value || '').trim();
        const content = (contentInput.value || '').trim();
        if (!name || !content) return;

        submitBtn.disabled = true;
        submitBtn.textContent = '提交中...';
        if (tip) tip.textContent = '';
        try {
            let imageUrl = '';
            if (this.commentImageData) {
                if (tip) tip.textContent = '正在上传图片...';
                imageUrl = await this.uploadCommentImage();
            }
            const res = await fetch(`${this.config.apiBase}/api/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ postId: this.commentPostId, name, content, image: imageUrl || undefined })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data || data.status !== 'success') {
                throw new Error((data && data.message) || '提交失败');
            }
            nameInput.value = '';
            contentInput.value = '';
            this.clearCommentImage();
            if (tip) tip.textContent = '留言成功';
            await this.loadComments();
        } catch (err) {
            if (tip) tip.textContent = err.message || '留言失败，请稍后再试';
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = '发表留言';
        }
    },

    // 留言头像首字符
    escName(name) {
        return String(name || '客').charAt(0).toUpperCase();
    },

    // 留言图片 URL：旧动态接口 → 新缓存友好 URL；相对路径补全
    commentImageSrc(url) {
        if (!url) return '';
        if (/^https?:\/\//.test(url)) return url;
        const normalized = this.normalizeImageUrl(url);
        if (normalized.startsWith('/api/')) return this.config.apiBase + normalized;
        return normalized;
    },

    // 格式化留言时间
    formatCommentDate(ts) {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    // 搜索文章（按标题、摘要、标签匹配）
    searchPosts(query) {
        if (!query) {
            this.filteredPosts = [...this.posts];
        } else {
            const lowerQuery = query.toLowerCase();
            this.filteredPosts = this.posts.filter(post =>
                post.title.toLowerCase().includes(lowerQuery) ||
                post.excerpt.toLowerCase().includes(lowerQuery) ||
                (post.tags || []).some(tag => tag.toLowerCase().includes(lowerQuery))
            );
        }

        this.renderPosts();
    },

    // 滚动到页面顶部
    scrollToTop() {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    // 设置事件监听
    setupEventListeners() {
        window.addEventListener('popstate', () => this.handleRoute());
        // 窗口尺寸变化时同步滑块位置
        window.addEventListener('resize', () => {
            this.moveIndicator(this.currentView);
        });
    },

    // 处理 URL 路由（形态 / 标签）——带参数时进入文章视图
    handleRoute() {
        const urlParams = new URLSearchParams(window.location.search);
        const type = urlParams.get('type');
        const tag = urlParams.get('tag');
        if (!type && !tag) return; // 无参数：停留在主页
        this.switchView('blog');
        if (type === 'board' || type === 'article' || type === 'mindmap' || type === 'graph') { this.filterByType(type); return; }
        if (tag) this.filterByTag(tag);
    },

    // 更新 URL 参数
    updateURL() {
        const params = new URLSearchParams();
        if (this.currentType) params.set('type', this.currentType);
        if (this.currentTag) params.set('tag', this.currentTag);
        const queryString = params.toString();
        const newURL = queryString ? `?${queryString}` : window.location.pathname;
        window.history.pushState({}, '', newURL);
    },

    // 获取随机卡片高度（用于瀑布流）
    // 卡片封面高度：由文章 id / 文件名决定，同一篇文章每次渲染都是同一高度。
    // 这样图片懒加载完成时容器高度不会变化，CSS 多列瀑布流不会重排（否则卡片会不断位移）。
    getCardHeight(post) {
        const heights = [180, 200, 220, 240, 260, 280];
        const key = String((post && (post.id || post.filename || post.title)) || '');
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 100000;
        return heights[h % heights.length];
    },

    // 根据标签获取渐变颜色
    getGradientColors(tags) {
        const colorMap = {
            '技术': ['#1a1a1a', '#2a2a2a'],
            'AI':   ['#1a1a1a', '#252525'],
            '生活': ['#181818', '#282828'],
            '学习': ['#1c1c1c', '#2c2c2c'],
            '资讯': ['#12222a', '#1c3540'],
            '默认': ['#151515', '#222222']
        };
        for (const tag of tags) {
            if (colorMap[tag]) return colorMap[tag];
        }
        return colorMap['默认'];
    },

    // 根据标签获取卡片图标
    getCardIcon(tags) {
        const iconMap = {
            '技术': '{ }',
            'AI':   '◇',
            '生活': '○',
            '学习': '△',
            '资讯': '●',
            '默认': '□'
        };
        for (const tag of tags) {
            if (iconMap[tag]) return iconMap[tag];
        }
        return iconMap['默认'];
    },

    // 格式化日期为 YYYY.MM.DD
    formatDate(dateStr) {
        const date = new Date(dateStr);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}.${month}.${day}`;
    },
    // ===================== 卡片堆叠（参考「文件堆叠」设计稿） =====================
    // 多张卡重叠，各带旋转与偏移；滚轮切换最上面那张，点小圆点横向展开。
    stackCards: new Map(),

    initStackBox(box, opts = {}) {
        if (document.body.classList.contains("home-layout")) return;
        if (!box || box.dataset.stackBound) return;
        box.dataset.stackBound = '1';

        const items = [...box.children].filter((el) => el.nodeType === 1);
        if (!items.length) return;

        const state = {
            active: 0,
            expanded: false,
            wheelAt: 0,
            hoverTimer: 0,
        };
        this.stackCards.set(box, state);

        // 摘掉入场动画标记：它会给元素写内联 transform，把堆叠位置盖掉
        items.forEach((el) => {
            el.removeAttribute('data-reveal');
            el.classList.remove('in-view');
            el.style.opacity = '';
            el.style.transform = '';
        });


        // 滚轮切换：卡片和外壳空白处都能滚，滚轮不会带动页面
        const onWheel = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const now = Date.now();
            if (now - state.wheelAt < 280) return;
            state.wheelAt = now;
            const live = [...box.children].filter((el) => el.classList.contains('news-item') || el.classList.contains('hv-photo') || el.classList.contains('home-project'));
            if (!live.length) return;
            const dir = Math.sign(e.deltaY) || 1;
            state.active = (state.active + dir + live.length) % live.length;
            this.paintStack(box);
            startAuto();
        };
        box.addEventListener('wheel', onWheel, { passive: false });
        box.addEventListener('mousewheel', onWheel, { passive: false });
        const outer = box.closest('.hv-photo-box, .hv-news-box, .hv-projects-box');
        if (outer) {
            outer.addEventListener('wheel', onWheel, { passive: false });
            outer.addEventListener('mousewheel', onWheel, { passive: false });
        }

        // 自动轮换：默认就在走（不用悬停），滚轮操作后重新计时
        const startAuto = () => {
            clearInterval(state.hoverTimer);
            state.hoverTimer = setInterval(() => {
                if (document.hidden) return;
                const live = [...box.children].filter((el) => el.classList.contains('news-item') || el.classList.contains('hv-photo') || el.classList.contains('home-project'));
                if (!live.length) return;
                state.active = (state.active + 1) % live.length;
                this.paintStack(box);
            }, opts.autoMs || 3600);
        };
        const stopAuto = () => clearInterval(state.hoverTimer);
        startAuto();
        box.addEventListener('pointerdown', stopAuto);
        box.addEventListener('pointerup', startAuto);

        this.paintStack(box);
    },

    // 按当前 active 计算每张卡的层叠位置
    paintStack(box) {
        const state = this.stackCards.get(box);
        if (!state) return;
        const items = [...box.children].filter((el) => el.classList.contains('news-item') || el.classList.contains('hv-photo') || el.classList.contains('home-project'));
        const n = items.length;
        if (!n) return;

        // 每次都摘掉滚动 reveal 标记 —— 它会写 transform: translateY(0) 压住堆叠位置
        items.forEach((el) => {
            if (el.hasAttribute('data-reveal')) el.removeAttribute('data-reveal');
            if (el.classList.contains('in-view')) el.classList.remove('in-view');
            el.style.setProperty('filter', 'none', 'important');
        });

        // 层叠参数（照「文件堆叠」设计稿）：最上面 -2°，往下依次 +1° / +3° / +4.6°
        const LAYERS = [
            { rot: -2, x: 0, y: 0, z: 40, opacity: 1, scale: 1 },
            { rot: 1, x: 5, y: 5, z: 30, opacity: 0.95, scale: 0.988 },
            { rot: 3, x: 10, y: 10, z: 20, opacity: 0.88, scale: 0.972 },
            { rot: 4.6, x: 15, y: 14, z: 10, opacity: 0.74, scale: 0.956 },
        ];

        items.forEach((el, i) => {
            const pos = (i - state.active + n) % n;      // 0 = 最上面
            const layer = LAYERS[pos];
            // 位置通过 CSS 变量传递，transform 由样式表用 !important 组合出来
            // —— 这样滚动 reveal 往元素上写的内联 transform 压不住它
            if (!layer) {
                el.style.setProperty('--stack-rot', '5deg');
                el.style.setProperty('--stack-x', '18px');
                el.style.setProperty('--stack-y', '17px');
                el.style.setProperty('--stack-s', '0.95');
                el.style.setProperty('--stack-o', '0');
                el.style.setProperty('z-index', '1');
                el.style.setProperty('pointer-events', 'none');
                el.style.visibility = 'hidden';   // 压在最下面的几百张直接不渲染
                return;
            }
            el.style.visibility = '';
            el.style.setProperty('--stack-rot', layer.rot + 'deg');
            el.style.setProperty('--stack-x', layer.x + 'px');
            el.style.setProperty('--stack-y', layer.y + 'px');
            el.style.setProperty('--stack-s', String(layer.scale));
            el.style.setProperty('--stack-o', String(layer.opacity));
            el.style.setProperty('z-index', String(layer.z));
            el.style.setProperty('pointer-events', pos === 0 ? 'auto' : 'none');
        });
    },

    // 简报：全部条目堆成一摞，滚轮循环切换（滚不完）
    initNewsStack() {
        const list = document.getElementById('newsList');
        if (!list || list.dataset.stackInit === '1') return;
        list.dataset.stackInit = '1';
        list.classList.remove('loop-box', 'loop-news');
        list.classList.add('stack-box', 'stack-news');
        this.initStackBox(list, { autoMs: 4200 });
    },

    // 项目：文件堆叠（照「文件堆叠」设计稿）——卡片带旋转偏移叠一摞，滚轮或定时换最上面那张
    // 可重复调用：内容重建后（比如换月份）再传一次，会按新卡片重新叠，滚轮监听只绑一次
    // autoMs: 0 → 不自动翻，只跟手动滚轮
    initFileStack(box, opts = {}) {
        if (!box) return;
        const cardsOf = () => [...box.children]
            .filter((el) => el.nodeType === 1 && !el.classList.contains('hv3-empty'));
        if (!cardsOf().length) return;
        box.classList.add('is-stack');

        // 层叠参数：最上面 -1.6°，往下依次 +1.2° / +2.6° / +3.8°
        const LAYERS = [
            { rot: -1.6, x: 0, y: 0, o: 1, s: 1, z: 40 },
            { rot: 1.2, x: 6, y: 6, o: 0.94, s: 0.985, z: 30 },
            { rot: 2.6, x: 12, y: 11, o: 0.86, s: 0.97, z: 20 },
            { rot: 3.8, x: 17, y: 16, o: 0.72, s: 0.955, z: 10 },
        ];
        const autoMs = opts.autoMs === 0 ? 0 : (opts.autoMs || 4200);
        const state = box._stackState || (box._stackState = { active: 0, timer: 0 });

        const paint = () => {
            const cards = cardsOf();
            const n = cards.length;
            if (!n) return;
            if (state.active >= n || state.active < 0) state.active = 0;
            cards.forEach((el, i) => {
                const pos = (i - state.active + n) % n;
                const L = LAYERS[pos];
                if (!L) {
                    // 压在最下面的那几张直接收起来，别让几百张卡片参与动画
                    el.style.setProperty('--stack-rot', '4.6deg');
                    el.style.setProperty('--stack-x', '20px');
                    el.style.setProperty('--stack-y', '19px');
                    el.style.setProperty('--stack-s', '0.94');
                    el.style.setProperty('--stack-o', '0');
                    el.style.zIndex = '1';
                    el.style.pointerEvents = 'none';
                    el.setAttribute('aria-hidden', 'true');
                    el.tabIndex = -1;
                    return;
                }
                el.removeAttribute('aria-hidden');
                el.tabIndex = 0;
                el.style.setProperty('--stack-rot', L.rot + 'deg');
                el.style.setProperty('--stack-x', L.x + 'px');
                el.style.setProperty('--stack-y', L.y + 'px');
                el.style.setProperty('--stack-s', String(L.s));
                el.style.setProperty('--stack-o', String(L.o));
                el.style.zIndex = String(L.z);
                // 只有最上面那张能点，避免点到后面被盖住的卡片
                el.style.pointerEvents = pos === 0 ? 'auto' : 'none';
            });
        };

        const step = (dir) => {
            const n = cardsOf().length;
            if (!n) return;
            state.active = (state.active + dir + n) % n;
            paint();
        };
        const startAuto = () => {
            clearInterval(state.timer);
            if (!autoMs) return;
            state.timer = setInterval(() => { if (!document.hidden) step(1); }, autoMs);
        };
        const stopAuto = () => clearInterval(state.timer);

        // 对外入口：按索引把某张直接翻到最上面（日记跟日期联动用）
        box.hvStackGoTo = (idx) => {
            const n = cardsOf().length;
            if (!n) return;
            state.active = ((idx % n) + n) % n;
            paint();
        };
        box.hvStackStep = step;

        if (!box.dataset.stackBound) {
            box.dataset.stackBound = '1';
            let wheelAt = 0;
            box.addEventListener('wheel', (e) => {
                e.preventDefault();
                const now = Date.now();
                if (now - wheelAt < 260) return;
                wheelAt = now;
                step(Math.sign(e.deltaY) || 1);
                startAuto();
            }, { passive: false });
            box.addEventListener('pointerenter', stopAuto);
            box.addEventListener('pointerleave', startAuto);
        }

        paint();
        startAuto();
    },

    // 旧入口保留：项目已改成两列网格，不再叠一摞（保留空实现防旧调用报错）
    initProjectStack() {
        this.renderHomeProjects();
    },

    // 项目列表：优先用后台维护的那份，失败/空则保留内置默认
    // _projectsFromApi 只在成功拉到数据后置位；离线或静态预览（接口 501）会下次首页再试一遍
    async loadProjectsData() {
        if (this._projectsFromApi) return;
        try {
            const r = await fetch('/api/admin?action=projects', { cache: 'no-store' });
            if (!r.ok) return;
            const j = await r.json();
            const list = j && j.status === 'success' ? j.data : null;
            if (Array.isArray(list) && list.length) {
                this.deployedProjects = list;
                this._projectsFromApi = true;
                // 主页那块渲染过一次就带 dataset.rendered 标记、再调会被直接 return，
                // 于是「主页还是内置默认、项目页已经换成后台数据」—— 两处对不上。
                // 这里清掉标记，让两边用同一份数据重画。
                const box = document.getElementById('hv3Projects');
                if (box) box.dataset.rendered = '';
                const pageBox = document.getElementById('deployedProjects');
                if (pageBox) pageBox.dataset.rendered = '';
                this.renderHomeProjects();
                this.renderDeployedProjects();
            }
        } catch (e) { /* 保留内置默认值 */ }
    },

    // 照片：全部堆成一摞
    initPhotoStack() {
        const box = document.getElementById('hvPhotos');
        if (!box || box.dataset.stackInit === '1') return;
        box.dataset.stackInit = '1';
        box.classList.remove('loop-box', 'loop-photos');
        box.classList.add('stack-box', 'stack-photos');
        this.initStackBox(box, { autoMs: 3400 });
    },

    // ===================== 无限滚动 =====================
    // 全部内容照常渲染，容器自己滚；内容复制一份接在后面，
    // 滚过中点就把位置减回去，看起来永远滚不到头。
    initLoopScroll(el, opts = {}) {
        if (!el || el.dataset.loopInit === '1') return;
        el.dataset.loopInit = '1';
        el.classList.add('loop-box');
        el.classList.remove('stack-box');

        const kids = [...el.children].filter((k) => k.nodeType === 1);
        if (!kids.length) return;

        kids.forEach((k) => {
            k.removeAttribute('data-reveal');
            k.classList.remove('in-view');
            k.style.removeProperty('transform');
            k.style.removeProperty('opacity');
            k.style.removeProperty('filter');
            k.style.removeProperty('pointer-events');
            ['--stack-rot', '--stack-x', '--stack-y', '--stack-s', '--stack-o', 'z-index']
                .forEach((p) => k.style.removeProperty(p));
        });

        // 补一份副本：列表短就复制，长列表 500 张不再复制
        let doubled = false;
        const need = kids.length <= 60 || el.scrollHeight < el.clientHeight * 2.2;
        if (need) {
            doubled = true;
            const frag = document.createDocumentFragment();
            kids.forEach((k) => frag.appendChild(k.cloneNode(true)));
            el.appendChild(frag);
        }

        // 回卷：有副本就滚过半减半，没副本就到底回顶部
        const wrap = () => {
            if (doubled) {
                const half = el.scrollHeight / 2;
                if (half <= el.clientHeight + 4) return;
                const gap = 2;
                if (el.scrollTop >= half - gap) el.scrollTop -= half - gap;
                else if (el.scrollTop <= 0) el.scrollTop += half - gap;
            } else if (el.scrollTop >= el.scrollHeight - el.clientHeight - 1) {
                el.scrollTop = 0;
            }
        };
        el.addEventListener('scroll', wrap, { passive: true });

        // 自己能滚时先把滚轮吃掉，不让页面跟着动
        el.addEventListener('wheel', (e) => {
            const canDown = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
            const canUp = el.scrollTop > 2;
            if ((e.deltaY > 0 && canDown) || (e.deltaY < 0 && canUp)) e.stopPropagation();
        }, { passive: true });

        // 慢慢自动往下滚
        if (opts.auto !== false) {
            let acc = 0;
            const speed = opts.speed || 0.5;
            setInterval(() => {
                if (document.hidden) return;
                if (el.matches(':hover') || el.dataset.paused === '1') return;
                acc += speed;
                if (acc >= 1) {
                    const step = Math.floor(acc);
                    acc -= step;
                    el.scrollTop += step;
                    wrap();
                }
            }, 32);
            el.addEventListener('pointerdown', () => { el.dataset.paused = '1'; });
            el.addEventListener('pointerup', () => { delete el.dataset.paused; });
            el.addEventListener('pointerleave', () => { delete el.dataset.paused; });
        }
    },

    // 正文手写体开关：默认开启（只有明确存了 '0' 才关）
    applyHandBody(on) {
        if (on === undefined) {
            let raw = '0';
            try { raw = localStorage.getItem('blog-hand-body') ?? '0'; } catch (e) { raw = '0'; }
            on = raw !== '0';
        } else {
            try { localStorage.setItem('blog-hand-body', on ? '1' : '0'); } catch (e) { /* 忽略 */ }
        }
        document.documentElement.classList.toggle('hand-body', !!on);
        const btn = document.getElementById('hvHandBtn');
        if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        return !!on;
    },

    // ===== 首页背景切换 =====
    // 候选 = 默认天空插画 + 图库「收藏」里的横向高清图（运行时取，不再依赖预生成的图池）。
    // 刷新时先用默认图把页面顶住，等图库那张原图真的下载完了，再交叉淡入换上去。
    heroBgPool: null,

    loadHeroBgPool() {
        if (this.heroBgPool) return Promise.resolve(this.heroBgPool);

        // 只请求博客自己的 /api/gallery（它已经代理并缓存了 r-gallery 的清单，
        // 现在还带上了 width / height / fav）。前端不再直连图库站，省掉一次跨域往返。
        return fetch('/api/gallery?limit=1000', { cache: 'no-cache' })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                const photos = (data && Array.isArray(data.photos) ? data.photos : []);
                const usable = photos.filter((p) => {
                    if (!p || !p.id || !p.url) return false;
                    if (String(p.rating || 'general') !== 'general') return false;   // 公开首屏不用 r16/r18
                    const w = Number(p.width) || 0;
                    const h = Number(p.height) || 0;
                    return w > h && w >= 1600;
                });
                // 收藏优先，其余按分辨率降序
                usable.sort((a, b) => {
                    if (!!b.fav !== !!a.fav) return (b.fav ? 1 : 0) - (a.fav ? 1 : 0);
                    return (Number(b.width) || 0) - (Number(a.width) || 0);
                });
                this.heroBgPool = usable.slice(0, 20).map((p) => ({
                    id: p.id,
                    fav: !!p.fav,
                    w: p.width,
                    h: p.height,
                    url: p.url,
                }));
                return this.heroBgPool;
            })
            .catch(() => {
                this.heroBgPool = [];
                return [];
            });
    },

    // 把 sky 层换成指定图；传 null 表示回到默认的天空插画（带 srcset）
    // instant=true 用于「刷新后恢复上次选择」，直接落到底层、不播动画
    applyHeroBg(item, instant) {
        const art = document.getElementById('skyArt');
        if (!art) return;

        const isDefault = !item;
        const url = isDefault ? 'images/sky/kumeng-1920.webp' : item.url;
        if (!url) return;
        const srcset = isDefault ? 'images/sky/kumeng-960.webp 960w, images/sky/kumeng-1920.webp 1920w' : null;

        // 已经是这张了就不折腾
        if (!instant && (art.getAttribute('src') === url)) return;

        const commit = (el) => {
            // srcset 优先于 src，切图前得先摘掉，否则换了 src 也不生效
            el.removeAttribute('srcset');
            if (srcset) el.setAttribute('srcset', srcset);
            el.setAttribute('src', url);
            if (item) el.setAttribute('data-picked', item.id);
            else el.removeAttribute('data-picked');
        };

        const alt = document.getElementById('skyArtAlt');

        if (instant || !alt) { commit(art); return; }

        // 交叉淡入：新图先在下层备好 → 上层淡入盖住 → 底层换成同一张 → 上层淡出并清空
        let settled = false;
        const swap = () => {
            if (settled) return;
            settled = true;
            alt.classList.add('is-visible');
            setTimeout(() => {
                commit(art);
                alt.classList.remove('is-visible');
                setTimeout(() => {
                    alt.removeAttribute('srcset');
                    alt.removeAttribute('src');
                }, 520);
            }, 520);
        };

        alt.removeAttribute('srcset');
        if (srcset) alt.setAttribute('srcset', srcset);
        alt.onload = swap;
        alt.onerror = () => { settled = true; commit(art); };   // 新图挂了就直接换，别卡住
        alt.setAttribute('src', url);
        if (alt.complete && alt.naturalWidth > 0) swap();
    },

    cycleHeroBg() {
        const btn = document.getElementById('hvBgBtn');
        const art = document.getElementById('skyArt');
        if (!art) return;

        this.loadHeroBgPool().then((pool) => {
            // index：0 = 默认天空图，1..n = 图池里的第几张
            let idx = 0;
            try { idx = Number(localStorage.getItem('blog-hero-bg') ?? '0'); } catch (e) { idx = 0; }
            if (!Number.isFinite(idx) || idx < 0) idx = 0;

            const total = pool.length + 1;   // 默认图也算一项
            idx = (idx + 1) % total;

            const item = idx === 0 ? null : pool[idx - 1];
            this.applyHeroBg(item);
            try { localStorage.setItem('blog-hero-bg', String(idx)); } catch (e) { }

            if (btn) {
                const name = item ? ('图库背景 ' + idx + ' / ' + pool.length) : '默认天空背景';
                btn.title = '切换背景（当前：' + name + '）';
                btn.setAttribute('aria-pressed', item ? 'true' : 'false');
            }
        });
    },

    restoreHeroBg() {
        let idx = 0;
        try { idx = Number(localStorage.getItem('blog-hero-bg') ?? '0'); } catch (e) { idx = 0; }
        if (!Number.isFinite(idx) || idx < 0) idx = 0;

        const btn = document.getElementById('hvBgBtn');

        // 没有明确选过（0 = 默认）：等页面加载完再悄悄换一张图库的图，不跟首屏抢带宽
        if (idx === 0) {
            if (btn) { btn.title = '切换背景（当前：默认天空背景）'; btn.setAttribute('aria-pressed', 'false'); }
            const pickLater = () => {
                this.loadHeroBgPool().then((pool) => {
                    if (!pool.length) return;
                    // 当前还是默认图才自动换；用户已经点过就别抢
                    const art = document.getElementById('skyArt');
                    if (!art || art.getAttribute('data-picked')) return;
                    const item = pool[Math.floor(Math.random() * pool.length)];
                    this.applyHeroBg(item);
                    if (btn) {
                        btn.title = '切换背景（当前：图库背景 ' + (pool.indexOf(item) + 1) + ' / ' + pool.length + '）';
                        btn.setAttribute('aria-pressed', 'true');
                    }
                });
            };
            if (document.readyState === 'complete') setTimeout(pickLater, 1200);
            else window.addEventListener('load', () => setTimeout(pickLater, 1200), { once: true });
            return;
        }

        this.loadHeroBgPool().then((pool) => {
            const item = pool[idx - 1];
            if (!item) return;
            this.applyHeroBg(item, true);   // 恢复时直接落地，不播淡入
            if (btn) {
                btn.title = '切换背景（当前：图库背景 ' + idx + ' / ' + pool.length + '）';
                btn.setAttribute('aria-pressed', 'true');
            }
        });
    },

    // 首页时钟旁的主题图标同步
    syncHvThemeIcon() {
        const icon = document.getElementById('hvThemeIcon');
        const btn = document.getElementById('hvThemeBtn');
        if (!icon || !window.ThemeManager) return;
        const t = ThemeManager.getCurrentTheme();
        if (t && t.icon) icon.textContent = t.icon;
        if (btn && t && t.name) btn.title = '当前：' + t.name + '（点击切换）';
    },

    // 灵动岛开关（时钟旁第三个圆钮）：关掉后岛不再弹出来（记忆在 localStorage）
    bindIslandToggle() {
        const btn = document.getElementById('hvIslandBtn');
        if (!btn || btn.dataset.bound) return;
        btn.dataset.bound = '1';

        const apply = (on) => {
            document.body.classList.toggle('island-off', !on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.classList.toggle('is-off', !on);
            btn.title = on ? '灵动岛：开（点击关闭）' : '灵动岛：关（点击开启）';
            try { localStorage.setItem('blog-island-on', on ? '1' : '0'); } catch (e) { /* 忽略 */ }
        };

        let saved = '1';
        try { saved = localStorage.getItem('blog-island-on') ?? '1'; } catch (e) { saved = '1'; }
        apply(saved !== '0');

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            apply(document.body.classList.contains('island-off'));
        });
    },

    /* 时间 / 按钮 上下翻：
       · 默认只露时间
       · 在时间区域往下滚 → 滑出下面那排按钮；往回滚 → 回到时间
       · 鼠标移开 → 自动滚回时间 */
    bindClockFlip() {
        const flip = document.getElementById('hv3ClockFlip');
        if (!flip || flip.dataset.bound) return;
        flip.dataset.bound = '1';
        const clock = flip.querySelector('.hv3-clock');

        // 两页高度都按时钟那页来，翻译位移也用它，保证正好对齐
        const sync = () => {
            const h = clock ? Math.round(clock.getBoundingClientRect().height) : 0;
            if (h <= 0) return;
            flip.style.setProperty('--flip-h', h + 'px');
            flip.style.setProperty('--flip-shift', (-h) + 'px');
        };
        sync();
        setTimeout(sync, 400);       // 字体/时钟内容落位后再校一次
        window.addEventListener('resize', () => setTimeout(sync, 80), { passive: true });

        const setTools = (on) => flip.classList.toggle('is-tools', !!on);

        flip.addEventListener('wheel', (e) => {
            const dy = e.deltaY;
            if (!dy) return;
            e.preventDefault();
            setTools(dy > 0);
        }, { passive: false });

        flip.addEventListener('mouseleave', () => setTools(false));
        // 触屏 / 点击也能切（再点一下收起）
        flip.addEventListener('click', (e) => {
            if (e.target.closest('.hv3-toggle')) return;   // 点按钮本身不切页
            setTools(!flip.classList.contains('is-tools'));
        });
    }
};

window.BlogApp = BlogApp;
