/**
 * legal-lang.js
 * ─────────────
 * Language-switcher dropdown logic for privacy.html and cookies.html.
 * Identical to the inline script previously duplicated in both pages.
 */
(function () {
  function initLegalLang() {
    var langToggle = document.getElementById('langToggle');
    var langMenu   = document.getElementById('langMenu');
    if (!langToggle || !langMenu) return;

    function syncUI(lang) {
      var codeEl = langToggle.querySelector('.lang-code');
      if (codeEl) codeEl.textContent = lang.toUpperCase();
      langMenu.querySelectorAll('li[data-lang]').forEach(function (li) {
        li.setAttribute('aria-selected', li.getAttribute('data-lang') === lang ? 'true' : 'false');
      });
    }

    function openMenu()  { langToggle.setAttribute('aria-expanded', 'true');  langMenu.classList.add('open'); }
    function closeMenu() { langToggle.setAttribute('aria-expanded', 'false'); langMenu.classList.remove('open'); }

    langToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      langToggle.getAttribute('aria-expanded') === 'true' ? closeMenu() : openMenu();
    });

    langMenu.addEventListener('click', function (e) { e.stopPropagation(); });

    langMenu.querySelectorAll('li[data-lang]').forEach(function (li) {
      li.setAttribute('tabindex', '0');

      function select(e) {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        if (window.i18n) {
          window.i18n.setLanguage(li.getAttribute('data-lang'));
          syncUI(li.getAttribute('data-lang'));
        }
      }

      li.addEventListener('click',    select);
      li.addEventListener('touchend', select);
      li.addEventListener('keydown',  function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(e); }
      });
    });

    document.addEventListener('click', function (e) {
      if (!langToggle.contains(e.target) && !langMenu.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });
    window.addEventListener('languageChanged', function (e) {
      syncUI(e.detail.language);
    });

    var saved = localStorage.getItem('preferred-language');
    if (saved) syncUI(saved);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLegalLang);
  } else {
    initLegalLang();
  }
})();
