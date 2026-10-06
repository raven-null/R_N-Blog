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

    // 画布 id 清洗：允许字母数字、下划线、短横线、点与中文
    var ID_ALLOWED = /[^A-Za-z0-9_.\u4e00-\u9fa5-]/g;

    /**
     * 解析内嵌块语法。
     *   ```embed board:wb-abc123
     *   ```embed map:mm-xyz789 :h=520 :caption="登录流程"
     *
     * 也兼容历史写法（lang 直接是画布 id，无 kind 前缀）——由调用方区分。
     * 返回 null 表示不是内嵌块。
     */
    function parseEmbed(raw) {
        var text = String(raw || '').replace(/\r/g, '').trim();
        var m = text.match(/^(board|map)\s*:\s*([^\s:]+)([\s\S]*)$/);
        if (!m) return null;
        var kind = m[1];
        var id = String(m[2] || '').replace(ID_ALLOWED, '').slice(0, 64);
        if (!id) return null;
        var rest = m[3] || '';
        var conf = { kind: kind, id: id, height: 0, caption: '', title: '' };
        var h = rest.match(/:h=(\d{2,4})/);
        if (h) {
            var n = parseInt(h[1], 10);
            if (n >= 120 && n <= 2000) conf.height = n;
        }
        var cap = rest.match(/:caption="([^"]*)"/);
        if (cap) conf.caption = cap[1];
        var ttl = rest.match(/:title="([^"]*)"/);
        if (ttl) conf.title = ttl[1];
        return conf;
    }

    /**
     * 生成内嵌块容器。kind 与 id 已清洗，这里仍做属性转义（caption/title 来自用户输入）。
     * 真实挂载由 article-app.js 的 mountEmbeds() 负责（解析层只产出占位）。
     */
    function renderEmbedBlock(conf) {
        if (!conf) return '';
        var attrs = 'class="embed-block" data-embed="' + conf.kind + ':' + conf.id + '"' +
            ' data-kind="' + conf.kind + '" data-id="' + escapeHtml(conf.id) + '"';
        if (conf.height) attrs += ' data-h="' + conf.height + '"';
        if (conf.title) attrs += ' data-title="' + escapeHtml(conf.title) + '"';
        var label = conf.kind === 'map' ? '思维导图' : '白板';
        var caption = conf.caption
            ? '<figcaption class="embed-caption">' + escapeHtml(conf.caption) + '</figcaption>'
            : '';
        return '<figure class="embed-figure">' +
            '<div ' + attrs + '><div class="embed-loading">' + label + '加载中…</div></div>' +
            caption +
            '</figure>';
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
            var text = token.text;

            // 本项目的 marked 版本把 fenced code 的 info string **整行**塞进 lang
            // （其内部规则为 t[2] = [^\n]*，默认 renderer 还用 notSpaceStart 只取第一个词）。
            // 因此 ```embed board:xxx :h=520 里，id 与参数都在 lang 中，text 是空的。
            // 这里按第一个空格切分：首词是语言，其余是内嵌块声明。
            var sp = language.search(/\s/);
            var langWord = sp < 0 ? language : language.slice(0, sp);
            var langRest = sp < 0 ? '' : language.slice(sp + 1).trim();

            // 内嵌画布块：```embed board:xxx / ```embed map:xxx
            // 只产出占位容器，真实挂载交给主线程的 mountEmbeds()——两个解析管线因此行为一致。
            if (langWord === 'embed') {
                var conf = parseEmbed(langRest || text);
                if (conf) return renderEmbedBlock(conf);
                return '<figure class="embed-figure"><div class="embed-block embed-error">' +
                    '内嵌块语法无效：' + escapeHtml((langRest || text).trim().slice(0, 80)) +
                    '<br>正确写法：```embed board:画布ID 或 ```embed map:导图ID</div></figure>';
            }

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
        parseEmbed: parseEmbed,
        renderEmbedBlock: renderEmbedBlock
    };
})(typeof self !== 'undefined' ? self : this);
