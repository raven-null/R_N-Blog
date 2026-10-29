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
        // 主页盒子的自由交互：堆叠切换 / 缩放 / 交换
        this.bindBoxPlay();
        // 赛博猫娘对话
        // 首页手写开关（时钟旁第二个小圆钮）
        document.getElementById('hvHandBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.applyHandBody(!document.documentElement.classList.contains('hand-body'));
        });

        // 首页主题切换（时钟旁的小圆钮）
        document.getElementById('hvThemeBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.ThemeManager) {
                ThemeManager.nextTheme();
                this.syncHvThemeIcon();
            }
        });
        this.syncHvThemeIcon();

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
        this.hvClockTimer = setInterval(() => this.renderHvClock(), 1000);
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
            return;
        }

        const postsHTML = this.filteredPosts.map(post => this.renderPostCard(post)).join('');
        postsContainer.innerHTML = `<div class="waterfall">${postsHTML}</div>`;
        if (typeof this.renderPostWall === 'function') this.renderPostWall();
        if (typeof this.renderHvPosts === 'function') this.renderHvPosts();
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

    // 切换视图（主页 / 博客 / 图库 / 项目）
    switchView(view) {
        const valid = ['home', 'blog', 'gallery', 'projects'];
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
        if (view === 'gallery') {
            if (window.GalleryWall) window.GalleryWall.open();
            else this.initGalleryWall();
        }
        if (view === 'projects') this.renderProjects();

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
        const list = document.getElementById('newsList');
        if (!list || list.dataset.rendered) return;
        list.dataset.rendered = '1';
        try {
            const items = await this.loadNews();
            this.newsItems = items;
            this.newsPool = items;
            this.newsShown = 0;
            list.innerHTML = '';
            this.renderMoreNews();
            this.bindNewsInfiniteScroll(list);
            this.fillNewsIfShort(list);
            this.bindNewsHoverScroll();
            // 简报改成堆叠卡片 + 滚轮切换（循环即无限）
            setTimeout(() => this.initNewsStack(), 500);
            this.initNewsStack();
        } catch (e) {
            console.error('资讯加载失败:', e);
            list.innerHTML = '<div class="home-empty">资讯加载失败，稍后再试</div>';
        }
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
        }, 5000);
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
        this.hvClockTimer = setInterval(() => this.renderHvClock(), 1000);
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
        const nameEl = document.querySelector('.hv-name');
        const bioEl = document.querySelector('.hv-bio');
        const avatarEl = document.querySelector('.hv-avatar');
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

    // ---------- 图库图片墙：平移 / 缩放 / 工具条 ----------

    gw: { x: 0, y: 0, s: 1, dragging: false, moved: 0, vx: 0, vy: 0, raf: 0, inertia: 0, inited: false },

    get gwMinS() { return 0.18; },
    get gwMaxS() { return 2.4; },

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
            if (e.target.closest('.gw-hud, button, a, input, .gw-hint')) return;
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
            this.gwApply();
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
    },

    gwApply() {
        const plane = document.getElementById('gwPlane');
        if (!plane) return;
        plane.style.transform = 'translate3d(' + this.gw.x + 'px, ' + this.gw.y + 'px, 0) scale(' + this.gw.s + ')';
    },

    gwZoomAt(px, py, factor) {
        const next = Math.min(this.gwMaxS, Math.max(this.gwMinS, this.gw.s * factor));
        if (Math.abs(next - this.gw.s) < 1e-4) return;
        this.gw.x = px - ((px - this.gw.x) / this.gw.s) * next;
        this.gw.y = py - ((py - this.gw.y) / this.gw.s) * next;
        this.gw.s = next;
        this.gwApply();
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
            this.gwApply();
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

    // 文章轮播：全部文章都在里面，自动切换 + 左右按钮
    renderHvPosts() {
        const track = document.getElementById('hvCarTrack');
        if (!track) return;
        const posts = Array.isArray(this.posts) ? this.posts : [];
        if (!posts.length) {
            if (!track.dataset.empty) {
                track.innerHTML = '<div class="home-empty">还没有文章</div>';
                track.dataset.empty = '1';
            }
            return;
        }
        track.dataset.empty = '';

        track.innerHTML = posts.map((post) => {
            const href = 'article.html?post=' + encodeURIComponent(post.filename || '');
            const title = this.esc(post.title || '无标题');
            const date = this.formatDate ? this.formatDate(post.date) : (post.date || '');
            const tag = (post.tags && post.tags[0]) ? '<span class="hv-post-tag">' + this.esc(post.tags[0]) + '</span>' : '';
            const cover = post.image
                ? '<span class="hv-car-cover"><img src="' + this.escAttr(post.image) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></span>'
                : '';
            return '<a class="hv-car-item" href="' + href + '">'
                + cover
                + '<span class="hv-car-body">'
                + '<span class="hv-car-title">' + title + '</span>'
                + '<span class="hv-car-meta"><span>' + date + '</span>' + tag + '</span>'
                + '</span>'
                + '</a>';
        }).join('');

        this.bindCarousel();
    },

    // 轮播：按钮翻页 + 自动播放
    bindCarousel() {
        const track = document.getElementById('hvCarTrack');
        if (!track || track.dataset.carBound) return;
        track.dataset.carBound = '1';

        const step = () => {
            const first = track.querySelector('.hv-car-item');
            const w = first ? first.getBoundingClientRect().width + 16 : track.clientWidth / 2;
            return Math.max(120, w);
        };

        const slide = (dir) => {
            const w = step();
            const max = track.scrollWidth - track.clientWidth;
            if (max <= 4) return;
            let next = track.scrollLeft + dir * w;
            if (next > max - 4) next = 0;            // 到底回开头，循环
            if (next < 0) next = max;
            track.scrollTo({ left: next, behavior: 'smooth' });
        };

        document.getElementById('hvCarousel')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-car-dir]');
            if (!btn) return;
            e.preventDefault();
            slide(Number(btn.dataset.carDir) || 1);
            restartAuto();
        });

        // 自动播放：8 秒一张，鼠标悬停暂停
        let timer = 0;
        const startAuto = () => {
            clearInterval(timer);
            timer = setInterval(() => slide(1), 8000);
        };
        const restartAuto = () => startAuto();
        const carousel = document.getElementById('hvCarousel');
        if (carousel) {
            carousel.addEventListener('mouseenter', () => clearInterval(timer));
            carousel.addEventListener('mouseleave', startAuto);
        }
        startAuto();
    },

    // 照片盒子：图库照片铺成网格，内部无限滚动（内容复制一份做无缝循环）
    async renderHvPhotos() {
        const box = document.getElementById('hvPhotos');
        if (!box || box.dataset.loaded) return;
        box.dataset.loaded = '1';

        let photos = [];
        try {
            const list = await Promise.race([
                this.loadGalleryImages(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
            ]);
            photos = (list || []).filter((p) => p && (p.thumb || p.url) && !this.isR18Image(p));
        } catch (e) {
            photos = [];
        }

        if (!photos.length) {
            const wrap = box.closest('.hv-photo-box');
            if (wrap) wrap.style.display = 'none';
            return;
        }

        const pick = photos;   // 全部渲染，交给无限滚动
        const tile = (p, i) => {
            const src = String(p.thumb || p.url).replace(/"/g, '&quot;');
            return '<button type="button" class="hv-photo" data-idx="' + i + '" title="看图">'
                + '<img src="' + src + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.visibility=\'hidden\'">'
                + '</button>';
        };
        box.innerHTML = pick.map(tile).join('');

        this.initLoopScroll(box);

        box.addEventListener('click', (e) => {
            const btn = e.target.closest('.hv-photo');
            if (!btn) return;
            const idx = Number(btn.dataset.idx) || 0;
            const photo = pick[idx % pick.length];
            if (!photo) return;
            window.__galleryImages = pick;
            if (typeof window.openGalleryLightbox === 'function') {
                window.openGalleryLightbox(photo.url || photo.thumb, idx % pick.length);
            }
        });

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
        this.renderHomeProjects();
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
        }, 5000);
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
        const box = document.getElementById('homeLife');
        const journalBox = document.getElementById('homeJournalBox');
        if (!box) return;
        this.bindCalendarWheel();
        if (!this.lifeAdminKey()) {
            box.style.display = 'none';
            if (journalBox) journalBox.style.display = 'none';
            const row = box.closest('.hv-side-row');
            if (row) row.style.display = 'none';
            return;
        }

        const today = this.formatDateKey(new Date());
        this.lifeState.date = today;
        this.lifeState.month = today.slice(0, 7);
        this._calViewMonth = this.lifeState.month;
        this.bindLifeEvents();

        await this.loadLifeMonth(this.lifeState.month);
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
            const lifeBox = document.getElementById('homeLife');
            const loggedIn = !!this.lifeAdminKey() && lifeBox && lifeBox.style.display !== 'none';

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
        const monthEl = document.getElementById('lifeMonthLabel');
        const journalDateEl = document.getElementById('journalDateLabel');
        if (monthEl) {
            const [y, m] = this.lifeState.month.split('-');
            monthEl.textContent = `${y} 年 ${Number(m)} 月`;
        }
        if (journalDateEl) journalDateEl.textContent = this.formatDateLabel(this.lifeState.date);
        this.renderLifeTasks();
        this.renderJournalView();
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

    // 日记展示盒子：当天没写就整块折叠
    renderJournalView() {
        const box = document.getElementById('homeJournalBox');
        const body = document.getElementById('journalBody');
        if (!box || !body) return;
        const entry = (this.lifeState.journals || []).find(j => j.date === this.lifeState.date);
        if (!entry || !entry.content) {
            box.style.display = 'none';
            body.innerHTML = '';
            return;
        }
        box.style.display = '';
        body.innerHTML = entry.content
            .split('\n')
            .map(line => `<p>${this.esc(line) || '&nbsp;'}</p>`)
            .join('');
    },

    // 选择日期（日历点击）：从日历下方弹出编写盒子
    selectLifeDate(date) {
        if (!date) return;
        const month = date.slice(0, 7);
        this.lifeState.date = date;
        const after = () => {
            this.renderLife();
            this.updateSelectedCalCell();
            this.openEditor();
        };
        if (month !== this.lifeState.month) {
            this.loadLifeMonth(month).then(ok => { if (ok) after(); });
            return;
        }
        after();
    },

    // 更新日历选中态
    updateSelectedCalCell() {
        document.querySelectorAll('#homeCalendar .cal-day').forEach(el => {
            el.classList.toggle('is-selected', el.dataset.date === this.lifeState.date);
        });
    },

    // 打开编写盒子（第一步：选「任务 / 日记」）
    openEditor() {
        if (!this.lifeAdminKey()) return;
        const wrap = document.getElementById('homeEditorWrap');
        if (!wrap) return;
        const choice = document.getElementById('editorChoice');
        const taskForm = document.getElementById('editorTaskForm');
        const journalForm = document.getElementById('editorJournalForm');
        const label = document.getElementById('editorDateLabel');
        if (choice) choice.style.display = '';
        if (taskForm) taskForm.style.display = 'none';
        if (journalForm) journalForm.style.display = 'none';
        if (label) label.textContent = this.formatDateLabel(this.lifeState.date);

        // 小弹窗：绝对定位浮在日历下方，不参与布局
        wrap.classList.add('is-open');
    },

    // 点「任务 / 日记」→ 选择层隐藏，换成对应编写表单
    chooseEditorKind(kind) {
        const choice = document.getElementById('editorChoice');
        const taskForm = document.getElementById('editorTaskForm');
        const journalForm = document.getElementById('editorJournalForm');
        if (choice) choice.style.display = 'none';

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
        const ta = document.getElementById('editorJournalInput');
        if (ta) {
            const entry = (this.lifeState.journals || []).find(j => j.date === this.lifeState.date);
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

    // 删除当天日记
    async deleteJournal() {
        if (!this.lifeState.date) return;
        try {
            await this.lifeApi(`?type=journal&date=${encodeURIComponent(this.lifeState.date)}`, { method: 'DELETE' });
            this.lifeState.journals = (this.lifeState.journals || []).filter(j => j.date !== this.lifeState.date);
            this.renderJournalView();
        } catch (err) { /* 忽略 */ }
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

    bindLifeEvents() {
        const box = document.getElementById('homeLife');
        if (!box || box.dataset.bound) return;
        box.dataset.bound = '1';

        // 任务展示列表：勾选完成 / 删除
        document.getElementById('lifeTaskList')?.addEventListener('click', (e) => this.onLifeTaskClick(e));

        // 编写盒子：选类型 / 关闭（×）
        const editor = document.getElementById('homeEditor');
        if (editor && !editor.dataset.bound) {
            editor.dataset.bound = '1';
            editor.addEventListener('click', (e) => {
                const kindBtn = e.target.closest('.editor-choice-btn');
                if (kindBtn) {
                    this.chooseEditorKind(kindBtn.dataset.kind);
                    return;
                }
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

        // 归档月份切换
        document.getElementById('lifePrevMonth')?.addEventListener('click', () => this.changeLifeMonth(-1));
        document.getElementById('lifeNextMonth')?.addEventListener('click', () => this.changeLifeMonth(1));

        // 删除当天日记
        document.getElementById('journalDeleteBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteJournal();
        });

        // 日历点击联动（日历会重建，用事件委托）
        document.getElementById('homeCalendar')?.addEventListener('click', (e) => {
            const cell = e.target.closest('.cal-day');
            if (!cell || !cell.dataset.date) return;
            this.selectLifeDate(cell.dataset.date);
        });
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

    // ===================== 桌面宠物：右下角的小幽灵猫 =====================
    // 会飘、眨眼、跟着鼠标看；点一下说话，双击睡觉，可以拖着走（位置记住）

    petSleeping: false,
    petSayTimer: null,
    petIdleTimer: null,

    petLines: [
        '喵～欢迎回来',
        '要不要去「文章」翻翻？',
        '右上角能换主题色，试试看',
        '「图库」会自己一张张滑过去',
        '「项目」里有我做的小东西',
        '把我拖到别的地方也可以喵',
        '双击我，我就去睡觉',
        '今天的简报在下面哦',
        '累了吧？歇一会儿',
        '这座站是我守着的喵',
        '我什么都不用做，就很开心',
        '你按键盘的时候我在看你',
        '别熬夜太晚，喵会心疼',
        '摸摸头也可以（我不躲）',
    ],

    initDeskPet() {
        const pet = document.getElementById('deskPet');
        const body = document.getElementById('deskPetBody');
        if (!pet || !body || pet.dataset.bound) return;
        pet.dataset.bound = '1';

        this.restorePetPos();

        // 桌宠动效引擎（spring-driven character）：弹簧动画 + 多边形眼睛 + 状态机
        this.petEngine = window.GrokCharacter
            ? new window.GrokCharacter(document.getElementById('grokPet'), {
                shape: 'blob',
                color: 'black',
                scheme: 'light',
                mode: 'hold',        // hold：我们手动切状态，不让它自己轮播
                followPointer: true, // 眼睛跟鼠标
            })
            : null;
        if (this.petEngine) {
            this.petEngine.setState('idle');
            this.petEngine.__petIdleTimer = 0;
        }

        let dragging = false;
        let moved = false;
        let startX = 0;
        let startY = 0;
        let originX = 0;
        let originY = 0;
        let lastTap = 0;

        const onDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            const rect = pet.getBoundingClientRect();
            dragging = true;
            moved = false;
            startX = e.clientX;
            startY = e.clientY;
            originX = rect.left;
            originY = rect.top;
            pet.classList.add('is-dragging');
            this.petPlay('dragging', 0);
            try { body.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        };

        const onMove = (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
            if (!moved) return;
            this.movePet(originX + dx, originY + dy);
        };

        const onUp = (e) => {
            if (!dragging) return;
            dragging = false;
            pet.classList.remove('is-dragging');
            this.petPlay('idle', 0);
            try { body.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
            if (moved) {
                this.savePetPos();
                return;
            }
            const now = Date.now();
            if (now - lastTap < 320) {
                lastTap = 0;
                this.togglePetSleep();
                return;
            }
            lastTap = now;
            this.petReact();
        };

        body.addEventListener('pointerenter', () => {
            if (this.petEngine && !this.petSleeping && !dragging) this.petPlay('curious', 0);
        });
        body.addEventListener('pointerleave', () => {
            if (this.petEngine && !this.petSleeping && !dragging) this.petPlay('idle', 0);
        });

        // 你在输入框里打字时，它会竖起来听
        document.addEventListener('focusin', (e) => {
            if (!this.petEngine || this.petSleeping) return;
            if (e.target.closest('input, textarea')) this.petPlay('listening', 0);
        });
        document.addEventListener('focusout', (e) => {
            if (!this.petEngine || this.petSleeping) return;
            if (e.target.closest('input, textarea')) this.petPlay('idle', 0);
        });

        body.addEventListener('pointerdown', onDown);
        body.addEventListener('pointermove', onMove);
        body.addEventListener('pointerup', onUp);
        body.addEventListener('pointercancel', onUp);
        body.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.petReact();
            }
        });

        // 眼睛跟着鼠标：只有鼠标设备才需要
        if (window.matchMedia('(pointer: fine)').matches) {
            document.addEventListener('mousemove', (e) => this.aimPetEyes(e.clientX, e.clientY), { passive: true });
        }

        this.startPetIdle();
        window.addEventListener('resize', () => {
            const rect = pet.getBoundingClientRect();
            if (rect.left > window.innerWidth - 40 || rect.top > window.innerHeight - 40) {
                pet.style.left = '';
                pet.style.top = '';
                pet.style.right = '';
                pet.style.bottom = '';
            }
        });
    },

    // 把宠物定位到视口内（留出边距）
    movePet(x, y) {
        const pet = document.getElementById('deskPet');
        if (!pet) return;
        const w = pet.offsetWidth || 92;
        const h = pet.offsetHeight || 120;
        const maxX = Math.max(8, window.innerWidth - w - 8);
        const maxY = Math.max(8, window.innerHeight - h - 8);
        pet.style.left = Math.round(Math.min(Math.max(x, 8), maxX)) + 'px';
        pet.style.top = Math.round(Math.min(Math.max(y, 8), maxY)) + 'px';
        pet.style.right = 'auto';
        pet.style.bottom = 'auto';
        this.placePetBubble();
    },

    savePetPos() {
        const pet = document.getElementById('deskPet');
        if (!pet) return;
        try {
            localStorage.setItem('deskpet_pos', JSON.stringify({
                x: pet.offsetLeft,
                y: pet.offsetTop,
            }));
        } catch (e) { /* 隐私模式忽略 */ }
    },

    restorePetPos() {
        const pet = document.getElementById('deskPet');
        if (!pet) return;
        let pos = null;
        try {
            pos = JSON.parse(localStorage.getItem('deskpet_pos') || 'null');
        } catch (e) { pos = null; }
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
        this.movePet(pos.x, pos.y);
    },

    // 点一下：跳一下 + 说一句话
    petReact() {
        const pet = document.getElementById('deskPet');
        if (!pet) return;
        if (this.petSleeping) {
            this.togglePetSleep(false);
            this.petSay('喵…醒了');
            return;
        }
        if (this.petEngine) this.petPlay('excited', 1300);
        else {
            pet.classList.remove('is-hop');
            void pet.offsetWidth;
            pet.classList.add('is-hop');
        }
        const lines = this.petLines;
        this.petSay(lines[Math.floor(Math.random() * lines.length)]);
    },

    petSay(text, ms = 3400) {
        const bubble = document.getElementById('deskPetBubble');
        if (!bubble) return;
        bubble.textContent = text;
        bubble.classList.remove('is-below');
        bubble.classList.add('is-show');
        this.placePetBubble();
        clearTimeout(this.petSayTimer);
        this.petSayTimer = setTimeout(() => bubble.classList.remove('is-show'), ms);
    },

    // 气泡贴在宠物上方（放不下就翻到下方），并夹在视口内
    placePetBubble() {
        const bubble = document.getElementById('deskPetBubble');
        const pet = document.getElementById('deskPet');
        if (!bubble || !pet || !bubble.classList.contains('is-show')) return;
        const rect = pet.getBoundingClientRect();
        const bw = bubble.offsetWidth;
        const bh = bubble.offsetHeight;
        const cx = Math.min(
            Math.max(rect.left + rect.width / 2, bw / 2 + 10),
            window.innerWidth - bw / 2 - 10
        );
        let top = rect.top - bh - 12;
        const below = top < 10;
        if (below) top = rect.bottom + 12;
        bubble.classList.toggle('is-below', below);
        bubble.style.left = Math.round(cx) + 'px';
        bubble.style.top = Math.round(top) + 'px';
    },

    togglePetSleep(force) {
        const pet = document.getElementById('deskPet');
        if (!pet) return;
        this.petSleeping = force === undefined ? !this.petSleeping : !!force;
        pet.dataset.state = this.petSleeping ? 'sleep' : 'awake';
        if (this.petEngine) {
            clearTimeout(this.petEngine.__petIdleTimer);
            try { this.petEngine.setState(this.petSleeping ? 'sleeping' : 'idle', { resetEyes: true }); } catch (e) { /* 忽略 */ }
        }
        if (this.petSleeping) {
            clearInterval(this.petIdleTimer);
            this.petIdleTimer = null;
        } else {
            this.startPetIdle();
        }
    },

    // 自己待着的时候，偶尔动一动
    startPetIdle() {
        clearInterval(this.petIdleTimer);
        this.petIdleTimer = setInterval(() => {
            if (document.hidden || this.petSleeping || this.canvasDragging) return;
            this.petPlay(['curious', 'excited', 'happy', 'thinking'][Math.floor(Math.random() * 4)], 1400);
        }, 26000);
    },

    // 眼睛看向鼠标：引擎的 followPointer 已经接管，这里只留一个空实现
    aimPetEyes(mouseX, mouseY) {
        if (!this.petEngine || this.petSleeping) return;
        if (typeof this.petEngine.setFollowPointer === 'function') {
            this.petEngine.setFollowPointer(true);
        }
    },

    // 切状态后过一会儿自己回 idle（引擎在 hold 模式下不会自动回落）
    petPlay(state, backMs = 1200) {
        if (!this.petEngine) return;
        clearTimeout(this.petEngine.__petIdleTimer);
        try { this.petEngine.setState(state, { resetEyes: true }); } catch (e) { return; }
        if (backMs > 0) {
            this.petEngine.__petIdleTimer = setTimeout(() => {
                if (this.petSleeping) return;
                try { this.petEngine.setState('idle'); } catch (e) { /* 忽略 */ }
            }, backMs);
        }
    },

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

    // 高宽比：优先用图片加载后测到的真实比例；还没有就按 id 稳定地编一个
    wallPhotoRatio(p) {
        const known = this.photoWallRatio.get(p.id);
        if (known) return Math.min(2.6, Math.max(0.42, known));
        const s = String(p.id || '');
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000;
        return 0.62 + (h % 100) / 100 * 0.85;   // 0.62 ~ 1.47
    },

    wallComputeLayout() {
        const body = document.getElementById('gwBody');
        const pool = this.photoWallPool;
        if (!body || !pool.length) {
            this.photoWallLayout = null;
            return;
        }
        const W = body.clientWidth || 2400;
        if (this.photoWallView === 'masonry') this.wallComputeMasonry(W);
        else this.wallComputeGrid(W);
        // 给墙内容容器一个实际尺寸（tile 绝对定位，容器本身要有大小）
        const gwBody = document.getElementById('gwBody');
        if (gwBody && this.photoWallLayout) {
            gwBody.style.width = Math.round(this.photoWallLayout.blockW) + 'px';
            gwBody.style.height = Math.round(this.photoWallLayout.blockH) + 'px';
        }
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

        const blockH = rows * (cellH + GAP) - GAP;
        this.photoWallLayout = { items, cols, cellW, cellH, blockW: W, blockH };
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

        this.photoWallLayout = { items, cols, cellW, blockW: W, blockH: blockH - GAP };
    },

    wallRender() {
        const body = document.getElementById('gwBody');
        const layout = this.photoWallLayout;
        if (!body || !layout) return;
        body.classList.toggle('is-masonry', this.photoWallView === 'masonry');

        const alive = new Set();
        for (const it of layout.items) {
            alive.add(it.key);
            let el = this.photoWallTiles.get(it.key);
            if (!el) {
                el = document.createElement('button');
                el.type = 'button';
                el.className = 'gw-tile';
                el.dataset.key = it.key;
                el.dataset.id = it.id;
                const img = document.createElement('img');
                img.loading = 'lazy';
                img.decoding = 'async';
                img.referrerPolicy = 'no-referrer';
                img.alt = '';
                img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
                img.addEventListener('load', () => this.wallNoteRatio(it.id, img));
                el.appendChild(img);
                body.appendChild(el);
                this.photoWallTiles.set(it.key, el);
            }
            const p = this.photoWallById.get(it.id);
            const img = el.firstElementChild;
            const src = p ? (p.thumb || p.url) : '';
            if (src && img.getAttribute('src') !== src) img.src = src;
            el.style.left = it.x + 'px';
            el.style.top = it.y + 'px';
            el.style.width = it.w + 'px';
            el.style.height = it.h + 'px';
            el.classList.toggle('is-big', !!it.big);
            el.classList.toggle('is-expanded', !!it.expanded);
        }
        this.photoWallTiles.forEach((el, key) => {
            if (alive.has(key)) return;
            el.remove();
            this.photoWallTiles.delete(key);
        });
        const sub = document.getElementById('photoWallSub');
        if (sub) sub.textContent = `${this.photoWallPool.length} 张`;
    },

    // 记下真实高宽比；瀑布流下攒够一批就重排一次，让错落更接近真实形状
    wallNoteRatio(id, img) {
        if (!id || !img.naturalWidth) return;
        const ratio = img.naturalHeight / img.naturalWidth;
        const prev = this.photoWallRatio.get(id);
        if (prev && Math.abs(prev - ratio) < 0.02) return;
        this.photoWallRatio.set(id, ratio);
        if (this.photoWallView !== 'masonry') return;
        clearTimeout(this.photoWallRelayoutTimer);
        this.photoWallRelayoutTimer = setTimeout(() => {
            if (this.photoWallView !== 'masonry' || !this.canvasOn) return;
            this.wallComputeLayout();
            this.wallRender();
        }, 700);
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

    // 渲染主页「我的项目」（GitHub 仓库卡片，单行横向，可拖拽/滑动查看）
    async renderHomeProjects() {
        const box = document.getElementById('homeProjectsGrid');
        if (!box || box.dataset.rendered) return;
        box.dataset.rendered = '1';

        const items = await this.loadGithubRepos();
        if (!items.length) {
            box.innerHTML = '<div class="home-empty">项目列表暂时不可用</div>';
            return;
        }

        box.innerHTML = items.map(repo => this.githubRepoCard(repo)).join('');
        this.initProjectStack();
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

    // 已部署的站点（想加项目改这里即可；新站跑一次 scripts/build-project-covers.mjs 生成封面）
    deployedProjects: [
        {
            name: '个人图床',
            desc: '图片托管与图库站点：分类浏览、灯箱查看、幻灯放映，支持访问密码与分级内容。',
            url: 'https://r-gallery.netlify.app/',
            host: 'r-gallery.netlify.app',
            icon: '▦',
            tag: 'JavaScript',
            cover: 'images/projects/gallery.webp',
        },
        {
            name: '个人资料库',
            desc: '资源与文档集中存放，按类目检索，随手取用。',
            url: 'https://r-database.netlify.app/',
            host: 'r-database.netlify.app',
            icon: '▤',
            tag: 'JavaScript',
            cover: 'images/projects/database.webp',
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
            name: '创世',
            desc: '长夜城 · 网页游戏，TypeScript 构建的世界。',
            url: 'https://ravennull.monster/',
            host: 'ravennull.monster',
            icon: '◈',
            tag: 'TypeScript',
            cover: 'images/projects/world.webp',
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
        if (!items.length) {
            box.innerHTML = '<div class="home-empty">仓库列表暂时不可用</div>';
            return;
        }

        box.innerHTML = items.map(repo => this.githubRepoCard(repo)).join('');
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
            if (now - state.wheelAt < 240) return;
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
        const outer = box.closest('.hv-photo-box, .hv-news-box');
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

        // 层叠参数：越靠后转得越多、偏得越远、越淡
        const LAYERS = [
            { rot: -2, x: 0, y: 0, z: 40, opacity: 1, scale: 1 },
            { rot: 1.5, x: 7, y: 7, z: 30, opacity: 0.94, scale: 0.985 },
            { rot: 3.5, x: 14, y: 14, z: 20, opacity: 0.86, scale: 0.97 },
            { rot: 5.5, x: 21, y: 20, z: 10, opacity: 0.72, scale: 0.955 },
        ];

        items.forEach((el, i) => {
            const pos = (i - state.active + n) % n;      // 0 = 最上面
            const layer = LAYERS[pos];
            // 位置通过 CSS 变量传递，transform 由样式表用 !important 组合出来
            // —— 这样滚动 reveal 往元素上写的内联 transform 压不住它
            if (!layer) {
                el.style.setProperty('--stack-rot', '7deg');
                el.style.setProperty('--stack-x', '26px');
                el.style.setProperty('--stack-y', '24px');
                el.style.setProperty('--stack-s', '0.94');
                el.style.setProperty('--stack-o', '0');
                el.style.setProperty('z-index', '1');
                el.style.setProperty('pointer-events', 'none');
                return;
            }
            el.style.setProperty('--stack-rot', layer.rot + 'deg');
            el.style.setProperty('--stack-x', layer.x + 'px');
            el.style.setProperty('--stack-y', layer.y + 'px');
            el.style.setProperty('--stack-s', String(layer.scale));
            el.style.setProperty('--stack-o', String(layer.opacity));
            el.style.setProperty('z-index', String(layer.z));
            el.style.setProperty('pointer-events', pos === 0 ? 'auto' : 'none');
        });
    },

    // 简报列表：全部渲染 + 无限滚动
    initNewsStack() {
        const list = document.getElementById('newsList');
        if (!list || list.dataset.loopInit === '1') return;
        list.classList.remove('stack-box', 'stack-news');
        list.classList.add('loop-box', 'loop-news');
        this.initLoopScroll(list, { auto: true });
    },

    // 项目列表：全部渲染 + 无限滚动
    initProjectStack() {
        const box = document.getElementById('homeProjectsGrid');
        if (!box || box.dataset.loopInit === '1') return;
        box.classList.remove('stack-box', 'stack-projects');
        box.classList.add('loop-box', 'loop-projects');
        this.initLoopScroll(box, { auto: true });
    },

    // 首页照片：全部渲染 + 无限滚动
    initPhotoStack() {
        const box = document.getElementById('hvPhotos');
        if (!box || box.dataset.loopInit === '1') return;
        box.classList.remove('stack-box', 'stack-photos');
        box.classList.add('loop-box', 'loop-photos');
        this.initLoopScroll(box, { auto: true });
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
            let raw = '1';
            try { raw = localStorage.getItem('blog-hand-body') ?? '1'; } catch (e) { raw = '1'; }
            on = raw !== '0';
        } else {
            try { localStorage.setItem('blog-hand-body', on ? '1' : '0'); } catch (e) { /* 忽略 */ }
        }
        document.documentElement.classList.toggle('hand-body', !!on);
        const btn = document.getElementById('hvHandBtn');
        if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        return !!on;
    },
    // 首页时钟旁的主题图标同步
    syncHvThemeIcon() {
        const icon = document.getElementById('hvThemeIcon');
        const btn = document.getElementById('hvThemeBtn');
        if (!icon || !window.ThemeManager) return;
        const t = ThemeManager.getCurrentTheme();
        if (t && t.icon) icon.textContent = t.icon;
        if (btn && t && t.name) btn.title = '当前：' + t.name + '（点击切换）';
    }
};

window.BlogApp = BlogApp;
