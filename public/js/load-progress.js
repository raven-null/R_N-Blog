/**
 * 首屏加载遮罩（v2.1.0）
 * 遮罩的节点和内联样式都写在 index.html 里（body 第一个元素 + head 内联 style），
 * 所以它是页面上第一个画出来的东西，不会先露出半成品再「补一层遮罩」。
 * 这里只负责：接管已有的 #loadVeil → 按首屏图片的真实加载数推进 → 收尾移除。
 *
 *   0%    遮罩已经在了（HTML 里就带）
 *   0~92% 首屏（视口 + 下方 40%）的图片一张张到；加载失败的也算完成，不卡进度
 *   100%  补满 → 淡出 → 自移除，解除滚动锁定
 * 兜底 9 秒；首屏图少于 5 张（缓存命中 / 短文页）不遮，直接拿掉。
 */
(function () {
    'use strict';

    var MIN_IMAGES = 5;
    var TIMEOUT_MS = 12000;
    var WAIT_FOR_IMAGES_MS = 3000;

    var veil = document.getElementById('loadVeil');
    var created = false;

    // 兜底：万一 HTML 里没有（别的页面复用这个脚本），自己造一个
    if (!veil) {
        veil = document.createElement('div');
        veil.className = 'load-veil';
        veil.id = 'loadVeil';
        veil.innerHTML = '<div class="load-veil-inner"><div class="load-veil-bar"><span></span></div><div class="load-veil-pct">0%</div></div>';
        (document.body || document.documentElement).appendChild(veil);
        created = true;
    }

    var fill = veil.querySelector('.load-veil-bar > span'); // 进度条已换成 spinner，这里可能为 null（只更新数字）
    var pctLabel = veil.querySelector('.load-veil-pct');
    // 告诉 CSS：JS 接管了，把「10 秒后自动消失」那套兜底动画关掉
    veil.classList.add('is-js');
    var finished = false;
    var timer = null;
    var timeout = null;
    var startedAt = Date.now();
    var prevOverflow = null;
    // 首页的「今日简报」是异步接口，出得比图片晚：它没到位就别揭开遮罩，
    // 否则会先露出一个空白的简报区（app.js 在请求结束时会打 body.news-ready / 派事件）
    var needsNews = !!document.getElementById('hv3News');
    var newsReady = !needsNews;

    // 减少动效偏好：直接撤掉遮罩
    try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            remove();
            return;
        }
    } catch (e) { }

    function lockScroll() {
        if (prevOverflow !== null) return;
        try {
            prevOverflow = document.documentElement.style.overflow;
            document.documentElement.style.overflow = 'hidden';
        } catch (e) { prevOverflow = ''; }
    }

    function unlockScroll() {
        if (prevOverflow === null) return;
        try { document.documentElement.style.overflow = prevOverflow; } catch (e) { }
        prevOverflow = null;
    }

    lockScroll();

    var lastPct = 8;   // HTML 里条子起步就是 8%，别让 JS 把它缩回去

    function snapTo(v) {
        var pct = Math.max(0, Math.min(100, v));
        // 只增不减：首屏图片会陆续被渲染出来，分母一变大会让进度往回缩，观感就成了「倒退」
        if (pct < lastPct) pct = lastPct;
        lastPct = pct;
        if (fill) fill.style.width = pct + '%';
        if (pctLabel) pctLabel.textContent = Math.round(pct) + '%';
    }

    function remove() {
        unlockScroll();
        if (veil.parentNode) veil.parentNode.removeChild(veil);
    }

    function finish() {
        if (finished) return;
        finished = true;
        if (timer) { clearInterval(timer); timer = null; }
        if (timeout) { clearTimeout(timeout); timeout = null; }
        snapTo(100);
        veil.classList.add('is-done');
        unlockScroll();
        setTimeout(remove, 460);
    }

    // 遮罩不是「加载完才出现」，而是「一开始就在」；图不够多时直接快速撤掉，不锁人
    function dropIfFewImages() {
        if (finished) return;
        finished = true;
        if (timer) { clearInterval(timer); timer = null; }
        if (timeout) { clearTimeout(timeout); timeout = null; }
        veil.classList.add('is-done');
        unlockScroll();
        setTimeout(remove, 260);
    }

    // 首屏范围内的图片（视口外的懒加载不算，否则分母永远补不满）
    function aboveFoldImgs() {
        var list = [].slice.call(document.querySelectorAll('img'));
        var vh = window.innerHeight || 800;
        return list.filter(function (im) {
            if (!im.getAttribute('src') && !im.getAttribute('srcset')) return false;
            var r = im.getBoundingClientRect();
            if (!r.width && !r.height) return false;
            return r.top < vh * 1.4 && r.bottom > -200;
        });
    }

    function tick() {
        if (finished) return;
        if (!newsReady && document.body && document.body.classList.contains('news-ready')) newsReady = true;

        var imgs = aboveFoldImgs();

        if (imgs.length < MIN_IMAGES) {
            // 图片是 JS 渲染出来的：给 3 秒等它们出现，真没图才撤遮罩
            if (Date.now() - startedAt > WAIT_FOR_IMAGES_MS && newsReady) dropIfFewImages();
            return;
        }

        var done = 0;
        for (var i = 0; i < imgs.length; i++) {
            if (imgs[i].complete) done++;
        }
        // 图片推进到 92%；简报还没到就再压一截，进度条不会先满
        var ratio = done / imgs.length;
        snapTo(92 * (newsReady ? ratio : ratio * 0.94));

        if (done >= imgs.length) {
            if (newsReady) { finish(); return; }
            // 图片都到齐了、就差简报：让条子在这段等待里继续慢慢往前蹭，别停住像卡死
            snapTo(Math.min(90, lastPct + 0.35));
        }
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

    // 简报一到就立刻再看一眼，不用等下一次轮询
    document.addEventListener('blog:news-ready', function () {
        newsReady = true;
        tick();
    }, { once: true });
})();
