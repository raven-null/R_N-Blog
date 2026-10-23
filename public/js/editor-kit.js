/**
 * 写作页基础设施（admin-edit.html 专用，也被后续页面复用）
 * ------------------------------------------------------------------
 * v1.1.0
 *   - 新增 parseLegacyCanvasRefs / stripCanvasBlocks：白板 / 导图改成「关联」后，
 *     旧文章正文里的内嵌块需要能被认出来并一键移出正文（详见文件内注释）
 * v1.0.0
 *   - 从 admin-edit.js 里抽出的公共件，让主文件只留「写作这件事」本身
 *   - toast / esc：与原来完全一致，调用点不用改
 *   - EE.request / EE.api：请求层统一兜底
 *       · 非 JSON 响应不再抛异常炸掉整条 promise 链（Netlify 502/504 返回 HTML 页面时常见）
 *       · GET 遇到 5xx / 网络错误自动重试一次（部署中、连接被掐断）
 *       · POST 不自动重试（非幂等，重试可能重复建文章），只做错误归一
 *   - EE.confirm：自绘确认框（Promise），替掉原生 confirm/alert
 *       · 支持「危险操作」红按钮、ESC 取消、回车确认、点遮罩取消
 *       · 没有挂载点或脚本出错时回退到原生 confirm，不至于卡死流程
 *   - EE.countWords：净字数（汉字数 + 英文单词数，去掉 Markdown 标记）
 *   - EE.draft：本地草稿暂存（localStorage），带配额保护
 *   - EE.openShortcuts：快捷键说明面板
 *
 * 依赖：页面里需要 #eeToast（提示胶囊）；其余 DOM 自己创建。
 */
