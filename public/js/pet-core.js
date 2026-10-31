/* 桌宠内核：形象引擎 + 交互（一次绑定，全站共用）
   ------------------------------------------------------------
   收口 index.html（app.js）与其它页面（pet-boot.js）里两份重复实现：
     · 引擎按需创建（grok spring 角色，延迟加载也不怕，会自己等）
     · 拖拽：指针捕获 + rAF 合帧 + 松手惯性 + 边缘贴边 + 轻微倾斜
     · 单击（动作 + 稍后冒话，给双击留窗口）/ 双击（睡觉·唤醒）
     · 位置：按视口比例记忆，窗口变化后自动夹回可见区域
     · 气泡：rAF 合帧定位，四边都夹在视口内，箭头指向宠物
     · 睡觉状态跨页面记住；空闲小动作 / 首次见面打招呼
   说话内容与 AI 对话交给 pet-mind.js，这里只提供 say / setState / react。
*/
(function (global) {
  'use strict';

  const KEY_POS = 'deskpet_pos_v2';
  const KEY_POS_OLD = 'deskpet_pos';
  const KEY_ASLEEP = 'pet-asleep';
  const KEY_GREET = 'pet-greeted';

  const EDGE = 10;          // 贴边留白
  const PAD = 10;           // 气泡与视口边缘的最小距离

  const S = {
    ready: false,
    engine: null,
    sleeping: false,
    dragging: false,
    gliding: false,
    pos: null,
    stateTimer: 0,
    sayTimer: 0,
    idleTimer: 0,
    tapTimer: 0,
    engineTimer: 0,
    bubbleRaf: 0,
    reflowTimer: 0,
    lockUntil: 0,
    reduceMotion: false,
  };

  // 兼容浏览器全局与精简的测试环境（window 上未必有 document / localStorage）
  const doc = global.document || (typeof document !== 'undefined' ? document : null);
  const ls = (() => { try { return global.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null); } catch (e) { return null; } })();
  // 引擎不可用 / PetMind 未就绪时的兜底台词
  const FALLBACK = [
    '在呢',
    '点我可以聊天',
    '拖我去别的地方也行',
    '双击我就去睡觉',
    '我在这儿守着页面',
  ];

  const useRaf = typeof global.requestAnimationFrame === 'function'
    ? (fn) => global.requestAnimationFrame(fn)
    : (fn) => setTimeout(() => fn(Date.now()), 16);
  const cancelRaf = typeof global.cancelAnimationFrame === 'function'
    ? (id) => global.cancelAnimationFrame(id)
    : (id) => clearTimeout(id);

  // ---------- DOM 小工具 ----------
  function petEl() { return doc.getElementById('deskPet'); }
  function bodyEl() { return doc.getElementById('deskPetBody'); }
  function bubbleEl() { return doc.getElementById('deskPetBubble'); }

  function store(key, value) {
    try {
      if (value === undefined) return ls.getItem(key);
      ls.setItem(key, value);
    } catch (e) { /* 隐私模式忽略 */ }
    return null;
  }

  function bounds() {
    const pet = petEl();
    const w = (pet && pet.offsetWidth) || 56;
    const h = (pet && pet.offsetHeight) || 56;
    const vw = global.innerWidth || 1024;
    const vh = global.innerHeight || 800;
    return {
      w: w,
      h: h,
      minX: EDGE,
      minY: EDGE,
      maxX: Math.max(EDGE, vw - w - EDGE),
      maxY: Math.max(EDGE, vh - h - EDGE),
    };
  }

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  // ---------- 气泡 ----------
  function layoutBubble() {
    const bubble = bubbleEl();
    const pet = petEl();
    if (!bubble || !pet || !bubble.classList.contains('is-show')) return;
    const rect = pet.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const vw = global.innerWidth || 1024;
    const vh = global.innerHeight || 800;

    const cx = clamp(rect.left + rect.width / 2, bw / 2 + PAD, Math.max(bw / 2 + PAD, vw - bw / 2 - PAD));
    const above = rect.top - bh - 14;
    const below = rect.bottom + 14;
    const useBelow = above < PAD;
    const top = useBelow
      ? clamp(below, PAD, Math.max(PAD, vh - bh - PAD))
      : clamp(above, PAD, Math.max(PAD, vh - bh - PAD));

    bubble.classList.toggle('is-below', useBelow);
    // 箭头跟着宠物中心（气泡被夹到边上时不再指着空气）
    const arrow = clamp(Math.round(rect.left + rect.width / 2 - (cx - bw / 2)), 16, Math.max(16, bw - 16));
    bubble.style.setProperty('--deskpet-arrow-x', arrow + 'px');
    bubble.style.left = Math.round(cx) + 'px';
    bubble.style.top = Math.round(top) + 'px';
  }

  function placeBubble() {
    if (S.bubbleRaf) return;
    S.bubbleRaf = useRaf(() => {
      S.bubbleRaf = 0;
      layoutBubble();
    });
  }

  // 对话面板跟着桌宠走（桌面端）：优先放在桌宠上方，放不下就翻到下方，四边都夹在视口内
  function layoutPanel() {
    const panel = doc.getElementById('petChat');
    const pet = petEl();
    if (!panel || !pet || !panel.classList.contains('is-open')) return;
    // 窄屏交给 CSS（renewal.css 里有带 !important 的贴边规则，inline 覆盖不了）
    if ((global.innerWidth || 1024) <= 900) {
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
      return;
    }
    const pr = pet.getBoundingClientRect();
    const pw = panel.offsetWidth || 330;
    const ph = panel.offsetHeight || 220;
    const vw = global.innerWidth || 1024;
    const vh = global.innerHeight || 800;
    const pad = 12;
    const left = clamp(pr.left + pr.width / 2 - pw / 2, pad, Math.max(pad, vw - pw - pad));
    let top = pr.top - ph - 16;
    if (top < pad) top = Math.min(pr.bottom + 16, Math.max(pad, vh - ph - pad));
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  function say(text, ms) {
    const bubble = bubbleEl();
    if (!bubble || !text) return;
    bubble.textContent = text;
    bubble.classList.remove('is-below');
    bubble.classList.add('is-show');
    clearTimeout(S.sayTimer);
    placeBubble();
    // 气泡尺寸随文字变化，等下一帧再定一次位
    S.sayTimer = setTimeout(
      () => bubble.classList.remove('is-show'),
      ms || Math.min(9000, 2200 + String(text).length * 70)
    );
  }

  function hideBubble() {
    clearTimeout(S.sayTimer);
    S.sayTimer = 0;
    bubbleEl()?.classList.remove('is-show');
  }

  // ---------- 引擎 ----------
  function ensureEngine() {
    if (S.engine) return S.engine;
    const svg = doc.getElementById('grokPet');
    const Character = global.GrokCharacter;
    if (!svg || typeof Character !== 'function') return null;
    try {
      S.engine = new Character(svg, {
        shape: 'blob',
        color: 'black',
        scheme: 'light',
        mode: 'hold',                                   // 状态由我们手动切
        followPointer: CONFIG.gaze,                     // 眼睛一直跟着鼠标（后台可关）
        reduceMotion: S.reduceMotion,
        // 58px 的小身板下默认幅度几乎看不见，放大注视范围（眼睛会明确转向鼠标），
        // falloff 放大后「多远算看得很偏」从 120px 变成约 700px，鼠标在半个屏幕上移动时
        // 眼睛都能连续跟着转，而不是一离开门口就顶到极限。
        gazeRange: { x: 52, y: 34 },
        gazeClamp: 0.85,
        gazeFalloff: 12,
      });
      if (typeof S.engine.setInk === 'function') S.engine.setInk('#000000');
      S.engine.setState(S.sleeping ? 'sleeping' : 'idle', { resetEyes: true });
      S.engine.paused = !!doc.hidden;
      petEl()?.classList.add('has-engine');
      S.reduceMotion = !!S.engine.reduceMotion;
      try {
        global.dispatchEvent(new global.CustomEvent('pet:engine', { detail: { engine: S.engine } }));
      } catch (e) { /* 忽略 */ }
    } catch (e) {
      S.engine = null;
    }
    return S.engine;
  }

  // 引擎是延迟加载的：等它出现，最多约 8 秒
  function waitEngine(tries) {
    if (S.engine) return;
    if (ensureEngine()) return;
    if (tries <= 0) {
      petEl()?.classList.add('no-engine');
      return;
    }
    S.engineTimer = setTimeout(() => waitEngine(tries - 1), 400);
  }

  function engineState(name) {
    if (!S.engine) return;
    try { S.engine.setState(name, { resetEyes: true }); } catch (e) { /* 忽略 */ }
  }

  // 切状态，backMs 后自己回 idle（睡着时回 sleeping）
  // 有 backMs 的状态算「锁定」：期间鼠标进出、空闲小动作都不打断它
  function setState(name, backMs) {
    if (!S.engine) return;
    clearTimeout(S.stateTimer);
    S.stateTimer = 0;
    engineState(name);
    if (backMs > 0) {
      S.lockUntil = Date.now() + backMs;
      S.stateTimer = setTimeout(() => {
        S.stateTimer = 0;
        S.lockUntil = 0;
        engineState(S.sleeping ? 'sleeping' : 'idle');
      }, backMs);
    } else if (name !== 'idle') {
      S.lockUntil = 0;
    }
  }

  function isLocked() { return S.lockUntil > Date.now(); }

  // ---------- 位置 ----------
  function place(x, y, quiet) {
    const pet = petEl();
    if (!pet) return null;
    const b = bounds();
    const nx = clamp(Math.round(x), b.minX, b.maxX);
    const ny = clamp(Math.round(y), b.minY, b.maxY);
    pet.style.left = nx + 'px';
    pet.style.top = ny + 'px';
    pet.style.right = 'auto';
    pet.style.bottom = 'auto';
    S.pos = { x: nx, y: ny };
    // 位置变了：让引擎下一帧重算 SVG 矩形，否则眼睛会朝着旧位置看（最多迟 200ms）
    if (S.engine) S.engine.rectAt = 0;
    if (!quiet) {
      placeBubble();
      layoutPanel();
    }
    return S.pos;
  }

  function savePos() {
    if (!S.pos) return;
    const b = bounds();
    const rx = b.maxX > b.minX ? (S.pos.x - b.minX) / (b.maxX - b.minX) : 0;
    const ry = b.maxY > b.minY ? (S.pos.y - b.minY) / (b.maxY - b.minY) : 0;
    store(KEY_POS, JSON.stringify({ rx: +rx.toFixed(4), ry: +ry.toFixed(4), x: S.pos.x, y: S.pos.y }));
  }

  function restorePos() {
    let saved = null;
    try { saved = JSON.parse(store(KEY_POS) || 'null'); } catch (e) { saved = null; }
    if (saved && typeof saved.rx === 'number' && typeof saved.ry === 'number') {
      const b = bounds();
      place(b.minX + saved.rx * (b.maxX - b.minX), b.minY + saved.ry * (b.maxY - b.minY));
      return true;
    }
    // 兼容旧版按像素存的坐标
    let legacy = null;
    try { legacy = JSON.parse(store(KEY_POS_OLD) || 'null'); } catch (e) { legacy = null; }
    if (legacy && typeof legacy.x === 'number' && typeof legacy.y === 'number') {
      place(legacy.x, legacy.y);
      return true;
    }
    return false;
  }

  // 窗口变化：把宠物按比例夹回可见区域，并重新贴气泡
  function reflow() {
    if (!S.pos) return;
    place(S.pos.x, S.pos.y);
    placeBubble();
  }

  // ---------- 惯性滑动（松手后滑一小段，靠边就停） ----------
  function glide(vx, vy) {
    const speed = Math.hypot(vx, vy);
    if (speed < 0.12 || S.reduceMotion) { savePos(); return; }
    const b = bounds();
    let x = S.pos ? S.pos.x : b.maxX;
    let y = S.pos ? S.pos.y : b.maxY;
    let last = Date.now();
    let raf = 0;
    let vX = vx;
    let vY = vy;
    S.gliding = true;

    const frame = () => {
      const now = Date.now();
      const dt = clamp(now - last, 8, 48);
      last = now;
      x += vX * dt;
      y += vY * dt;
      const decay = Math.pow(0.9, dt / 16.7);
      vX *= decay;
      vY *= decay;
      if (x <= b.minX) { x = b.minX; vX = 0; }
      if (x >= b.maxX) { x = b.maxX; vX = 0; }
      if (y <= b.minY) { y = b.minY; vY = 0; }
      if (y >= b.maxY) { y = b.maxY; vY = 0; }
      place(x, y, true);
      if (Math.hypot(vX, vY) > 0.05) {
        raf = useRaf(frame);
      } else {
        S.gliding = false;
        savePos();
        placeBubble();
        if (!S.sleeping) setState('idle', 0);
      }
    };
    raf = useRaf(frame);
  }

  // ---------- 反应 ----------
  function randomLine() {
    const mind = global.PetMind;
    if (mind && typeof mind.pickLine === 'function') {
      try {
        const line = mind.pickLine();
        if (line) return line;
      } catch (e) { /* 忽略 */ }
    }
    return FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
  }

  // 点一下：跳一下 + 换个表情（台词由 speakRandom 负责）
  function react() {
    if (S.sleeping) { toggleSleep(false); return; }
    setState('excited', 1100);
    const pet = petEl();
    if (pet) {
      pet.classList.remove('is-hop');
      void pet.offsetWidth;
      pet.classList.add('is-hop');
      setTimeout(() => pet.classList.remove('is-hop'), 560);
    }
  }

  function speakRandom() {
    if (S.sleeping) return;
    say(randomLine(), 3800);
    setState('happy', 1400);
  }

  // 点桌宠 = 开聊：面板由 pet-mind 负责，没加载时至少冒一句
  function openChat() {
    if (S.sleeping) return;
    const mind = global.PetMind;
    if (mind && typeof mind.openPanel === 'function') {
      mind.openPanel();
      setState('happy', 1200);
      return;
    }
    speakRandom();
  }

  // ---------- 睡觉 / 唤醒 ----------
  function toggleSleep(force) {
    const pet = petEl();
    if (!pet) return S.sleeping;
    const next = force === undefined ? !S.sleeping : !!force;
    if (next === S.sleeping) return S.sleeping;
    S.sleeping = next;

    pet.dataset.state = next ? 'sleep' : 'awake';
    pet.classList.toggle('is-asleep', next);
    store(KEY_ASLEEP, next ? '1' : '0');
    clearTimeout(S.idleTimer);

    if (next) {
      clearTimeout(S.stateTimer);
      clearTimeout(S.tapTimer);
      hideBubble();
      hideOrbit();
      engineState('sleeping');
      try { global.dispatchEvent(new global.CustomEvent('pet:sleep', { detail: { sleeping: true } })); } catch (e) { /* 忽略 */ }
    } else {
      engineState('waking');
      clearTimeout(S.stateTimer);
      S.stateTimer = setTimeout(() => {
        S.stateTimer = 0;
        engineState('idle');
      }, 700);
      scheduleIdle();
      say('喵…醒了', 3000);
      try { global.dispatchEvent(new global.CustomEvent('pet:sleep', { detail: { sleeping: false } })); } catch (e) { /* 忽略 */ }
    }
    return S.sleeping;
  }

  // ---------- 空闲小动作 ----------
  function scheduleIdle() {
    clearTimeout(S.idleTimer);
    if (S.reduceMotion) return;
    const wait = 22000 + Math.random() * 26000;
    S.idleTimer = setTimeout(() => {
      if (!doc.hidden && !S.sleeping && !S.dragging && !S.gliding && !isLocked()) {
        const pool = ['curious', 'happy', 'excited', 'thinking', 'playful', 'proud'];
        setState(pool[Math.floor(Math.random() * pool.length)], 1500);
      }
      scheduleIdle();
    }, wait);
  }

  // ---------- 拖拽 ----------
  function bindDrag() {
    const pet = petEl();
    const body = bodyEl();
    if (!pet || !body) return;

    let drag = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let pending = null;
    let frame = 0;
    let lastTap = 0;
    // 380ms 内：1 下=开对话框、2 下=召唤三个圆、3 下=实时对话。
    // 窗口收窄到和双击确认延迟一致，两次双击之间不会串成三连击。
    const TRIPLE_WINDOW = 380;
    const DOUBLE_DELAY = 380;
    const tapTimes = [];
    const toggleVoiceMode = () => {
      const mind = global.PetMind;
      if (mind && typeof mind.toggleVoiceMode === 'function') mind.toggleVoiceMode();
      else speakRandom();
    };
    let vx = 0;
    let vy = 0;
    let lastX = 0;
    let lastY = 0;
    let lastT = 0;

    const flush = () => {
      frame = 0;
      if (!pending) return;
      place(pending.x, pending.y);
      pending = null;
    };

    // 只有主键（左键 / 触摸）算交互：右键、中键一律不拖不点，避免"右键弹出对话框"
    const isPrimary = (e) => (e.button === undefined ? true : e.button === 0);

    const onDown = (e) => {
      if (!isPrimary(e)) return;
      const rect = pet.getBoundingClientRect();
      drag = true;
      moved = false;
      startX = lastX = e.clientX;
      startY = lastY = e.clientY;
      lastT = Date.now();
      vx = vy = 0;
      originX = rect.left;
      originY = rect.top;
      pet.classList.add('is-dragging');
      setState('dragging', 0);
      // 注意：三个圆要等真的开始拖动才收（见 onMove），否则双击的第一下就会把它们收掉
      try { body.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      if (e.cancelable) e.preventDefault();
    };

    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) { moved = true; hideOrbit(); }
      if (!moved) return;
      // 速度采样：只留最近一段，松手时才像被甩出去
      const now = Date.now();
      const dt = now - lastT;
      if (dt > 0) {
        vx = vx * 0.6 + ((e.clientX - lastX) / dt) * 0.4;
        vy = vy * 0.6 + ((e.clientY - lastY) / dt) * 0.4;
        lastT = now;
        lastX = e.clientX;
        lastY = e.clientY;
      }
      pet.style.setProperty('--pet-tilt', clamp(dx * 0.25, -9, 9).toFixed(2) + 'deg');
      pending = { x: originX + dx, y: originY + dy };
      if (!frame) frame = useRaf(flush);
    };

    const onUp = (e) => {
      if (!drag) return;
      drag = false;
      S.dragging = false;
      if (frame) { cancelRaf(frame); frame = 0; }
      if (pending) { place(pending.x, pending.y); pending = null; }
      try { body.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      pet.classList.remove('is-dragging');
      pet.style.removeProperty('--pet-tilt');

      if (moved) {
        glide(vx, vy);
        if (!S.gliding) savePos();
        if (!S.sleeping) setState('idle', 0);
        return;
      }

      if (S.sleeping) {                    // 睡着时点一下：直接醒
        lastTap = 0;
        tapTimes.length = 0;
        toggleSleep(false);
        return;
      }
      const now = Date.now();
      lastTap = now;
      tapTimes.push(now);
      while (tapTimes.length && now - tapTimes[0] > TRIPLE_WINDOW) tapTimes.shift();
      react();                             // 立刻给动作反馈

      if (tapTimes.length >= 3) {          // 三连击：实时对话（不碰对话框）
        clearTimeout(S.tapTimer);
        S.tapTimer = 0;
        tapTimes.length = 0;
        hideOrbit();
        toggleVoiceMode();
        return;
      }
      if (tapTimes.length === 2) {         // 双击：召唤 / 收起三个圆（等一等看有没有第三下）
        clearTimeout(S.tapTimer);
        S.tapTimer = setTimeout(() => {
          S.tapTimer = 0;
          if (tapTimes.length !== 2) return;
          tapTimes.length = 0;
          toggleOrbit();
        }, DOUBLE_DELAY);
        return;
      }
      // 单击：只是摸一下（跳一下 + 冒一句），对话框只从 💬 那个圆进
      speakRandom();
    };

    S.dragging = false;
    body.addEventListener('pointerdown', (e) => { S.dragging = false; onDown(e); });
    // 移动/抬起挂在 window 上：指针捕获失败（老 Safari）或拖出窗口也不会丢帧
    global.addEventListener('pointermove', (e) => { if (drag) { S.dragging = true; onMove(e); } }, { passive: true });
    global.addEventListener('pointerup', onUp);
    global.addEventListener('pointercancel', onUp);
    // 丢焦（比如拖出窗口）时收尾，避免一直粘在指针上
    global.addEventListener('blur', () => { if (drag) onUp({ pointerId: 0 }); });
    // 长按 / 右键不弹系统菜单；同时把"待执行的单击"取消掉，
    // 否则某些触控板/驱动会先发一次主键 pointerdown、再补一个 contextmenu，
    // 结果就是"右键弹出对话面板"。
    const cancelPendingTap = () => {
      clearTimeout(S.tapTimer);
      S.tapTimer = 0;
      lastTap = 0;
      tapTimes.length = 0;
      if (drag) {
        drag = false;
        S.dragging = false;
        pet.classList.remove('is-dragging');
        pet.style.removeProperty('--pet-tilt');
        if (!S.sleeping) setState('idle', 0);
      }
    };
    body.addEventListener('contextmenu', (e) => { e.preventDefault(); cancelPendingTap(); });
    body.addEventListener('auxclick', (e) => { e.preventDefault(); cancelPendingTap(); });

    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        react();
        setTimeout(openChat, 260);
      }
      return undefined;
    });
  }

  // 跟着鼠标：眼睛由引擎负责，身体再做一点点"探身"（CSS 变量驱动 dpFloat 动画）
  function bindGaze() {
    const pet = petEl();
    if (!pet || S.reduceMotion) return;
    let raf = 0;
    let mx = 0;
    let my = 0;

    const apply = () => {
      raf = 0;
      if (S.gazeOff) {
        pet.style.setProperty('--pet-shift-x', '0px');
        pet.style.setProperty('--pet-shift-y', '0px');
        pet.style.setProperty('--pet-lean', '0deg');
        return;
      }
      const svg = doc.getElementById('grokPet');
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const nx = clamp((mx - (r.left + r.width / 2)) / Math.max(240, (global.innerWidth || 1280) * 0.5), -1, 1);
      const ny = clamp((my - (r.top + r.height / 2)) / Math.max(240, (global.innerHeight || 800) * 0.5), -1, 1);
      pet.style.setProperty('--pet-shift-x', (nx * 1.8).toFixed(2) + 'px');
      pet.style.setProperty('--pet-shift-y', (ny * 1.2).toFixed(2) + 'px');
      pet.style.setProperty('--pet-lean', (nx * 2.4).toFixed(2) + 'deg');
    };

    global.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      mx = e.clientX;
      my = e.clientY;
      if (!raf) raf = useRaf(apply);
    }, { passive: true });
    // 鼠标离开窗口：回正
    const root = doc.documentElement;
    if (root && typeof root.addEventListener === 'function') {
      root.addEventListener('pointerleave', () => {
        pet.style.setProperty('--pet-shift-x', '0px');
        pet.style.setProperty('--pet-shift-y', '0px');
        pet.style.setProperty('--pet-lean', '0deg');
      });
    }
  }

  // 鼠标悬停 / 键盘焦点：抬头看你
  function bindHover() {
    const body = bodyEl();
    if (!body) return;
    body.addEventListener('pointerenter', () => {
      if (!S.sleeping && !S.dragging && !isLocked()) setState('curious', 0);
    });
    body.addEventListener('pointerleave', () => {
      if (!S.sleeping && !S.dragging && !isLocked()) setState('idle', 0);
    });
  }

  // ---------- 双击召唤的三个圆：打开对话框 / 实时对话 / 睡觉 ----------
  // 三个圆的位置：以桌宠中心为原点，朝屏幕内侧扇形铺开。
  // 注意要「整组平移」进视口 —— 逐点 clamp 会在窄屏/贴边时把三个圆夹到同一条线，
  // 挤成一根竖条（文章页窄窗口下就是这样变形的）。
  function layoutOrbit() {
    const host = doc.getElementById('deskpetOrbit');
    const pet = petEl();
    if (!host || !pet || !host.children.length) return;
    const vw = global.innerWidth || 1024;
    const vh = global.innerHeight || 800;
    const w = pet.offsetWidth || 58;
    const h = pet.offsetHeight || 58;
    // 位置优先用自己记的坐标，避免布局抖动 / 滚动条变化带来的误差
    let left = S.pos ? S.pos.x : 0;
    let top = S.pos ? S.pos.y : 0;
    if (!S.pos) {
      const r = pet.getBoundingClientRect();
      left = r.left;
      top = r.top;
    }
    const cx = left + w / 2;
    const cy = top + h / 2;
    const dirX = cx < vw / 2 ? 1 : -1;
    const dirY = cy < vh / 2 ? 1 : -1;
    const base = Math.atan2(dirY, dirX);
    const dist = 66;
    const spread = [-0.95, -0.05, 0.85];
    const half = 16;          // 按钮半宽（32px）
    const edge = 10;          // 与视口的最小距离
    const items = [...host.children];
    const pts = items.map((_, i) => {
      const ang = base + spread[i % spread.length];
      return { x: cx + Math.cos(ang) * dist, y: cy + Math.sin(ang) * dist };
    });

    const minX = Math.min(...pts.map((p) => p.x)) - half;
    const maxX = Math.max(...pts.map((p) => p.x)) + half;
    const minY = Math.min(...pts.map((p) => p.y)) - half;
    const maxY = Math.max(...pts.map((p) => p.y)) + half;
    let shiftX = 0;
    let shiftY = 0;
    if (minX < edge) shiftX = edge - minX;
    else if (maxX > vw - edge) shiftX = (vw - edge) - maxX;
    if (minY < edge) shiftY = edge - minY;
    else if (maxY > vh - edge) shiftY = (vh - edge) - maxY;

    items.forEach((btn, i) => {
      btn.style.left = Math.round(pts[i].x + shiftX - left - half) + 'px';
      btn.style.top = Math.round(pts[i].y + shiftY - top - half) + 'px';
      btn.style.setProperty('--orbit-i', String(i));
    });
  }

  // 显示 / 收起 / 切换三个圆（双击召唤；点外部或 Esc 收起）
  function showOrbit() {
    const host = doc.getElementById('deskpetOrbit');
    if (!host || S.sleeping || S.dragging) return false;
    layoutOrbit();
    host.classList.add('is-show');
    // 布局刚变化（滚动条 / 字体 / 图片加载）时下一帧再校一次
    useRaf(() => { if (host.classList.contains('is-show')) layoutOrbit(); });
    return true;
  }

  function hideOrbit() {
    doc.getElementById('deskpetOrbit')?.classList.remove('is-show');
  }

  function toggleOrbit() {
    const host = doc.getElementById('deskpetOrbit');
    if (!host) return false;
    if (host.classList.contains('is-show')) {
      hideOrbit();
      return false;
    }
    return showOrbit();
  }

  function bindOrbit() {
    const pet = petEl();
    if (!pet || typeof doc.createElement !== 'function') return;
    if (doc.getElementById('deskpetOrbit')) return;

    const host = doc.createElement('div');
    host.className = 'deskpet-orbit';
    host.id = 'deskpetOrbit';

    // 细线条图标（stroke 取 currentColor，跟主题走）
    const NS = 'http://www.w3.org/2000/svg';
    const ICONS = {
      chat: ['M4.5 5.5h15v9.5h-9.6l-5.4 4.2z'],
      // 麦克风：实时对话（不用开对话框，直接说）
      voice: [
        'M12 4.2a2.4 2.4 0 0 1 2.4 2.4v4.8a2.4 2.4 0 0 1-4.8 0V6.6A2.4 2.4 0 0 1 12 4.2z',
        'M6.8 11.4a5.2 5.2 0 0 0 10.4 0',
        'M12 16.7v3',
      ],
      sleep: ['M20 14.4A8.4 8.4 0 0 1 9.6 4a7 7 0 1 0 10.4 10.4z'],
    };
    const makeIcon = (key) => {
      const svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      (ICONS[key] || []).forEach((d) => {
        const path = doc.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
      });
      return svg;
    };

    const actions = [
      { key: 'chat', label: '打开对话框', run: () => openChat() },
      { key: 'voice', label: '实时对话（直接说话，不弹对话框）', run: () => global.PetMind?.toggleVoiceMode?.() },
      { key: 'sleep', label: '睡觉 / 唤醒', run: () => toggleSleep() },
    ];
    actions.forEach((a) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'deskpet-orbit-item';
      btn.dataset.petAction = a.key;
      btn.appendChild(makeIcon(a.key));
      btn.title = a.label;
      btn.setAttribute('aria-label', a.label);
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        a.run();
      });
      host.appendChild(btn);
    });
    pet.appendChild(host);

    // 点页面其它地方就把三个圆收起来
    doc.addEventListener('pointerdown', (e) => {
      if (!host.classList.contains('is-show')) return;
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#deskPet')) return;
      hideOrbit();
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && host.classList.contains('is-show')) hideOrbit();
    });
    global.addEventListener('resize', () => {
      if (host.classList.contains('is-show')) layoutOrbit();
    });

    S.orbit = { host, layoutOrbit, showOrbit, hideOrbit, toggleOrbit };
  }

  // 你在输入框打字时它竖起来听
  function bindFocus() {
    doc.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (S.sleeping) return;
      if (t.closest('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable="true"]')) {
        setState('listening', 0);
      }
    });
    doc.addEventListener('focusout', (e) => {
      const t = e.target;
      if (!t || !t.closest || S.sleeping) return;
      if (t.closest('input, textarea, [contenteditable="true"]')) setState('idle', 0);
    });
  }

  function bindReflow() {
    const schedule = () => {
      clearTimeout(S.reflowTimer);
      S.reflowTimer = setTimeout(() => {
        reflow();
        layoutPanel();
      }, 120);
    };
    global.addEventListener('resize', schedule);
    global.addEventListener('orientationchange', schedule);
  }

  // 页面切到后台：暂停引擎绘制（省电、不白烧帧），回来再继续
  function bindVisibility() {
    const sync = () => {
      if (!S.engine) return;
      S.engine.paused = !!doc.hidden;
      if (doc.hidden) {
        clearTimeout(S.idleTimer);
        clearTimeout(S.stateTimer);
        S.stateTimer = 0;
      } else if (!S.sleeping) {
        scheduleIdle();
      }
    };
    doc.addEventListener('visibilitychange', sync);
    sync();
  }

  // ---------- 首次见面 ----------
  function greet() {
    if (store(KEY_GREET)) return;
    store(KEY_GREET, '1');
    setTimeout(() => {
      if (S.sleeping || doc.hidden) return;
      // 用户已经先动手了（点过/聊过）就别再插一句，免得把他的气泡顶掉
      const mind = global.PetMind;
      if (mind && mind.state && Date.now() - (mind.state.lastUserAt || 0) < 30000) return;
      if (bubbleEl()?.classList.contains('is-show')) return;
      say('我是枯梦，点我聊天，拖我去别处也行', 7000);
      setState('happy', 1800);
    }, 1800);
  }

  // ---------- 后台设置（后台「前台设置 → 桌宠」下发） ----------
  // /api/admin?action=settings 的 GET 是公开的（首页本来就在读），pet 段不含密钥。
  const CONFIG = {
    enabled: true,
    name: '枯梦',
    autoTalk: true,
    talkRate: 'normal',
    gaze: true,
    tts: false,
    ttsRate: 1.05,
    ttsPitch: 1.1,
    ttsVoice: '',
    wakeWord: '枯梦',
    wakeAction: 'panel',
    persona: '',
    loaded: false,
  };

  const TALK_RATE = {
    quiet: [190000, 420000],
    normal: [70000, 155000],
    chatty: [35000, 85000],
  };

  function applyConfig() {
    const pet = petEl();
    if (!pet) return;
    const mind = global.PetMind;

    if (!CONFIG.enabled) {
      pet.style.display = 'none';
      if (S.engine) S.engine.paused = true;
      if (mind) mind.setQuiet(true, { persist: false });
      return;
    }

    if (S.engine && typeof S.engine.setFollowPointer === 'function') {
      S.engine.setFollowPointer(!!CONFIG.gaze);
    }
    S.gazeOff = !CONFIG.gaze;

    if (mind) {
      if (!CONFIG.autoTalk) {
        mind.setQuiet(true, { persist: false });
      } else {
        const [lo, hi] = TALK_RATE[CONFIG.talkRate] || TALK_RATE.normal;
        mind.state.autoMs = [lo, hi];
        mind.state.nightAutoMs = [Math.round(lo * 1.8), Math.round(hi * 1.8)];
      }
      if (CONFIG.name && typeof mind.setName === 'function') mind.setName(CONFIG.name);
      mind.state.persona = CONFIG.persona || '';
      // 朗读参数（语速 / 音调）
      if (typeof CONFIG.ttsRate === 'number') mind.state.ttsRate = CONFIG.ttsRate;
      if (typeof CONFIG.ttsPitch === 'number') mind.state.ttsPitch = CONFIG.ttsPitch;
      mind.state.ttsVoice = CONFIG.ttsVoice || '';
      mind.state.wakeWord = CONFIG.wakeWord || '枯梦';
      mind.state.wakeAction = CONFIG.wakeAction || 'panel';
      // 朗读默认值：只在本机还没选过时应用
      if (CONFIG.tts) {
        let local = null;
        try { local = global.localStorage.getItem('pet-tts'); } catch (e) { local = null; }
        if (local === null && typeof mind.toggleTTS === 'function') mind.toggleTTS(true, { persist: false });
      }
    } else {
      S.pendingConfig = true;
    }
  }

  function loadConfig() {
    if (CONFIG.loaded || typeof global.fetch !== 'function') return;
    CONFIG.loaded = true;
    global.fetch('/api/admin?action=settings', { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        const pet = json && json.data && json.data.pet;
        if (!pet || typeof pet !== 'object') return;
        CONFIG.enabled = pet.enabled !== false;
        CONFIG.name = String(pet.name || '枯梦').slice(0, 20);
        CONFIG.autoTalk = pet.autoTalk !== false;
        CONFIG.talkRate = ['quiet', 'normal', 'chatty'].includes(pet.talkRate) ? pet.talkRate : 'normal';
        CONFIG.gaze = pet.gaze !== false;
        CONFIG.tts = pet.tts === true;
        CONFIG.ttsRate = Number.isFinite(Number(pet.ttsRate)) ? Math.min(1.6, Math.max(0.6, Number(pet.ttsRate))) : 1.05;
        CONFIG.ttsPitch = Number.isFinite(Number(pet.ttsPitch)) ? Math.min(1.6, Math.max(0.6, Number(pet.ttsPitch))) : 1.1;
        CONFIG.ttsVoice = String(pet.ttsVoice || '').slice(0, 40);
        CONFIG.wakeWord = String(pet.wakeWord || '枯梦').slice(0, 20);
        CONFIG.wakeAction = ['panel', 'voice', 'line'].includes(pet.wakeAction) ? pet.wakeAction : 'panel';
        CONFIG.persona = String(pet.persona || '').slice(0, 300);
        applyConfig();
      })
      .catch(() => { /* 没有后端（静态预览）就用默认值 */ });
  }

  // ---------- 启动 ----------
  function init() {
    if (S.ready) return global.PetCore;
    const pet = petEl();
    const body = bodyEl();
    if (!pet || !body) return global.PetCore;
    S.ready = true;

    try {
      S.reduceMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { S.reduceMotion = false; }

    S.sleeping = store(KEY_ASLEEP) === '1';
    pet.dataset.state = S.sleeping ? 'sleep' : 'awake';
    pet.classList.toggle('is-asleep', S.sleeping);

    restorePos();
    waitEngine(20);

    bindDrag();
    bindHover();
    bindOrbit();
    bindGaze();
    bindFocus();
    bindReflow();
    bindVisibility();
    loadConfig();
    if (!S.sleeping) scheduleIdle();
    greet();

    // 兼容旧接口：其它脚本可能读 PetBoot / PetBootEngine
    const ready = global.PetBoot || {};
    ready.ready = true;
    ready.placeBubble = placeBubble;
    ready.say = say;
    Object.defineProperty(ready, 'engine', { get: () => S.engine, configurable: true, enumerable: true });
    Object.defineProperty(ready, 'sleeping', { get: () => S.sleeping, configurable: true, enumerable: true });
    Object.defineProperty(ready, 'api', { get: () => global.PetCore, configurable: true, enumerable: true });
    global.PetBoot = ready;
    global.PetBootEngine = null;
    return global.PetCore;
  }

  global.PetCore = {
    init,
    ensureEngine,
    setState,
    react,
    speakRandom,
    openChat,
    say,
    hideBubble,
    placeBubble,
    layoutBubble,
    layoutPanel,
    moveTo: place,
    savePos,
    restorePos,
    reflow,
    toggleSleep,
    scheduleIdle,
    pickFallback: randomLine,
    get engine() { return S.engine; },
    get sleeping() { return S.sleeping; },
    get dragging() { return S.dragging; },
    get pos() { return S.pos; },
    get ready() { return S.ready; },
    bounds,
    state: S,
    config: CONFIG,
    applyConfig,
  };

  // 自举：脚本一加载就把交互接上（引擎若还没到会自己等）
  const boot = () => {
    if (doc.getElementById('deskPet')) init();
  };
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(window);
