/* =============================================================================
   nav.jsx — rail navigation, view routing, header status chips
   MediaRade by sgtsilicon
   ========================================================================== */
import { For, createMemo } from 'solid-js';
import Bus, { state } from '../core/bus.js';
import Config from '../core/config.js';
import U from '../core/util.js';
import { useConfig } from './reactive.js';
import { Badge } from './components.jsx';

export const VIEWS = [
  { id: 'browse',     icon: 'browse',  label: 'Browse' },
  { id: 'video',      icon: 'video',   label: 'Video' },
  { id: 'queue',      icon: 'queue',   label: 'Queue' },
  { id: 'uppbeat',    icon: 'music',   label: 'Uppbeat' },
  { id: 'library',    icon: 'library', label: 'Library' },
  { id: 'compliance', icon: 'shield',  label: 'Licence' },
  { id: 'log',        icon: 'log',     label: 'Log' },
  { id: 'settings',   icon: 'gear',    label: 'Setup' }
];

export const Nav = {
  VIEWS: VIEWS,

  go: function (id) {
    if (!VIEWS.some(function (v) { return v.id === id; })) return;
    Bus.patch({ view: id }, 'view');
    Bus.emit('view', id);
  }
};

/** Route 'nav' Bus events to Nav.go (used by acquire, modal, keyboard). */
export function wireNav() {
  return Bus.on('nav', Nav.go);
}

/* --- rail ---------------------------------------------------------------- */

export function Rail() {
  const queueBadge = createMemo(function () {
    return state.jobs.reduce(function (n, j) {
      return n + (j.state === 'queued' || j.state === 'running' ? 1 : 0);
    }, 0);
  });

  const libraryBadge = createMemo(function () { return state.libraryItems.length; });

  const [uppbeatOn] = useConfig('uppbeatEnabled');

  const badgeFor = function (id) {
    if (id === 'queue') return queueBadge();
    if (id === 'library') return libraryBadge();
    return 0;
  };

  const visible = createMemo(function () {
    return VIEWS.filter(function (v) { return v.id !== 'uppbeat' || uppbeatOn(); });
  });

  return (
    <nav class="mr-rail" id="rail">
      <div class="mr-rail__logo">
        <div class="ps2-cube">
          <div class="ps2-cube__inner">
            <For each={[1, 2, 3, 4, 5, 6]}>
              {() => <i class="ps2-cube__face" />}
            </For>
          </div>
        </div>
      </div>
      <For each={visible()}>
        {(v) => (
          <>
            {v.id === 'settings' && <div class="mr-rail__spacer" />}
            <button
              class={'ps2-tile' + (state.view === v.id ? ' is-active' : '')}
              title={v.label}
              onClick={() => Nav.go(v.id)}
            >
              <span innerHTML={U.icon(v.icon)} />
              <span class="ps2-tile__label">{v.label}</span>
              {badgeFor(v.id) > 0 && (
                <span class="ps2-tile__badge">
                  {badgeFor(v.id) > 99 ? '99+' : badgeFor(v.id)}
                </span>
              )}
            </button>
          </>
        )}
      </For>
    </nav>
  );
}

/* --- header status chips -------------------------------------------------- */

export function StatusChips() {
  const [strict] = useConfig('strictMode');

  return (
    <div class="mr-status" id="status">
      <span
        class={'ps2-badge ps2-badge--' + (strict() ? 'ok' : 'crit')}
        style={{ cursor: 'pointer' }}
        title={strict()
          ? 'Strict mode: only machine-verified Creative Commons material can be downloaded. Click to review in Settings.'
          : 'Strict mode is OFF — unverified material can be downloaded. Click to review in Settings.'}
        onClick={() => Nav.go('settings')}
      >
        <i class="ps2-badge__dot" />
        <span>{strict() ? 'STRICT' : 'STRICT OFF'}</span>
      </span>

      {state.tools.checked && !state.tools.ytdlp && (
        <span
          class="ps2-badge ps2-badge--crit"
          style={{ cursor: 'pointer' }}
          title="yt-dlp was not found. Click to set its path."
          onClick={() => Nav.go('settings')}
        >
          <i class="ps2-badge__dot" />
          <span>no yt-dlp</span>
        </span>
      )}

      {state.tools.checked && state.tools.ytdlp && !state.tools.ffmpeg && (
        <span
          class="ps2-badge ps2-badge--warn"
          title="ffmpeg was not found. Merging and audio extraction will fail."
        >
          <i class="ps2-badge__dot" />
          <span>no ffmpeg</span>
        </span>
      )}

      <Badge
        kind={state.host.connected ? 'info' : 'mute'}
        text={state.host.connected
          ? (state.project && state.project.name ? U.truncate(state.project.name, 18) : 'connected')
          : 'no host'}
      />
    </div>
  );
}