(function () {
    'use strict';

    var EE = {};
    var doc = document;

    // ===== 转义 / 提示 =====
    EE.esc = function (s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    /** 底部提示胶囊。type: undefined | 'success' | 'error' */
    EE.toast = function (msg, type) {
        var t = doc.getElementById('eeToast');
        if (!t) { console.log('[toast]', msg); return; }
        t.textContent = msg;
        t.className = 'ee-toast show' + (type ? ' ' + type : '');
        clearTimeout(t._timer);
        // 错误信息留久一点，够看清
        t._timer = setTimeout(function () { t.className = 'ee-toast'; }, type === 'error' ? 4200 : 2600);
    };

    // ===== 请求层 =====
    var RETRY_DELAY = 700;

    /**
     * 底层请求：永远 resolve 一个对象，不抛异常。
     * 成功（HTTP 2xx 且是合法 JSON）→ 服务端原始对象 {status:'success', ...}
     * 失败 → {status:'error', message, httpStatus}
     */
    function once(url, opts) {
        var init = {
            method: opts.method || 'GET',
            headers: opts.headers || {},
            body: opts.body,
            cache: 'no-store'
        };
        return fetch(url, init).then(function (res) {
            return res.text().then(function (text) {
                var data = null;
                try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
                if (data === null || typeof data !== 'object') {
                    // Netlify 的错误页 / 网关返回的 HTML：包装成结构化错误，别让上层拿到字符串
                    return {
                        status: 'error',
                        message: '服务返回的不是 JSON（HTTP ' + res.status + '）',
                        httpStatus: res.status,
                        raw: String(text || '').slice(0, 200)
                    };
                }
                if (!data.status && res.status >= 400) data.status = 'error';
                if (data.httpStatus == null) data.httpStatus = res.status;
                return data;
            });
        }, function (err) {
            return { status: 'error', message: '网络错误：' + ((err && err.message) || err), network: true };
        });
    }

    /**
     * @param {string} url
     * @param {object} [opts] {method, body, headers, retry}
     *        retry: 失败后重试次数。只对 GET 生效（POST/PATCH/DELETE 非幂等，不自动重试）
     */
    EE.request = function (url, opts) {
        opts = opts || {};
        var method = (opts.method || 'GET').toUpperCase();
        var retry = opts.retry == null ? (method === 'GET' ? 1 : 0) : opts.retry;
        function attempt(left) {
            return once(url, opts).then(function (r) {
                var retriable = r.network || (r.httpStatus >= 500);
                if (left > 0 && retriable) {
                    return new Promise(function (res) { setTimeout(res, RETRY_DELAY); })
                        .then(function () { return attempt(left - 1); });
                }
                return r;
            });
        }
        return attempt(retry);
    };

    /** /api/admin?query —— 带管理密钥 */
    EE.api = function (query, opts) {
        opts = opts || {};
        return EE.request('/api/admin?' + query, {
            method: opts.method,
            body: opts.body,
            retry: opts.retry,
            headers: { 'Content-Type': 'application/json', 'X-Admin-Key': EE.adminKey() }
        });
    };

    /** 管理密钥（各处统一从这里取，避免每个模块各读一次 localStorage） */
    EE.adminKey = function () {
        try { return localStorage.getItem('admin_key') || ''; } catch (e) { return ''; }
    };

    // ===== 自绘确认框 =====
    var modalEl = null, modalResolve = null;
    function buildModal() {
        var el = doc.createElement('div');
        el.className = 'ee-confirm';
        el.id = 'eeConfirm';
        el.innerHTML =
            '<div class="ee-confirm-mask" data-act="cancel"></div>' +
            '<div class="ee-confirm-box" role="dialog" aria-modal="true" aria-labelledby="eeConfirmTitle">' +
            '  <h3 id="eeConfirmTitle"></h3>' +
            '  <p id="eeConfirmMsg"></p>' +
            '  <div class="ee-confirm-actions">' +
            '    <button type="button" class="ee-btn" id="eeConfirmCancel"></button>' +
            '    <button type="button" class="ee-btn primary" id="eeConfirmOk"></button>' +
            '  </div>' +
            '</div>';
        doc.body.appendChild(el);

        el.addEventListener('click', function (e) {
            var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
            if (act === 'cancel') settle(false);
        });
        el.querySelector('#eeConfirmCancel').addEventListener('click', function () { settle(false); });
        el.querySelector('#eeConfirmOk').addEventListener('click', function () { settle(true); });
        doc.addEventListener('keydown', function (e) {
            if (!el.classList.contains('open')) return;
            if (e.key === 'Escape') { e.preventDefault(); settle(false); }
            else if (e.key === 'Enter') { e.preventDefault(); settle(true); }
        }, true);
        return el;
    }
    function settle(v) {
        if (!modalEl) return;
        modalEl.classList.remove('open');
        var fn = modalResolve;
        modalResolve = null;
        if (fn) fn(v);
    }

    /**
     * 自绘确认框
     * @param {object|string} opts 字符串等价 {message}
     *        {title, message, okText, cancelText, danger}
     * @returns {Promise<boolean>}
     */
    EE.confirm = function (opts) {
        if (typeof opts === 'string') opts = { message: opts };
        opts = opts || {};
        // 兜底：DOM 建不起来（或 body 还没就绪）就用原生，流程不能断
        if (!doc.body) return Promise.resolve(window.confirm(opts.message || ''));
        try {
            if (!modalEl) modalEl = buildModal();
        } catch (e) {
            return Promise.resolve(window.confirm(opts.message || ''));
        }
        // 前一个弹窗还没关：先当取消，避免 Promise 悬空
        if (modalResolve) settle(false);

        modalEl.querySelector('#eeConfirmTitle').textContent = opts.title || '确认操作';
        modalEl.querySelector('#eeConfirmMsg').textContent = opts.message || '';
        var ok = modalEl.querySelector('#eeConfirmOk');
        var cancel = modalEl.querySelector('#eeConfirmCancel');
        ok.textContent = opts.okText || '确定';
        cancel.textContent = opts.cancelText || '取消';
        ok.classList.toggle('danger', !!opts.danger);
        cancel.style.display = opts.cancelText === null ? 'none' : '';
        modalEl.classList.add('open');
        setTimeout(function () { try { ok.focus(); } catch (e) { /* 忽略 */ } }, 30);

        return new Promise(function (resolve) { modalResolve = resolve; });
    };

    // ===== 净字数 =====
    /**
     * 汉字数 + 英文/数字单词数。去掉 Markdown 标记与图片地址，
     * 图片按 1 字计（跟阅读体验更接近；原来按源码 length 算，图片那串 URL 能占几十字）。
     * @returns {{words:number, chars:number}} chars = 去掉标记后的纯文本长度
     */
    EE.countWords = function (md) {
        var s = String(md == null ? '' : md).replace(/\r\n/g, '\n');
        // 代码块：保留代码内容，但去掉围栏与语言名
        s = s.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm, '$2');
        s = s.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gm, '');
        s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '图');            // 图片 → 1 字
        s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');            // 链接保留文字
        s = s.replace(/<[^>]+>/g, '');                            // 内联 HTML
        s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');           // 标题号
        s = s.replace(/^[ \t]*>[ \t]?/gm, '');                    // 引用号
        s = s.replace(/^[ \t]*([-*+]|\d{1,3}[.)])[ \t]+/gm, '');   // 列表号
        s = s.replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '');         // 分割线
        s = s.replace(/(\*\*|__|~~|==|`|\*|_)/g, '');             // 行内标记
        var text = s.replace(/\s+/g, ' ').trim();
        var zh = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) || []).length;
        var latin = (text.match(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g) || []).length;
        return { words: zh + latin, chars: text.length };
    };

    // ===== 旧「正文内嵌画布」的兼容与迁移（v1.1.0）=====
    /**
     * v3.35.0 起，白板 / 导图不再「插入正文」，而是作为文章的**关联**（canvasRefs）。
     * 这两个函数只服务历史数据：
     *   parseLegacyCanvasRefs(md) —— 从旧正文里认出内嵌的画布，供编辑页提示「转为关联」
     *   stripCanvasBlocks(md)     —— 把正文里的内嵌块整段移出（迁移时用）
     * 识别三种历史写法：```embed 换行 board:id / ```embed board:id / ```excalidraw 换行 id
     */
    var CANVAS_ID_RE = /^(?:wb|mm)-[A-Za-z0-9_-]{2,61}$/;

    EE.parseLegacyCanvasRefs = function (md) {
        var s = String(md == null ? '' : md);
        var out = [], seen = {};
        function push(kind, id) {
            id = String(id || '').trim();
            if (!CANVAS_ID_RE.test(id)) return;
            var key = kind + ':' + id;
            if (seen[key]) return;
            seen[key] = 1;
            out.push({ kind: kind, id: id });
        }
        var re1 = /```embed[^\n]*\n\s*(board|map)\s*:\s*([^\s:]+)/g;
        var re2 = /```embed\s+(board|map)\s*:\s*([^\s:]+)/g;
        var re3 = /```excalidraw[^\n]*\n\s*(\S+)/g;
        var m;
        while ((m = re1.exec(s))) push(m[1] === 'map' ? 'map' : 'board', m[2]);
        while ((m = re2.exec(s))) push(m[1] === 'map' ? 'map' : 'board', m[2]);
        while ((m = re3.exec(s))) {
            var bare = m[1].trim();
            push(bare.indexOf('mm-') === 0 ? 'map' : 'board', bare);
        }
        return out;
    };

    /** 把正文里的内嵌画布块整段移出，返回清理后的 Markdown */
    EE.stripCanvasBlocks = function (md) {
        var s = String(md == null ? '' : md);
        // ```embed ... ``` 整块。开栏行可能自带 board:id，也可能写在下一行；
        // 块内允许为空（收尾围栏紧跟换行），所以中间那段是惰性匹配、不强制要求额外换行。
        s = s.replace(/(^|\n)[ \t]*```embed[^\n]*(?:\n[\s\S]*?)?\n?[ \t]*```[ \t]*(?=\n|$)/g, '$1');
        // ```excalidraw ... ``` 整块（更早的写法，块内是裸 id）
        s = s.replace(/(^|\n)[ \t]*```excalidraw[^\n]*(?:\n[\s\S]*?)?\n?[ \t]*```[ \t]*(?=\n|$)/g, '$1');
        return s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
    };

    // ===== 本地草稿 =====
    var DRAFT_PREFIX = 'ee_draft_v1:';
    EE.draft = {
        /** 只有 localStorage 真的可写才认为可用（隐私模式下会抛） */
        available: function () {
            try {
                localStorage.setItem(DRAFT_PREFIX + '__probe', '1');
                localStorage.removeItem(DRAFT_PREFIX + '__probe');
                return true;
            } catch (e) { return false; }
        },
        save: function (key, data) {
            if (!key) return false;
            try {
                localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ t: Date.now(), data: data }));
                return true;
            } catch (e) {
                // 配额满了：清掉同前缀的旧草稿再试一次（只留当前这篇）
                try {
                    for (var i = localStorage.length - 1; i >= 0; i--) {
                        var k = localStorage.key(i);
                        if (k && k.indexOf(DRAFT_PREFIX) === 0 && k !== DRAFT_PREFIX + key) localStorage.removeItem(k);
                    }
                    localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ t: Date.now(), data: data }));
                    return true;
                } catch (e2) { return false; }
            }
        },
        load: function (key) {
            if (!key) return null;
            try {
                var raw = localStorage.getItem(DRAFT_PREFIX + key);
                if (!raw) return null;
                var obj = JSON.parse(raw);
                if (!obj || !obj.data) return null;
                return { savedAt: obj.t || 0, data: obj.data };
            } catch (e) { return null; }
        },
        clear: function (key) {
            if (!key) return;
            try { localStorage.removeItem(DRAFT_PREFIX + key); } catch (e) { /* 忽略 */ }
        }
    };

    // ===== 快捷键说明 =====
    var SHORTCUTS = [
        ['Ctrl / ⌘ + S', '保存'],
        ['Ctrl / ⌘ + .', '折叠 / 展开右侧属性栏'],
        ['Ctrl / ⌘ + F', '浏览器内查找（编辑器也支持）'],
        ['右键正文', '剪切 / 复制 / 粘贴 / 格式 / 段落操作'],
        ['Esc', '关闭当前弹层'],
        ['?', '打开这张快捷键说明']
    ];
    var scEl = null;
    EE.openShortcuts = function () {
        if (!doc.body) return;
        if (!scEl) {
            scEl = doc.createElement('div');
            scEl.className = 'ee-shortcuts';
            scEl.id = 'eeShortcuts';
            scEl.innerHTML =
                '<div class="ee-shortcuts-mask" data-act="close"></div>' +
                '<div class="ee-shortcuts-box" role="dialog" aria-modal="true">' +
                '  <div class="ee-shortcuts-head"><span>快捷键</span>' +
                '    <button type="button" class="ee-btn" data-act="close">关闭</button></div>' +
                '  <div class="ee-shortcuts-body" id="eeShortcutsBody"></div>' +
                '</div>';
            doc.body.appendChild(scEl);
            scEl.addEventListener('click', function (e) {
                var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
                if (act === 'close') EE.closeShortcuts();
            });
            scEl.querySelector('#eeShortcutsBody').innerHTML = SHORTCUTS.map(function (r) {
                return '<div class="ee-sc-row"><kbd>' + EE.esc(r[0]) + '</kbd><span>' + EE.esc(r[1]) + '</span></div>';
            }).join('');
            doc.addEventListener('keydown', function (e) {
                if (!scEl.classList.contains('open')) return;
                if (e.key === 'Escape') { e.preventDefault(); EE.closeShortcuts(); }
            }, true);
        }
        scEl.classList.add('open');
    };
    EE.closeShortcuts = function () {
        if (scEl) scEl.classList.remove('open');
    };

    window.EE = EE;
})();
