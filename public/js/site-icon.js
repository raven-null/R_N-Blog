/**
 * 全站统一网站图标（favicon / apple-touch-icon）
 * 五个页面（index / article / admin / admin-edit / excalidraw）共用这一份逻辑：
 *   - 默认图标：/images/Default/web-logo.webp
 *   - 后台「博客设置 → 网站图标」填了自定义图标时，全站统一跟随
 * 页面 head 里只需声明 link，再引入本脚本即可，不要在页面内重复写 favicon 逻辑。
 */
(function () {
    'use strict';

    var DEFAULT_ICON = '/images/Default/web-logo.webp';

    function applyIcon(url) {
        if (!url) return;
        var links = document.querySelectorAll('link[rel="icon"],link[rel="apple-touch-icon"],link[rel="shortcut icon"]');
        for (var i = 0; i < links.length; i++) links[i].setAttribute('href', url);
    }

    // 兜底：页面若漏写 link 声明，这里补上默认图标，保证不会出现浏览器默认图标
    if (!document.querySelector('link[rel="icon"]')) {
        var link = document.createElement('link');
        link.rel = 'icon';
        link.type = 'image/webp';
        link.href = DEFAULT_ICON;
        document.head.appendChild(link);
    }

    fetch('/api/admin?action=settings', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (d && d.status === 'success' && d.data && d.data.favicon) {
                applyIcon(d.data.favicon);
            }
        })
        .catch(function () { /* 设置读取失败时保持默认图标 */ });
})();
