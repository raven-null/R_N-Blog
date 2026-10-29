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

  /* ============================================================
     兜底着色：直接把背景/文字写在元素内联样式上
     ------------------------------------------------------------
     有些浏览器/CDN 会缓存旧的 CSS，导致「深色主题 + 浅色卡片」。
     这里在 data-tone 变化时，主动给常见浮层与卡片打一层颜色，
     优先级高于任何样式表，不依赖 CSS 是否刷新到。
     ============================================================ */
  const SURFACES = [
    // 阅读页
    '.reader-toolbar', '.sidebar-top-bar', '.mobile-top-bar',
    '.toc-sidebar-inner', '.toc-search', '.toc-search-input',
    '.article-header', '.article-navigation', '.nav-card',
    '.rp-card', '.rc-card',
    // AI 聊天浮层
    '.chat-window', '.chat-header', '.chat-input-area', '.chat-messages', '.chat-session-item',
    // 评论
    '.comment-item-main', '.comment-form-main',
    // 通用卡片
    '.dash-panel', '.card', '.project-card', '.home-project',
    // 桌宠对话
    '.pet-chat',
  ];

  const TEXT_SURFACES = [
    '.chat-header-title', '.reader-btn', '.reader-font-size',
    '.toc-title', '.toc-list a', '.toc-child',
    '.article-title', '.article-meta',
  ];

  let paintRaf = 0;

  function paintSurfaces() {
    paintRaf = 0;
    const root = document.documentElement;
    const dark = root.getAttribute('data-tone') === 'dark';

    SURFACES.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (dark) {
          el.style.setProperty('background-color', 'var(--glass-card, rgba(20, 24, 37, 0.72))', 'important');
          el.style.setProperty('background-image', 'none', 'important');
          el.style.setProperty('color', 'var(--text)', 'important');
          el.style.setProperty('border-color', 'var(--glass-line, rgba(255,255,255,0.12))', 'important');
        } else {
          el.style.removeProperty('background-color');
          el.style.removeProperty('background-image');
          el.style.removeProperty('color');
          el.style.removeProperty('border-color');
        }
      });
    });

    TEXT_SURFACES.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (dark) el.style.setProperty('color', 'var(--text)', 'important');
        else el.style.removeProperty('color');
      });
    });
  }

  function schedulePaint() {
    if (paintRaf) return;
    paintRaf = requestAnimationFrame(paintSurfaces);
  }

  // 暴露给外部（切换主题/新浮层出现时手动调）
  Tone.repaint = schedulePaint;

  global.Tone = Tone;

  // 尽早定一次，避免先黑闪一下
  if (typeof document !== 'undefined') {
    const boot = () => {
      Tone.refresh();
      schedulePaint();
      // 主题或时段改动时自动跟随
      const root = document.documentElement;
      if (typeof MutationObserver === 'function') {
        new MutationObserver(() => {
          Tone.refresh();
          schedulePaint();
        }).observe(root, {
          attributes: true,
          attributeFilter: ['data-theme', 'data-period'],
        });

        // 新浮层/新卡片插入时也补一次色
        if (document.body) {
          new MutationObserver(schedulePaint).observe(document.body, {
            childList: true,
            subtree: true,
          });
        }
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(window);
