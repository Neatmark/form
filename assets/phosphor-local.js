/**
 * phosphor-local.js — self-contained Phosphor-style icon renderer
 * No CDN, no font files, no network dependency. Works fully offline.
 * Icons: stroke-based, square linecaps, miter joins — precise Swiss geometry.
 * viewBox 0 0 256 256 | stroke-width 20 | fill none (unless noted)
 */
(function (global) {
  'use strict';

  /* ─── Icon path data ──────────────────────────────────────── */
  const ICONS = {

    /* ── Theme ── */
    'ph-sun': `
      <circle cx="128" cy="128" r="52"/>
      <line x1="128" y1="20"  x2="128" y2="52"/>
      <line x1="128" y1="204" x2="128" y2="236"/>
      <line x1="20"  y1="128" x2="52"  y2="128"/>
      <line x1="204" y1="128" x2="236" y2="128"/>
      <line x1="54"  y1="54"  x2="76"  y2="76"/>
      <line x1="180" y1="180" x2="202" y2="202"/>
      <line x1="202" y1="54"  x2="180" y2="76"/>
      <line x1="76"  y1="180" x2="54"  y2="202"/>`,

    'ph-moon': `
      <path d="M 216 128
               A 88 88 0 1 1 128 40
               A 68 68 0 0 0 216 128 Z"
            fill="none"/>`,

    'ph-monitor': `
      <rect x="32" y="48" width="192" height="144"/>
      <line x1="96"  y1="208" x2="160" y2="208"/>
      <line x1="128" y1="192" x2="128" y2="208"/>`,

    /* ── Navigation ── */
    'ph-arrow-right': `
      <line x1="40" y1="128" x2="216" y2="128"/>
      <polyline points="144,56 216,128 144,200"/>`,

    'ph-arrow-left': `
      <line x1="216" y1="128" x2="40" y2="128"/>
      <polyline points="112,56 40,128 112,200"/>`,

    'ph-caret-down': `
      <polyline points="64,96 128,160 192,96"/>`,

    /* ── Actions ── */
    'ph-x': `
      <line x1="56"  y1="56"  x2="200" y2="200"/>
      <line x1="200" y1="56"  x2="56"  y2="200"/>`,

    'ph-pencil-simple': `
      <path d="M 200 56 L 56 200 L 32 224 L 56 200"/>
      <path d="M 56 200 L 32 224"/>
      <path d="M 160 40 L 216 96 L 72 240 L 16 240 L 16 184 Z"/>
      <line x1="136" y1="64" x2="192" y2="120"/>`,

    'ph-pencil': `
      <path d="M 152 40 L 216 104 L 80 240 L 16 240 L 16 176 Z"/>
      <line x1="120" y1="72"  x2="184" y2="136"/>
      <line x1="16"  y1="240" x2="240" y2="240"/>`,

    'ph-upload-simple': `
      <polyline points="80,104 128,56 176,104"/>
      <line x1="128" y1="56"  x2="128" y2="176"/>
      <line x1="40"  y1="208" x2="216" y2="208"/>`,

    'ph-download-simple': `
      <polyline points="80,152 128,200 176,152"/>
      <line x1="128" y1="200" x2="128" y2="80"/>
      <line x1="40"  y1="208" x2="216" y2="208"/>`,

    'ph-cloud-arrow-up': `
      <path d="M 80 192
               A 56 56 0 0 1 80 80
               A 56 56 0 0 1 96 81
               A 72 72 0 0 1 240 128
               A 56 56 0 0 1 184 184"
            fill="none"/>
      <polyline points="104,152 128,128 152,152"/>
      <line x1="128" y1="128" x2="128" y2="208"/>`,

    'ph-arrow-clockwise': `
      <path d="M 192 72 A 88 88 0 1 1 164 44" fill="none"/>
      <polyline points="192,24 192,72 144,72"/>`,

    'ph-arrow-counter-clockwise': `
      <path d="M 64 72 A 88 88 0 1 0 92 44" fill="none"/>
      <polyline points="64,24 64,72 112,72"/>`,

    'ph-refresh-cw': `
      <path d="M 192 72 A 88 88 0 1 1 164 44" fill="none"/>
      <polyline points="192,24 192,72 144,72"/>`,

    'ph-rotate-ccw': `
      <path d="M 64 72 A 88 88 0 1 0 92 44" fill="none"/>
      <polyline points="64,24 64,72 112,72"/>`,

    /* ── Status / Feedback ── */
    'ph-check-circle': `
      <circle cx="128" cy="128" r="96"/>
      <polyline points="84,128 112,156 172,96"/>`,

    'ph-x-circle': `
      <circle cx="128" cy="128" r="96"/>
      <line x1="96"  y1="96"  x2="160" y2="160"/>
      <line x1="160" y1="96"  x2="96"  y2="160"/>`,

    /* ── People / Identity ── */
    'ph-user': `
      <circle cx="128" cy="88" r="56"/>
      <path d="M 24 216 A 104 104 0 0 1 232 216" fill="none"/>`,

    'ph-user-circle': `
      <circle cx="128" cy="128" r="96"/>
      <circle cx="128" cy="104" r="40"/>
      <path d="M 56 200 A 72 72 0 0 1 200 200" fill="none"/>`,

    'ph-shield-check': `
      <path d="M 48 72 L 128 40 L 208 72 L 208 128 A 80 80 0 0 1 48 128 Z" fill="none"/>
      <polyline points="92,128 116,152 168,100"/>`,

    'ph-question': `
      <circle cx="128" cy="128" r="96"/>
      <path d="M 100 96 A 28 28 0 0 1 156 96 C 156 124 128 124 128 152" fill="none"/>
      <circle cx="128" cy="184" r="8" fill="currentColor" stroke="none"/>`,

    /* ── Data / UI chrome ── */
    'ph-file-text': `
      <path d="M 152 32 L 208 88 L 208 208 A 8 8 0 0 1 200 216 L 56 216 A 8 8 0 0 1 48 208 L 48 48 A 8 8 0 0 1 56 40 L 144 40" fill="none"/>
      <polyline points="152,32 152,88 208,88"/>
      <line x1="88" y1="136" x2="168" y2="136"/>
      <line x1="88" y1="168" x2="168" y2="168"/>`,

    'ph-calendar': `
      <rect x="40" y="56" width="176" height="168"/>
      <line x1="40"  y1="104" x2="216" y2="104"/>
      <line x1="88"  y1="32"  x2="88"  y2="80"/>
      <line x1="168" y1="32"  x2="168" y2="80"/>`,

    'ph-clock': `
      <circle cx="128" cy="128" r="96"/>
      <polyline points="128,72 128,128 176,128"/>`,

    'ph-clock-counter-clockwise': `
      <circle cx="128" cy="128" r="96"/>
      <polyline points="128,72 128,128 80,160"/>
      <path d="M 64 72 A 88 88 0 0 0 92 44" fill="none"/>
      <polyline points="64,24 64,72 112,72"/>`,

    'ph-magnifying-glass': `
      <circle cx="108" cy="108" r="72"/>
      <line x1="156" y1="156" x2="224" y2="224"/>`,

    'ph-magnifying-glass-plus': `
      <circle cx="104" cy="104" r="72"/>
      <line x1="152" y1="152" x2="224" y2="224"/>
      <line x1="80"  y1="104" x2="128" y2="104"/>
      <line x1="104" y1="80"  x2="104" y2="128"/>`,

    'ph-search': `
      <circle cx="108" cy="108" r="72"/>
      <line x1="156" y1="156" x2="224" y2="224"/>`,

    'ph-list': `
      <line x1="40" y1="72"  x2="216" y2="72"/>
      <line x1="40" y1="128" x2="216" y2="128"/>
      <line x1="40" y1="184" x2="216" y2="184"/>`,

    'ph-check-square': `
      <rect x="40" y="40" width="176" height="176"/>
      <polyline points="88,128 116,156 168,96"/>`,

    'ph-trash': `
      <line x1="32"  y1="56"  x2="224" y2="56"/>
      <line x1="88"  y1="24"  x2="168" y2="24"/>
      <path d="M 80 56 L 80 216 L 176 216 L 176 56" fill="none"/>
      <line x1="104" y1="104" x2="104" y2="168"/>
      <line x1="152" y1="104" x2="152" y2="168"/>`,

    'ph-envelope': `
      <rect x="32" y="56" width="192" height="160"/>
      <polyline points="32,56 128,144 224,56"/>`,

    'ph-tray': `
      <rect x="32" y="48" width="192" height="176"/>
      <line x1="32"  y1="160" x2="224" y2="160"/>
      <polyline points="96,120 128,152 160,120"/>
      <line x1="128" y1="80"  x2="128" y2="152"/>`,

    'ph-arrows-down-up': `
      <polyline points="48,80  80,48  112,80"/>
      <line x1="80"  y1="48"  x2="80"  y2="176"/>
      <polyline points="144,176 176,208 208,176"/>
      <line x1="176" y1="80"  x2="176" y2="208"/>`,

    'ph-puzzle-piece': `
      <path d="M 160 80 L 160 56 A 8 8 0 0 0 152 48 L 72 48 A 8 8 0 0 0 64 56 L 64 136 A 8 8 0 0 0 72 144 L 96 144 L 96 168 A 8 8 0 0 0 104 176 L 184 176 A 8 8 0 0 0 192 168 L 192 88 A 8 8 0 0 0 184 80 Z" fill="none"/>`,

    'ph-zoom-in': `
      <circle cx="104" cy="104" r="72"/>
      <line x1="152" y1="152" x2="224" y2="224"/>
      <line x1="80"  y1="104" x2="128" y2="104"/>
      <line x1="104" y1="80"  x2="104" y2="128"/>`,

    'ph-inbox': `
      <rect x="32" y="48" width="192" height="176"/>
      <line x1="32"  y1="160" x2="224" y2="160"/>
      <polyline points="96,120 128,152 160,120"/>
      <line x1="128" y1="80"  x2="128" y2="152"/>`,

    'ph-edit-3': `
      <path d="M 152 40 L 216 104 L 80 240 L 16 240 L 16 176 Z"/>
      <line x1="120" y1="72" x2="184" y2="136"/>`,

    /* ── Submit arrow — wide aspect, chunky arrowhead ── */
    /* True Illustrator "extend left anchor points" method:
       ViewBox origin shifts LEFT by 256 units — arrowhead coordinates
       are IDENTICAL to ph-arrow-right (144,56 216,128 144,200).
       Only the shaft's left endpoint extends. Nothing else changes. */
    'ph-arrow-right-wide': {
      viewBox: '-256 0 512 256',
      paths: `
        <line x1="-216" y1="128" x2="216" y2="128"/>
        <polyline points="144,56 216,128 144,200"/>
      `
    },

  };

  /* ─── SVG wrapper ─────────────────────────────────────────── */
  function wrap(inner, viewBox) {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + (viewBox || '0 0 256 256') + '" ' +
      'fill="none" stroke="currentColor" stroke-width="20" ' +
      'stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true" focusable="false">' +
      inner +
      '</svg>'
    );
  }

  /* ─── Core renderer ───────────────────────────────────────── */
  function renderIcons(root) {
    var els = (root || document).querySelectorAll('i.ph');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      // Already rendered — skip
      if (el.querySelector('svg')) continue;

      var iconClass = null;
      for (var j = 0; j < el.classList.length; j++) {
        var c = el.classList[j];
        if (c !== 'ph' && c.startsWith('ph-')) { iconClass = c; break; }
      }
      if (!iconClass || !ICONS[iconClass]) continue;

      // Handle both plain string icons and object icons {viewBox, paths}
      var iconDef = ICONS[iconClass];
      var iconPaths, iconViewBox;
      if (typeof iconDef === 'object') {
        iconPaths   = iconDef.paths;
        iconViewBox = iconDef.viewBox;
      } else {
        iconPaths   = iconDef;
        iconViewBox = null;
      }
      el.innerHTML = wrap(iconPaths, iconViewBox);

      // Ensure correct display so SVG inside the <i> sizes properly
      var cs = getComputedStyle(el);
      if (cs.display === 'inline') {
        el.style.display = 'inline-flex';
      }
      el.style.alignItems    = 'center';
      el.style.justifyContent = 'center';

      // Size: square by default, or preserve aspect ratio for wide icons
      var svg = el.querySelector('svg');
      if (svg) {
        if (iconViewBox) {
          // Parse viewBox to get natural aspect ratio
          var vb = iconViewBox.split(' ');
          var vbW = parseFloat(vb[2]);
          var vbH = parseFloat(vb[3]);
          var aspect = vbW / vbH;
          svg.style.height = '1em';
          svg.style.width  = aspect + 'em';
        } else {
          svg.style.width  = '1em';
          svg.style.height = '1em';
        }
        svg.style.flexShrink = '0';
      }
    }
  }

  /* ─── Public API — mirrors window.lucide pattern ─────────── */
  global.phosphor = {
    init: renderIcons,
    createIcons: function (opts) {
      renderIcons(opts && opts.context ? opts.context : null);
    }
  };

  /* Auto-init once DOM is ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { renderIcons(); });
  } else {
    renderIcons();
  }

}(window));
