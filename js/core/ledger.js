/* =============================================================================
   ledger.js — append-only compliance record + attribution sidecars
   MediaRade by rad1x

   Every download, every override, every strict-mode change lands here. The file
   is JSONL so it survives partial writes and can be handed to someone else.
   ========================================================================== */
(function (global) {
  'use strict';

  var Ledger = {

    /** Append one entry. Never throws — a logging failure must not kill a job. */
    record: function (entry) {
      if (!Config.get('ledgerEnabled')) return null;
      var row = Object.assign({
        at: new Date().toISOString(),
        panel: 'MediaRade 1.2.2',
        project: (State.project && State.project.name) || null
      }, entry);
      try {
        Paths.appendLine(Paths.file('ledger'), JSON.stringify(row));
        Bus.emit('ledger', row);
      } catch (e) {
        console.warn('[MediaRade] ledger write failed:', e);
      }
      return row;
    },

    /** Newest first. */
    read: function (limit) {
      var raw = Paths.read(Paths.file('ledger'), '');
      if (!raw) return [];
      var rows = raw.split(/\r?\n/).filter(Boolean).map(function (l) {
        try { return JSON.parse(l); } catch (e) { return null; }
      }).filter(Boolean);
      rows.reverse();
      return limit ? rows.slice(0, limit) : rows;
    },

    stats: function () {
      var rows = Ledger.read();
      var s = { total: 0, verified: 0, overridden: 0, blocked: 0, byTier: {} };
      rows.forEach(function (r) {
        if (r.event === 'download_complete') {
          s.total++;
          if (r.verdict === 'VERIFIED_CC_BY') s.verified++;
          if (r.override) s.overridden++;
          s.byTier[r.verdict] = (s.byTier[r.verdict] || 0) + 1;
        }
        if (r.event === 'download_blocked') s.blocked++;
      });
      return s;
    },

    /* --- sidecars --------------------------------------------------------- */

    /**
     * Write <name>.license.json and, for CC material, <name>.attribution.txt
     * beside the media file (and a copy in Licenses\ so nothing is lost when
     * the media is moved).
     */
    writeSidecars: function (mediaPath, report, extra) {
      if (!Config.get('writeSidecars') || !mediaPath) return null;
      var path = CEP.path;
      var dir  = path.dirname(mediaPath);
      var base = path.basename(mediaPath, path.extname(mediaPath));
      var payload = License.sidecar(report, Object.assign({ mediaFile: mediaPath }, extra || {}));
      var written = [];

      try {
        var jsonPath = path.join(dir, base + '.license.json');
        Paths.writeJSON(jsonPath, payload);
        written.push(jsonPath);
        Paths.writeJSON(path.join(Paths.dir('licenses'), base + '.license.json'), payload);
      } catch (e) { console.warn('[MediaRade] sidecar json failed:', e); }

      if (report.attribution) {
        try {
          var txtPath = path.join(dir, base + '.attribution.txt');
          Paths.write(txtPath, Ledger.attributionText(report, mediaPath));
          written.push(txtPath);
        } catch (e) { console.warn('[MediaRade] attribution txt failed:', e); }
      }

      return written;
    },

    attributionText: function (report, mediaPath) {
      var a = report.attribution;
      var L = [
        'ATTRIBUTION — required by the licence',
        '=====================================',
        '',
        a.plain,
        '',
        'Title    : ' + a.title,
        'Creator  : ' + a.author,
        'Channel  : ' + (a.channelUrl || 'n/a'),
        'Source   : ' + a.source,
        'Licence  : ' + a.license + '  (' + a.licenseUrl + ')',
        'File     : ' + (mediaPath || 'n/a'),
        'Verified : ' + report.checkedAt,
        '',
        'Paste this into your credits, description or an on-screen card:',
        '',
        '  ' + a.credits,
        ''
      ];
      if (report.obligations && report.obligations.length) {
        L.push('OBLIGATIONS', '-----------');
        report.obligations.forEach(function (o) { L.push('* ' + o.key + ': ' + o.text); });
        L.push('');
      }
      var flags = (report.signals || []).filter(function (s) { return s.severity === 'crit' || s.severity === 'warn'; });
      if (flags.length) {
        L.push('OUTSTANDING RISKS', '-----------------');
        flags.forEach(function (s) { L.push('[' + s.severity.toUpperCase() + '] ' + s.label + ' — ' + s.detail); });
        L.push('');
      }
      L.push('Recorded by MediaRade (by rad1x). Evidence of due diligence, not legal advice.');
      return L.join('\r\n');
    },

    /** Append to Compliance\CREDITS.md — the file you ship with the cut. */
    appendCredits: function (report, mediaPath) {
      if (!Config.get('writeCredits') || !report.attribution) return;
      var file = Paths.file('credits');
      if (!Paths.exists(file)) {
        Paths.write(file, [
          '# Credits',
          '',
          'Generated by MediaRade (by rad1x). Every entry below carries a licence',
          'obligation that must appear in the published work.',
          ''
        ].join('\r\n'));
      }
      var a = report.attribution;
      var block = [
        '',
        '## ' + a.title,
        '',
        '- **Creator:** ' + a.author,
        '- **Source:** ' + a.source,
        '- **Licence:** [' + a.license + '](' + a.licenseUrl + ')',
        '- **File:** `' + (mediaPath || '') + '`',
        '- **Verified:** ' + report.checkedAt,
        '',
        '> ' + a.credits,
        ''
      ].join('\r\n');
      try { CEP.fs.appendFileSync(file, block, 'utf8'); } catch (e) {}
    },

    /* --- events ------------------------------------------------------------ */

    logDownloadStart: function (job, report) {
      return Ledger.record({
        event: 'download_start',
        videoId: job.id, url: job.url, title: job.title, channel: job.channel,
        kind: job.kind, verdict: report ? report.tier : 'UNKNOWN',
        confidence: report ? report.score : null,
        strictMode: Config.get('strictMode'),
        override: !!job.override,
        overrideReason: job.overrideReason || null,
        acknowledgement: job.ack || null
      });
    },

    logDownloadComplete: function (job, report, file) {
      return Ledger.record({
        event: 'download_complete',
        videoId: job.id, url: job.url, title: job.title, channel: job.channel,
        kind: job.kind, file: file,
        verdict: report ? report.tier : 'UNKNOWN',
        confidence: report ? report.score : null,
        licenseField: report ? report.licenseField : null,
        requiresAttribution: report ? report.requiresAttribution : false,
        attribution: report && report.attribution ? report.attribution.plain : null,
        override: !!job.override,
        overrideReason: job.overrideReason || null
      });
    },

    logBlocked: function (info, report) {
      return Ledger.record({
        event: 'download_blocked',
        videoId: info.id, title: info.title, channel: info.channel || info.uploader,
        verdict: report.tier, confidence: report.score,
        reasons: report.gate.reasons
      });
    },

    exportReport: function () {
      var rows = Ledger.read();
      var stats = Ledger.stats();
      var lines = [
        '# MediaRade licence report',
        '',
        'Generated ' + new Date().toISOString() + ' by MediaRade (by rad1x).',
        '',
        '| Metric | Count |',
        '| --- | --- |',
        '| Completed downloads | ' + stats.total + ' |',
        '| Verified CC BY 3.0 | ' + stats.verified + ' |',
        '| Manual overrides | ' + stats.overridden + ' |',
        '| Blocked by strict mode | ' + stats.blocked + ' |',
        '',
        '## Entries',
        '',
        '| Date | Event | Title | Verdict | Override |',
        '| --- | --- | --- | --- | --- |'
      ];
      rows.forEach(function (r) {
        lines.push('| ' + r.at + ' | ' + r.event + ' | ' +
          String(r.title || '').replace(/\|/g, '/') + ' | ' + (r.verdict || '') + ' | ' +
          (r.override ? 'YES — ' + String(r.overrideReason || '').replace(/\|/g, '/') : '') + ' |');
      });
      var out = CEP.path.join(Paths.dir('compliance'), 'licence-report-' + Date.now() + '.md');
      Paths.write(out, lines.join('\r\n'));
      return out;
    }
  };

  global.Ledger = Ledger;
})(window);
