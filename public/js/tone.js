/* 页面明暗与文字颜色
   ------------------------------------------------------------
   目标：亮背景用近黑字，暗背景用暖白字，所有页面一致。

   判断依据（两个来源合一）：
     1. 主题骨架       data-theme="light" | "dark"
     2. 天色时段       data-period="dawn|day|dusk|night"（只有首页/文章页有）

   在 <html> 上写一个 data-tone="light|dark"：
     亮 → 近黑字 + 深灰次文字
     暗 → 暖白字 + 浅灰次文字
*/
(function (global) {
  'use strict';

  function currentTone() {
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme');
    const period = root.getAttribute('data-period');
    // 深色骨架，或天色到了静夜，都按暗底处理
    const dark = theme === 'dark' || period === 'night';
    return dark ? 'dark' : 'light';
  }

  const Tone = {
    refresh() {
      const tone = currentTone();
      const root = document.documentElement;
      if (root.getAttribute('data-tone') !== tone) {
        root.setAttribute('data-tone', tone);
      }
      return tone;
    },

    tone: currentTone,
  };

  global.Tone = Tone;

  // 尽早定一次，避免先黑闪一下
  if (typeof document !== 'undefined') {
    const boot = () => {
      Tone.refresh();
      // 主题或时段改动时自动跟随
      const root = document.documentElement;
      if (typeof MutationObserver === 'function') {
        new MutationObserver(() => Tone.refresh()).observe(root, {
          attributes: true,
          attributeFilter: ['data-theme', 'data-period'],
        });
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(window);
