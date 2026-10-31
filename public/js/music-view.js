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

  // ---------- 顶栏自动隐藏 ----------
  // 音乐视图里顶栏是浮层（.top-bar 设了 pointer-events: none），不会自己响应 hover。
  // 麻烦的是指针进 iframe 之后，父文档收不到 mousemove，元素的 :hover 也不会更新
  // （实测 pill.matches(':hover') 会一直停在 true），所以这里一律用「最近有没有真的动过」来判断：
  //   动过（热区/pill 上的 mouseenter、mousemove、click）→ 展开并刷新时间戳
  //   HIDE_DELAY 内没再动过 → 收起
  var HOT_ZONE = 90;
  var HIDE_DELAY = 2000;
  var pill = document.getElementById('topBarPill');
  var barTimer = 0;
  var lastTouch = 0;

  function inMusicView() {
    return document.body.classList.contains('view-music-active');
  }

  function showBar() {
    if (!pill) return;
    clearTimeout(barTimer);
    pill.classList.add('is-open');
    barTimer = setTimeout(hideBar, HIDE_DELAY);
  }

  // 任何真实交互都算「还在用导航」
  function touchBar() {
    lastTouch = Date.now();
    showBar();
  }

  function hideBar() {
    if (!pill || !inMusicView()) return;
    if (Date.now() - lastTouch < HIDE_DELAY) {
      barTimer = setTimeout(hideBar, HIDE_DELAY);
      return;
    }
    pill.classList.remove('is-open');
  }

  document.addEventListener('mousemove', function (e) {
    if (!inMusicView()) return;
    // 只在顶部一带唤出（页面大部分被 iframe 盖着，这里基本只在降级卡片/空态时才走到）
    if (e.clientY <= HOT_ZONE) touchBar();
  }, { passive: true });

  // 顶部透明热区：iframe 吞掉 mousemove 时，靠它把导航唤出来
  var hotzone = document.getElementById('musicHotzone');
  if (hotzone) {
    hotzone.addEventListener('mouseenter', function () {
      if (inMusicView()) touchBar();
    });
    hotzone.addEventListener('mousemove', function () {
      if (inMusicView()) touchBar();
    });
  }
  // 指针停在胶囊上操作时持续续命；离开后 lastTouch 不再更新，HIDE_DELAY 后自动收起
  if (pill) {
    ['mouseenter', 'mousemove', 'click'].forEach(function (type) {
      pill.addEventListener(type, function () {
        if (inMusicView()) touchBar();
      }, { passive: true });
    });
  }

  // 触屏没有 mousemove：保持 bundle.css 的「触屏常显」行为，这里不做拦截

  // ---------- 灵动岛：接收 Folia 推来的播放状态 ----------
  // iframe 里是另一个源，父页面读不到它的 DOM。Folia 侧在检测到自己被嵌入时，
  // 会用 postMessage 推出 { type: 'folia:now-playing', song, lyric, playing, loading }
  // （见那边的 src/hooks/useParentFrameBroadcast.ts）。
  // 这里校验 event.origin，别让任何页面都能往这颗岛上写字。
  var FOLIA_ORIGIN_PATTERN = /^https:\/\/music\.ravennull\.work$/;
  var island = document.getElementById('nowIsland');
  var islandCover = document.getElementById('nowIslandCover');
  var islandTitle = document.getElementById('nowIslandTitle');
  var islandLyric = document.getElementById('nowIslandLyric');
  var lastLyricText = null;
  var lastCover = null;
  var lyricSwapTimer = 0;

  // 换句先淡出再换字，避免文字硬闪
  function setIslandLyric(text) {
    if (!islandLyric || text === lastLyricText) return;
    lastLyricText = text;
    clearTimeout(lyricSwapTimer);
    islandLyric.classList.add('is-flipping');
    lyricSwapTimer = setTimeout(function () {
      islandLyric.textContent = text;
      islandLyric.classList.remove('is-flipping');
    }, 140);
  }

  function applyNowPlaying(data) {
    if (!island) return;
    var song = data.song;
    if (!song) {
      island.classList.remove('show');
      return;
    }

    island.classList.add('show');
    island.classList.toggle('paused', !data.playing && !data.loading);

    var title = song.name || '';
    if (song.artist) title += ' · ' + song.artist;
    if (islandTitle && islandTitle.textContent !== title) islandTitle.textContent = title;

    if (islandCover && song.cover && song.cover !== lastCover) {
      lastCover = song.cover;
      islandCover.src = song.cover;
    }

    var lyric = data.lyric && data.lyric.text ? String(data.lyric.text).trim() : '';
    setIslandLyric(lyric || title);
  }

  window.addEventListener('message', function (event) {
    if (!FOLIA_ORIGIN_PATTERN.test(event.origin)) return;
    var data = event.data;
    if (!data || data.type !== 'folia:now-playing') return;
    applyNowPlaying(data);
  });

  // 点岛（或键盘回车）→ 回到音乐视图
  if (island) {
    var goToPlayer = function () {
      if (window.BlogApp && typeof window.BlogApp.switchView === 'function') {
        window.BlogApp.switchView('music');
      }
    };
    island.addEventListener('click', goToPlayer);
    island.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        goToPlayer();
      }
    });
  }

  // ---------- 对外接口 ----------
  window.MusicView = {
    // app.js 每次切到音乐视图时调用
    onShow: function () {
      syncLayout();
      syncHeight();
      // 进来先亮一会儿，让人知道导航在这儿，随后自动收起
      touchBar();
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
