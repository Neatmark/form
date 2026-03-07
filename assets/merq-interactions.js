/* ══════════════════════════════════════════════════════════════
   MERQ — Interaction Layer (merq-interactions.js)
   Zero external dependencies. CSS does all the visual work.
   This file handles only what CSS cannot:
     1. Mouse position for cursor
     2. IntersectionObserver for scroll reveals
     3. Word splitting for hero title
     4. Shake class on empty-blur
     5. Submit button: loading dashes markup
     6. Success overlay trigger
     7. Wizard page observer
══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Capability flags ─────────────────────────────────── */
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TOUCH   = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  if (TOUCH) {
    document.documentElement.classList.add('is-touch-device');
  }

  /* ── Touch fallback — kills cursor if media query was wrong ─── */
  /* Chrome on Android fires ONE synthetic mousemove on first touchstart  */
  /* causing the cursor ring to briefly appear then freeze. Prevent this  */
  /* by listening for a real single-finger touch and disabling cursor.    */
  /*                                                                       */
  /* IMPORTANT: pinch-to-zoom extensions fire touchstart with             */
  /* e.touches.length >= 2. We ONLY kill cursor on single-touch events    */
  /* (real mobile tap). Multi-touch = desktop pinch gesture = leave alone.*/
  window.addEventListener('touchstart', function killCursorOnTouch(e) {
    if (e.touches && e.touches.length > 1) return; // pinch — ignore
    document.documentElement.classList.add('is-touch-device');
    var dot  = document.getElementById('cursor-dot');
    var ring = document.getElementById('cursor-ring');
    if (dot)  { dot.style.display  = 'none'; }
    if (ring) { ring.style.display = 'none'; }
    window.removeEventListener('touchstart', killCursorOnTouch, { capture: true });
  }, { capture: true, passive: true });

  /* ── DOM ready ─────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  function boot() {
    insertDOM();
    if (!TOUCH) initCursor();
    initWordSplit();
    initReveals();
    initWizardObserver();
    initInputFeedback();
    initSubmitButton();
    initSuccessOverlay();
  }


  /* ══════════════════════════════════════════════════════
     1. INJECT DOM — curtain + success overlay
     These elements aren't in the HTML, we create them once.
  ══════════════════════════════════════════════════════ */

  function insertDOM() {
    /* Page curtain */
    if (!document.getElementById('merq-curtain')) {
      var curtain = document.createElement('div');
      curtain.id = 'merq-curtain';
      document.body.insertBefore(curtain, document.body.firstChild);
    }

    /* Custom cursor */
    if (!document.getElementById('cursor-dot') && !TOUCH) {
      var dot  = document.createElement('div'); dot.id  = 'cursor-dot';
      var ring = document.createElement('div'); ring.id = 'cursor-ring';
      document.body.appendChild(dot);
      document.body.appendChild(ring);
    }

    /* Success overlay — only on form page */
    if (document.querySelector('.hero-title') && !document.getElementById('merq-success')) {
      var success = document.createElement('div');
      success.id = 'merq-success';
      success.innerHTML =
        '<div class="merq-success-rule"></div>' +
        '<div class="merq-success-copy">' +
          '<span class="merq-success-eyebrow">Submission received</span>' +
          '<span class="merq-success-headline">We\'ll be<br>in touch.</span>' +
        '</div>';
      document.body.appendChild(success);
    }
  }


  /* ══════════════════════════════════════════════════════
     2. CUSTOM CURSOR
     Dot: reads CSS custom properties --cx / --cy (instant).
     Ring: rAF lerp for the lag feel (no library).
  ══════════════════════════════════════════════════════ */



  /* ── Zoom-extension fix ─────────────────────────────────────
     Zoom extensions (Pinch-to-Zoom, Bento Zoom, etc.) apply
     transform:scale() or CSS zoom to <body>. When body has a
     CSS transform, position:fixed children are no longer in
     viewport space — they're in body's scaled CSS space.
     clientX/clientY are still raw viewport pixels.

     Fix: read body.getBoundingClientRect() to get the visual
     rect, divide by body.offsetWidth for the actual scale.
     Convert viewport mouse coords → body CSS coords each frame.
     Fast path: if scale ≈ 1 (no zoom), returns null = no cost.
  ══════════════════════════════════════════════════════════ */
  function getBodyZoom() {
    var b    = document.body;
    var rect = b.getBoundingClientRect();
    var ow   = b.offsetWidth;
    var oh   = b.offsetHeight;
    if (!ow || !oh) return null;
    var sx = rect.width  / ow;
    var sy = rect.height / oh;
    /* Fast path — no scale applied */
    if (Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) return null;
    return { sx: sx, sy: sy, ox: rect.left, oy: rect.top };
  }

  function initCursor() {
    if (REDUCED) return;

    var ring = document.getElementById('cursor-ring');
    if (!ring) return;

    /* Raw viewport coords from mouse only (ignore touch/stylus) */
    var mouseX = -100, mouseY = -100;
    var ringX  = -100, ringY  = -100;

    document.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      mouseX = e.clientX;
      mouseY = e.clientY;
    });

    var LERP = 0.18;
    function tick() {
      /* Convert viewport → body CSS coordinate space each frame.
         When no zoom extension is active, bz is null and we use
         raw coords directly — zero extra work in the normal case. */
      var bz = getBodyZoom();
      var targetX = bz ? (mouseX - bz.ox) / bz.sx : mouseX;
      var targetY = bz ? (mouseY - bz.oy) / bz.sy : mouseY;
      ringX += (targetX - ringX) * LERP;
      ringY += (targetY - ringY) * LERP;
      ring.style.left = ringX + 'px';
      ring.style.top  = ringY + 'px';
      requestAnimationFrame(tick);
    }
    tick();

    /* State classes on body */
    var root = document.body;

    document.addEventListener('mouseover', function (e) {
      var t = e.target;
      root.classList.remove('cursor--input', 'cursor--submit', 'cursor--label');

      if (t.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, select')) {
        root.classList.add('cursor--input');
      } else if (t.closest('.submit-btn')) {
        root.classList.add('cursor--submit');
      } else if (t.matches('label') || t.closest('label') || t.classList.contains('q-label')) {
        root.classList.add('cursor--label');
      }
    });

    document.addEventListener('mousedown', function () {
      root.classList.add('cursor--clicking');
    });
    document.addEventListener('mouseup', function () {
      root.classList.remove('cursor--clicking');
    });
    document.addEventListener('mouseleave', function () {
      root.classList.remove('cursor--input', 'cursor--submit', 'cursor--label', 'cursor--clicking');
    });
  }


  /* ══════════════════════════════════════════════════════
     3. HERO WORD SPLIT
     Splits .hero-title words into .word-wrap > .word-inner.
     Sets --word-delay per span. CSS does the clip animation.
  ══════════════════════════════════════════════════════ */

  function initWordSplit() {
    if (REDUCED) return;

    var el = document.querySelector('.hero-title');
    if (!el) return;

    /* Preserve <br> tags while splitting words */
    var rawHTML = el.innerHTML;
    var lines   = rawHTML.split(/<br\s*\/?>/i);

    var wordIndex = 0;
    var newHTML = lines.map(function (line) {
      var words = line.trim().split(/\s+/).filter(Boolean);
      return words.map(function (word) {
        /* base delay: 0.55s after curtain + 0.1s per word */
        var delay = 0.55 + (wordIndex * 0.1);
        wordIndex++;
        return (
          '<span class="word-wrap">' +
          '<span class="word-inner" style="--word-delay:' + delay + 's">' +
          word +
          '</span></span>'
        );
      }).join(' ');
    }).join('<br>');

    el.innerHTML = newHTML;
  }


  /* ══════════════════════════════════════════════════════
     4. SCROLL REVEALS — IntersectionObserver
     Marks elements with classes, sets --reveal-delay,
     then observes. CSS handles all transitions.
  ══════════════════════════════════════════════════════ */

  /* Global observer singleton */
  var revealObserver = null;

  function getObserver() {
    if (revealObserver) return revealObserver;
    revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-revealed');
          revealObserver.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0,
      /* top 88% of viewport — elements reveal before they hit center */
      rootMargin: '0px 0px -12% 0px'
    });
    return revealObserver;
  }

  function observeElement(el) {
    if (!REDUCED) getObserver().observe(el);
    else          el.classList.add('is-revealed');
  }

  function markAndObserve(container) {
    var ctx = container || document;
    var obs = getObserver();

    /* ── Labels and hints ── */
    ctx.querySelectorAll(
      '.client-field > label, .q-label, .q-hint, ' +
      '.section-badge, .section-title, .hero-badge, .hero-desc'
    ).forEach(function (el, i) {
      if (!el.classList.contains('merq-reveal-label')) {
        el.classList.add('merq-reveal-label');
        el.style.setProperty('--reveal-delay', (i * 0.04) + 's');
        if (!REDUCED) obs.observe(el); else el.classList.add('is-revealed');
      }
    });

    /* ── Inputs / textareas / selects — staggered within parent ── */
    ctx.querySelectorAll('.q-card, .client-card').forEach(function (card) {
      var fields = card.querySelectorAll(
        'input:not([type="checkbox"]):not([type="radio"]):not(.honeypot), ' +
        'textarea, select, .check-grid, .q20-upload-area'
      );
      fields.forEach(function (el, i) {
        if (!el.classList.contains('merq-reveal')) {
          el.classList.add('merq-reveal');
          el.style.setProperty('--reveal-delay', (i * 0.07) + 's');
          if (!REDUCED) obs.observe(el); else el.classList.add('is-revealed');
        }
      });
    });

    /* ── Section heads ── */
    ctx.querySelectorAll('.section-head').forEach(function (el) {
      if (!el.classList.contains('merq-reveal')) {
        el.classList.add('merq-reveal');
        if (!REDUCED) obs.observe(el); else el.classList.add('is-revealed');
      }
    });

    /* ── Page nav buttons ── */
    ctx.querySelectorAll('.page-nav-buttons, .submit-cluster, .submit-notes').forEach(function (el) {
      if (!el.classList.contains('merq-reveal')) {
        el.classList.add('merq-reveal');
        if (!REDUCED) obs.observe(el); else el.classList.add('is-revealed');
      }
    });

    /* ── Horizontal rules (header/footer borders used as structural lines) ── */
    ctx.querySelectorAll('.section-head').forEach(function (el) {
      /* The border-bottom on section-head becomes a rule reveal */
      if (!el.classList.contains('merq-reveal-rule')) {
        el.classList.add('merq-reveal-rule');
        if (!REDUCED) obs.observe(el); else el.classList.add('is-revealed');
      }
    });

    /* ── Footer (all pages) ── */
    var footer = document.querySelector('.site-footer');
    if (footer && !footer.classList.contains('merq-reveal')) {
      footer.classList.add('merq-reveal');
      if (!REDUCED) obs.observe(footer); else footer.classList.add('is-revealed');
    }

    /* ── Dashboard static elements (present on load) ── */
    ctx.querySelectorAll('.login-card').forEach(function (el) {
      el.style.setProperty('--reveal-delay', '0s');
      if (!REDUCED) obs.observe(el); else el.classList.add('is-revealed');
    });

    ctx.querySelectorAll('.stat-card').forEach(function (el, i) {
      el.style.setProperty('--reveal-delay', (0.15 + i * 0.06) + 's');
      if (!REDUCED) obs.observe(el); else el.classList.add('is-revealed');
    });

    ctx.querySelectorAll('.filters, .stats').forEach(function (el, i) {
      el.style.setProperty('--reveal-delay', (0.1 + i * 0.07) + 's');
      if (!REDUCED) obs.observe(el); else el.classList.add('is-revealed');
    });

    /* ── Legal content blocks ── */
    ctx.querySelectorAll('.legal-content > *').forEach(function (el, i) {
      el.style.setProperty('--reveal-delay', (i * 0.05) + 's');
      if (!REDUCED) obs.observe(el); else el.classList.add('is-revealed');
    });
  }

  function initReveals() {
    markAndObserve(document);
    initDashboardCardObserver();
  }

  /* ── Dashboard: watch for dynamically injected submission cards ──
     dashboard.js creates .submission-card elements at runtime.
     A MutationObserver on .submissions-grid catches each batch
     and staggers their reveal as they land in the DOM.           */
  function initDashboardCardObserver() {
    var isDash = !!document.getElementById('dashboardScreen');
    if (!isDash) return;

    /* When dashboard screen gains .visible class (after login),
       trigger reveals for stat cards and filters that were
       invisible because they were inside a display:none container */
    var dashScreen = document.getElementById('dashboardScreen');
    if (dashScreen) {
      var dashVisibleObserver = new MutationObserver(function () {
        if (dashScreen.classList.contains('visible')) {
          dashVisibleObserver.disconnect();
          setTimeout(function () {
            dashScreen.querySelectorAll('.stat-card, .filters, .stats').forEach(function (el, i) {
              el.style.setProperty('--reveal-delay', (i * 0.07) + 's');
              el.classList.add('is-revealed');
            });
          }, 80);
        }
      });
      dashVisibleObserver.observe(dashScreen, { attributes: true, attributeFilter: ['class'] });

      /* If already visible on load */
      if (dashScreen.classList.contains('visible')) {
        dashScreen.querySelectorAll('.stat-card, .filters, .stats').forEach(function (el, i) {
          el.style.setProperty('--reveal-delay', (i * 0.07) + 's');
          el.classList.add('is-revealed');
        });
      }
    }

    function revealCard(card, delay) {
      card.style.setProperty('--reveal-delay', delay + 's');
      if (REDUCED) {
        card.classList.add('is-revealed');
      } else {
        getObserver().observe(card);
      }
    }

    /* Observe the grid container once it exists */
    function attachGridObserver() {
      var grid = document.querySelector('.submissions-grid');
      if (!grid) return;

      /* Reveal any cards already in the grid */
      grid.querySelectorAll('.submission-card:not(.is-revealed)').forEach(function (card, i) {
        revealCard(card, i * 0.05);
      });

      /* Watch for new cards being added */
      var cardObserver = new MutationObserver(function (mutations) {
        var newCards = [];
        mutations.forEach(function (m) {
          m.addedNodes.forEach(function (node) {
            if (node.nodeType === 1 && node.classList.contains('submission-card')) {
              newCards.push(node);
            }
          });
        });
        newCards.forEach(function (card, i) {
          revealCard(card, i * 0.05);
        });
      });

      cardObserver.observe(grid, { childList: true });
    }

    /* If grid isn't in DOM yet (dashboard screen hidden on load),
       watch document.body until it appears */
    var grid = document.querySelector('.submissions-grid');
    if (grid) {
      attachGridObserver();
    } else {
      var bodyObserver = new MutationObserver(function (mutations) {
        if (document.querySelector('.submissions-grid')) {
          bodyObserver.disconnect();
          attachGridObserver();
        }
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
  }


  /* ══════════════════════════════════════════════════════
     5. WIZARD PAGE OBSERVER
     When a .form-page gains .active, mark + observe its elements.
  ══════════════════════════════════════════════════════ */

  function initWizardObserver() {
    var pages = document.querySelectorAll('.form-page');
    if (!pages.length) return;

    var seen = new Set();

    /* Page 1 is active on load — mark immediately */
    pages.forEach(function (page) {
      if (page.classList.contains('active')) {
        seen.add(page.id);
        /* First page: reveal elements immediately without scroll wait */
        if (!REDUCED) {
          setTimeout(function () {
            page.querySelectorAll('.merq-reveal, .merq-reveal-label').forEach(function (el) {
              el.classList.add('is-revealed');
            });
          }, 800); /* after curtain clears */
        }
      }
    });

    /* Subsequent pages: sequenced cascade reveal on navigation */
    var pageObserver = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.type === 'attributes' && m.attributeName === 'class') {
          var page = m.target;
          if (page.classList.contains('active') && !seen.has(page.id)) {
            seen.add(page.id);

            /* Stamp reveal classes directly — do NOT call markAndObserve here.
               markAndObserve hands elements to IntersectionObserver which fires
               immediately for in-viewport elements, racing with our stagger.
               We own the full reveal sequence for wizard pages. */
            var labelEls = Array.from(page.querySelectorAll(
              '.client-field > label, .q-label, .q-hint, ' +
              '.section-badge, .section-title, .hero-badge, .hero-desc'
            ));
            labelEls.forEach(function (el) {
              if (!el.classList.contains('merq-reveal-label')) {
                el.classList.add('merq-reveal-label');
              }
            });

            page.querySelectorAll('.q-card, .client-card').forEach(function (card) {
              card.querySelectorAll(
                'input:not([type="checkbox"]):not([type="radio"]):not(.honeypot), ' +
                'textarea, select, .check-grid, .q20-upload-area'
              ).forEach(function (el) {
                if (!el.classList.contains('merq-reveal')) {
                  el.classList.add('merq-reveal');
                }
              });
            });

            page.querySelectorAll('.section-head, .page-nav-buttons, .submit-cluster, .submit-notes').forEach(function (el) {
              if (!el.classList.contains('merq-reveal')) {
                el.classList.add('merq-reveal');
              }
            });

            /* Now collect everything in DOM order and assign delays */
            var allReveal = Array.from(page.querySelectorAll(
              '.merq-reveal, .merq-reveal-label, .merq-reveal-rule'
            ));

            allReveal.forEach(function (el, i) {
              el.style.setProperty('--reveal-delay', (i * 0.04) + 's');
            });

            /* Two rAFs: first lets the page slide finish painting,
               second triggers all transitions with their stagger delays */
            requestAnimationFrame(function () {
              requestAnimationFrame(function () {
                allReveal.forEach(function (el) {
                  el.classList.add('is-revealed');
                });
              });
            });
          }
        }
      });
    });

    pages.forEach(function (page) {
      pageObserver.observe(page, { attributes: true });
    });
  }


  /* ══════════════════════════════════════════════════════
     6. INPUT FEEDBACK — empty-blur shake
     CSS handles everything else via :focus-within,
     :not(:placeholder-shown), :hover. This only adds the shake.
  ══════════════════════════════════════════════════════ */

  function initInputFeedback() {
    if (REDUCED) return;

    document.addEventListener('focusout', function (e) {
      var t = e.target;
      if (!t.matches(
        'input:not([type="checkbox"]):not([type="radio"]):not(.honeypot), ' +
        'textarea'
      )) return;

      /* Empty blur — whisper shake on the label */
      var val = (t.value || '').trim();
      if (!val) {
        var field = t.closest('.client-field');
        var label = field
          ? field.querySelector('label')
          : t.closest('.q-card')
              ? t.closest('.q-card').querySelector('.q-label')
              : null;

        if (label) {
          label.classList.remove('merq-shake');
          /* Reflow so the animation re-triggers if already running */
          void label.offsetWidth;
          label.classList.add('merq-shake');
          label.addEventListener('animationend', function () {
            label.classList.remove('merq-shake');
          }, { once: true });
        }
      }
    }, true); /* capture phase so it fires before blur propagation stops */
  }


  /* ══════════════════════════════════════════════════════
     7. SUBMIT BUTTON
     Wraps existing text in .merq-btn-inner so CSS can
     shift it on hover. Watches data-loading for dashes.
  ══════════════════════════════════════════════════════ */

  function initSubmitButton() {
    var btn = document.getElementById('submitBtn');
    if (!btn) return;

    /* Wrap content in .merq-btn-inner if not already done */
    function wrapContent() {
      if (!btn.querySelector('.merq-btn-inner') &&
          !btn.querySelector('.merq-loading-dashes')) {
        btn.innerHTML = '<span class="merq-btn-inner">' + btn.innerHTML + '</span>';
      }
    }
    wrapContent();

    /* Watch for data-loading and innerHTML changes from script.js */
    var btnObserver = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName === 'data-loading') {
          if (btn.getAttribute('data-loading') === 'true') {
            /* Replace with loading dashes */
            btn.innerHTML =
              '<span class="merq-loading-dashes">' +
              '<span class="d">\u2014</span>' +
              '<span class="d">\u2014</span>' +
              '<span class="d">\u2014</span>' +
              '</span>';
          }
        }
        /* After script.js restores button text (clears data-loading),
           re-wrap the restored content */
        if (m.type === 'childList') {
          var hasLoader = !!btn.querySelector('.merq-loading-dashes');
          var isLoading = btn.getAttribute('data-loading') === 'true';
          if (!hasLoader && !isLoading && !btn.querySelector('.merq-btn-inner')) {
            wrapContent();
          }
        }
      });
    });

    btnObserver.observe(btn, { attributes: true, childList: true });
  }


  /* ══════════════════════════════════════════════════════
     8. SUCCESS OVERLAY
     Watches for the existing custom alert overlay to close
     after a success state, then surfaces the Swiss overlay.
  ══════════════════════════════════════════════════════ */

  function initSuccessOverlay() {
    var alertOverlay = document.getElementById('customAlertOverlay');
    var successEl    = document.getElementById('merq-success');
    if (!alertOverlay || !successEl) return;

    var wasSuccess = false;

    var alertObserver = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName !== 'class') return;

        if (alertOverlay.classList.contains('active')) {
          /* Check if this is a success alert (check-circle icon) */
          var icon = document.getElementById('customAlertIcon');
          wasSuccess = icon && icon.classList.contains('ph-check-circle');
        } else {
          /* Alert just closed */
          if (wasSuccess) {
            wasSuccess = false;
            showSuccessOverlay(successEl);
          }
        }
      });
    });

    alertObserver.observe(alertOverlay, { attributes: true });
  }

  function showSuccessOverlay(el) {
    if (REDUCED) return;
    el.classList.add('is-visible');
    /* One rAF to ensure the opacity transition fires before we add .is-revealed */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.classList.add('is-revealed');
      });
    });
  }

})();
