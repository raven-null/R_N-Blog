/**
 * 写作页「AI」页签：写作问答助手（v1.0.0）
 * ------------------------------------------------------------------
 * 定位（作者明确要求的三条）：
 *   1. **只读问答** —— 不做「插入正文 / 替换选中」，一个字都不会自己写进文章；
 *      需要内容时作者自己复制（每条回答都有「复制」）。
 *   2. **不带正文上下文** —— 请求里只有对话本身，不读标题、不读正文、不读选中；
 *      作者想让人看片段，自己贴进来。
 *   3. **独立配置** —— 用后台「博客设置 → AI 助手 → 写作助手」那一套模型和密钥，
 *      和访客端聊天机器人完全分开；密钥不出服务端（本模块调用 action=ai-write 代调）。
 *
 * 用法：
 *     WriteAi.init({ host: document.getElementById('eeSideAi') });
 *     WriteAi.onShow();   // 切到 AI 页签时调用（顺带聚焦输入框）
 *     WriteAi.stop();     // 离开时中断生成（可选）
 */
(function () {
    'use strict';

    var STREAM_URL = '/api/admin?action=ai-write';
    var SETTINGS_URL = '/api/admin?action=settings';
    var STORE_KEY = 'ee_ai_chat_v1';
    var MAX_KEEP = 12;              // 本地最多留多少条消息
    var PAINT_EVERY = 60;           // 流式渲染节流（毫秒）

    var els = {};
    var host = null;
    var config = null;              // ai.write
    var state = 'loading';          // loading | disabled | nokey | ready | error
    var messages = [];              // [{role, content}]（渲染用，也是请求体）
    var controller = null;          // 正在进行的请求
    var streaming = null;           // 当前流式气泡
    var streamText = '';
    var paintTimer = null;
    var lastPaint = 0;

    // ===== 小工具 =====
    function el(tag, cls, text) {
        var d = document.createElement(tag);
        if (cls) d.className = cls;
        if (text != null) d.textContent = text;
        return d;
    }
    function adminKey() {
        try { return localStorage.getItem('admin_key') || ''; } catch (e) { return ''; }
    }
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * AI 输出走最小白名单清洗：只留「排版类」标签，属性只留链接 href 和代码块的语言 class。
     * 模型被诱导时可能吐 <img onerror>、<script> 之类，这里一律剥掉。
     */
    var ALLOWED_TAGS = {
        P: 1, BR: 1, HR: 1, STRONG: 1, EM: 1, DEL: 1, S: 1, UL: 1, OL: 1, LI: 1,
        BLOCKQUOTE: 1, PRE: 1, CODE: 1, SPAN: 1,
        H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
        TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TH: 1, TD: 1, A: 1
    };
    function sanitize(root) {
        var nodes = Array.prototype.slice.call(root.querySelectorAll('*'));
        nodes.forEach(function (node) {
            var tag = node.tagName;
            if (!ALLOWED_TAGS[tag]) {
                // 不允许的标签：去掉它自己，内容提到上一层
                var parent = node.parentNode;
                if (!parent) return;
                while (node.firstChild) parent.insertBefore(node.firstChild, node);
                parent.removeChild(node);
                return;
            }
            // 属性：只留白名单里的
            Array.prototype.slice.call(node.attributes).forEach(function (attr) {
                var name = attr.name.toLowerCase();
                var keep = false;
                if (tag === 'A' && name === 'href') {
                    keep = /^(https?:|mailto:|#|\/)/i.test(attr.value);
                } else if (tag === 'CODE' && name === 'class') {
                    keep = /^language-[\w+#.-]{1,24}$/.test(attr.value);
                }
                if (!keep) node.removeAttribute(attr.name);
            });
            if (tag === 'A') {
                node.setAttribute('target', '_blank');
                node.setAttribute('rel', 'noopener noreferrer');
            }
        });
        return root.innerHTML;
    }

    /**
     * Markdown → 安全 HTML。marked 没加载时退化为「转义 + 换行」。
     *
     * 安全要点：必须用 DOMParser 建一个**惰性文档**再清洗，不能先塞进 div.innerHTML。
     * 因为把 `<img src=x onerror=...>` 赋给 innerHTML 的那一刻，图片就会开始加载、
     * onerror 立刻执行 —— 这时再「事后清洗」已经晚了（实测 window.__xss 会被赋上值）。
     * DOMParser 生成的文档是惰性的：不加载资源、不执行脚本。
     */
    function renderMd(text) {
        var src = String(text || '');
        if (window.marked && typeof window.marked.parse === 'function' && window.DOMParser) {
            try {
                var html = window.marked.parse(src, { breaks: true, gfm: true });
                var doc = new window.DOMParser().parseFromString('<div id="eeAiRoot">' + html + '</div>', 'text/html');
                var root = doc.getElementById('eeAiRoot');
                if (root) {
                    sanitize(root);
                    return root.innerHTML;
                }
            } catch (e) { /* 落到下面的纯文本 */ }
        }
        return escapeHtml(src).replace(/\n/g, '<br>');
    }

    // ===== 本地记忆（刷新页面后对话还在；关掉标签页就没了）=====
    function loadMemory() {
        try {
            var raw = sessionStorage.getItem(STORE_KEY);
            if (!raw) return [];
            var arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            return arr
                .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; })
                .slice(-MAX_KEEP);
        } catch (e) { return []; }
    }
    function saveMemory() {
        try { sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-MAX_KEEP))); } catch (e) { /* 隐私模式，忽略 */ }
    }

    // ===== 界面 =====
    function build() {
        if (!host || host.dataset.built) return;
        host.dataset.built = '1';
        host.innerHTML = '';
        var wrap = el('div', 'ee-ai');

        els.status = el('div', 'ee-ai-status');
        els.status.id = 'eeAiStatus';
        els.list = el('div', 'ee-ai-list');
        els.list.id = 'eeAiList';

        els.quick = el('div', 'ee-ai-quick');
        els.quick.id = 'eeAiQuick';
        var quickList = [
            '这句话怎么改写更通顺',
            'Markdown 表格怎么写',
            '段落之间怎么过渡',
            '标题怎么起更抓人'
        ];
        quickList.forEach(function (q) {
            var b = el('button', 'ee-ai-mini', q);
            b.type = 'button';
            b.title = '直接提问：' + q;
            b.addEventListener('click', function () { send(q); });
            els.quick.appendChild(b);
        });

        var inputBox = el('div', 'ee-ai-input');
        els.input = document.createElement('textarea');
        els.input.id = 'eeAiInput';
        els.input.rows = 2;
        els.input.placeholder = '问点写作上的事…（Enter 发送，Shift+Enter 换行）';
        els.input.setAttribute('aria-label', '向写作助手提问');

        var acts = el('div', 'ee-ai-acts');
        els.send = el('button', 'ee-btn primary', '发送');
        els.send.type = 'button';
        els.send.id = 'eeAiSend';
        els.stop = el('button', 'ee-btn', '停止');
        els.stop.type = 'button';
        els.stop.id = 'eeAiStop';
        els.stop.hidden = true;
        els.clear = el('button', 'ee-btn danger', '清空');
        els.clear.type = 'button';
        els.clear.id = 'eeAiClear';
        els.clear.hidden = true;
        acts.appendChild(els.send);
        acts.appendChild(els.stop);
        acts.appendChild(els.clear);

        inputBox.appendChild(els.input);
        inputBox.appendChild(acts);

        var note = el('div', 'ee-ai-note', '只解答写作疑问：不读取正文，也不会改动正文');

        wrap.appendChild(els.status);
        wrap.appendChild(els.list);
        wrap.appendChild(els.quick);
        wrap.appendChild(inputBox);
        wrap.appendChild(note);
        host.appendChild(wrap);

        els.send.addEventListener('click', function () { send(); });
        els.stop.addEventListener('click', stop);
        els.clear.addEventListener('click', clearChat);
        els.input.addEventListener('keydown', onKey);

        paintStatus();
        paintMessages();
    }

    function paintStatus() {
        if (!els.status) return;
        els.status.className = 'ee-ai-status';
        var link = '<a href="/admin.html" target="_blank" rel="noopener">后台 → 博客设置 → AI 助手 → 写作助手</a>';
        if (state === 'loading') {
            els.status.textContent = '正在读取 AI 配置…';
        } else if (state === 'disabled') {
            els.status.className = 'ee-ai-status warn';
            els.status.innerHTML = '写作助手已在后台关闭。去 ' + link + ' 打开「启用写作助手」。';
        } else if (state === 'nokey') {
            els.status.className = 'ee-ai-status warn';
            els.status.innerHTML = '还没填写作助手的 API Key。去 ' + link + ' 填一个（独立于访客端），填完点「重试」。';
            if (!els.status.querySelector('.ee-ai-retry')) {
                var retry = el('button', 'ee-ai-mini ee-ai-retry', '重试');
                retry.type = 'button';
                retry.style.marginTop = '6px';
                retry.addEventListener('click', function () { reloadConfig(); });
                els.status.appendChild(document.createElement('br'));
                els.status.appendChild(retry);
            }
        } else if (state === 'error') {
            els.status.className = 'ee-ai-status error';
            els.status.textContent = '读取 AI 配置失败：' + (els.status.dataset.err || '接口无响应');
        } else {
            var model = (config && config.model) || 'AI';
            els.status.textContent = '写作助手 · ' + model + '（密钥在服务端，只做问答）';
        }
        var usable = state === 'ready';
        if (els.input) els.input.disabled = !usable;
        if (els.send) els.send.disabled = !usable || !!controller;
        if (els.quick) els.quick.hidden = !usable || messages.length > 0;
        if (els.clear) els.clear.hidden = messages.length === 0;
    }

    function scrollBottom() {
        if (els.list) els.list.scrollTop = els.list.scrollHeight;
    }

    function bubbleFor(m) {
        var box = el('div', 'ee-ai-msg' + (m.role === 'user' ? ' me' : ''));
        box.appendChild(el('span', 'who', m.role === 'user' ? '我' : '助手'));
        var body = el('div', 'ee-ai-body');
        body.innerHTML = m.role === 'user' ? escapeHtml(m.content).replace(/\n/g, '<br>') : renderMd(m.content);
        box.appendChild(body);
        return box;
    }

    function paintMessages() {
        if (!els.list) return;
        els.list.innerHTML = '';
        if (!messages.length) {
            var empty = el('div', 'ee-ai-empty');
            empty.innerHTML = '写作中拿不准的地方，直接问。<br>例如用词、标点、结构、Markdown 写法。';
            els.list.appendChild(empty);
        } else {
            messages.forEach(function (m) {
                var box = bubbleFor(m);
                if (m.role === 'assistant' && m.content) {
                    var acts = el('div', 'ee-ai-msg-actions');
                    var copy = el('button', 'ee-ai-mini', '复制');
                    copy.type = 'button';
                    copy.addEventListener('click', function () { copyText(m.content, copy); });
                    acts.appendChild(copy);
                    box.appendChild(acts);
                }
                els.list.appendChild(box);
            });
        }
        paintStatus();
        scrollBottom();
    }

    function copyText(text, btn) {
        var done = function () {
            if (btn) { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1200); }
        };
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done, function () { fallback(); });
            } else { fallback(); }
        } catch (e) { fallback(); }
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { }
            document.body.removeChild(ta);
        }
    }

    // ===== 配置 =====
    function reloadConfig() {
        state = 'loading';
        paintStatus();
        var headers = { 'X-Admin-Key': adminKey() };
        return fetch(SETTINGS_URL, { headers: headers })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var ai = (d && d.data && d.data.ai) || {};
                config = ai.write || null;
                if (!config) { state = 'nokey'; }
                else if (config.enabled === false) { state = 'disabled'; }
                else if (!config.apiKey) { state = 'nokey'; }
                else { state = 'ready'; }
            })
            .catch(function (err) {
                state = 'error';
                if (els.status) els.status.dataset.err = (err && err.message) || String(err);
            })
            .then(function () { paintStatus(); });
    }

    // ===== 发送 / 流式 =====
    function paintStream(force) {
        if (!streaming) return;
        var now = Date.now();
        if (!force && now - lastPaint < PAINT_EVERY) {
            if (!paintTimer) {
                paintTimer = setTimeout(function () { paintTimer = null; paintStream(true); }, PAINT_EVERY);
            }
            return;
        }
        lastPaint = now;
        var body = streaming.querySelector('.ee-ai-body');
        if (body) body.innerHTML = renderMd(streamText);
        scrollBottom();
    }

    function send(preset) {
        if (state !== 'ready' || controller) return;
        var text = String(preset != null ? preset : (els.input && els.input.value) || '').trim();
        if (!text) return;
        if (els.input && preset == null) els.input.value = '';

        messages.push({ role: 'user', content: text });
        paintMessages();

        // 助手气泡：先占位成「思考中」
        var box = el('div', 'ee-ai-msg streaming');
        box.appendChild(el('span', 'who', '助手'));
        var body = el('div', 'ee-ai-body');
        body.innerHTML = '<span class="ee-ai-empty" style="padding:0">思考中…</span>';
        box.appendChild(body);
        els.list.appendChild(box);
        streaming = box;
        streamText = '';
        scrollBottom();

        controller = new AbortController();
        paintStatus();
        if (els.stop) els.stop.hidden = false;

        var payload = {
            messages: messages.map(function (m) { return { role: m.role, content: m.content }; })
        };

        fetch(STREAM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey() },
            body: JSON.stringify(payload),
            signal: controller.signal
        }).then(function (res) {
            var type = res.headers.get('content-type') || '';
            if (!res.ok) {
                return res.json().catch(function () { return {}; }).then(function (d) {
                    var msg = (d && d.message) || ('HTTP ' + res.status);
                    // 401 基本只有一种原因：后台登录态过期，提示得具体一点
                    if (res.status === 401) msg = '未授权（后台登录可能已过期），重新登录后台后再试';
                    throw new Error(msg);
                });
            }
            if (type.indexOf('event-stream') < 0) {
                // 上游不是流式：一次性拿全文
                return res.json().then(function (d) {
                    var t = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
                    streamText = t;
                    paintStream(true);
                });
            }
            return readStream(res);
        }).then(function () {
            finish(true);
        }).catch(function (err) {
            if (err && err.name === 'AbortError') { finish(false, '（已停止）'); return; }
            finish(false, '出错了：' + ((err && err.message) || String(err)));
        });
    }

    function readStream(res) {
        var reader = res.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';
        return (function pump() {
            return reader.read().then(function (r) {
                if (r.done) { paintStream(true); return; }
                buffer += decoder.decode(r.value, { stream: true });
                var lines = buffer.split('\n');
                buffer = lines.pop();
                lines.forEach(function (line) {
                    var s = line.trim();
                    if (!s || s.indexOf('data:') !== 0) return;
                    var data = s.slice(5).trim();
                    if (data === '[DONE]') return;
                    try {
                        var j = JSON.parse(data);
                        var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
                        if (delta) { streamText += delta; paintStream(false); }
                    } catch (e) { /* 半行 JSON，等下一块 */ }
                });
                return pump();
            });
        })();
    }

    function finish(ok, note) {
        var box = streaming;
        streaming = null;
        controller = null;
        if (els.stop) els.stop.hidden = true;
        if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
        if (note) streamText = (streamText || '') + (streamText ? '\n\n' : '') + note;
        if (box) {
            box.classList.remove('streaming');
            var body = box.querySelector('.ee-ai-body');
            if (body) body.innerHTML = renderMd(streamText || (note || '（没有返回内容）'));
            if (streamText) {
                var acts = el('div', 'ee-ai-msg-actions');
                var copy = el('button', 'ee-ai-mini', '复制');
                copy.type = 'button';
                var snapshot = streamText;
                copy.addEventListener('click', function () { copyText(snapshot, copy); });
                acts.appendChild(copy);
                box.appendChild(acts);
            }
        }
        if (ok && streamText) messages.push({ role: 'assistant', content: streamText });
        streamText = '';
        saveMemory();
        paintStatus();
        scrollBottom();
    }

    function stop() {
        if (controller) controller.abort();
    }

    function clearChat() {
        if (!messages.length && !streaming) return;
        var doClear = function () {
            stop();
            messages = [];
            try { sessionStorage.removeItem(STORE_KEY); } catch (e) { }
            paintMessages();
        };
        if (window.EE && typeof window.EE.confirm === 'function') {
            window.EE.confirm({
                title: '清空对话',
                message: '清空这次与写作助手的对话？文章内容不受影响。',
                okText: '清空',
                danger: true
            }).then(function (ok) { if (ok) doClear(); });
            return;
        }
        doClear();
    }

    function onKey(e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
            return;
        }
        // 生成中按 Esc 停止（只在输入框里，不影响编辑器/其它 Esc 行为）
        if (e.key === 'Escape' && controller) {
            e.preventDefault();
            stop();
        }
    }

    // ===== 对外 =====
    var WriteAi = {};

    WriteAi.init = function (opts) {
        opts = opts || {};
        host = opts.host || document.getElementById('eeSideAi');
        if (!host) return false;
        messages = loadMemory();
        build();
        reloadConfig();
        return true;
    };

    WriteAi.onShow = function () {
        build();
        paintMessages();
        if (els.input && !els.input.disabled) {
            setTimeout(function () { try { els.input.focus(); } catch (e) { } }, 60);
        }
        return true;
    };

    WriteAi.stop = stop;
    WriteAi.clear = clearChat;
    WriteAi.reloadConfig = reloadConfig;
    WriteAi.isBusy = function () { return !!controller; };
    WriteAi.state = function () { return state; };
    WriteAi.messages = function () { return messages.slice(); };
    /** 测试用：不经过界面直接发一条（行为与点「发送」完全一致） */
    WriteAi.send = function (text) { send(text); };

    window.WriteAi = WriteAi;
})();
