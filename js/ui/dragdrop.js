/* =============================================================================
   dragdrop.js — drag media from anywhere in the panel onto a timeline target.
   MediaRade by rad1x

   Why this file ships two kinds of drag:
   1. Pointer-based drag (DnD.source) stays inside the panel and lands on the
      dock's track lanes / persist points, which drive the real ExtendScript
      insert. This always works, because it never leaves the panel.
   2. Native OS drag (DnD.native) publishes the clip's local file path through
      the dataTransfer (text/uri-list + text/plain + DownloadURL). In CEP/CEF
      this is the only mechanism that can leave the panel, so it is what lets
      you drag a button straight onto Premiere Pro's real timeline or project
      panel. Attach it only to nodes whose payload has a real on-disk file.

   For a genuine OS-level drag into the Premiere project panel, every media item
   also offers "Reveal in Explorer".
   ========================================================================== */
(function (global) {
  'use strict';

  var drag = null;      // { payload, ghost, target }
  var THRESHOLD = 5;

  function ghostFor(payload) {
    return U.el('div', { class: 'mr-dragghost' }, [
      U.el('span', { class: 'mr-dragghost__kind', text: (payload.kind || 'media').toUpperCase() }),
      U.el('span', { class: 'ps2-truncate', text: U.truncate(payload.title || 'media', 40) })
    ]);
  }

  function targetAt(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el !== document.body) {
      if (el.hasAttribute && el.hasAttribute('data-drop')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function clearOver() {
    U.$$('.is-over').forEach(function (n) { n.classList.remove('is-over'); });
  }

  function begin(payload, x, y) {
    drag = { payload: payload, ghost: ghostFor(payload), target: null };
    document.body.appendChild(drag.ghost);
    document.body.classList.add('is-dragging-media');
    State.drag = payload;
    Bus.emit('drag:start', payload);
    move(x, y);
  }

  function move(x, y) {
    if (!drag) return;
    drag.ghost.style.left = x + 'px';
    drag.ghost.style.top = y + 'px';

    var t = targetAt(x, y);
    if (t !== drag.target) {
      clearOver();
      drag.target = t;
      if (t) t.classList.add('is-over');
    }
  }

  function end(commit) {
    if (!drag) return;
    var payload = drag.payload, target = drag.target;

    if (drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    clearOver();
    document.body.classList.remove('is-dragging-media');
    State.drag = null;
    drag = null;
    Bus.emit('drag:end');

    if (commit && target && typeof target.__mrDrop === 'function') {
      try { target.__mrDrop(payload, target); }
      catch (e) { Toast.err('Drop failed', e.message); }
    }
  }

  var DnD = {

    /**
     * Make a node draggable.
     * @param {Element}  node
     * @param {Function} payloadFn -> { kind:'video'|'audio', title, file, nodeId, report, entry }
     */
    source: function (node, payloadFn) {
      if (!node) return node;
      node.style.cursor = node.style.cursor || 'grab';

      node.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        var sx = e.clientX, sy = e.clientY, started = false;

        function onMove(ev) {
          if (!started) {
            if (Math.abs(ev.clientX - sx) < THRESHOLD && Math.abs(ev.clientY - sy) < THRESHOLD) return;
            var payload = payloadFn();
            if (!payload) { cleanup(); return; }
            started = true;
            begin(payload, ev.clientX, ev.clientY);
            node.classList.add('is-dragging');
          }
          ev.preventDefault();
          move(ev.clientX, ev.clientY);
        }

        function onUp(ev) {
          cleanup();
          if (started) { ev.preventDefault(); ev.stopPropagation(); end(true); }
        }

        function onKey(ev) { if (ev.key === 'Escape') { cleanup(); end(false); } }

        function cleanup() {
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('mouseup', onUp, true);
          document.removeEventListener('keydown', onKey, true);
          node.classList.remove('is-dragging');
        }

        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
        document.addEventListener('keydown', onKey, true);
      });

      return node;
    },

    /**
     * Mark a node as a drop target.
     * @param {Element}  node
     * @param {Function} onDrop(payload, node)
     */
    target: function (node, onDrop) {
      if (!node) return node;
      node.setAttribute('data-drop', '1');
      node.__mrDrop = onDrop;
      return node;
    },

    /**
     * Make a node a native OS drag source (HTML5 drag-and-drop).
     * This is the path that can actually leave the CEF panel: the payload is
     * published as a local file (text/uri-list, text/plain, DownloadURL) so
     * Premiere Pro's own project panel and timeline accept the drop. Only
     * attach it to nodes whose payload carries a real on-disk file.
     * @param {Element}  node
     * @param {Function} payloadFn -> { kind, title, file, nodeId, report }
     */
    native: function (node, payloadFn) {
      if (!node) return node;
      node.setAttribute('draggable', 'true');
      node.addEventListener('dragstart', function (e) {
        var payload = payloadFn();
        if (!payload || !payload.file) { e.preventDefault(); return; }
        var dt = e.dataTransfer;
        if (!dt) { e.preventDefault(); return; }
        var path = String(payload.file).replace(/\//g, '\\');
        var url = (typeof CEP.toFileUrl === 'function')
          ? CEP.toFileUrl(path)
          : ('file:///' + path.replace(/\\/g, '/'));
        var name = payload.title || path.split(/[\\/]/).pop();
        try {
          dt.effectAllowed = 'copy';
          dt.setData('text/uri-list', url + '\r\n');
          dt.setData('text/plain', path);
          dt.setData('DownloadURL', 'application/octet-stream:' + encodeURIComponent(name) + ':' + url);
          var ghost = ghostFor(payload);
          document.body.appendChild(ghost);
          if (dt.setDragImage) { try { dt.setDragImage(ghost, 14, 14); } catch (e2) {} }
          window.setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 0);
        } catch (err) {
          e.preventDefault();
        }
      });
      node.addEventListener('dragend', function () { clearOver(); });
      return node;
    },

    isDragging: function () { return !!drag; }
  };

  global.DnD = DnD;
})(window);
