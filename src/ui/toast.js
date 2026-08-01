/* =============================================================================
   toast.js — transient notices. MediaRade by rad1x
   ========================================================================== */
import U from '../core/util.js';
import Bus from '../core/bus.js';

let host;

function ensure() { return host || (host = U.$('#toasts')); }

export const Toast = {
  show: function (o) {
    const h = ensure();
    if (!h) return null;
    o = typeof o === 'string' ? { text: o } : (o || {});

    const node = U.el('div', { class: 'mr-toast mr-toast--' + (o.kind || 'info') }, [
      U.el('div', { class: 'ps2-grow' }, [
        o.title ? U.el('div', { class: 'mr-toast__title', text: o.title }) : null,
        U.el('div', { text: o.text || '' })
      ]),
      o.action ? U.el('button', {
        class: 'ps2-btn ps2-btn--sm ps2-btn--ghost',
        text: o.action.label,
        onclick: function () { close(); o.action.run(); }
      }) : null
    ]);

    h.appendChild(node);

    let timer = null;
    function close() {
      if (!node.parentNode) return;
      clearTimeout(timer);
      node.classList.add('is-out');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 220);
    }
    node.addEventListener('click', function (e) { if (e.target === node || e.target.parentNode === node) close(); });

    const life = o.sticky ? 0 : (o.duration || (o.kind === 'err' ? 8000 : 4200));
    if (life) timer = setTimeout(close, life);

    // keep the stack shallow
    while (h.children.length > 5) h.removeChild(h.firstChild);

    return { close: close, node: node };
  },

  ok:   function (title, text) { return Toast.show({ kind: 'ok', title: title, text: text }); },
  warn: function (title, text) { return Toast.show({ kind: 'warn', title: title, text: text }); },
  err:  function (title, text) { return Toast.show({ kind: 'err', title: title, text: text, duration: 9000 }); },
  info: function (title, text) { return Toast.show({ kind: 'info', title: title, text: text }); }
};

Bus.on('toast', function (o) { Toast.show(o); });

export default Toast;
