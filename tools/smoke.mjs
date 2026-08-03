/* =============================================================================
   tools/smoke.mjs — headless smoke test for the built panel.
   MediaRade by rad1x

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
     node tools/smoke.mjs "%APPDATA%\Adobe\CEP\extensions\com.rad1x.mediarade" */
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
    readdirSync: () => [],
    statSync: (p) => {
      p = norm(p);
      if (!(p in FILES) && !DIRS[p]) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { size: (FILES[p] || '').length, mtimeMs: Date.now(),
               isFile: () => p in FILES, isDirectory: () => !!DIRS[p] };
    },
    createWriteStream: () => ({ on() {}, close(cb) { cb && cb(); }, write() {}, end() {} })
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

  const modules = {
    path, fs,
    os: { homedir: () => 'C:\\Users\\dev', platform: () => 'win32' },
    child_process: { spawn: (exe, args) => fakeChild(args) },
    https: {
      get: (opts, cb) => {
        /* Respond to the Uppbeat account check like the live API would — a
           Creator account with the plan nested under subscription.plan. */
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { 'content-length': '2' };
        res.setEncoding = () => {};
        cb(res);
        const body = JSON.stringify({
          user: { email: 'pro@uppbeat.fake', name: 'Pro User', subscription: { plan: 'creator' } }
        });
        setTimeout(() => { res.emit('data', body); res.emit('end'); }, 1);
        return { on() {}, destroy() {} };
      }
    },
    url: { parse: (u) => { const x = new URL(u); return { protocol: x.protocol, hostname: x.hostname, path: x.pathname + x.search }; } }
  };

  win.cep_node = { require: (m) => { if (modules[m]) return modules[m]; throw new Error('no module ' + m); } };

  const SEQ = { name: 'Smoke Sequence', id: 'seq-1', playhead: 12.5, inPoint: 4, outPoint: 30,
                fps: 25, videoTracks: 3, audioTracks: 4, end: 180, zeroPoint: 0 };

  win.__adobe_cep__ = {
    evalScript(script, cb) {
      const fn = (script.match(/\$\._MediaRade\.(\w+)/) || [])[1];
      let data = {};
      if (fn === 'ping') data = { version: '1.0.0', host: 'Premiere Pro', hostVersion: '25.0', hasProject: true };
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

  return { FILES, DIRS, SPAWNED };
}

/* --- boot ------------------------------------------------------------------ */

const html = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8')
  .replace(/<script[^>]*><\/script>/g, '')
  .replace(/<link[^>]*>/g, '');

const bundle = readFileSync(join(ROOT, 'dist', 'js', 'mediarade.js'), 'utf8');

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
UB.setAuthToken('xyzsecret');
check('setAuthToken stores BOTH auth_token and authorization_token',
  UB.session().cookies, 'auth_token=xyzsecret; authorization_token=xyzsecret');
await UB.setAuthToken('authorization_token=jwtabc');
check('setAuthToken keeps a name=value paste intact (authorization_token wins)',
  UB.session().cookies, 'authorization_token=jwtabc');
await UB.setAuthToken('auth_token=short');
check('setAuthToken keeps a name=value paste intact (auth_token wins)',
  UB.session().cookies, 'auth_token=short');
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
