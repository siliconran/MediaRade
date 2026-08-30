/* =============================================================================
   nav.js — rail navigation, view routing, header status chips
   MediaRade by sgtsilicon
   ========================================================================== */
(function (global) {
  'use strict';

  var VIEWS = [
    { id: 'browse',     icon: 'browse',  label: 'Browse' },
    { id: 'video',      icon: 'video',   label: 'Video' },
    { id: 'queue',      icon: 'queue',   label: 'Queue' },
    { id: 'library',    icon: 'library', label: 'Library' },
    { id: 'points',     icon: 'points',  label: 'Points' },
    { id: 'compliance', icon: 'shield',  label: 'Licence' },
    { id: 'settings',   icon: 'gear',    label: 'Setup' }
  ];

  var rail, status, tiles = {};

  var Nav = {
    VIEWS: VIEWS,

    init: function () {
      rail = U.$('#rail');
      status = U.$('#status');

      VIEWS.forEach(function (v) {
        if (v.id === 'settings') rail.appendChild(U.el('div', { class: 'mr-rail__spacer' }));
        var tile = U.el('button', {
          class: 'ps2-tile', title: v.label,
          onclick: function () { Nav.go(v.id); }
        }, [
          U.el('span', { html: U.icon(v.icon) }),
          U.el('span', { class: 'ps2-tile__label', text: v.label })
        ]);
        tiles[v.id] = tile;
        rail.appendChild(tile);
      });

      Bus.on('nav', Nav.go);
      Bus.on('queue', Nav.badges);
      Bus.on('job', U.debounce(Nav.badges, 200));
      Bus.on('library', Nav.badges);
      Bus.on('host:state', Nav.status);
      Bus.on('tools', Nav.status);
      Bus.on('config', Nav.status);

      Nav.status();
      Nav.badges();
    },

    go: function (id) {
      if (!tiles[id]) return;
      State.view = id;
      Object.keys(tiles).forEach(function (k) { tiles[k].classList.toggle('is-active', k === id); });
      U.$$('.mr-view').forEach(function (n) { n.classList.toggle('is-active', n.dataset.view === id); });
      Bus.emit('view', id);
    },

    badges: function () {
      var q = Queue.counts();
      Nav.badge('queue', q.active || null);
      Nav.badge('library', Library.items.length || null);
      var pts = Premiere.pointsForCurrent().length;
      Nav.badge('points', pts || null);
    },

    badge: function (viewId, value) {
      var tile = tiles[viewId];
      if (!tile) return;
      var b = U.$('.ps2-tile__badge', tile);
      if (!value) { if (b) b.remove(); return; }
      if (!b) { b = U.el('span', { class: 'ps2-tile__badge' }); tile.appendChild(b); }
      b.textContent = value > 99 ? '99+' : String(value);
    },

    /** Header chips: strict mode, host link, tool availability. */
    status: function () {
      if (!status) return;
      U.clear(status);

      var strict = Config.get('strictMode');
      var strictChip = C.badge(strict ? 'STRICT' : 'STRICT OFF', strict ? 'ok' : 'crit');
      strictChip.style.cursor = 'pointer';
      strictChip.title = strict
        ? 'Strict mode: only machine-verified Creative Commons material can be downloaded. Click to review in Settings.'
        : 'Strict mode is OFF — unverified material can be downloaded. Click to review in Settings.';
      strictChip.addEventListener('click', function () { Nav.go('settings'); });
      status.appendChild(strictChip);

      var tools = State.tools;
      if (tools.checked && !tools.ytdlp) {
        var t = C.badge('no yt-dlp', 'crit');
        t.style.cursor = 'pointer';
        t.title = 'yt-dlp was not found. Click to set its path.';
        t.addEventListener('click', function () { Nav.go('settings'); });
        status.appendChild(t);
      } else if (tools.checked && !tools.ffmpeg) {
        var f = C.badge('no ffmpeg', 'warn');
        f.title = 'ffmpeg was not found. Merging and audio extraction will fail.';
        status.appendChild(f);
      }

      var h = State.host;
      status.appendChild(C.badge(
        h.connected ? (State.project && State.project.name ? U.truncate(State.project.name, 18) : 'connected') : 'no host',
        h.connected ? 'info' : 'mute'
      ));
    }
  };

  global.Nav = Nav;
})(window);
