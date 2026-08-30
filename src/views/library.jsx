/* =============================================================================
   views/library.jsx — everything on disk under Documents\MediaRade
   MediaRade by sgtsilicon
   ========================================================================== */
import { For, Show, createMemo, createSignal } from 'solid-js';
import Bus, { state } from '../core/bus.js';
import Paths from '../core/paths.js';
import Library from '../core/library.js';
import Premiere from '../core/premiere.js';
import License from '../core/license.js';
import U from '../core/util.js';
import { CEP } from '../core/cep.js';
import Acquire from '../ui/acquire.js';
import DnD from '../ui/dragdrop.js';
import Toast from '../ui/toast.js';
import Modal from '../ui/modal.js';
import Place from '../ui/place.js';
import { Badge, Btn, Chip, Empty } from '../ui/components.jsx';

/** Thumbnail background layers: the local cache file first, network fallback
    second. Local paths must go through CEP.toFileUrl; remote (http/https)
    thumbs are URLs already and would be mangled into a bogus file:// path. */
function thumbBg(entry) {
  const t = entry && entry.thumb;
  const local = t ? (t.indexOf('http') === 0 ? t : CEP.toFileUrl(t)) : '';
  const net = entry && entry.videoId && entry.videoId.indexOf('manual:') !== 0
    ? U.thumb(entry.videoId) : '';
  const layers = [];
  if (local) layers.push('url("' + local + '")');
  if (net) layers.push('url("' + net + '")');
  return layers.join(', ');
}

