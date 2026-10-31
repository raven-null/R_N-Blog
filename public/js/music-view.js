/**
 * 音乐视图：首页第 5 个视图，内嵌 Folia 播放器（https://music.ravennull.work/）。
 *
 * 与 app.js 的分工：
 *   - app.js 负责 #view-music 的显示/隐藏与顶栏滑块，切进来时调 MusicView.onShow()
 *   - 这里只负责 iframe 本身：预加载、遮罩、探活、失败兜底、小屏降级
 *
 * 几条约束都是实测踩出来的，改之前先看这里：
 *   1. iframe 初始 src 必须是 about:blank —— 留空会被解析成本页地址，导致无限递归加载。
 *   2. 不能加 sandbox —— Folia 用 localStorage 存登录态与播放设置，sandbox 会让它初始化即报错。
 *   3. 遮罩不能等 iframe 的 load —— Folia 冷启动 load 要 20s+，一直盖着等于让用户盯转圈；
 *      所以 6 秒后主动让位给 Folia 自己的启动动画，探活成功时更早让位。
 *   4. 别对慢加载喊失败 —— 探活通了就取消「加载失败」计时。
 */
(function () {
  'use strict';

  var FOLIA_ORIGIN = 'https://music.ravennull.work';
  var MOBILE_MAX = 768;            // 与博客移动端断点对齐（renewal.css 里 760，这里放宽一点）
  var FORCE_INLINE_KEY = 'music-inline-mobile';
  var BOOT_TIMEOUT = 20000;        // 这么久还没动静才判定失败
  var BOOT_MAX_COVER = 6000;       // 自家遮罩最多盖这么久，之后让位

  var frame = document.getElementById('musicFrame');
  var booting = document.getElementById('musicBooting');
  var notice = document.getElementById('musicNotice');
  if (!frame || !booting || !notice) return;

  var loaded = false;
  var bootTimer = 0;
  var coverTimer = 0;

  function forcedInline() {
    try { return localStorage.getItem(FORCE_INLINE_KEY) === '1'; } catch (e) { return false; }
  }

  // 小屏默认不内嵌；点过「还是在这个页面里听」就记住
  function wantsInline() {
    return window.innerWidth > MOBILE_MAX || forcedInline();
  }

  function showNotice() { notice.classList.add('show'); }
  function hideNotice() { notice.classList.remove('show'); }

  // 遮罩淡出：让位给 Folia 自己的启动画面
  function elideBooting() {
    clearTimeout(coverTimer);
    booting.classList.add('hidden');
  }

  // 轻量探活：no-cors 只要网络可达就 resolve（opaque 响应），用来区分「只是慢」和「根本连不上」
  function probe() {
    try {
      fetch(FOLIA_ORIGIN + '/?probe=' + Date.now(), { mode: 'no-cors', cache: 'no-store' })
        .then(function () {
          clearTimeout(bootTimer);          // 网络通，别再误报加载失败
          setTimeout(elideBooting, 800);    // 留一点渲染时间再让位
        })
        .catch(function () { /* 失败不处理：load 事件和超时会兜住 */ });
    } catch (e) { /* 老引擎没有 fetch，忽略 */ }
  }

  function mount() {
    if (loaded) return;
    loaded = true;
    hideNotice();
    booting.classList.remove('hidden');
    frame.src = FOLIA_ORIGIN + '/';
    coverTimer = setTimeout(elideBooting, BOOT_MAX_COVER);
    clearTimeout(bootTimer);
    bootTimer = setTimeout(showNotice, BOOT_TIMEOUT);
    probe();
  }

  // 跨域 iframe 的 onload 只能证明「文档到货了」；内容对不对它不报错。
  // about:blank 占位页也会触发 load，必须排除，否则遮罩会提前消失。
  frame.addEventListener('load', function () {
    if (!loaded) return;
    if (String(frame.src).indexOf(FOLIA_ORIGIN) !== 0) return;
    clearTimeout(bootTimer);
    elideBooting();
    hideNotice();
  });

  // 视图从 display:none 切回来时 iframe 需要重新对齐滚动区高度
  function syncHeight() {
    var scroller = document.getElementById('scrollArea');
    if (!scroller) return;
    var h = scroller.clientHeight;
    if (h > 0) frame.style.height = h + 'px';
  }

  function syncLayout() {
    var inline = wantsInline();
    document.body.classList.toggle('music-degraded', !inline);
    if (inline) mount();
    syncHeight();
  }

  var btnInline = document.getElementById('musicInlineBtn');
  if (btnInline) {
    btnInline.addEventListener('click', function () {
      try { localStorage.setItem(FORCE_INLINE_KEY, '1'); } catch (e) { /* 隐私模式 */ }
      syncLayout();
    });
  }

  var btnRetry = document.getElementById('musicRetryBtn');
  if (btnRetry) {
    btnRetry.addEventListener('click', function () {
      hideNotice();
      booting.classList.remove('hidden');
      // 时间戳绕过中间缓存，也保证 iframe 一定会重新导航
      frame.src = FOLIA_ORIGIN + '/?_t=' + Date.now();
      clearTimeout(coverTimer);
      coverTimer = setTimeout(elideBooting, BOOT_MAX_COVER);
      clearTimeout(bootTimer);
      bootTimer = setTimeout(showNotice, BOOT_TIMEOUT);
      probe();
    });
  }

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      syncHeight();
      // 断点可能变了；已强制内嵌的用户不回退到降级卡片
      if (!forcedInline()) syncLayout();
    }, 150);
  }, { passive: true });

  // ---------- 对外接口 ----------
  window.MusicView = {
    // app.js 每次切到音乐视图时调用
    onShow: function () {
      syncLayout();
      syncHeight();
    }
  };

  // ---------- 预加载 ----------
  // 用户希望首页就预加载：挂在 load 之后，不拖慢首屏；手机上不预加载（本来也不显示 iframe）。
  function boot() { syncLayout(); }
  if (document.readyState === 'complete') setTimeout(boot, 0);
  else window.addEventListener('load', function () { setTimeout(boot, 0); });
  // 兜底：load 万一被阻塞，2.5s 后也把布局算出来（此时仍按 display:none 量不到高度，onShow 会再算）
  setTimeout(boot, 2500);
})();
