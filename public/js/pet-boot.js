/* 桌宠启动器（兼容旧引用）
   ------------------------------------------------------------
   形象、拖拽、气泡、睡眠都收口在 pet-core.js，说话在 pet-mind.js。
   保留这个文件只是为了让老页面 / 老缓存里的 <script> 引用不报错。
*/
(function (global) {
  'use strict';

  let tries = 0;

  function boot() {
    if (global.PetCore) { global.PetCore.init(); return; }
    if (tries++ < 40) global.setTimeout(boot, 250);
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
