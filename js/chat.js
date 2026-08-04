/**
 * AI 智能对话助手
 * 使用智谱 BigModel GLM-4-Flash API
 */
const AIChat = {
    // API 配置 - 请替换为你的 API Key
    config: {
        apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        apiKey: '5dc4e465fad643a7b486d85e2f35594f.l105oILErFBpytEq',
        model: 'glm-4-flash',
        maxTokens: 1024
    },

    // 对话历史
    messages: [],

    // 是否正在等待回复
    isWaiting: false,

    // 初始化
    init() {
        this.createChatUI();
        this.bindEvents();
        this.loadHistory();
    },

    // 创建聊天界面
    createChatUI() {
        const chatHTML = `
            <button class="chat-toggle" id="chatToggle" title="AI 助手">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
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
                <div class="chat-messages" id="chatMessages">
                    <div class="chat-welcome">
                        <div class="chat-welcome-icon">✦</div>
                        <div class="chat-welcome-text">你好！我是管理员，有什么可以帮你的吗？</div>
                    </div>
                </div>
                <div class="chat-input-area">
                    <textarea class="chat-input" id="chatInput" placeholder="输入你的问题..." rows="1"></textarea>
                    <button class="chat-send" id="chatSend" title="发送">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        const container = document.createElement('div');
        container.className = 'chat-container';
        container.innerHTML = chatHTML;
        document.body.appendChild(container);
    },

    // 绑定事件
    bindEvents() {
        const toggle = document.getElementById('chatToggle');
        const close = document.getElementById('chatClose');
        const clear = document.getElementById('chatClear');
        const send = document.getElementById('chatSend');
        const input = document.getElementById('chatInput');

        if (toggle) toggle.addEventListener('click', () => this.toggleWindow());
        if (close) close.addEventListener('click', () => this.closeWindow());
        if (clear) clear.addEventListener('click', () => this.clearChat());
        if (send) send.addEventListener('click', () => this.sendMessage());

        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });

            input.addEventListener('input', () => {
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 100) + 'px';
            });
        }

        // 拖拽功能
        this.initDrag();
    },

    // 初始化拖拽
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

        // 调整大小功能
        this.initResize();
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

    // 切换窗口显示
    toggleWindow() {
        const chatWindow = document.getElementById('chatWindow');
        chatWindow.classList.toggle('show');
        if (chatWindow.classList.contains('show')) {
            chatWindow.style.opacity = '1';
            chatWindow.style.visibility = 'visible';
            chatWindow.style.transform = '';
            document.getElementById('chatInput').focus();
        } else {
            chatWindow.style.opacity = '';
            chatWindow.style.visibility = '';
            chatWindow.style.transform = '';
        }
    },

    // 关闭窗口
    closeWindow() {
        const chatWindow = document.getElementById('chatWindow');
        chatWindow.classList.remove('show');
        chatWindow.style.opacity = '';
        chatWindow.style.visibility = '';
        chatWindow.style.transform = '';
    },

    // 发送消息
    async sendMessage() {
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (!text || this.isWaiting) return;

        input.value = '';
        input.style.height = 'auto';

        this.addMessage('user', text);
        this.messages.push({ role: 'user', content: text });
        this.saveHistory();

        this.isWaiting = true;
        this.updateSendButton();
        this.showTyping();

        try {
            const reply = await this.callAPI();
            this.hideTyping();
            this.addMessage('assistant', reply);
            this.messages.push({ role: 'assistant', content: reply });
            this.saveHistory();
        } catch (error) {
            this.hideTyping();
            this.addMessage('error', `请求失败：${error.message}`);
        }

        this.isWaiting = false;
        this.updateSendButton();
    },

    // 调用 API
    async callAPI() {

        // 构建消息列表：系统提示词 + 对话历史
        const messagesWithSystem = [
            {
                role: 'system',
                content: '你是一名博客管理员，名叫渡鸦_001。你的职责是：1. 热情友好地接待每一位访客；2. 回答关于博客内容、技术文章的问题；3. 你的所有回复都要体现你作为管理员的身份，比如"欢迎来到我的博客"、"感谢阅读我的文章"等。你博学多才，乐于助人。'
            },
            ...this.messages  // 展开对话历史
        ];

        const response = await fetch(this.config.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`
            },
            body: JSON.stringify({
                model: this.config.model,
                messages: messagesWithSystem,  // 使用包含系统提示的列表
                max_tokens: this.config.maxTokens,
                stream: false
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    },

    // 添加消息到界面
    addMessage(role, content) {
        const container = document.getElementById('chatMessages');
        const welcome = container.querySelector('.chat-welcome');
        if (welcome) welcome.remove();

        const div = document.createElement('div');
        div.className = `chat-message chat-message-${role}`;

        const avatar = role === 'user'
            ? '<img src="images/system1.jpg" alt="我" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">'
            : '✦';
        const label = role === 'user' ? '你' : role === 'error' ? '错误' : 'AI';

        div.innerHTML = `
            <div class="chat-message-avatar">${avatar}</div>
            <div class="chat-message-body">
                <div class="chat-message-label">${label}</div>
                <div class="chat-message-content">${this.escapeHtml(content)}</div>
            </div>
        `;

        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    },

    // 显示/隐藏打字指示器
    showTyping() {
        const container = document.getElementById('chatMessages');
        const div = document.createElement('div');
        div.className = 'chat-message chat-message-assistant chat-typing';
        div.id = 'chatTyping';
        div.innerHTML = `
            <div class="chat-message-avatar">✦</div>
            <div class="chat-message-body">
                <div class="chat-message-label">AI</div>
                <div class="chat-message-content">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                </div>
            </div>
        `;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    },

    hideTyping() {
        const typing = document.getElementById('chatTyping');
        if (typing) typing.remove();
    },

    // 更新发送按钮状态
    updateSendButton() {
        const send = document.getElementById('chatSend');
        send.disabled = this.isWaiting;
    },

    // 清空对话
    clearChat() {
        this.messages = [];
        this.saveHistory();
        const container = document.getElementById('chatMessages');
        container.innerHTML = `
            <div class="chat-welcome">
                <div class="chat-welcome-icon">✦</div>
                <div class="chat-welcome-text">对话已清空，重新开始吧！</div>
            </div>
        `;
    },

    // HTML 转义
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML.replace(/\n/g, '<br>');
    },

    // 保存/加载历史
    saveHistory() {
        try {
            localStorage.setItem('chat-history', JSON.stringify(this.messages));
        } catch (e) { }
    },

    loadHistory() {
        try {
            const saved = localStorage.getItem('chat-history');
            if (saved) {
                this.messages = JSON.parse(saved);
                this.messages.forEach(msg => this.addMessage(msg.role, msg.content));
            }
        } catch (e) { }
    }
};

window.AIChat = AIChat;