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
        console.log('[BlogApp] 初始化开始');
        ThemeManager.init();
        ThemeManager.createThemeToggle();
        await this.loadPosts();
        console.log('[BlogApp] 文章加载完成:', this.posts.length, '篇');
        this.render();
        // 主页为默认视图时，渲染统计概览与最新文章
        if (this.currentView === 'home') this.renderHome();
        // 顶部筛选导航（全部 / 文章 / 白板…）只在文章视图显示
        const navBar = document.getElementById('navBar');
        if (navBar) navBar.style.display = this.currentView === 'blog' ? '' : 'none';
        console.log('[BlogApp] 渲染完成');
        this.setupEventListeners();
        this.bindPagePrefetch();
        this.handleRoute();
        this.startAutoRefresh();
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
            console.log('[loadPosts] 开始加载文章');
            const CACHE_KEY = 'blog-posts-data-v16';
            const CACHE_TTL = 15 * 1000; // 缓存有效期 15 秒（缩短，保证改动后尽快可见）
            const cachedRaw = sessionStorage.getItem(CACHE_KEY);
            if (!force && cachedRaw) {
                try {
                    const cached = JSON.parse(cachedRaw);
                    // 检查缓存是否过期（存有时间戳）
                    if (cached.t && Date.now() - cached.t < CACHE_TTL && Array.isArray(cached.posts)) {
                        console.log('[loadPosts] 使用缓存数据');
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
            console.log('[loadPosts] 从 Blobs 加载文章');
            const blobResults = await this.loadBlobPosts();
            console.log('[loadPosts] Blobs 返回:', blobResults.length, '篇');
            this.posts = blobResults.filter(p => p !== null);
            console.log('[loadPosts] 过滤后:', this.posts.length, '篇');

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
                console.warn('文章缓存失败（不影响使用）:', e);
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

    // 生成文章索引指纹（id + 日期 + 标题，任一变化即视为改动）
    _articlesFingerprint(index) {
        return index
            .filter(a => a.status === 'published')
            .map(a => `${a.id}|${a.date}|${a.update || ''}|${a.title}`)
            .join('§');
    },

    // 静默检查：与服务器索引比对，有变化才重新加载并渲染
    async refreshIfChanged() {
        try {
            const res = await fetch('/api/admin?action=articles', { cache: 'no-store' });
            const data = await res.json();
            if (data.status !== 'success' || !Array.isArray(data.data)) return;
            const fp = this._articlesFingerprint(data.data);
            // 首次调用只记录指纹，不做无谓刷新
            if (this._lastFingerprint === null) {
                this._lastFingerprint = fp;
                return;
            }
            if (fp !== this._lastFingerprint) {
                console.log('[BlogApp] 检测到文章变化，自动刷新');
                this._lastFingerprint = fp;
                await this.loadPosts(true);
                this.render();
            }
        } catch (e) { /* 静默失败，下次轮询再试 */ }
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
            return;
        }

        const postsHTML = this.filteredPosts.map(post => this.renderPostCard(post)).join('');
        postsContainer.innerHTML = `<div class="waterfall">${postsHTML}</div>`;
    },

    // 根据作者名字返回对应头像（站长使用设置中的头像，其他用默认）
    getAuthorAvatar(author) {
        const name = (author || '').trim();
        // 站长（博主/设置中配置的用户名）使用设置页面的头像
        const settings = this.getBlogSettings();
        const authorName = settings ? settings.authorName : '';
        const avatar = settings ? settings.avatar : '';
        // 作者是站长（博主或配置的用户名）→ 用设置的头像
        if (name === '博主' || (authorName && name === authorName)) {
            return avatar || 'images/Default/profile -picture.webp';
        }
        // AI 或其他作者 → 默认头像
        return 'images/Default/profile -picture.webp';
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
                        <img src="${this.escAttr(post.image)}" alt="${this.esc(post.title)}" class="img-placeholder" loading="lazy" decoding="async"
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
                    <img src="${this.escAttr(post.image)}" alt="${this.esc(post.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="BlogApp.handleCoverError(this)">
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

    // 打开文章详情页
    openPost(filename, id) {
        if (id) {
            window.location.href = `article.html?post=${filename}&blob=${id}`;
        } else {
            window.location.href = `article.html?post=${filename}`;
        }
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

    // 切换视图（主页 / 博客 / 图库）
    switchView(view) {
        const valid = ['home', 'blog', 'gallery'];
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

        // 滑块指示器动画
        this.moveIndicator(view);

        // 标签导航仅博客视图展示
        const navBar = document.getElementById('navBar');
        if (navBar) navBar.style.display = view === 'blog' ? '' : 'none';

        // 图库分类按钮仅在图库视图显示
        document.body.classList.toggle('view-gallery-active', view === 'gallery');
        // 切换视图时隐藏分类面板
        const tagPanel = document.getElementById('galleryTagFloatPanel');
        if (tagPanel) tagPanel.classList.remove('show');

        // 视图显隐
        document.querySelectorAll('.view').forEach(v => {
            v.style.display = v.id === 'view-' + view ? '' : 'none';
        });

        // 首次进入渲染内容
        if (view === 'home') this.renderHome();
        if (view === 'gallery') this.renderGallery();

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
    async loadGalleryImages() {
        if (this.galleryImages) return this.galleryImages;
        const base = this.config.galleryBase;
        const token = this.galleryViewKey();
        let list = [];
        let unlocked = false;
        if (token) {
            try {
                list = await this.fetchGalleryPages(base, { token });
                unlocked = true;
            } catch (e) {
                list = [];
                unlocked = false;
            }
        }
        if (!unlocked) {
            try {
                list = await this.fetchGalleryPages(base, { safe: true });
            } catch (e) {
                list = [];
            }
        }
        const tokenQ = unlocked ? 'token=' + encodeURIComponent(token) : '';
        const rawQ = tokenQ ? '?' + tokenQ : '';
        // 缩略图带 v=2：r-gallery 把缩略图从 480px 提到 960px，换 URL 才能绕过 CDN 的旧图缓存
        const thumbQ = tokenQ ? '?' + tokenQ + '&v=2' : '?v=2';
        this.galleryImages = list.map(p => ({
            id: p.id,
            title: p.title || '',
            rating: p.rating || 'general',
            tags: p.tags || [],
            categories: p.categories || [],
            url: base + '/api/photos/' + encodeURIComponent(p.id) + '/raw' + rawQ,
            thumb: base + '/api/photos/' + encodeURIComponent(p.id) + '/thumb' + thumbQ,
        }));
        return this.galleryImages;
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
        // 更新悬浮按钮图标为当前标签首字（默认态显示标签 SVG）
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
            const res = await fetch(`${this.config.apiBase}/api/news?flat=1&limit=80`);
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
            console.warn('后端资讯加载失败，回退本地数据:', e);
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

    // 渲染主页「今日简报」（原「每日新闻」视图，取最新若干条）
    async renderHomeNews() {
        const list = document.getElementById('newsList');
        if (!list || list.dataset.rendered) return;
        list.dataset.rendered = '1';
        try {
            const items = await this.loadNews();
            this.newsItems = items;
            this.buildNewsFilter(items);
            this.renderNewsList(items);
        } catch (e) {
            console.error('资讯加载失败:', e);
            list.innerHTML = '<div class="home-empty">资讯加载失败，稍后再试</div>';
        }
    },

    // 根据新闻出品方动态生成筛选按钮
    buildNewsFilter(items) {
        const box = document.getElementById('newsFilter');
        if (!box) return;
        const sources = new Set(items.map(it => it.source).filter(Boolean));
        box.innerHTML = '<button class="news-filter-btn active" data-cat="all" onclick="BlogApp.filterNews(\'all\')">全部</button>' +
            [...sources].map(s => `<button class="news-filter-btn" data-cat="${this.esc(s)}" onclick="BlogApp.filterNews('${this.esc(s)}')">${this.esc(s)}</button>`).join('');
    },

    // 筛选资讯（全部 / 出品方）
    filterNews(src) {
        document.querySelectorAll('#newsFilter .news-filter-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.cat === src);
        });
        const items = src === 'all' ? this.newsItems : this.newsItems.filter(it => it.source === src);
        this.renderNewsList(items);
    },

    // 渲染资讯列表（主页只展示最新 8 条，一行一条：出品方徽标 + 标题 + 出品方 · 日期）
    renderNewsList(items) {
        const list = document.getElementById('newsList');
        if (!list) return;
        const rows = items.slice(0, 8);
        if (!rows.length) {
            list.innerHTML = '<div class="home-empty">暂无资讯</div>';
            return;
        }
        list.innerHTML = rows.map(it => `
            <a class="news-item" href="${it.url || '#'}" target="_blank" rel="noopener">
                <span class="news-item-cat">${this.esc(it.source || it.category || '资讯')}</span>
                <span class="news-item-title">${this.esc(it.title)}</span>
                <span class="news-item-meta">${this.esc(it.source || '')}${it.date ? ' · ' + this.formatDate(it.date) : ''}</span>
            </a>
        `).join('');

        // 入场动效（Anime.js）
        if (typeof anime !== 'undefined') {
            anime.animate(list.querySelectorAll('.news-item'), {
                opacity: [0, 1],
                translateX: [20, 0],
                duration: 400,
                delay: anime.stagger(25),
                ease: 'out(2)'
            });
        }
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
            // 图完整填充容器（宽高比已经对齐，所以既不留白也不裁切）
            img.style.objectFit = 'fill';
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

    // 渲染主页（入口数字 + 文章区 + 今日简报）
    async renderHome(force = false) {
        // 文章区不依赖网络，先渲染，避免图库接口慢时主页整块空白
        this.renderHomeArticles();
        this.renderHomeNews();
        this.renderHomeCta(force);

        // 入场动效（Anime.js）
        if (typeof anime !== 'undefined') {
            anime.animate('.view-home .dash-hero, .view-home .home-articles > *, .view-home .home-news, .view-home .home-shortcuts, .view-home .dash-bottom', {
                opacity: [0, 1],
                translateY: [16, 0],
                duration: 500,
                delay: anime.stagger(60),
                ease: 'out(2)'
            });
        }
    },

    // 首页入口数字：文章数 / 图库照片数（图库接口慢或离线时显示占位）
    async renderHomeCta(force = false) {
        const postsEl = document.getElementById('homeCtaPosts');
        const photosEl = document.getElementById('homeCtaPhotos');
        if (!postsEl && !photosEl) return;

        if (postsEl && (!postsEl.dataset.rendered || force)) {
            postsEl.textContent = this.posts.length;
            postsEl.dataset.rendered = '1';
        }

        if (photosEl && (!photosEl.dataset.rendered || force)) {
            photosEl.dataset.rendered = '1';
            try {
                // 图库来自外部站点，给个上限，避免一直停在占位
                const list = await Promise.race([
                    this.loadGalleryImages(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('图库接口超时')), 3000)),
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

    // 主页文章区：左封面大卡（最新一篇）+ 右更新列表（其余 4 篇）
    renderHomeArticles() {
        const sorted = this.postsSorted();
        this.renderHomeFeatured(sorted[0]);
        this.renderHomeLatest(sorted.slice(1, 5));
    },

    // 封面大卡：最新一篇
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
                    ? `<img src="${this.escAttr(post.image)}" alt="${this.esc(post.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="BlogApp.handleCoverError(this)">`
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

    // 更新列表：传入要渲染的文章数组
    renderHomeLatest(list) {
        const box = document.getElementById('homeLatest');
        if (!box) return;
        const rows = Array.isArray(list) ? list : this.postsSorted().slice(0, 5);
        if (!rows.length) {
            box.innerHTML = '<div class="home-empty">还没有更多文章</div>';
            return;
        }
        box.innerHTML = rows.map(post => {
            const date = this.formatDate(post.date);
            const tags = (post.tags || []).slice(0, 3).map(t => `<span class="home-tag">${this.esc(t)}</span>`).join('');
            const typeLabel = post.type === 'whiteboard' ? '白板'
                : post.type === 'mindmap' ? '导图'
                : post.type === 'graph' ? '节点图' : '';
            return `
                <a class="home-article" href="article.html?post=${this.escAttr(post.filename)}&blob=${this.escAttr(post.id || '')}">
                    <span class="home-article-date">${date}</span>
                    <span class="home-article-title">${this.esc(post.title)}${typeLabel ? `<span class="home-article-type">${typeLabel}</span>` : ''}</span>
                    <span class="home-article-tags">${tags}</span>
                </a>
            `;
        }).join('');
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

    // ===================== 移动端轮盘菜单 =====================

    wheelOpen: false,

    // 打开 / 收起轮盘
    toggleWheel() {
        if (this.wheelOpen) this.closeWheel();
        else this.openWheel();
    },

    openWheel() {
        const layer = document.getElementById('wheelLayer');
        const trigger = document.getElementById('wheelTrigger');
        if (!layer) return;
        // 环半径按屏幕短边自适应（88–168px）
        const radius = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.31);
        layer.style.setProperty('--wheel-r', Math.max(88, Math.min(radius, 168)) + 'px');
        layer.classList.add('open');
        this.wheelOpen = true;
        if (trigger) {
            trigger.classList.add('active');
            trigger.setAttribute('aria-expanded', 'true');
        }
        document.body.classList.add('wheel-open');
        this.syncWheelActive();
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
    },

    // 高亮当前视图对应的轮盘选项
    syncWheelActive() {
        const layer = document.getElementById('wheelLayer');
        if (!layer) return;
        layer.querySelectorAll('.wheel-item').forEach(el => {
            const m = /runWheelAction\('([^']+)'\)/.exec(el.getAttribute('onclick') || '');
            const action = m ? m[1] : '';
            el.classList.toggle('is-active', action === this.currentView);
        });
    },

    // 执行轮盘选项
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
            console.warn('留言加载失败:', e);
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
    }
};

window.BlogApp = BlogApp;
