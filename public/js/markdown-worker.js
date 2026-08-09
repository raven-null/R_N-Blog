/**
 * Markdown 解析 Web Worker
 * 将 marked.parse() 移至后台线程，避免阻塞主线程
 */
importScripts('vendor/marked.min.js');

self.onmessage = function(e) {
    const { content, id } = e.data;
    try {
        const html = marked.parse(content, { breaks: true, gfm: true });
        self.postMessage({ id, html });
    } catch (err) {
        self.postMessage({ id, error: err.message });
    }
};
