/**
 * Markdown 解析 Web Worker
 * 将 marked.parse() 移至后台线程，避免阻塞主线程
 *
 * 注意：自定义配置（==高亮==、图片 URL 重写/图注/灯箱、.code-block 包裹）必须与
 * 主线程共用 public/js/markdown-config.js。此前这里只 importScripts 了 marked，
 * 导致长文（content.length >= 5000）里所有自定义 renderer 静默失效 ——
 * 其中最严重的是内嵌白板：article-app.js 依赖 `.code-block code.language-excalidraw`，
 * 缺少 .code-block 包裹时长文里的内嵌白板会退化成一段代码块。
 */
importScripts('vendor/marked.min.js');
importScripts('markdown-config.js');

self.onmessage = function (e) {
    const { content, id } = e.data;
    try {
        const renderer = self.MarkdownConfig && self.MarkdownConfig.apply
            ? self.MarkdownConfig.apply(marked)
            : null;
        const html = marked.parse(content, { breaks: true, gfm: true, renderer });
        self.postMessage({ id, html });
    } catch (err) {
        // 解析失败时回传错误，主线程 markdown.js 会回退到主线程解析
        self.postMessage({ id, error: err.message });
    }
};
