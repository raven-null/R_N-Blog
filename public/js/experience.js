/* Shared theme controls and contextual pet actions. */
(() => {
  const boot = async () => {
    // Tool pages also share the same clock and theme without loading blog code.
    for (const [name, src] of [['Daylight','/js/daylight.js?v=20261030c'],['ThemeManager','/js/theme.js?v=20261030c']]) {
      if (!window[name]) await new Promise(resolve => { const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = resolve; document.head.append(script); });
    }
    // 「外观」下拉已按需求移除；主题仍由 ThemeManager 自动跟随天色，
    // 桌宠「切换天色」按钮保留手动切换入口。
    const update = () => { const el = document.getElementById('periodLabel'); if (el) el.textContent = ({dawn:'晨光初至',day:'日光正好',dusk:'落日余温',night:'静夜微光'})[document.documentElement.dataset.period] || '日光正好'; };
    update(); document.addEventListener('daylightchange', update);
    // 桌宠对话面板（快捷指令 / 安静模式 / Esc 收起）由 pet-mind.js 统一接管，
    // 这里不再注入，避免面板顶部出现两套按钮。
  };
  // Run after deferred scripts and their synchronous initializers.
  if(document.readyState!=='complete')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
