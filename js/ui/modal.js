/* =============================================================================
   modal.js — dialogs, including the licence-override gate
   MediaRade by siliconran
   ========================================================================== */
(function (global) {
  'use strict';

  var root, box, escHandler = null;

  function ensure() {
    root = root || U.$('#modal');
    box = box || U.$('#modalBox');
    return root;
  }

  var Modal = {
    open: function (o) {
      ensure();
      U.clear(box);

      var head = U.el('div', { class: 'ps2-panel__header' }, [
        U.el('span', { class: 'ps2-panel__title', text: o.title || 'MediaRade' }),
        U.el('span', { class: 'ps2-panel__spacer' }),
        U.el('button', { class: 'ps2-btn ps2-btn--sm ps2-btn--ghost', text: '✕', onclick: Modal.close })
      ]);

      var body = U.el('div', { class: 'mr-modal__body' });
      U.append(body, o.body);

      var foot = U.el('div', { class: 'mr-modal__foot' });
      (o.buttons || []).forEach(function (b) {
        foot.appendChild(U.el('button', {
          class: 'ps2-btn ' + (b.variant ? 'ps2-btn--' + b.variant : 'ps2-btn--ghost'),
          text: b.label,
          disabled: b.disabled,
          id: b.id || null,
          onclick: function () { if (b.run) b.run(Modal); else Modal.close(); }
        }));
      });

      U.append(box, [head, body, o.buttons && o.buttons.length ? foot : null]);
      root.classList.add('is-open');

      escHandler = function (e) { if (e.key === 'Escape') Modal.close(); };
      document.addEventListener('keydown', escHandler);
      if (o.onOpen) setTimeout(function () { o.onOpen(box); }, 0);
      return Modal;
    },

    close: function () {
      ensure();
      root.classList.remove('is-open');
      if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
      U.clear(box);
    },

    confirm: function (o) {
      return new Promise(function (resolve) {
        Modal.open({
          title: o.title || 'Confirm',
          body: typeof o.body === 'string'
            ? U.el('p', { style: { fontSize: '12px', lineHeight: '1.6', margin: '0 0 4px' }, html: o.body })
            : o.body,
          buttons: [
            { label: o.cancelLabel || 'Cancel', run: function () { Modal.close(); resolve(false); } },
            { label: o.okLabel || 'Confirm', variant: o.danger ? 'danger' : 'primary',
              run: function () { Modal.close(); resolve(true); } }
          ]
        });
      });
    },

    prompt: function (o) {
      return new Promise(function (resolve) {
        var input = U.el('input', {
          class: 'ps2-input', type: 'text', value: o.value || '', placeholder: o.placeholder || ''
        });
        Modal.open({
          title: o.title || 'Enter a value',
          body: U.el('div', { class: 'ps2-col-gap' }, [
            o.text ? U.el('div', { class: 'ps2-caption', text: o.text }) : null,
            input
          ]),
          buttons: [
            { label: 'Cancel', run: function () { Modal.close(); resolve(null); } },
            { label: o.okLabel || 'OK', variant: 'primary', run: function () { Modal.close(); resolve(input.value.trim() || null); } }
          ],
          onOpen: function () { input.focus(); input.select(); }
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { Modal.close(); resolve(input.value.trim() || null); }
        });
      });
    },

    /* =======================================================================
       The override gate.

       Reached only when a licence verdict does not permit reuse. It refuses to
       proceed while strict mode is on, requires a written reason, and requires
       the exact acknowledgement phrase to be typed. All three land in the
       ledger, because the point is an auditable record of a human decision.
       ==================================================================== */
    override: function (info, report) {
      var PHRASE = 'I ACCEPT THE RISK';

      return new Promise(function (resolve) {
        var strict = Config.get('strictMode');

        var reasons = U.el('div', { class: 'ps2-col-gap', style: { marginBottom: '12px' } },
          report.gate.reasons.map(function (r) {
            return U.el('div', { class: 'mr-signal mr-signal--crit' }, [
              U.el('span', { class: 'mr-signal__icon', text: '!' }),
              U.el('span', { class: 'ps2-grow', text: r })
            ]);
          })
        );

        var reason = U.el('textarea', {
          class: 'ps2-textarea',
          placeholder: 'Why are you overriding? e.g. "Written permission from the uploader, email 2026-07-28, filed in /legal."'
        });

        var ack = U.el('input', {
          class: 'ps2-input',
          type: 'text',
          placeholder: 'Type: ' + PHRASE,
          style: { fontFamily: 'var(--ps2-font-mono)', textTransform: 'uppercase' }
        });

        var goBtn = null;

        function validate() {
          if (!goBtn) return;
          var okReason = reason.value.trim().length >= 12;
          var okAck = !Config.get('requireAckPhrase') || ack.value.trim().toUpperCase() === PHRASE;
          var enabled = !strict && okReason && okAck;
          goBtn.disabled = !enabled;
          goBtn.classList.toggle('is-disabled', !enabled);
        }
        reason.addEventListener('input', validate);
        ack.addEventListener('input', validate);

        var body = U.el('div', { class: 'ps2-col-gap' }, [
          U.el('div', { class: 'mr-verdict mr-verdict--' + report.tierInfo.tone }, [
            U.el('div', { class: 'mr-verdict__seal', text: report.tierInfo.seal }),
            U.el('div', { class: 'ps2-grow' }, [
              U.el('div', { class: 'mr-verdict__title', text: report.tierInfo.title }),
              U.el('div', { class: 'mr-verdict__line', html: report.tierInfo.line })
            ])
          ]),

          U.el('div', { class: 'mr-section__title', text: 'Why this is blocked' }),
          reasons,

          strict
            ? U.el('div', { class: 'mr-claimwarn' }, [
                U.el('span', { text: '🔒' }),
                U.el('span', { html:
                  '<b>Strict mode is on.</b> This download cannot proceed. Strict mode is the ' +
                  'protection that stops mislabelled "royalty free" uploads reaching your timeline. ' +
                  'If you genuinely hold rights to this material, turn strict mode off in Settings — ' +
                  'that change is itself recorded in the ledger.' })
              ])
            : U.el('div', { class: 'mr-claimwarn' }, [
                U.el('span', { text: '⚠' }),
                U.el('span', { html:
                  'You are about to override a licence verdict. Your reason and acknowledgement are ' +
                  'written to <code>Compliance\\license-ledger.jsonl</code> with a timestamp. ' +
                  'MediaRade cannot give you rights you do not have.' })
              ]),

          U.el('div', { class: 'mr-field' }, [
            U.el('span', { class: 'mr-field__label', text: 'Reason for override (required, min 12 chars)' }),
            reason
          ]),

          Config.get('requireAckPhrase') ? U.el('div', { class: 'mr-field' }, [
            U.el('span', { class: 'mr-field__label', text: 'Type the acknowledgement exactly' }),
            ack
          ]) : null
        ]);

        Modal.open({
          title: 'Licence override',
          body: body,
          buttons: [
            { label: 'Cancel', run: function () { Modal.close(); resolve(null); } },
            strict ? {
              label: 'Open settings',
              run: function () { Modal.close(); resolve(null); Bus.emit('nav', 'settings'); }
            } : null,
            {
              label: 'Override and download',
              variant: 'danger',
              id: 'mrOverrideGo',
              disabled: true,
              run: function () {
                Modal.close();
                resolve({ reason: reason.value.trim(), ack: PHRASE });
              }
            }
          ].filter(Boolean),
          onOpen: function (b) {
            goBtn = U.$('#mrOverrideGo', b);
            validate();
            reason.focus();
          }
        });
      });
    }
  };

  global.Modal = Modal;
})(window);
