/* =============================================================================
   proc.js — child-process runner with line streaming + cancellation
   MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var live = [];   // every child we started, so we can reap them on unload

  function untrack(child) {
    var i = live.indexOf(child);
    if (i > -1) live.splice(i, 1);
  }

  /**
   * Spawn a process and stream it line by line.
   *
   * @param {string}   exe
   * @param {string[]} args
   * @param {object}   opts
   *   onStdout(line)  onStderr(line)  cwd  timeout(ms)  maxBuffer(chars)
   * @returns {Promise<{code, stdout, stderr, killed}>} with a .cancel() attached
   */
  function run(exe, args, opts) {
    opts = opts || {};
    var cp = CEP.cp;
    var child = null, killed = false, timer = null;

    var promise = new Promise(function (resolve, reject) {
      try {
        child = cp.spawn(exe, args, {
          cwd: opts.cwd || undefined,
          windowsHide: true,
          windowsVerbatimArguments: false
        });
      } catch (e) {
        return reject(new Error('Could not start "' + exe + '": ' + e.message));
      }

      live.push(child);

      var out = '', err = '', outBuf = '', errBuf = '';
      var cap = opts.maxBuffer || 6e6;

      function pump(chunk, isErr) {
        var buf = (isErr ? errBuf : outBuf) + chunk;
        var lines = buf.split(/\r?\n/);
        buf = lines.pop();                     // keep the partial tail
        if (isErr) errBuf = buf; else outBuf = buf;

        lines.forEach(function (line) {
          if (isErr) {
            if (err.length < cap) err += line + '\n';
            if (opts.onStderr) { try { opts.onStderr(line); } catch (e) {} }
          } else {
            if (out.length < cap) out += line + '\n';
            if (opts.onStdout) { try { opts.onStdout(line); } catch (e) {} }
          }
        });
      }

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', function (c) { pump(c, false); });
      child.stderr.on('data', function (c) { pump(c, true); });

      child.on('error', function (e) {
        clearTimeout(timer); untrack(child);
        reject(new Error('"' + exe + '" failed to run: ' + e.message +
          (e.code === 'ENOENT' ? ' — check the binary path in Settings.' : '')));
      });

      child.on('close', function (code) {
        clearTimeout(timer);
        untrack(child);
        if (outBuf) { out += outBuf; if (opts.onStdout) { try { opts.onStdout(outBuf); } catch (e) {} } }
        if (errBuf) { err += errBuf; if (opts.onStderr) { try { opts.onStderr(errBuf); } catch (e) {} } }
        resolve({ code: code, stdout: out, stderr: err, killed: killed });
      });

      if (opts.timeout) {
        timer = setTimeout(function () {
          killed = true;
          try { child.kill(); } catch (e) {}
        }, opts.timeout);
      }
    });

    promise.cancel = function () {
      killed = true;
      if (!child) return;
      try {
        // yt-dlp spawns ffmpeg children; taskkill /T takes the whole tree.
        CEP.cp.spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
      } catch (e) {
        try { child.kill(); } catch (e2) {}
      }
    };
    promise.pid = function () { return child ? child.pid : null; };

    return promise;
  }

  /** Convenience: run and reject on a non-zero exit. */
  function runOk(exe, args, opts) {
    return run(exe, args, opts).then(function (r) {
      if (r.code !== 0) {
        var msg = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-4).join(' | ');
        throw new Error(exe + ' exited ' + r.code + (msg ? ': ' + msg : ''));
      }
      return r;
    });
  }

  /** `where` lookup, so we can find yt-dlp/ffmpeg on PATH. */
  function which(name) {
    return run('where', [name], { timeout: 5000 })
      .then(function (r) {
        if (r.code !== 0) return null;
        var first = (r.stdout || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)[0];
        return first || null;
      })
      .catch(function () { return null; });
  }

  function killAll() {
    live.slice().forEach(function (c) {
      try { CEP.cp.spawn('taskkill', ['/pid', String(c.pid), '/f', '/t'], { windowsHide: true }); } catch (e) {}
    });
    live.length = 0;
  }

  global.Proc = { run: run, runOk: runOk, which: which, killAll: killAll, live: live };
})(window);
