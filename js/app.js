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
    // 当前页码
    currentPage: 1,

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
            // 检查缓存
            const cachedData = sessionStorage.getItem('blog-posts-data');
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
            
            // 缓存结果
            sessionStorage.setItem('blog-posts-data', JSON.stringify(this.posts));
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
        'images/BG/BG (1).jpg', 'images/BG/BG (2).jpg', 'images/BG/BG (3).jpg',
        'images/BG/BG (4).jpg', 'images/BG/BG (5).jpg', 'images/BG/BG (6).jpg',
        'images/BG/BG (7).jpg', 'images/BG/BG (8).jpg', 'images/BG/BG (9).jpg',
        'images/BG/BG (10).jpg', 'images/BG/BG (11).jpg', 'images/BG/BG (12).jpg',
        'images/BG/BG (13).jpg', 'images/BG/BG (14).jpg', 'images/BG/BG (15).jpg',
        'images/BG/BG (16).jpg', 'images/BG/BG (17).jpg', 'images/BG/BG (18).jpg',
        'images/BG/BG (19).jpg', 'images/BG/BG (20).jpg', 'images/BG/BG (21).jpg',
        'images/BG/BG (22).jpg', 'images/BG/BG (23).jpg', 'images/BG/BG (24).jpg',
        'images/BG/BG (25).jpg', 'images/BG/BG (26).jpg', 'images/BG/BG (27).jpg',
        'images/BG/BG (28).jpg'
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
                frontmatter: frontmatter
            };
        } catch (error) {
            console.error(`加载文章 ${filename} 失败:`, error);
            return null;
        }
    },

    // 渲染页面（标签、文章、分页）
    render() {
        this.renderTags();
        this.renderPosts();
        this.renderPagination();
    },

    // 渲染标签筛选栏
    renderTags() {
        const tagsContainer = document.getElementById('tags');
        if (!tagsContainer) return;

        // 收集所有标签
        const allTags = new Set();
        this.posts.forEach(post => {
            (post.tags || []).forEach(tag => allTags.add(tag));
        });

        // 排除的标签
        const excludedTags = ['技术', 'AI', '生活'];
        
        // 过滤掉排除的标签
        const filteredTags = Array.from(allTags).filter(tag => !excludedTags.includes(tag));

        if (filteredTags.length === 0) {
            tagsContainer.innerHTML = '';
            return;
        }

        const tagsHTML = filteredTags.map(tag => `
            <button class="tag-btn ${this.currentTag === tag ? 'active' : ''}"
                    onclick="BlogApp.filterByTag('${tag}')">
                ${tag}
            </button>
        `).join('');

        tagsContainer.innerHTML = `
            <div class="tags-wrap">
                ${tagsHTML}
            </div>
        `;
    },

    // 渲染文章瀑布流
    renderPosts() {
        const postsContainer = document.getElementById('posts');
        if (!postsContainer) return;

        const startIndex = (this.currentPage - 1) * this.config.postsPerPage;
        const endIndex = startIndex + this.config.postsPerPage;
        const postsToShow = this.filteredPosts.slice(startIndex, endIndex);

        if (postsToShow.length === 0) {
            postsContainer.innerHTML = `
                <div style="text-align:center;padding:80px 20px;color:var(--text-muted);">
                    <div style="font-size:48px;margin-bottom:16px;opacity:0.3;">∅</div>
                    <p>暂无文章</p>
                </div>
            `;
            return;
        }

        const postsHTML = postsToShow.map(post => this.renderPostCard(post)).join('');
        postsContainer.innerHTML = `<div class="waterfall">${postsHTML}</div>`;
    },

    // 渲染单个文章卡片
    renderPostCard(post) {
        const gradientColors = this.getGradientColors(post.tags || []);
        const dateFormatted = this.formatDate(post.date);

        return `
            <div class="card" onclick="BlogApp.openPost('${post.filename}')">
                ${post.image ? `
                    <div class="card-img">
                        <img src="${post.image}" alt="${post.title}" class="img-placeholder">
                    </div>
                ` : `
                    <div class="card-img" style="height: ${this.getRandomHeight()}px; background: linear-gradient(145deg, ${gradientColors[0]}, ${gradientColors[1]});">
                        <div class="big-text">${this.getCardIcon(post.tags || [])}</div>
                    </div>
                `}
                <div class="card-body">
                    <div class="card-avatar"></div>
                    <div class="card-username">${post.author}</div>
                    <div class="card-tag">
                        ${(post.tags || []).map(tag => `<span>${tag}</span>`).join(' ')}
                    </div>
                    <div class="card-title">${post.title}</div>
                    <div class="card-desc">${post.excerpt}</div>
                    <div class="card-meta">
                        <span class="card-date">${dateFormatted}</span>
                    </div>
                </div>
            </div>
        `;
    },

    // 渲染分页按钮
    renderPagination() {
        const paginationContainer = document.getElementById('pagination');
        if (!paginationContainer) return;

        const totalPages = Math.ceil(this.filteredPosts.length / this.config.postsPerPage);
        if (totalPages <= 1) {
            paginationContainer.innerHTML = '';
            return;
        }

        let html = '';

        // 上一页按钮
        if (this.currentPage > 1) {
            html += `<button class="page-btn" onclick="BlogApp.goToPage(${this.currentPage - 1})">&larr;</button>`;
        }

        // 页码按钮
        for (let i = 1; i <= totalPages; i++) {
            if (i === this.currentPage) {
                html += `<button class="page-btn active">${i}</button>`;
            } else if (i === 1 || i === totalPages || (i >= this.currentPage - 2 && i <= this.currentPage + 2)) {
                html += `<button class="page-btn" onclick="BlogApp.goToPage(${i})">${i}</button>`;
            } else if (i === this.currentPage - 3 || i === this.currentPage + 3) {
                html += `<span class="page-ellipsis">...</span>`;
            }
        }

        // 下一页按钮
        if (this.currentPage < totalPages) {
            html += `<button class="page-btn" onclick="BlogApp.goToPage(${this.currentPage + 1})">&rarr;</button>`;
        }

        paginationContainer.innerHTML = `<div class="pagination-wrap">${html}</div>`;
    },

    // 按标签筛选文章
    filterByTag(tag) {
        this.currentTag = tag;
        this.currentPage = 1;

        if (tag) {
            this.filteredPosts = this.posts.filter(post => (post.tags || []).includes(tag));
        } else {
            this.filteredPosts = [...this.posts];
        }

        this.renderTags();
        this.renderPosts();
        this.renderPagination();
        this.updateURL();
        this.updateNavLinks();
    },

    // 更新导航栏链接的激活状态
    updateNavLinks() {
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
        });
        document.querySelectorAll('.nav-link').forEach(link => {
            const onclick = link.getAttribute('onclick') || '';
            if (this.currentTag && onclick.includes(`'${this.currentTag}'`)) {
                link.classList.add('active');
            } else if (!this.currentTag && onclick.includes('null')) {
                link.classList.add('active');
            }
        });
    },

    // 跳转到指定页
    goToPage(page) {
        this.currentPage = page;
        this.renderPosts();
        this.renderPagination();

        // 滚动到内容区顶部
        const contentWrapper = document.getElementById('contentWrapper');
        if (contentWrapper) {
            contentWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    },

    // 打开文章详情页
    openPost(filename) {
        window.location.href = `article.html?post=${filename}`;
    },

    // 切换搜索框显示
    toggleSearch() {
        const dropdown = document.getElementById('searchDropdown');
        if (dropdown) {
            dropdown.classList.toggle('show');
            if (dropdown.classList.contains('show')) {
                setTimeout(() => document.getElementById('searchInput').focus(), 100);
            } else {
                // 关闭时清空搜索
                const input = document.getElementById('searchInput');
                if (input) {
                    input.value = '';
                    this.searchPosts('');
                }
            }
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

        this.currentPage = 1;
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
    },

    // 处理 URL 路由（标签和页码）
    handleRoute() {
        const urlParams = new URLSearchParams(window.location.search);
        const tag = urlParams.get('tag');
        const page = urlParams.get('page');

        if (tag) this.filterByTag(tag);
        if (page) this.goToPage(parseInt(page));
    },

    // 更新 URL 参数
    updateURL() {
        const params = new URLSearchParams();
        if (this.currentTag) params.set('tag', this.currentTag);
        if (this.currentPage > 1) params.set('page', this.currentPage);
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
    }
};

window.BlogApp = BlogApp;
