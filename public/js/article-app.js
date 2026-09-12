/**
 * 文章页主脚本（由 article.html 内联脚本抽出，便于独立缓存与排查）
 * 改动后请同步 bump article.html 里的 ?v= 版本号
 */
        // 文章详情页应用
        const ArticleApp = {
            // 当前文章数据
            currentPost: null,

            // 后端 API 地址（Netlify 部署的后端）
            apiBase: '',

            // 当前留言所属文章 ID
            postId: null,

            // 所有文章列表（用于上下篇导航）
            allPosts: [],

            // 初始化应用
            async init() {
                ThemeManager.init();
                ThemeManager.createThemeToggle();

                // 从 URL 获取文章文件名
                const urlParams = new URLSearchParams(window.location.search);
                const postFile = urlParams.get('post');
                const isNews = urlParams.get('type') === 'news';
                const blobId = urlParams.get('blob');

                if (!postFile) {
                    this.showError('未指定文章');
                    return;
                }

                // 加载文章（优先 Blobs，无 blobId 时用文件名作为 id）
                if (blobId) {
                    await this.loadBlobArticle(blobId, postFile);
                } else {
                    // 尝试用文件名（去掉 .md）作为 id 从 Blobs 加载
                    const fallbackId = postFile.replace('.md', '');
                    await this.loadBlobArticle(fallbackId, postFile);
                }
                // 初始化留言区
                this.initComments(blobId || postFile);
                // 供聊天窗口直接提问时结合当前文章内容
                window.__currentArticleContext = (this.currentPost && this.currentPost.content) || '';
                // 异步加载文章列表，不阻塞文章渲染（资讯模式不加载，避免上下篇导航错乱）
                if (!isNews) {
                    this.loadAllPosts().then(() => this.renderNavigation());
                } else {
                    const nav = document.getElementById('article-navigation');
                    if (nav) nav.style.display = 'none';
                }
            },

            // 加载 Blobs 后台文章
            async loadBlobArticle(blobId, filename) {
                try {
                    const res = await fetch(`/api/admin?action=articles&id=${blobId}`);
                    const data = await res.json();
                    if (data.status !== 'success' || !data.data) throw new Error('文章不存在');
                    const d = data.data;

                    const content = d.content || '';

                    this.currentPost = {
                        filename: filename,
                        title: d.title,
                        date: d.date || d.createdAt,
                        update: d.updatedAt,
                        tags: d.tags || [],
                        author: d.author || '博主',
                        content: content,
                        type: d.type || 'article',
                        boardId: d.boardId || '',
                        frontmatter: {},
                    };
                    this.renderArticle();
                    document.title = `${this.currentPost.title} - 我的博客`;
                } catch (error) {
                    console.error('加载Blobs文章失败:', error);
                    this.showError('文章加载失败');
                }
            },

            // 加载资讯正文（按 id 从 recommendations.json 匹配，按需解析）
            async loadNewsArticle(id) {
                const res = await fetch('data/recommendations.json');
                if (!res.ok) throw new Error('HTTP 错误: ' + res.status);
                const text = await res.text();
                let items;
                try {
                    items = JSON.parse(text);
                } catch (e) {
                    throw new Error('资讯数据解析失败');
                }
                const item = (Array.isArray(items) ? items : []).find(it => it.id === id);
                if (!item) throw new Error('未找到该资讯');
                if (!item.content) {
                    const err = new Error('该资讯暂无正文');
                    err.noContent = true;
                    err.sourceUrl = item.url;
                    err.sourceName = item.source;
                    throw err;
                }
                this.currentPost = {
                    filename: id,
                    title: item.title,
                    date: item.date,
                    update: null,
                    tags: item.category ? [item.category] : [],
                    author: item.source || '资讯',
                    content: item.content,
                    frontmatter: {},
                    isNews: true
                };
                this.renderArticle();
                document.title = `${this.currentPost.title} - 我的博客`;
            },

            // 加载单篇文章（仅支持资讯，静态文章已迁移至 Blobs）
            async loadArticle(filename, isNews) {
                try {
                    if (isNews) {
                        await this.loadNewsArticle(filename);
                        return;
                    }

                    // 静态文章已迁移至 Blobs，显示错误提示
                    this.showError('文章已迁移，请从首页重新访问');

                } catch (error) {
                    console.error('加载文章失败:', error);
                    if (error.noContent) {
                        const nav = document.getElementById('article-navigation');
                        if (nav) nav.style.display = 'none';
                        this.showNewsNoContent(error.sourceUrl, error.sourceName);
                    } else {
                        this.showError('文章加载失败');
                    }
                }
            },

            // 加载所有文章（用于上下篇导航，优先复用首页缓存）
            async loadAllPosts() {
                try {
                    // 优先复用首页 sessionStorage 缓存（新格式 {t, posts}）
                    // 首页写入的键名带版本号（blog-posts-data-v16 等），这里扫描全部同名键取最新的一份，
                    // 命中即可跳过「整列表」请求（原来写死 v15 导致永远命不中）
                    let homepageCache = null;
                    try {
                        let bestT = -1;
                        for (let i = 0; i < sessionStorage.length; i++) {
                            const k = sessionStorage.key(i);
                            if (!k || k.indexOf('blog-posts-data-') !== 0) continue;
                            const raw = sessionStorage.getItem(k);
                            if (!raw) continue;
                            try {
                                const parsed0 = JSON.parse(raw);
                                const t0 = (parsed0 && parsed0.t) || 0;
                                if (t0 >= bestT) { bestT = t0; homepageCache = raw; }
                            } catch (e) { /* 忽略坏数据 */ }
                        }
                    } catch (e) { /* sessionStorage 不可用时忽略 */ }
                    if (homepageCache) {
                        try {
                            const parsed = JSON.parse(homepageCache);
                            const posts = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.posts) ? parsed.posts : []);
                            this.allPosts = posts.map(p => ({
                                filename: p.filename,
                                title: p.title,
                                date: p.date,
                                tags: p.tags || [],
                                id: p.id || '',
                            }));
                            this.allPosts.sort((a, b) => new Date(b.date) - new Date(a.date));
                            return;
                        } catch (e) { /* 解析失败则回退 */ }
                    }

                    // 回退：检查文章页独立缓存
                    const cachedData = sessionStorage.getItem('blog-posts-cache-v3');
                    if (cachedData) {
                        this.allPosts = JSON.parse(cachedData);
                        return;
                    }

                    // 仅从 Blobs 加载
                    this.allPosts = await this.loadBlobPostList();
                    this.allPosts.sort((a, b) => new Date(b.date) - new Date(a.date));
                    sessionStorage.setItem('blog-posts-cache-v3', JSON.stringify(this.allPosts));
                } catch (error) {
                    console.warn('加载文章列表失败:', error);
                }
            },

            async loadStaticPostList() {
                return [];
            },

            async loadBlobPostList() {
                try {
                    const res = await fetch('/api/admin?action=articles');
                    const data = await res.json();
                    if (data.status !== 'success' || !Array.isArray(data.data)) return [];
                    return data.data.filter(a => a.status === 'published').map(a => ({
                        filename: a.filename || `${a.id}.md`,
                        title: a.title,
                        date: a.date,
                        tags: a.tags || [],
                        id: a.id,
                    }));
                } catch { return []; }
            },

            // 渲染文章头部和正文
            async renderArticle() {
                const header = document.getElementById('article-header');
                const content = document.getElementById('article-content');

                if (!this.currentPost) return;

                // 纯白板文章（type=whiteboard）：整页交互白板，无目录侧栏，跳过 Markdown 管线
                if (this.currentPost.type === 'whiteboard') {
                    await this.renderWhiteboard();
                    return;
                }
                document.body.classList.remove('no-toc');

                // 渲染文章头部信息（与白板文章共用）
                this.renderArticleHeader(header);

                // 异步解析 Markdown（长文使用 Web Worker）
                const html = await MarkdownParser.parseMarkdownAsync(this.currentPost.content);

                // 增量渲染：按 h2/h3 分段，首屏先渲染前 3 块，其余空闲时追加
                const sections = html.split(/(?=<h[23][^>]*>)/);
                const firstBatch = sections.splice(0, 3);
                content.innerHTML = firstBatch.join('');

                // 文章内容入场动画（Anime.js）
                if (window.BlogAnimations && BlogAnimations.ready) {
                    BlogAnimations.animateArticleContent(content);
                }

                // 首屏代码块立即高亮
                requestAnimationFrame(() => this.highlightVisibleBlocks(content));

                // 剩余段落用 requestIdleCallback 渐进追加
                if (sections.length > 0) {
                    const appendNext = () => {
                        if (sections.length === 0) {
                            // 全部渲染完成后：高亮剩余代码块 + 挂载 Excalidraw 内嵌 + 生成完整目录
                            this.highlightRemainingBlocks(content);
                            this.mountExcalidrawEmbeds(content);
                            requestAnimationFrame(() => this.generateTableOfContents());
                            return;
                        }
                        const chunk = sections.splice(0, 2).join('');
                        content.insertAdjacentHTML('beforeend', chunk);
                        if ('requestIdleCallback' in window) {
                            requestIdleCallback(appendNext);
                        } else {
                            setTimeout(appendNext, 0);
                        }
                    };
                    if ('requestIdleCallback' in window) {
                        requestIdleCallback(appendNext);
                    } else {
                        setTimeout(appendNext, 0);
                    }
                } else {
                    // 短文无增量渲染：挂载 Excalidraw 内嵌，直接生成目录
                    this.mountExcalidrawEmbeds(content);
                    requestAnimationFrame(() => this.generateTableOfContents());
                }
            },

            // 文章头部信息（普通文章与纯白板文章共用）
            renderArticleHeader(header) {
                const dateFormatted = this.formatDate(this.currentPost.date);
                header.innerHTML = `
                    <h1 class="article-title">${this.currentPost.title}</h1>
                    <div class="article-meta">
                        <div class="meta-item">
                            <svg class="meta-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                                <circle cx="12" cy="7" r="4"></circle>
                            </svg>
                            <span>${this.currentPost.author}</span>
                        </div>
                        <div class="meta-item">
                            <svg class="meta-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                <line x1="16" y1="2" x2="16" y2="6"></line>
                                <line x1="8" y1="2" x2="8" y2="6"></line>
                                <line x1="3" y1="10" x2="21" y2="10"></line>
                            </svg>
                            <span>${dateFormatted}</span>
                        </div>
                        ${this.currentPost.update ? `
                        <div class="meta-item">
                            <svg class="meta-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <polyline points="1 20 1 14 7 14"></polyline>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                            </svg>
                            <span>更新于 ${this.formatDate(this.currentPost.update)}</span>
                        </div>
                        ` : ''}
                        <div class="meta-item">
                            <svg class="meta-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                                <line x1="7" y1="7" x2="7.01" y2="7"></line>
                            </svg>
                            <span>${this.currentPost.tags.length} 个标签</span>
                        </div>
                    </div>
                    ${this.currentPost.tags.length > 0 ? `
                        <div class="article-tags">
                            ${this.currentPost.tags.map(tag => `<span class="article-tag">${tag}</span>`).join('')}
                        </div>
                    ` : ''}
                `;
            },

            // 纯白板文章：沉浸式画布舞台（无文档感：标题/评论收进悬浮控件，画廊式导航）
            async renderWhiteboard() {
                const content = document.getElementById('article-content');
                if (!this.currentPost) return;
                document.body.classList.add('board-mode', 'no-toc');

                // 头部信息不占版面（移入「信息」浮层）
                const header = document.getElementById('article-header');
                if (header) header.innerHTML = '';

                const boardId = (this.currentPost.boardId || '').trim();
                if (!boardId || !/^[A-Za-z0-9_-]{1,64}$/.test(boardId)) {
                    content.innerHTML = '<div class="board-stage"><div class="board-canvas-empty">这篇白板文章尚未关联画板</div></div>';
                    return;
                }

                // 评论区整块移入右侧抽屉（复用全部留言逻辑）
                const comments = document.getElementById('comment-section');

                const p = this.currentPost;
                const escT = this.escHtml ? this.escHtml : (s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
                const title = escT(p.title || '白板');
                const tagChips = (p.tags || []).map(t => '<span>' + escT(t) + '</span>').join('');

                content.innerHTML =
                    '<div class="board-stage" id="boardStage" data-board="' + boardId + '">' +
                    '<div class="board-canvas"><div id="boardCanvasHost" data-excalidraw data-note="' + boardId + '" data-mode="view"></div></div>' +
                    '<div class="board-bottom" id="boardBottom">' +
                    '<div class="board-topbar" id="boardTopbar">' +
                    '<a class="bt-btn bb-view-only" href="/" title="返回博客"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10.5 9-7.5 9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg></a>' +
                    '<button class="bt-btn bb-view-only" id="boardEditBtn" title="在当前页面直接编辑此白板"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>编辑</button>' +
                    '<button class="bt-btn bb-view-only" id="boardInfoBtn" title="白板信息"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".4" fill="currentColor"/></svg>信息</button>' +
                    '<button class="bt-btn bb-view-only" id="boardCommentBtn" title="留言"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>留言</button>' +
                    '<button class="board-save bb-edit-only" id="boardSaveBtn" title="保存到服务器（桌面端 Ctrl / ⌘ + S）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg><span id="boardSaveLabel">保存</span></button>' +
                    '<button class="board-done bb-edit-only" id="boardDoneBtn" title="退出编辑（有改动会先问是否保存）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>完成</button>' +
                    '<span class="board-tip" id="boardTip"></span>' +
                    '</div>' +
                    '</div>' +
                    '<div class="board-pop" id="boardInfoPop" hidden>' +
                    '<h4>' + title + '</h4>' +
                    '<div class="bp-row"><span class="k">作者</span><span>' + escT(p.author || '博主') + '</span></div>' +
                    '<div class="bp-row"><span class="k">日期</span><span>' + escT(p.date || '') + '</span></div>' +
                    (p.update ? '<div class="bp-row"><span class="k">更新</span><span>' + escT(p.update) + '</span></div>' : '') +
                    '<div class="bp-row"><span class="k">画板</span><span style="word-break:break-all">' + escT(boardId) + '</span></div>' +
                    '<div class="bp-tags">' + (tagChips || '<span style="opacity:.5">无标签</span>') + '</div>' +
                    '<div class="bp-actions">' +
                    '<a class="bt-btn" style="background:rgba(255,255,255,.08)" href="/excalidraw.html?note=' + encodeURIComponent(boardId) + '&edit=1" target="_blank" title="在新窗口打开完整编辑器">完整编辑器</a>' +
                    '<button class="bt-btn" id="boardShareBtn" style="background:rgba(255,255,255,.08)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>复制链接</button>' +
                    '</div></div>' +
                    '<div class="board-scrim" id="boardScrim"></div>' +
                    '<aside class="board-drawer" id="boardDrawer" aria-hidden="true">' +
                    '<div class="board-drawer-head"><span class="dh-title">留言</span></div>' +
                    '<div class="board-drawer-body" id="boardDrawerBody"></div>' +
                    '</aside>' +
                    '<div class="board-dlg" id="boardDlg">' +
                    '<div class="bd-card">' +
                    '<div class="bd-title">退出编辑</div>' +
                    '<div class="bd-sub">改动需要先写入服务器才会保留。可点编辑界面下方的「保存」按钮，或按 Ctrl / ⌘ + S。</div>' +
                    '<div class="bd-btns">' +
                    '<button class="bd-btn primary" id="bdSaveExit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg>保存并退出</button>' +
                    '<button class="bd-btn" id="bdDiscardExit">不保存，直接退出</button>' +
                    '<button class="bd-btn" id="bdCancel">取消</button>' +
                    '</div>' +
                    '<div class="bd-err" id="bdErr"></div>' +
                    '</div></div>' +
                    '<button class="board-navbtn prev" id="boardPrev" hidden title="上一篇"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>' +
                    '<button class="board-navbtn next" id="boardNext" hidden title="下一篇"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>' +
                    '</div>';

                // 评论区移入抽屉
                const drawerBody = document.getElementById('boardDrawerBody');
                if (comments && drawerBody) drawerBody.appendChild(comments);

                this.initBoardMode();
                // 懒加载 Excalidraw bundle（onload 后自动挂载画布容器）
                this.loadExcalidrawBundle();
            },

            // 画布舞台控件：信息/评论抽屉/画廊导航/闲置自动隐藏
            initBoardMode() {
                const stage = document.getElementById('boardStage');
                if (!stage) return;
                const infoPop = document.getElementById('boardInfoPop');
                const infoBtn = document.getElementById('boardInfoBtn');
                const drawer = document.getElementById('boardDrawer');
                const scrim = document.getElementById('boardScrim');
                const drawerBody = document.getElementById('boardDrawerBody');

                // 评论抽屉（评论区已移入 drawerBody，直接显示）
                const openDrawer = () => {
                    stage.classList.add('drawer-open');
                    drawer.classList.add('open');
                    drawer.setAttribute('aria-hidden', 'false');
                    scrim.classList.add('show');
                    if (drawerBody && !drawerBody.dataset.init) {
                        drawerBody.dataset.init = '1';
                        const section = drawerBody.querySelector('.dash-panel');
                        if (section) section.style.display = '';
                    }
                };
                const closeDrawer = () => {
                    stage.classList.remove('drawer-open');
                    drawer.classList.remove('open');
                    drawer.setAttribute('aria-hidden', 'true');
                    scrim.classList.remove('show');
                };
                const closeAll = () => { closeDrawer(); infoPop.hidden = true; };
                const cb = document.getElementById('boardCommentBtn');
                if (cb) cb.addEventListener('click', openDrawer);
                if (scrim) scrim.addEventListener('click', closeAll);
                // 抽屉/浮层没有关闭按钮后：点遮罩或按 Esc 关闭
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') closeAll();
                });

                // 信息浮层
                if (infoBtn) infoBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    infoPop.hidden = !infoPop.hidden;
                });
                const shareBtn = document.getElementById('boardShareBtn');
                if (shareBtn) shareBtn.addEventListener('click', () => {
                    try {
                        navigator.clipboard.writeText(location.href);
                        shareBtn.textContent = '已复制链接';
                        setTimeout(() => { shareBtn.textContent = '复制链接'; }, 1800);
                    } catch (e) { /* 剪贴板不可用时忽略 */ }
                });

                // 就地编辑：view ↔ edit 原地切换（不跳转；口令/保存/权限由编辑器组件自带）
                const boardId = stage.dataset.board || '';
                const mountBoardHost = (mode) => {
                    const old = document.getElementById('boardCanvasHost');
                    if (!old || !old.parentNode) return;
                    const div = document.createElement('div');
                    div.id = 'boardCanvasHost';
                    div.dataset.excalidraw = '';
                    div.dataset.note = boardId;
                    div.dataset.mode = mode;
                    div.dataset.bare = '1'; // 前台舞台：精简模式（无工具条，Ctrl+S/退出询问保存）
                    old.parentNode.replaceChild(div, old);
                    if (window.ExcalidrawMount) window.ExcalidrawMount();
                    else this.loadExcalidrawBundle(); // bundle 未就绪：加载完成后会自动扫描当前容器
                };
                const enterEdit = () => {
                    if (stage.dataset.editing === '1') return;
                    stage.dataset.editing = '1';
                    stage.classList.add('editing');
                    mountBoardHost('edit');
                };
                const dlg = document.getElementById('boardDlg');
                const dlgErr = document.getElementById('bdErr');
                const showDlg = () => {
                    if (stage.dataset.editing !== '1') return;
                    if (dlgErr) { dlgErr.classList.remove('show'); dlgErr.textContent = ''; }
                    if (dlg) dlg.classList.add('show');
                };
                const hideDlg = () => { if (dlg) dlg.classList.remove('show'); };
                const doExit = () => {
                    stage.dataset.editing = '';
                    stage.classList.remove('editing');
                    mountBoardHost('view');
                    // 恢复浮层可见性（idle 状态由鼠标唤醒）
                    stage.classList.remove('idle');
                    hideDlg();
                };
                const doSaveAndExit = async () => {
                    const saver = window.__excalidrawSave;
                    if (!saver) { doExit(); return; }
                    const saved = await saver();
                    if (saved) { doExit(); return; }
                    // 保存未完成（口令错误/只读/空画布等）：留在编辑态并提示
                    if (dlgErr) {
                        dlgErr.textContent = '保存未完成（可能未输入口令、画布为空或网络问题）。可取消后重试，或选择不保存退出。';
                        dlgErr.classList.add('show');
                    }
                };
                const editBtn = document.getElementById('boardEditBtn');
                if (editBtn) editBtn.addEventListener('click', enterEdit);
                const doneBtn = document.getElementById('boardDoneBtn');
                if (doneBtn) doneBtn.addEventListener('click', () => {
                    if (stage.dataset.editing !== '1') return;
                    // 已保存（无未保存改动）直接退出；有改动才询问保存
                    const dirty = !!(window.__excalidrawDirty && window.__excalidrawDirty());
                    if (dirty) showDlg(); else doExit();
                });
                const saveBtn = document.getElementById('boardSaveBtn');
                const boardTip = document.getElementById('boardTip');
                const showTip = (msg, ok) => {
                    if (!boardTip) return;
                    boardTip.textContent = msg;
                    boardTip.className = 'board-tip show ' + (ok ? 'ok' : 'err');
                    clearTimeout(boardTip._t);
                    boardTip._t = setTimeout(() => { boardTip.className = 'board-tip'; }, 2800);
                };
                const doSave = async () => {
                    if (!window.__excalidrawSave) { showTip('编辑器尚未就绪，请稍候', false); return; }
                    const lbl = document.getElementById('boardSaveLabel');
                    if (saveBtn) saveBtn.disabled = true;
                    if (lbl) lbl.textContent = '保存中…';
                    let saved = false;
                    try { saved = await window.__excalidrawSave(); } catch (e) { saved = false; }
                    if (saveBtn) saveBtn.disabled = false;
                    if (lbl) lbl.textContent = saved ? '已保存' : '保存';
                    showTip(saved ? '已保存到服务器' : '保存未完成（可能需要口令、画布为空或网络问题）', saved);
                    if (saved) setTimeout(() => { if (lbl) lbl.textContent = '保存'; }, 1800);
                };
                if (saveBtn) saveBtn.addEventListener('click', doSave);
                const bdSaveExit = document.getElementById('bdSaveExit');
                if (bdSaveExit) bdSaveExit.addEventListener('click', doSaveAndExit);
                const bdDiscard = document.getElementById('bdDiscardExit');
                if (bdDiscard) bdDiscard.addEventListener('click', doExit);
                const bdCancel = document.getElementById('bdCancel');
                if (bdCancel) bdCancel.addEventListener('click', hideDlg);
                if (dlg) dlg.addEventListener('click', (e) => { if (e.target === dlg) hideDlg(); });
                // 分享链接带 &edit=1 时打开即进入编辑态（可编辑分享链接）
                if (new URLSearchParams(location.search).get('edit') === '1') enterEdit();

                // 画廊式上下篇（原隐藏导航卡中取 href）
                const navHref = (sel) => {
                    const el = document.querySelector(sel);
                    return el && el.getAttribute('href') ? el.getAttribute('href') : '';
                };
                const prev = document.getElementById('boardPrev');
                const next = document.getElementById('boardNext');
                const prevHref = navHref('.nav-card.prev');
                const nextHref = navHref('.nav-card.next');
                if (prev && prevHref) { prev.hidden = false; prev.addEventListener('click', () => { location.href = prevHref; }); }
                if (next && nextHref) { next.hidden = false; next.addEventListener('click', () => { location.href = nextHref; }); }

                // 闲置自动隐藏控件（鼠标/触控唤醒）；触屏由 CSS 保持常驻
                if (window.matchMedia('(hover: hover)').matches) {
                    let timer = null;
                    const wake = () => {
                        stage.classList.remove('idle');
                        clearTimeout(timer);
                        timer = setTimeout(() => stage.classList.add('idle'), 2600);
                    };
                    stage.addEventListener('mousemove', wake);
                    stage.addEventListener('touchstart', wake);
                    wake();
                }

                // Esc 关闭浮层/抽屉
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') closeAll();
                });
            },

            // Excalidraw 内嵌：把 ```excalidraw 代码块替换为交互白板容器，按需懒加载 bundle
            mountExcalidrawEmbeds(container) {
                let found = 0;
                container.querySelectorAll('.code-block code.language-excalidraw').forEach(code => {
                    const id = (code.textContent || '').trim();
                    const block = code.closest('.code-block');
                    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
                        if (block) {
                            const err = document.createElement('div');
                            err.className = 'excalidraw-embed excalidraw-error';
                            err.textContent = '白板 ID 无效：' + (id || '（空）');
                            block.replaceWith(err);
                        }
                        return;
                    }
                    const div = document.createElement('div');
                    div.className = 'excalidraw-embed';
                    div.dataset.excalidraw = '';
                    div.dataset.note = id;
                    div.dataset.mode = 'view';
                    div.textContent = '白板加载中…';
                    if (block) block.replaceWith(div);
                    found++;
                });
                if (found) this.loadExcalidrawBundle();
            },

            // 懒加载 Excalidraw bundle：已加载则直接重扫容器；加载中则等待 onload
            loadExcalidrawBundle() {
                if (window.ExcalidrawMount) { window.ExcalidrawMount(); return; }
                if (document.querySelector('script[data-excalidraw-bundle]')) return;
                // 样式独立文件（Excalidraw 0.18 Vite 产物）：先注入 CSS 再注入 JS
                const css = document.createElement('link');
                css.rel = 'stylesheet';
                css.href = '/js/vendor/excalidraw/excalidraw-editor.v13.css';
                css.dataset.excalidrawBundle = '1';
                document.head.appendChild(css);
                const s = document.createElement('script');
                s.src = '/js/vendor/excalidraw/excalidraw-editor.v13.js';
                s.dataset.excalidrawBundle = '1';
                s.onload = () => { if (window.ExcalidrawMount) window.ExcalidrawMount(); };
                s.onerror = () => {
                    document.querySelectorAll('.article-content .excalidraw-embed[data-excalidraw]').forEach(el => {
                        el.textContent = '白板组件加载失败，请刷新重试';
                    });
                };
                document.head.appendChild(s);
            },

            // 高亮视口内可见的代码块（首屏立即 + 滚动时按需）
            highlightVisibleBlocks(container) {
                if (typeof hljs === 'undefined') return;
                const blocks = container.querySelectorAll('pre code:not(.hljs)');
                if (!blocks.length) return;
                const observer = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting) {
                            hljs.highlightElement(entry.target);
                            observer.unobserve(entry.target);
                        }
                    });
                }, { rootMargin: '200px' });
                blocks.forEach(block => observer.observe(block));
            },

            // 增量渲染完成后高亮剩余未处理的代码块
            highlightRemainingBlocks(container) {
                if (typeof hljs === 'undefined') return;
                container.querySelectorAll('pre code:not(.hljs)').forEach(block => {
                    hljs.highlightElement(block);
                });
            },

            // 生成左侧目录
            generateTableOfContents() {
                const content = document.getElementById('article-content');
                const tocSidebar = document.getElementById('tocSidebar');
                const tocList = document.getElementById('toc-list');

                // 获取所有标题元素
                const headings = content.querySelectorAll('h1, h2, h3, h4, h5, h6');

                // 短文无标题：保留侧边栏与顶部控制按钮（返回/首页/主题/AI），目录区显示空状态
                if (headings.length === 0) {
                    tocSidebar.style.display = 'flex';
                    tocList.innerHTML = '<li class="toc-empty">本文暂无目录</li>';
                    const collapseBtn = document.getElementById('tocCollapseBtn');
                    const searchInput = document.getElementById('tocSearchInput');
                    if (collapseBtn) collapseBtn.style.display = 'none';
                    if (searchInput) searchInput.style.display = 'none';
                    return;
                }

                // 有标题：恢复目录搜索与折叠控件（防止二次渲染时残留隐藏状态）
                const collapseBtn = document.getElementById('tocCollapseBtn');
                const searchInput = document.getElementById('tocSearchInput');
                if (collapseBtn) collapseBtn.style.display = '';
                if (searchInput) searchInput.style.display = '';

                tocSidebar.style.display = 'flex';
                tocList.innerHTML = '';

                // 第一遍遍历：分析哪些 h1/h2 有子标题
                const parentHasChildren = {};
                let lastParentIndex = -1;
                
                headings.forEach((heading, index) => {
                    const level = parseInt(heading.tagName.charAt(1));
                    if (level <= 2) {
                        lastParentIndex = index;
                        parentHasChildren[index] = false;
                    } else if (lastParentIndex >= 0) {
                        parentHasChildren[lastParentIndex] = true;
                    }
                });

                // 第二遍遍历：生成目录结构
                let currentParent = null;
                let childContainer = null;

                headings.forEach((heading, index) => {
                    const id = `heading-${index}`;
                    heading.id = id;

                    const li = document.createElement('li');
                    const level = parseInt(heading.tagName.charAt(1));
                    li.className = `toc-${heading.tagName.toLowerCase()}`;

                    // 判断是否为子目录项（h3、h4、h5、h6）
                    if (level >= 3) {
                        li.classList.add('toc-child-item');
                        if (childContainer) {
                            childContainer.appendChild(li);
                        } else {
                            tocList.appendChild(li);
                        }
                    } else {
                        // h1 或 h2 作为父级目录
                        tocList.appendChild(li);
                        
                        // 只有当确实有子标题时才添加折叠功能
                        if (parentHasChildren[index]) {
                            li.classList.add('toc-parent');
                            
                            // 创建标题容器（包含链接和折叠图标）
                            const titleDiv = document.createElement('div');
                            titleDiv.className = 'toc-parent-title';
                            li.appendChild(titleDiv);
                            
                            // 添加折叠图标
                            const toggleIcon = document.createElement('span');
                            toggleIcon.className = 'toc-toggle-icon';
                            toggleIcon.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
                            toggleIcon.title = '折叠/展开';
                            titleDiv.appendChild(toggleIcon);
                            
                            // 创建子容器
                            childContainer = document.createElement('ul');
                            childContainer.className = 'toc-child toc-child-container';
                            li.appendChild(childContainer);
                        } else {
                            childContainer = null;
                        }
                    }

                    const a = document.createElement('a');
                    a.href = `#${id}`;
                    a.textContent = heading.textContent;
                    a.title = heading.textContent;

                    // 点击平滑滚动到对应标题
                    a.addEventListener('click', (e) => {
                        e.preventDefault();
                        heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    });

                    // 将链接插入到正确位置
                    const titleDiv = li.querySelector('.toc-parent-title');
                    if (titleDiv) {
                        titleDiv.insertBefore(a, titleDiv.firstChild);
                    } else {
                        li.insertBefore(a, li.firstChild);
                    }
                });

                // 初始化折叠功能
                this.initTocCollapse();

                // 监听滚动，高亮当前可见标题
                this.initScrollHighlight(headings);

                // 初始化目录搜索
                this.initTocSearch();
            },

            // 初始化目录折叠功能
            initTocCollapse() {
                const collapseBtn = document.getElementById('tocCollapseBtn');
                const childContainers = document.querySelectorAll('.toc-child-container');
                const parentItems = document.querySelectorAll('.toc-parent');

                if (!collapseBtn) return;

                // 统一折叠按钮点击事件
                collapseBtn.addEventListener('click', () => {
                    const isCollapsed = collapseBtn.classList.toggle('collapsed');
                    
                    childContainers.forEach(container => {
                        if (isCollapsed) {
                            container.classList.add('collapsed');
                        } else {
                            container.classList.remove('collapsed');
                        }
                    });

                    parentItems.forEach(item => {
                        if (isCollapsed) {
                            item.classList.add('collapsed');
                        } else {
                            item.classList.remove('collapsed');
                        }
                    });
                });

                // 为每个父级目录的折叠图标添加点击事件
                parentItems.forEach(item => {
                    const toggleIcon = item.querySelector('.toc-toggle-icon');
                    const childContainer = item.querySelector('.toc-child-container');
                    
                    if (toggleIcon && childContainer) {
                        toggleIcon.addEventListener('click', (e) => {
                            e.stopPropagation();
                            const isCollapsed = childContainer.classList.toggle('collapsed');
                            item.classList.toggle('collapsed', isCollapsed);
                        });
                    }
                });
            },

            // 目录搜索功能
            initTocSearch() {
                const searchInput = document.getElementById('tocSearchInput');
                const tocList = document.getElementById('toc-list');
                if (!searchInput || !tocList) return;

                searchInput.addEventListener('input', () => {
                    const query = searchInput.value.trim().toLowerCase();
                    const items = tocList.querySelectorAll('li');

                    items.forEach(li => {
                        const link = li.querySelector('a');
                        if (!link) return;
                        const text = link.textContent.toLowerCase();
                        if (!query || text.includes(query)) {
                            li.style.display = '';
                        } else {
                            li.style.display = 'none';
                        }
                    });
                });
            },

            // 滚动时高亮当前所在目录项，并自动滚动目录到可见位置
            initScrollHighlight(headings) {
                const tocLinks = document.querySelectorAll('.toc-list a');
                const tocContainer = document.querySelector('.toc-list-wrapper');
                if (tocLinks.length === 0 || !tocContainer) return;

                const observer = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting) {
                            // 移除所有高亮
                            tocLinks.forEach(link => link.classList.remove('active'));
                            // 高亮当前标题对应的目录项
                            const index = Array.from(headings).indexOf(entry.target);
                            if (index >= 0 && tocLinks[index]) {
                                const activeLink = tocLinks[index];
                                activeLink.classList.add('active');

                                // 计算目录项相对于滚动容器的位置
                                const containerRect = tocContainer.getBoundingClientRect();
                                const linkRect = activeLink.getBoundingClientRect();
                                const linkRelativeTop = linkRect.top - containerRect.top;
                                const linkBottom = linkRelativeTop + linkRect.height;
                                const containerHeight = containerRect.height;

                                // 目标滚动位置：让高亮项居中显示
                                const targetScroll = tocContainer.scrollTop + linkRelativeTop - containerHeight / 2 + linkRect.height / 2;

                                // 如果当前项在视口上半部分之外，滚动使其居中
                                if (linkRelativeTop < 60) {
                                    tocContainer.scrollTo({ top: targetScroll, behavior: 'smooth' });
                                }
                                // 如果当前项在视口下半部分之外，滚动使其居中
                                else if (linkBottom > containerHeight - 60) {
                                    tocContainer.scrollTo({ top: targetScroll, behavior: 'smooth' });
                                }
                            }
                        }
                    });
                }, { rootMargin: '-80px 0px -60% 0px' });

                headings.forEach(heading => observer.observe(heading));
            },

            // 渲染上下篇导航
            renderNavigation() {
                const navigation = document.getElementById('article-navigation');

                if (this.allPosts.length === 0) {
                    navigation.style.display = 'none';
                    return;
                }

                const currentIndex = this.allPosts.findIndex(post => post.filename === this.currentPost.filename);

                let prevPost = null;
                let nextPost = null;

                if (currentIndex > 0) {
                    prevPost = this.allPosts[currentIndex - 1];
                }

                if (currentIndex < this.allPosts.length - 1) {
                    nextPost = this.allPosts[currentIndex + 1];
                }

                navigation.innerHTML = `
                    ${prevPost ? `
                        <a href="article.html?post=${prevPost.filename}${prevPost.id ? '&blob=' + prevPost.id : ''}" class="nav-card prev">
                            <div class="nav-label">← 上一篇</div>
                            <div class="nav-title">${prevPost.title}</div>
                        </a>
                    ` : '<div></div>'}
                    ${nextPost ? `
                        <a href="article.html?post=${nextPost.filename}${nextPost.id ? '&blob=' + nextPost.id : ''}" class="nav-card next">
                            <div class="nav-label">下一篇 →</div>
                            <div class="nav-title">${nextPost.title}</div>
                        </a>
                    ` : '<div></div>'}
                `;
            },

            // 显示错误信息
            showError(message) {
                const header = document.getElementById('article-header');
                const content = document.getElementById('article-content');

                header.innerHTML = '';
                content.innerHTML = `
                    <div class="error-state">
                        <div class="icon"><svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/></svg></div>
                        <div class="message">${message}</div>
                        <a href="index.html" class="back-link">返回首页</a>
                    </div>
                `;
            },

            // 资讯无正文时提示并引导前往原文
            showNewsNoContent(sourceUrl, sourceName) {
                const header = document.getElementById('article-header');
                const content = document.getElementById('article-content');

                header.innerHTML = '';
                content.innerHTML = `
                    <div class="error-state">
                        <div class="icon"><svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".5" fill="currentColor"/></svg></div>
                        <div class="message">该资讯暂无站内正文（来源仅提供摘要）</div>
                        <div class="error-actions">
                            <a href="${sourceUrl || '#'}" target="_blank" rel="noopener" class="back-link">前往原文阅读 ↗</a>
                            <a href="index.html" class="back-link secondary">返回首页</a>
                        </div>
                    </div>
                `;
            },

            // 初始化留言区
            async initComments(postId) {
                const section = document.getElementById('comment-section');
                if (!section) return;
                section.style.display = '';
                this.postId = postId;
                await this.loadComments();
                const form = document.getElementById('comment-form');
                if (form) form.addEventListener('submit', (e) => this.submitComment(e));
                this.commentImageUrl = '';
                const fileInput = document.getElementById('comment-image');
                if (fileInput) fileInput.addEventListener('change', (e) => this.onCommentImageSelect(e));
                const removeBtn = document.getElementById('comment-image-remove');
                if (removeBtn) removeBtn.addEventListener('click', () => this.clearCommentImage());
                // 回复：点击填入 @昵称 到输入框
                const list = document.getElementById('comment-list');
                if (list) list.addEventListener('click', (e) => {
                    const btn = e.target.closest('.comment-reply-btn');
                    if (!btn) return;
                    const name = btn.getAttribute('data-name') || '';
                    const input = document.getElementById('comment-content');
                    if (input) {
                        input.value = '@' + name + ' ';
                        input.focus();
                        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                });
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
                this.commentImageUrl = '';
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
                const res = await fetch(`${this.apiBase}/api/upload`, {
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

            // 加载某篇文章的留言
            async loadComments() {
                const list = document.getElementById('comment-list');
                if (!list) return;
                try {
                    const res = await fetch(`${this.apiBase}/api/comments?postId=${encodeURIComponent(this.postId)}`);
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const data = await res.json();
                    const comments = (data && Array.isArray(data.comments)) ? data.comments : [];
                    if (!comments.length) {
                        list.innerHTML = '<div class="comment-empty">还没有留言，来抢沙发~</div>';
                        return;
                    }
                    list.innerHTML = comments.map(c => {
                        return `
                        <div class="comment-item">
                            <div class="comment-item-avatar" title="${this.esc(c.name || '')}">${this.escName(c.name || '客')}</div>
                            <div class="comment-item-main">
                                <div class="comment-item-user">
                                    <span class="comment-item-name">${this.esc(c.name || '匿名')}</span>
                                </div>
                                <div class="comment-item-content">${this.renderCommentContent(c.content)}</div>
                                ${c.image ? `<img class="comment-item-image" src="${this.esc(this.commentImageSrc(c.image))}" alt="评论图片" loading="lazy" onclick="openLightbox(this)" style="cursor:zoom-in">` : ''}
                                <div class="comment-item-actions">
                                    <span class="comment-item-time">${this.formatCommentDate(c.createdAt)}</span>
                                    <button type="button" class="comment-reply-btn" data-name="${this.esc(c.name || '')}">回复</button>
                                </div>
                            </div>
                        </div>`;
                    }).join('');
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
                    const res = await fetch(`${this.apiBase}/api/comments`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ postId: this.postId, name, content, image: imageUrl || undefined })
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

            // 评论内容渲染：转义后高亮 @提及、文章链接可点击
            renderCommentContent(str) {
                let raw = String(str || '');
                let text = this.esc(raw);
                text = text.replace(/@([\u4e00-\u9fa5\w\-]{1,20})/g, '<span class="mention">@$1</span>');
                text = text.replace(/(\/article\.html\?id=[\w\-]+)/g, '<a href="$1" target="_blank" class="mention">$1</a>');
                return text;
            },

            // HTML 转义
            esc(str) {
                return String(str || '')
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            },

            // 留言头像首字符
            escName(name) {
                return String(name || '客').charAt(0).toUpperCase();
            },

            // 留言图片 URL：旧动态接口 → 新缓存友好 URL；相对路径补全
            commentImageSrc(url) {
                if (!url) return '';
                if (/^https?:\/\//.test(url)) return url;
                let u = url;
                if (u.startsWith('/api/image?key=')) {
                    const rest = u.slice('/api/image?key='.length);
                    const key = rest.split('&')[0];
                    const mime = (rest.match(/mime=image\/(\w+)/) || [])[1];
                    u = '/images/c/' + key + (key.includes('.') ? '' : (mime ? '.' + mime : '.png'));
                }
                if (u.startsWith('/api/')) return this.apiBase + u;
                return u;
            },

            // 格式化留言时间
            formatCommentDate(ts) {
                const d = new Date(ts);
                if (isNaN(d.getTime())) return '';
                const pad = n => String(n).padStart(2, '0');
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
            },

            // 格式化日期为 YYYY-MM-DD
            formatDate(dateStr) {
                const date = new Date(dateStr);
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            }
        };

        // 页面加载完成后初始化
        document.addEventListener('DOMContentLoaded', () => {
            ArticleApp.init();
            AIChat.init();

            // 侧边栏主题切换按钮
            const sidebarThemeBtn = document.getElementById('sidebarThemeToggle');
            const mobileThemeBtn = document.getElementById('mobileThemeToggle');
            const updateThemeIcons = () => {
                const icon = ThemeManager.getCurrentTheme().icon;
                if (sidebarThemeBtn) sidebarThemeBtn.textContent = icon;
                if (mobileThemeBtn) mobileThemeBtn.textContent = icon;
            };
            if (sidebarThemeBtn) sidebarThemeBtn.addEventListener('click', () => { ThemeManager.nextTheme(); updateThemeIcons(); });
            if (mobileThemeBtn) mobileThemeBtn.addEventListener('click', () => { ThemeManager.nextTheme(); updateThemeIcons(); });
            updateThemeIcons();

            // 侧边栏AI助手按钮
            const sidebarChatBtn = document.getElementById('sidebarChatToggle');
            if (sidebarChatBtn) sidebarChatBtn.addEventListener('click', () => {
                const chatWindow = document.getElementById('chatWindow');
                if (chatWindow) chatWindow.classList.toggle('show');
            });

            // 返回上一页按钮
            const sidebarGoBack = document.getElementById('sidebarGoBack');
            const mobileGoBack = document.getElementById('mobileGoBack');
            const goBack = () => {
                if (window.history.length > 1) {
                    window.history.back();
                } else {
                    window.location.href = 'index.html';
                }
            };
            if (sidebarGoBack) sidebarGoBack.addEventListener('click', goBack);
            if (mobileGoBack) mobileGoBack.addEventListener('click', goBack);
        });

        // 通用复制函数
        function copyToClipboard(text) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text);
            }
            // 兼容 HTTP 环境
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            return Promise.resolve();
        }

        // 复制代码块内容
        function copyCode(btn) {
            const codeBlock = btn.closest('.code-block');
            if (!codeBlock) return;
            const code = codeBlock.querySelector('code');
            if (!code) return;
            copyToClipboard(code.textContent).then(() => {
                const span = btn.querySelector('span');
                if (span) span.textContent = '已复制';
                btn.classList.add('copied');
                setTimeout(() => {
                    if (span) span.textContent = '复制';
                    btn.classList.remove('copied');
                }, 2000);
            });
        }

        // 打开灯箱
        function openLightbox(img) {
            const overlay = document.getElementById('lightboxOverlay');
            const lightboxImg = document.getElementById('lightboxImg');
            lightboxImg.src = img.src;
            lightboxImg.alt = img.alt;
            overlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        }

        // 关闭灯箱
        function closeLightbox() {
            const overlay = document.getElementById('lightboxOverlay');
            overlay.classList.remove('active');
            document.body.style.overflow = '';
            // 重置缩放
            const img = document.getElementById('lightboxImg');
            img.style.transform = '';
            img.style.cursor = 'zoom-out';
            currentScale = 1;
        }

        // ESC 关闭灯箱
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeLightbox();
        });

        // WASD shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            
            switch(e.key.toLowerCase()) {
                case 'w':
                    window.scrollBy({ top: -300, behavior: 'smooth' });
                    break;
                case 's':
                    window.scrollBy({ top: 300, behavior: 'smooth' });
                    break;
                case 'a':
                    window.history.back();
                    break;
                case 'd':
                    window.history.forward();
                    break;
                case 'e':
                    const chatWindow = document.getElementById('chatWindow');
                    if (chatWindow) chatWindow.classList.toggle('show');
                    break;
                case 'q':
                    ThemeManager.nextTheme();
                    break;
            }
        });

        // 滚轮缩放图片
        let currentScale = 1;
        document.getElementById('lightboxOverlay').addEventListener('wheel', (e) => {
            e.preventDefault();
            const img = document.getElementById('lightboxImg');

            // 计算缩放比例
            const delta = e.deltaY > 0 ? -0.15 : 0.15;
            currentScale = Math.max(0.5, Math.min(5, currentScale + delta));

            // 应用缩放
            img.style.transform = `scale(${currentScale})`;
            img.style.cursor = currentScale > 1 ? 'grab' : 'zoom-out';
        });

        // 拖动已缩放的图片
        let isDragging = false;
        let startX, startY, scrollLeft, scrollTop;

        document.getElementById('lightboxImg').addEventListener('mousedown', (e) => {
            if (currentScale <= 1) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            e.target.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const img = document.getElementById('lightboxImg');
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            img.style.transform = `scale(${currentScale}) translate(${dx}px, ${dy}px)`;
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            document.getElementById('lightboxImg').style.cursor = 'grab';
        });

        // 移动端菜单功能
        window.menuVisible = false;

        function toggleMobileMenu() {
            var popup = document.getElementById('mobileMenuPopup');
            var ball = document.getElementById('mobileFloatBall');
            window.menuVisible = !window.menuVisible;
            
            if (window.menuVisible) {
                popup.style.setProperty('display', 'flex', 'important');
                popup.classList.add('show');
                ball.classList.add('active');
            } else {
                popup.style.setProperty('display', 'none', 'important');
                popup.classList.remove('show');
                ball.classList.remove('active');
            }
        }

        // 显示侧边栏（目录）
        function showSidebar() {
            var sidebar = document.getElementById('tocSidebar');
            var overlay = document.getElementById('sidebarOverlay');
            sidebar.classList.add('show');
            overlay.classList.add('show');
            document.body.style.overflow = 'hidden';
            // 关闭菜单
            var popup = document.getElementById('mobileMenuPopup');
            var ball = document.getElementById('mobileFloatBall');
            popup.style.setProperty('display', 'none', 'important');
            popup.classList.remove('show');
            ball.classList.remove('active');
            window.menuVisible = false;
        }

        // 关闭侧边栏
        function closeSidebar() {
            const sidebar = document.getElementById('tocSidebar');
            const overlay = document.getElementById('sidebarOverlay');
            sidebar.classList.remove('show');
            overlay.classList.remove('show');
            document.body.style.overflow = '';
        }

        // 切换主题
        function toggleTheme() {
            ThemeManager.nextTheme();
            const sidebarThemeBtn = document.getElementById('sidebarThemeToggle');
            const mobileThemeBtn = document.getElementById('mobileThemeToggle');
            const icon = ThemeManager.getCurrentTheme().icon;
            if (sidebarThemeBtn) sidebarThemeBtn.textContent = icon;
            if (mobileThemeBtn) mobileThemeBtn.textContent = icon;
        }

        // 切换AI聊天
        function toggleChat() {
            // 关闭菜单
            var popup = document.getElementById('mobileMenuPopup');
            var ball = document.getElementById('mobileFloatBall');
            if (popup) {
                popup.style.setProperty('display', 'none', 'important');
                popup.classList.remove('show');
            }
            if (ball) ball.classList.remove('active');
            window.menuVisible = false;

            // 打开聊天窗口
            var chatWin = document.getElementById('chatWindow');
            if (chatWin) {
                chatWin.classList.add('show');
                chatWin.style.opacity = '1';
                chatWin.style.visibility = 'visible';
                chatWin.style.transform = 'scale(1)';
            }
        }

        // 检测屏幕尺寸，显示/隐藏移动端元素
        function checkMobileView() {
            const width = window.innerWidth;
            const floatBall = document.getElementById('mobileFloatBall');
            const menuPopup = document.getElementById('mobileMenuPopup');
            const tocSidebar = document.getElementById('tocSidebar');

            // 当侧边栏隐藏时（宽度<773），显示悬浮球
            if (width < 773) {
                floatBall.style.setProperty('display', 'flex', 'important');
            } else {
                floatBall.style.setProperty('display', 'none', 'important');
                menuPopup.style.setProperty('display', 'none', 'important');
                menuPopup.classList.remove('show');
                closeSidebar();
                if (tocSidebar) tocSidebar.style.display = '';
            }
        }

        window.addEventListener('resize', checkMobileView);
        checkMobileView();

        // 文章内容横向拖动：表格/代码块等超出部分可按住左右拖动查看，不显示滚动条
        (function () {
            var scroller = null;
            var startX = 0;
            var startScroll = 0;
            var moved = false;

            document.addEventListener('mousedown', function (e) {
                // 命中所有可横向滚动的内容块（后续如需支持更多元素，加进选择器即可）
                var t = e.target && e.target.closest
                    ? e.target.closest('.article-content table, .article-content pre')
                    : null;
                // 只有确实超出容器宽度时才启用拖拽
                if (!t || t.scrollWidth <= t.clientWidth + 1) return;
                scroller = t;
                startX = e.clientX;
                startScroll = t.scrollLeft;
                moved = false;
            });

            document.addEventListener('mousemove', function (e) {
                if (!scroller) return;
                var dx = e.clientX - startX;
                if (!moved) {
                    if (Math.abs(dx) < 5) return; // 小于阈值视为点击，不进入拖拽
                    moved = true;
                    scroller.classList.add('dragging');
                    if (window.getSelection) window.getSelection().removeAllRanges();
                }
                scroller.scrollLeft = startScroll - dx;
            });

            function endDrag() {
                if (scroller) scroller.classList.remove('dragging');
                scroller = null;
            }

            document.addEventListener('mouseup', endDrag);
            document.addEventListener('mouseleave', endDrag);

            // 拖拽结束后阻止误触块内的链接
            document.addEventListener('click', function (e) {
                if (moved) {
                    e.preventDefault();
                    e.stopPropagation();
                    moved = false;
                }
            }, true);
        })();
    