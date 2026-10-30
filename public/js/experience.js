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
    const pet = document.getElementById('deskPet'), panel = document.getElementById('petChat');
    if (!pet || !panel) return;
    // 「枯梦 · 小助手」小字按钮已按需求移除；聊天面板与快捷指令保留。
    const closePanel = () => panel.classList.remove('is-open');
    const shortcuts=document.createElement('div'); shortcuts.className='pet-shortcuts';
    const action=(label,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=fn;shortcuts.append(b);return b;};
    action('随机阅读',()=>{const posts=window.BlogApp?.posts; if(posts?.length){const post=posts[Math.floor(Math.random()*posts.length)]; location.href='/article.html?post='+encodeURIComponent(post.filename);} else location.href='/?type=article';});
    action('切换天色',()=>window.ThemeManager?.nextTheme());
    shortcuts.addEventListener('pointerdown', e => { if (e.target.closest('button')?.dataset.keepSelection) e.preventDefault(); });
    action('解释选中内容',()=>{const selected=getSelection()?.toString().trim();if(selected)window.PetMind?.send('请解释这段内容：'+selected.slice(0,1200));else window.PetMind?.say('先选中一段文字，再来问我。');}).dataset.keepSelection='true';
    const quiet=action('安静模式',()=>{if(!window.PetMind)return;const state=window.PetMind.state;window.PetMind.setQuiet(state.enabled);quiet.textContent=state.enabled?'安静模式':'恢复陪伴';});
    try{if(localStorage.getItem('pet-quiet')==='true')quiet.textContent='恢复陪伴';}catch(_){}
    panel.querySelector('.pet-chat-head')?.after(shortcuts);
    document.addEventListener('keydown',e=>{if(e.key==='Escape')closePanel();});
    document.getElementById('petChatClose')?.addEventListener('click',closePanel);
  };
  // Run after deferred scripts and their synchronous initializers.
  if(document.readyState!=='complete')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
