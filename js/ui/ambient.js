/* =============================================================================
   ambient.js — the PS2 boot field: light towers + drifting data cubes
   MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var canvas, ctx, cubes = [], raf = null, w = 0, h = 0, last = 0;

  function makeTowers() {
    var host = U.$('#towers');
    if (!host) return;
    U.clear(host);
    var n = 16;
    for (var i = 0; i < n; i++) {
      host.appendChild(U.el('i', {
        class: 'ps2-tower',
        style: {
          left: (Math.random() * 100).toFixed(2) + '%',
          animationDelay: (-Math.random() * 14).toFixed(2) + 's',
          animationDuration: (9 + Math.random() * 11).toFixed(2) + 's',
          opacity: (0.25 + Math.random() * 0.6).toFixed(2),
          width: (Math.random() < 0.22 ? 3 : 1.5) + 'px'
        }
      }));
    }
  }

  function seedCubes() {
    cubes = [];
    var count = Math.round(U.clamp((w * h) / 26000, 8, 34));
    for (var i = 0; i < count; i++) cubes.push(spawn(true));
  }

  function spawn(anywhere) {
    return {
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : h + 40,
      size: 5 + Math.random() * 16,
      speed: 5 + Math.random() * 16,        // px/s upward
      drift: (Math.random() - 0.5) * 7,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.5,
      alpha: 0.12 + Math.random() * 0.35
    };
  }

  function resize() {
    if (!canvas) return;
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedCubes();
  }

  function draw(now) {
    raf = requestAnimationFrame(draw);
    var dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;

    ctx.clearRect(0, 0, w, h);

    for (var i = 0; i < cubes.length; i++) {
      var c = cubes[i];
      c.y -= c.speed * dt;
      c.x += c.drift * dt;
      c.rot += c.spin * dt;
      if (c.y < -50) cubes[i] = spawn(false);

      var s = c.size;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);

      // fade the far ones toward the horizon
      var depth = U.clamp(1 - (c.y / h) * 0.55, 0.25, 1);
      ctx.globalAlpha = c.alpha * depth;

      ctx.fillStyle = 'rgba(255, 90, 110, 0.10)';
      ctx.strokeStyle = 'rgba(255, 175, 190, 0.55)';
      ctx.lineWidth = 1;
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.strokeRect(-s / 2, -s / 2, s, s);

      // isometric back edge, the "data cube" read
      ctx.globalAlpha = c.alpha * depth * 0.55;
      var o = s * 0.32;
      ctx.beginPath();
      ctx.moveTo(-s / 2, -s / 2); ctx.lineTo(-s / 2 + o, -s / 2 - o);
      ctx.lineTo(s / 2 + o, -s / 2 - o); ctx.lineTo(s / 2, -s / 2);
      ctx.moveTo(s / 2, s / 2); ctx.lineTo(s / 2 + o, s / 2 - o);
      ctx.lineTo(s / 2 + o, -s / 2 - o);
      ctx.stroke();

      ctx.restore();
    }
  }

  var Ambient = {
    start: function () {
      canvas = U.$('#cubes');
      if (!canvas) return;
      ctx = canvas.getContext('2d');

      makeTowers();

      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced || !Config.get('ambientMotion')) { Ambient.stop(); return; }

      resize();
      window.addEventListener('resize', U.debounce(resize, 180));
      if (!raf) raf = requestAnimationFrame(draw);
    },

    stop: function () {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      if (ctx) ctx.clearRect(0, 0, w, h);
    },

    toggle: function (on) { if (on) Ambient.start(); else Ambient.stop(); }
  };

  global.Ambient = Ambient;
})(window);
