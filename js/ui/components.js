/* =============================================================================
   components.js — shared UI builders. MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var C = {};

  /* --- primitives --------------------------------------------------------- */

  C.badge = function (text, kind, dot) {
    return U.el('span', { class: 'ps2-badge ps2-badge--' + (kind || 'mute') }, [
      dot === false ? null : U.el('i', { class: 'ps2-badge__dot' }),
      U.el('span', { text: text })
    ]);
  };

  C.chip = function (label, on, onclick, opts) {
    opts = opts || {};
    var n = U.el('button', {
      class: 'ps2-chip' + (on ? ' is-on' : '') + (opts.locked ? ' is-locked' : ''),
      title: opts.title || '',
      onclick: function () { if (!opts.locked && onclick) onclick(!n.classList.contains('is-on'), n); }
    }, [opts.icon ? U.el('span', { text: opts.icon }) : null, U.el('span', { text: label })]);
    return n;
  };

  C.btn = function (label, opts) {
    opts = opts || {};
    return U.el('button', {
      class: 'ps2-btn' +
        (opts.variant ? ' ps2-btn--' + opts.variant : '') +
        (opts.size ? ' ps2-btn--' + opts.size : '') +
        (opts.block ? ' ps2-btn--block' : '') +
        (opts.active ? ' is-active' : ''),
      title: opts.title || '',
      disabled: opts.disabled,
      onclick: opts.onclick
    }, [opts.icon ? U.el('span', { text: opts.icon }) : null, U.el('span', { text: label })]);
  };

  C.switch_ = function (label, on, onchange) {
    var n = U.el('label', { class: 'ps2-switch' + (on ? ' is-on' : '') }, [
      U.el('span', { class: 'ps2-switch__track' }, [U.el('span', { class: 'ps2-switch__thumb' })]),
      U.el('span', { class: 'ps2-switch__text', text: label })
    ]);
    n.addEventListener('click', function () {
      var next = !n.classList.contains('is-on');
      n.classList.toggle('is-on', next);
      if (onchange) onchange(next);
    });
    return n;
  };

  C.check = function (label, on, onchange) {
    var n = U.el('label', { class: 'ps2-check' + (on ? ' is-on' : '') }, [
      U.el('span', { class: 'ps2-check__box' }),
      U.el('span', { text: label })
    ]);
    n.addEventListener('click', function () {
      var next = !n.classList.contains('is-on');
      n.classList.toggle('is-on', next);
      if (onchange) onchange(next);
    });
    return n;
  };

  C.select = function (options, value, onchange, opts) {
    opts = opts || {};
    var s = U.el('select', { class: 'ps2-select', title: opts.title || '' },
      options.map(function (o) {
        var v = typeof o === 'string' ? o : o.value;
        var l = typeof o === 'string' ? o : o.label;
        return U.el('option', { value: v, selected: String(v) === String(value) }, l);
      }));
    s.addEventListener('change', function () { if (onchange) onchange(s.value); });
    return s;
  };

  C.field = function (label, control) {
    return U.el('div', { class: 'mr-field' }, [
      U.el('span', { class: 'mr-field__label', text: label }),
      control
    ]);
  };

  C.section = function (title, children, right) {
    return U.el('div', { class: 'mr-section' }, [
      U.el('div', { class: 'mr-section__title' }, [U.el('span', { text: title }), right || null]),
      U.el('div', {}, children)
    ]);
  };

  C.empty = function (title, hint, action) {
    return U.el('div', { class: 'mr-empty' }, [
      U.el('div', { class: 'ps2-cube', style: { width: '38px', height: '38px' } }, [
        U.el('div', { class: 'ps2-cube__inner' }, [1,2,3,4,5,6].map(function () {
          return U.el('i', { class: 'ps2-cube__face' });
        }))
      ]),
      U.el('div', { class: 'mr-empty__title', text: title }),
      hint ? U.el('div', { class: 'mr-empty__hint', html: hint }) : null,
      action || null
    ]);
  };

  C.progress = function (percent, indeterminate) {
    return U.el('div', { class: 'ps2-progress' + (indeterminate ? ' ps2-progress--indeterminate' : '') }, [
      U.el('div', { class: 'ps2-progress__fill', style: { width: (percent || 0) + '%' } })
    ]);
  };

  /* --- licence rendering --------------------------------------------------- */

  C.licenseBadge = function (report, verifying) {
    if (verifying) return C.badge('verifying…', 'info');
    var b = License.badge(report);
    var n = C.badge(b.text, b.cls);
    if (report) n.title = report.tierInfo.title + ' — confidence ' + report.score + '%';
    return n;
  };

  C.verdict = function (report) {
    var t = report.tierInfo;
    return U.el('div', { class: 'mr-verdict mr-verdict--' + t.tone }, [
      U.el('div', { class: 'mr-verdict__seal', text: t.seal }),
      U.el('div', { class: 'ps2-grow' }, [
        U.el('div', { class: 'mr-verdict__title', text: t.title }),
        U.el('div', { class: 'mr-verdict__line', html: t.line })
      ]),
      U.el('div', { class: 'mr-verdict__score' }, [
        U.el('b', { text: report.score + '%' }),
        U.el('span', { class: 'ps2-caption', text: 'confidence' })
      ])
    ]);
  };

  var SEV_ICON = { pos: '✓', crit: '✕', warn: '!', info: 'i' };

  C.signal = function (s) {
    return U.el('div', { class: 'mr-signal mr-signal--' + s.severity }, [
      U.el('span', { class: 'mr-signal__icon', text: SEV_ICON[s.severity] || '·' }),
      U.el('div', { class: 'ps2-grow' }, [
        U.el('div', { class: 'mr-signal__label', text: s.label }),
        s.detail ? U.el('div', { class: 'mr-signal__detail', text: s.detail }) : null,
        s.evidence ? U.el('code', { class: 'mr-signal__evidence', text: s.evidence }) : null
      ])
    ]);
  };

  /** The full licence report block used on the video view. */
  C.licenseReport = function (report, opts) {
    opts = opts || {};
    var order = { crit: 0, warn: 1, pos: 2, info: 3 };
    var signals = report.signals.slice().sort(function (a, b) {
      return (order[a.severity] || 9) - (order[b.severity] || 9);
    });

    var children = [C.verdict(report)];

    if (!report.verified) {
      children.push(U.el('div', { class: 'mr-claimwarn', style: { marginBottom: '12px' } }, [
        U.el('span', { text: '⏳' }),
        U.el('span', { html: 'Full metadata has not been fetched, so no licence field exists to check. ' +
                             '<b>Nothing here can be trusted until you verify.</b>' })
      ]));
    }

    children.push(U.el('div', { class: 'mr-section__title' }, [
      U.el('span', { text: 'Evidence' }),
      U.el('span', { class: 'ps2-caption', style: { marginLeft: 'auto' },
        text: report.counts.crit + ' critical · ' + report.counts.warn + ' warning' })
    ]));
    children.push(U.el('div', { class: 'mr-signals' }, signals.map(C.signal)));

    if (report.obligations.length) {
      children.push(U.el('div', { class: 'mr-section__title', style: { marginTop: '14px' }, text: 'Your obligations' }));
      children.push(U.el('div', {}, report.obligations.map(function (o) {
        return U.el('div', { class: 'mr-obligation' }, [
          U.el('span', { class: 'mr-obligation__key', text: o.key }),
          U.el('span', { class: 'ps2-grow', text: o.text })
        ]);
      })));
    }

    if (report.attribution) {
      children.push(U.el('div', { class: 'mr-section__title', style: { marginTop: '14px' } }, [
        U.el('span', { text: 'Required credit' }),
        U.el('button', {
          class: 'ps2-btn ps2-btn--sm ps2-btn--ghost',
          style: { marginLeft: 'auto' },
          text: 'Copy',
          onclick: function () {
            U.copy(report.attribution.credits);
            Toast.ok('Copied', 'Attribution text is on the clipboard.');
          }
        })
      ]));
      children.push(U.el('div', { class: 'mr-attrib', text: report.attribution.credits }));
    }

    if (opts.footer) children.push(opts.footer);

    return U.el('div', {}, children);
  };

  /* --- media cards --------------------------------------------------------- */

  /**
   * A search result card.
   * @param {object} r       normalised search result
   * @param {object} handlers { onOpen, onVerify, onDownload }
   */
  C.resultCard = function (r, handlers) {
    handlers = handlers || {};
    var report = r.report;

    var thumb = U.el('div', { class: 'mr-card__thumb' }, [
      U.el('img', { src: r.thumb, loading: 'lazy', onerror: function () { this.style.display = 'none'; } }),
      r.duration ? U.el('span', { class: 'mr-card__dur', text: U.hhmmss(r.duration) }) : null
    ]);

    var meta = U.el('div', { class: 'mr-card__meta' }, [
      r.channel ? U.el('span', { class: 'ps2-truncate', text: r.channel }) : null,
      r.views ? U.el('span', { text: U.compact(r.views) + ' views' }) : null,
      r.uploadDate ? U.el('span', { text: U.ago(r.uploadDate) }) : null
    ]);

    var tags = U.el('div', { class: 'mr-card__tags' }, [
      C.licenseBadge(report, r.verifying),
      report && report.claims.length ? C.badge(report.claims.length + ' claim' + (report.claims.length > 1 ? 's' : ''), 'info') : null,
      report && report.counts.crit ? C.badge(report.counts.crit + ' critical', 'crit') : null
    ]);

    var canGrab = License.allow(report);

    var actions = U.el('div', { class: 'mr-card__actions' }, [
      C.btn('Open', { size: 'sm', onclick: function (e) { e.stopPropagation(); if (handlers.onOpen) handlers.onOpen(r); } }),
      report
        ? C.btn(canGrab ? 'Video' : 'Video ⚠', {
            size: 'sm', variant: canGrab ? 'primary' : null,
            title: canGrab ? 'Queue the video' : 'Licence check will run first',
            onclick: function (e) { e.stopPropagation(); if (handlers.onDownload) handlers.onDownload(r, 'video'); }
          })
        : C.btn('Verify', { size: 'sm', onclick: function (e) { e.stopPropagation(); if (handlers.onVerify) handlers.onVerify(r); } }),
      report ? C.btn(canGrab ? 'Audio' : 'Audio ⚠', {
        size: 'sm',
        onclick: function (e) { e.stopPropagation(); if (handlers.onDownload) handlers.onDownload(r, 'audio'); }
      }) : null
    ]);

    var card = U.el('div', {
      class: 'mr-card',
      data: { tier: report ? report.tier : 'UNKNOWN', id: r.id },
      onclick: function () { if (handlers.onOpen) handlers.onOpen(r); }
    }, [
      thumb,
      U.el('div', { class: 'mr-card__body' }, [
        U.el('div', { class: 'mr-card__title', text: r.title, title: r.title }),
        meta, tags, actions
      ])
    ]);

    if (r.verifying) card.appendChild(U.el('div', {
      class: 'ps2-progress ps2-progress--indeterminate',
      style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '2px' }
    }, [U.el('div', { class: 'ps2-progress__fill' })]));

    return card;
  };

  global.C = C;
})(window);
