/* =============================================================================
   main.js — boot, wiring, lifecycle. MediaRade by sgtsilicon
   ========================================================================== */
(function (global) {
  'use strict';

  var BOOT_MS = 2600;   // matches --ps2-dur-boot in ps2ui.css

  /* --- one place where every module is switched on ----------------------- */

  function initUI() {
    Ambient.start();
    Nav.init();
    Browse.init();
    Video.init();
    QueueView.init();
    LibraryView.init();
    PointsView.init();
    ComplianceView.init();
    SettingsView.init();
    Dock.init();
    Nav.go('browse');
  }

  function initHost() {
    Premiere.connect().then(function () {
      Premiere.startPolling(1500);
    }).catch(function (e) {
      Paths.log('host connect failed: ' + e.message);
      // keep re-probing in the background; the dock will show "no host"
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

  /* --- shortcuts, boot overlay, teardown --------------------------------- */

  function wireLifecycle() {
    // never leave yt-dlp / ffmpeg orphaned when the panel dies
    window.addEventListener('beforeunload', function () { Proc.killAll(); });

    // Ctrl/Cmd+F jumps straight to search
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        Bus.emit('nav', 'browse');
        if (Browse.focusSearch) Browse.focusSearch();
      }
    });

    // clear the boot overlay once its CSS animation has run
    var boot = U.$('#boot');
    if (!boot) return;
    if (!Config.get('showBoot')) { boot.style.display = 'none'; return; }
    var clearBoot = function () { if (boot.parentNode) boot.parentNode.removeChild(boot); };
    boot.addEventListener('animationend', clearBoot, { once: true });
    setTimeout(clearBoot, BOOT_MS + 900);
  }

  /* --- failure screen ------------------------------------------------------ */

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
      C.btn('Reload', { variant: 'primary', onclick: function () { location.reload(); } })
    ]));
  }

  /* --- boot ---------------------------------------------------------------- */

  function run() {
    try {
      Config.load();
      Paths.bootstrap();
      Search.init();
      Library.load();
      Paths.log('boot complete — MediaRade 1.3.4 by rad1x');
    } catch (e) {
      console.error('[MediaRade] startup failed:', e);
      fatal(e);
      return;
    }
    initUI();
    initHost();
    initTools();
    wireLifecycle();
  }

  function boot() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }

  boot();
})(window);
