/* 桌宠的心智
   ------------------------------------------------------------
   四件事：
     1. 看：采集当前页面在显示什么（视图 / 文章标题与进度 / 图库当前照片 / 简报）
     2. 说：主动搭话（本地台词库 + 情境插值 + 最近三句去重），可安静
     3. 聊：接站内 /api/ai，流式显示，带上"它此刻看到的"
     4. 听：Web Speech API 中文语音输入（可选朗读回复）

   与桌宠内核（pet-core.js）的关系：说话/反应状态都交给 PetCore.setState，
   这里只负责「说什么」和「听什么」。
*/
(function (global) {
  'use strict';

  const STATE = {
    enabled: true,
    ttsOn: false,
    name: '渡鸦',
    persona: '',
    ttsRate: 1.05,
    ttsPitch: 1.1,
    ttsVoice: '',
    wakeWord: '渡鸦',
    wakeAction: 'panel',
    autoMs: [70000, 155000],   // 白天主动说话间隔
    nightAutoMs: [150000, 300000], // 夜间：更安静
    minGap: 50000,             // 两次自动说话的最小间隔
    lastAutoAt: 0,
    lastUserAt: 0,
    lastSwitchAt: 0,
    history: [],               // { role, content }
    recent: [],                // 最近说过的本地台词（去重）
    busy: false,
    timer: 0,
    bubbleTimer: 0,
    stateTimer: 0,
    viewSince: Date.now(),
    lastView: '',
    started: false,
    streamEl: null,
  };

  // 兼容浏览器全局与精简的测试环境（window 上未必有 document / localStorage）
  const doc = global.document || (typeof document !== 'undefined' ? document : null);
  const ls = (() => { try { return global.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null); } catch (e) { return null; } })();

  const PERIOD = { dawn: '晨曦', day: '白昼', dusk: '薄暮', night: '静夜' };

  // ---------- 本地台词（AI 不可用时的兜底，也用于即时反应） ----------
  const LINES = {
    home: [
      '最近的文字已经整理好了，挑一篇看看吧',
      '左边是照片，右边是文章，随便逛',
      '现在是{period}，光打在画上刚好',
      '照片墙一直没人翻，喵有点寂寞',
      '站里一共 {posts} 篇文章，你读过几篇？',
      '今天的简报在下面，我还没看完',
      '鼠标停在我身上，我就抬头看你',
      '点上面的数字可以直接进对应页面',
    ],
    blog: [
      '这么多标题，挑一个吧',
      '要不要我念一篇给你听？',
      '列表只看标题看不出味道，点进去试试',
      '按标签筛一下会好找很多',
      '每篇读到最后，我都在右下角',
    ],
    articleStart: [
      '刚点进来，先看看开头',
      '这篇我还没读过，你读给我听？',
      '读到 {progress}% 了，慢慢来',
    ],
    article: [
      '读到 {progress}% 了，慢慢来',
      '读到这儿有想法的话可以跟我说',
      '要不要我总结一下这段？',
      '看太久了，眼睛歇一下',
      '读到 {progress}%，节奏不急不缓',
      '选中一段再点我，我可以解释',
    ],
    articleEnd: [
      '快读完了，已经 {progress}%',
      '结尾这儿通常最有味道',
      '读完了要不要写点什么？',
    ],
    gallery: [
      '这张不错，我盯了好一会儿',
      '双击可以看大图',
      '照片比文章诚实多了',
      '这套图是最近拍的？',
      '图库里一共 {photos} 张',
    ],
    galleryLightbox: [
      '慢点翻，我还没看清',
      '这张我也想放大看看',
      '大图里细节多，值得多看两眼',
    ],
    projects: [
      '这些都是一个个熬夜堆出来的',
      '想看看哪个项目怎么做的？',
      '项目里有几个我自己也在用',
    ],
    night: [
      '这个点了，早点睡吧',
      '夜里页面会变蓝，我调的',
      '你是不是该睡了…',
      '我不催，但真的挺晚了',
    ],
    idle: [
      '在呢',
      '有事没事都可以叫我',
      '摸摸头也可以（我不躲）',
      '我就在这儿，不吵你',
      '安静陪你一会儿',
    ],
  };

  // ---------- 采集当前页面在显示什么 ----------
  function visibleView() {
    // 文章详情页（article.html）先认出来，它没有 view-* 容器
    if (doc.querySelector('.article-header, .article-title, .article-content')) return 'article';

    const map = {
      'view-home': 'home',
      'view-blog': 'blog',
      'view-gallery': 'gallery',
      'view-projects': 'projects',
    };
    for (const id in map) {
      const el = doc.getElementById(id);
      if (el && getComputedStyle(el).display !== 'none') return map[id];
    }
    return 'home';
  }

  function collect() {
    const view = visibleView();
    const ctx = {
      view,
      viewSince: STATE.viewSince,
      stuckSec: Math.round((Date.now() - STATE.viewSince) / 1000),
    };

    const root = doc.documentElement;
    ctx.period = root.getAttribute('data-period') || '';
    const clock = doc.getElementById('hvClockTime');
    ctx.time = clock && clock.textContent.trim() ? clock.textContent.trim() : '';
    if (!ctx.time) {
      const now = new Date();
      ctx.time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    }

    // 首页：精选文章标题 + 简报标题 + 数字
    if (view === 'home') {
      ctx.posts = [...doc.querySelectorAll('.hv-car-title, .hv-post-title')].map((e) => e.textContent.trim()).slice(0, 5);
      ctx.news = [...doc.querySelectorAll('#newsList .news-item')].map((e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)).slice(0, 4);
      ctx.statPosts = (doc.getElementById('homeCtaPosts') || {}).textContent || '';
      ctx.statPhotos = (doc.getElementById('homeCtaPhotos') || {}).textContent || '';
      ctx.statProjects = (doc.getElementById('homeCtaProjects') || {}).textContent || '';
    }

    // 文章页：标题 + 读到哪了
    if (view === 'article') {
      const h = doc.querySelector('.article-title, h1.article-title, .post-title, article h1, h1');
      ctx.article = h ? h.textContent.trim() : '';
      const scroller = doc.getElementById('scrollArea') || doc.scrollingElement;
      if (scroller) {
        const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
        ctx.progress = Math.round(Math.min(1, scroller.scrollTop / max) * 100);
      }
      const visiblePara = [...doc.querySelectorAll('.article-content p, article p, .article-body p')]
        .find((p) => {
          const r = p.getBoundingClientRect();
          return r.top >= 0 && r.top < global.innerHeight * 0.7;
        });
      if (visiblePara) ctx.reading = visiblePara.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
    }

    // 图库：当前大图
    if (view === 'gallery') {
      const lb = doc.getElementById('galleryLightbox');
      const open = lb && getComputedStyle(lb).display !== 'none';
      const img = doc.getElementById('galleryLightboxImg');
      ctx.lightboxOpen = !!open;
      ctx.galleryCount = Array.isArray(global.__galleryImages) ? global.__galleryImages.length : 0;
      if (open && img) {
        ctx.photo = img.getAttribute('src') || '';
        ctx.photoIndex = Number(global.__galleryIndex) || 0;
        ctx.photoTotal = Array.isArray(global.__galleryImages) ? global.__galleryImages.length : 0;
      }
    }

    if (view === 'projects') {
      ctx.projectNames = [...doc.querySelectorAll('.projects-grid a, #projectsGithubGrid a, #deployedProjects a')]
        .map((a) => a.textContent.replace(/\s+/g, ' ').trim().slice(0, 30)).slice(0, 6);
    }

    ctx.sectionLabel = { home: '主页', blog: '文章列表', gallery: '图库', projects: '项目', article: '文章页' }[view] || '页面';
    return ctx;
  }

  // ---------- 气泡 ----------
  function bubbleEl() { return doc.getElementById('deskPetBubble'); }

  function placeBubble() {
    const core = global.PetCore;
    if (core && typeof core.placeBubble === 'function') { core.placeBubble(); return; }
    if (global.PetBoot && typeof global.PetBoot.placeBubble === 'function') { global.PetBoot.placeBubble(); return; }
    global.BlogApp?.placePetBubble?.();
  }

  function say(text, ms, opts) {
    const el = bubbleEl();
    if (!el || !text) return;
    el.textContent = text;
    el.classList.remove('is-below');
    el.classList.add('is-show');
    placeBubble();
    clearTimeout(STATE.bubbleTimer);
    STATE.bubbleTimer = setTimeout(
      () => el.classList.remove('is-show'),
      ms || Math.min(9000, 2400 + text.length * 70)
    );
    if (!opts || opts.log !== false) logPush('assistant', text);
    if (STATE.ttsOn && (!opts || opts.speak !== false) && STATE.busy) speak(text);
  }

  function logEl() { return doc.getElementById('petChatLog'); }

  function logPush(role, text) {
    appendMsg(role, text);
    if (role === 'user' || role === 'assistant') {
      STATE.history.push({ role, content: text });
      if (STATE.history.length > 16) STATE.history = STATE.history.slice(-16);
    }
  }

  // 只写面板、不进 AI 上下文（用于开场白之类）；没有消息区时什么都不做
  function appendMsg(role, text) {
    const box = logEl();
    if (!box) return;
    const item = doc.createElement('div');
    item.className = 'pet-msg pet-msg-' + role;
    item.textContent = text;
    box.appendChild(item);
    while (box.children.length > 40) box.firstElementChild.remove();
    box.scrollTop = box.scrollHeight;
  }

  // 流式回复：边收边写同一个气泡，收完再进历史
  function logStreamStart() {
    const box = logEl();
    if (!box) return null;
    const item = doc.createElement('div');
    item.className = 'pet-msg pet-msg-assistant is-streaming';
    box.appendChild(item);
    box.scrollTop = box.scrollHeight;
    STATE.streamEl = item;
    return item;
  }

  // 注意：历史记录和 DOM 解耦 —— 极简输入条没有消息区，但多轮上下文仍要保留
  function logStreamEnd(text) {
    const item = STATE.streamEl;
    STATE.streamEl = null;
    if (item) item.classList.remove('is-streaming');
    if (text) {
      if (item) item.textContent = text;
      STATE.history.push({ role: 'assistant', content: text });
      if (STATE.history.length > 16) STATE.history = STATE.history.slice(-16);
      const box = logEl();
      if (box) box.scrollTop = box.scrollHeight;
    } else if (item) {
      item.remove();
    }
  }

  // ---------- 对话历史：只存在内存里，刷新 / 换页就清空 ----------
  function clearHistory() {
    STATE.history = [];
    // 顺便把旧版本留在本机的那份也抹掉
    if (ls) {
      try { ls.removeItem('pet-history'); } catch (e) { /* 隐私模式忽略 */ }
    }
  }

  // ---------- 角色状态 ----------
  function isSleeping() {
    const core = global.PetCore;
    if (core && typeof core.sleeping === 'boolean' && core.ready) return core.sleeping;
    return doc.getElementById('deskPet')?.dataset.state === 'sleep';
  }

  function petState(name, backMs) {
    const core = global.PetCore;
    if (core && typeof core.setState === 'function' && core.engine) { core.setState(name, backMs); return; }
    const eng = global.BlogApp?.petEngine || global.PetBoot?.engine || global.PetBootEngine;
    if (!eng || typeof eng.setState !== 'function') return;
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
  // 音色是本机资源：优先访客在面板里选的，其次后台设置的关键词，最后自动挑中文语音
  function voiceList() {
    const synth = global.speechSynthesis;
    if (!synth || typeof synth.getVoices !== 'function') return [];
    const all = synth.getVoices() || [];
    const zh = all.filter((v) => /^zh/i.test(v.lang || ''));
    return zh.length ? zh : all;
  }

  function savedVoice() {
    try { return ls ? ls.getItem('pet-tts-voice') : null; } catch (e) { return null; }
  }

  function pickVoice() {
    const list = voiceList();
    if (!list.length) return null;
    const saved = savedVoice();
    const want = (saved && saved !== 'auto' ? saved : (STATE.ttsVoice || '')).trim().toLowerCase();
    if (want) {
      const hit = list.find((v) => (v.name || '').toLowerCase().includes(want));
      if (hit) return hit;
    }
    return list.find((v) => v.default) || list[0] || null;
  }

  function speak(text) {
    if (!global.speechSynthesis || !text) return;
    try {
      const u = new global.SpeechSynthesisUtterance(text.replace(/[*_`#>|]/g, '').slice(0, 160));
      u.lang = 'zh-CN';
      const rate = Number(STATE.ttsRate);
      const pitch = Number(STATE.ttsPitch);
      u.rate = Number.isFinite(rate) ? Math.min(1.6, Math.max(0.6, rate)) : 1.05;
      u.pitch = Number.isFinite(pitch) ? Math.min(1.6, Math.max(0.6, pitch)) : 1.1;
      const voice = pickVoice();
      if (voice) u.voice = voice;
      global.speechSynthesis.cancel();
      global.speechSynthesis.speak(u);
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 问 AI ----------
  function buildPrompt(ctx) {
    const name = STATE.name || '渡鸦';
    const bits = [
      '你是这个个人博客站里的桌宠「' + name + '」，一只住在网页右下角的小生物。',
      '说话短、口语、有点小情绪，可以偶尔用「喵」，但不要每句都卖萌，不要长篇大论。',
      '你能看到访客此刻正在看的页面，回答时优先结合下面的现场信息，不要编造没看到的内容。',
      '被问身份时，说自己是站里的桌宠，不要说自己是大模型。',
      '',
      '【此刻现场】',
      '- 页面：' + ctx.sectionLabel + '（' + ctx.view + '）',
      '- 本地时间：' + ctx.time + (ctx.period ? '，天色：' + (PERIOD[ctx.period] || ctx.period) : ''),
      '- 在这个页面已经待了：' + ctx.stuckSec + ' 秒',
    ];
    if (STATE.persona) bits.push('', '【站主给的人设补充】', STATE.persona);
    if (ctx.posts && ctx.posts.length) bits.push('- 首页精选文章：' + ctx.posts.join(' / '));
    if (ctx.news && ctx.news.length) bits.push('- 今日简报：' + ctx.news.join(' / '));
    if (ctx.statPosts) bits.push('- 站点数字：' + ctx.statPosts + ' 篇文章 / ' + ctx.statPhotos + ' 张照片 / ' + ctx.statProjects + ' 个项目');
    if (ctx.article) bits.push('- 正在读的文章：' + ctx.article + (typeof ctx.progress === 'number' ? '（读到 ' + ctx.progress + '%）' : ''));
    if (ctx.reading) bits.push('- 正在看的段落：「' + ctx.reading + '」');
    if (ctx.lightboxOpen) bits.push('- 图库里正打开一张大图（第 ' + (ctx.photoIndex + 1) + ' 张 / 共 ' + ctx.photoTotal + ' 张）');
    else if (ctx.galleryCount) bits.push('- 图库共 ' + ctx.galleryCount + ' 张照片');
    if (ctx.projectNames && ctx.projectNames.length) bits.push('- 项目列表：' + ctx.projectNames.join(' / '));
    bits.push('', '要求：日常聊天简短自然；用户要求解释文字或总结时，给出清晰、有依据的说明，必要时分点，不编造文章中未提供的信息。');
    return bits.join('\n');
  }

  async function askAI(userText, onDelta) {
    const ctx = collect();
    const messages = [
      { role: 'system', content: buildPrompt(ctx) },
      ...STATE.history.slice(-8),
    ];
    if (userText && messages.at(-1)?.content !== userText) messages.push({ role: 'user', content: userText });

    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) };
    if (global.AbortSignal && typeof AbortSignal.timeout === 'function') options.signal = AbortSignal.timeout(30000);
    const res = await fetch('/api/ai', options);
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (!ctype.includes('text/event-stream')) {
      const data = await res.json().catch(() => null);
      const t = data && data.choices && data.choices[0]
        && ((data.choices[0].message && data.choices[0].message.content)
          || (data.choices[0].delta && data.choices[0].delta.content));
      const text = t || '';
      if (onDelta && text) onDelta(text, text);
      return text;
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
          if (delta) {
            reply += delta;
            if (onDelta) onDelta(delta, reply);
          }
        } catch (e) { /* 跳过不完整分片 */ }
      }
    }
    return reply;
  }

  // ---------- 主动说话 ----------
  function fill(line, ctx) {
    return line
      .replace('{period}', PERIOD[ctx.period] || '现在')
      .replace('{posts}', ctx.statPosts || '不少')
      .replace(/{photos}/g, String(ctx.galleryCount || ctx.statPhotos || '很多'))
      .replace('{progress}', String(typeof ctx.progress === 'number' ? ctx.progress : 0))
      .replace('{title}', ctx.article || '这篇');
  }

  function poolFor(ctx) {
    const hour = new Date().getHours();
    const night = hour >= 23 || hour < 6;
    if (night) return LINES.night.concat(LINES.idle);
    if (ctx.view === 'gallery' && ctx.lightboxOpen) return LINES.galleryLightbox;
    if (ctx.view === 'article') {
      if (typeof ctx.progress === 'number' && ctx.progress >= 80) return LINES.articleEnd;
      if (typeof ctx.progress === 'number' && ctx.progress < 10) return LINES.articleStart;
      return LINES.article;
    }
    return LINES[ctx.view] || LINES.idle;
  }

  function pickLocalLine(ctx) {
    const context = ctx || collect();
    let pool = poolFor(context);
    // 看太久 / 什么也没发生：混一点闲话，别老提具体内容
    if (context.stuckSec > 240 && Math.random() < 0.35) pool = pool.concat(LINES.idle);

    let line = '';
    for (let i = 0; i < 6; i++) {
      const candidate = fill(pool[Math.floor(Math.random() * pool.length)], context);
      if (!STATE.recent.includes(candidate)) { line = candidate; break; }
      line = candidate;
    }
    STATE.recent.push(line);
    if (STATE.recent.length > 4) STATE.recent = STATE.recent.slice(-4);
    return line;
  }

  // 点桌宠时对外的一句话（PetCore 会来拿）
  function pickLine() {
    return pickLocalLine(collect());
  }

  async function autoTalk(force) {
    if (!STATE.enabled || STATE.busy) return;
    if (isSleeping() || doc.hidden) return;
    if (doc.activeElement?.matches?.('input, textarea, [contenteditable="true"]')) return;

    const now = Date.now();
    if (!force && now - STATE.lastAutoAt < STATE.minGap) return;
    if (now - STATE.lastUserAt < 20000) return;   // 刚聊过就别插话

    STATE.lastAutoAt = now;
    const ctx = collect();
    // Ambient greetings stay local; AI requests are reserved for explicit questions.
    say(pickLocalLine(ctx), 5200, { log: false });
    petState(ctx.view === 'article' ? 'thinking' : 'curious', 2600);
  }

  function scheduleAuto() {
    clearTimeout(STATE.timer);
    if (!STATE.enabled || doc.hidden) return;
    const hour = new Date().getHours();
    const night = hour >= 23 || hour < 6;
    const [lo, hi] = night ? STATE.nightAutoMs : STATE.autoMs;
    const wait = lo + Math.random() * (hi - lo);
    STATE.timer = setTimeout(() => {
      if (Date.now() - STATE.lastUserAt > 25000) autoTalk();
      scheduleAuto();
    }, wait);
  }

  // ---------- 语音输入 ----------
  let recognition = null;
  let listening = false;
  let voiceMode = false;
  let recRestartTimer = 0;

  function initVoice() {
    const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    const mic = doc.getElementById('petMic');
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

    rec.onstart = () => {
      listening = true;
      mic.classList.add('is-listening');
      petState('listening', 0);
      if (!voiceMode) say('在听…', 9000, { log: false, speak: false });
    };
    rec.onresult = (e) => {
      let interim = '';
      let finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      const live = (finalText || interim).trim();
      if (!live) return;
      // 召唤词：常驻监听时先看是不是在叫它（命中了就不当聊天内容处理）
      if (wakeListening() && !voiceMode && matchWake(live)) {
        onWakeWord();
        return;
      }
      const el = bubbleEl();
      if (el) {
        el.textContent = live;
        el.classList.remove('is-below');
        el.classList.add('is-show');
        placeBubble();
      }
      const input = doc.getElementById('petChatInput');
      if (input) input.value = live.slice(0, 300);
      if (finalText) {
        STATE.lastUserAt = Date.now();
        send(finalText.trim());
      }
    };
    rec.onerror = (e) => {
      listening = false;
      mic.classList.remove('is-listening');
      if (e.error === 'not-allowed') {
        say('麦克风没开权限，我收不到声音', 5000);
        stopVoiceMode();
        stopWake();
      } else if (e.error === 'no-speech') {
        if (!voiceMode && !wakeListening()) say('没听到声音…再试一次？', 4000);
      } else if (e.error !== 'aborted') {
        say('没听清…再说一次？', 4000);
      }
      if (!STATE.busy) petState(voiceMode ? 'listening' : 'idle', 0);
    };
    rec.onend = () => {
      listening = false;
      mic.classList.remove('is-listening');
      // 正在等 AI 回复时别把 thinking 顶掉
      if (!STATE.busy) petState(voiceMode ? 'listening' : 'idle', 0);
      // 对话模式：浏览器自己停了就接上（等回复期间先别抢麦克风）
      if (voiceMode && !doc.hidden) restartRecognition(400);
      // 召唤词监听：同理，浏览器自己停就接着听
      else if (wakeListening() && !doc.hidden) scheduleWakeListen(600);
    };

    mic.addEventListener('click', (e) => {
      e.stopPropagation();
      if (voiceMode) { stopVoiceMode('对话模式关掉了'); return; }
      if (listening) { try { rec.stop(); } catch (err) { /* 忽略 */ } return; }
      try { rec.start(); } catch (err) { /* 已在启动中 */ }
    });
    recognition = rec;
  }

  // ---------- 召唤词（语音唤醒） ----------
  // 常驻识别里匹配关键词；命中后按后台设置唤出对话框 / 直接进实时对话 / 只应一声。
  // 注意：这是"一直听着"的，耗电也涉及隐私，所以默认关闭、15 分钟没被叫到自动关。
  const WAKE = { enabled: false, allowed: true, autoStarted: false, hitAt: 0, listenTimer: 0, idleTimer: 0, button: null };
  const WAKE_ALIASES = ['渡鸦', '渡鸭', '渡亚', '度鸦', '杜鸦', '毒鸦'];
  const WAKE_ACTIONS = ['panel', 'voice', 'line'];

  function wakeWords() {
    const base = String(STATE.wakeWord || '').trim() || '渡鸦';
    const list = WAKE_ALIASES.slice();
    if (!list.includes(base)) list.unshift(base);
    return list;
  }

  function matchWake(text) {
    const said = String(text || '').replace(/[\s,，。.、!！?？、~～]/g, '');
    if (!said) return false;
    return wakeWords().some((word) => said.indexOf(word.replace(/\s+/g, '')) !== -1);
  }

  function wakeListening() {
    return WAKE.enabled && !voiceMode && !!recognition;
  }

  function scheduleWakeListen(delay) {
    clearTimeout(WAKE.listenTimer);
    if (!wakeListening() || doc.hidden) return;
    WAKE.listenTimer = setTimeout(() => {
      if (!wakeListening() || doc.hidden) return;
      try {
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.start();
      } catch (e) { /* 可能已经在跑 */ }
    }, delay || 0);
  }

  function updateWakeUI() {
    const btn = WAKE.button || doc.getElementById('petWakeToggle');
    if (!btn) return;
    // 后台关掉「允许语音召唤」后，这颗 👂 直接不显示
    btn.style.display = WAKE.allowed ? '' : 'none';
    const word = STATE.wakeWord || '渡鸦';
    btn.classList.toggle('is-on', WAKE.enabled);
    btn.setAttribute('aria-pressed', String(WAKE.enabled));
    btn.title = WAKE.enabled ? '停止召唤词监听（喊「' + word + '」就能叫我）' : '开启召唤词（喊「' + word + '」叫我）';
    btn.setAttribute('aria-label', btn.title);
  }

  // 由 pet-core 按后台设置调用：站主关掉后访客就看不到这个入口
  function setWakeAllowed(allowed) {
    WAKE.allowed = allowed !== false;
    if (!WAKE.allowed && WAKE.enabled) stopWake(true);
    updateWakeUI();
  }

  function onWakeWord() {
    if (Date.now() - WAKE.hitAt < 2500) return;
    WAKE.hitAt = Date.now();
    const action = WAKE_ACTIONS.includes(STATE.wakeAction) ? STATE.wakeAction : 'panel';
    stopWake(true);              // 命中后先停，避免同一句里连续触发
    STATE.lastUserAt = Date.now();
    if (action === 'voice') {
      startVoiceMode();
      return;
    }
    if (action === 'line') {
      say(pickLine(), 4200, { log: false });
      petState('happy', 1400);
      return;
    }
    say('在呢', 2200, { log: false });
    openPanel();
  }

  function startWake() {
    if (WAKE.enabled) return true;
    if (!WAKE.allowed) {
      say('站主把语音召唤关掉了', 4000, { log: false });
      return false;
    }
    if (!recognition) {
      say('这个浏览器听不见我…换 Chrome / Edge 再说', 5000, { log: false });
      return false;
    }
    WAKE.enabled = true;
    updateWakeUI();
    const word = STATE.wakeWord || '渡鸦';
    say('叫我「' + word + '」就行，我先听着', 5200, { log: false });
    petState('listening', 2200);
    scheduleWakeListen(0);
    clearTimeout(WAKE.idleTimer);
    WAKE.idleTimer = setTimeout(() => {
      if (WAKE.enabled) {
        stopWake(true);
        say('我先不听了，想叫我的话再点 👂', 4200, { log: false });
      }
    }, 15 * 60 * 1000);
    return true;
  }

  function stopWake(silent) {
    const was = WAKE.enabled;
    WAKE.enabled = false;
    clearTimeout(WAKE.listenTimer);
    clearTimeout(WAKE.idleTimer);
    updateWakeUI();
    if (!voiceMode) {
      try { if (recognition) recognition.stop(); } catch (e) { /* 忽略 */ }
    }
    if (was && !silent) say('好，我不听了', 3200, { log: false });
    return was;
  }

  function toggleWake() {
    if (WAKE.enabled) {
      stopWake(false);
      return false;
    }
    return startWake();
  }

  // 前台没有召唤词按钮了：靠后台开关 + 用户第一次和桌宠互动后再开麦
  // （浏览器要求有用户手势才允许启动语音识别，所以不能页面一加载就听）
  function maybeWake() {
    if (!WAKE.allowed || WAKE.enabled || WAKE.autoStarted) return false;
    WAKE.autoStarted = true;
    return startWake();
  }

  // ---------- 对话模式（连点三下桌宠 / 悬停选「聊天」后开）：边说边答 ----------
  function restartRecognition(delay) {
    clearTimeout(recRestartTimer);
    if (!recognition || !voiceMode) return;
    recRestartTimer = setTimeout(() => {
      if (!voiceMode || !recognition || doc.hidden) return;
      try {
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.start();
      } catch (e) { /* 可能已经在跑 */ }
    }, delay || 0);
  }

  function startVoiceMode() {
    if (voiceMode) return true;
    if (!recognition) {
      say('这个浏览器听不见我…换 Chrome / Edge 再说', 5000, { log: false });
      return false;
    }
    voiceMode = true;
    STATE.lastUserAt = Date.now();
    // 实时对话：不打开对话框，直接在桌宠气泡里说
    if (!STATE.ttsOn) toggleTTS(true);
    doc.getElementById('deskPet')?.classList.add('is-voice-mode');
    say('直接说话就行，不用开对话框；再点一下麦克风或连点三下退出', 6500, { log: false });
    petState('listening', 0);
    restartRecognition(0);
    return true;
  }

  function stopVoiceMode(reason) {
    if (!voiceMode) return;
    voiceMode = false;
    clearTimeout(recRestartTimer);
    doc.getElementById('deskPet')?.classList.remove('is-voice-mode');
    try { recognition && recognition.stop(); } catch (e) { /* 忽略 */ }
    if (!STATE.busy) petState('idle', 0);
    if (reason) say(reason, 4200, { log: false, speak: false });
  }

  function toggleVoiceMode() {
    if (voiceMode) { stopVoiceMode('对话模式关掉了'); return false; }
    return startVoiceMode();
  }

  // ---------- 发一句话 ----------
  async function send(text) {
    const word = String(text || '').trim();
    if (!word || STATE.busy) return;
    STATE.lastUserAt = Date.now();
    logPush('user', word);
    petState('thinking', 0);
    STATE.busy = true;
    setSending(true);

    const el = bubbleEl();
    if (el) {
      el.textContent = '…';
      el.classList.remove('is-below');
      el.classList.add('is-show');
      placeBubble();
    }

    let reply = '';
    try {
      reply = (await askAI(word, (delta, full) => {
        const box = el;
        if (box && full.length <= 120) box.textContent = full;
        if (!STATE.streamEl) logStreamStart();
        if (STATE.streamEl) STATE.streamEl.textContent = full;
        const log = logEl();
        if (log) log.scrollTop = log.scrollHeight;
      })).trim();
      logStreamEnd(reply);
      reply = reply || '喵…没想好怎么回。';
      say(reply, 12000, { log: false, speak: true });
      petState('excited', 1600);
    } catch (e) {
      logStreamEnd('');
      clearTimeout(STATE.bubbleTimer);
      const why = String(e && e.message || e).slice(0, 40);
      say('AI 还没接上（' + why + '）', 6000, { speak: false });
      petState('confused', 1500);
    } finally {
      STATE.busy = false;
      setSending(false);
    }
  }

  function setSending(busy) {
    const form = doc.getElementById('petChatForm');
    form?.setAttribute('aria-busy', String(busy));
    const button = form?.querySelector('[type=submit]');
    if (button) {
      button.disabled = busy;
      button.textContent = busy ? '…' : '↑';
      button.setAttribute('aria-label', busy ? '正在回复' : '发送消息');
    }
  }

  // ---------- 面板 ----------
  function setPressed(button, on) {
    if (!button) return;
    button.setAttribute('aria-pressed', String(!!on));
    button.classList.toggle('is-on', !!on);
  }

  function syncTools() {
    const mute = doc.getElementById('petQuietToggle');
    if (mute) {
      setPressed(mute, !STATE.enabled);
      mute.title = STATE.enabled ? '安静一会儿' : '继续陪我';
    }
    const tts = doc.getElementById('petTtsToggle');
    if (tts) {
      setPressed(tts, STATE.ttsOn);
      tts.title = STATE.ttsOn ? '关掉朗读' : '朗读回复';
    }
    // 朗读开着才显示音色选择
    const row = doc.getElementById('petVoiceRow');
    if (row) {
      row.hidden = !STATE.ttsOn;
      if (STATE.ttsOn && doc.getElementById('petVoiceSelect')) {
        fillVoiceOptions(doc.getElementById('petVoiceSelect'));
      }
    }
  }

  // 面板里的音色下拉（只有朗读打开时才出现）
  function fillVoiceOptions(sel) {
    if (!sel || typeof doc.createElement !== 'function') return;
    const list = voiceList();
    const current = pickVoice();
    const saved = savedVoice();
    sel.textContent = '';
    const auto = doc.createElement('option');
    auto.value = 'auto';
    auto.textContent = current ? '自动（' + current.name + '）' : '自动';
    sel.appendChild(auto);
    list.forEach((v) => {
      const opt = doc.createElement('option');
      opt.value = v.name;
      opt.textContent = v.name + (v.lang ? ' · ' + v.lang : '');
      sel.appendChild(opt);
    });
    sel.value = saved && saved !== 'auto' ? saved : 'auto';
    if (!sel.value) sel.value = 'auto';
  }

  function initVoicePicker() {
    const form = doc.getElementById('petChatForm');
    if (!form || !form.parentNode || doc.getElementById('petVoiceRow')) return;
    // 极简输入条里没有音色下拉的位置，只在带标题栏的完整面板里才插入
    if (!doc.querySelector('.pet-chat-head')) return;
    if (typeof doc.createElement !== 'function') return;
    const row = doc.createElement('div');
    row.className = 'pet-voice-row';
    row.id = 'petVoiceRow';
    row.hidden = true;
    const label = doc.createElement('label');
    label.textContent = '音色';
    label.setAttribute('for', 'petVoiceSelect');
    const sel = doc.createElement('select');
    sel.id = 'petVoiceSelect';
    row.appendChild(label);
    row.appendChild(sel);
    form.parentNode.insertBefore(row, form);
    sel.addEventListener('change', () => {
      try { if (ls) ls.setItem('pet-tts-voice', sel.value || 'auto'); } catch (e) { /* 忽略 */ }
      const picked = pickVoice();
      if (picked) speak('这样说话，' + (STATE.name || '我') + '在这儿');
      else say('这台机器没装语音包…换 Chrome / Edge 试试', 4200, { log: false });
    });
    // 系统语音列表是异步的
    const synth = global.speechSynthesis;
    if (synth && typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', () => fillVoiceOptions(sel));
    }
    fillVoiceOptions(sel);
  }

  function openPanel() {
    const wrap = doc.getElementById('petChat');
    if (!wrap) return;
    wrap.classList.add('is-open');
    const input = doc.getElementById('petChatInput');
    const log = logEl();
    if (log && !log.children.length) {
      if (STATE.history.length) {
        // 上一页 / 上次刷新的对话：接着聊，不另起一段
        STATE.history.slice(-6).forEach((m) => appendMsg(m.role, m.content));
      } else {
        const ctx = collect();
        appendMsg('assistant', '我是' + (STATE.name || '渡鸦') + '，住在右下角。' + (ctx.view === 'article' && ctx.article ? '你正在读《' + ctx.article + '》。' : '') + '想聊什么？');
      }
    }
    // 面板跟着桌宠走（放不下会自己翻到另一侧）
    const place = () => { if (global.PetCore && global.PetCore.layoutPanel) global.PetCore.layoutPanel(); };
    place();
    setTimeout(place, 30);
    setTimeout(() => input && input.focus(), 120);
    maybeWake();
  }

  function closePanel() {
    doc.getElementById('petChat')?.classList.remove('is-open');
    if (voiceMode) stopVoiceMode();
  }

  function initPanel() {
    const wrap = doc.getElementById('petChat');
    const form = doc.getElementById('petChatForm');
    const input = doc.getElementById('petChatInput');
    const close = doc.getElementById('petChatClose');
    if (!wrap) return;

    form && form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = (input && input.value || '').trim();
      if (!text || STATE.busy) return;
      input.value = '';
      send(text);
    });

    close && close.addEventListener('click', (e) => { e.stopPropagation(); closePanel(); });

    // 点气泡展开对话
    const bubble = bubbleEl();
    bubble && bubble.addEventListener('click', () => openPanel());

    // 桌宠本体单击（短按）也打开面板？——不，单击是摸摸，保持安静；双击是睡觉。

    // 安静模式 / 朗读
    doc.getElementById('petQuietToggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      setQuiet(STATE.enabled);
    });
    doc.getElementById('petTtsToggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTTS();
    });

    // 召唤词不再有前台按钮：完全由后台「允许语音召唤」控制，
    // 用户第一次和桌宠互动后再开始听（浏览器要求有手势才能开麦）。

    // Esc 关闭；点面板外面也关闭
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && wrap.classList.contains('is-open')) closePanel();
    });
    doc.addEventListener('pointerdown', (e) => {
      if (!wrap.classList.contains('is-open')) return;
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#petChat') || t.closest('#deskPet')) return;
      closePanel();
    });

    syncTools();
    updateWakeUI();
  }

  // ---------- 启动 ----------
  function start() {
    if (STATE.started) return;
    STATE.started = true;
    try {
      STATE.enabled = ls.getItem('pet-quiet') !== 'true';
      STATE.ttsOn = ls.getItem('pet-tts') === 'true';
    } catch (_) { /* 忽略 */ }
    initPanel();
    initVoicePicker();
    initVoice();
    clearHistory();
    scheduleAuto();

    doc.addEventListener('visibilitychange', () => {
      if (doc.hidden) {
        clearTimeout(STATE.timer);
        if (WAKE.enabled) {
          try { if (recognition) recognition.stop(); } catch (e) { /* 忽略 */ }
        }
      } else {
        scheduleAuto();
        if (WAKE.enabled) scheduleWakeListen(500);
      }
    });

    // 视图切换：过几秒打一句招呼（有冷却，来回切不刷屏）
    let lastProgress = -1;
    const watchView = () => {
      if (doc.hidden) return;
      const v = visibleView();
      if (v !== STATE.lastView) {
        const first = !STATE.lastView;
        STATE.lastView = v;
        STATE.viewSince = Date.now();
        lastProgress = -1;
        if (first) return;
        const now = Date.now();
        if (now - STATE.lastSwitchAt < 15000) return;
        STATE.lastSwitchAt = now;
        setTimeout(() => {
          if (Date.now() - STATE.lastUserAt < 15000) return;
          autoTalk(true);
        }, 3200);
      }
      // 事件驱动：文章快读到结尾时说一句（每篇一次）
      if (v === 'article') {
        const ctx = collect();
        const p = typeof ctx.progress === 'number' ? ctx.progress : 0;
        const key = 'pet-done-' + (ctx.article || 'article').slice(0, 60);
        if (lastProgress >= 0 && lastProgress < 90 && p >= 95) {
          let done = false;
          try { done = ls.getItem(key) === '1'; } catch (_) { done = false; }
          if (!done) {
            try { ls.setItem(key, '1'); } catch (_) { /* 忽略 */ }
            if (STATE.enabled && !isSleeping() && Date.now() - STATE.lastUserAt > 20000) {
              say('读完了？这篇挺长的，眼睛歇会儿', 6500, { log: false });
              petState('happy', 1800);
            }
          }
        }
        lastProgress = p;
      } else {
        lastProgress = -1;
      }
    };
    setInterval(watchView, 2000);
    watchView();

    // 深夜提醒：一天最多一次
    const hour = new Date().getHours();
    const dayKey = 'pet-night-' + new Date().toDateString();
    let reminded = false;
    try { reminded = ls.getItem(dayKey) === '1'; } catch (_) { reminded = false; }
    if (STATE.enabled && !reminded && (hour >= 23 || hour < 5)) {
      setTimeout(() => {
        if (!STATE.enabled || doc.hidden || isSleeping()) return;
        try { ls.setItem(dayKey, '1'); } catch (_) { /* 忽略 */ }
        say('这个点了，别熬太晚喵', 7000, { log: false });
      }, 6000);
    }
  }

  // persist=false：后台设置下发的默认值，不写进访客的 localStorage（否则会覆盖他自己的选择）
  function setQuiet(quiet, opts) {
    STATE.enabled = !quiet;
    clearTimeout(STATE.timer);
    clearTimeout(STATE.bubbleTimer);
    if (!opts || opts.persist !== false) {
      try { ls.setItem('pet-quiet', String(!!quiet)); } catch (_) { /* 忽略 */ }
    }
    if (quiet) {
      bubbleEl()?.classList.remove('is-show');
      global.PetCore?.setState('drowsy', 1800);
    } else {
      scheduleAuto();
      global.PetCore?.setState('happy', 1500);
    }
    syncTools();
  }

  function toggleTTS(on, opts) {
    STATE.ttsOn = on === undefined ? !STATE.ttsOn : !!on;
    if (!opts || opts.persist !== false) {
      try { ls.setItem('pet-tts', String(STATE.ttsOn)); } catch (_) { /* 忽略 */ }
    }
    if (!STATE.ttsOn && global.speechSynthesis) {
      try { global.speechSynthesis.cancel(); } catch (_) { /* 忽略 */ }
    }
    syncTools();
    return STATE.ttsOn;
  }

  // 后台设置里的名字 / 口吻
  function setName(name) {
    const next = String(name || '').trim().slice(0, 20);
    if (!next || next === STATE.name) return;
    STATE.name = next;
    const title = doc.querySelector('.pet-chat-title');
    if (title) title.textContent = next;
  }

  global.PetMind = {
    start,
    collect,
    say,
    send,
    autoTalk,
    pickLine,
    pickLocalLine,
    openPanel,
    closePanel,
    setQuiet,
    toggleTTS,
    setName,
    startVoiceMode,
    stopVoiceMode,
    toggleVoiceMode,
    startWake,
    stopWake,
    toggleWake,
    setWakeAllowed,
    maybeWake,
    matchWake,
    wakeWords,
    isSleeping,
    get wakeEnabled() { return WAKE.enabled; },
    get voiceMode() { return voiceMode; },
    get listening() { return !!listening; },
    get recognition() { return recognition; },
    state: STATE,
  };
})(window);
