/* =============================================================================
   views/queue.js — download queue. MediaRade by siliconran
   ========================================================================== */
(function (global) {
  'use strict';

  var root, toolbar, body, nodes = {};

  var QueueView = {

    init: function () {
      root = U.$('.mr-view[data-view="queue"]');
      toolbar = U.el('div', { class: 'mr-view__toolbar' });
      body = U.el('div', { class: 'mr-view__body' });
      U.append(root, [toolbar, body]);

      Bus.on('queue', QueueView.render);
      Bus.on('job', QueueView.update);

      QueueView.render();
    },

    render: function () {
      U.clear(toolbar);
      U.clear(body);
      nodes = {};

      var c = Queue.counts();
      toolbar.appendChild(U.el('div', { class: 'ps2-row-gap ps2-wrap' }, [
        C.badge(c.running + ' running', c.running ? 'info' : 'mute'),
        C.badge(c.queued + ' queued', 'mute'),
        C.badge(c.done + ' done', c.done ? 'ok' : 'mute'),
        c.error ? C.badge(c.error + ' failed', 'crit') : null,
        U.el('span', { class: 'ps2-panel__spacer', style: { flex: 1 } }),
        C.btn('Clear finished', { size: 'sm', onclick: function () { Queue.clearFinished(); } }),
        c.active ? C.btn('Stop all', { size: 'sm', variant: 'danger', onclick: function () {
          Queue.cancelAll(); Toast.info('Stopped', 'All active downloads were cancelled.');
        } }) : null
      ]));

      if (!Queue.jobs.length) {
        body.appendChild(C.empty('The queue is empty',
          'Downloads you start from <b>Browse</b> or <b>Video</b> appear here with live progress.'));
        return;
      }

      Queue.jobs.slice().reverse().forEach(function (job) {
        var node = QueueView.jobNode(job);
        nodes[job.id] = node;
        body.appendChild(node);
      });
    },

    jobNode: function (job) {
      var bar = C.progress(job.percent || 0, job.state === 'running' && !job.percent);
      var stats = U.el('div', { class: 'mr-job__stats' });
      var actions = U.el('div', { class: 'ps2-row-gap' });

      var node = U.el('div', { class: 'mr-job', data: { state: job.state, id: job.id } }, [
        U.el('div', { class: 'mr-job__thumb', style: { backgroundImage: 'url("' + job.thumb + '")' } }),
        U.el('div', { class: 'mr-job__body' }, [
          U.el('div', { class: 'ps2-row-gap' }, [
            U.el('span', { class: 'ps2-truncate ps2-grow', style: { fontSize: '12px' }, text: job.title, title: job.title }),
            C.badge(job.kind, 'mute'),
            job.override ? C.badge('override', 'crit') : C.licenseBadge(job.report)
          ]),
          bar,
          stats
        ]),
        actions
      ]);

      QueueView.paint(node, job);
      return node;
    },

    paint: function (node, job) {
      node.dataset.state = job.state;

      var fill = U.$('.ps2-progress__fill', node);
      var wrap = U.$('.ps2-progress', node);
      if (fill) fill.style.width = (job.percent || 0) + '%';
      if (wrap) wrap.classList.toggle('ps2-progress--indeterminate',
        job.state === 'running' && (job.percent === null || job.percent === undefined || job.phase === 'processing'));

      var stats = U.$('.mr-job__stats', node);
      if (stats) {
        U.clear(stats);
        if (job.state === 'running') {
          if (job.phase && job.phase !== 'processing') stats.appendChild(U.el('span', { text: job.phase + '…' }));
          else if (job.phase === 'processing') stats.appendChild(U.el('span', { text: 'post-processing…' }));
          if (job.percent) stats.appendChild(U.el('span', { text: job.percent.toFixed(1) + '%' }));
          if (job.total) stats.appendChild(U.el('span', { text: U.bytes(job.downloaded || 0) + ' / ' + U.bytes(job.total) }));
          if (job.speed) stats.appendChild(U.el('span', { text: U.bytes(job.speed) + '/s' }));
          if (job.eta) stats.appendChild(U.el('span', { text: 'eta ' + U.hhmmss(job.eta) }));
        } else if (job.state === 'done') {
          stats.appendChild(U.el('span', { class: 'ps2-truncate', text: job.file || 'complete', title: job.file || '' }));
        } else if (job.state === 'error') {
          stats.appendChild(U.el('span', { style: { color: 'var(--ps2-crit)' }, text: job.error }));
        } else {
          stats.appendChild(U.el('span', { text: job.state }));
        }
      }

      var actions = node.lastChild;
      U.clear(actions);

      if (job.state === 'running' || job.state === 'queued') {
        actions.appendChild(C.btn('Stop', { size: 'sm', variant: 'danger', onclick: function () { Queue.cancel(job.id); } }));
      } else if (job.state === 'done' && job.file) {
        var entry = Library.byVideo(job.videoId).filter(function (e) { return e.file === job.file; })[0];
        var payload = entry ? Acquire.payload(entry) : {
          kind: job.kind, title: job.title, file: job.file, report: job.report
        };

        var grip = U.el('div', { class: 'mr-grip', style: { minHeight: '30px' }, title: 'Drag to the dock' });
        DnD.source(grip, function () { Dock.open(); return payload; });

        var placeBtn = C.btn('Place', {
          size: 'sm', variant: 'primary',
          title: 'Insert using the dock\'s mode and target — or drag this button straight onto Premiere\'s timeline',
          onclick: function () { Dock.quickPlace(payload); }
        });
        DnD.native(placeBtn, function () { return payload; });

        U.append(actions, [
          grip,
          placeBtn,
          C.btn('⤴', { size: 'sm', title: 'Reveal in Explorer', onclick: function () { CEP.revealInExplorer(job.file); } })
        ]);
      } else {
        U.append(actions, [
          C.btn('Retry', { size: 'sm', onclick: function () { Queue.retry(job.id); } }),
          C.btn('✕', { size: 'sm', variant: 'ghost', onclick: function () { Queue.remove(job.id); } })
        ]);
      }
    },

    update: function (job) {
      var node = nodes[job.id];
      if (!node) { QueueView.render(); return; }
      QueueView.paint(node, job);
    }
  };

  global.QueueView = QueueView;
})(window);
