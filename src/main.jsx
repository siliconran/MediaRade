/* =============================================================================
   main.jsx — boot, wiring, lifecycle. MediaRade by rad1x
   ========================================================================== */
import { render } from 'solid-js/web';
import { For, Show, createSignal } from 'solid-js';

import '../css/ps2ui.css';
import '../css/mediarade.css';

import Bus, { state } from './core/bus.js';
import Config from './core/config.js';
import Paths from './core/paths.js';
import Search from './core/search.js';
import Library from './core/library.js';
import Premiere from './core/premiere.js';
import YtDlp from './core/ytdlp.js';
import Proc from './core/proc.js';
import U from './core/util.js';
import Inbox from './core/inbox.js';

import Ambient from './ui/ambient.js';
import { wireNav, Nav, Rail, StatusChips } from './ui/nav.jsx';
import Toast from './ui/toast.js';
import Acquire from './ui/acquire.js';
import License from './core/license.js';
import Uppbeat from './core/uppbeat.js';
import SP from './core/sp.js';
import Queue from './core/queue.js';
import BrowseView, { focusSearch } from './views/browse.jsx';
import VideoView from './views/video.jsx';
import QueueView from './views/queue.jsx';
import LibraryView from './views/library.jsx';
import UppbeatView from './views/uppbeat.jsx';
import ComplianceView from './views/compliance.jsx';
import SettingsView from './views/settings.jsx';
import LogView from './views/log.jsx';

const BOOT_MS = 2600;   // matches --ps2-dur-boot in ps2ui.css

/* --- app shell ------------------------------------------------------------ */

function App() {
  return (
    <>
      <Rail />
      <header class="mr-header">
        <div class="mr-wordmark">
          <span class="mr-wordmark__name">MEDIA<b>RADE</b></span>
          <span class="mr-wordmark__by">by rad1x</span>
        </div>
        <StatusChips />
      </header>
      <main class="mr-main" id="main">
        <Show when={state.view === 'browse'}>
          <div class="mr-view is-active" data-view="browse"><BrowseView /></div>
        </Show>
        <Show when={state.view === 'video'}>
          <div class="mr-view is-active" data-view="video"><VideoView /></div>
        </Show>
        <Show when={state.view === 'queue'}>
          <div class="mr-view is-active" data-view="queue"><QueueView /></div>
        </Show>
        <Show when={state.view === 'library'}>
          <div class="mr-view is-active" data-view="library"><LibraryView /></div>
        </Show>
        <Show when={state.view === 'uppbeat'}>
          <div class="mr-view is-active" data-view="uppbeat"><UppbeatView /></div>
        </Show>
        <Show when={state.view === 'compliance'}>
          <div class="mr-view is-active" data-view="compliance"><ComplianceView /></div>
        </Show>
        <Show when={state.view === 'log'}>
          <div class="mr-view is-active" data-view="log"><LogView /></div>
        </Show>
        <Show when={state.view === 'settings'}>
          <div class="mr-view is-active" data-view="settings"><SettingsView /></div>
        </Show>
      </main>
    </>
  );
}

/* --- host, tools ----------------------------------------------------------- */

function initHost() {
  Premiere.connect().then(function () {
    Premiere.startPolling(1500);
  }).catch(function (e) {
    Paths.log('host connect failed: ' + e.message);
    Premiere.startPolling(1500);
  });
}

function initTools() {
  YtDlp.locate().then(function (r) {
    Paths.log('tools: yt-dlp=' + (r.ytdlp || 'none') + ' ffmpeg=' + (r.ffmpeg || 'none'));
  }).catch(function (e) {
    Paths.log('tool detection failed: ' + e.message);
  });
}

/* --- shortcuts, boot overlay, teardown ------------------------------------- */

function wireLifecycle() {
  window.addEventListener('beforeunload', function () { Proc.killAll(); });

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      Bus.emit('nav', 'browse');
      if (focusSearch) focusSearch();
    }
  });

  var boot = U.$('#boot');
  if (!boot) return;
  if (!Config.get('showBoot')) { boot.style.display = 'none'; return; }
  var clearBoot = function () { if (boot.parentNode) boot.parentNode.removeChild(boot); };
  boot.addEventListener('animationend', clearBoot, { once: true });
  setTimeout(clearBoot, BOOT_MS + 900);
}

/* --- failure screen --------------------------------------------------------- */

function fatal(err) {
  var boot = U.$('#boot');
  if (boot) boot.style.display = 'none';
  var main = U.$('#main');
  if (!main) return;
  main.style.cssText = 'display:flex;align-items:center;justify-content:center;';
  U.clear(main);
  main.appendChild(U.el('div', { class: 'mr-empty' }, [
    U.el('div', { class: 'mr-empty__title', text: 'MediaRade could not start' }),
    U.el('div', { class: 'mr-empty__hint', html: U.esc(err && err.message ? err.message : String(err)) }),
    U.el('button', { class: 'ps2-btn ps2-btn--primary', text: 'Reload',
      onclick: function () { location.reload(); } })
  ]));
}

/* --- inbox ------------------------------------------------------------------
   Other apps (FictusTube, FurcaTube) hand a video over by dropping a JSON job
   into Documents\MediaRade\Inbox. Downloading it goes through exactly the same
   Acquire path as a click in the panel, so the licence gate, the ledger and the
   sidecars all still apply — a handover must not become a way around them.
   ---------------------------------------------------------------------------- */

function wireInbox() {
  Bus.on('inbox:job', function (job) {
    const id = U.videoId(job.url);
    if (!id) {
      /* Non-YouTube links have no licence verdict path here, so say so rather
         than silently dropping the job. */
      Toast.err('Cannot accept that link', (job.from || 'An app') + ' sent "' + U.truncate(job.url, 60) +
        '", which is not a YouTube video. MediaRade can only verify and download YouTube links.');
      return;
    }
    Toast.info('Sent from ' + (job.from || 'another app'),
      (job.title || job.url) + ' — checking its licence, then downloading as ' + job.kind + '.');
    Bus.patch({ view: 'queue' });
    Acquire.request(id, job.kind);
  });
  Inbox.start();
}

/* --- boot ------------------------------------------------------------------- */

function run() {
  try {
    Config.load();
    Paths.bootstrap();
    Search.init();
    Library.load();
    wireInbox();
    Paths.log('boot complete — MediaRade 1.3.4 by rad1x');
  } catch (e) {
    console.error('[MediaRade] startup failed:', e);
    fatal(e);
    return;
  }

  /* Diagnostics handle. The Setup › Diagnostics panel and the CEF debugger
     (localhost:8099) both reach the engine through this. */
  window.MR = {
    builtAt: __BUILD_STAMP__,
    Config: Config, Paths: Paths, Search: Search, Library: Library, Queue: Queue, Inbox: Inbox,
    Premiere: Premiere, YtDlp: YtDlp, License: License, Uppbeat: Uppbeat, SP: SP, Bus: Bus, U: U
  };

  render(function () { return <App />; }, U.$('#app'));

  wireNav();
  Ambient.start();
  initHost();
  initTools();
  wireLifecycle();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
else run();
