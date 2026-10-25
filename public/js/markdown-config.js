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
 *     （v3.35.0 起正文不再内嵌画布，这一层只服务普通代码块）
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

    // 注：v3.35.0 起正文不再有「内嵌画布」写法（白板 / 导图改成文章关联），
    // 原 parseEmbed / renderEmbedBlock 与 ```embed 渲染分支一并移除。

    /**
     * 标题锚点 slug（v3.38.0）。
     * 目标：**手写的页内链接不会因为改稿而失效**。
     * 之前的标题 id 是渲染后按顺序生成的 `heading-0/1/2`，前面插一个标题，后面全部错位；
     * 现在按标题文字生成：`## 为什么要注意开销` → `id="为什么要注意开销"`。
     * 规则：小写 → 去掉 Markdown 标记 → 空白变 `-` → 只留字母数字下划线中文与 `-`。
     * 重复标题由渲染器追加 -2 / -3（编辑器插入链接时用同一套逻辑算，保证一致）。
     */
    function slugify(text) {
        var s = String(text == null ? '' : text).trim().toLowerCase();
        s = s.replace(/[`*_~\[\]()#>!]/g, '');                 // 常见 Markdown 标记
        s = s.replace(/[\s\u3000]+/g, '-');                     // 空白 → -
        s = s.replace(/[^\w\u4e00-\u9fa5\-.]+/g, '');           // 只留字母数字下划线中文点与 -
        s = s.replace(/\.+/g, '.').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
        return s || 'section';
    }

    /**
     * 把自定义配置应用到传入的 marked 实例上。
     * 每次解析调用一次即可（幂等：重复调用只是重复设置同样的选项；
     * 标题去重计数在每次调用时重置，所以同一次解析内是确定的）。
     */
    function apply(marked) {
        if (!marked) return null;

        marked.setOptions({ breaks: true, gfm: true });

        // 行内高亮扩展（v1.5.0：支持颜色）
        //   ==文字==           → <mark class="hl hl-yellow">文字</mark>
        //   =={red}文字==      → <mark class="hl hl-red">文字</mark>
        // 颜色白名单外的写法（含 {xxx} 不是已知颜色）当作普通文字，不吞内容。
        var HL_COLORS = ['yellow', 'orange', 'red', 'green', 'blue', 'purple', 'gray'];
        marked.use({
            extensions: [{
                name: 'highlight',
                level: 'inline',
                start: function (src) { return src.indexOf('=='); },
                tokenizer: function (src) {
                    var match = src.match(/^==(?:\{(?:([a-z]+))\})?([\s\S]+?)==/);
                    if (!match) return;
                    var color = match[1] || 'yellow';
                    if (HL_COLORS.indexOf(color) < 0) return;   // 未知颜色：按普通文字处理
                    return { type: 'highlight', raw: match[0], text: match[2], color: color };
                },
                renderer: function (token) {
                    var color = HL_COLORS.indexOf(token.color) >= 0 ? token.color : 'yellow';
                    return '<mark class="hl hl-' + color + '">' + escapeHtml(String(token.text || '')) + '</mark>';
                }
            }]
        });

        var renderer = new marked.Renderer();

        // 标题：给稳定 id（按标题文字生成），手写的 `[见第 2 节](#为什么要注意开销)` 才不会因改稿失效。
        // marked 15 是 token 风格，内联内容要自己 parseInline，否则 `**粗体**` 会原样输出。
        var headingSlugCount = Object.create(null);
        renderer.heading = function (token) {
            var depth = token && token.depth ? token.depth : 2;
            var inner = (token && token.tokens && this.parser && typeof this.parser.parseInline === 'function')
                ? this.parser.parseInline(token.tokens)
                : escapeHtml(String((token && token.text) || ''));
            var plain = String((token && token.text) || '').replace(/[`*_~\[\]()#>!]/g, '');
            var base = slugify(plain);
            var n = (headingSlugCount[base] || 0) + 1;
            headingSlugCount[base] = n;
            var id = n === 1 ? base : base + '-' + n;
            return '<h' + depth + ' id="' + escapeHtml(id) + '">' + inner + '</h' + depth + '>';
        };

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
        // 注：v3.35.0 起正文不再有「内嵌画布」写法（白板 / 导图改成文章关联），
        // 所以这里不再有 ```embed 的特殊分支 —— 任何代码块（含历史遗留的 ```embed）都按普通代码块渲染。
        renderer.code = function (token) {
            var language = token.lang || '';
            var text = token.text;

            // 本项目的 marked 版本把 fenced code 的 info string **整行**塞进 lang
            // （其内部规则为 t[2] = [^\n]*，默认 renderer 还用 notSpaceStart 只取第一个词）。
            // 这里按第一个空格切分，语言标签只取首词。
            var sp = language.search(/\s/);
            var langWord = sp < 0 ? language : language.slice(0, sp);

            var escapedCode = escapeHtml(text);
            return '<div class="code-block">\n' +
                '                    <div class="code-header">\n' +
                '                        <span class="code-lang">' + langWord + '</span>\n' +
                '                        <button class="copy-btn" onclick="copyCode(this)" title="复制代码">\n' +
                '                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>\n' +
                '                            <span>复制</span>\n' +
                '                        </button>\n' +
                '                    </div>\n' +
                '                    <pre><code class="language-' + escapeHtml(langWord) + '">' + escapedCode + '</code></pre>\n' +
                '                </div>';
        };

        return renderer;
    }

    root.MarkdownConfig = {
        apply: apply,
        escapeHtml: escapeHtml,
        slugify: slugify
    };
})(typeof self !== 'undefined' ? self : this);
