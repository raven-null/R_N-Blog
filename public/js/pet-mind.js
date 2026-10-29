/* 桌宠的心智
   ------------------------------------------------------------
   四件事：
     1. 看：采集当前页面在显示什么（视图 / 文章标题与进度 / 图库当前照片 / 简报）
     2. 说：主动搭话（本地短句 + 上下文插值；也可让 AI 现场生成）
     3. 聊：接站内 /api/ai，流式回答，带上"它此刻看到的"
     4. 听：Web Speech API 中文语音输入（可选语音朗读回复）

   与角色引擎的关系：说话时把 grok 角色切到 listening / thinking / excited。
*/
(function (global) {
  'use strict';

  const STATE = {
    enabled: true,
    autoMs: [55000, 130000],   // 主动说话间隔区间
    minGap: 45000,             // 两次自动说话的最小间隔
    lastAutoAt: 0,
    lastUserAt: 0,
    history: [],               // { role, content }
    busy: false,
    ttsOn: false,
    timer: 0,
    viewSince: Date.now(),
    lastView: '',
  };

  // ---------- 本地短句（AI 不可用时的兜底，也用于即时反应） ----------
  const LINES = {
    home: [
      '今天有三篇新的，要不要看看？',
      '左边那篇讲无限画布的，你可能会喜欢',
      '现在是{period}，光打在画上刚好',
      '照片墙一直没人翻，喵有点寂寞',
      '站里一共 {posts} 篇文章，你读过几篇？',
      '点上面的数字可以直接进对应页面',
    ],
    blog: [
      '这么多标题，挑一个吧',
      '要不要我念一篇给你听？',
      '列表只看标题看不出味道，点进去试试',
    ],
    article: [
      '这篇读了一半了，慢慢来',
      '读到这儿有想法的话可以跟我说',
      '要不要我总结一下这段？',
      '看太久了，眼睛歇一下',
    ],
    gallery: [
      '这张不错，我盯了好一会儿',
      '双击可以看大图',
      '照片比文章诚实多了',
      '这套图是最近拍的？',
    ],
    projects: [
      '这些都是一个个熬夜堆出来的',
      '想看看哪个项目怎么做的？',
    ],
    night: [
      '这个点了，早点睡吧',
      '夜里页面会变蓝，我调的',
      '你是不是该睡了…',
    ],
    idle: [
      '在呢',
      '有事没事都可以叫我',
      '摸摸头也可以（我不躲）',
      '我就在这儿，不吵你',
    ],
  };

  // ---------- 采集当前页面在显示什么 ----------
  function visibleView() {
    // 文章详情页（article.html）先认出来，它没有 view-* 容器
    if (document.querySelector('.article-header, .article-title, .article-content')) return 'article';

    const map = {
      'view-home': 'home',
      'view-blog': 'blog',
      'view-gallery': 'gallery',
      'view-projects': 'projects',
    };
    for (const id in map) {
      const el = document.getElementById(id);
      if (el && getComputedStyle(el).display !== 'none') return map[id];
    }
    return 'home';
  }

  function collect() {
    const view = visibleView();
    const ctx = { view, viewSince: STATE.viewSince, stuckSec: Math.round((Date.now() - STATE.viewSince) / 1000) };

    const root = document.documentElement;
    ctx.period = root.getAttribute('data-period') || '';
    const clock = document.getElementById('hvClockTime');
    ctx.time = clock && clock.textContent.trim() ? clock.textContent.trim() : '';
    if (!ctx.time) {
      const now = new Date();
      ctx.time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    }

    // 首页：精选文章标题 + 简报标题 + 数字
    if (view === 'home') {
      ctx.posts = [...document.querySelectorAll('.hv-post-title')].map((e) => e.textContent.trim()).slice(0, 5);
      ctx.news = [...document.querySelectorAll('#newsList .news-item')].map((e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)).slice(0, 4);
      ctx.statPosts = (document.getElementById('homeCtaPosts') || {}).textContent || '';
      ctx.statPhotos = (document.getElementById('homeCtaPhotos') || {}).textContent || '';
      ctx.statProjects = (document.getElementById('homeCtaProjects') || {}).textContent || '';
    }

    // 文章页：标题 + 读到哪了
    if (view === 'article') {
      const h = document.querySelector('.article-title, h1.article-title, .post-title, article h1, h1');
      ctx.article = h ? h.textContent.trim() : '';
      const scroller = document.getElementById('scrollArea') || document.scrollingElement;
      if (scroller) {
        const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
        ctx.progress = Math.round(Math.min(1, scroller.scrollTop / max) * 100);
      }
      const visiblePara = [...document.querySelectorAll('.article-content p, article p, .article-body p')]
        .find((p) => {
          const r = p.getBoundingClientRect();
          return r.top >= 0 && r.top < window.innerHeight * 0.7;
        });
      if (visiblePara) ctx.reading = visiblePara.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
    }

    // 图库：当前大图
    if (view === 'gallery') {
      const lb = document.getElementById('galleryLightbox');
      const open = lb && getComputedStyle(lb).display !== 'none';
      const img = document.getElementById('galleryLightboxImg');
      ctx.lightboxOpen = !!open;
      if (open && img) {
        ctx.photo = img.getAttribute('src') || '';
        ctx.photoIndex = Number(global.__galleryIndex) || 0;
        ctx.photoTotal = Array.isArray(global.__galleryImages) ? global.__galleryImages.length : 0;
      }
      ctx.galleryCount = Array.isArray(global.__galleryImages) ? global.__galleryImages.length : 0;
    }

    if (view === 'projects') {
      ctx.projectNames = [...document.querySelectorAll('.projects-grid a, #projectsGithubGrid a, #deployedProjects a')]
        .map((a) => a.textContent.replace(/\s+/g, ' ').trim().slice(0, 30)).slice(0, 6);
    }

    ctx.sectionLabel = { home: '主页', blog: '文章列表', gallery: '图库', projects: '项目', article: '文章页' }[view] || '页面';
    return ctx;
  }

  // ---------- 气泡 ----------
  function bubbleEl() { return document.getElementById('deskPetBubble'); }

  function say(text, ms) {
    const el = bubbleEl();
    if (!el || !text) return;
    el.textContent = text;
    el.classList.remove('is-below');
    el.classList.add('is-show');
    if (global.PetBoot && typeof global.PetBoot.placeBubble === 'function') {
      global.PetBoot.placeBubble();
    } else if (global.BlogApp && typeof global.BlogApp.placePetBubble === 'function') {
      global.BlogApp.placePetBubble();
    }
    clearTimeout(STATE.bubbleTimer);
    STATE.bubbleTimer = setTimeout(() => el.classList.remove('is-show'), ms || Math.min(9000, 2400 + text.length * 70));
    logPush('assistant', text);
    if (STATE.ttsOn) speak(text);
  }

  function logEl() { return document.getElementById('petChatLog'); }

  function logPush(role, text) {
    const box = logEl();
    if (!box) return;
    const item = document.createElement('div');
    item.className = 'pet-msg pet-msg-' + role;
    item.textContent = text;
    box.appendChild(item);
    box.scrollTop = box.scrollHeight;
    if (role === 'user' || role === 'assistant') {
      STATE.history.push({ role, content: text });
      if (STATE.history.length > 16) STATE.history = STATE.history.slice(-16);
    }
  }

  // ---------- 角色状态 ----------
  function petState(name, backMs) {
    const eng = global.BlogApp && global.BlogApp.petEngine;
    if (!eng) return;
    try {
      eng.setState(name, { resetEyes: true });
      if (backMs) {
        clearTimeout(STATE.stateTimer);
        STATE.stateTimer = setTimeout(() => {
          try { eng.setState('idle'); } catch (e) { /* 忽略 */ }
        }, backMs);
      }
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 语音朗读 ----------
  function speak(text) {
    if (!global.speechSynthesis || !text) return;
    try {
      const u = new SpeechSynthesisUtterance(text.replace(/[*_`#>]/g, '').slice(0, 160));
      u.lang = 'zh-CN';
      u.rate = 1.05;
      u.pitch = 1.1;
      global.speechSynthesis.cancel();
      global.speechSynthesis.speak(u);
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 问 AI ----------
  function buildPrompt(ctx) {
    const bits = [
      '你是这个个人博客站里的桌宠「枯梦」，一只住在网页右下角的小生物。',
      '说话短、口语、有点小情绪，可以偶尔用「喵」，但不要每句都卖萌，不要长篇大论。',
      '你能看到访客此刻正在看的页面，回答时优先结合下面的现场信息，不要编造没看到的内容。',
      '被问身份时，说自己是站里的桌宠，不要说自己是大模型。',
      '',
      '【此刻现场】',
      '- 页面：' + ctx.sectionLabel + '（' + ctx.view + '）',
      '- 本地时间：' + ctx.time + (ctx.period ? '，天色：' + ctx.period : ''),
      '- 在这个页面已经待了：' + ctx.stuckSec + ' 秒',
    ];
    if (ctx.posts && ctx.posts.length) bits.push('- 首页精选文章：' + ctx.posts.join(' / '));
    if (ctx.news && ctx.news.length) bits.push('- 今日简报：' + ctx.news.join(' / '));
    if (ctx.statPosts) bits.push('- 站点数字：' + ctx.statPosts + ' 篇文章 / ' + ctx.statPhotos + ' 张照片 / ' + ctx.statProjects + ' 个项目');
    if (ctx.article) bits.push('- 正在读的文章：' + ctx.article + (typeof ctx.progress === 'number' ? '（读到 ' + ctx.progress + '%）' : ''));
    if (ctx.reading) bits.push('- 正在看的段落：「' + ctx.reading + '」');
    if (ctx.lightboxOpen) bits.push('- 图库里正打开一张大图（第 ' + (ctx.photoIndex + 1) + ' 张 / 共 ' + ctx.photoTotal + ' 张）');
    else if (ctx.galleryCount) bits.push('- 图库共 ' + ctx.galleryCount + ' 张照片');
    if (ctx.projectNames && ctx.projectNames.length) bits.push('- 项目列表：' + ctx.projectNames.join(' / '));
    bits.push('', '要求：回复控制在 1~2 句、40 字以内；不要列点，不要重复上面的信息，像旁边的人随口搭一句。');
    return bits.join('\n');
  }

  async function askAI(userText) {
    const ctx = collect();
    const messages = [
      { role: 'system', content: buildPrompt(ctx) },
      ...STATE.history.slice(-8),
    ];
    if (userText) messages.push({ role: 'user', content: userText });

    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (!ctype.includes('text/event-stream')) {
      const data = await res.json().catch(() => null);
      const t = data && data.choices && data.choices[0]
        && ((data.choices[0].message && data.choices[0].message.content)
          || (data.choices[0].delta && data.choices[0].delta.content));
      return t || '';
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let reply = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
          if (delta) reply += delta;
        } catch (e) { /* 跳过不完整分片 */ }
      }
    }
    return reply;
  }

  // ---------- 主动说话 ----------
  function pickLocalLine(ctx) {
    const hour = new Date().getHours();
    let pool = LINES[ctx.view] || LINES.idle;
    if (hour >= 23 || hour < 6) pool = LINES.night.concat(LINES.idle);
    if (ctx.stuckSec > 180 && Math.random() < 0.4) pool = LINES.idle;
    const line = pool[Math.floor(Math.random() * pool.length)];
    return line
      .replace('{period}', ({ dawn: '晨曦', day: '白昼', dusk: '薄暮', night: '静夜' })[ctx.period] || '现在')
      .replace('{posts}', ctx.statPosts || '不少');
  }

  async function autoTalk(force) {
    if (!STATE.enabled || STATE.busy) return;
    const now = Date.now();
    if (!force && now - STATE.lastAutoAt < STATE.minGap) return;
    if (document.hidden) return;

    STATE.lastAutoAt = now;
    const ctx = collect();

    // 先给一句即时的（本地池），保证"立刻有反应"
    const quick = pickLocalLine(ctx);
    say(quick, 5200);
    petState(ctx.view === 'article' ? 'thinking' : 'curious', 2600);

    // 再让 AI 补一句更贴现场的（失败就沉默，不打扰）
    STATE.busy = true;
    try {
      const ai = await askAI('现在随便跟我说一句，结合我正在看的东西，别重复我刚说的话。');
      const text = (ai || '').replace(/^["「]|["」]$/g, '').trim();
      if (text && text.length <= 90) {
        clearTimeout(STATE.autoSayTimer);
        STATE.autoSayTimer = setTimeout(() => {
          if (STATE.busy) return;          // 用户已经插话了，这句就不补了
          say(text, 9000);
          petState('excited', 1800);
        }, 5200);
      }
    } catch (e) {
      /* AI 不可用时只有本地那句，够用 */
    } finally {
      STATE.busy = false;
    }
  }

  function scheduleAuto() {
    clearTimeout(STATE.timer);
    const [lo, hi] = STATE.autoMs;
    const wait = lo + Math.random() * (hi - lo);
    STATE.timer = setTimeout(() => {
      if (Date.now() - STATE.lastUserAt > 20000) autoTalk();
      scheduleAuto();
    }, wait);
  }

  // ---------- 语音输入 ----------
  function initVoice() {
    const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    const mic = document.getElementById('petMic');
    if (!mic) return;
    if (!SR) {
      mic.title = '这个浏览器不支持语音识别（试试 Chrome / Edge）';
      mic.classList.add('is-disabled');
      mic.addEventListener('click', () => say('这个浏览器听不见我…换 Chrome 试试？', 4000));
      return;
    }

    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    let listening = false;
    rec.onstart = () => {
      listening = true;
      mic.classList.add('is-listening');
      petState('listening', 0);
      say('在听…', 9000);
    };
    rec.onresult = (e) => {
      let interim = '';
      let finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      const live = finalText || interim;
      if (live) {
        const el = bubbleEl();
        if (el) el.textContent = live;
        const input = document.getElementById('petChatInput');
        if (input) input.value = live;
      }
      if (finalText) {
        send(finalText.trim());
      }
    };
    rec.onerror = (e) => {
      listening = false;
      mic.classList.remove('is-listening');
      if (e.error === 'not-allowed') say('麦克风没开权限，我收不到声音', 5000);
      else if (e.error !== 'aborted') say('没听清…再说一次？', 4000);
      petState('idle', 0);
    };
    rec.onend = () => {
      listening = false;
      mic.classList.remove('is-listening');
      if (!STATE.busy) petState('idle', 0);
    };

    mic.addEventListener('click', (e) => {
      e.stopPropagation();
      if (listening) { rec.stop(); return; }
      try { rec.start(); } catch (err) { /* 已在启动中 */ }
    });
  }

  // ---------- 发一句话 ----------
  async function send(text) {
    if (!text) return;
    clearTimeout(STATE.autoSayTimer);
    clearTimeout(STATE.bubbleTimer);
    STATE.lastUserAt = Date.now();
    logPush('user', text);
    petState('thinking', 0);
    STATE.busy = true;

    const el = bubbleEl();
    if (el) { el.textContent = '…'; el.classList.add('is-show'); }

    try {
      const reply = (await askAI(text)).trim() || '喵…没想好怎么回。';
      say(reply, 12000);
      petState('excited', 2000);
    } catch (e) {
      say('脑子卡住了（' + String(e.message || e).slice(0, 30) + '）', 5000);
      petState('confused', 1500);
    } finally {
      STATE.busy = false;
    }
  }

  // ---------- 对话面板 ----------
  function initPanel() {
    const wrap = document.getElementById('petChat');
    const form = document.getElementById('petChatForm');
    const input = document.getElementById('petChatInput');
    const close = document.getElementById('petChatClose');
    if (!wrap) return;

    form && form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = (input && input.value || '').trim();
      if (!text) return;
      input.value = '';
      send(text);
    });

    close && close.addEventListener('click', (e) => {
      e.stopPropagation();
      wrap.classList.remove('is-open');
    });

    // 点气泡展开对话
    const bubble = bubbleEl();
    bubble && bubble.addEventListener('click', () => {
      wrap.classList.add('is-open');
      setTimeout(() => input && input.focus(), 120);
    });
  }

  // ---------- 启动 ----------
  function start() {
    initPanel();
    initVoice();
    scheduleAuto();

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleAuto();
    });

    // 视图切换：过几秒打一句招呼
    const watchView = () => {
      const v = visibleView();
      if (v !== STATE.lastView) {
        STATE.lastView = v;
        STATE.viewSince = Date.now();
        setTimeout(() => {
          if (Date.now() - STATE.lastUserAt < 15000) return;
          autoTalk(true);
        }, 2600);
      }
    };
    setInterval(watchView, 2000);
    watchView();

    // 深夜提醒一次
    const hour = new Date().getHours();
    if (hour >= 23 || hour < 5) {
      setTimeout(() => say('这个点了，别熬太晚喵', 7000), 6000);
    }
  }

  global.PetMind = {
    start,
    collect,
    say,
    send,
    autoTalk,
    toggleTTS(on) {
      STATE.ttsOn = on === undefined ? !STATE.ttsOn : !!on;
      return STATE.ttsOn;
    },
    state: STATE,
  };
})(window);
