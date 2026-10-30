/* 桌宠启动器（用于没有 app.js 的页面，比如文章页）
   ------------------------------------------------------------
   index.html 的桌宠由 app.js 的 initDeskPet 负责；这里给其它页面用，
   能力对齐：拖动 / 位置记忆 / 点击说话 / 双击睡觉 / 气泡定位。
   检测到 window.BlogApp 就直接退出，避免重复初始化。
*/
(function (global) {
  'use strict';

  function placeBubble() {
    const bubble = document.getElementById('deskPetBubble');
    const pet = document.getElementById('deskPet');
    if (!bubble || !pet || !bubble.classList.contains('is-show')) return;
    const rect = pet.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const cx = Math.min(
      Math.max(rect.left + rect.width / 2, bw / 2 + 10),
      window.innerWidth - bw / 2 - 10
    );
    let top = rect.top - bh - 12;
    const below = top < 10;
    if (below) top = rect.bottom + 12;
    bubble.classList.toggle('is-below', below);
    bubble.style.left = Math.round(cx) + 'px';
    bubble.style.top = Math.round(top) + 'px';
  }

  function boot() {
    if (global.BlogApp) return;              // 首页交给 app.js
    if (global.PetBoot && global.PetBoot.ready) return;
    const pet = document.getElementById('deskPet');
    const body = document.getElementById('deskPetBody');
    const svg = document.getElementById('grokPet');
    if (!pet || !body) return;

    // 角色引擎
    let engine = null;
    if (global.GrokCharacter && svg) {
      try {
        engine = new global.GrokCharacter(svg, {
          shape: 'blob',
          color: 'black',
          scheme: 'light',
          mode: 'hold',
          followPointer: true,
        });
        // 纯黑：引擎默认的 black 调色板是「#585858 → #000」渐变，这里直接压成纯色
        if (typeof engine.setInk === 'function') engine.setInk('#000000');
        engine.setState('idle');
      } catch (e) { engine = null; }
    }
    global.PetBootEngine = engine;

    // 恢复位置
    try {
      const pos = JSON.parse(localStorage.getItem('deskpet_pos') || 'null');
      if (pos && typeof pos.x === 'number') {
        pet.style.left = pos.x + 'px';
        pet.style.top = pos.y + 'px';
        pet.style.right = 'auto';
        pet.style.bottom = 'auto';
      }
    } catch (e) { /* 忽略 */ }

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let lastTap = 0;

    const setState = (name, backMs) => {
      if (!engine) return;
      try {
        engine.setState(name, { resetEyes: true });
        if (backMs) setTimeout(() => { try { engine.setState('idle'); } catch (e) {} }, backMs);
      } catch (e) { /* 忽略 */ }
    };

    const moveTo = (x, y) => {
      const w = pet.offsetWidth || 44;
      const h = pet.offsetHeight || 44;
      pet.style.left = Math.round(Math.min(Math.max(x, 8), window.innerWidth - w - 8)) + 'px';
      pet.style.top = Math.round(Math.min(Math.max(y, 8), window.innerHeight - h - 8)) + 'px';
      pet.style.right = 'auto';
      pet.style.bottom = 'auto';
      placeBubble();
    };

    body.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const rect = pet.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      originX = rect.left;
      originY = rect.top;
      if (e.cancelable) e.preventDefault();
      pet.classList.add('is-dragging');
      setState('dragging', 0);
    });

    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) moveTo(originX + dx, originY + dy);
    });

    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      pet.classList.remove('is-dragging');
      if (moved) {
        try {
          localStorage.setItem('deskpet_pos', JSON.stringify({ x: pet.offsetLeft, y: pet.offsetTop }));
        } catch (e) { /* 忽略 */ }
        setState('idle', 0);
        return;
      }
      const now = Date.now();
      if (now - lastTap < 320) {
        lastTap = 0;
        pet.dataset.state = pet.dataset.state === 'sleep' ? 'awake' : 'sleep';
        setState(pet.dataset.state === 'sleep' ? 'sleeping' : 'idle', 0);
        return;
      }
      lastTap = now;
      setState('excited', 1300);
      if (global.PetMind) global.PetMind.autoTalk(true);
    });

    body.addEventListener('pointerenter', () => { if (!dragging) setState('curious', 0); });
    body.addEventListener('pointerleave', () => { if (!dragging) setState('idle', 0); });

    // 眼睛跟随已在引擎里（followPointer）
    global.PetBoot = { ready: true, placeBubble, engine };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // 脚本顺序兜底：稍后再试一次
  setTimeout(boot, 600);
})(window);
