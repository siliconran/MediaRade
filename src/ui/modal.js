/* =============================================================================
   modal.js — dialogs, including the licence-override gate
   MediaRade by sgtsilicon
   ========================================================================== */
import U from '../core/util.js';

let root, box, escHandler = null;

function ensure() {
  root = root || U.$('#modal');
  box = box || U.$('#modalBox');
  return root;
}

export const Modal = {
  open: function (o) {
    ensure();
    U.clear(box);

    const head = U.el('div', { class: 'ps2-panel__header' }, [
      U.el('span', { class: 'ps2-panel__title', text: o.title || 'MediaRade' }),
      U.el('span', { class: 'ps2-panel__spacer' }),
      U.el('button', { class: 'ps2-btn ps2-btn--sm ps2-btn--ghost', text: '✕', onclick: Modal.close })
    ]);

    const body = U.el('div', { class: 'mr-modal__body' });
    U.append(body, o.body);

    const foot = U.el('div', { class: 'mr-modal__foot' });
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
      const input = U.el('input', {
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

  close: function () {
    ensure();
    root.classList.remove('is-open');
    box.innerHTML = '';
    if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
  }
};

export default Modal;
