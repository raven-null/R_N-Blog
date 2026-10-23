/**
 * 写作页 · 本地预览渲染（preview.html）
 * ------------------------------------------------------------------
 * v1.0.0
 * 数据来源：写作页 window.open 打开本页后，用 postMessage 把
 *   {title, tags, excerpt, image, status, statusText, content, words, at}
 * 发过来（只认同源）。收到就渲染，全程不碰数据库。
 *
 * 渲染复用站点的 Markdown 管线（js/markdown-config.js + vendored marked），
 * 因此标题、列表、表格、代码块、图注的观感与前台一致。
 * 白板 / 思维导图不挂 iframe：预览是为了看排版，挂 8MB 的 Excalidraw
 * 既慢又可能触发画布的口令流程，这里用占位卡片说明。
 */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var esc = function (s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };
    var rendered = false;

    // 站点 Markdown 配置会给图片挂 onclick="openLightbox(this)"、
    // 给代码块挂 onclick="copyCode(this)"，本页要提供这两个函数，否则点了报未定义。
    window.openLightbox = function (img) {
        if (img && img.src) window.open(img.src, '_blank');
    };
    window.copyCode = function (btn) {
        var box = btn.closest ? btn.closest('.code-block') : null;
        var code = box ? box.querySelector('code') : null;
        var text = code ? code.textContent : '';
        var done = function () {
            var label = btn.querySelector('span');
            if (!label) return;
            var old = label.textContent;
            label.textContent = '已复制';
            setTimeout(function () { label.textContent = old; }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { /* 忽略 */ });
        } else {
            var ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { /* 忽略 */ }
            document.body.removeChild(ta);
        }
    };

    /** 画布占位：把 .embed-block / ```excalidraw 代码块换成说明卡片 */
    function maskEmbeds(root) {
        Array.prototype.forEach.call(root.querySelectorAll('.embed-block'), function (el) {
            var kind = el.getAttribute('data-kind') === 'map' ? '思维导图' : '白板';
            var id = el.getAttribute('data-id') || '';
            var box = document.createElement('div');
            box.className = 'pv-canvas';
            box.innerHTML = '<span class="pv-canvas-k">' + kind + '</span>' +
                '<span class="pv-canvas-id">' + esc(id) + '</span>' +
                '<span class="pv-canvas-tip">预览页不加载画布。正式文章页会在这里显示可交互的' + kind +
                '（含编辑口令校验）。</span>';
            if (el.parentNode) el.parentNode.replaceChild(box, el);
        });
        // ```excalidraw / ```mindmap 代码块：前台由编辑器渲染成画布，预览里同样只给占位
        Array.prototype.forEach.call(root.querySelectorAll('pre code[class*="language-excalidraw"], pre code[class*="language-mindmap"]'), function (code) {
            var isMap = /language-mindmap/.test(code.className);
            var block = code.closest('.code-block') || code.parentNode;
            var box = document.createElement('div');
            box.className = 'pv-canvas';
            box.innerHTML = '<span class="pv-canvas-k">' + (isMap ? '思维导图' : '白板') + '</span>' +
                '<span class="pv-canvas-id">内嵌在正文里</span>' +
                '<span class="pv-canvas-tip">预览页不加载画布数据。正式文章页会把这段渲染成可交互画布。</span>';
            if (block && block.parentNode) block.parentNode.replaceChild(box, block);
        });
    }

    function render(p) {
        if (!p) return;
        rendered = true;
        document.title = '预览 · ' + (p.title || '未命名');

        $('pvDim').textContent = (p.statusText || '草稿') + ' · ' + (p.words || 0).toLocaleString() + ' 字 · ' +
            new Date(p.at || Date.now()).toLocaleTimeString();

        $('pvTitle').textContent = p.title || '（无标题）';

        var meta = [];
        if (p.statusText) meta.push('<span>' + esc(p.statusText) + '</span>');
        meta.push('<span>' + (p.words || 0).toLocaleString() + ' 字</span>');
        (p.tags || []).forEach(function (t) {
            meta.push('<span class="pv-tag">' + esc(t) + '</span>');
        });
        $('pvMeta').innerHTML = meta.join('');

        var cover = $('pvCover');
        if (p.image) {
            cover.innerHTML = '<img src="' + esc(p.image) + '" alt="封面" onerror="this.style.display=\'none\'">';
        } else {
            cover.innerHTML = '';
        }

        var ex = $('pvExcerpt');
        if (p.excerpt) { ex.style.display = ''; ex.textContent = p.excerpt; }
        else ex.style.display = 'none';

        // 复用站点 Markdown 管线（marked + markdown-config）
        var body = $('pvBody');
        var html;
        try {
            if (typeof marked !== 'undefined' && window.MarkdownConfig) {
                var renderer = window.MarkdownConfig.apply(marked);
                html = marked.parse(p.content || '', { renderer: renderer });
            } else if (typeof marked !== 'undefined') {
                html = marked.parse(p.content || '');
            } else {
                throw new Error('marked 未加载');
            }
        } catch (e) {
            // 兜底：至少把文字显示出来，别白屏
            html = '<pre style="white-space:pre-wrap">' + esc(p.content || '') + '</pre>' +
                '<p style="color:#ff9f9a;font-size:12.5px">Markdown 渲染失败（' + esc(e.message) + '），以上为原文。</p>';
        }
        body.innerHTML = html;
        maskEmbeds(body);

        // 相关画布（v3.35.0：白板 / 导图改成文章的关联）。预览页不加载画布本体，只列出来
        var rel = $('pvRelated');
        var refs = Array.isArray(p.canvasRefs) ? p.canvasRefs.filter(function (r) {
            return r && (r.kind === 'board' || r.kind === 'map') && r.id;
        }) : [];
        if (rel) {
            if (!refs.length) {
                rel.style.display = 'none';
                rel.innerHTML = '';
            } else {
                rel.style.display = '';
                rel.innerHTML = '<div class="pv-related-head">相关画布' +
                    '<span class="pv-related-count">' + refs.length + '</span></div>' +
                    '<div class="pv-related-list">' + refs.map(function (r) {
                        var k = r.kind === 'map' ? 'map' : 'board';
                        var label = k === 'map' ? '思维导图' : '白板';
                        var name = String(r.name || '').trim() || ('未命名' + label);
                        return '<div class="pv-related-row ' + k + '">' +
                            '<span class="pv-related-k">' + label + '</span>' +
                            '<span class="pv-related-n">' + esc(name) + '</span>' +
                            '<span class="pv-related-note">正式页面点开展开</span>' +
                            '</div>';
                    }).join('') + '</div>';
            }
        }

        if (typeof hljs !== 'undefined') {
            Array.prototype.forEach.call(body.querySelectorAll('pre code'), function (block) {
                try { hljs.highlightElement(block); } catch (e) { /* 忽略 */ }
            });
        }

        $('pvEmpty').style.display = 'none';
        $('pvDoc').style.display = '';
    }

    /** 向打开本页的写作页要数据 */
    function ask() {
        try {
            if (window.opener && !window.opener.closed) {
                window.opener.postMessage({ type: 'ee-preview-ready' }, location.origin);
                return true;
            }
        } catch (e) { /* 跨域 / 已关闭：落到下面的提示 */ }
        return false;
    }

    window.addEventListener('message', function (e) {
        if (e.origin !== location.origin) return;
        var d = e.data;
        if (!d || d.type !== 'ee-preview-data') return;
        render(d.payload);
    });

    $('pvClose').addEventListener('click', function () { window.close(); });
    $('pvRefresh').addEventListener('click', function () {
        if (!ask()) $('pvDim').textContent = '写作页已关闭，无法重新获取';
    });

    // 页面加载完主动要一次；3 秒还没数据就说明是直接打开的
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { ask(); });
    } else {
        ask();
    }
    setTimeout(function () {
        if (!rendered) $('pvDim').textContent = '未收到内容 · 可在写作页重新点「预览」';
    }, 3000);
})();