export function LibraryView() {
  const [kind, setKind] = createSignal('all');
  const [tier, setTier] = createSignal('all');
  const [sort, setSort] = createSignal('date');
  const [text, setText] = createSignal('');

  const stats = createMemo(function () {
    const s = { count: state.libraryItems.length, bytes: 0, video: 0, audio: 0, low: 0, moderate: 0, high: 0, overridden: 0 };
    state.libraryItems.forEach(function (i) {
      s.bytes += i.size || 0;
      if (i.kind === 'audio') s.audio++; else s.video++;
      const level = License.level(i.report);
      if (level === 'LOW') s.low++;
      else if (level === 'MODERATE') s.moderate++;
      else if (level === 'HIGH' || level === 'CRITICAL') s.high++;
      if (i.override) s.overridden++;
    });
    return s;
  });

  const items = createMemo(function () {
    let out = state.libraryItems.slice();
    if (kind() !== 'all') out = out.filter(function (i) { return i.kind === kind(); });
    if (tier() !== 'all') out = out.filter(function (i) { return License.level(i.report) === tier(); });
    if (text()) {
      const q = text().toLowerCase();
      out = out.filter(function (i) {
        return (i.title || '').toLowerCase().indexOf(q) > -1 ||
               (i.channel || '').toLowerCase().indexOf(q) > -1;
      });
    }
    if (sort() === 'name') out.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    else if (sort() === 'size') out.sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
    else out.sort(function (a, b) { return (b.downloadedAt || 0) - (a.downloadedAt || 0); });
    return out;
  });

  let searchInput;
  const debouncedText = U.debounce(function (v) { setText(v.trim()); }, 200);

  return (
    <div>
      <div class="mr-view__toolbar">
        <div class="mr-searchbar">
          <input ref={searchInput} class="ps2-input" type="text" placeholder="Filter by title or channel…"
            onInput={(e) => debouncedText(e.currentTarget.value)} />
          <Btn label="Folder" title="Open Documents\\MediaRade"
            onClick={() => CEP.openFolder(Paths.dir('root'))} />
        </div>

        <div class="mr-filters">
          <div class="mr-filters__group">
            <span class="mr-filters__label">Type</span>
            <Chip label="All" on={kind() === 'all'} onChange={() => setKind('all')} />
            <Chip label="Video" on={kind() === 'video'} onChange={() => setKind('video')} />
            <Chip label="Audio" on={kind() === 'audio'} onChange={() => setKind('audio')} />
          </div>
          <div class="mr-filters__group">
            <span class="mr-filters__label">Risk</span>
            <Chip label="All" on={tier() === 'all'} onChange={() => setTier('all')} />
            <Chip label="LOW" on={tier() === 'LOW'} onChange={() => setTier('LOW')} />
            <Chip label="MODERATE" on={tier() === 'MODERATE'} onChange={() => setTier('MODERATE')} />
            <Chip label="HIGH" on={tier() === 'HIGH'} onChange={() => setTier('HIGH')} />
            <Chip label="CRITICAL" on={tier() === 'CRITICAL'} onChange={() => setTier('CRITICAL')} />
          </div>
          <div class="mr-filters__group">
            <span class="mr-filters__label">Sort</span>
            <Chip label="Newest" on={sort() === 'date'} onChange={() => setSort('date')} />
            <Chip label="Name" on={sort() === 'name'} onChange={() => setSort('name')} />
            <Chip label="Size" on={sort() === 'size'} onChange={() => setSort('size')} />
          </div>
        </div>

        <div class="ps2-caption" style={{ marginTop: '8px' }}>
          {stats().count + ' items · ' + U.bytes(stats().bytes) + ' · ' +
            stats().low + ' LOW risk' +
            (stats().moderate ? ' · ' + stats().moderate + ' moderate' : '') +
            (stats().high ? ' · ' + stats().high + ' high' : '') +
            (stats().overridden ? ' · ' + stats().overridden + ' overridden' : '')}
        </div>
      </div>

      <div class="mr-view__body">
        <Show
          when={items().length > 0}
          fallback={
            <Empty
              title={state.libraryItems.length ? 'Nothing matches' : 'Library is empty'}
              hint={state.libraryItems.length
                ? 'Loosen the filters above.'
                : 'Downloads land in <code>Documents\\MediaRade\\Downloads</code> and show up here, ' +
                  'each with the licence record that was captured at download time.'}
            />
          }
        >
          <div class="mr-lib-grid">
            <For each={items()}>
              {(e) => <LibraryItem e={e} />}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

function LibraryItem(props) {
  const e = () => props.e;
  const payload = () => Acquire.payload(e());
  const badge = () => License.badge(e().report);

  function importBin() {
    Premiere.importFile(e().file, { report: e().report, title: e().title })
      .then(function (d) { e().nodeId = d.nodeId; Library.save(); Toast.ok('Imported', d.name); })
      .catch(function (err) { Toast.err('Import failed', err.message); });
  }

  function remove() {
    Modal.confirm({
      title: 'Remove from library',
      body: 'Delete <b>' + U.esc(e().name || e().title) + '</b> from disk as well?<br>' +
            '<span class="ps2-caption">The ledger entry in Compliance\\ is kept either way.</span>',
      okLabel: 'Delete files', cancelLabel: 'Keep files', danger: true
    }).then(function (deleteFiles) {
      Library.remove(e().id, deleteFiles);
      Toast.info('Removed', deleteFiles ? 'Files deleted.' : 'Removed from the library only.');
    });
  }

  function showRecord() {
    const sidecar = Library.sidecar(e());
    const report = e().report;

    const body = U.el('div', { class: 'ps2-col-gap' }, [
      report
        ? recordBody(report)
        : U.el('div', { class: 'ps2-caption', text: 'No report was stored for this item.' }),
      U.el('div', { class: 'ps2-hr' }),
      U.el('dl', { class: 'mr-meta-grid' }, [
        U.el('dt', { text: 'File' }), U.el('dd', { text: e().file || '' }),
        U.el('dt', { text: 'Sidecar' }), U.el('dd', { text: sidecar ? 'present' : 'missing' }),
        U.el('dt', { text: 'Downloaded' }), U.el('dd', { text: e().downloadedAt ? new Date(e().downloadedAt).toLocaleString() : '' })
      ])
    ]);

    Modal.open({
      title: 'Licence record',
      body: body,
      buttons: [
        { label: 'Open folder', run: function () { CEP.revealInExplorer(e().file); } },
        { label: 'Close', variant: 'primary', run: function () { Modal.close(); } }
      ]
    });
  }

  return (
    <div class="mr-lib-item">
      <div
        class="mr-lib-item__thumb"
        style={{ backgroundImage: thumbBg(e()) }}
        title="Drag onto Premiere's timeline or project panel"
        ref={(el) => DnD.native(el, function () { return payload(); })}
      >
        <span class="mr-lib-item__kind">{e().kind === 'audio' ? '♪ AUDIO' : '▦ VIDEO'}</span>
      </div>

      <div class="mr-lib-item__body">
        <div class="mr-lib-item__name" title={e().title}>{e().title}</div>
        <div class="ps2-caption ps2-truncate">{e().channel || ''}</div>
        <div class="ps2-row-gap ps2-wrap">
          <Badge text={badge().text} kind={badge().cls} />
          {e().size ? <span class="ps2-caption">{U.bytes(e().size)}</span> : null}
        </div>
      </div>

      <div class="mr-lib-item__foot">
        <Btn size="sm" variant="primary" label="Place"
          ref={(el) => DnD.native(el, function () { return payload(); })}
          title="Insert at the configured target — or drag this button straight onto Premiere's timeline"
          onClick={() => Place.quick(payload())} />
        <Btn size="sm" label="Bin" title="Import to the project bin" onClick={importBin} />
        <Btn size="sm" label="ⓘ" title="Licence record" onClick={showRecord} />
        <Btn size="sm" label="⤴" title="Reveal in Explorer"
          onClick={() => CEP.revealInExplorer(e().file)} />
        <Btn size="sm" label="✕" title="Remove" onClick={remove} />
      </div>
    </div>
  );
}

/** Compact DOM build of the licence record for the modal (mirrors LicenseReport). */
function recordBody(report) {
  const t = report.levelInfo;
  const children = [
    U.el('div', { class: 'mr-verdict mr-verdict--' + t.tone }, [
      U.el('div', { class: 'mr-verdict__seal', text: t.seal }),
      U.el('div', { class: 'ps2-grow' }, [
        U.el('div', { class: 'mr-verdict__title', text: t.title }),
        U.el('div', { class: 'mr-verdict__line', html: t.line })
      ]),
      U.el('div', { class: 'mr-verdict__score' }, [
        U.el('b', { text: report.score }),
        U.el('span', { class: 'ps2-caption', text: 'risk' })
      ])
    ])
  ];

  if (report.attribution) {
    children.push(U.el('div', { class: 'mr-attrib', style: { marginTop: '10px' }, text: report.attribution.credits }));
  }

  return U.el('div', {}, children);
}

export default LibraryView;
