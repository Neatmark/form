/**
 * theme-init.js
 * ─────────────
 * Reads the saved theme preference from localStorage and applies it to
 * <html> immediately — before any CSS or DOM rendering — so there is no
 * flash of the wrong colour scheme on page load.
 *
 * Must be loaded as a synchronous (non-deferred, non-async) <script> in
 * <head>, directly after the <link> tags, so it runs before first paint.
 */
(function () {
  var saved = localStorage.getItem('user-theme');
  var theme, mode;
  if (saved === 'dark' || saved === 'light') {
    theme = saved;
    mode  = saved;
  } else {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    mode  = 'auto';
  }
  document.documentElement.setAttribute('data-theme',      theme);
  document.documentElement.setAttribute('data-theme-mode', mode);
})();
