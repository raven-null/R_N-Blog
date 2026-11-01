/**
 * 首屏加载遮罩（v2.0.0）
 * 首访图片多（100+ 张，且都要过 /api/*-image 函数），体感就是「白屏卡住」。
 * 这里盖一层遮罩，进度**真实跟着首屏图片的加载数走**（不是假动画）：
 *   0%    遮罩出现
 *   0~92% 首屏（视口 + 下方 40%）的图片一张张到：已 load 的 / 已失败的都算完成
 *   100%  全部完成后补满、淡出、解除滚动锁定
 * 兜底 9 秒：有图一直不回来也不会把人锁在遮罩里。
 * 首屏图少于 5 张（多半是缓存命中）时不显示遮罩，避免每次刷新都黑一下。
 */
(function () {
    'use strict';

    try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    } catch (e) { }

    var MIN_IMAGES = 5;
    var TIMEOUT_MS = 9000;

    var veil = document.createElement('div');
    veil.className = 'load-veil';
    veil.setAttribute('role', 'status');
    veil.setAttribute('aria-live', 'polite');
    veil.innerHTML = '<div class="load-veil-inner">' +
        '<div class="load-veil-bar"><span></span></div>' +
        '<div class="load-veil-pct">0%</div>' +
        '</div>';

    var fill = null;
    var pctLabel = null;
    var shown = false;
    var finished = false;
    var timer = null;
    var timeout = null;
    var countdown = 0;
    var prevOverflow = '';
    var startedAt = Date.now();

    function mount() {
        if (veil.parentNode) return;
        (document.body || document.documentElement).appendChild(veil);
        fill = veil.querySelector('.load-veil-bar > span');
        pctLabel = veil.querySelector('.load-veil-pct');
    }

    function show() {
        if (shown || finished) return;
        mount();
        shown = true;
        try {
            prevOverflow = document.documentElement.style.overflow;
            document.documentElement.style.overflow = 'hidden';
        } catch (e) { }
        veil.classList.add('is-visible');
    }

    function snapTo(v) {
        var pct = Math.max(0, Math.min(100, v));
        if (fill) fill.style.width = pct + '%';
        if (pctLabel) pctLabel.textContent = Math.round(pct) + '%';
    }

    function finish() {
        if (finished) return;
        finished = true;
        if (timer) { clearInterval(timer); timer = null; }
        if (timeout) { clearTimeout(timeout); timeout = null; }
        if (!shown) return;          // 一开始就没显示，直接收工
        snapTo(100);
        veil.classList.add('is-done');
        try { document.documentElement.style.overflow = prevOverflow; } catch (e) { }
        setTimeout(function () {
            if (veil.parentNode) veil.parentNode.removeChild(veil);
        }, 520);
    }

    // 首屏范围内的图片（懒加载的那些视口外的不算，否则分母永远补不满）
    function aboveFoldImgs() {
        var list = [].slice.call(document.querySelectorAll('img'));
        var vh = window.innerHeight || 800;
        return list.filter(function (im) {
            if (!im.getAttribute('src') && !im.getAttribute('srcset')) return false;
            var r = im.getBoundingClientRect();
            if (!r.width && !r.height) return false;   // 还没上屏
            return r.top < vh * 1.4 && r.bottom > -200;
        });
    }

    function tick() {
        if (finished) return;
        var imgs = aboveFoldImgs();
        if (!shown) {
            // 图片是 JS 渲染出来的，DOMContentLoaded 那会儿往往还是 0 张：
            // 给 3 秒窗口等它们出现，真的没图（缓存命中 / 短文页）才放弃遮罩
            if (imgs.length < MIN_IMAGES) {
                if (Date.now() - startedAt > 3000) finish();
                return;
            }
            show();
        }
        if (!imgs.length) { snapTo(94); return; }

        var done = 0;
        for (var i = 0; i < imgs.length; i++) {
            // error 之后 complete 也是 true，算它完成，别让它卡住进度
            if (imgs[i].complete) done++;
        }
        // 留 8% 给「最后的收尾」，避免停在 100% 却还没揭开
        snapTo(92 * (done / imgs.length));

        // 首屏这一批到齐就算完事，不等页面里其他懒加载图片
        if (done >= imgs.length) finish();
    }

    function start() {
        tick();
        timer = setInterval(tick, 160);
        timeout = setTimeout(finish, TIMEOUT_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }

    window.addEventListener('load', function () { tick(); }, { once: true });
})();
