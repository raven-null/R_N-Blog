/**
 * 博客首页核心逻辑
 * 负责文章加载、标签筛选、搜索、分页和渲染
 */
const BlogApp = {
    // 配置项
    config: {
        postsDirectory: 'posts',
        // 后端 API 地址（同源）
        apiBase: ''
    },

    // 所有文章
    posts: [],
    // 筛选后的文章
    filteredPosts: [],
    // 当前选中的标签
    currentTag: null,
    // 当前视图（博客 / 图库 / 仪表盘）
    currentView: 'blog',
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
        console.log('[BlogApp] 渲染完成');
        // 卡片笔记：首页胶囊区（独立加载，失败不影响主页）
        this.renderNotesPills();
        this.setupEventListeners();
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
                        // 旧缓存可能含卡片笔记（已改为首页胶囊区展示，瀑布只保留文章/白板）
                        this.posts = cached.posts.filter(p => p.type !== 'card');
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
                .filter(a => a.status === 'published' && a.type !== 'card') // 卡片笔记走首页胶囊区/灵感页
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

    // 首页「灵感」胶囊区：卡片笔记以胶囊呈现，点击原地展开（不跳转）
    async renderNotesPills() {
        const wrap = document.getElementById('notesPills');
        if (!wrap) return;
        try {
            const res = await fetch('/api/admin?action=articles', { cache: 'no-store' });
            const d = await res.json();
            if (!d || d.status !== 'success' || !Array.isArray(d.data)) return;
            const cards = d.data
                .filter(a => a.status === 'published' && a.type === 'card')
                .sort((a, b) => String(b.date).localeCompare(String(a.date)))
                .slice(0, 6);
            if (!cards.length) return;

            const esc = this.esc.bind(this);
            const plain = (s) => String(s || '').replace(/`/g, '').replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
            const miniMd = (s) => esc(s)
                .replace(/`([^`]+)`/g, '<code>$1</code>')
                .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
                .replace(/\n/g, '<br>');
            const hue = (t) => {
                let h = 0;
                for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
                return h % 360;
            };
            const accent = (tags) => 'hsl(' + hue((tags && tags[0]) || 'card') + ' 70% 62% / 0.75)';

            wrap.innerHTML =
                '<div class="np-head"><strong>灵感</strong><span class="np-count">' + cards.length + ' 条</span>' +
                '<a href="/notes.html">全部 →</a></div>' +
                '<div class="np-list">' +
                cards.map(c => {
                    const ac = accent(c.tags);
                    return '<div class="pill-item" data-id="' + c.id + '">' +
                        '<button class="pill-row" style="--pc:' + ac + '">' +
                        '<span class="pill-dot"></span>' +
                        '<span class="pill-text">' + esc(plain(c.content || '')) + '</span>' +
                        '<span class="pill-date">' + esc(String(c.date || '').slice(0, 10)) + '</span>' +
                        '<span class="pill-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>' +
                        '</button>' +
                        '<div class="pill-panel"><div class="pp-inner"><div class="pp-card" style="--pc:' + ac + '">' +
                        '<div class="pp-body">' + miniMd(c.content || '') + '</div>' +
                        '<div class="pp-foot">' +
                        (c.tags || []).slice(0, 4).map(t => '<span class="t">' + esc(t) + '</span>').join('') +
                        '<span>' + esc(String(c.date || '').slice(0, 10)) + '</span>' +
                        '<button class="pp-copy" data-text="' + esc(c.content || '') + '">复制内容</button>' +
                        '</div></div></div></div>' +
                        '</div>';
                }).join('') +
                '</div>';
            wrap.hidden = false;

            // 手风琴 + 复制
            wrap.querySelectorAll('.pill-item').forEach(item => {
                item.querySelector('.pill-row').addEventListener('click', () => {
                    const isOpen = item.classList.contains('open');
                    wrap.querySelectorAll('.pill-item.open').forEach(o => o.classList.remove('open'));
                    if (!isOpen) item.classList.add('open');
                });
                const copyBtn = item.querySelector('.pp-copy');
                if (copyBtn) copyBtn.addEventListener('click', () => {
                    try {
                        navigator.clipboard.writeText(copyBtn.dataset.text || '');
                        copyBtn.textContent = '已复制';
                        setTimeout(() => { copyBtn.textContent = '复制内容'; }, 1600);
                    } catch (e) { /* ignore */ }
                });
            });
        } catch (e) { /* 胶囊区加载失败不影响主页 */ }
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

        // 内容形态徽标（白板/卡片）
        const typeBadge = post.type === 'whiteboard'
            ? '<span class="card-type-badge">白板</span>'
            : (post.type === 'card' ? '<span class="card-type-badge">卡片</span>' : '');

        // 预计阅读时长（按每 300 字约 1 分钟估算）；白板文章以交互形态替代
        const wordCount = post.wordCount || 0;
        const readTime = Math.max(1, Math.round(wordCount / 300));
        const readingLabel = post.type === 'whiteboard' ? '交互白板' : `${readTime} 分钟`;

        return `
            <div class="card" onclick="BlogApp.openPost('${this.escAttr(post.filename)}', '${this.escAttr(post.id || '')}')">
                ${post.image ? `
                    <div class="card-img">
                        <img src="${this.escAttr(post.image)}" alt="${this.esc(post.title)}" class="img-placeholder" loading="lazy" decoding="async"
                             referrerpolicy="no-referrer"
                             data-g1="${gradientColors[0]}" data-g2="${gradientColors[1]}" data-icon="${this.getCardIcon(post.tags || [])}"
                             onerror="BlogApp.handleCoverError(this)">
                    </div>
                ` : `
                    <div class="card-img" style="height: ${this.getRandomHeight()}px; background: linear-gradient(145deg, ${gradientColors[0]}, ${gradientColors[1]});">
                        <div class="big-text">${this.getCardIcon(post.tags || [])}</div>
                    </div>
                `}
                <div class="card-body">
                    <div class="card-author">
                        <div class="card-avatar" style="background-image:url('${avatarImg}');"></div>
                        <span class="card-username">${authorName}</span>
                    </div>
                    <div class="card-tag">
                        ${typeBadge}
                        ${(post.tags || []).map(tag => `<span>${tag}</span>`).join(' ')}
                    </div>
                    <div class="card-title">${post.title}</div>
                    <div class="card-desc">${post.excerpt}</div>
                    <div class="card-meta">
                        <span class="card-date">${dateFormatted}</span>
                        <span class="card-reading">${readingLabel}</span>
                    </div>
                </div>
            </div>
        `;
    },

    // 按标签筛选文章
    filterByTag(tag) {
        this.currentTag = tag;

        if (tag) {
            this.filteredPosts = this.posts.filter(post => (post.tags || []).includes(tag));
        } else {
            this.filteredPosts = [...this.posts];
        }

        this.renderPosts();
        this.updateNavActive();
        this.updateURL();
        this.closeTagsPanel();
    },

    // 更新导航栏静态标签链接的激活状态
    updateNavActive() {
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
        });
        const tag = this.currentTag;
        document.querySelectorAll('.nav-link').forEach(link => {
            const onclick = link.getAttribute('onclick') || '';
            if (tag && onclick.includes(`'${tag}'`)) link.classList.add('active');
            if (!tag && onclick.includes('null')) link.classList.add('active');
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

    // 切换视图（博客 / 图库 / 每日新闻 / 仪表盘）
    switchView(view) {
        const valid = ['blog', 'gallery', 'news', 'dashboard'];
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
        if (view === 'gallery') this.renderGallery();
        if (view === 'news') this.renderNewsView();
        if (view === 'dashboard') this.renderDashboard();

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

    // 渲染图库（从 Blobs API 加载图库图片，瀑布流布局）
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

    // 加载图库图片（从 Blobs API 获取所有图片）
    // R18 图片：元数据公开（用于「R18」分类下渲染锁定占位卡片），图片内容（缩略图/原图）均需密钥；
    // 已有密钥（后台登录 / 本次会话验证过）时 URL 附加参数直接加载，否则点击时弹窗验证
    async loadGalleryImages() {
        if (this.galleryImages) return this.galleryImages;
        try {
            // 带时间戳绕过 CDN/浏览器缓存：图片标签变更后前台立即可见（否则列表接口 max-age=300 会拿旧数据）
            const res = await fetch('/api/admin?action=images&_=' + Date.now());
            const data = await res.json();
            if (data.status === 'success' && Array.isArray(data.data)) {
                const vk = this.galleryViewKey();
                this.galleryImages = data.data.map(img => {
                    let url = this.normalizeImageUrl(img.url);
                    let thumb = img.thumb ? this.normalizeImageUrl(img.thumb) : '';
                    // 已有密钥：R18 图片 URL 附加密钥参数（<img> 无法带 header）
                    if (vk && this.isR18Image(img)) {
                        const q = 'adminKey=' + encodeURIComponent(vk);
                        url = url + (url.includes('?') ? '&' : '?') + q;
                        if (thumb) thumb = thumb + (thumb.includes('?') ? '&' : '?') + q;
                    }
                    return { key: img.key, url, thumb, tags: img.tags || [] };
                });
            } else {
                this.galleryImages = [];
            }
        } catch {
            this.galleryImages = [];
        }
        return this.galleryImages;
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

    // 判断图片是否归类为 R18（大小写不敏感）
    isR18Image(img) {
        return !!(img && (img.tags || []).some(t => String(t).toLowerCase() === 'r18'));
    },

    // 给图库中所有 R18 图片的 URL 附加密钥参数（验证通过后调用）
    applyR18Keys(key) {
        const q = 'adminKey=' + encodeURIComponent(key);
        (this.galleryImages || []).forEach(img => {
            if (!this.isR18Image(img)) return;
            if (img.url && !img.url.includes('adminKey=')) img.url += (img.url.includes('?') ? '&' : '?') + q;
            if (img.thumb && !img.thumb.includes('adminKey=')) img.thumb += (img.thumb.includes('?') ? '&' : '?') + q;
        });
    },

    // 点击 R18 图片时的密钥验证弹窗：输入管理员密钥，验证通过后本会话内可直接查看
    async requestR18Key() {
        // 已有密钥（后台登录 或 本会话验证过）→ 直接附加并放行
        const existing = this.galleryViewKey();
        if (existing) {
            this.applyR18Keys(existing);
            return true;
        }
        const key = window.prompt('该图片为 R18 内容，请输入管理员密钥后查看：');
        if (!key || !key.trim()) return false;
        // 用密钥请求一张 R18 原图验证（X-Admin-Key 头）
        const target = (this.galleryImages || []).find(img => this.isR18Image(img));
        if (!target) return false;
        try {
            const res = await fetch(target.url, { headers: { 'X-Admin-Key': key.trim() } });
            if (!res.ok) {
                alert('密钥错误，无法查看 R18 图片');
                return false;
            }
        } catch {
            alert('验证失败，请重试');
            return false;
        }
        // 验证通过：存入 localStorage gallery_key（后台退出时会一并清除，实现权限联动失效）
        localStorage.setItem('gallery_key', key.trim());
        this.applyR18Keys(key.trim());
        // 刷新网格，使后续点击的图片 URL 已带密钥
        this.renderGalleryByTag();
        return true;
    },

    // 当前图库筛选标签（'all' 表示全部）
    galleryTag: 'all',

    // 图库分类切换
    setGalleryTag(tag) {
        this.galleryTag = tag || 'all';
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
            } else {
                btn.textContent = this.galleryTag.charAt(0);
            }
        }
        const panel = document.getElementById('galleryTagFloatPanel');
        if (panel) panel.classList.remove('show');
    },

    // 根据当前分类渲染图库
    renderGalleryByTag() {
        const grid = document.getElementById('galleryGrid');
        if (!grid) return;
        // 始终基于完整图库数据（this.galleryImages）筛选
        const allImages = (this.galleryImages && this.galleryImages.length) ? this.galleryImages : [];
        // 「全部」视图不显示 R18；R18 仅在对应分类标签下可见（未验证时显示锁定占位卡片）
        const filtered = this.galleryTag === 'all'
            ? allImages.filter(img => !this.isR18Image(img))
            : allImages.filter(img => (img.tags || []).includes(this.galleryTag));
        // window.__galleryImages 设为当前筛选结果（灯箱在筛选结果内导航）
        window.__galleryImages = filtered;
        if (!filtered.length) {
            grid.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">该分类暂无图片</p>';
            return;
        }
        grid.innerHTML = filtered.map((img, i) => {
            // R18 且未验证密钥：显示锁定占位卡片（不加载任何图片内容）
            if (this.isR18Image(img) && !(img.url || '').includes('adminKey=')) {
                return `<figure class="gallery-item gallery-item-locked" title="R18 内容，点击输入管理员密钥查看"
                     onclick="openGalleryLightbox('${img.url}', ${i})">
                    <div class="gallery-lock-badge">R18</div>
                </figure>`;
            }
            return `<figure class="gallery-item">
                <img src="${img.thumb || img.url}" alt="图片 ${i + 1}" loading="lazy"
                     onclick="openGalleryLightbox('${img.url}', ${i})">
            </figure>`;
        }).join('');
    },

    // 切换图库分类面板
    toggleGalleryTagPanel() {
        const panel = document.getElementById('galleryTagFloatPanel');
        if (!panel) return;
        panel.classList.toggle('show');
    },

    // 加载并渲染图库分类标签
    async renderGalleryTags() {
        const list = document.getElementById('galleryTagFloatList');
        if (!list) return;
        try {
            // 从完整图库数据提取所有标签（后端分类）；
            // 注意不能用 window.__galleryImages（「全部」视图已过滤 R18，会导致管理员看不到 R18 分类）
            const allTags = new Set();
            const images = this.galleryImages || [];
            images.forEach(img => (img.tags || []).forEach(t => allTags.add(t)));
            const tags = [...allTags];
            list.innerHTML = `
                <button class="gallery-tag-item active" data-tag="all" onclick="BlogApp.setGalleryTag('all')">全部</button>
                ${tags.map(t => `<button class="gallery-tag-item" data-tag="${t}" onclick="BlogApp.setGalleryTag('${t}')">${t}</button>`).join('')}
            `;
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

    // 渲染每日新闻视图（列表式，无卡片图片）
    async renderNewsView() {
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
            list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">资讯加载失败</p>';
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

    // 渲染资讯列表（一行一条：出品方徽标 + 标题 + 出品方 · 日期）
    renderNewsList(items) {
        const list = document.getElementById('newsList');
        if (!list) return;
        if (!items.length) {
            list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">暂无资讯</p>';
            return;
        }
        list.innerHTML = items.map(it => `
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

    // 渲染仪表盘（统计概览 + 关于）
    async renderDashboard() {
        const box = document.getElementById('dashboardStats');
        if (!box || box.dataset.rendered) return;
        box.dataset.rendered = '1';

        const settings = this.getBlogSettings();
        const stats = (settings && settings.stats) || { posts: true, tags: true, words: true, images: true };

        const posts = this.posts.length;
        const tags = new Set(this.posts.flatMap(p => p.tags || [])).size;
        const totalWords = this.posts.reduce((s, p) => s + (p.wordCount || 0), 0);
        let images = 0;
        try {
            images = (await this.loadGalleryImages()).length;
        } catch (e) { }

        // 统计概览（根据设置选择显示项）
        const cards = [];
        if (stats.posts !== false) cards.push(`<div class="dashboard-card"><div class="dashboard-num">${posts}</div><div class="dashboard-label">文章</div></div>`);
        if (stats.tags !== false) cards.push(`<div class="dashboard-card"><div class="dashboard-num">${tags}</div><div class="dashboard-label">标签</div></div>`);
        if (stats.words !== false) cards.push(`<div class="dashboard-card"><div class="dashboard-num">${totalWords.toLocaleString('zh-CN')}</div><div class="dashboard-label">总字数</div></div>`);
        if (stats.images !== false) cards.push(`<div class="dashboard-card"><div class="dashboard-num">${images}</div><div class="dashboard-label">图库图片</div></div>`);

        box.innerHTML = cards.join('') || '<div class="dashboard-card"><div class="dashboard-num">—</div><div class="dashboard-label">统计</div></div>';

        // 入场动效（Anime.js）
        if (typeof anime !== 'undefined') {
            anime.animate('.dashboard .dash-hero, .dashboard .dashboard-card, .dashboard .dash-panel', {
                opacity: [0, 1],
                translateY: [16, 0],
                duration: 500,
                delay: anime.stagger(60),
                ease: 'out(2)'
            });
        }

        // 初始化留言区（postId 固定为 dashboard）
        this.initComments('dashboard');
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

    // 处理 URL 路由（标签）
    handleRoute() {
        const urlParams = new URLSearchParams(window.location.search);
        const tag = urlParams.get('tag');
        if (tag) this.filterByTag(tag);
    },

    // 更新 URL 参数
    updateURL() {
        const params = new URLSearchParams();
        if (this.currentTag) params.set('tag', this.currentTag);
        const queryString = params.toString();
        const newURL = queryString ? `?${queryString}` : window.location.pathname;
        window.history.pushState({}, '', newURL);
    },

    // 获取随机卡片高度（用于瀑布流）
    getRandomHeight() {
        const heights = [160, 180, 200, 220, 240, 260, 280, 300];
        return heights[Math.floor(Math.random() * heights.length)];
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
