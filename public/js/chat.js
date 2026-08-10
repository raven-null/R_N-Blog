/**
 * AI 智能对话助手
 * 使用智谱 BigModel GLM-4-Flash API
 * 支持流式输出、多会话、Markdown 渲染、划词助手等
 */
const AIChat = {
    // API 配置 - 请替换为你的 API Key
    config: {
        apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        apiKey: '5dc4e465fad643a7b486d85e2f35594f.l105oILErFBpytEq',
        model: 'glm-4-flash',
        maxTokens: 2048,
        temperature: 0.7
    },

    // 常量
    MAX_INPUT_LENGTH: 2000,       // 输入长度上限
    MAX_HISTORY_ROUNDS: 10,       // 上下文保留轮数
    SLASH_COMMANDS: [
        { cmd: '/解释', prompt: '请简明扼要地解释一个概念：', desc: '解释概念' },
        { cmd: '/翻译', prompt: '请将以下内容翻译为中文：', desc: '翻译' },
        { cmd: '/润色', prompt: '请润色以下内容，使其更通顺自然：', desc: '润色文本' },
        { cmd: '/总结', prompt: '请总结以上对话的要点：', desc: '总结对话' },
        { cmd: '/写代码', prompt: '请帮我编写代码：', desc: '编写代码' }
    ],

    // 系统提示词
    systemPrompt: '你是一名博客管理员。你的职责是：1. 热情友好地接待每一位访客；2. 回答关于博客内容、技术文章的问题；3. 你的所有回复都要体现你作为管理员的身份，比如"欢迎来到我的博客"、"感谢阅读我的文章"等。你博学多才，乐于助人。',

    // 会话状态
    sessions: [],
    currentSessionId: null,
    messages: [],
    isWaiting: false,
    abortController: null,
    unreadCount: 0,

    // 初始化
    init() {
        this.createChatUI();
        this.bindEvents();
        this.loadSessions();
        this.initDrag();
        this.initResize();
        this.initSelectionBubble();
        this.restoreWindowState();
        this.updateCharCount();

        // 聊天窗口开关动画（Anime.js 就绪时启用）
        this.chatAnime = window.BlogAnimations && window.BlogAnimations.isChatAnimeEnabled();
        if (this.chatAnime) {
            const chatWindow = document.getElementById('chatWindow');
            if (chatWindow) chatWindow.classList.add('anime-driven');
        }
    },

    // 创建聊天界面
    createChatUI() {
        const chatHTML = `
            <button class="chat-toggle" id="chatToggle" title="AI 助手">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <span class="chat-toggle-badge" id="chatBadge" style="display:none;"></span>
            </button>
            <div class="chat-window" id="chatWindow">
                <div class="chat-resize-handle" id="chatResizeHandle"></div>
                <div class="chat-header">
                    <div class="chat-header-title">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <span>管理员</span>
                    </div>
                    <div class="chat-header-actions">
                        <button class="chat-clear" id="chatSessionBtn" title="会话管理">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"></path>
                            </svg>
                        </button>
                        <button class="chat-clear" id="chatClear" title="清空对话">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                        <button class="chat-close" id="chatClose" title="关闭">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                </div>
                <div class="chat-session-panel" id="chatSessionPanel">
                    <div class="chat-session-new" id="chatSessionNew">
                        <span>＋ 新建会话</span>
                    </div>
                    <div class="chat-session-list" id="chatSessionList"></div>
                </div>
                <div class="chat-messages" id="chatMessages">
                    <div class="chat-welcome">
                        <div class="chat-welcome-icon">✦</div>
                        <div class="chat-welcome-text">你好！我是管理员，有什么可以帮你的吗？</div>
                    </div>
                </div>
                <div class="chat-slash-menu" id="chatSlashMenu"></div>
                <div class="chat-input-area">
                    <textarea class="chat-input" id="chatInput" placeholder="输入你的问题...（/ 唤起快捷指令）" rows="1"></textarea>
                    <div class="chat-input-side">
                        <span class="chat-char-count" id="chatCharCount">0/2000</span>
                        <button class="chat-send" id="chatSend" title="发送">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="22" y1="2" x2="11" y2="13"></line>
                                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        `;

        const container = document.createElement('div');
        container.className = 'chat-container';
        container.innerHTML = chatHTML;
        document.body.appendChild(container);

        this.sendIcon = container.querySelector('#chatSend').innerHTML;
        this.stopIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
    },

    // 绑定事件
    bindEvents() {
        const toggle = document.getElementById('chatToggle');
        const close = document.getElementById('chatClose');
        const clear = document.getElementById('chatClear');
        const send = document.getElementById('chatSend');
        const input = document.getElementById('chatInput');
        const sessionBtn = document.getElementById('chatSessionBtn');
        const sessionNew = document.getElementById('chatSessionNew');

        if (toggle) toggle.addEventListener('click', () => this.toggleWindow());
        if (close) close.addEventListener('click', () => this.closeWindow());
        if (clear) clear.addEventListener('click', () => this.clearChat());
        if (send) send.addEventListener('click', () => {
            if (this.isWaiting) {
                this.stopGeneration();
            } else {
                this.sendMessage().catch(err => console.warn('[AIChat] 发送失败:', err));
            }
        });
        if (sessionBtn) sessionBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSessionPanel(); });
        if (sessionNew) sessionNew.addEventListener('click', () => this.newSession());

        document.addEventListener('click', (e) => {
            const panel = document.getElementById('chatSessionPanel');
            const btn = document.getElementById('chatSessionBtn');
            if (panel && panel.classList.contains('show') && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
                panel.classList.remove('show');
            }
        });

        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage().catch(err => console.warn('[AIChat] 发送失败:', err));
                }
            });

            input.addEventListener('input', () => {
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 100) + 'px';
                this.updateCharCount();
                this.handleSlashMenu();
            });

            input.addEventListener('blur', () => {
                setTimeout(() => {
                    const menu = document.getElementById('chatSlashMenu');
                    if (menu) menu.style.display = 'none';
                }, 150);
            });
        }

        // 窗口大小变化时保存状态（配合拖拽）
        window.addEventListener('beforeunload', () => this.saveWindowState());
    },

    // 初始化拖拽（含位置记忆）
    initDrag() {
        const chatWindow = document.getElementById('chatWindow');
        const header = chatWindow.querySelector('.chat-header');
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        const onMouseMove = (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            let newLeft = startLeft + (clientX - startX);
            let newTop = startTop + (clientY - startY);

            // 边界限制
            const maxLeft = window.innerWidth - chatWindow.offsetWidth;
            const maxTop = window.innerHeight - chatWindow.offsetHeight;
            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));

            chatWindow.style.left = newLeft + 'px';
            chatWindow.style.top = newTop + 'px';
            chatWindow.style.right = 'auto';
            chatWindow.style.bottom = 'auto';
        };

        const onMouseUp = () => {
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.removeEventListener('touchmove', onMouseMove);
            document.removeEventListener('touchend', onMouseUp);
            this.saveWindowState();
        };

        const onMouseDown = (e) => {
            if (e.target.closest('.chat-header-actions')) return;
            isDragging = true;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            startX = clientX;
            startY = clientY;
            const rect = chatWindow.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.addEventListener('touchmove', onMouseMove, { passive: false });
            document.addEventListener('touchend', onMouseUp);
        };

        header.addEventListener('mousedown', onMouseDown);
        header.addEventListener('touchstart', onMouseDown, { passive: false });
    },

    // 初始化调整大小
    initResize() {
        const chatWindow = document.getElementById('chatWindow');
        const handle = document.getElementById('chatResizeHandle');
        if (!handle) return;

        let isResizing = false;
        let startX, startY, startWidth, startHeight;

        const onMouseMove = (e) => {
            if (!isResizing) return;
            e.preventDefault();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;

            const newWidth = Math.max(280, Math.min(startWidth - (clientX - startX), window.innerWidth * 0.9));
            const newHeight = Math.max(300, Math.min(startHeight - (clientY - startY), window.innerHeight * 0.9));

            chatWindow.style.width = newWidth + 'px';
            chatWindow.style.height = newHeight + 'px';
        };

        const onMouseUp = () => {
            isResizing = false;
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.removeEventListener('touchmove', onMouseMove);
            document.removeEventListener('touchend', onMouseUp);
            this.saveWindowState();
        };

        const onMouseDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            isResizing = true;
            document.body.style.userSelect = 'none';
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            startX = clientX;
            startY = clientY;
            startWidth = chatWindow.offsetWidth;
            startHeight = chatWindow.offsetHeight;

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.addEventListener('touchmove', onMouseMove, { passive: false });
            document.addEventListener('touchend', onMouseUp);
        };

        handle.addEventListener('mousedown', onMouseDown);
        handle.addEventListener('touchstart', onMouseDown, { passive: false });
    },

    // 窗口状态记忆
    saveWindowState() {
        const w = document.getElementById('chatWindow');
        if (!w) return;
        const state = { left: w.style.left, top: w.style.top, width: w.style.width, height: w.style.height };
        try { localStorage.setItem('chat-window-state', JSON.stringify(state)); } catch (e) { }
    },

    restoreWindowState() {
        if (window.innerWidth <= 773) return;
        try {
            const state = JSON.parse(localStorage.getItem('chat-window-state'));
            if (state && state.left) {
                const w = document.getElementById('chatWindow');
                w.style.left = state.left;
                w.style.top = state.top;
                w.style.width = state.width;
                w.style.height = state.height;
                w.style.right = 'auto';
                w.style.bottom = 'auto';
            }
        } catch (e) { }
    },

    // 划词助手：选中正文文字后可快速调用 AI
    initSelectionBubble() {
        this.selectionBubble = document.createElement('div');
        this.selectionBubble.className = 'chat-selection-bubble';
        this.selectionBubble.innerHTML = `
            <button class="sel-btn" data-action="explain">解释</button>
            <button class="sel-btn" data-action="translate">翻译</button>
            <button class="sel-btn" data-action="polish">润色</button>`;
        document.body.appendChild(this.selectionBubble);

        this.selectionBubble.querySelectorAll('.sel-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const text = this.selectionBubble.dataset.text || '';
                const action = btn.dataset.action;
                const prompt = this.buildSelectionPrompt(text, action);
                this.sendExternal(prompt);
                this.hideSelectionBubble();
            });
        });

        document.addEventListener('mouseup', (e) => this.handleSelection(e));
        document.addEventListener('touchend', (e) => this.handleSelection(e));
        document.addEventListener('mousedown', (e) => {
            if (this.selectionBubble && !this.selectionBubble.contains(e.target)) this.hideSelectionBubble();
        });
    },

    handleSelection(e) {
        if (e.target.closest('.chat-selection-bubble')) return;
        const chatWindow = document.getElementById('chatWindow');
        if (chatWindow && chatWindow.contains(e.target)) return;
        if (e.target.closest('input, textarea')) return;

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) { this.hideSelectionBubble(); return; }
        const text = selection.toString().trim();
        if (text.length < 2) { this.hideSelectionBubble(); return; }

        // 限制选区来源：优先文章正文，其次排除界面区域
        const anchor = selection.anchorNode;
        const article = document.querySelector('.article-content');
        if (article) {
            if (!article.contains(anchor)) { this.hideSelectionBubble(); return; }
        } else if (anchor && anchor.nodeType === 1 && (anchor.closest('.toc-sidebar') || anchor.closest('.chat-window'))) {
            this.hideSelectionBubble();
            return;
        }

        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) { this.hideSelectionBubble(); return; }

        const bubble = this.selectionBubble;
        bubble.dataset.text = text;
        bubble.style.display = 'flex';
        const bWidth = bubble.offsetWidth;
        let left = rect.left + rect.width / 2 - bWidth / 2;
        let top = rect.top - bubble.offsetHeight - 10;
        if (top < 8) top = rect.bottom + 10;
        left = Math.max(8, Math.min(left, window.innerWidth - bWidth - 8));
        bubble.style.left = left + 'px';
        bubble.style.top = top + 'px';
    },

    hideSelectionBubble() {
        if (this.selectionBubble) this.selectionBubble.style.display = 'none';
    },

    buildSelectionPrompt(text, action) {
        const prompts = {
            explain: `请解释以下内容，尽量简明扼要：\n\n${text}`,
            translate: `请将以下内容翻译成中文：\n\n${text}`,
            polish: `请润色以下内容，使其更通顺自然：\n\n${text}`
        };
        return prompts[action] || prompts.explain;
    },

    // 切换窗口显示
    toggleWindow() {
        const chatWindow = document.getElementById('chatWindow');
        if (chatWindow.classList.contains('show')) {
            this.closeWindow();
        } else {
            this.openWindow();
        }
    },

    openWindow() {
        const chatWindow = document.getElementById('chatWindow');
        const useAnime = this.chatAnime;
        chatWindow.style.visibility = 'visible';
        chatWindow.style.opacity = useAnime ? '0' : '1';
        chatWindow.classList.add('show');
        if (useAnime) {
            anime.animate(chatWindow, {
                scale: [0.92, 1],
                translateY: [16, 0],
                opacity: [0, 1],
                duration: 400,
                ease: 'out(3)'
            });
        } else {
            chatWindow.style.transform = '';
        }
        const input = document.getElementById('chatInput');
        if (input) input.focus({ preventScroll: true });
        this.unreadCount = 0;
        this.updateBadge();
    },

    closeWindow() {
        const chatWindow = document.getElementById('chatWindow');
        if (this.chatAnime) {
            anime.animate(chatWindow, {
                scale: [1, 0.94],
                translateY: [0, 14],
                opacity: [1, 0],
                duration: 220,
                ease: 'in(2)',
                onComplete: () => {
                    chatWindow.classList.remove('show');
                    chatWindow.style.opacity = '';
                    chatWindow.style.visibility = '';
                    chatWindow.style.transform = '';
                }
            });
        } else {
            chatWindow.classList.remove('show');
            chatWindow.style.opacity = '';
            chatWindow.style.visibility = '';
            chatWindow.style.transform = '';
        }
    },

    // 未读消息角标
    updateBadge() {
        const badge = document.getElementById('chatBadge');
        if (!badge) return;
        if (this.unreadCount > 0) {
            badge.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    },

    // 发送外部消息（划词助手等调用）
    sendExternal(prompt) {
        this.openWindow();
        this.sendMessage(prompt, { force: true }).catch(err => console.warn('[AIChat] 发送失败:', err));
    },

    // 发送消息
    async sendMessage(text, opts = {}) {
        const input = document.getElementById('chatInput');
        const content = (typeof text === 'string') ? text : (input ? input.value.trim() : '');
        if (!content) return;
        if (this.isWaiting) return;
        if (content.length > this.MAX_INPUT_LENGTH) {
            this.showNotice(`输入内容过长（最多 ${this.MAX_INPUT_LENGTH} 字）`);
            return;
        }

        // 防抖：与上一条用户消息相同则忽略
        const lastMsg = this.messages[this.messages.length - 1];
        if (!opts.force && lastMsg && lastMsg.role === 'user' && lastMsg.content === content) return;

        if (typeof text !== 'string' && input) {
            input.value = '';
            input.style.height = 'auto';
            this.updateCharCount();
            const menu = document.getElementById('chatSlashMenu');
            if (menu) menu.style.display = 'none';
        }

        this.openWindow();
        this.addMessage('user', content);
        this.messages.push({ role: 'user', content });
        this.updateSessionName();
        this.saveSessions();

        this.isWaiting = true;
        this.updateSendButton();

        // 创建流式消息容器
        const streamEl = this.createStreamingMessage();
        let accumulated = '';
        let renderScheduled = false;
        let lastRenderTime = 0;
        this.abortController = new AbortController();

        const scheduleRender = () => {
            if (renderScheduled) return;
            renderScheduled = true;
            requestAnimationFrame(() => {
                renderScheduled = false;
                // 限流：至少间隔 50ms 渲染一次，减少 DOM 频繁重排
                const now = performance.now();
                if (now - lastRenderTime >= 50) {
                    lastRenderTime = now;
                    this.updateStreamingMessage(streamEl, accumulated);
                }
            });
        };

        try {
            await this.streamAI((delta) => {
                accumulated += delta;
                scheduleRender();
            }, this.abortController.signal);

            // 成功：最终渲染并记录
            this.messages.push({ role: 'assistant', content: accumulated });
            this.saveSessions();
            this.finalizeAssistantMessage(streamEl, accumulated);
        } catch (error) {
            if (error.name === 'AbortError') {
                // 用户手动停止，保留已生成内容
                if (accumulated.trim()) {
                    this.messages.push({ role: 'assistant', content: accumulated });
                    this.saveSessions();
                    this.finalizeAssistantMessage(streamEl, accumulated);
                } else {
                    streamEl.remove();
                    this.showNotice('已停止生成');
                }
            } else {
                streamEl.remove();
                this.addMessage('error', this.friendlyError(error));
            }
        }

        this.isWaiting = false;
        this.abortController = null;
        this.updateSendButton();
    },

    // 停止生成
    stopGeneration() {
        if (this.abortController) this.abortController.abort();
    },

    // 流式调用 API
    async streamAI(onDelta, signal) {
        const messages = this.buildMessages();

        const response = await this.fetchWithRetry(this.config.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`
            },
            body: JSON.stringify({
                model: this.config.model,
                messages,
                max_tokens: this.config.maxTokens,
                temperature: this.config.temperature,
                stream: true
            }),
            signal
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const e = new Error(error.error?.message || `HTTP ${response.status}`);
            e.status = response.status;
            throw e;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.substring(5).trim();
                if (data === '[DONE]') return;
                try {
                    const json = JSON.parse(data);
                    const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
                    if (delta) onDelta(delta);
                } catch (e) { }
            }
        }
    },

    // 带重试的请求
    async fetchWithRetry(url, options, maxRetries = 2) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(url, options);
                if (response.status === 429 && attempt < maxRetries) {
                    await this.sleep(500 * Math.pow(2, attempt));
                    continue;
                }
                return response;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                if (attempt < maxRetries) {
                    await this.sleep(500 * Math.pow(2, attempt));
                    continue;
                }
                throw err;
            }
        }
    },

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },

    // 构建发送给 API 的消息（滑动窗口裁剪）
    buildMessages() {
        const recent = this.messages.slice(-(this.MAX_HISTORY_ROUNDS * 2));
        const history = recent.map(m => ({ role: m.role, content: m.content }));
        return [{ role: 'system', content: this.systemPrompt }, ...history];
    },

    // 创建流式消息容器
    createStreamingMessage() {
        const container = document.getElementById('chatMessages');
        const welcome = container.querySelector('.chat-welcome');
        if (welcome) welcome.remove();

        const div = document.createElement('div');
        div.className = 'chat-message chat-message-assistant';
        div.innerHTML = `
            <div class="chat-message-avatar"><img src="images/Default/profile -picture.webp" alt="AI" style="width:100%;height:100%;object-fit:cover;border-radius:8px;"></div>
            <div class="chat-message-body">
                <div class="chat-message-label">AI</div>
                <div class="chat-message-content chat-streaming-content">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                </div>
            </div>`;
        container.appendChild(div);
        this.scrollToBottom(true);
        return div;
    },

    // 流式更新内容
    updateStreamingMessage(el, text) {
        const contentEl = el.querySelector('.chat-message-content');
        if (!contentEl) return;
        contentEl.classList.remove('chat-streaming-content');
        if (!text) return;
        if (typeof MarkdownParser !== 'undefined') {
            contentEl.innerHTML = MarkdownParser.parseMarkdown(text);
        } else {
            contentEl.innerHTML = this.escapeHtml(text);
        }
        this.scrollToBottom(true);
    },

    // 最终渲染（高亮代码 + 快捷操作）
    finalizeAssistantMessage(el, text) {
        const contentEl = el.querySelector('.chat-message-content');
        contentEl.classList.remove('chat-streaming-content');
        if (typeof MarkdownParser !== 'undefined') {
            contentEl.innerHTML = MarkdownParser.parseMarkdown(text);
            requestAnimationFrame(() => {
                if (typeof hljs !== 'undefined') {
                    contentEl.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
                }
            });
        } else {
            contentEl.innerHTML = this.escapeHtml(text);
        }
        el.dataset.raw = text;
        this.addReplyActions(el, text);
        this.scrollToBottom(true);
    },

    // 消息快捷操作：复制 / 重新生成
    addReplyActions(el, text) {
        if (el.querySelector('.chat-reply-actions')) return;
        const body = el.querySelector('.chat-message-body');
        const actions = document.createElement('div');
        actions.className = 'chat-reply-actions';
        actions.innerHTML = `
            <button class="chat-action-btn chat-copy-btn" title="复制">复制</button>
            <button class="chat-action-btn chat-regen-btn" title="重新生成">重新生成</button>`;
        body.appendChild(actions);

        actions.querySelector('.chat-copy-btn').addEventListener('click', (e) => {
            this.copyText(text, e.currentTarget).catch(err => console.warn('[AIChat] 复制失败:', err));
        });
        actions.querySelector('.chat-regen-btn').addEventListener('click', () => this.regenerate(el));
    },

    async copyText(text, btn) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        const old = btn.textContent;
        btn.textContent = '已复制';
        btn.classList.add('active');
        setTimeout(() => { btn.textContent = old; btn.classList.remove('active'); }, 1500);
    },

    // 重新生成回复
    regenerate(el) {
        if (this.isWaiting) return;
        const raw = el.dataset.raw;
        const idx = this.messages.findIndex(m => m.role === 'assistant' && m.content === raw);
        if (idx >= 0) this.messages.splice(idx, 1);

        // 找到该回复对应的用户提问
        let userText = '';
        for (let i = idx - 1; i >= 0; i--) {
            if (this.messages[i].role === 'user') { userText = this.messages[i].content; break; }
        }
        el.remove();
        this.saveSessions();
        if (!userText) return;
        this.sendMessage(userText, { force: true }).catch(err => console.warn('[AIChat] 重新生成失败:', err));
    },

    // 会话管理
    getSession() {
        return this.sessions.find(s => s.id === this.currentSessionId) || this.sessions[0];
    },

    newSession() {
        const id = Date.now().toString(36);
        const session = { id, name: `会话 ${this.sessions.length + 1}`, messages: [] };
        this.sessions.push(session);
        this.switchSession(id);
    },

    switchSession(id) {
        const session = this.sessions.find(s => s.id === id);
        if (!session) return;
        this.currentSessionId = id;
        this.messages = session.messages;
        this.clearMessagesDOM();
        this.messages.forEach(msg => this.addMessage(msg.role, msg.content, { withActions: msg.role === 'assistant' }));
        this.saveSessions();
        this.renderSessionList();
        this.toggleSessionPanel(false);
    },

    deleteSession(id) {
        if (this.sessions.length <= 1) return;
        const idx = this.sessions.findIndex(s => s.id === id);
        if (idx < 0) return;
        this.sessions.splice(idx, 1);
        if (this.currentSessionId === id) {
            const next = this.sessions[Math.max(0, idx - 1)] || this.sessions[0];
            this.currentSessionId = next.id;
            this.messages = next.messages;
            this.clearMessagesDOM();
            this.messages.forEach(msg => this.addMessage(msg.role, msg.content, { withActions: msg.role === 'assistant' }));
        }
        this.saveSessions();
        this.renderSessionList();
    },

    toggleSessionPanel(show) {
        const panel = document.getElementById('chatSessionPanel');
        if (!panel) return;
        const target = typeof show === 'boolean' ? show : !panel.classList.contains('show');
        panel.classList.toggle('show', target);
        if (target) this.renderSessionList();
    },

    renderSessionList() {
        const list = document.getElementById('chatSessionList');
        if (!list) return;
        list.innerHTML = '';
        this.sessions.forEach(session => {
            const item = document.createElement('div');
            item.className = 'chat-session-item';
            if (session.id === this.currentSessionId) item.classList.add('active');
            item.innerHTML = `
                <span class="chat-session-name">${this.escapeHtml(session.name)}</span>
                <button class="chat-session-del" title="删除会话">✕</button>`;
            item.addEventListener('click', () => this.switchSession(session.id));
            item.querySelector('.chat-session-del').addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteSession(session.id);
            });
            list.appendChild(item);
        });
    },

    // 以首条用户消息命名会话
    updateSessionName() {
        const session = this.getSession();
        if (!session) return;
        const firstUser = session.messages.find(m => m.role === 'user');
        if (firstUser && (session.name === `会话 ${this.sessions.indexOf(session) + 1}` || !session.name)) {
            const name = firstUser.content.slice(0, 12) + (firstUser.content.length > 12 ? '…' : '');
            session.name = name;
            this.saveSessions();
            this.renderSessionList();
        }
    },

    saveSessions() {
        try {
            localStorage.setItem('chat-sessions', JSON.stringify(this.sessions));
            localStorage.setItem('chat-current-session', this.currentSessionId);
        } catch (e) { }
    },

    loadSessions() {
        try {
            const saved = JSON.parse(localStorage.getItem('chat-sessions'));
            if (Array.isArray(saved) && saved.length) {
                this.sessions = saved;
                const cur = localStorage.getItem('chat-current-session');
                this.currentSessionId = cur && this.sessions.some(s => s.id === cur) ? cur : this.sessions[0].id;
            } else {
                this.sessions = [{ id: Date.now().toString(36), name: '会话 1', messages: [] }];
                this.currentSessionId = this.sessions[0].id;
            }
        } catch (e) {
            this.sessions = [{ id: Date.now().toString(36), name: '会话 1', messages: [] }];
            this.currentSessionId = this.sessions[0].id;
        }
        this.messages = this.getSession().messages;
        this.messages.forEach(msg => this.addMessage(msg.role, msg.content, { withActions: msg.role === 'assistant' }));
        this.renderSessionList();
    },

    // 添加消息到界面
    addMessage(role, content, opts = {}) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const welcome = container.querySelector('.chat-welcome');
        if (welcome) welcome.remove();

        const div = document.createElement('div');
        div.className = `chat-message chat-message-${role}`;

        const avatar = role === 'user'
            ? '<img src="images/Default/profile -picture.webp" alt="我" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">'
            : '<img src="images/Default/profile -picture.webp" alt="AI" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">';
        const label = role === 'user' ? '你' : role === 'error' ? '错误' : 'AI';

        div.innerHTML = `
            <div class="chat-message-avatar">${avatar}</div>
            <div class="chat-message-body">
                <div class="chat-message-label">${label}</div>
                <div class="chat-message-content"></div>
            </div>`;

        const contentEl = div.querySelector('.chat-message-content');
        if (role === 'assistant') {
            contentEl.innerHTML = (typeof MarkdownParser !== 'undefined')
                ? MarkdownParser.parseMarkdown(content)
                : this.escapeHtml(content);
            requestAnimationFrame(() => {
                if (typeof hljs !== 'undefined') {
                    contentEl.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
                }
            });
            div.dataset.raw = content;
            if (opts.withActions !== false) this.addReplyActions(div, content);
        } else if (role === 'error') {
            contentEl.textContent = content;
        } else {
            contentEl.innerHTML = this.escapeHtml(content);
        }

        container.appendChild(div);
        this.scrollToBottom(true);

        // 未读消息角标
        if (role !== 'user' && !document.getElementById('chatWindow').classList.contains('show')) {
            this.unreadCount++;
            this.updateBadge();
        }

        return div;
    },

    // 显示提示消息（非阻塞）
    showNotice(text) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'chat-notice';
        div.textContent = text;
        container.appendChild(div);
        this.scrollToBottom(true);
        setTimeout(() => div.remove(), 3000);
    },

    // 滚动到底部（可选强制）
    scrollToBottom(force) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        if (force || container.scrollHeight - container.scrollTop - container.clientHeight < 80) {
            container.scrollTop = container.scrollHeight;
        }
    },

    // 清空当前会话
    clearChat() {
        this.messages = [];
        this.saveSessions();
        this.clearMessagesDOM('对话已清空，重新开始吧！');
    },

    clearMessagesDOM(welcomeText) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        container.innerHTML = `
            <div class="chat-welcome">
                <div class="chat-welcome-icon">✦</div>
                <div class="chat-welcome-text">${welcomeText || '你好！我是管理员，有什么可以帮你的吗？'}</div>
            </div>`;
    },

    // 更新发送按钮（发送 / 停止）
    updateSendButton() {
        const send = document.getElementById('chatSend');
        if (!send) return;
        if (this.isWaiting) {
            send.innerHTML = this.stopIcon;
            send.title = '停止生成';
        } else {
            send.innerHTML = this.sendIcon;
            send.title = '发送';
        }
    },

    // 输入字数统计与限制
    updateCharCount() {
        const input = document.getElementById('chatInput');
        const count = document.getElementById('chatCharCount');
        if (!input || !count) return;
        const len = input.value.length;
        count.textContent = `${len}/${this.MAX_INPUT_LENGTH}`;
        count.classList.toggle('over', len > this.MAX_INPUT_LENGTH);
    },

    // 斜杠快捷指令菜单
    handleSlashMenu() {
        const input = document.getElementById('chatInput');
        const menu = document.getElementById('chatSlashMenu');
        if (!input || !menu) return;
        const value = input.value;

        if (value.startsWith('/') && value !== '/') {
            const query = value.slice(1).toLowerCase();
            const items = this.SLASH_COMMANDS.filter(c => c.cmd.slice(1).toLowerCase().includes(query));
            menu.innerHTML = '';
            items.forEach(c => {
                const item = document.createElement('div');
                item.className = 'chat-slash-item';
                item.innerHTML = `<span class="slash-cmd">${c.cmd}</span><span class="slash-desc">${c.desc}</span>`;
                item.addEventListener('click', () => {
                    input.value = c.prompt + ' ';
                    input.style.height = 'auto';
                    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
                    this.updateCharCount();
                    menu.style.display = 'none';
                    input.focus({ preventScroll: true });
                });
                menu.appendChild(item);
            });
            menu.style.display = items.length ? 'block' : 'none';
        } else {
            menu.style.display = 'none';
        }
    },

    // 友好的错误提示
    friendlyError(error) {
        const status = error.status;
        if (status === 429) return '请求过于频繁，请稍后再试（限流）';
        if (status === 401 || status === 403) return 'API 认证失败，请检查 API Key 配置';
        if (status === 404) return '请求的接口不存在';
        if (status === 500 || status === 502 || status === 503) return '服务暂时不可用，请稍后重试';
        if (error.name === 'AbortError') return '已停止生成';
        return `请求失败：${error.message}`;
    },

    // HTML 转义
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML.replace(/\n/g, '<br>');
    }
};

window.AIChat = AIChat;
