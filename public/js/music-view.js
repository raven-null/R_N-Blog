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
      // 宽度变了要重新判断文字还溢不溢出
      if (window.MusicView && typeof window.MusicView.refreshMarquee === 'function') {
        window.MusicView.refreshMarquee();
      }
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
  var lastLyricSwapAt = 0;
  var lastSongId = null;
  var lyricGapTimer = 0;

  // ---------- 岛模式：岛和导航栏互斥 ----------
  // 有歌在放 → 进入岛模式（导航栏整个收走，只留「圆按钮 + 岛」）。
  // 切换方式以鼠标悬停为准：指到圆按钮上 → 导航栏接管、岛让位；
  // 离开圆按钮和导航栏 → 延迟一下收回、岛回来。点击/键盘仍保留（触屏与无障碍）。
  var dockOrb = document.getElementById('dockOrb');
  var topBarPillEl = document.getElementById('topBarPill');

  function setNavDockOpen(open) {
    document.body.classList.toggle('nav-dock-open', open);
    // 导航从隐藏变成显示时，滑块要重新量一次位置
    if (open) {
      setTimeout(function () {
        if (window.BlogApp && typeof BlogApp.moveIndicator === 'function') {
          BlogApp.moveIndicator(BlogApp.currentView);
        }
      }, 60);
    }
  }

  function setIslandMode(on) {
    document.body.classList.toggle('island-mode', on);
    if (!on) setNavDockOpen(false);
  }

  // ---- 悬停切换 ----
  var navHoverTimer = 0;
  var NAV_CLOSE_DELAY = 180;   // 够鼠标从圆按钮挪到导航栏上（中间只隔 8px）

  function openNavByHover() {
    if (!document.body.classList.contains('island-mode')) return;
    clearTimeout(navHoverTimer);
    setNavDockOpen(true);
  }

  function scheduleNavClose() {
    if (!document.body.classList.contains('island-mode')) return;
    clearTimeout(navHoverTimer);
    navHoverTimer = setTimeout(function () {
      // 鼠标其实还在圆按钮或导航栏上（比如从圆按钮挪到了导航栏），就别收
      if (dockOrb && dockOrb.matches(':hover')) return;
      if (topBarPillEl && topBarPillEl.matches(':hover')) return;
      setNavDockOpen(false);
    }, NAV_CLOSE_DELAY);
  }

  if (dockOrb) {
    dockOrb.addEventListener('mouseenter', openNavByHover);
    dockOrb.addEventListener('mouseleave', scheduleNavClose);
    dockOrb.addEventListener('click', function (e) {
      e.stopPropagation();
      // 桌面端鼠标悬停已经能把导航唤出来，所以点击改成和导航栏品牌名一样：进后台。
      // 触屏没有 hover，点击仍然负责唤出/收起导航。
      var canHover = window.matchMedia ? window.matchMedia('(hover: hover)').matches : false;
      if (canHover) {
        window.location.href = '/admin';
        return;
      }
      setNavDockOpen(!document.body.classList.contains('nav-dock-open'));
    });
  }

  // 品牌名 + 五个视图按钮放不下时浏览器会让按钮换行：这时收起品牌名（`.is-cramped`），
  // 进后台的入口就只剩左边那颗圆球。宽度一变就重新判断。
  function syncPillCramped() {
    if (!topBarPillEl) return;
    var views = topBarPillEl.querySelector('.top-bar-views');
    if (!views) return;
    // 按钮一行装得下时高度就是个按钮高（34 左右）；换行了会明显变高
    var wrapped = views.getBoundingClientRect().height > 44;
    topBarPillEl.classList.toggle('is-cramped', wrapped);
  }

  syncPillCramped();
  window.addEventListener('resize', syncPillCramped);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(syncPillCramped).observe(topBarPillEl);
  }

  if (topBarPillEl) {
    topBarPillEl.addEventListener('mouseenter', function () {
      clearTimeout(navHoverTimer);
    });
    topBarPillEl.addEventListener('mouseleave', scheduleNavClose);
  }

  // 圆按钮的图标要跟站点真正的 favicon 走：后台可能设了自定义图标，
  // site-icon.js 会异步把它写回 link[rel=icon]，这里跟着同步（别写死默认 logo）。
  var orbImg = dockOrb ? dockOrb.querySelector('img') : null;

  function syncOrbIcon() {
    if (!orbImg) return;
    var link = document.querySelector('link[rel="icon"]');
    var href = link && link.getAttribute('href');
    if (href && orbImg.getAttribute('src') !== href) orbImg.setAttribute('src', href);
  }

  syncOrbIcon();
  var faviconLink = document.querySelector('link[rel="icon"]');
  if (faviconLink && typeof MutationObserver === 'function') {
    // site-icon.js 拉完后台设置会 setAttribute('href', ...)，这里接住那次改动
    new MutationObserver(syncOrbIcon).observe(faviconLink, {
      attributes: true,
      attributeFilter: ['href'],
    });
  }
  setTimeout(syncOrbIcon, 1500);   // 兜底：favicon 是异步取的，稍后再对一次

  // 点导航以外的地方 / 按 Esc：把导航收回去，岛回来
  document.addEventListener('click', function (e) {
    if (!document.body.classList.contains('nav-dock-open')) return;
    if (dockOrb && dockOrb.contains(e.target)) return;
    // 点了视图按钮就说明用户要走了，直接收起导航
    if (e.target && e.target.closest && e.target.closest('#viewSwitch .view-btn')) {
      setNavDockOpen(false);
      return;
    }
    if (topBarPillEl && topBarPillEl.contains(e.target)) return;
    setNavDockOpen(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.body.classList.contains('nav-dock-open')) {
      setNavDockOpen(false);
    }
  });

  // ---------- 超长文字跑马灯 ----------
  // 标题/歌词只在真的超出岛宽时才滚动；否则保持静止。
  function getRun(el) {
    if (!el) return null;
    var run = el.querySelector('.now-island-run');
    if (!run) {
      run = document.createElement('span');
      run.className = 'now-island-run';
      el.appendChild(run);
    }
    return run;
  }

  function setRunText(el, text) {
    var run = getRun(el);
    if (!run || run.textContent === text) return false;
    run.textContent = text;
    return true;
  }

  function updateMarquee(el) {
    var run = getRun(el);
    if (!run) return;
    run.classList.remove('is-scrolling');
    run.style.removeProperty('--marquee-x');
    run.style.removeProperty('--marquee-duration');
    // 先强制一次布局，避免量到上一轮动画里的旧值
    void run.offsetWidth;
    // 岛收起时容器宽为 0，这时候不判断（等它展开后 applyNowPlaying 会再量一次）
    if (el.clientWidth < 20) return;
    var overflow = run.scrollWidth - el.clientWidth;
    if (overflow > 6) {
      var shift = overflow + 12;
      run.style.setProperty('--marquee-x', '-' + shift + 'px');
      run.style.setProperty('--marquee-duration', Math.max(6, Math.round(shift / 28)) + 's');
      run.classList.add('is-scrolling');
    }
  }

  // 换句先淡出再换字，避免文字硬闪。
  // 但句与句挨得很近时（<600ms）不再走淡出——否则连着的两句会各闪一次，看着像在抽搐。
  function setIslandLyric(text) {
    if (!islandLyric || text === lastLyricText) return;
    var gap = Date.now() - lastLyricSwapAt;
    lastLyricSwapAt = Date.now();
    lastLyricText = text;

    clearTimeout(lyricSwapTimer);
    if (gap < 600) {
      setRunText(islandLyric, text);
      updateMarquee(islandLyric);
      return;
    }
    islandLyric.classList.add('is-flipping');
    lyricSwapTimer = setTimeout(function () {
      setRunText(islandLyric, text);
      updateMarquee(islandLyric);
      islandLyric.classList.remove('is-flipping');
    }, 140);
  }

  // 岛展开有 0.34s 的宽度过渡，等它到位再量一次（首次显示时宽度还是 0，量不出真实溢出）
  var marqueeTimer = 0;
  function scheduleMarqueeUpdate() {
    clearTimeout(marqueeTimer);
    marqueeTimer = setTimeout(function () {
      updateMarquee(islandTitle);
      updateMarquee(islandLyric);
      updateMarquee(cardLyric);
    }, 380);
  }

  function applyNowPlaying(data) {
    // 存一份最新的，并转给文章覆盖层里的「正在播放」（那边自己会藏/显示）
    lastNowPlaying = data;
    forwardNowPlaying(data);
    if (!island) return;
    var song = data.song;
    if (!song) {
      island.classList.remove('show');
      setIslandMode(false);
      updateMusicCard(data);
      return;
    }

    island.classList.add('show');
    setIslandMode(true);
    island.classList.toggle('paused', !data.playing && !data.loading);

    var title = song.name || '';
    if (song.artist) title += ' · ' + song.artist;
    if (setRunText(islandTitle, title)) updateMarquee(islandTitle);

    if (islandCover && song.cover && song.cover !== lastCover) {
      lastCover = song.cover;
      islandCover.src = song.cover;
    }

    // 换歌判定要放在歌词处理之前：换歌时新歌的歌词可能还没到
    var songChanged = song.id !== lastSongId;
    lastSongId = song.id;

    var lyric = data.lyric && data.lyric.text ? String(data.lyric.text).trim() : '';
    // 有歌词就只显示歌词，没有才显示「歌名 · 歌手」。
    // 关键是句与句之间会有一小段 lyric 为空：这时候不能立刻切回标题，
    // 否则每句结束都闪一下歌名，下一句又闪回来——就是「文字快速切换」的来源。
    if (lyric) {
      clearTimeout(lyricGapTimer);
      island.classList.add('has-lyric');
      setIslandLyric(lyric);
    } else if (songChanged) {
      // 换歌且新歌暂时没词：直接露标题，别留着上一首的歌词
      clearTimeout(lyricGapTimer);
      lastLyricText = null;
      island.classList.remove('has-lyric');
    } else {
      // 同一首歌的句间空档：先保持这句，等一小会儿还是没词才露标题
      clearTimeout(lyricGapTimer);
      lyricGapTimer = setTimeout(function () {
        lastLyricText = null;
        island.classList.remove('has-lyric');
      }, 2600);
    }

    // 岛刚展开时宽度还是 0，量不出溢出；等过渡走完再判定一次跑马灯
    updateMusicCard(data);
    scheduleMarqueeUpdate();
  }

  window.addEventListener('message', function (event) {
    if (!FOLIA_ORIGIN_PATTERN.test(event.origin)) return;
    var data = event.data;
    if (!data || data.type !== 'folia:now-playing') return;
    applyNowPlaying(data);
  });

  // 触屏没有 hover：岛上的头像点一下就把导航栏唤出来（桌面端点头像仍然回播放器）
  if (islandCover && island) {
    islandCover.addEventListener('click', function (e) {
      var canHover = window.matchMedia ? window.matchMedia('(hover: hover)').matches : false;
      if (canHover) return;
      e.preventDefault();
      e.stopPropagation();
      setNavDockOpen(!document.body.classList.contains('nav-dock-open'));
    });
  }

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

  // ---------- 岛上的控制按钮：上一首 / 播放暂停 / 下一首 ----------
  // 播放器在 iframe 里、是另一个源，只能把指令 postMessage 塞回去，
  // Folia 侧用 useParentFrameBroadcast 接 folia:control（prev / toggle / next）。
  var musicFrame = document.getElementById('musicFrame');

  function sendPlayerControl(action, extra) {
    if (!musicFrame || !musicFrame.contentWindow) return;
    try {
      var message = { type: 'folia:control', action: action };
      if (extra) {
        for (var key in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, key)) message[key] = extra[key];
        }
      }
      musicFrame.contentWindow.postMessage(message, FOLIA_ORIGIN);
    } catch (e) { /* iframe 还没挂上，忽略 */ }
  }

  // ---------- 转给文章覆盖层里的「正在播放」 ----------
  // 文章页跑在另一个 iframe 里，读不到这里的状态；它自己会发请求，播放状态一变也主动推过去。
  var lastNowPlaying = null;

  function articleFrameWindow() {
    var frame = document.getElementById('articleFrame');
    if (!frame) return null;
    var src = frame.getAttribute('src') || '';
    if (!src || src === 'about:blank') return null;
    return frame.contentWindow || null;
  }

  // 只发文章页要用的几个字段：整份歌词窗口每秒传一次太重
  function slimNowPlaying(data) {
    var song = data && data.song;
    // 下一句：优先从窗口里取（能对上前后文），老版播放器只有 nextLyric
    var nextText = '';
    var win = data && data.lyricsWindow;
    if (win && Array.isArray(win.lines) && win.lines.length) {
      var active = Math.max(0, Math.min(Number(win.active) || 0, win.lines.length - 1));
      var following = win.lines[active + 1];
      nextText = following && following.text ? String(following.text) : '';
    }
    if (!nextText && data && data.nextLyric && data.nextLyric.text) {
      nextText = String(data.nextLyric.text);
    }
    return {
      playing: !!(data && data.playing),
      loading: !!(data && data.loading),
      song: song ? { name: song.name || '', artist: song.artist || '', cover: song.cover || '' } : null,
      lyric: data && data.lyric ? { text: data.lyric.text || '' } : null,
      next: nextText ? { text: nextText } : null
    };
  }

  function forwardNowPlaying(data) {
    var win = articleFrameWindow();
    if (!win) return;
    try {
      win.postMessage({ type: 'blog:now-playing', payload: slimNowPlaying(data) }, location.origin);
    } catch (e) { /* iframe 正在换页，忽略 */ }
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== location.origin) return;
    var data = event.data || {};
    if (data.type === 'blog:now-playing-request') {
      // 文章页刚打开：把手上最新的一份给它
      var win = articleFrameWindow();
      if (!win || !lastNowPlaying) return;
      try {
        win.postMessage({ type: 'blog:now-playing', payload: slimNowPlaying(lastNowPlaying) }, location.origin);
      } catch (e) { /* 忽略 */ }
    } else if (data.type === 'blog:player-control' && data.action) {
      sendPlayerControl(data.action);
    }
  });

  // ---------- 主页「正在听」卡片 ----------
  // 和岛吃同一份推送：换歌/换行跟着变，三个按钮、卡片本身都能直接操作播放器。
  var musicCard = document.getElementById('hv3Music');
  var cardCover = document.getElementById('hv3MusicCover');
  var cardName = document.getElementById('hv3MusicName');
  var cardArtist = document.getElementById('hv3MusicArtist');
  var cardLyric = document.getElementById('hv3MusicLyric');

  // 卡片里的歌名：太长就左右跑马灯（比岛慢一档，读起来不赶）
  var cardNameRun = cardName ? cardName.querySelector('.hv3-music-run') : null;

  function setCardName(text) {
    var value = text ? String(text) : '';
    if (!cardNameRun || cardNameRun.textContent === value) return false;
    cardNameRun.textContent = value;
    return true;
  }

  function updateCardNameMarquee() {
    if (!cardNameRun || !cardName) return;
    cardNameRun.classList.remove('is-scrolling');
    cardNameRun.style.removeProperty('--marquee-x');
    cardNameRun.style.removeProperty('--marquee-duration');
    void cardNameRun.offsetWidth;
    // 卡片收起时宽度是 0，量不出来；下次推送再量（所以调用方在没滚的时候会再调一次）
    if (cardName.clientWidth < 20) return;
    // 卡片标题这里只要溢出就滚（岛那边留了 6px 余量，是因为岛宽会变；
    // 卡片宽度是固定的 5 栏，差 1px 也是被切掉了一点，得让它滚出来）
    var overflow = cardNameRun.scrollWidth - cardName.clientWidth;
    if (overflow > 0) {
      var shift = overflow + 16;
      cardNameRun.style.setProperty('--marquee-x', '-' + shift + 'px');
      // 约 16px/秒，比灵动岛（28px/秒）慢一些；越长滚得越久
      cardNameRun.style.setProperty('--marquee-duration', Math.max(8, Math.round(shift / 16)) + 's');
      cardNameRun.classList.add('is-scrolling');
    }
  }

  // 名字变了，或者名字没变但还没滚起来（首次显示时卡片宽度可能还是 0），就重新量一次；
  // 已经在滚的就不动它，免得每秒推送把动画重启一遍。
  function syncCardName(text) {
    var changed = setCardName(text);
    if (changed || !cardNameRun || !cardNameRun.classList.contains('is-scrolling')) {
      updateCardNameMarquee();
    }
  }

  var lyricsBox = document.getElementById('hv3MusicLyrics');
  var lyricPrevEl = document.getElementById('hv3LyricPrev');
  var lyricCurrentEl = document.getElementById('hv3LyricCurrent');
  var lyricNextEl = document.getElementById('hv3LyricNext');
  var loopBtn = document.getElementById('hv3MusicLoopBtn');
  var lyricHoldTimer = 0;

  // 循环键的三态：off → all → one → off，和播放器自己是同一套设置（Folia 那边改完会回推状态）
  var LOOP_TEXT = {
    off: { title: '循环：不循环', label: '不循环' },
    all: { title: '循环：列表循环', label: '列表循环' },
    one: { title: '循环：单曲循环', label: '单曲循环' }
  };

  function syncLoopButton(mode) {
    if (!loopBtn) return;
    var key = LOOP_TEXT[mode] ? mode : 'off';
    loopBtn.setAttribute('data-loop', key);
    loopBtn.title = LOOP_TEXT[key].title;
    loopBtn.setAttribute('aria-label', '切换循环方式，当前 ' + LOOP_TEXT[key].label);
  }

  // 兜底：老版本 Folia 只推「当前这一句」，不推前后窗口。那就把从这一刻起收到的每句攒起来
  // （换歌就清空），用倒数第二句充当「上一句」，只是开头缺进入页面之前的那几句。
  var lyricHistory = [];
  var lyricHistorySong = null;

  function accumulateLyric(song, data) {
    if (!song) {
      lyricHistory = [];
      lyricHistorySong = null;
      return;
    }
    if (lyricHistorySong !== song.id) {
      lyricHistory = [];
      lyricHistorySong = song.id;
    }
    var text = data && data.lyric && data.lyric.text ? String(data.lyric.text).trim() : '';
    if (!text) return;
    var translation = data.lyric.translation ? String(data.lyric.translation) : '';
    var last = lyricHistory[lyricHistory.length - 1];
    if (last && last.text === text) {
      if (translation) last.translation = translation;
      return;
    }
    lyricHistory.push({ text: text, translation: translation });
    if (lyricHistory.length > 16) lyricHistory.shift();
  }

  // 画歌词：一行一句地换——上一句淡出上移，当前句从下方顶上来，下一句淡入下方
  // 数据优先取 Folia 推来的窗口（前后文齐全），老版播放器只有当前句时用攒下来的历史补上一句

  function setLyricLine(el, text, translation) {
    if (!el) return false;
    var value = text ? String(text) : '';
    var sub = translation ? String(translation) : '';
    if (el.dataset.text === value && el.dataset.sub === sub) return false;
    el.dataset.text = value;
    el.dataset.sub = sub;
    // 包一层 span：长句子才能在它身上做省略号
    el.innerHTML = value
      ? '<span class="hv3-music-lyric-text">' + escapeHtml(value) + '</span>'
        + (sub ? '<span class="hv3-music-lyric-trans">' + escapeHtml(sub) + '</span>' : '')
      : '';
    return true;
  }

  // 长句自动缩字号：全角按 1、半角按 0.55 折算成"视觉宽度单位"，越长的句子字号越小
  function lyricFontSize(text) {
    var value = text ? String(text) : '';
    var units = 0;
    for (var i = 0; i < value.length; i++) {
      units += /[\u0000-\u00ff]/.test(value[i]) ? 0.55 : 1;
    }
    if (units <= 14) return 21;
    if (units <= 20) return 19;
    if (units <= 26) return 17;
    if (units <= 34) return 15;
    if (units <= 44) return 13.5;
    return 12.5;
  }

  // 当前句分两层叠着画：底层是暗的字，上层是强调色的字，用 clip-path 按这句唱到的比例裁出来
  // ——就是卡拉OK 那种「一句唱到哪儿亮到哪儿」。两层文本必须一模一样，所以一起重画。
  function setCurrentLyric(text, translation) {
    if (!lyricCurrentEl) return false;
    var value = text ? String(text) : '';
    var sub = translation ? String(translation) : '';
    if (lyricCurrentEl.dataset.text === value && lyricCurrentEl.dataset.sub === sub) return false;
    lyricCurrentEl.dataset.text = value;
    lyricCurrentEl.dataset.sub = sub;
    var safe = escapeHtml(value);
    lyricCurrentEl.innerHTML =
      '<span class="hv3-music-lyric-base">' + safe + '</span>' +
      '<span class="hv3-music-lyric-fill" aria-hidden="true">' + safe + '</span>' +
      (sub ? '<span class="hv3-music-lyric-trans">' + escapeHtml(sub) + '</span>' : '');
    // 长句子自动缩字号，别让它在两行里被裁掉
    lyricCurrentEl.style.setProperty('--lyric-font', lyricFontSize(value) + 'px');
    return true;
  }

  // 当前句的时间范围（毫秒），用来算唱到哪儿了
  var lyricTiming = { startMs: 0, endMs: 0 };

  function syncLyricProgress(positionMs) {
    if (!lyricCurrentEl) return;
    var now = Number.isFinite(positionMs) ? positionMs : 0;
    var span = lyricTiming.endMs - lyricTiming.startMs;
    var ratio = span > 0 ? (now - lyricTiming.startMs) / span : 1;
    ratio = Math.max(0, Math.min(1, ratio));
    lyricCurrentEl.style.setProperty('--lyric-progress', (ratio * 100).toFixed(1) + '%');
  }

  // 上下两句换内容时重放一次"飘"的动画（同一个类要摘掉再加重启，否则不会重播）
  function replayGhost(el) {
    if (!el) return;
    el.classList.remove('is-ghost');
    void el.offsetWidth;
    el.classList.add('is-ghost');
  }

  function renderCardLyrics(data) {
    if (!lyricCurrentEl) return false;
    var win = data && data.lyricsWindow;
    var prevText = '';
    var currentText = '';
    var translation = '';
    var nextText = '';
    var startMs = 0;
    var endMs = 0;

    if (win && Array.isArray(win.lines) && win.lines.length) {
      var active = Math.max(0, Math.min(Number(win.active) || 0, win.lines.length - 1));
      var currentLine = win.lines[active] || {};
      prevText = (win.lines[active - 1] || {}).text || '';
      currentText = currentLine.text || '';
      translation = currentLine.translation || '';
      nextText = (win.lines[active + 1] || {}).text || '';
      startMs = Number(currentLine.startMs) || 0;
      endMs = Number(currentLine.endMs) || 0;
    } else {
      if (lyricHistory.length) {
        var last = lyricHistory[lyricHistory.length - 1];
        currentText = last.text || '';
        translation = last.translation || '';
        prevText = lyricHistory.length > 1 ? (lyricHistory[lyricHistory.length - 2].text || '') : '';
      }
      nextText = data && data.nextLyric && data.nextLyric.text ? String(data.nextLyric.text) : '';
      var leaf = data && data.lyric;
      if (leaf) {
        startMs = Number(leaf.startMs) || 0;
        endMs = Number(leaf.endMs) || 0;
      }
    }

    var hasLyricText = !!currentText;
    if (!currentText) currentText = '歌词加载中…';
    lyricTiming = { startMs: startMs, endMs: endMs };

    var changed = setCurrentLyric(currentText, translation);
    var prevChanged = setLyricLine(lyricPrevEl, prevText, '');
    var nextChanged = setLyricLine(lyricNextEl, nextText, '');

    // 换句时上下两句各飘一下：唱完的那句从下方散上来，下一句从更下方浮起来
    if (prevChanged) replayGhost(lyricPrevEl);
    if (nextChanged) replayGhost(lyricNextEl);

    // 没拿到这句的时间范围时，直接当作「整句已唱完」，不做填充动画
    syncLyricProgress(progressState.positionMs);

    if (changed && hasLyricText) {
      // 重启动画：当前句从下方顶上来，一口气滑到位
      lyricCurrentEl.classList.remove('is-entering');
      void lyricCurrentEl.offsetWidth;
      lyricCurrentEl.classList.add('is-entering');
    }
    return true;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 翻不翻：真在放（或正要开始放）才翻起来；暂停、没歌都停在正面，方便按播放键
  var cardHovered = false;

  function syncCardFlip() {
    if (!musicCard) return;
    var canFlip = musicCard.classList.contains('is-playing') && !musicCard.classList.contains('paused');
    musicCard.classList.toggle('is-lyric', canFlip && !cardHovered);
    if (lyricsBox) lyricsBox.setAttribute('aria-hidden', canFlip && !cardHovered ? 'false' : 'true');
  }

  // ---------- 进度条 ----------
  // 位置来自播放器的推送（整秒），推送之间本地按 250ms 补帧，免得进度条一格一格跳。
  var progressWrap = document.getElementById('hv3MusicProgress');
  var progressFill = document.getElementById('hv3MusicProgressFill');
  var progressTime = document.getElementById('hv3MusicProgressTime');
  var progressState = { positionMs: 0, durationMs: 0, at: 0, playing: false, shown: false };

  function formatClock(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function paintProgress(positionMs, durationMs) {
    if (progressFill) progressFill.style.width = (Math.min(1, positionMs / durationMs) * 100).toFixed(2) + '%';
    if (progressTime) progressTime.textContent = formatClock(positionMs) + ' / ' + formatClock(durationMs);
  }

  function syncProgress(data) {
    if (!progressWrap) return;
    var song = data && data.song;
    var durationMs = song && song.durationMs ? Number(song.durationMs) : 0;
    var positionMs = data && Number.isFinite(data.positionMs) ? Math.max(0, Number(data.positionMs)) : 0;
    // 老版播放器不推 positionMs，也没有时长时就不显示进度条（不编一个假的出来）
    var show = !!song && durationMs > 0 && positionMs > 0;
    if (show !== progressState.shown) {
      progressState.shown = show;
      progressWrap.hidden = !show;
    }
    if (!show) return;
    progressState.positionMs = positionMs;
    progressState.durationMs = durationMs;
    progressState.at = Date.now();
    progressState.playing = !!data.playing;
    paintProgress(positionMs, durationMs);
    syncLyricProgress(positionMs);
  }

  setInterval(function () {
    if (progressDragging) return;
    if (!progressState.shown || !progressState.playing || !progressState.durationMs) return;
    var advanced = progressState.positionMs + (Date.now() - progressState.at);
    var clamped = Math.min(advanced, progressState.durationMs);
    paintProgress(clamped, progressState.durationMs);
    syncLyricProgress(clamped);
  }, 250);

  // ---------- 进度条拖动 ----------
  // 拖动时只在本地画（不打断播放），松手才把目标位置发给播放器（folia:control 的 seek）。
  var progressBarEl = progressWrap ? progressWrap.querySelector('.hv3-music-progress-bar') : null;
  var progressDragging = false;
  var progressJustDragged = false;

  function ratioFromPointer(event) {
    if (!progressBarEl) return 0;
    var rect = progressBarEl.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }

  function paintAtRatio(ratio) {
    if (!progressState.durationMs) return null;
    var positionMs = Math.round(ratio * progressState.durationMs);
    paintProgress(positionMs, progressState.durationMs);
    return positionMs;
  }

  if (progressBarEl) {
    progressBarEl.addEventListener('pointerdown', function (e) {
      if (!progressState.durationMs) return;
      e.preventDefault();
      e.stopPropagation();
      progressDragging = true;
      progressJustDragged = true;
      progressBarEl.classList.add('is-dragging');
      try { progressBarEl.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器没有就算了 */ }
      paintAtRatio(ratioFromPointer(e));
    });

    progressBarEl.addEventListener('pointermove', function (e) {
      if (!progressDragging) return;
      e.preventDefault();
      e.stopPropagation();
      paintAtRatio(ratioFromPointer(e));
    });

    progressBarEl.addEventListener('pointerup', function (e) {
      if (!progressDragging) return;
      progressDragging = false;
      progressBarEl.classList.remove('is-dragging');
      e.preventDefault();
      e.stopPropagation();
      var positionMs = paintAtRatio(ratioFromPointer(e));
      if (positionMs === null) return;
      // 本地先把位置认下来，等播放器推回来再校准
      progressState.positionMs = positionMs;
      progressState.at = Date.now();
      sendPlayerControl('seek', { positionMs: positionMs });
    });

    progressBarEl.addEventListener('pointercancel', function () {
      if (!progressDragging) return;
      progressDragging = false;
      progressBarEl.classList.remove('is-dragging');
    });

    // 拖完别让这一次点击冒到卡片上（否则会顺带切到音乐视图）
    progressBarEl.addEventListener('click', function (e) {
      if (!progressJustDragged) return;
      progressJustDragged = false;
      e.stopPropagation();
    });
  }

  function updateMusicCard(data) {
    if (!musicCard) return;
    var song = data && data.song;

    syncLoopButton(data && data.loopMode);
    accumulateLyric(song, data);
    renderCardLyrics(data);
    syncProgress(data);

    if (!song) {
      musicCard.classList.remove('is-playing', 'paused');
      syncCardName('还没有在播放');
      if (cardArtist) cardArtist.textContent = '去播放器里挑一首';
      if (cardLyric) setRunText(cardLyric, '');
      syncCardFlip();
      return;
    }

    musicCard.classList.add('is-playing');
    musicCard.classList.toggle('paused', !data.playing && !data.loading);

    syncCardName(song.name || '');
    if (cardArtist && cardArtist.textContent !== (song.artist || '')) cardArtist.textContent = song.artist || '';
    if (cardCover && song.cover && cardCover.getAttribute('src') !== song.cover) cardCover.src = song.cover;

    var cardLyricText = data.lyric && data.lyric.text ? String(data.lyric.text).trim() : '';
    setRunText(cardLyric, cardLyricText);
    updateMarquee(cardLyric);

    syncCardFlip();
  }

  if (musicCard) {
    musicCard.addEventListener('click', function (e) {
      // 控制按钮有自己的 handler，别被卡片点击顺走
      if (e.target && e.target.closest && e.target.closest('.hv3-music-ctls')) return;
      if (window.BlogApp && typeof window.BlogApp.switchView === 'function') {
        window.BlogApp.switchView('music');
      }
    });

    var cardCtls = musicCard.querySelectorAll('.hv3-music-ctls button');
    for (var cci = 0; cci < cardCtls.length; cci++) {
      cardCtls[cci].addEventListener('click', function (e) {
        e.stopPropagation();
        sendPlayerControl(this.getAttribute('data-ctl'));
      });
    }

    // 鼠标移到卡上 → 立刻翻回正面（歌词收起）；移开一会儿再翻上去，别让路过也触发
    musicCard.addEventListener('mouseenter', function () {
      cardHovered = true;
      clearTimeout(lyricHoldTimer);
      syncCardFlip();
    });
    musicCard.addEventListener('mouseleave', function () {
      cardHovered = false;
      clearTimeout(lyricHoldTimer);
      lyricHoldTimer = setTimeout(syncCardFlip, 900);
    });

    var cardOpenBtn = document.getElementById('hv3MusicOpen');
    if (cardOpenBtn) {
      cardOpenBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (window.BlogApp && typeof window.BlogApp.switchView === 'function') {
          window.BlogApp.switchView('music');
        }
      });
    }
  }

  if (island) {
    var ctlButtons = island.querySelectorAll('.now-ctl');
    for (var ci = 0; ci < ctlButtons.length; ci++) {
      ctlButtons[ci].addEventListener('click', function (e) {
        // 别冒泡到岛本身——那是「回到播放器」
        e.stopPropagation();
        sendPlayerControl(this.getAttribute('data-ctl'));
      });
    }
  }

  // ---------- 对外接口 ----------
  window.MusicView = {
    // app.js 每次切到音乐视图时调用
    onShow: function () {
      syncLayout();
      syncHeight();
      // 进来先亮一会儿，让人知道导航在这儿，随后自动收起
      touchBar();
      // 视图重新显示后宽度恢复了，重新判断文字要不要滚
      scheduleMarqueeUpdate();
    },
    // 窗口尺寸变化后重新判断跑马灯
    refreshMarquee: scheduleMarqueeUpdate
  };

  // ---------- 预加载 ----------
  // 用户希望首页就预加载：挂在 load 之后，不拖慢首屏；手机上不预加载（本来也不显示 iframe）。
  function boot() { syncLayout(); }
  if (document.readyState === 'complete') setTimeout(boot, 0);
  else window.addEventListener('load', function () { setTimeout(boot, 0); });
  // 兜底：load 万一被阻塞，2.5s 后也把布局算出来（此时仍按 display:none 量不到高度，onShow 会再算）
  setTimeout(boot, 2500);
})();
