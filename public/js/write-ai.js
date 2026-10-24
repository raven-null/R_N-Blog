/**
 * 写作页「AI」页签：写作问答助手（v1.1.0）
 * ------------------------------------------------------------------
 * 职责只有一个：回答问题。除此之外没有任何功能 ——
 *   · 不写入正文（没有插入 / 替换按钮）
 *   · 不读正文上下文（请求体里只有对话本身）
 *   · 没有快捷提问、没有复制按钮、没有会话管理、不落本地存储
 * 面板里除消息和输入框之外，只有「未配置 / 已关闭 / 出错」这类必要状态提示。
 *
 * 密钥不出服务端：本模块只调用 action=ai-write，由 functions/admin.ts 代调上游。
 *
 * 用法：
 *     WriteAi.init({ host: document.getElementById('eeSideAi') });
 *     WriteAi.onShow();   // 切到 AI 页签时调用（顺带聚焦输入框）
 */
(function () {
    'use strict';

    var STREAM_URL = '/api/admin?action=ai-write';
    var SETTINGS_URL = '/api/admin?action=settings';
    var PAINT_EVERY = 60;           // 流式渲染节流（毫秒）

    // ===== 上下文窗口（v1.4.0）=====
    // 历史**不落盘**（刷新即全新），但同一页里的多轮对话仍然要发给模型，
    // 否则它会「忘记上一句」。发多少有预算，太长既贵又容易跑偏：
    var HISTORY_ROUNDS = 6;         // 最多带最近 6 轮（12 条：user + assistant）
    var HISTORY_MAX_CHARS = 6000;   // 历史部分的字符预算（不含本次提问）
    var HISTORY_MSG_MAX = 2000;     // 单条历史消息截断（服务端另有 4000 字硬上限）

    var els = {};
    var host = null;
    var config = null;              // ai.write
    var state = 'loading';          // loading | disabled | nokey | unauth | ready | error
    var messages = [];              // [{role, content}]：面板里显示的全部对话（只在内存里）
    var controller = null;          // 正在进行的请求
    var streaming = null;           // 当前流式气泡
    var streamText = '';
    var paintTimer = null;
    var lastPaint = 0;

    /**
     * 取出发给模型的上下文：最近 N 轮 + 字数预算，从最旧的一端开始丢。
     * 规则：
     *   · 单条超长先截断（assistant 回答里常有代码块，很容易上万字）；
     *   · 起点必须是 user —— 以 assistant 开头的历史容易让模型跑偏；
     *   · 超预算就成对丢弃（丢一条 user 连带它后面的 assistant 一起丢）；
     *   · 永远保留最后一问，哪怕它自己就超预算（已经按单条上限截断了）。
     */
    function trimHistory(all) {
        var tail = all.slice(-HISTORY_ROUNDS * 2).map(function (m) {
            var c = String(m.content || '');
            if (c.length > HISTORY_MSG_MAX) c = c.slice(0, HISTORY_MSG_MAX);
            return { role: m.role, content: c };
        });
        while (tail.length && tail[0].role !== 'user') tail.shift();
        var total = tail.reduce(function (n, m) { return n + m.content.length; }, 0);
        while (total > HISTORY_MAX_CHARS && tail.length > 1) {
            total -= tail.shift().content.length;
            // 丢到 user 开头为止，保持成对
            while (tail.length > 1 && tail[0].role !== 'user') total -= tail.shift().content.length;
        }
        return tail;
    }

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

    // ===== 界面 =====
    // 布局对齐 DeepSeek 网页版：输入框钉在面板底部，发送按钮就在输入框右侧，
    // 生成中同一个按钮原地变成「停止」；对话超出高度只在消息区滚动。
    var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
    var ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
        '<rect x="7" y="7" width="10" height="10" rx="2"/></svg>';

    function build() {
        if (!host || host.dataset.built) return;
        host.dataset.built = '1';
        host.innerHTML = '';
        var wrap = el('div', 'ee-ai');

        els.status = el('div', 'ee-ai-status');
        els.status.id = 'eeAiStatus';
        els.status.hidden = true;          // 只有出状态（未配置 / 出错）时才出现

        els.list = el('div', 'ee-ai-list');
        els.list.id = 'eeAiList';

        // 一行：输入框 + 右侧圆按钮（发送 ⇄ 停止）
        var inputBox = el('div', 'ee-ai-input');
        els.input = document.createElement('textarea');
        els.input.id = 'eeAiInput';
        els.input.rows = 1;
        // 不放可见提示语（只用 aria-label 给读屏软件），面板保持干净
        els.input.setAttribute('aria-label', '向写作助手提问');

        els.submit = el('button', 'ee-ai-submit');
        els.submit.type = 'button';
        els.submit.id = 'eeAiSubmit';
        els.submit.dataset.mode = 'send';
        els.submit.innerHTML = ICON_SEND;
        els.submit.title = '发送（Enter）';
        els.submit.setAttribute('aria-label', '发送');

        inputBox.appendChild(els.input);
        inputBox.appendChild(els.submit);

        wrap.appendChild(els.status);
        wrap.appendChild(els.list);
        wrap.appendChild(inputBox);
        host.appendChild(wrap);

        // 同一个按钮两种角色：没在生成 → 发送；正在生成 → 停止
        els.submit.addEventListener('click', function () {
            if (controller) stop();
            else send();
        });
        els.input.addEventListener('keydown', onKey);

        paintStatus();
        paintMessages();
    }

    /** 「发送 ⇄ 停止」按钮换形 */
    function setSubmitMode(on) {
        if (!els.submit) return;
        els.submit.dataset.mode = on ? 'stop' : 'send';
        els.submit.innerHTML = on ? ICON_STOP : ICON_SEND;
        var label = on ? '停止生成（Esc）' : '发送（Enter）';
        els.submit.title = label;
        els.submit.setAttribute('aria-label', on ? '停止生成' : '发送');
    }

    /** 状态条里的「重试」小按钮（未配置 / 网络失败 都用它） */
    function appendRetry(btnText) {
        var retry = el('button', 'ee-ai-mini', btnText || '重试');
        retry.type = 'button';
        retry.className = 'ee-ai-mini ee-ai-retry';
        retry.style.marginTop = '6px';
        retry.addEventListener('click', function () { reloadConfig(); });
        els.status.appendChild(document.createElement('br'));
        els.status.appendChild(retry);
    }

    function paintStatus() {
        if (!els.status) return;
        els.status.className = 'ee-ai-status';
        var link = '<a href="/admin.html" target="_blank" rel="noopener">后台 → 博客设置 → AI 助手 → 写作助手</a>';
        if (state === 'loading') {
            els.status.hidden = false;
            els.status.textContent = '正在读取 AI 配置…';
        } else if (state === 'disabled') {
            els.status.hidden = false;
            els.status.className = 'ee-ai-status warn';
            els.status.innerHTML = '写作助手已在后台关闭。去 ' + link + ' 打开「启用写作助手」。';
        } else if (state === 'nokey') {
            els.status.hidden = false;
            els.status.className = 'ee-ai-status warn';
            els.status.innerHTML = '还没填写作助手的 API Key。去 ' + link + ' 填一个（独立于访客端），填完点「重试」。';
            appendRetry('重试');
        } else if (state === 'unauth') {
            // 密钥在服务端存着，但这个页面没通过校验（改过密码 / 登录态丢了），密钥被脱敏成空串。
            // 这时绝不能显示「还没填」—— 作者会以为自己白填了。
            els.status.hidden = false;
            els.status.className = 'ee-ai-status warn';
            els.status.innerHTML = '写作助手的密钥已经配好了，但这个页面没通过管理密钥校验（改过密码或登录态丢了）。' +
                '去 <a href="/admin.html" target="_blank" rel="noopener">后台</a> 重新登录一次，再回来点「重试」。';
            appendRetry('重试');
        } else if (state === 'error') {
            els.status.hidden = false;
            els.status.className = 'ee-ai-status error';
            // 给作者看的是「怎么办」，浏览器原文（Failed to fetch 之类）留在 title 里，排查时能看到
            els.status.innerHTML = '读取 AI 配置失败：' + escapeHtml(els.status.dataset.err || '接口无响应') +
                '。多半是网络断了或请求被插件拦截，恢复后点「重试」。';
            els.status.title = els.status.dataset.raw || '';
            appendRetry('重试');
        } else {
            // 正常状态不摆状态条：这个面板只回答问题，不放别的东西
            els.status.hidden = true;
        }
        var usable = state === 'ready';
        if (els.input) els.input.disabled = !usable;
        if (els.submit) els.submit.disabled = !usable;
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
            els.list.appendChild(el('div', 'ee-ai-empty', '写作中拿不准的地方，直接问。'));
        } else {
            messages.forEach(function (m) { els.list.appendChild(bubbleFor(m)); });
        }
        paintStatus();
        scrollBottom();
    }

    // ===== 配置 =====
    /**
     * 读配置。网络层失败（浏览器原文 Failed to fetch）和 5xx 会退避重试两次 ——
     * 常见场景是断网一瞬间、或正好撞上站点部署。两次都失败才进 error 态。
     */
    var CONFIG_RETRY_DELAYS = [300, 800];

    function loadSettingsOnce() {
        return fetch(SETTINGS_URL, { headers: { 'X-Admin-Key': adminKey() } })
            .then(function (r) {
                if (!r.ok && r.status !== 401) {
                    var e = new Error('HTTP ' + r.status);
                    if (r.status >= 500) e.retriable = true;
                    throw e;
                }
                return r.json();
            });
    }

    function reloadConfig() {
        state = 'loading';
        paintStatus();
        var tries = 0;
        function attempt() {
            return loadSettingsOnce().catch(function (err) {
                // 网络层失败（没拿到响应）或 5xx：重试
                var netFail = !(err && /^HTTP \d+$/.test(err.message || ''));
                if ((netFail || err.retriable) && tries < CONFIG_RETRY_DELAYS.length) {
                    var wait = CONFIG_RETRY_DELAYS[tries++];
                    return new Promise(function (res) { setTimeout(res, wait); }).then(attempt);
                }
                throw err;
            });
        }
        return attempt()
            .then(function (d) {
                var ai = (d && d.data && d.data.ai) || {};
                config = ai.write || null;
                if (!config) { state = 'nokey'; }
                else if (config.enabled === false) { state = 'disabled'; }
                else if (config.apiKey) { state = 'ready'; }
                // 服务端把「根本没配」（hasKey === false）和「配了但这个请求没通过校验、
                // 密钥被脱敏成空串」（hasKey === true）分开了，别再混成一个「还没填」
                else if (config.hasKey) { state = 'unauth'; }
                else { state = 'nokey'; }
            })
            .catch(function (err) {
                state = 'error';
                if (els.status) {
                    var raw = (err && err.message) || String(err);
                    els.status.dataset.raw = raw;
                    els.status.dataset.err = /Failed to fetch|NetworkError|load failed|^HTTP 5|ERR_/i.test(raw)
                        ? '网络连接失败（请求没发出去，或被浏览器插件拦截）'
                        : raw;
                }
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
        setSubmitMode(true);

        // 只把裁剪过的窗口发给模型（见 trimHistory）；面板里显示的仍然是完整对话
        var payload = { messages: trimHistory(messages) };

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
        setSubmitMode(false);
        if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
        if (note) streamText = (streamText || '') + (streamText ? '\n\n' : '') + note;
        if (box) {
            box.classList.remove('streaming');
            var body = box.querySelector('.ee-ai-body');
            if (body) body.innerHTML = renderMd(streamText || (note || '（没有返回内容）'));
        }
        if (ok && streamText) messages.push({ role: 'assistant', content: streamText });
        streamText = '';
        paintStatus();
        scrollBottom();
    }

    function stop() {
        if (controller) controller.abort();
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
    WriteAi.reloadConfig = reloadConfig;
    WriteAi.isBusy = function () { return !!controller; };
    WriteAi.state = function () { return state; };
    WriteAi.messages = function () { return messages.slice(); };
    /** 测试用：看一下此刻会发给模型的上下文窗口（不含尚未发送的提问） */
    WriteAi.contextPreview = function () { return trimHistory(messages); };
    /** 测试用：不经过界面直接发一条（行为与点「发送」完全一致） */
    WriteAi.send = function (text) { send(text); };

    window.WriteAi = WriteAi;
})();
