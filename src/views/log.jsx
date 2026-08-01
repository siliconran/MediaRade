/* =============================================================================
   views/log.jsx — tail of Logs\mediarade.log
   MediaRade by rad1x
   ========================================================================== */
import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import Paths from '../core/paths.js';
import { CEP } from '../core/cep.js';
import { Chip } from '../ui/components.jsx';

const MAX_LINES = 500;
const POLL_MS = 2000;

export function LogView() {
  const [lines, setLines] = createSignal([]);
  const [error, setError] = createSignal(null);
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [stamp, setStamp] = createSignal('');
  const [text, setText] = createSignal('');

  let pre, timer = null;
  let lastSize = -1, lastMtime = 0;

  const visible = createMemo(function () {
    const q = text().toLowerCase();
    if (!q) return lines();
    return lines().filter(function (l) { return l.toLowerCase().indexOf(q) > -1; });
  });

  function refresh(full) {
    const p = Paths.file('log');
    const st = Paths.stat(p);
    if (!st) {
      if (full) {
        setLines([]);
        setError('No log file yet — entries will appear here once the panel runs a search, download or check.');
      }
      return;
    }
    const mtime = st.mtimeMs || st.mtime || 0;
    if (!full && st.size === lastSize && mtime === lastMtime) return;
    lastSize = st.size;
    lastMtime = mtime;

    const raw = Paths.read(p, '');
    setLines(raw.split(/\r?\n/).slice(-MAX_LINES));
    setStamp(mtime ? new Date(mtime).toLocaleTimeString() : '');
    setError(null);

    requestAnimationFrame(function () {
      if (pre && autoScroll()) pre.scrollTop = pre.scrollHeight;
    });
  }

  onMount(function () {
    refresh(true);
    timer = setInterval(function () { refresh(false); }, POLL_MS);
  });

  onCleanup(function () {
    if (timer) clearInterval(timer);
  });

  return (
    <div class="mr-view__body" style={{ display: 'flex', flexDirection: 'column' }}>
      <div class="mr-view__toolbar">
        <span class="mr-filters__label" style={{ alignSelf: 'center' }}>Log</span>
        <span class="ps2-caption ps2-mono" style={{ alignSelf: 'center' }}>{Paths.file('log')}</span>
        <span class="ps2-panel__spacer" />
        <span class="ps2-caption" style={{ alignSelf: 'center' }}>{stamp() ? 'updated ' + stamp() : ''}</span>
        <input class="ps2-input" type="text" placeholder="Filter…"
          style={{ width: '140px', padding: '4px 8px' }}
          onInput={(e) => setText(e.currentTarget.value)} />
        <Chip label="Auto-scroll" on={autoScroll()} onChange={(on) => setAutoScroll(on)} />
        <button class="ps2-btn ps2-btn--sm" onClick={() => refresh(true)}>Refresh</button>
        <button class="ps2-btn ps2-btn--sm ps2-btn--ghost"
          onClick={() => CEP.openFolder(Paths.dir('logs'))}>
          Open logs folder
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        <Show when={error()}>
          <div class="ps2-caption" style={{ padding: '10px 0', color: 'var(--ps2-warn)' }}>{error()}</div>
        </Show>
        <pre ref={pre} class="mr-attrib mr-log"
          style={{ margin: 0, flex: 1, minHeight: 0, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {visible().join('\n') || (text() ? '— no lines match "' + text() + '" —' : '— nothing yet —')}
        </pre>
        <div class="ps2-caption" style={{ padding: '6px 0 2px', textAlign: 'center' }}>
          {visible().length + ' line' + (visible().length === 1 ? '' : 's') + ' · last ' + MAX_LINES + ' shown'}
        </div>
      </div>
    </div>
  );
}

export default LogView;
