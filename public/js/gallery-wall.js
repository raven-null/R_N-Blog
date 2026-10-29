/* 图库：无限图片墙
   ------------------------------------------------------------
   和 private-gallery 那套一样，墙是「铺满整个平面」的：
     · 方格：无限网格，照片按 (列,行) 取模循环，每 8 格有一个 2×2 大图
     · 瀑布流：先把照片排成一条「带」，再纵向无限重复这条带
   视口外的格子不渲染（按可见范围动态增删），所以拖多远都不会到头。
   单击就地放大、双击进灯箱、滚轮缩放、拖动带惯性。
*/
(function (global) {
  'use strict';

  const CELL = 200;          // 格子基准边长
  const GAP = 12;            // 间距
  const MIN_S = 0.16;
  const MAX_S = 2.2;

  const S = {
    x: 0,
    y: 0,
    s: 1,
    view: 'grid',            // grid | masonry
    pool: [],
    tiles: new Map(),        // key -> element
    ratio: new Map(),        // photoId -> 真实高宽比
    masonryBand: null,       // { items, bandH, blockW }
    expandedKey: null,
    dragging: false,
    moved: 0,
    vx: 0,
    vy: 0,
    inertia: 0,
    raf: 0,
    inited: false,
    loading: false,
    clickTimer: null,
  };

  // ---------- 工具 ----------
  const mod = (n, m) => ((n % m) + m) % m;

  function hash32(a, b) {
    let h = 2166136261 ^ (a * 374761393) ^ (b * 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }

  function ratioOf(p) {
    const known = S.ratio.get(p.id);
    if (known) return Math.min(2.6, Math.max(0.42, known));
    const s = String(p.id || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000;
    return 0.62 + (h % 100) / 100 * 0.85;
  }

  // ---------- 布局：方格（无限） ----------
  function gridGeom() {
    const wall = document.getElementById('galleryWall');
    const vw = wall ? wall.clientWidth : window.innerWidth;
    // 列数按视口宽度定（缩放 1 时一屏大约 7 列）
    const cols = Math.max(5, Math.min(12, Math.round(vw / 240)));
    const cellW = CELL;
    const cellH = CELL;
    return {
      cols,
      cellW,
      cellH,
      stepX: cellW + GAP,
      stepY: cellH + GAP,
    };
  }

  // 某个格子是否是大图锚点（2×2）
  function isBigAnchor(c, r, cols) {
    if (mod(c, 7) === 6) return false;              // 让大图不跨到右边界外太乱
    return hash32(c, r) % 9 === 0;
  }

  // 格子 (c,r) 是否被某个大图覆盖
  function bigOwner(c, r, cols) {
    const anchors = [[c, r], [c - 1, r], [c, r - 1], [c - 1, r - 1]];
    for (const [ac, ar] of anchors) {
      if (isBigAnchor(ac, ar, cols)) return { c: ac, r: ar };
    }
    return null;
  }

  // ---------- 布局：瀑布流（把照片排成一条带，纵向重复） ----------
  function buildMasonryBand() {
    if (S.masonryBand) return S.masonryBand;
    const wall = document.getElementById('galleryWall');
    const vw = wall ? wall.clientWidth : window.innerWidth;
    const cols = Math.max(5, Math.min(12, Math.round(vw / 240)));
    const cellW = CELL;
    const stepX = cellW + GAP;
    const colH = new Array(cols).fill(0);
    const items = [];
    const pool = S.pool;

    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      const ratio = ratioOf(p);
      const big = cols >= 2 && i % 9 === 0;
      let c = 0;
      for (let k = 1; k < cols; k++) if (colH[k] < colH[c]) c = k;

      if (big && c + 1 < cols) {
        const spanW = cellW * 2 + GAP;
        const y = colH[c];
        const h = Math.round(spanW * ratio);
        items.push({ id: p.id, x: c * stepX, y, w: spanW, h, big: true });
        colH[c] = y + h + GAP;
        colH[c + 1] = y + h + GAP;
      } else {
        const y = colH[c];
        const h = Math.round(cellW * ratio);
        items.push({ id: p.id, x: c * stepX, y, w: cellW, h, big: false });
        colH[c] = y + h + GAP;
      }
    }

    const bandH = Math.max.apply(null, colH) + GAP;
    S.masonryBand = { items, bandH, blockW: cols * stepX - GAP, cols, cellW };
    return S.masonryBand;
  }

  // ---------- 渲染（只渲染视口内的格子） ----------
  function render() {
    const wall = document.getElementById('galleryWall');
    const body = document.getElementById('gwBody');
    if (!wall || !body || !S.pool.length) return;

    const vw = wall.clientWidth;
    const vh = wall.clientHeight;
    const s = S.s;
    // 视口在世界坐标里的范围（留一格缓冲）
    const wx0 = -S.x / s;
    const wy0 = -S.y / s;
    const wx1 = (vw - S.x) / s;
    const wy1 = (vh - S.y) / s;

    const need = new Set();

    if (S.view === 'grid') {
      const g = gridGeom();
      const c0 = Math.floor(wx0 / g.stepX) - 1;
      const c1 = Math.ceil(wx1 / g.stepX) + 1;
      const r0 = Math.floor(wy0 / g.stepY) - 1;
      const r1 = Math.ceil(wy1 / g.stepY) + 1;
      const n = S.pool.length;

      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          // 被大图盖住的格子跳过（由锚点画）
          const owner = bigOwner(c, r, g.cols);
          if (owner && (owner.c !== c || owner.r !== r)) continue;

          const big = owner && owner.c === c && owner.r === r;
          const idx = mod(r * g.cols + c, n);
          const p = S.pool[idx];
          const key = 'g' + c + ',' + r;
          need.add(key);

          const w = big ? g.cellW * 2 + GAP : g.cellW;
          const h = big ? g.cellH * 2 + GAP : g.cellH;
          placeTile(body, key, p, c * g.stepX, r * g.stepY, w, h, big);
        }
      }
    } else {
      const band = buildMasonryBand();
      const b0 = Math.floor(wy0 / band.bandH) - 1;
      const b1 = Math.ceil(wy1 / band.bandH) + 1;
      for (let b = b0; b <= b1; b++) {
        const offsetY = b * band.bandH;
        const pad = 260;
        for (const it of band.items) {
          const yAbs = it.y + offsetY;
          if (yAbs > wy1 + pad) continue;
          if (yAbs + it.h < wy0 - pad) continue;
          const key = 'm' + b + '/' + it.id + '/' + Math.round(it.x) + ',' + Math.round(it.y);
          need.add(key);
          placeTile(body, key, byId(it.id), it.x, it.y + offsetY, it.w, it.h, it.big);
        }
      }
    }

    // 回收视野外的 tile
    for (const [key, el] of S.tiles) {
      if (!need.has(key)) {
        el.remove();
        S.tiles.delete(key);
      }
    }

    const plane = document.getElementById('gwPlane');
    if (plane) {
      plane.style.transform = 'translate3d(' + S.x + 'px, ' + S.y + 'px, 0) scale(' + S.s + ')';
    }
  }

  function byId(id) {
    return S.pool.find((p) => p.id === id) || S.pool[0];
  }

  function placeTile(body, key, photo, x, y, w, h, big) {
    if (!photo) return;
    let el = S.tiles.get(key);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'gw-tile';
      el.dataset.key = key;
      el.dataset.id = photo.id;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      img.addEventListener('load', () => {
        if (!photo || !img.naturalWidth) return;
        const r = img.naturalHeight / img.naturalWidth;
        if (!S.ratio.has(photo.id)) {
          S.ratio.set(photo.id, r);
          S.masonryBand = null;      // 有真实比例了，瀑布流带子要重排
        }
      });
      el.appendChild(img);
      body.appendChild(el);
      S.tiles.set(key, el);
    }
    const img = el.firstElementChild;
    const src = photo.thumb || photo.url;
    if (src && img.getAttribute('src') !== src) img.src = src;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.classList.toggle('is-big', !!big);
    el.classList.toggle('is-expanded', S.expandedKey === key);
  }

  // ---------- 视角 ----------
  function apply() {
    if (S.raf) return;
    S.raf = requestAnimationFrame(() => {
      S.raf = 0;
      render();
    });
  }

  function zoomAt(px, py, factor) {
    const next = Math.min(MAX_S, Math.max(MIN_S, S.s * factor));
    if (Math.abs(next - S.s) < 1e-4) return;
    S.x = px - ((px - S.x) / S.s) * next;
    S.y = py - ((py - S.y) / S.s) * next;
    S.s = next;
    apply();
  }

  function fitWidth() {
    const wall = document.getElementById('galleryWall');
    if (!wall) return;
    const vw = wall.clientWidth;
    const g = gridGeom();
    // 让一屏大约 6.5 列
    S.s = Math.max(MIN_S, Math.min(1.2, (vw / 6.5) / g.stepX));
    S.x = Math.round(vw / 2 - (g.cols / 2) * g.stepX * S.s);
    S.y = 40;
    apply();
  }

  // ---------- 交互 ----------
  function bindEvents(wall) {
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let lastX = 0;
    let lastY = 0;
    let lastT = 0;

    const down = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest('.gw-hud, .gw-hint, .gw-tip')) return;
      stopInertia();
      S.dragging = true;
      S.moved = 0;
      S.lastUpAt = Date.now();
      startX = e.clientX;
      startY = e.clientY;
      originX = S.x;
      originY = S.y;
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = Date.now();
      S.vx = 0;
      S.vy = 0;
      wall.classList.add('is-dragging');
    };

    const move = (e) => {
      if (!S.dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      S.moved = Math.max(S.moved, Math.abs(dx) + Math.abs(dy));
      S.x = originX + dx;
      S.y = originY + dy;
      const now = Date.now();
      const dt = Math.max(1, now - lastT);
      S.vx = (e.clientX - lastX) / dt;
      S.vy = (e.clientY - lastY) / dt;
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = now;
      apply();
    };

    const up = () => {
      if (!S.dragging) return;
      S.dragging = false;
      S.lastUpAt = Date.now();
      wall.classList.remove('is-dragging');
      if (Math.hypot(S.vx, S.vy) > 0.15) startInertia();
    };

    wall.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    wall.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = wall.getBoundingClientRect();
      zoomAt(
        e.clientX - rect.left,
        e.clientY - rect.top,
        Math.max(0.72, Math.min(1.38, Math.exp(-e.deltaY * 0.0012)))
      );
    }, { passive: false });

    // 触屏捏合
    let pinch = null;
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    wall.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      stopInertia();
      S.dragging = false;
      const [a, b] = e.touches;
      pinch = { d0: Math.max(1, dist(a, b)), s0: S.s, x0: S.x, y0: S.y, mx: (a.clientX + b.clientX) / 2, my: (a.clientY + b.clientY) / 2 };
    }, { passive: true });
    wall.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      const [a, b] = e.touches;
      const next = Math.min(MAX_S, Math.max(MIN_S, pinch.s0 * (dist(a, b) / pinch.d0)));
      const k = next / pinch.s0;
      S.s = next;
      S.x = (a.clientX + b.clientX) / 2 - (pinch.mx - pinch.x0) * k;
      S.y = (a.clientY + b.clientY) / 2 - (pinch.my - pinch.y0) * k;
      apply();
    }, { passive: true });
    wall.addEventListener('touchend', () => { pinch = null; });

    // 单击放大 / 双击灯箱
    wall.addEventListener('click', (e) => {
      const tile = e.target.closest('.gw-tile');
      if (!tile) return;
      // 刚拖过就不算点击（松手 300ms 内的位移也排除）
      if (S.dragging || S.moved > 6) {
        if (Date.now() - (S.lastUpAt || 0) < 320) return;
      }
      clearTimeout(S.clickTimer);
      S.clickTimer = setTimeout(() => {
        S.expandedKey = S.expandedKey === tile.dataset.key ? null : tile.dataset.key;
        apply();
      }, 240);
    });

    wall.addEventListener('dblclick', (e) => {
      const tile = e.target.closest('.gw-tile');
      if (tile) {
        clearTimeout(S.clickTimer);
        openLightbox(tile.dataset.id);
        return;
      }
      if (!e.target.closest('.gw-hud')) fitWidth();
    });
  }

  function openLightbox(id) {
    const idx = S.pool.findIndex((p) => p.id === id);
    const target = idx >= 0 ? idx : 0;
    const photo = S.pool[target];
    if (!photo) return;
    global.__galleryImages = S.pool;
    if (typeof global.openGalleryLightbox === 'function') {
      global.openGalleryLightbox(photo.url || photo.thumb, target);
    }
  }

  function startInertia() {
    const step = () => {
      S.inertia = 0;
      if (S.dragging) return;
      S.vx *= 0.94;
      S.vy *= 0.94;
      if (Math.abs(S.vx) < 0.02 && Math.abs(S.vy) < 0.02) return;
      S.x += S.vx * 16;
      S.y += S.vy * 16;
      apply();
      S.inertia = requestAnimationFrame(step);
    };
    S.inertia = requestAnimationFrame(step);
  }

  function stopInertia() {
    if (S.inertia) {
      cancelAnimationFrame(S.inertia);
      S.inertia = 0;
    }
  }

  // ---------- 数据 ----------
  async function loadPhotos() {
    if (S.pool.length || S.loading) return;
    S.loading = true;
    const app = global.BlogApp;
    const count = document.getElementById('gwCount');
    if (count) count.textContent = '加载中…';
    try {
      const list = await Promise.race([
        app.loadGalleryImages(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ]);
      S.pool = (list || []).filter((p) => p && (p.thumb || p.url) && !app.isR18Image(p));
      S.view = 'grid';
      S.masonryBand = null;
      if (count) count.textContent = S.pool.length + ' 张';
    } catch (e) {
      if (count) count.textContent = '图片没加载出来';
    } finally {
      S.loading = false;
    }
  }

  function setView(v) {
    S.view = v === 'masonry' ? 'masonry' : 'grid';
    S.expandedKey = null;
    S.tiles.forEach((el) => el.remove());
    S.tiles.clear();
    const btn = document.querySelector('[data-gw="view"]');
    if (btn) btn.textContent = S.view === 'grid' ? '瀑布流' : '方格';
    fitWidth();
  }

  function shuffle() {
    if (!S.pool.length) return;
    const start = Math.floor(Math.random() * S.pool.length);
    S.pool = S.pool.slice(start).concat(S.pool.slice(0, start));
    S.masonryBand = null;
    S.tiles.forEach((el) => el.remove());
    S.tiles.clear();
    apply();
  }

  // ---------- 对外 ----------
  const GalleryWall = {
    get state() { return S; },

    open() {
      const wall = document.getElementById('galleryWall');
      if (!wall) return;

      if (!S.inited) {
        S.inited = true;
        bindEvents(wall);
        document.getElementById('gwHud')?.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-gw]');
          if (!btn) return;
          e.stopPropagation();
          if (btn.dataset.gw === 'view') setView(S.view === 'grid' ? 'masonry' : 'grid');
          else if (btn.dataset.gw === 'shuffle') shuffle();
          else if (btn.dataset.gw === 'fit') fitWidth();
        });
        window.addEventListener('resize', () => { S.masonryBand = null; apply(); });
        setTimeout(() => document.getElementById('gwHint')?.classList.add('gone'), 4500);
      }

      loadPhotos().then(() => {
        if (!S.pool.length) return;
        // 每次进入都回到「适应宽度」并重绘
        S.tiles.forEach((el) => el.remove());
        S.tiles.clear();
        fitWidth();
      });
    },

    fit: fitWidth,
    setView,
    shuffle,
    render: apply,
  };

  global.GalleryWall = GalleryWall;
})(window);
