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
    var TIMEOUT_MS = 9000;
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

    var fill = veil.querySelector('.load-veil-bar > span');
    var pctLabel = veil.querySelector('.load-veil-pct');
    // 告诉 CSS：JS 接管了，把「10 秒后自动消失」那套兜底动画关掉
    veil.classList.add('is-js');
    var finished = false;
    var timer = null;
    var timeout = null;
    var startedAt = Date.now();
    var prevOverflow = null;

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

    function snapTo(v) {
        var pct = Math.max(0, Math.min(100, v));
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
        var imgs = aboveFoldImgs();

        if (imgs.length < MIN_IMAGES) {
            // 图片是 JS 渲染出来的：给 3 秒等它们出现，真没图才撤遮罩
            if (Date.now() - startedAt > WAIT_FOR_IMAGES_MS) dropIfFewImages();
            return;
        }

        var done = 0;
        for (var i = 0; i < imgs.length; i++) {
            if (imgs[i].complete) done++;
        }
        snapTo(92 * (done / imgs.length));

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
