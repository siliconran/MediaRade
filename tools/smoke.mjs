/* =============================================================================
   tools/smoke.mjs — headless smoke test for the built panel.
   MediaRade by siliconran

   Boots dist/js/mediarade.js inside jsdom with the same CEP/Node shims the dev
   harness uses, then asserts the behaviours that matter: the risk checker's
   verdicts, the download gate under each policy, the Uppbeat credit rules, and
   the parts of the UI that are easy to break silently.

       npm run build && node tools/smoke.mjs

   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

/* Defaults to this repo; pass a path to verify an installed copy instead:
     node tools/smoke.mjs "%APPDATA%\Adobe\CEP\extensions\org.rad1x.mediarade" */
const ROOT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');

/* --- assertions ----------------------------------------------------------- */

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  \u001b[32mok\u001b[0m   ' + name); }
  else { failures.push(name); console.log('  \u001b[31mFAIL\u001b[0m ' + name + '\n       expected ' + e + '\n       actual   ' + a); }
}

function section(t) { console.log('\n' + t); }

/* --- shims ---------------------------------------------------------------- */

function makeShims(win) {
  const FILES = {};
  const DIRS = { 'C:\\Users\\dev\\Documents': true };
  const SPAWNED = [];
  const norm = (p) => String(p).replace(/\//g, '\\');

  const path = {
    join: (...a) => norm(a.filter(Boolean).join('\\')).replace(/\\+/g, '\\'),
    dirname: (p) => { p = norm(p); return p.slice(0, p.lastIndexOf('\\')) || '\\'; },
    basename: (p, ext) => {
      p = norm(p); const b = p.slice(p.lastIndexOf('\\') + 1);
      return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
    },
    extname: (p) => { const b = path.basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }
  };

  const fs = {
    existsSync: (p) => !!FILES[norm(p)] || !!DIRS[norm(p)],
    mkdirSync: (p) => { DIRS[norm(p)] = true; },
    readFileSync: (p) => {
      p = norm(p);
      if (!(p in FILES)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; }
      return FILES[p];
    },
    writeFileSync: (p, d) => { FILES[norm(p)] = String(d); },
    appendFileSync: (p, d) => { p = norm(p); FILES[p] = (FILES[p] || '') + String(d); },
    renameSync: (a, b) => { a = norm(a); b = norm(b); FILES[b] = FILES[a]; delete FILES[a]; },
    unlinkSync: (p) => { delete FILES[norm(p)]; },
    copyFileSync: (a, b) => { FILES[norm(b)] = FILES[norm(a)]; },
    /* Real enough for the inbox watcher: list the immediate children of a
       directory out of the in-memory file table. Returning [] unconditionally
       made a folder-watching feature untestable. SEP avoids a literal
       backslash in this file. */
    readdirSync: (p) => {
      const SEP = String.fromCharCode(92);
      let dir = norm(p);
      while (dir.length && dir.charAt(dir.length - 1) === SEP) dir = dir.slice(0, -1);
      dir += SEP;
      const out = [];
      Object.keys(FILES).concat(Object.keys(DIRS)).forEach((k) => {
        if (k.indexOf(dir) !== 0) return;
        const rest = k.slice(dir.length);
        if (!rest || rest.indexOf(SEP) > -1) return;
        if (out.indexOf(rest) === -1) out.push(rest);
      });
      return out;
    },
    statSync: (p) => {
      p = norm(p);
      if (!(p in FILES) && !DIRS[p]) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { size: (FILES[p] || '').length, mtimeMs: Date.now(),
               isFile: () => p in FILES, isDirectory: () => !!DIRS[p] };
    },
    /* A real stream, so the download path (res.pipe(out) -> 'finish' -> rename)
       can be exercised end to end rather than stubbed out. */
    createWriteStream: (p) => {
      const out = new EventEmitter();
      let buf = '';
      out.write = (c) => { buf += String(c); return true; };
      out.end = () => { FILES[norm(p)] = buf; setTimeout(() => out.emit('finish'), 1); };
      out.close = (cb) => { cb && cb(); };
      return out;
    }
  };

  /* Boot with the ambient canvas off — jsdom has no 2D context. */
  FILES['C:\\Users\\dev\\Documents\\MediaRade\\config.json'] =
    JSON.stringify({ ambientMotion: false, showBoot: false });

  /* Answers plausibly per invocation: `where yt-dlp` gets a path, `-g` gets a
     progressive stream URL, everything else gets a path. The strict H.264
     preview selector is made to fail so every stream resolution exercises the
     last-resort `-f b` fallback in YtDlp.streamUrl. */
  function fakeChild(args) {
    const h = {};
    const argv = args || [];
    SPAWNED.push(argv);
    const fIdx = argv.indexOf('-f');
    const sel = fIdx > -1 ? argv[fIdx + 1] : '';
    const strictPrimary = sel.indexOf('vcodec^=avc1') > -1;
    let out = '', err = '', code = 0;
    if (argv.indexOf('-g') > -1) {
      if (strictPrimary) {
        code = 1;
        err = 'ERROR: requested format not available\n';
      } else {
        out = 'https://rr4---sn-example.googlevideo.com/videoplayback?expire=1&itag=18\n';
      }
    } else {
      out = 'C:\\tools\\yt-dlp.exe\n';
    }
    const child = {
      pid: 1234,
      stdout: { setEncoding() {}, on(e, f) { h['out:' + e] = f; }, pipe() {} },
      stderr: { setEncoding() {}, on(e, f) { h['err:' + e] = f; } },
      on(e, f) { h[e] = f; },
      kill() {}
    };
    setTimeout(() => {
      if (out) h['out:data'] && h['out:data'](out);
      if (err) h['err:data'] && h['err:data'](err);
      h.close && h.close(code);
    }, 5);
    return child;
  }

  /* The Uppbeat account check answers with the REAL setup_frontend envelope:
     the account is nested at user.user (user itself is only the auth wrapper),
     and the plan lives in a TOP-LEVEL subscriptionData array. The mock used to
     use a flattened shape the live API never sends, which is exactly why a
     Creator account read as free in the panel while the tests stayed green.

     ACCOUNT_MODE flips between a signed-in Creator and the guest response
     Uppbeat gives anyone holding a bare auth_token, so both can be asserted. */
  const CREATOR_BODY = {
    user: {
      auth_token: true,
      token: 'c8730e0e96df2c17da03fb7c3311a6cfbe8c1fabcec8fd12cd498c07ec4e3ec8',
      user: { id: 42, email: 'pro@uppbeat.fake', name: 'Pro User' },
      is_authenticated: true
    },
    auth_token: true,
    subscriptionData: [{ plan: 'creator', is_active: true }],
    credits: { credits_current: 0, credits_max: 3 }
  };
  /* Verified against the live API: a token Uppbeat has never issued still comes
     back with auth_token:true — it only means "a token cookie was sent". */
  const GUEST_BODY = {
    user: { auth_token: true, token: 'deadbeef'.repeat(16), user: null, is_authenticated: false },
    auth_token: true,
    subscriptionData: [],
    credits: { credits_current: 0, credits_max: 3 }
  };
  const ACCOUNT_MODE = { value: 'creator' };
  const ACCOUNT_BODY = () => (ACCOUNT_MODE.value === 'guest' ? GUEST_BODY : CREATOR_BODY);

  /* Typesense answers a single search under `hits` and a multi_search under
     `results[].hits` — browse reads the second shape, search the first. */
  const DOC = { asset_type: 'track', track_id: 13902, id: '13902', track_slug: 'chill-fm',
                name: 'Chill FM', contributor_name: 'Dope Cat', contributor_slug: 'dope-cat',
                is_premium: false, version_length: 132, tempo: 90 };
  const SEARCH_BODY = (opts) => (/multi_search/.test(String(opts.path || ''))
    ? { results: [{ found: 1, hits: [{ document: DOC }] }] }
    : { found: 1, hits: [{ document: DOC }] });
  const REQUESTS = [];
  /* Lets a test force the V2 API to refuse every format, so the unrecoverable
     403 path can be asserted as well as the wav -> mp3 recovery. */
  const FLAGS = { V2_FORCE_403: false };

  const modules = {
    path, fs,
    os: { homedir: () => 'C:\\Users\\dev', platform: () => 'win32' },
    child_process: { spawn: (exe, args) => fakeChild(args) },
    https: (() => {
      /* The panel drives this with https.request (it needs POST for the
         Typesense multi_search browse call, which 404s on GET). `get` stays as
         a thin alias so the shim mirrors the real module. */
      const request = (opts, cb) => {
        REQUESTS.push({ method: (opts.method || 'GET').toUpperCase(),
                        host: opts.hostname, path: opts.path, headers: opts.headers, body: '' });
        const rec = REQUESTS[REQUESTS.length - 1];
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { 'content-length': '2' };
        res.setEncoding = () => {};
        const isV2 = /api-v2-cdn/.test(String(opts.hostname || ''));
        let body;
        if (/typesense/.test(String(opts.hostname || ''))) body = JSON.stringify(SEARCH_BODY(opts));
        else if (isV2) {
          /* Measured on the live API: WAV is an entitlement. The same track
             answers 403 "Insufficient privileges" for format=wav and 200 for
             format=mp3, so the mock reproduces exactly that. */
          if (FLAGS.V2_FORCE_403 || /format=wav/.test(String(opts.path || ''))) {
            res.statusCode = 403;
            res.headers['content-type'] = 'application/problem+json';
            body = JSON.stringify({ title: 'Insufficient privileges', status: 403 });
          } else {
            res.headers['content-type'] = 'application/json';
            body = JSON.stringify({ url: 'https://download-cdn.uppbeat.io/audio-files/x/track.mp3?Signature=abc',
                                    licenseCode: 'TESTCODE123', pageUrl: 'https://uppbeat.io/t/a/b' });
          }
        } else body = JSON.stringify(ACCOUNT_BODY());
        /* httpDownload streams the body to a file with res.pipe(out); the
           JSON callers just read 'data'/'end'. Support both. */
        res.pipe = (out) => { setTimeout(() => { out.write(body); out.end(); }, 1); return out; };
        setTimeout(() => { cb(res); setTimeout(() => { res.emit('data', body); res.emit('end'); }, 1); }, 1);
        return { on() {}, destroy() {}, write(b) { rec.body += b; }, end() {} };
      };
      return { request, get: (opts, cb) => request(Object.assign({}, opts, { method: 'GET' }), cb) };
    })(),
    url: { parse: (u) => { const x = new URL(u); return { protocol: x.protocol, hostname: x.hostname, path: x.pathname + x.search }; } }
  };

  win.cep_node = { require: (m) => { if (modules[m]) return modules[m]; throw new Error('no module ' + m); } };

  const SEQ = { name: 'Smoke Sequence', id: 'seq-1', playhead: 12.5, inPoint: 4, outPoint: 30,
                fps: 25, videoTracks: 3, audioTracks: 4, end: 180, zeroPoint: 0 };

  win.__adobe_cep__ = {
    evalScript(script, cb) {
      const fn = (script.match(/\$\._MediaRade\.(\w+)/) || [])[1];
      let data = {};
      if (fn === 'ping') data = { version: '1.3.4', host: 'Premiere Pro', hostVersion: '25.0', hasProject: true };
      else if (fn === 'getState') data = { project: { name: 'Smoke.prproj', path: 'C:\\p' }, sequence: SEQ };
      else if (fn === 'importFile') data = { name: 'clip.mp4', nodeId: 'node-1' };
      else if (fn === 'place') data = { sequence: SEQ.name, position: 12.5, track: 'V1+A1',
                                        mode: 'overwrite', item: { nodeId: 'node-1' }, created: false };
      setTimeout(() => cb(JSON.stringify({ ok: true, data })), 1);
    },
    getHostEnvironment: () => JSON.stringify({ appName: 'PPRO', appVersion: '25.0' }),
    getSystemPath: (t) => (t === 'myDocuments' ? 'file:///C:/Users/dev/Documents' : 'file:///C:/app'),
    addEventListener() {}, removeEventListener() {}, invokeSync: () => '', resizeContent() {}
  };

  return { FILES, DIRS, SPAWNED, ACCOUNT_MODE, REQUESTS,
           get V2_FORCE_403() { return FLAGS.V2_FORCE_403; },
           set V2_FORCE_403(v) { FLAGS.V2_FORCE_403 = v; } };
}

/* --- boot ------------------------------------------------------------------ */

const html = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8')
  .replace(/<script[^>]*><\/script>/g, '')
  .replace(/<link[^>]*>/g, '');

const bundle = readFileSync(join(ROOT, 'dist', 'js', 'mediarade.js'), 'utf8');
/* The package the build should have taken its version and author from.
   Resolved against THIS SCRIPT rather than ROOT: ROOT may be an installed
   extension folder, which has no package.json, and reading it from there
   crashed the whole run when verifying a deployed copy. */
const PKG = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const dom = new JSDOM(html, {
  pretendToBeVisual: true,
  runScripts: 'outside-only',          // gives the window its own eval/Function realm
  url: 'file:///D:/Projects/MediaRade/dist/index.html'
});
const win = dom.window;
const shims = makeShims(win);

const errors = [];
win.addEventListener('error', (e) => errors.push(String(e.message)));
const origError = win.console.error;
win.console.error = (...a) => { errors.push(a.map(String).join(' ')); origError.apply(win.console, a); };

try {
  win.eval(bundle);
} catch (e) {
  console.error('[31mThe bundle threw while loading:[0m ' + e.message);
  console.error(String(e.stack || '').split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 400));

const MR = win.MR;
const $ = (s) => win.document.querySelector(s);
const $$ = (s) => Array.from(win.document.querySelectorAll(s));
const text = (n) => (n ? n.textContent.trim() : null);
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/* Boot locates yt-dlp/ffmpeg asynchronously (a `where` spawn). A Queue.add that
   runs before that finishes throws synchronously from YtDlp.requireReady — a
   flake under slow CI. Wait until the tools are found before asserting. */
const waitTools = (ms = 4000) => {
  const t0 = Date.now();
  return new Promise((r) => {
    const poll = () => {
      if (MR.YtDlp.ready() || Date.now() - t0 > ms) return r();
      setTimeout(poll, 40);
    };
    poll();
  });
};
await waitTools();

/* ========================================================================== */

section('boot');
check('no console errors during boot', errors, []);
check('diagnostics handle exposed', typeof MR === 'object' && !!MR.License, true);
check('build stamp present', /^\d{4}-\d{2}-\d{2}T/.test(MR.builtAt || ''), true);
check('app shell rendered', !!$('.mr-rail') && !!$('.mr-main'), true);

section('navigation');
const tabs = $$('.ps2-tile__label').map(text);
check('tab list', tabs, ['Browse', 'Video', 'Queue', 'Uppbeat', 'Library', 'Licence', 'Log', 'Setup']);
check('no in-panel timeline (Points tab gone)', tabs.includes('Points'), false);
check('no timeline dock in the DOM', !!$('.mr-dock'), false);

section('risk checker');
const L = MR.License;
const cases = {
  trap: L.evaluate({ id: 'a', title: 'ROYALTY FREE Cinematic B-Roll — No Copyright!', channel: 'E',
    description: 'Free to use in any project! (c) 2024 Example. Do not reupload.',
    license: 'Standard YouTube License' }),
  clean: L.evaluate({ id: 'b', title: 'City timelapse', channel: 'Real Creator',
    description: 'Shot on my own camera.',
    license: 'Creative Commons Attribution license (reuse allowed)', channel_is_verified: true }),
  contentId: L.evaluate({ id: 'c', title: 'Free Background Music', channel: 'M',
    description: 'Royalty free music, free to use!',
    license: 'Creative Commons Attribution license (reuse allowed)',
    track: 'Song', artist: 'Artist', album: 'Album' }),
  plain: L.evaluate({ id: 'd', title: 'My holiday video', channel: 'S',
    description: 'A trip to the coast.', license: 'Standard YouTube License' }),
  /* What YouTube ACTUALLY returns for an all-rights-reserved upload: an empty
     licence field, not the literal "Standard YouTube License" string. Verified
     against live yt-dlp output — a green verdict here would be a real leak. */
  emptyPlain: L.evaluate({ id: 'e', title: 'My holiday video', channel: 'S',
    description: 'A trip to the coast.', license: '' }),
  emptyTrap: L.evaluate({ id: 'f', title: 'ROYALTY FREE B-Roll — No Copyright!', channel: 'E',
    description: 'Free to use in any project!', license: '' }),
  /* Real CC string, exactly as the platform spells it. */
  realCC: L.evaluate({ id: 'g', title: 'Cloudy sky timelapse 4K', channel: 'TotallyJerks',
    description: 'Free download.', license: 'Creative Commons Attribution license (reuse allowed)' }),
  /* A famous commercial track on the official "Artist - Topic" channel. No
     Content ID fields in a flat listing, but the title shape and channel make
     the commercial release obvious — must be HIGH, not MODERATE. */
  famousTrack: L.evaluate({ id: 'h', title: 'Tame Impala - The Less I Know The Better (Audio)',
    channel: 'Tame Impala - Topic', description: 'Provided to YouTube by Universal...', license: '' })
};
check('"royalty free" text on a Standard licence -> HIGH', cases.trap.level, 'HIGH');
check('genuine CC BY -> LOW', cases.clean.level, 'LOW');
check('Content ID fingerprint -> CRITICAL', cases.contentId.level, 'CRITICAL');
check('plain Standard licence -> MODERATE', cases.plain.level, 'MODERATE');
check('empty licence field is NOT treated as cleared', cases.emptyPlain.level, 'MODERATE');
check('empty licence + reuse claim -> HIGH', cases.emptyTrap.level, 'HIGH');
check('live CC string is recognised', cases.realCC.level, 'LOW');
check('obvious commercial music (official audio) -> HIGH', cases.famousTrack.level, 'HIGH');
check('commercial music recorded as a warning signal', cases.famousTrack.counts.warn > 0, true);
check('commercial music is overridable, not CRITICAL', L.blocked(cases.famousTrack).hard, false);
check('empty licence never yields attribution', cases.emptyPlain.attribution, null);
check('CRITICAL is never overridable', L.blocked(cases.contentId).hard, true);
check('HIGH is overridable off strict mode', cases.trap.level === 'HIGH', true);
check('CC BY produces attribution text', !!cases.clean.attribution.credits, true);
check('Standard licence produces no attribution', cases.plain.attribution, null);

section('download gate by policy');
const gate = (mode, strict) => {
  MR.Config.set('strictMode', strict);
  if (!strict) MR.Config.set('licenseMode', mode);
  return { LOW: L.allow(cases.clean), MODERATE: L.allow(cases.plain),
           HIGH: L.allow(cases.trap), CRITICAL: L.allow(cases.contentId) };
};
check('strict mode: LOW only', gate('cc', true), { LOW: true, MODERATE: false, HIGH: false, CRITICAL: false });
check('policy cc: LOW only', gate('cc', false), { LOW: true, MODERATE: false, HIGH: false, CRITICAL: false });
check('policy claim: LOW+MODERATE', gate('claim', false), { LOW: true, MODERATE: true, HIGH: false, CRITICAL: false });
check('policy all: everything but CRITICAL', gate('all', false), { LOW: true, MODERATE: true, HIGH: true, CRITICAL: false });
MR.Config.set('strictMode', true); MR.Config.set('licenseMode', 'cc');

section('search filter encoding');
check('Creative Commons sp matches YouTube reference',
  MR.SP.build({ features: { creativeCommons: true }, type: 'any' }), MR.SP.CC_ONLY);
check('CC + video filter encodes both fields',
  MR.SP.build({ features: { creativeCommons: true }, type: 'video' }), 'EgQQATAB');
check('search URL is a youtube results URL',
  MR.SP.url('b-roll', { features: { creativeCommons: true }, type: 'video' }),
  'https://www.youtube.com/results?search_query=b-roll&sp=EgQQATAB');

section('override path (HIGH risk must be downloadable after confirming)');
MR.Config.set('strictMode', true);
check('HIGH is blocked up front under strict mode', L.allow(cases.trap), false);
check('HIGH is offered as overridable even under strict mode', L.blocked(cases.trap).overridable, true);
check('CRITICAL is never overridable', L.blocked(cases.contentId).overridable, false);
/* The confirmed override must actually enter the queue — this is the bug where
   Queue.add threw "Strict mode is on" and the confirm dialog dead-ended. */
const overrideJob = MR.Queue.add({
  info: { id: 'aaaaaaaaaaa', title: 'HIGH risk clip', channel: 'E' },
  report: cases.trap, kind: 'video',
  override: true, overrideReason: 'smoke test'
});
check('confirmed override enters the queue',
  !!overrideJob && ['queued', 'running'].indexOf(overrideJob.state) > -1, true);
check('override is flagged on the job', overrideJob.override, true);
let criticalRefused = false;
try {
  MR.Queue.add({ info: { id: 'ccccccccccc', title: 'Content ID clip' },
                 report: cases.contentId, kind: 'video', override: true });
} catch (e) { criticalRefused = !!e.blocked; }
check('CRITICAL refuses even an explicit override', criticalRefused, true);
MR.Queue.jobs.slice().forEach((j) => MR.Queue.remove(j.id));

section('queue reactivity');
const rjob = MR.Queue.add({
  info: { id: 'bbbbbbbbbbb', title: 'Reactive clip', channel: 'C' },
  report: cases.clean, kind: 'video'
});
await settle(60);
check('new job reaches the queue', MR.Queue.jobs.length, 1);

MR.Bus.patch({ view: 'queue' });
await settle(200);

/* Queue mutates its own job objects in place and THEN announces the change.
   If the store held the same object references, setState would compare the new
   value against an already mutated object, see no difference, and skip the
   update — which is exactly how the queue froze at 0%. */
rjob.percent = 42;
rjob.state = 'running';
MR.Bus.updateJob(rjob.id, { percent: 42, state: 'running' });
await settle(120);
check('queue view renders the job', !!$('.mr-job'), true);
check('queue view shows live progress',
  ($('.mr-job .ps2-progress__fill')?.getAttribute('style') || '').includes('42'), true);
check('queue view shows the running state', $('.mr-job')?.dataset.state, 'running');
MR.Queue.jobs.slice().forEach((j) => MR.Queue.remove(j.id));
await settle(80);
check('removing a job clears the view', !!$('.mr-job'), false);
MR.Config.set('strictMode', true);

section('yt-dlp argument building');
const Y = MR.YtDlp;
/* --embed-thumbnail aborts the whole job on a container that cannot hold cover
   art. WAV is the default audio format, so this one is not hypothetical:
   verified against live yt-dlp, which exits 1 with
   "Supported filetypes for thumbnail embedding are: mp3, mkv/mka, ogg/opus/flac, m4a/mp4/m4v/mov". */
check('wav cannot embed a thumbnail', Y.supportsThumbnail({ kind: 'audio', audioFormat: 'wav' }), false);
check('mp3 can', Y.supportsThumbnail({ kind: 'audio', audioFormat: 'mp3' }), true);
check('flac can', Y.supportsThumbnail({ kind: 'audio', audioFormat: 'flac' }), true);
check('mp4 can', Y.supportsThumbnail({ kind: 'video', container: 'mp4' }), true);
check('webm cannot', Y.supportsThumbnail({ kind: 'video', container: 'webm' }), false);

const wavArgs = Y.downloadArgs({ kind: 'audio', audioFormat: 'wav', outDir: 'C:\\out', outName: 'x', url: 'U' });
const mp3Args = Y.downloadArgs({ kind: 'audio', audioFormat: 'mp3', outDir: 'C:\\out', outName: 'x', url: 'U' });
check('wav job omits --embed-thumbnail', wavArgs.includes('--embed-thumbnail'), false);
check('mp3 job keeps --embed-thumbnail', mp3Args.includes('--embed-thumbnail'), true);
check('progress + final-path markers are always requested',
  wavArgs.some((a) => a.includes('@@MRP@@')) && wavArgs.some((a) => a.includes('@@MRF@@')), true);

section('both = one muxed file');
const bothArgs = Y.downloadArgs({ kind: 'both', container: 'mp4', quality: '1080',
  outDir: 'C:\\out', outName: 'x', url: 'U' });
const fmtBoth = bothArgs[bothArgs.indexOf('-f') + 1];
const fmtVideo = Y.downloadArgs({ kind: 'video', container: 'mp4', quality: '1080',
  outDir: 'C:\\out', outName: 'x', url: 'U' })[bothArgs.indexOf('-f') + 1];
check('both never falls back to a video-only stream', /\/b$/.test(fmtBoth), false);
check('video keeps its silent-source fallback', /\/b(\[height<=\d+\])?$/.test(fmtVideo), true);
check('both merges into the chosen container', bothArgs.includes('--merge-output-format'), true);
check('both is one job, not two', MR.Queue.addBoth({
  info: { id: 'bothtest11', title: 'Both test' }, report: cases.clean
}).length, 1);
MR.Queue.jobs.slice().forEach((j) => MR.Queue.remove(j.id));

section('preview stream (YouTube embeds are refused in CEP)');
check('a stream resolver exists instead of an iframe', typeof Y.streamUrl, 'function');
const fallbackUrl = await Y.streamUrl('abcdefghijk', 480);
check('strict H.264 selector failing still resolves via the last-resort fallback',
  /^https:\/\//.test(fallbackUrl) && fallbackUrl.includes('googlevideo.com'), true);

section('uppbeat');
const UB = MR.Uppbeat;
UB.clearSession();
const track = { id: 't1', title: 'Golden Hour', artist: 'Pecan Pie', page: 'https://uppbeat.io/t/pecan-pie/golden-hour' };
const freeReport = UB.report(track);
check('free plan requires the artist credit', freeReport.requiresAttribution, true);
check('free plan download is still allowed', L.allow(freeReport), true);
check('free credit names the artist', freeReport.attribution.short.includes('Pecan Pie'), true);
UB.setCookiesManually('sess=abc');
UB.session().plan = 'creator';
const paidReport = UB.report(track);
check('premium plan is LOW risk', paidReport.level, 'LOW');
check('premium plan does not force the credit', paidReport.requiresAttribution, false);
UB.clearSession();
check('cookie jar keeps only uppbeat.io', UB.parseJar(
  '# Netscape HTTP Cookie File\n' +
  '.uppbeat.io\tTRUE\t/\tTRUE\t0\tsession\tXYZ\n' +
  '.youtube.com\tTRUE\t/\tTRUE\t0\tLEAK\tNOPE\n'), 'session=XYZ');
check('filename split for assisted ingest', UB.guessFromFilename('Pecan Pie - Golden Hour.mp3'),
  { artist: 'Pecan Pie', title: 'Golden Hour' });
check('browser fallback list is exposed', Array.isArray(UB.BROWSERS) &&
  UB.BROWSERS.some(function (b) { return b.id === 'firefox'; }) &&
  typeof UB.browserInstalled === 'function' && typeof UB.cookiesArg === 'function', true);
{
  const before = shims.SPAWNED.length;
  await UB.importSession('firefox').catch(function () {});
  const args = shims.SPAWNED.slice(before).find(function (a) { return a.indexOf('--cookies-from-browser') > -1; }) || [];
  check('cookie import asks for the right browser',
    args[args.indexOf('--cookies-from-browser') + 1] === 'firefox', true);
  check('cookie import never fetches uppbeat.io (offline URL)',
    args.indexOf('unsupported:uppbeat-cookies-only') > -1 && args.indexOf('https://uppbeat.io/') === -1, true);
}
check('one-shot importNow is exposed for the sign-in popup', typeof UB.importNow, 'function');
{
  const before = shims.SPAWNED.length;
  await UB.importNow().catch(function () {});
  const args = shims.SPAWNED.slice(before).find(function (a) { return a.indexOf('--cookies-from-browser') > -1; }) || [];
check('importNow drives yt-dlp with the offline cookie URL',
    args.indexOf('unsupported:uppbeat-cookies-only') > -1 && args.indexOf('https://uppbeat.io/') === -1, true);
}
check('manual cookie parser handles a Cookie header',
  UB.parseManualCookies('Cookie: session=abc; auth_token=xyz'), 'session=abc; auth_token=xyz');
check('manual cookie parser handles line-separated pairs',
  UB.parseManualCookies('session=abc\nauth_token=xyz'), 'session=abc; auth_token=xyz');
check('manual cookie parser handles a Cookie-Editor JSON export',
  UB.parseManualCookies('[{"name":"auth_token","value":"xyz","domain":".uppbeat.io"}]'), 'auth_token=xyz');
check('setAuthToken is exposed', typeof UB.setAuthToken, 'function');
check('setAuthorizationToken is exposed (separate download credential)',
  typeof UB.setAuthorizationToken, 'function');
UB.setAuthToken('xyzsecret');
/* It used to copy the pasted value into `authorization_token` too, on the guess
   that one of the two names had to be right. They are different cookies with
   different values: the V2 download API reads authorization_token and answers
   500 (not 401) for any value it does not accept — so the fabricated cookie
   was itself the cause of the HTTP 500 on every download. */
check('setAuthToken no longer fabricates an authorization_token cookie',
  UB.session().cookies, 'auth_token=xyzsecret');
check('a bare non-JWT auth_token fills only the account field',
  UB.session().authToken, 'xyzsecret');
check('a bare non-JWT auth_token leaves the download field empty',
  UB.session().authorizationToken, '');
await UB.setAuthToken('authorization_token=jwtabc');
check('setAuthToken keeps a name=value paste intact (authorization_token wins)',
  UB.session().cookies, 'authorization_token=jwtabc');
check('name=value authorization_token populates the download field',
  UB.session().authorizationToken, 'jwtabc');
await UB.setAuthToken('auth_token=short');
check('setAuthToken keeps a name=value paste intact (auth_token wins)',
  UB.session().cookies, 'auth_token=short');
UB.clearSession();
/* A pasted auth JWT must enable BOTH APIs: it names the plan from its claims
   AND doubles as the download credential (Uppbeat accepts it as a Bearer token
   for the V2 download API). */
await UB.setAuthorizationToken('v2jwtvalue');
check('setAuthorizationToken sets the download credential without touching auth',
  UB.session().authorizationToken, 'v2jwtvalue');
UB.clearSession();

/* --- the two-credential paste panel --------------------------------------- */
check('setTokens is exposed for the two-field sign-in', typeof UB.setTokens, 'function');
await UB.setTokens('accountTok', 'downloadTok');
check('setTokens stores each credential under its own cookie name',
  UB.session().cookies, 'auth_token=accountTok; authorization_token=downloadTok');
check('setTokens keeps the account credential separate', UB.session().authToken, 'accountTok');
check('setTokens keeps the download credential separate',
  UB.session().authorizationToken, 'downloadTok');
/* Apply handles failure only through the promise, so a bad paste must REJECT.
   A synchronous throw escapes the handler and wedges the button disabled. */
for (const [label, a, z] of [
  ['a blank auth_token', '  ', 'downloadTok'],
  ['a blank authorization_token', 'accountTok', '";"'],
]) {
  let rejected = false, threw = false;
  try { await UB.setTokens(a, z).then(() => {}, () => { rejected = true; }); }
  catch (e) { threw = true; }
  check('setTokens rejects (never throws) on ' + label, rejected && !threw, true);
}
UB.clearSession();

/* The V2 download API answers 401 with no credential but 500 with one it
   rejects, and it always rejects the opaque auth_token — so auth_token must
   never be used as a Bearer fallback there. */
await UB.setAuthToken('opaqueaccountonly');
{
  const before = shims.REQUESTS.length;
  await UB.resolveDownload({ id: '13902', kind: 'track' }).catch(() => {});
  const call = shims.REQUESTS.slice(before).find((r) => /api-v2-cdn/.test(String(r.host)));
  check('no V2 request is made when only the account credential exists', !!call, false);
}
UB.clearSession();
await UB.setTokens('accountTok', 'downloadTok');
{
  const before = shims.REQUESTS.length;
  await UB.resolveDownload({ id: '13902', kind: 'track' }).catch(() => {});
  const call = shims.REQUESTS.slice(before).find((r) => /api-v2-cdn/.test(String(r.host)));
  check('the V2 Bearer carries the download credential, not the account one',
    call && call.headers.Authorization, 'Bearer downloadTok');
  check('the V2 call still sends the cookie jar (cookie-based auth works too)',
    !!(call && /authorization_token=downloadTok/.test(String(call.headers.Cookie))), true);
  check('the V2 call never leaks the account token as X-Auth-Token',
    !!(call && call.headers['X-Auth-Token']), false);
}
UB.clearSession();
check('setPlan is exposed', typeof UB.setPlan, 'function');
UB.setAuthToken('xyzsecret');
UB.setPlan('creator');
check('setPlan forces a paid plan', UB.isPremium(), true);
UB.setPlan('redetect');
check('setPlan redetect keeps signed-in premium path even if /me is unreachable',
  typeof UB.session().cookies, 'string');
UB.clearSession();
check('diagnose is exposed for the sign-in popup', typeof UB.diagnose, 'function');
check('loginWithCredentials is exposed for the password path', typeof UB.loginWithCredentials, 'function');
check('findNode/helperPath are exposed', typeof UB.findNode, 'function' && typeof UB.helperPath, 'function');
{
  const beforeSpawns = shims.SPAWNED.length;
  await UB.loginWithCredentials('', 'pw').catch(() => {});
  await UB.loginWithCredentials('a@b.invalid-email').catch(() => {});   // no password
  await UB.loginWithCredentials('not-an-email', 'pw').catch(() => {});
  check('loginWithCredentials rejects bad input WITHOUT spawning a process',
    shims.SPAWNED.length === beforeSpawns, true);
}
check('login helper ships with the repo',
  existsSync(join(ROOT, 'tools', 'uppbeat-login.mjs')), true);
{
  const beforeSpawns = shims.SPAWNED.length;
  await UB.verifyInBrowser().catch(() => {});   // no cookies -> must reject without spawning
  check('verifyInBrowser rejects without a session WITHOUT spawning a process',
    shims.SPAWNED.length === beforeSpawns, true);
}
check('refreshPlan is exposed for browser-first plan checks', typeof UB.refreshPlan, 'function');
{
  const beforeSpawns = shims.SPAWNED.length;
  await UB.refreshPlan();                        // browser verify unavailable -> falls back to /me mock
  check('refreshPlan falls back to the account endpoint when the browser verify is unavailable',
    UB.session().plan, 'creator');
  check('refreshPlan fallback clears the plan error', UB.session().planError, null);
  check('refreshPlan falls back WITHOUT extra process spawns',
    shims.SPAWNED.length === beforeSpawns, true);
}
await UB.setAuthToken('xyzsecret');
check('auth_token re-checks the plan against the account endpoint', UB.session().plan, 'creator');
check('a Creator account is recognised as premium (was showing free)',
  UB.isPremium(), true);
check('the account is read from user.user, not the auth wrapper',
  UB.session().account.email, 'pro@uppbeat.fake');
check('the session token is read from user.token, not the auth_token boolean',
  UB.session().token, 'c8730e0e96df2c17da03fb7c3311a6cfbe8c1fabcec8fd12cd498c07ec4e3ec8');
UB.clearSession();

/* A guest session is what you get from pasting an auth_token copied while
   signed OUT — the exact state that made the panel report "free" and then 500
   on every download. It must read as signed-out, never as a free account. */
{
  shims.ACCOUNT_MODE.value = 'guest';
  const beforeSpawns = shims.SPAWNED.length;
  await UB.setAuthToken('guestsecret');
  check('a guest session (is_authenticated:false) is NOT treated as signed in',
    UB.session().signedIn, false);
  check('a guest session is not premium', UB.isPremium(), false);
  check('a guest session reports why instead of silently reading free',
    /not recognise this session as signed in/.test(UB.session().planError || ''), true);
  check('a guest session does not fall through to opening Chrome',
    shims.SPAWNED.length === beforeSpawns, true);
  await UB.resolveDownload({ id: '13902' }).then(
    () => check('a guest session refuses to download', 'resolved', 'rejected'),
    (e) => check('a guest session refuses to download before spending a request',
      /No Uppbeat session|not recognise this session/.test(e.message), true));
  shims.ACCOUNT_MODE.value = 'creator';
  UB.clearSession();
}

/* browse() builds a Typesense multi_search, which is POST-only — Typesense
   404s a GET /multi_search. The panel's HTTP helper used to ignore `method`
   and `body` entirely, so every browse tab silently returned nothing. */
{
  const before = shims.REQUESTS.length;
  const rows = await UB.browse('music');
  const call = shims.REQUESTS.slice(before).find((r) => /multi_search/.test(r.path));
  check('browse sends multi_search as POST, not GET', call && call.method, 'POST');
  check('browse actually sends the searches body',
    !!(call && JSON.parse(call.body).searches[0].collection === 'tracks.v3'), true);
  check('browse declares a Content-Length for the body',
    !!(call && Number(call.headers['Content-Length']) === call.body.length), true);
  check('browse reads results[].hits and returns tracks', rows.length, 1);
  check('browse keeps the asset id the download endpoint needs', rows[0].id, '13902');
}
for (const [tab, collection] of [['sfx', 'sfx.v3'], ['trending', 'tracksTrending'], ['luts', 'motiongraphics.v2']]) {
  const before = shims.REQUESTS.length;
  await UB.browse(tab);
  const call = shims.REQUESTS.slice(before).find((r) => /multi_search/.test(r.path));
  check('browse "' + tab + '" queries the ' + collection + ' collection over POST',
    call && call.method === 'POST' && JSON.parse(call.body).searches[0].collection === collection, true);
}
{
  const before = shims.REQUESTS.length;
  const rows = await UB.search('chill');
  const call = shims.REQUESTS.slice(before).find((r) => /documents\/search/.test(r.path));
  check('search stays a GET against the single-collection endpoint', call && call.method, 'GET');
  check('search returns normalised tracks', rows.length && rows[0].title, 'Chill FM');
}

/* --- the download credential ---------------------------------------------
   Uppbeat uses two cookies: auth_token signs you in and reports the plan;
   authorization_token is what the V2 download API reads. A session holding
   only the first is exactly the "signed in, plan detected, HTTP 500 on every
   download" state, so it must be diagnosed rather than attempted. */
UB.clearSession();
await UB.setAuthToken('xyzsecret');
{
  const before = shims.REQUESTS.length;
  let msg = '(resolved instead of rejecting)';
  await UB.resolveDownload({ id: '13902', kind: 'track' }).then(() => {}, (e) => { msg = e.message; });
  check('download is refused when only auth_token is present',
    /authorization_token/.test(msg), true);
  check('the refusal explains the two-cookie split rather than blaming the plan',
    /TWO cookies/i.test(msg), true);
  check('the hopeless request is never actually sent',
    shims.REQUESTS.length === before, true);
}

UB.clearSession();
await UB.setCookiesManually('auth_token=xyzsecret; authorization_token=v2jwtvalue');
{
  const before = shims.REQUESTS.length;
  await UB.resolveDownload({ id: '13902', kind: 'track' }).catch(() => {});
  const call = shims.REQUESTS.slice(before).find((r) => /api-v2-cdn|\/download/.test(r.host + r.path));
  check('a session carrying authorization_token does attempt the download', !!call, true);
  check('the download call targets the V2 asset API', call && call.host, 'api-v2-cdn.uppbeat.io');
  check('the download call sends the format query param the SPA sends',
    !!(call && /[?&]format=(mp3|wav)/.test(call.path)), true);
  /* Verified against the live service: the V2 download API accepts the
     authorization_token (or the auth JWT) as `Authorization: Bearer` and
     answers 200 with a real signed download URL — the auth_token COOKIE alone
     answers 401. So the download credential travels as a Bearer header. */
  check('the V2 call sends the download credential as a Bearer header',
    !!(call && call.headers.Authorization === 'Bearer v2jwtvalue' && call.headers.Cookie), true);
  check('the V2 call sends the download credential, never the auth_token, as the token',
    call && call.headers.Authorization, 'Bearer v2jwtvalue');
}
{
  const before = shims.REQUESTS.length;
  await UB.resolveDownload({ id: '87094', kind: 'sfx', variantId: '90210' }).catch(() => {});
  const call = shims.REQUESTS.slice(before).find((r) => /\/download/.test(r.path));
  check('an SFX download uses the variants route Uppbeat requires',
    !!(call && /\/api\/v1\/sfx\/87094\/variants\/90210\/download/.test(call.path)), true);
}
await UB.resolveDownload({ id: '87094', kind: 'sfx' }).then(
  () => check('an SFX row with no variant id fails loudly', 'resolved', 'rejected'),
  (e) => check('an SFX row with no variant id fails loudly', /variant id/.test(e.message), true));

/* --- the WAV entitlement -------------------------------------------------
   Uppbeat gates WAV by plan: the same track answers 403 for format=wav and
   200 for format=mp3. The panel's audioFormat setting is the yt-dlp one, so
   feeding it straight through made EVERY Uppbeat download fail for anyone
   whose global preference was wav. Ask, then fall back. */
MR.Config.set('audioFormat', 'wav');
{
  const before = shims.REQUESTS.length;
  const r = await UB.resolveDownload({ id: '13902', kind: 'track' });
  const calls = shims.REQUESTS.slice(before).filter((c) => /api-v2-cdn/.test(String(c.host)));
  check('a wav preference is asked for first', /format=wav/.test(calls[0] && calls[0].path), true);
  check('a 403 on wav retries as mp3 instead of failing',
    !!calls.find((c) => /format=mp3/.test(c.path)), true);
  check('the resolved format reports what was actually served', r.format, 'mp3');
  check('the downgrade is recorded so the UI can say so', r.downgradedFrom, 'wav');
  check('the licence code comes back with the download', r.licenseCode, 'TESTCODE123');
}
{
  const res = await UB.download({ id: '13902', kind: 'track', artist: 'Dope Cat', title: 'Chill FM' });
  /* A .wav named file holding mp3 bytes breaks Premiere's import. */
  check('the file is named for the format actually served, not the one asked for',
    /\.mp3$/.test(res.file), true);
  check('download reports the served format', res.format, 'mp3');
}
MR.Config.set('audioFormat', 'mp3');
{
  const before = shims.REQUESTS.length;
  const r = await UB.resolveDownload({ id: '13902', kind: 'track' });
  const calls = shims.REQUESTS.slice(before).filter((c) => /api-v2-cdn/.test(String(c.host)));
  check('an mp3 preference asks once and does not retry', calls.length, 1);
  check('no phantom downgrade is reported when none happened', r.downgradedFrom, undefined);
}
/* When the fallback cannot save it (mp3 itself refused), the 403 must be
   explained as an entitlement rather than sending the user to re-import a
   session that is working fine. */
MR.Config.set('audioFormat', 'wav');
shims.V2_FORCE_403 = true;
{
  let msg = '(resolved)';
  await UB.resolveDownload({ id: '13902', kind: 'track' }).then(() => {}, (e) => { msg = e.message; });
  check('an unrecoverable 403 blames the plan/format, not the session',
    /insufficient privileges/i.test(msg) && /WAV/.test(msg), true);
  check('an unrecoverable 403 does not tell you to re-import the session',
    /re-open uppbeat\.io|missing or expired/i.test(msg), false);
}
shims.V2_FORCE_403 = false;
MR.Config.set('audioFormat', 'mp3');

/* --- the 20-minute download token ----------------------------------------
   Uppbeat's authorization_token is a JWT valid for ~20 minutes. Expired, it
   answers 401 Bearer error="invalid_token" with an EMPTY body, which reads to
   a user as "the whole session is broken". The token dates itself, so say so
   locally instead of spending a request to be told. */
function jwtWithExp(secondsFromNow) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b64({ alg: 'HS512', typ: 'JWT' }) + '.' +
    b64({ id: '1', role: ['User', 'Creator'], exp: Math.floor(Date.now() / 1000) + secondsFromNow }) + '.sig';
}
UB.clearSession();
await UB.setTokens('accountTok', jwtWithExp(-600));   // expired 10 minutes ago
{
  const life = UB.downloadTokenLife();
  check('an expired download token is detected locally', life && life.expired, true);
  const before = shims.REQUESTS.length;
  let msg = '(resolved)';
  await UB.resolveDownload({ id: '13902', kind: 'track' }).then(() => {}, (e) => { msg = e.message; });
  check('an expired token fails with how long ago it expired', /expired 10 minutes ago/.test(msg), true);
  check('an expired token explains the ~20 minute lifetime', /20 minutes/.test(msg), true);
  check('an expired token does not blame the plan', /plan may not cover|Insufficient/.test(msg), false);
  check('no request is spent on a token known to be dead',
    shims.REQUESTS.length === before, true);
  const st = UB.downloadStatus();
  check('downloadStatus reports the expiry for the header', st && st.tone, 'err');
}
UB.clearSession();
await UB.setTokens('accountTok', jwtWithExp(900));    // 15 minutes left
{
  const life = UB.downloadTokenLife();
  check('a live download token reports minutes remaining', life && life.expired === false && life.minutes === 15, true);
  const st = UB.downloadStatus();
  check('downloadStatus is ok while the token is healthy', st && st.tone, 'ok');
  const r = await UB.resolveDownload({ id: '13902', kind: 'track' });
  check('a live token proceeds to the download normally', !!r.url, true);
}
UB.clearSession();
await UB.setTokens('accountTok', jwtWithExp(120));    // 2 minutes left
check('downloadStatus warns when the token is nearly out',
  (UB.downloadStatus() || {}).tone, 'warn');
UB.clearSession();
/* An opaque (non-JWT) credential has no readable expiry — unreadable is not
   the same as invalid, so it must still be attempted. */
await UB.setTokens('accountTok', 'opaqueDownloadCredential');
check('an opaque download credential reports no expiry rather than failing',
  UB.downloadTokenLife(), null);
{
  const r = await UB.resolveDownload({ id: '13902', kind: 'track' });
  check('an opaque download credential is still attempted', !!r.url, true);
}
UB.clearSession();
/* prod-api still needs the header form, so the gating must be per-host. Set the
   session explicitly here rather than inheriting whatever an earlier block left
   behind — that coupling made these two checks fail the moment a test was
   inserted above them. */
UB.clearSession();
await UB.setTokens('xyzsecret', 'downloadTok');
{
  const before = shims.REQUESTS.length;
  await UB.me().catch(() => {});
  const call = shims.REQUESTS.slice(before).find((r) => /setup_frontend/.test(r.path));
  check('the account API still gets the X-Auth-Token header',
    !!(call && call.headers['X-Auth-Token'] === 'xyzsecret'), true);
  check('the account API is sent auth_token, never authorization_token, as the token',
    call && call.headers['X-Auth-Token'], 'xyzsecret');
}
UB.clearSession();

function b64url(s) { return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
const creatorJwt = b64url('{"alg":"HS512"}') + '.' +
  b64url('{"id":"1","role":["User","Creator"],"permissions":["download_premium_music","unlimited_downloads_music"]}') + '.sig';
{
  const beforeSpawns = shims.SPAWNED.length;
  const res = await UB.setAuthToken(creatorJwt);
  check('pasted Creator JWT is decoded locally WITHOUT opening Chrome',
    shims.SPAWNED.length === beforeSpawns, true);
  check('pasted Creator JWT sets plan from its own claims', UB.session().plan, 'creator');
  check('pasted Creator JWT is premium', UB.isPremium(), true);
}
const freeJwt = b64url('{"alg":"HS512"}') + '.' +
  b64url('{"id":"2","role":["User"],"permissions":[]}') + '.sig';
await UB.setAuthToken(freeJwt);
check('pasted free JWT (User only) stays free', UB.session().plan, 'free');
UB.clearSession();

const stale = JSON.stringify({ cookies: 'auth_token=' + creatorJwt + '; authorization_token=' + creatorJwt,
  token: 'true', plan: 'free', signedIn: true, importedAt: 1 });
shims.FILES['C:\\Users\\dev\\Documents\\MediaRade\\config.json'] = JSON.stringify(
  Object.assign(JSON.parse(shims.FILES['C:\\Users\\dev\\Documents\\MediaRade\\config.json']),
    { uppbeatSession: JSON.parse(stale) }));
MR.Config.load();
MR.Uppbeat.loadSession();
check('loadSession re-derives plan from a stored JWT even when config says free',
  MR.Uppbeat.session().plan, 'creator');
UB.clearSession();

section('log messages');
/* Every error the user actually saw in mediarade.log should map to something
   that names a cause. An SSL EOF used to fall through unmatched and surfaced
   the raw yt-dlp line, which explained nothing. */
check('an SSL EOF is explained, not passed through raw',
  /connection was cut partway/i.test(
    MR.YtDlp.explain('ERROR: [download] Got error: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1032). Giving up after 6 retries') || ''),
  true);
check('an SSL EOF points at the same IP check as the 403',
  /Check connection/.test(MR.YtDlp.explain('[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred') || ''), true);
check('a reset connection is explained too',
  !!MR.YtDlp.explain('ConnectionResetError: [Errno 104] Connection reset by peer'), true);
check('the 403 still leads with the IP cause, not the bot check',
  /googlevideo ties every media URL to the IP/.test(MR.YtDlp.explain('ERROR: unable to download video data: HTTP Error 403: Forbidden') || ''),
  true);
/* Version and author were typed into the source in two places that drifted
   independently. The ledger one is an evidence field, so a stale value there is
   a wrong audit record, not a cosmetic slip. Both now come from package.json. */
check('the panel version matches package.json', MR.version, PKG.version);
check('the author matches package.json', MR.author, PKG.author);
{
  /* A ledger entry is the audit record, so assert the version it stamps. */
  const rec = MR.Ledger.record({ event: 'smoke_version_probe' });
  check('a ledger entry stamps the real build version',
    rec && rec.panel, 'MediaRade ' + PKG.version);
}

section('direct links');
check('videoId reads a standard watch URL',
  MR.U.videoId('https://www.youtube.com/watch?v=jNQXAC9IVRw'), 'jNQXAC9IVRw');
check('videoId reads youtu.be, shorts, embed, live and the old /v/ form',
  ['https://youtu.be/jNQXAC9IVRw', 'https://www.youtube.com/shorts/jNQXAC9IVRw',
   'https://www.youtube.com/embed/jNQXAC9IVRw', 'https://www.youtube.com/live/jNQXAC9IVRw',
   'https://www.youtube.com/v/jNQXAC9IVRw'].map(MR.U.videoId),
  ['jNQXAC9IVRw', 'jNQXAC9IVRw', 'jNQXAC9IVRw', 'jNQXAC9IVRw', 'jNQXAC9IVRw']);
check('videoId survives extra parameters and music.youtube.com',
  ['https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PL123&index=2&t=42s',
   'https://music.youtube.com/watch?v=jNQXAC9IVRw&feature=share'].map(MR.U.videoId),
  ['jNQXAC9IVRw', 'jNQXAC9IVRw']);
check('videoId accepts a bare id', MR.U.videoId('jNQXAC9IVRw'), 'jNQXAC9IVRw');
/* `v=` used to match anywhere in the string, so a channel called "…v=…" or a
   stray query value could be mistaken for a video. Anchor it to a parameter. */
check('videoId ignores an 11-char run that is not a v parameter',
  MR.U.videoId('https://www.youtube.com/@somechannelname'), null);
check('videoId rejects free text', MR.U.videoId('lofi hip hop radio'), null);
check('isYouTubeUrl recognises the domains it should',
  ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'youtu.be/abc',
   'https://music.youtube.com/x', 'https://vimeo.com/123', 'not a url'].map(MR.U.isYouTubeUrl),
  [true, true, true, false, false]);
/* A watch URL carrying &list= is still one video — only a /playlist? address
   is a playlist, or pasting a video from a playlist would list the whole thing. */
check('playlistId only fires on a real playlist address',
  [MR.U.playlistId('https://www.youtube.com/playlist?list=PLabc123'),
   MR.U.playlistId('https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLabc123')],
  ['PLabc123', null]);

section('channel search');
check('channelUrl accepts a bare @handle',
  MR.Search.channelUrl('@MrBeast'), 'https://www.youtube.com/@MrBeast/videos');
check('channelUrl accepts a full handle URL',
  MR.Search.channelUrl('https://www.youtube.com/@LofiGirl'), 'https://www.youtube.com/@LofiGirl/videos');
check('channelUrl accepts a /channel/UC… URL',
  MR.Search.channelUrl('https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/featured'),
  'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/videos');
check('channelUrl accepts legacy /c/ and /user/ forms',
  [MR.Search.channelUrl('youtube.com/c/Something'), MR.Search.channelUrl('youtube.com/user/Someone')],
  ['https://www.youtube.com/c/Something/videos', 'https://www.youtube.com/user/Someone/videos']);
check('channelUrl rejects a plain video link',
  MR.Search.channelUrl('https://www.youtube.com/watch?v=aaaaaaaaaaa'), null);
check('channelUrl rejects free text', MR.Search.channelUrl('lofi beats'), null);
check('normalizeChannel keeps the id, name and url',
  MR.Search.normalizeChannel({ id: 'UC123', channel: 'Lofi Girl',
    url: 'https://www.youtube.com/channel/UC123', channel_follower_count: 12 }),
  { id: 'UC123', name: 'Lofi Girl', url: 'https://www.youtube.com/channel/UC123',
    handle: null, thumb: '', subs: 12, description: '' });
check('normalizeChannel drops a row with no id', MR.Search.normalizeChannel({ channel: 'x' }), null);

/* A channel avatar and a channel banner arrive mixed in one thumbnail list,
   telling apart only by aspect ratio: an avatar is square, a banner ~6:1.
   Picking the first/largest would put the banner in the avatar circle. */
check('pickChannelArt separates the square avatar from the wide banner',
  MR.Search.pickChannelArt([
    { url: 'banner-small', width: 1060, height: 175 },
    { url: 'avatar-small', width: 176, height: 176 },
    { url: 'banner-big', width: 2560, height: 424 },
    { url: 'avatar-big', width: 900, height: 900 }
  ]),
  { avatar: 'avatar-big', banner: 'banner-big' });
check('pickChannelArt still returns something when nothing is square',
  MR.Search.pickChannelArt([{ url: 'only-banner', width: 2560, height: 424 }]).avatar,
  'only-banner');
check('pickChannelArt tolerates missing dimensions and an empty list',
  [MR.Search.pickChannelArt([{ url: 'x' }]).avatar, MR.Search.pickChannelArt([]).avatar],
  ['x', null]);
check('channelPage is exposed', typeof MR.Search.channelPage, 'function');
await MR.Search.channelPage('not a channel').then(
  () => check('channelPage rejects a non-channel address', 'resolved', 'rejected'),
  (e) => check('channelPage rejects a non-channel address',
    /does not look like a YouTube channel/.test(e.message), true));

section('inbox handover');
check('Inbox is exposed', typeof MR.Inbox, 'object');
check('a job needs an http url',
  [MR.Inbox.parse('{"url":"not a url"}'), MR.Inbox.parse('{}'), MR.Inbox.parse('nonsense')],
  [null, null, null]);
check('a valid job parses with video as the default kind',
  MR.Inbox.parse('{"url":"https://www.youtube.com/watch?v=abcdefghijk","from":"FictusTube"}'),
  { url: 'https://www.youtube.com/watch?v=abcdefghijk', kind: 'video', title: '', from: 'FictusTube' });
check('a job can ask for audio',
  MR.Inbox.parse('{"url":"https://youtu.be/abcdefghijk","kind":"AUDIO","title":"t"}').kind, 'audio');
check('an unknown kind falls back to video',
  MR.Inbox.parse('{"url":"https://youtu.be/abcdefghijk","kind":"flac"}').kind, 'video');
/* FictusTube writes `source`; other senders may write `from` or `app`. Naming
   the sender should not depend on guessing which spelling they chose. */
check('the sender is read from source as well as from',
  [MR.Inbox.parse('{"url":"https://youtu.be/abcdefghijk","source":"FictusTube"}').from,
   MR.Inbox.parse('{"url":"https://youtu.be/abcdefghijk","app":"FurcaTube"}').from,
   MR.Inbox.parse('{"url":"https://youtu.be/abcdefghijk"}').from],
  ['FictusTube', 'FurcaTube', 'another app']);
{
  /* A job must be picked up, acted on, and moved out of the way so a restart
     cannot download it a second time. */
  /* Ask the app where its inbox is rather than hardcoding a path — the test
     then cannot drift from Paths.dir(). */
  const SEP = String.fromCharCode(92);
  const inbox = MR.Paths.dir('inbox');
  shims.DIRS[inbox] = true;
  shims.FILES[inbox + SEP + 'job1.json'] =
    '{"url":"https://www.youtube.com/watch?v=zzzzzzzzzzz","kind":"audio","from":"FictusTube"}';
  const seen = [];
  const offJob = MR.Bus.on('inbox:job', (j) => seen.push(j));
  const jobs = MR.Inbox.scan();
  offJob();
  check('scan picks the job up', jobs.length, 1);
  check('scan announces it on the bus', seen.length && seen[0].from, 'FictusTube');
  check('the job file is moved out of the inbox',
    !!shims.FILES[inbox + SEP + 'job1.json'], false);
  check('re-scanning does not replay the job', MR.Inbox.scan().length, 0);
}

section('browse cards');
const info0 = { id: 'bbbbbbbbbbb', title: 'Genuine CC BY clip', channel: 'Real Creator',
  description: 'Shot on my own camera.', license: 'Creative Commons Attribution license (reuse allowed)',
  duration: 120, view_count: 1000, upload_date: '20260101' };
MR.Search.infoCache[info0.id] = info0;
MR.Search.reportCache[info0.id] = L.evaluate(info0);
MR.Bus.patch({ view: 'browse', searching: false, searchError: null, results: [{
  id: info0.id, title: info0.title, channel: info0.channel, duration: 120, views: 1000,
  uploadDate: '20260101', thumb: '', url: '', live: false,
  report: MR.Search.reportCache[info0.id], verifying: false
}] });
await settle();
check('card renders with its risk level', $('.mr-card')?.dataset.tier, 'LOW');
check('thumbnail has a play affordance', !!$('.mr-card__playbtn'), true);
check('card actions', $$('.mr-card__actions .ps2-btn').map(text),
  ['Video', 'Audio', 'Copy credit ✱']);

section('drag to Premiere');
shims.FILES['C:\\Users\\dev\\Documents\\MediaRade\\Downloads\\Video\\clip.mp4'] = 'clip';
MR.Bus.patch({ view: 'library', libraryItems: [
  { id: 'lib1', videoId: info0.id, title: 'Genuine CC BY clip', channel: 'Real Creator',
    kind: 'video', file: 'C:\\Users\\dev\\Documents\\MediaRade\\Downloads\\Video\\clip.mp4',
    files: [], thumb: null, report: MR.Search.reportCache[info0.id], size: 1024, downloadedAt: Date.now() },
  { id: 'lib2', videoId: 'ggggggggggg', title: 'Gone clip', channel: 'Real Creator',
    kind: 'video', file: 'C:\\Users\\dev\\Documents\\MediaRade\\Downloads\\Video\\gone.mp4',
    files: [], thumb: null, report: null, size: 512, downloadedAt: Date.now() }
] });
await settle(200);
check('library thumbnail is a native OS drag source',
  $('.mr-lib-item__thumb')?.getAttribute('draggable'), 'true');
check('Place button is also a drag source',
  $$('.mr-lib-item__foot .ps2-btn').filter((b) => b.getAttribute('draggable') === 'true').length, 2);

/* A drag source that cannot hand a real file to the OS is useless — assert a
   dragstart actually publishes the clip as a file:// uri-list (what Premiere's
   timeline accepts) plus the raw path. */
const dragEl = $('.mr-lib-item__thumb');
const fakeDT = {
  data: {}, types: [], effectAllowed: null,
  setData(t, v) { this.data[t] = v; if (this.types.indexOf(t) < 0) this.types.push(t); },
  getData(t) { return this.data[t] || ''; },
  setDragImage() {}
};
const dragEv = new win.MouseEvent('dragstart', { bubbles: true, cancelable: true });
Object.defineProperty(dragEv, 'dataTransfer', { value: fakeDT });
dragEl.dispatchEvent(dragEv);
check('dragstart publishes the file as a file:// uri-list',
  fakeDT.getData('text/uri-list').indexOf('file:///C:/Users/dev/Documents/MediaRade/Downloads/Video/clip.mp4') > -1, true);
check('dragstart also publishes the raw Windows path',
  fakeDT.getData('text/plain'), 'C:\\Users\\dev\\Documents\\MediaRade\\Downloads\\Video\\clip.mp4');
check('dragstart publishes the CEP file-drag property Premiere needs',
  fakeDT.getData('application/x-cef-dnd-file'), 'C:\\Users\\dev\\Documents\\MediaRade\\Downloads\\Video\\clip.mp4');
check('a dragstart for a file no longer on disk publishes nothing', (() => {
  const gone = $$('.mr-lib-item').find((el) => (el.textContent || '').includes('Gone clip'));
  const d = { data: {}, types: [], setData(t, v) { this.data[t] = v; if (this.types.indexOf(t) < 0) this.types.push(t); }, getData(t) { return this.data[t] || ''; } };
  const ev = new win.MouseEvent('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: d });
  gone.querySelector('.mr-lib-item__thumb').dispatchEvent(ev);
  return d.getData('text/uri-list');
})(), '');
MR.Bus.patch({ view: 'browse' });
await settle(150);

section('direct-link bar');
{
  MR.Bus.patch({ view: 'browse' });
  await settle(150);
  const box = $('.mr-searchbar input');
  const type = async (text) => {
    box.value = text;
    box.dispatchEvent(new win.Event('input', { bubbles: true }));
    await settle(80);
  };

  check('no direct bar for an empty box', !!$('.mr-directbar'), false);
  await type('lofi hip hop');
  check('no direct bar for a plain search', !!$('.mr-directbar'), false);

  await type('https://www.youtube.com/watch?v=jNQXAC9IVRw');
  check('a pasted video link raises the direct bar', !!$('.mr-directbar'), true);
  check('the bar says what it recognised',
    /Video link detected/.test(text($('.mr-directbar'))), true);
  const labels = $$('.mr-directbar .ps2-btn').map(text);
  check('the bar offers video and audio download without searching first',
    labels, ['Download video', 'Download audio', 'Open']);

  /* The whole point is one click from paste to download — and it must go
     through Acquire so the licence gate still applies. */
  /* Assert on the spawn, not on Search.report(): that returns null rather than
     undefined for an unknown id, so comparing against undefined can never
     fail and would have proved nothing. A licence check means yt-dlp is asked
     for full metadata, so the spawn is the evidence. */
  const spawnsBefore = shims.SPAWNED.length;
  $$('.mr-directbar .ps2-btn')[0].click();
  await settle(400);
  const spawned = shims.SPAWNED.slice(spawnsBefore);
  check('a direct download runs the licence check first, not a blind download',
    spawned.some((a) => a.indexOf('-J') > -1 &&
      a.some((x) => String(x).indexOf('jNQXAC9IVRw') > -1)), true);
  check('nothing is queued before a verdict exists', MR.Queue.jobs.length, 0);

  await type('https://www.youtube.com/@LofiGirl');
  check('a pasted channel link is recognised as a channel',
    /Channel link detected/.test(text($('.mr-directbar'))), true);
  check('a channel link offers no download buttons, only Open channel',
    $$('.mr-directbar .ps2-btn').map(text), ['Open channel']);

  await type('https://www.youtube.com/playlist?list=PLabc123');
  check('a pasted playlist link is recognised as a playlist',
    /Playlist link detected/.test(text($('.mr-directbar'))), true);
  check('a playlist link offers List videos', $$('.mr-directbar .ps2-btn').map(text), ['List videos']);

  await type('');
  check('clearing the box removes the bar', !!$('.mr-directbar'), false);
  MR.Bus.patch({ view: 'browse' });
  await settle(120);
}

section('clicking a video opens it');
$('.mr-card__title').click();
await settle(250);
check('clicking the card body opens the Video view', $('.mr-view.is-active')?.dataset.view, 'video');
check('body click shows the poster, not the player', !!$('.mr-player__cover'), true);

MR.Bus.patch({ view: 'browse' });
await settle(150);
$('.mr-card__thumb').click();
await settle(250);
check('clicking the thumbnail opens the Video view', $('.mr-view.is-active')?.dataset.view, 'video');
await settle(300);   // the preview resolves a stream URL through yt-dlp
check('thumbnail click plays a real stream, not a YouTube iframe', !!$('.mr-player video'), true);
check('no iframe embed is used (CEP origin is null, YouTube returns Error 153)',
  !!$('.mr-player iframe'), false);
check('the resolved stream is what gets played',
  ($('.mr-player video')?.getAttribute('src') || '').indexOf('googlevideo.com') > -1, true);

section('copy attribution');
const videoBtns = $$('.mr-view[data-view="video"] .ps2-btn').map(text);
check('a copy-credit button sits next to Audio',
  videoBtns.slice(videoBtns.indexOf('Audio'), videoBtns.indexOf('Audio') + 2), ['Audio', 'Copy credit ✱']);
check('a copy-credit button sits on the download panel',
  videoBtns.filter((b) => b && b.startsWith('Copy credit')).length, 2);
check('attribution block is rendered', ($('.mr-attrib')?.textContent || '').includes('CC BY 3.0'), true);

section('licence check states');
/* A video that has never been checked must render immediately, say so honestly,
   and offer a manual "Check licence" — not block the whole view on a fetch. */
const freshId = 'zzzzzneverchecked';
MR.Bus.patch({ view: 'video', videoId: freshId, autoPlay: false, videoNonce: Date.now() });
await settle(250);
check('unchecked video shows the not-checked-yet message',
  ($('.mr-view[data-view="video"]')?.textContent || '').includes('has not been licence-checked yet'), true);
check('a manual Check licence button is offered',
  $$('.mr-view[data-view="video"] .ps2-btn').map(text).includes('Check licence'), true);
check('no verdict is shown before checking', !!$('.mr-view[data-view="video"] .mr-verdict'), false);

section('setup');
MR.Bus.patch({ view: 'settings' });
await settle(200);
check('setup panels', $$('.mr-view[data-view="settings"] .ps2-panel__title').map(text),
  ['Risk checker policy', 'Tooling', 'Uppbeat', 'Download defaults', 'Premiere', 'Storage', 'Diagnostics', 'About']);

section('uppbeat view');
MR.Bus.patch({ view: 'uppbeat' });
await settle(200);
const ubText = $('.mr-view[data-view="uppbeat"]')?.textContent || '';
check('free-plan credit warning is shown', ubText.includes('you must credit the artist'), true);
check('sign-in is offered', ubText.toUpperCase().includes('SIGN IN'), true);
check('the mode selector is gone (direct is the only mode)',
  ubText.toLowerCase().includes('assisted (browser)'), false);
check('one-step browser sign-in exists', typeof UB.signIn, 'function');
{
  let opened = '';
  const origOpen = win.open;
  win.open = (u) => { opened = u; return {}; };
  UB.openSignIn();
  win.open = origOpen;
  check('login opens https://uppbeat.io/login', opened, 'https://uppbeat.io/login');
}
check('ingest survives as a fallback', ubText.toUpperCase().includes('INGEST A FILE'), true);

/* ========================================================================== */

console.log('\n' + (failures.length
  ? '\u001b[31m' + failures.length + ' failed\u001b[0m, ' + pass + ' passed\n  - ' + failures.join('\n  - ')
  : '\u001b[32mall ' + pass + ' checks passed\u001b[0m'));

process.exit(failures.length ? 1 : 0);
