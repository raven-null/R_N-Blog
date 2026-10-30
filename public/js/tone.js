/* Palette ownership stays in ThemeManager; no document-wide inline repaint. */
(function (global) {
  const refresh = () => {
    const root = document.documentElement;
    const tone = root.dataset.theme === 'dark' ? 'dark' : 'light';
    if (root.dataset.tone !== tone) root.dataset.tone = tone;
    return tone;
  };
  global.Tone = { refresh, tone: refresh, repaint: refresh };
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  refresh();
})(window);
