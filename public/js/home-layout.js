/**
 * 主页宽度（v1.0.0）
 * 后台「主页布局」里那条滑块把值存进 settings.layout.homeWidthPct（内容占视口宽度的百分比），
 * 这里读出来贴到 CSS 变量 --home-content-w 上，renewal.css 的 .main-content / .top-bar-inner 直接用它。
 * 先用 localStorage 里的上次值顶上，避免首屏先按默认宽度画一遍再跳。
 */
(function () {
    'use strict';

    var DEFAULT_PCT = 86;
    var KEY = 'home-content-w';
    var MIN = 40;
    var MAX = 100;

    function clampPct(v) {
        var n = Number(v);
        if (!Number.isFinite(n) || n < MIN || n > MAX) return DEFAULT_PCT;
        return Math.round(n);
    }

    function apply(pct) {
        document.documentElement.style.setProperty('--home-content-w', pct + '%');
        document.documentElement.dataset.homeWidth = String(pct);
    }

    try {
        var cached = localStorage.getItem(KEY);
        if (cached) apply(clampPct(cached));
    } catch (e) { /* 隐私模式下读不到就算了 */ }

    fetch('/api/admin?action=settings', { cache: 'no-store', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            var layout = d && d.data && d.data.layout;
            var pct = clampPct(layout ? layout.homeWidthPct : null);
            apply(pct);
            try { localStorage.setItem(KEY, String(pct)); } catch (e) { }
        })
        .catch(function () { /* 拿不到就保持默认/缓存值 */ });
})();
