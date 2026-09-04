/* =============================================================================
   views/compliance.js — the audit trail: policy state, ledger, credits export
   MediaRade by siliconran
   ========================================================================== */
(function (global) {
  'use strict';

  var root, toolbar, body;

  var EVENT_LABEL = {
    download_start: 'queued',
    download_complete: 'downloaded',
    download_blocked: 'BLOCKED',
    download_error: 'failed',
    download_canceled: 'cancelled',
    timeline_insert: 'placed on timeline',
    file_deleted: 'deleted',
    strict_mode_enabled: 'STRICT MODE ON',
    strict_mode_disabled: 'STRICT MODE OFF'
  };

  var ComplianceView = {

    init: function () {
      root = U.$('.mr-view[data-view="compliance"]');
      toolbar = U.el('div', { class: 'mr-view__toolbar' });
      body = U.el('div', { class: 'mr-view__body' });
      U.append(root, [toolbar, body]);

      Bus.on('ledger', U.debounce(function () { if (State.view === 'compliance') ComplianceView.render(); }, 400));
      Bus.on('view', function (v) { if (v === 'compliance') ComplianceView.render(); });

      ComplianceView.render();
    },

    render: function () {
      if (!body) return;
      U.clear(toolbar);
      U.clear(body);

      var strict = Config.get('strictMode');
      var stats = Ledger.stats();

      toolbar.appendChild(U.el('div', { class: 'ps2-row-gap ps2-wrap' }, [
        C.badge(strict ? 'STRICT MODE ON' : 'STRICT MODE OFF', strict ? 'ok' : 'crit'),
        C.badge(stats.total + ' downloads', 'mute'),
        C.badge(stats.verified + ' verified CC BY', stats.verified ? 'ok' : 'mute'),
        stats.overridden ? C.badge(stats.overridden + ' overridden', 'crit') : null,
        stats.blocked ? C.badge(stats.blocked + ' blocked', 'warn') : null,
        U.el('span', { class: 'ps2-grow' }),
        C.btn('Export report', {
          size: 'sm', variant: 'primary',
          onclick: function () {
            try {
              var p = Ledger.exportReport();
              Toast.ok('Report written', p);
              CEP.revealInExplorer(p);
            } catch (e) { Toast.err('Export failed', e.message); }
          }
        }),
        C.btn('Open folder', { size: 'sm', onclick: function () { CEP.openFolder(Paths.dir('compliance')); } })
      ]));

      /* --- the policy explainer, stated plainly ------------------------- */
      body.appendChild(U.el('div', { class: 'ps2-panel', style: { marginBottom: '14px' } }, [
        U.el('div', { class: 'ps2-panel__header' }, [
          U.el('span', { class: 'ps2-panel__title', text: 'How MediaRade decides' })
        ]),
        U.el('div', { style: { fontSize: '11px', lineHeight: '1.7', color: 'var(--ps2-text-secondary)' }, html:
          '<p style="margin:0 0 8px"><b style="color:var(--ps2-ash)">Only one signal counts.</b> YouTube publishes a ' +
          'machine-readable licence field per upload. It reads either <i>Creative Commons Attribution ' +
          '(reuse allowed)</i> or <i>Standard YouTube Licence</i>. That field is the only thing MediaRade ' +
          'treats as a licence.</p>' +
          '<p style="margin:0 0 8px"><b style="color:var(--ps2-ash)">Text is never a licence.</b> "Royalty free", ' +
          '"no copyright", "free to use" are recorded as <i>claims</i>. When a claim appears on an upload whose ' +
          'licence field says Standard YouTube Licence, that is reported as a <span style="color:var(--ps2-crit)">' +
          'CONFLICT</span> — the single most common way people end up with a strike over "free" media.</p>' +
          '<p style="margin:0 0 8px"><b style="color:var(--ps2-ash)">A CC mark only covers what the uploader owns.</b> ' +
          'Credited music, stock footage and subscription libraries (Epidemic Sound, Artlist, NCS…) keep their own ' +
          'licences. MediaRade flags those separately even on a clean CC upload.</p>' +
          '<p style="margin:0"><b style="color:var(--ps2-ash)">Everything is written down.</b> Each download stores a ' +
          '<code>.license.json</code> and, for CC material, an <code>attribution.txt</code>. Overrides require a ' +
          'written reason and a typed acknowledgement, and land in an append-only ledger. This is evidence of due ' +
          'diligence — it is not legal advice, and it cannot give you rights you do not hold.</p>'
        })
      ]));

      /* --- ledger ------------------------------------------------------- */
      var rows = Ledger.read(300);

      if (!rows.length) {
        body.appendChild(C.empty('Ledger is empty',
          'Every download, block and override will be recorded in ' +
          '<code>Documents\\MediaRade\\Compliance\\license-ledger.jsonl</code>.'));
        return;
      }

      var list = U.el('div', { class: 'ps2-list' });
      rows.forEach(function (r) {
        var tone = r.event === 'download_blocked' ? 'warn'
                 : r.event === 'strict_mode_disabled' ? 'crit'
                 : r.override ? 'crit'
                 : r.verdict === 'VERIFIED_CC_BY' ? 'ok' : 'mute';

        list.appendChild(U.el('div', { class: 'ps2-row', style: { cursor: 'default' } }, [
          U.el('div', { class: 'ps2-row__main' }, [
            U.el('div', { class: 'ps2-row__title', text: r.title || EVENT_LABEL[r.event] || r.event }),
            U.el('div', { class: 'ps2-row__sub',
              text: new Date(r.at).toLocaleString() + '  ·  ' + (EVENT_LABEL[r.event] || r.event) +
                    (r.overrideReason ? '  ·  reason: ' + U.truncate(r.overrideReason, 60) : '') })
          ]),
          r.override ? C.badge('override', 'crit') : null,
          r.verdict ? C.badge(License.badge({ tier: r.verdict }).text, tone) : C.badge(EVENT_LABEL[r.event] || r.event, tone)
        ]));
      });

      body.appendChild(C.section('Ledger — newest first', list,
        U.el('span', { class: 'ps2-caption', text: rows.length + ' entries' })));
    }
  };

  global.ComplianceView = ComplianceView;
})(window);
