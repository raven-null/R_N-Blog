/**
 * marked 自定义配置（主线程与 Web Worker 共用）
 * ---------------------------------------------------------------------------
 * 背景：原实现把 marked 的配置写在 MarkdownParser.parseMarkdown() 里，而长文
 * （content.length >= 5000）会走 public/js/markdown-worker.js 解析，那条路径
 * 直接 marked.parse() —— 没有任何自定义配置。后果是长文里这些能力全部静默失效：
 *   · ==高亮== 行内扩展
 *   · renderer.image 的图片 URL 重写（/api/*-image → /images/a|t|g）、figure 图注、
 *     loading="lazy"、灯箱 onclick
 *   · renderer.code 的 .code-block 包裹（复制按钮、语言标签）
 *     且 article-app.js 的内嵌白板依赖 `.code-block code.language-excalidraw`，
 *     少了这层包裹 → 长文里的内嵌白板会显示成一段代码。
 *
 * 因此把配置抽到本文件，由两边共同加载（浏览器 <script> / Worker importScripts）。
 *
 * 环境兼容：Worker 里没有 localStorage，renderer.image 的图库密钥注入会静默跳过。
 * 这不影响正确性 —— /images/g/ 与 /images/t/ 的访客访问本就由后端按密钥判定。
 *
 * 注意：本文件被 Worker 用 importScripts 加载，不能使用 ESM 语法。
 */
(function (root) {
    'use strict';

    // 读取图库管理密钥（浏览器 localStorage；Worker 中恒为空串）
    function readAdminKey() {
        try {
            if (typeof localStorage === 'undefined') return '';
            return localStorage.getItem('admin_key') || '';
        } catch (e) {
            return '';
        }
    }

    // 内联 SVG 兜底：图片加载失败时不再显示裂图
    var IMG_FALLBACK = "this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22100%22%3E%3Crect fill=%22%23222%22 width=%22200%22 height=%22100%22/%3E%3Ctext fill=%22%23666%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2214%22%3E图片加载失败%3C/text%3E%3C/svg%3E'";

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * 把自定义配置应用到传入的 marked 实例上。
     * 每次解析调用一次即可（幂等：重复调用只是重复设置同样的选项）。
     */
    function apply(marked) {
        if (!marked) return null;

        marked.setOptions({ breaks: true, gfm: true });

        // 行内高亮扩展：==文字==
        marked.use({
            extensions: [{
                name: 'highlight',
                level: 'inline',
                start: function (src) { return src.indexOf('=='); },
                tokenizer: function (src) {
                    var match = src.match(/^==(.+?)==/);
                    if (match) {
                        return { type: 'highlight', raw: match[0], text: match[1] };
                    }
                },
                renderer: function (token) {
                    return '<mark>' + token.text + '</mark>';
                }
            }]
        });

        var renderer = new marked.Renderer();

        // 图片：URL 重写 + figure 图注 + 懒加载 + 点击灯箱
        renderer.image = function (token) {
            var href = token.href;
            var title = token.title;
            var text = token.text;

            var titleAttr = title ? ' title="' + title + '"' : '';
            var altText = text || '';
            var captionHtml = altText ? '<figcaption class="img-caption">' + altText + '</figcaption>' : '';

            // 旧动态接口 URL → 缓存友好 URL（.webp 结尾，CDN 可缓存）
            var src = href;
            if (src.startsWith('/api/article-image?key=')) {
                src = '/images/a/' + src.slice('/api/article-image?key='.length).split('&')[0];
            } else if (src.startsWith('/api/admin-image?key=')) {
                var isThumb = src.includes('&thumb=1');
                var key = src.slice('/api/admin-image?key='.length).split('&')[0];
                src = (isThumb ? '/images/t/' : '/images/g/') + key;
            } else if (src.startsWith('/images/g-thumb/')) {
                src = '/images/t/' + src.slice('/images/g-thumb/'.length);
            }

            // 图库图片（可能归类 R18）：管理员浏览时附加密钥参数才能加载
            if (src.startsWith('/images/g/') || src.startsWith('/images/t/')) {
                var ak = readAdminKey();
                if (ak) src += (src.includes('?') ? '&' : '?') + 'adminKey=' + encodeURIComponent(ak);
            }

            return '<figure class="img-figure"><img src="' + src + '" alt="' + altText + '"' + titleAttr +
                ' loading="lazy" decoding="async" onerror="' + IMG_FALLBACK +
                '" onclick="openLightbox(this)" style="cursor:zoom-in">' + captionHtml + '</figure>';
        };

        // 代码块：.code-block 包裹 + 语言标签 + 复制按钮
        // 内嵌白板依赖这层包裹（article-app.js 用 .code-block code.language-excalidraw 匹配）
        renderer.code = function (token) {
            var language = token.lang || '';
            var escapedCode = escapeHtml(token.text);
            return '<div class="code-block">\n' +
                '                    <div class="code-header">\n' +
                '                        <span class="code-lang">' + language + '</span>\n' +
                '                        <button class="copy-btn" onclick="copyCode(this)" title="复制代码">\n' +
                '                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>\n' +
                '                            <span>复制</span>\n' +
                '                        </button>\n' +
                '                    </div>\n' +
                '                    <pre><code class="language-' + language + '">' + escapedCode + '</code></pre>\n' +
                '                </div>';
        };

        return renderer;
    }

    root.MarkdownConfig = { apply: apply, escapeHtml: escapeHtml };
})(typeof self !== 'undefined' ? self : this);
