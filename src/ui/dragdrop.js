/* =============================================================================
   dragdrop.js — dragging media out of the panel and onto Premiere.
   MediaRade by rad1x

   MediaRade has no timeline of its own, so there is exactly one kind of drag
   here: a native OS drag. The dragged clip's local file is published on the
   dataTransfer (text/uri-list + text/plain + DownloadURL), which is the only
   mechanism that can leave a CEP/CEF panel — and it is what lets you drop a
   clip anywhere on Premiere's real timeline or into its project panel.

   Attach it only to nodes whose payload carries a real on-disk file. Anything
   still downloading has no file yet, so the drag is refused rather than
   starting a gesture that cannot complete.

   Every media item also offers "Reveal in Explorer" as a guaranteed fallback,
   and a Place button that inserts via ExtendScript without any dragging.
   ========================================================================== */
import U from '../core/util.js';
import { CEP } from '../core/cep.js';

/** The floating label shown under the cursor while dragging. */
function ghostFor(payload) {
  const kids = [];
  if (payload.thumb) {
    const img = U.el('img', { class: 'mr-dragghost__img' });
    img.src = payload.thumb.indexOf('http') === 0 ? payload.thumb : CEP.toFileUrl(payload.thumb);
    kids.push(img);
  }
  kids.push(U.el('span', { class: 'mr-dragghost__kind', text: (payload.kind || 'media').toUpperCase() }));
  kids.push(U.el('span', { class: 'ps2-truncate', text: U.truncate(payload.title || 'media', 40) }));
  return U.el('div', { class: 'mr-dragghost' }, kids);
}

export const DnD = {

  /**
   * Make a node a native OS drag source.
   * @param {Element}  node
   * @param {Function} payloadFn -> { kind, title, file, nodeId, report, thumb }
   */
  native: function (node, payloadFn) {
    if (!node) return node;
    node.setAttribute('draggable', 'true');
    node.classList.add('mr-draggable');

    node.addEventListener('dragstart', function (e) {
      const payload = typeof payloadFn === 'function' ? payloadFn() : payloadFn;
      if (!payload || !payload.file) { e.preventDefault(); return; }

      // Verify the file still exists on disk before starting a drag.
      try {
        if (CEP.fs && !CEP.fs.existsSync(payload.file)) {
          e.preventDefault();
          return;
        }
      } catch (err) { /* if fs check fails, allow the drag anyway */ }

      const dt = e.dataTransfer;
      if (!dt) { e.preventDefault(); return; }

      // Normalise path separators to backslash for Windows, then build a
      // file:// URL that Premiere and the OS can resolve.
      const path = String(payload.file).replace(/\//g, '\\');
      const url = CEP.toFileUrl(path);
      const name = payload.title || path.split(/[\\/]/).pop();

      try {
        dt.effectAllowed = 'copy';
        // Premiere accepts text/uri-list with a file:// URL.
        dt.setData('text/uri-list', url + '\r\n');
        dt.setData('text/plain', path);
        dt.setData('text/html', '<a href="' + url + '">' + U.esc(name) + '</a>');
        // DownloadURL is used by some hosts to recognise dropped media.
        dt.setData('DownloadURL', 'application/octet-stream:' + encodeURIComponent(name) + ':' + url);

        const ghost = ghostFor(payload);
        document.body.appendChild(ghost);
        if (dt.setDragImage) { try { dt.setDragImage(ghost, 14, 14); } catch (err) { /* keep the default image */ } }
        window.setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 0);

        document.body.classList.add('is-dragging-media');
      } catch (err) {
        e.preventDefault();
      }
    });

    node.addEventListener('dragend', function () {
      document.body.classList.remove('is-dragging-media');
    });

    return node;
  }
};

export default DnD;
