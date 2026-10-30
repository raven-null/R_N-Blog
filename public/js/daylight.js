/* 昼夜天色
   ------------------------------------------------------------
   把「枯梦·梦隙」的昼夜光照思路移植成 CSS 变量：
   时间 → 天空渐变两端色 + 地平线暖光 + 日/月位置与颜色。
   每 30 秒刷新一次，跨时段自动过渡（CSS transition 2s）。

   预览：在地址后面加 ?hour=18.5 可以看任意时刻的天色。
*/
(function (global) {
  'use strict';

  const smooth = (a, b, v) => {
    const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  const clockMinutes = (date) => date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;

  // 天空关键帧（小时 → 顶部色 / 底部色 / 光晕色）。线性插值，够柔和不跳。
  const SKY = [
    { h: 0.0, top: '#0a0f1e', bottom: '#18223a', glow: '#8fa8d8' },
    { h: 4.5, top: '#152039', bottom: '#3a3a54', glow: '#c79a86' },
    { h: 5.5, top: '#3d4a6b', bottom: '#9c7a86', glow: '#ffb27a' },
    { h: 6.5, top: '#8fa9d0', bottom: '#f6c9a0', glow: '#ffbf85' },
    { h: 8.0, top: '#bcd6f2', bottom: '#fbf0dd', glow: '#ffe6ad' },
    { h: 12.0, top: '#d3e6fa', bottom: '#fdfaf1', glow: '#fff6d6' },
    { h: 15.5, top: '#cbdcf2', bottom: '#fbeedb', glow: '#ffdfae' },
    { h: 17.5, top: '#dcb79f', bottom: '#f8cfa6', glow: '#ffa869' },
    { h: 18.8, top: '#8a6f92', bottom: '#e39a70', glow: '#ff8d54' },
    { h: 19.8, top: '#3c3f63', bottom: '#7a5570', glow: '#e08a6a' },
    { h: 21.0, top: '#141c33', bottom: '#232d49', glow: '#9db4e0' },
    { h: 24.0, top: '#0a0f1e', bottom: '#18223a', glow: '#8fa8d8' },
  ];

  const hexToRgb = (hex) => {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const mixRgb = (a, b, t) => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
  const rgbCss = (c) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

  // 按小时在关键帧之间插值
  function skyFor(hour) {
    let i = 0;
    for (let k = 0; k < SKY.length - 1; k++) {
      if (hour >= SKY[k].h && hour <= SKY[k + 1].h) { i = k; break; }
    }
    const a = SKY[i];
    const b = SKY[Math.min(i + 1, SKY.length - 1)];
    const span = Math.max(0.0001, b.h - a.h);
    const t = smooth(0, 1, (hour - a.h) / span);
    return {
      top: mixRgb(hexToRgb(a.top), hexToRgb(b.top), t),
      bottom: mixRgb(hexToRgb(a.bottom), hexToRgb(b.bottom), t),
      glow: mixRgb(hexToRgb(a.glow), hexToRgb(b.glow), t),
    };
  }

  function periodFor(hour) {
    if (hour < 5 || hour >= 20) return { key: 'night', name: '静夜' };
    if (hour < 8) return { key: 'dawn', name: '晨曦' };
    if (hour < 16) return { key: 'day', name: '白昼' };
    return { key: 'dusk', name: '薄暮' };
  }

  // 太阳 6:00 东升、12:00 顶、18:00 西落；夜里换成月亮走同一条弧
  function arcFor(hour) {
    // 太阳 6:00 升起、19:00 之后才换成月亮（日落后仍有一段余晖）
    const isDay = hour >= 6 && hour < 19;
    const span = isDay
      ? (hour - 6) / 13
      : ((hour >= 19 ? hour - 19 : hour + 5) / 11);
    const clamped = Math.max(0, Math.min(1, span));
    const x = 8 + clamped * 84;
    const y = 86 - Math.sin(clamped * Math.PI) * 72;
    return { x, y, isDay };
  }

  function lightingFor(minutes) {
    const hour = ((minutes / 60) % 24 + 24) % 24;
    const angle = ((hour - 6) / 12) * Math.PI;
    const elevation = Math.sin(angle);
    const daylight = smooth(-0.16, 0.30, elevation);
    const warmth = (1 - smooth(0.05, 0.78, elevation)) * smooth(-0.22, 0.16, elevation);
    const sky = skyFor(hour);
    const arc = arcFor(hour);
    const period = periodFor(hour);

    // 插画背景的明暗与染色：夜里压暗、晨曦黄昏加暖
    const ART_TONE = {
      dawn: { brightness: 0.94, tint: 0.62 },
      day: { brightness: 1.04, tint: 0.4 },
      dusk: { brightness: 0.88, tint: 0.66 },
      night: { brightness: 0.52, tint: 0.72 },
    };
    const tone = ART_TONE[period.key] || ART_TONE.day;

    return {
      tone,
      hour,
      period,
      daylight,
      warmth,
      top: sky.top,
      bottom: sky.bottom,
      glow: sky.glow,
      arc,
      // 光晕强度：白天强、夜里收成一点点月光
      glowOpacity: arc.isDay ? 0.35 + daylight * 0.5 : 0.22,
      // 太阳亮白、月亮偏冷白
      glowColor: arc.isDay ? sky.glow : mixRgb(sky.glow, [200, 214, 245], 0.7),
    };
  }

  function publish(minutes) {
    const L = lightingFor(minutes);
    const root = document.documentElement;
    Daylight.minutes = minutes;
    root.style.setProperty('--sky-top', rgbCss(L.top));
    root.style.setProperty('--sky-bottom', rgbCss(L.bottom));
    root.style.setProperty('--sky-glow', rgbCss(L.glowColor));
    root.style.setProperty('--sky-glow-opacity', L.glowOpacity.toFixed(3));
    root.style.setProperty('--sun-x', L.arc.x.toFixed(2) + '%');
    root.style.setProperty('--sun-y', L.arc.y.toFixed(2) + '%');
    const previous = root.dataset.period;
    root.setAttribute('data-period', L.period.key);
    if (previous !== L.period.key) document.dispatchEvent(new CustomEvent('daylightchange', { detail: L.period }));
    if (window.Tone) window.Tone.refresh();
    const dark = root.getAttribute('data-theme') === 'dark';
    root.style.setProperty('--art-brightness', (dark ? L.tone.brightness * 0.55 : L.tone.brightness).toFixed(3));
    root.style.setProperty('--art-tint', L.tone.tint.toFixed(3));
    if (typeof L.warmth === 'number') {
      root.style.setProperty('--sky-warmth', L.warmth.toFixed(3));
    }
    return L;
  }

  function previewHour() {
    const m = /[?&]hour=([\d.]+)/.exec(location.search);
    if (!m) return null;
    const h = parseFloat(m[1]);
    return Number.isFinite(h) ? h : null;
  }

  // 清除旧版时段徽标（防止浏览器缓存里的老 HTML 还带着它）
  function dropLegacyBadge() {
    document.querySelectorAll('.sky-badge, #skyBadge').forEach(function (el) {
      el.parentNode && el.parentNode.removeChild(el);
    });
  }

  const Daylight = {
    lightingFor,
    periodFor,
    publish,

    // 开始按真实时间刷新
    start(intervalMs = 30000) {
      if (this.timer) clearInterval(this.timer);
      this.preview = previewHour();
      dropLegacyBadge();
      setTimeout(dropLegacyBadge, 400);
      setTimeout(dropLegacyBadge, 1500);
      const forced = this.preview;
      const tick = () => {
        publish(this.preview === null ? clockMinutes(new Date()) : this.preview * 60);
      };
      tick();
      if (forced !== null) return; // 预览模式不自动走
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => { if (!document.hidden) tick(); }, intervalMs);
      if (!this.visibilityBound) {
        this.visibilityBound = true;
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refresh(); });
      }
    },

    refresh() {
      return publish(this.preview == null ? clockMinutes(new Date()) : this.preview * 60);
    },

    // 预览：手动指定小时（0–24），传 null 回到真实时间
    setHour(hour) {
      this.preview = hour == null ? null : Math.max(0, Math.min(24, Number(hour)));
      if (this.preview !== null && !Number.isFinite(this.preview)) this.preview = null;
      this.refresh();
    },
  };

  global.Daylight = Daylight;
  document.addEventListener('themechange', () => { if (Daylight.minutes !== undefined) publish(Daylight.minutes); });

  // 尽早跑一次，避免首屏闪一下默认色
  if (typeof document !== 'undefined') {
    const boot = () => Daylight.start();
    boot();
  }
})(window);
