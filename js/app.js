/**
 * 博客首页核心逻辑
 * 负责文章加载、标签筛选、搜索、分页和渲染
 */
const BlogApp = {
    // 配置项
    config: {
        postsDirectory: 'posts',
        postsPerPage: 10
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
    // 当前已加载的文章数量（加载更多）
    visibleCount: 10,

    // 初始化应用
    async init() {
        ThemeManager.init();
        ThemeManager.createThemeToggle();
        await this.loadPosts();
        this.render();
        this.setupEventListeners();
        this.handleRoute();
    },

    // 加载所有文章
    async loadPosts() {
        try {
            // 检查缓存（带版本号，旧缓存自动失效）
            const CACHE_KEY = 'blog-posts-data-v4';
            const cachedData = sessionStorage.getItem(CACHE_KEY);
            if (cachedData) {
                this.posts = JSON.parse(cachedData);
                this.filteredPosts = [...this.posts];
                return;
            }

            const postFiles = await this.getPostFiles();
            this.posts = [];
            
            // 并行加载所有文章
            const promises = postFiles.map(file => this.loadPost(file));
            const results = await Promise.all(promises);
            this.posts = results.filter(post => post !== null);
            
            // 按日期降序排序
            this.posts.sort((a, b) => new Date(b.date) - new Date(a.date));
            this.filteredPosts = [...this.posts];
            
            // 缓存结果（仅缓存元数据与字数，不缓存正文，避免超长正文超出存储配额）
            try {
                const cacheData = this.posts.map(p => ({
                    filename: p.filename,
                    title: p.title,
                    date: p.date,
                    tags: p.tags,
                    author: p.author,
                    excerpt: p.excerpt,
                    image: p.image,
                    wordCount: p.wordCount || 0
                }));
                sessionStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));
            } catch (e) {
                console.warn('文章缓存失败（不影响使用）:', e);
            }
        } catch (error) {
            console.error('加载文章失败:', error);
        }
    },

    // 获取文章文件列表
    async getPostFiles() {
        try {
            const response = await fetch(`${this.config.postsDirectory}/manifest.json`);
            if (response.ok) return await response.json();
        } catch (e) {
            console.log('未找到 manifest.json，使用默认列表');
        }
        return ['blog-usage-guide.md', 'javascript-async.md', 'jimeng-ai-prompt-framework.md'];
    },

    // 加载单篇文章数据
    // BG 文件夹图片列表（用于无图文章的默认封面）
    bgImages: [
        'images/BG/01_BG.webp', 'images/BG/02_BG.webp', 'images/BG/03_BG.webp',
        'images/BG/04_BG.webp', 'images/BG/05_BG.webp', 'images/BG/06_BG.webp',
        'images/BG/07_BG.webp', 'images/BG/08_BG.webp', 'images/BG/09_BG.webp',
        'images/BG/10_BG.webp', 'images/BG/11_BG.webp', 'images/BG/12_BG.webp',
        'images/BG/13_BG.webp', 'images/BG/14_BG.webp', 'images/BG/15_BG.webp',
        'images/BG/16_BG.webp', 'images/BG/17_BG.webp', 'images/BG/18_BG.webp',
        'images/BG/19_BG.webp', 'images/BG/20_BG.webp', 'images/BG/21_BG.webp',
        'images/BG/22_BG.webp', 'images/BG/23_BG.webp', 'images/BG/24_BG.webp',
        'images/BG/25_BG.webp', 'images/BG/26_BG.webp', 'images/BG/27_BG.webp',
        'images/BG/28_BG.webp'
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

    async loadPost(filename) {
        try {
            const filePath = `${this.config.postsDirectory}/${filename}`;
            const { frontmatter, content } = await MarkdownParser.loadFromFile(filePath);

            // 标准化 tags 为数组
            let tags = [];
            if (Array.isArray(frontmatter.tags)) {
                tags = frontmatter.tags;
            } else if (typeof frontmatter.tags === 'string') {
                tags = frontmatter.tags.split(',').map(t => t.trim()).filter(Boolean);
            }

            return {
                filename,
                title: frontmatter.title || filename.replace('.md', ''),
                date: frontmatter.date || new Date().toISOString().split('T')[0],
                tags,
                author: frontmatter.author || 'Anonymous',
                excerpt: frontmatter.excerpt || MarkdownParser.extractExcerpt(content),
                image: frontmatter.image || MarkdownParser.extractFirstImage(content) || this.getRandomBgImage(filename),
                content: content,
                wordCount: content.length,
                frontmatter: frontmatter
            };
        } catch (error) {
            console.error(`加载文章 ${filename} 失败:`, error);
            return null;
        }
    },

    // 渲染页面（文章、分页）
    render() {
        this.renderPosts();
        this.renderPagination();
    },

    // 渲染文章瀑布流（支持"加载更多"追加）
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

        const end = Math.min(this.visibleCount, this.filteredPosts.length);

        // 首次渲染或筛选重置时替换，否则追加新批次
        const wrap = postsContainer.querySelector('.waterfall');
        if (!wrap || end <= this.config.postsPerPage) {
            const postsHTML = this.filteredPosts.slice(0, end).map(post => this.renderPostCard(post)).join('');
            postsContainer.innerHTML = `<div class="waterfall">${postsHTML}</div>`;
        } else {
            const start = Math.max(0, end - this.config.postsPerPage);
            const newHTML = this.filteredPosts.slice(start, end).map(post => this.renderPostCard(post)).join('');
            const tmp = document.createElement('div');
            tmp.innerHTML = newHTML;
            while (tmp.firstChild) wrap.appendChild(tmp.firstChild);
        }
    },

    // 根据作者名字返回对应头像
    getAuthorAvatar(author) {
        const name = (author || '').trim();
        if (name === '渡鸦NULL') return 'images/TX/01_TX.webp';
        if (name === 'AI') return 'images/TX/02_TX.webp';
        return 'images/TX/03_TX.webp';
    },

    // 渲染单个文章卡片
    renderPostCard(post) {
        const gradientColors = this.getGradientColors(post.tags || []);
        const dateFormatted = this.formatDate(post.date);
        const avatarImg = this.getAuthorAvatar(post.author);

        // 预计阅读时长（按每 300 字约 1 分钟估算）
        const wordCount = post.wordCount || 0;
        const readTime = Math.max(1, Math.round(wordCount / 300));

        return `
            <div class="card" onclick="BlogApp.openPost('${post.filename}')">
                ${post.image ? `
                    <div class="card-img">
                        <img src="${post.image}" alt="${post.title}" class="img-placeholder" loading="lazy"
                             onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(145deg, ${gradientColors[0]}, ${gradientColors[1]})';">
                    </div>
                ` : `
                    <div class="card-img" style="height: ${this.getRandomHeight()}px; background: linear-gradient(145deg, ${gradientColors[0]}, ${gradientColors[1]});">
                        <div class="big-text">${this.getCardIcon(post.tags || [])}</div>
                    </div>
                `}
                <div class="card-body">
                    <div class="card-author">
                        <div class="card-avatar" style="background-image:url('${avatarImg}');"></div>
                        <span class="card-username">${post.author}</span>
                    </div>
                    <div class="card-tag">
                        ${(post.tags || []).map(tag => `<span>${tag}</span>`).join(' ')}
                    </div>
                    <div class="card-title">${post.title}</div>
                    <div class="card-desc">${post.excerpt}</div>
                    <div class="card-meta">
                        <span class="card-date">${dateFormatted}</span>
                        <span class="card-reading">${readTime} 分钟</span>
                    </div>
                </div>
            </div>
        `;
    },

    // 渲染加载更多按钮
    renderPagination() {
        const paginationContainer = document.getElementById('pagination');
        if (!paginationContainer) return;

        const total = this.filteredPosts.length;
        if (total <= this.config.postsPerPage) {
            paginationContainer.innerHTML = '';
            return;
        }

        if (this.visibleCount < total) {
            paginationContainer.innerHTML = `
                <div class="pagination-wrap">
                    <button class="load-more-btn" onclick="BlogApp.loadMore()">加载更多</button>
                </div>
            `;
        } else {
            paginationContainer.innerHTML = `
                <div class="pagination-wrap">
                    <span class="load-more-done">已加载全部 ${total} 篇</span>
                </div>
            `;
        }
    },

    // 加载更多文章
    loadMore() {
        this.visibleCount += this.config.postsPerPage;
        this.renderPosts();
        this.renderPagination();
    },

    // 按标签筛选文章
    filterByTag(tag) {
        this.currentTag = tag;
        this.visibleCount = this.config.postsPerPage;

        if (tag) {
            this.filteredPosts = this.posts.filter(post => (post.tags || []).includes(tag));
        } else {
            this.filteredPosts = [...this.posts];
        }

        this.renderPosts();
        this.renderPagination();
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
    openPost(filename) {
        window.location.href = `article.html?post=${filename}`;
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

    // 切换视图（博客 / 图库 / 仪表盘）
    switchView(view) {
        const valid = ['blog', 'gallery', 'dashboard'];
        if (!valid.includes(view) || this.currentView === view) return;
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

        // 视图显隐
        document.querySelectorAll('.view').forEach(v => {
            v.style.display = v.id === 'view-' + view ? '' : 'none';
        });

        // 首次进入渲染内容
        if (view === 'gallery') this.renderGallery();
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

    // 渲染图库（读取 images/R-N-picture 目录清单，瀑布流布局）
    async renderGallery() {
        const grid = document.getElementById('galleryGrid');
        if (!grid || grid.dataset.rendered) return;
        grid.dataset.rendered = '1';
        try {
            const images = await this.loadGalleryManifest();
            window.__galleryImages = images;
            grid.innerHTML = images.map((src, i) => `
                <figure class="gallery-item">
                    <img src="images/R-N-picture/${src}" alt="图片 ${i + 1}" loading="lazy"
                         onclick="openGalleryLightbox('images/R-N-picture/${src}', ${i})">
                </figure>
            `).join('');
        } catch (e) {
            grid.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">图库加载失败</p>';
        }
    },

    // 加载图库清单（images/R-N-picture/manifest.json，缓存复用）
    async loadGalleryManifest() {
        if (this.galleryImages) return this.galleryImages;
        const res = await fetch('images/R-N-picture/manifest.json');
        if (!res.ok) throw new Error('manifest load failed');
        const images = await res.json();
        this.galleryImages = Array.isArray(images) ? images : [];
        return this.galleryImages;
    },

    // 渲染资讯推荐（读取 data/recommendations.json，新闻卡片）
    async renderNews() {
        const box = document.getElementById('dashNews');
        if (!box || box.dataset.rendered) return;
        box.dataset.rendered = '1';
        try {
            const items = await this.loadNews();
            if (!items.length) {
                box.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:30px;">暂无资讯</p>';
                return;
            }
            box.innerHTML = items.map(item => this.renderNewsCard(item)).join('');
            // 入场动效（Anime.js）
            if (typeof anime !== 'undefined') {
                anime.animate(box.querySelectorAll('.news-card'), {
                    opacity: [0, 1],
                    translateY: [16, 0],
                    duration: 500,
                    delay: anime.stagger(40),
                    ease: 'out(2)'
                });
            }
        } catch (e) {
            box.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:30px;">资讯加载失败</p>';
        }
    },

    // 加载资讯数据
    async loadNews() {
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

    // 渲染单张资讯卡片
    renderNewsCard(item) {
        const category = this.esc(item.category || '资讯');
        const source = this.esc(item.source || '');
        const date = item.date ? this.formatShortDate(item.date) : '';
        return `
            <a class="news-card" href="${item.url}" target="_blank" rel="noopener">
                <div class="news-card-head">
                    <span class="news-cat">${category}</span>
                    <span class="news-meta">${source}${date ? ' · ' + date : ''}</span>
                </div>
                <div class="news-card-title">${this.esc(item.title)}</div>
                ${item.summary ? `<div class="news-card-summary">${this.esc(item.summary)}</div>` : ''}
            </a>
        `;
    },

    // HTML 转义（用于卡片文本）
    esc(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    // 渲染仪表盘（统计概览 + 资讯推荐 + 关于）
    async renderDashboard() {
        const box = document.getElementById('dashboardStats');
        if (!box || box.dataset.rendered) return;
        box.dataset.rendered = '1';

        const posts = this.posts.length;
        const tags = new Set(this.posts.flatMap(p => p.tags || [])).size;
        const totalWords = this.posts.reduce((s, p) => s + (p.wordCount || 0), 0);
        let images = 0;
        try {
            images = (await this.loadGalleryManifest()).length;
        } catch (e) { }

        // 统计概览
        box.innerHTML = `
            <div class="dashboard-card">
                <div class="dashboard-num">${posts}</div>
                <div class="dashboard-label">文章</div>
            </div>
            <div class="dashboard-card">
                <div class="dashboard-num">${tags}</div>
                <div class="dashboard-label">标签</div>
            </div>
            <div class="dashboard-card">
                <div class="dashboard-num">${totalWords.toLocaleString('zh-CN')}</div>
                <div class="dashboard-label">总字数</div>
            </div>
            <div class="dashboard-card">
                <div class="dashboard-num">${images}</div>
                <div class="dashboard-label">图库图片</div>
            </div>
        `;

        // 资讯推荐
        this.renderNews();

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

        this.visibleCount = this.config.postsPerPage;
        this.renderPosts();
        this.renderPagination();
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

    // 格式化短日期为 MM-DD
    formatShortDate(dateStr) {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return dateStr;
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${month}-${day}`;
    }
};

window.BlogApp = BlogApp;
