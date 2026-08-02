/* =============================================================================
   views/settings.jsx — setup, policy, diagnostics. MediaRade by rad1x
   ========================================================================== */
import { For, Show, createSignal, onMount } from 'solid-js';
import Bus, { state } from '../core/bus.js';
import Config from '../core/config.js';
import License from '../core/license.js';
import Library from '../core/library.js';
import Paths from '../core/paths.js';
import Premiere from '../core/premiere.js';
import YtDlp from '../core/ytdlp.js';
import SP from '../core/sp.js';
import Uppbeat from '../core/uppbeat.js';
import { CEP } from '../core/cep.js';
import U from '../core/util.js';
import Ambient from '../ui/ambient.js';
import Modal from '../ui/modal.js';
import Toast from '../ui/toast.js';
import { useConfig } from '../ui/reactive.js';
import { Badge, Btn, Select, Switch } from '../ui/components.jsx';

/* --- helpers -------------------------------------------------------------- */

function Row(props) {
  return (
    <div style={{ marginBottom: '10px' }}>
      <div class="mr-field__label" style={{ marginBottom: '3px' }}>{props.label}</div>
      {props.children}
      {props.hint ? <div class="ps2-caption" style={{ marginTop: '3px' }} innerHTML={props.hint} /> : null}
    </div>
  );
}

function TextInput(props) {
  let el;
  onMount(function () { el.value = Config.get(props.key) || ''; });
  return (
    <input ref={el} class="ps2-input" type="text" placeholder={props.placeholder || ''}
      onChange={(e) => Config.set(props.key, e.target.value.trim())} />
  );
}

function NumInput(props) {
  let el;
  onMount(function () { el.value = Config.get(props.key); });
  return (
    <input ref={el} class="ps2-input" type="number" min={props.min} max={props.max}
      onChange={(e) => {
        const v = U.clamp(parseInt(e.target.value, 10) || props.min, props.min, props.max);
        Config.set(props.key, v);
        el.value = v;
      }} />
  );
}

function Toggle(props) {
  const [get] = useConfig(props.key);
  return (
    <div style={{ marginBottom: '8px' }}>
      <Switch label={props.label} on={get()}
        onChange={(on) => {
          Config.set(props.key, on);
          if (props.onchange) props.onchange(on);
        }} />
      {props.hint ? <div class="ps2-caption" style={{ marginTop: '2px', marginLeft: '44px' }} innerHTML={props.hint} /> : null}
    </div>
  );
}

function Panel(props) {
  return (
    <div class="ps2-panel" style={{ marginBottom: '14px' }}>
      <div class="ps2-panel__header">
        <span class="ps2-panel__title">{props.title}</span>
        <span class="ps2-panel__spacer" />
        {props.badge || null}
      </div>
      <div>{props.children}</div>
    </div>
  );
}

/* --- panels ---------------------------------------------------------------- */

function LicensingPanel() {
  const [strict] = useConfig('strictMode');

  function onStrictToggle(on) {
    if (on) {
      Config.setStrict(true);
      Toast.ok('Strict mode on', 'Only LOW-risk verified Creative Commons material can be downloaded.');
      return;
    }
    Modal.confirm({
      title: 'Turn strict mode off?',
      danger: true,
      okLabel: 'Turn it off',
      cancelLabel: 'Keep it on',
      body:
        'Strict mode is what stops a mislabelled "royalty free" upload reaching your timeline. ' +
        'With it off, MediaRade still verifies and still flags every problem, but HIGH-risk ' +
        'material can be downloaded after you record a written reason. ' +
        '<b>CRITICAL material — anything under Content ID enforcement or with a stated licence ' +
        'YouTube reports as Standard — always blocks, in every mode.</b><br><br>' +
        '<b>The change itself is written to the ledger</b>, along with every override that follows. ' +
        'Only do this for material you actually have the rights to.'
    }).then(function (yes) {
      if (!yes) return;
      Modal.prompt({
        title: 'Reason for disabling strict mode',
        text: 'This goes in the ledger.',
        placeholder: 'e.g. "Licensed archive footage cleared by production"'
      }).then(function (reason) {
        if (!reason) return;
        Config.setStrict(false, reason);
        Toast.warn('Strict mode off', 'Overrides are now possible, and every one is logged.');
      });
    });
  }

  return (
    <Panel title="Risk checker policy"
      badge={<Badge text={strict() ? 'strict' : 'permissive'} kind={strict() ? 'ok' : 'crit'} />}>
      <div class="mr-claimwarn" style={strict() ? {
        color: 'var(--ps2-ok)', background: 'rgba(69,214,127,0.07)',
        borderColor: 'rgba(69,214,127,0.3)', borderLeftColor: 'var(--ps2-ok)'
      } : {}}>
        <span>{strict() ? '🔒' : '⚠'}</span>
        <span innerHTML={strict()
          ? 'Downloads are limited to <b>LOW-risk</b> uploads whose YouTube licence field reports ' +
            'Creative Commons and that carry no critical flags. <b>HIGH</b> requires a written override; ' +
            '<b>CRITICAL always blocks.</b>'
          : '<b>Permissive mode.</b> <b>LOW</b> and <b>MODERATE</b> download freely, <b>HIGH</b> asks for ' +
            'a written reason, and <b>CRITICAL</b> (Content ID enforcement, stated licence YouTube reports ' +
            'as Standard) always blocks. Every verdict is still written to the ledger.'} />
      </div>
      <div style={{ height: '10px' }} />
      <div style={{ marginBottom: '8px' }}>
        <Switch label="Strict mode" on={strict()} onChange={onStrictToggle} />
      </div>
      <div style={{ height: '12px' }} />
      <Toggle key="autoVerify" label="Verify every search result automatically"
        hint="Off means results stay unverified until you open or download them — faster searches, no verdicts up front." />
      <Toggle key="writeSidecars" label="Write .license.json and attribution.txt beside each download" />
      <Toggle key="writeCredits" label="Append every credit to Compliance\CREDITS.md" />
      <Toggle key="stampMarker" label="Stamp a timeline marker with the attribution on insert" />
      <Toggle key="ledgerEnabled" label="Keep the append-only compliance ledger" />
      <Row label="Verification concurrency"
        hint="Parallel metadata fetches. Too high invites YouTube rate-limiting.">
        <NumInput key="verifyConcurrency" min={1} max={8} />
      </Row>
    </Panel>
  );
}

function ToolsPanel() {
  const t = () => state.tools;

  function redetect() {
    YtDlp.locate().then(function (r) {
      Toast[r.ytdlp ? 'ok' : 'err'](r.ytdlp ? 'Found yt-dlp' : 'yt-dlp not found',
        r.ytdlp || 'Install it, or drop yt-dlp.exe in Documents\\MediaRade\\bin.');
    });
  }

  function update() {
    if (!YtDlp.ready()) { Toast.err('Nothing to update', 'yt-dlp was not found.'); return; }
    const n = Toast.show({ kind: 'info', title: 'Updating yt-dlp…', text: 'This can take a minute.', sticky: true });
    YtDlp.selfUpdate().then(function (out) {
      n.close();
      Toast.ok('yt-dlp updated', (YtDlp.version || '') + ' — ' + U.truncate(out.trim().split('\n').pop(), 70));
    }).catch(function (e) { n.close(); Toast.err('Update failed', e.message); });
  }

  return (
    <Panel title="Tooling"
      badge={<Badge text={t().ytdlp ? 'ready' : 'not ready'} kind={t().ytdlp ? 'ok' : 'crit'} />}>
      <div class="mr-meta-grid" style={{ marginBottom: '10px' }}>
        <dt>yt-dlp</dt>
        <dd style={{ color: t().ytdlp ? 'var(--ps2-ok)' : 'var(--ps2-crit)' }}>
          {t().ytdlp ? t().ytdlp + (t().ytdlpVersion ? '  (' + t().ytdlpVersion + ')' : '') : 'NOT FOUND'}
        </dd>
        <dt>ffmpeg</dt>
        <dd style={{ color: t().ffmpeg ? 'var(--ps2-ok)' : 'var(--ps2-warn)' }}>{t().ffmpeg || 'NOT FOUND'}</dd>
        <dt>Node</dt>
        <dd style={{ color: CEP.nodeAvailable ? 'var(--ps2-ok)' : 'var(--ps2-crit)' }}>
          {CEP.nodeAvailable ? 'available' : 'UNAVAILABLE — the panel cannot run yt-dlp'}
        </dd>
      </div>
      <div class="ps2-row-gap ps2-wrap" style={{ marginBottom: '12px' }}>
        <Btn size="sm" variant="primary" label="Re-detect" onClick={redetect} />
        <Btn size="sm" label="Update yt-dlp" onClick={update} />
        <Btn size="sm" variant="ghost" label="bin folder" onClick={() => CEP.openFolder(Paths.dir('bin'))} />
      </div>
      <Row label="yt-dlp path"
        hint="MediaRade looks in <code>Documents\MediaRade\bin\yt-dlp.exe</code> first, then your PATH.">
        <TextInput key="ytdlpPath" placeholder="blank = auto-detect (bin\ then PATH)" />
      </Row>
      <Row label="ffmpeg path" hint="Required for merging video+audio streams and for any audio conversion.">
        <TextInput key="ffmpegPath" placeholder="blank = auto-detect" />
      </Row>
      <Row label="Cookies from browser"
        hint="Needed for age-restricted videos and when YouTube challenges the request. Uses your signed-in session.">
        <Select
          options={[{ value: '', label: 'none' }, 'chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'chromium']}
          value={Config.get('cookiesFromBrowser')}
          onChange={(v) => Config.set('cookiesFromBrowser', v)} />
      </Row>
      <Row label="Proxy">
        <TextInput key="proxy" placeholder="http://host:port  or  socks5://host:port" />
      </Row>
      <Row label="Rate limit" hint="Throttling downloads makes rate-limiting far less likely on long sessions.">
        <TextInput key="rateLimit" placeholder="e.g. 2M — blank for unlimited" />
      </Row>
    </Panel>
  );
}

function DownloadsPanel() {
  const quality = [
    { value: 'best', label: 'Best available' }, { value: '2160', label: '2160p (4K)' },
    { value: '1440', label: '1440p' }, { value: '1080', label: '1080p' },
    { value: '720', label: '720p' }, { value: '480', label: '480p' }
  ];
  return (
    <Panel title="Download defaults">
      <div class="mr-optgrid" style={{ marginBottom: '12px' }}>
        <div class="mr-field">
          <span class="mr-field__label">Video quality</span>
          <Select options={quality} value={Config.get('videoQuality')}
            onChange={(v) => Config.set('videoQuality', v)} />
        </div>
        <div class="mr-field">
          <span class="mr-field__label">Container</span>
          <Select options={['mp4', 'mkv', 'webm']} value={Config.get('videoContainer')}
            onChange={(v) => Config.set('videoContainer', v)} />
        </div>
        <div class="mr-field">
          <span class="mr-field__label">Audio format</span>
          <Select options={[{ value: 'wav', label: 'WAV' }, { value: 'flac', label: 'FLAC' }, { value: 'm4a', label: 'M4A' }, { value: 'mp3', label: 'MP3' }, { value: 'opus', label: 'Opus' }]}
            value={Config.get('audioFormat')} onChange={(v) => Config.set('audioFormat', v)} />
        </div>
        <div class="mr-field">
          <span class="mr-field__label">Results per search</span>
          <NumInput key="resultCount" min={5} max={100} />
        </div>
        <div class="mr-field">
          <span class="mr-field__label">Parallel downloads</span>
          <NumInput key="concurrentDownloads" min={1} max={6} />
        </div>
        <div class="mr-field">
          <span class="mr-field__label">Fragments per download</span>
          <NumInput key="concurrentFragments" min={1} max={16} />
        </div>
      </div>
      <Toggle key="embedMetadata" label="Embed metadata in the file" />
      <Toggle key="embedThumbnail" label="Embed the poster frame" />
      <Toggle key="embedChapters" label="Embed chapters" />
      <Toggle key="writeSubs" label="Download subtitles by default" />
      <Row label="Subtitle languages"><TextInput key="subLangs" placeholder="en,en-GB" /></Row>
      <Row label="SponsorBlock segments to remove"
        hint="Blank disables it. Applies to every download; the Video view can also set it per clip.">
        <TextInput key="sponsorblockRemove" placeholder="sponsor,selfpromo,interaction" />
      </Row>
      <Row label="Filename template"
        hint="yt-dlp output template. The extension is appended automatically.">
        <TextInput key="filenameTemplate" placeholder="%(title)s [%(id)s]" />
      </Row>
      <Toggle key="restrictFilenames" label="Restrict filenames to ASCII"
        hint="Useful if your storage or NLE chokes on unicode filenames." />
    </Panel>
  );
}

function PremierePanel() {
  const seq = () => state.sequence;
  return (
    <Panel title="Premiere"
      badge={<Badge text={state.host.connected ? 'connected' : 'no host'}
        kind={state.host.connected ? 'ok' : 'mute'} />}>
      <Row label="Project bin name"
        hint="Downloads are imported into this bin, colour-coded by licence verdict.">
        <TextInput key="binName" placeholder="MediaRade" />
      </Row>
      <Toggle key="autoImport" label="Import to the project as soon as a download finishes" />
      <Toggle key="selectAfterInsert" label="Select the clip after inserting" />
      <div class="mr-optgrid" style={{ marginBottom: '12px' }}>
        <div class="mr-field">
          <span class="mr-field__label">Default insert mode</span>
          <Select options={[{ value: 'overwrite', label: 'Overwrite' }, { value: 'insert', label: 'Insert (ripple)' }]}
            value={Config.get('defaultInsertMode')}
            onChange={(v) => Config.set('defaultInsertMode', v)} />
        </div>
        <div class="mr-field">
          <span class="mr-field__label">Default drop point</span>
          <Select options={[{ value: 'playhead', label: 'Playhead' }, { value: 'end', label: 'Sequence end' }, { value: 'inpoint', label: 'Sequence in point' }]}
            value={Config.get('defaultDropTarget')}
            onChange={(v) => Config.set('defaultDropTarget', v)} />
        </div>
        <div class="mr-field">
          <span class="mr-field__label">Default video track</span>
          <NumInput key="defaultVideoTrack" min={1} max={16} />
        </div>
        <div class="mr-field">
          <span class="mr-field__label">Default audio track</span>
          <NumInput key="defaultAudioTrack" min={1} max={16} />
        </div>
      </div>
      <div class="ps2-caption" innerHTML={seq()
        ? 'Active sequence <b>' + U.esc(seq().name) + '</b> has ' + seq().videoTracks + ' video and ' +
          seq().audioTracks + ' audio tracks.'
        : 'No sequence is open. If you drop media with no sequence, MediaRade asks Premiere to build one from the clip.'} />
    </Panel>
  );
}

function StoragePanel() {
  const stats = Library.stats();
  return (
    <Panel title="Storage">
      <div class="mr-meta-grid" style={{ marginBottom: '10px' }}>
        <dt>Root</dt><dd>{Paths.dir('root')}</dd>
        <dt>Video</dt><dd>{Paths.dir('video')}</dd>
        <dt>Audio</dt><dd>{Paths.dir('audio')}</dd>
        <dt>Compliance</dt><dd>{Paths.dir('compliance')}</dd>
        <dt>On disk</dt><dd>{stats.count + ' items · ' + U.bytes(stats.bytes)}</dd>
      </div>
      <div class="ps2-row-gap ps2-wrap">
        <Btn size="sm" variant="primary" label="Open MediaRade folder"
          onClick={() => CEP.openFolder(Paths.dir('root'))} />
        <Btn size="sm" label="Open downloads" onClick={() => CEP.openFolder(Paths.dir('downloads'))} />
        <Btn size="sm" label="Open logs" onClick={() => CEP.openFolder(Paths.dir('logs'))} />
        <Btn size="sm" variant="ghost" label="Prune missing" onClick={() => {
          const n = Library.prune();
          Toast.info('Pruned', n ? n + ' entries whose files were gone.' : 'Every library entry still has its file.');
        }} />
      </div>
    </Panel>
  );
}

function DiagnosticsPanel() {
  let out;

  function log(s) { if (out) out.textContent = s; }

  return (
    <Panel title="Diagnostics">
      <div class="ps2-row-gap ps2-wrap" style={{ marginBottom: '10px' }}>
        <Btn size="sm" label="Test Premiere link" onClick={() => {
          Premiere.call('ping').then(function (d) {
            return Premiere.call('getState').then(function (s) {
              log('Premiere link OK\n' + JSON.stringify(d, null, 2) + '\n\nState:\n' + JSON.stringify(s, null, 2));
            });
          }).catch(function (e) { log('Premiere link FAILED\n' + e.message); });
        }} />
        <Btn size="sm" label="Test yt-dlp" onClick={() => {
          if (!YtDlp.ready()) { log('yt-dlp not found.'); return; }
          log('Running…');
          YtDlp.probeVersion().then(function (v) {
            log('yt-dlp ' + (v || 'unknown') + '\nPath: ' + YtDlp.ytdlp + '\nffmpeg: ' + (YtDlp.ffmpeg || 'missing'));
          });
        }} />
        <Btn size="sm" label="Test search filter" onClick={() => {
          // Compare like-for-like: the published reference value carries the
          // Creative Commons flag and nothing else, so the probe must too.
          const bare = SP.build({ features: { creativeCommons: true }, type: 'any' });
          const ccVideo = SP.build({ features: { creativeCommons: true }, type: 'video' });
          const combo = SP.build({ sort: 'views', duration: 'short', uploaded: 'year',
            type: 'video', features: { creativeCommons: true, hd: true } });
          log('Creative Commons only   : ' + bare +
            (bare === SP.CC_ONLY ? '   [matches YouTube reference ✓]' : '   [MISMATCH — expected ' + SP.CC_ONLY + ']') +
            '\nCC + videos only        : ' + ccVideo +
            '\nCombined example        : ' + combo +
            '\n\nURL actually sent to yt-dlp:\n' +
            SP.url('royalty free b-roll', { features: { creativeCommons: true }, type: 'video' }));
        }} />
        <Btn size="sm" label="Test risk checker" onClick={() => {
          const trap = License.evaluate({
            id: 'TESTTESTTES', title: 'ROYALTY FREE Cinematic B-Roll — No Copyright!',
            channel: 'Example Uploads',
            description: 'Free to use in any project! Music by Some Artist. (c) 2024 Example. Do not reupload.',
            license: 'Standard YouTube License'
          });
          const clean = License.evaluate({
            id: 'TESTTESTTE2', title: 'City timelapse', channel: 'Real Creator',
            description: 'Shot on my own camera.',
            license: 'Creative Commons Attribution license (reuse allowed)',
            channel_is_verified: true
          });
          const tb = License.blocked(trap), cb = License.blocked(clean);
          log('TRAP CASE  ("royalty free" text + Standard licence)\n' +
            '  level     : ' + trap.level + '  (risk ' + trap.score + ')\n' +
            '  allow()   : ' + License.allow(trap) + '   blocked(): ' + tb.allowed +
            '  hard=' + tb.hard + '\n' +
            '  reasons   : ' + trap.gate.reasons.join(' | ') + '\n\n' +
            'CLEAN CASE (genuine CC BY)\n' +
            '  level     : ' + clean.level + '  (risk ' + clean.score + ')\n' +
            '  allow()   : ' + License.allow(clean) + '   blocked(): ' + cb.allowed + '\n' +
            '  attribution: ' + (clean.attribution ? clean.attribution.plain : 'none'));
        }} />
        <Btn size="sm" label="Paths" onClick={() => {
          log(['root       ' + Paths.dir('root'),
            'video      ' + Paths.dir('video'),
            'audio      ' + Paths.dir('audio'),
            'compliance ' + Paths.dir('compliance'),
            'config     ' + Paths.file('config'),
            'ledger     ' + Paths.file('ledger'),
            'exists?    ' + Paths.exists(Paths.dir('root'))].join('\n'));
        }} />
      </div>
      <pre ref={out} class="mr-attrib"
        style={{ whiteSpace: 'pre-wrap', maxHeight: '190px', overflow: 'auto', margin: 0 }}
        textContent="Run a check to see results here." />
    </Panel>
  );
}

function AboutPanel(props) {
  const [showBoot] = useConfig('showBoot');
  const [ambientMotion] = useConfig('ambientMotion');
  return (
    <Panel title="About">
      <div style={{ fontSize: '11px', lineHeight: '1.7', color: 'var(--ps2-text-secondary)' }} innerHTML={
        '<b style="color:var(--ps2-ash)">MediaRade 1.0.0</b> — by rad1x.<br>' +
        'A YouTube acquisition panel for Premiere Pro with strict, evidence-based licence verification.<br><br>' +
        'Interface built on a vanilla CSS port of <a href="https://github.com/Timmy-Lane/ps2ui">PS2UI</a> (MIT), ' +
        'retinted to a black-and-red ramp. No Sony assets are used; PlayStation and PlayStation 2 are ' +
        'trademarks of Sony Interactive Entertainment.<br><br>' +
        'Downloading is powered by <b>yt-dlp</b> and <b>ffmpeg</b>, which are not bundled — install them yourself. ' +
        'Respect YouTube\'s Terms of Service and the rights of creators. MediaRade records what YouTube ' +
        'reported; it does not grant rights and it is not legal advice.'} />
      <div class="ps2-hr" />
      <div class="ps2-row-gap ps2-wrap">
        <div style={{ marginBottom: '8px' }}>
          <Switch label="Boot animation" on={showBoot()} onChange={(on) => Config.set('showBoot', on)} />
        </div>
        <div style={{ marginBottom: '8px' }}>
          <Switch label="Ambient motion" on={ambientMotion()}
            onChange={(on) => { Config.set('ambientMotion', on); Ambient.toggle(on); }} />
        </div>
      </div>
      <div style={{ height: '10px' }} />
      <Btn size="sm" variant="danger" label="Reset all settings" onClick={() => {
        Modal.confirm({
          title: 'Reset settings',
          body: 'Restore every setting to its default? Your downloads, library and ledger are untouched.',
          danger: true, okLabel: 'Reset'
        }).then(function (yes) {
          if (!yes) return;
          Config.reset();
          Toast.ok('Settings reset', 'Strict mode is back on.');
          props.onReset();
        });
      }} />
    </Panel>
  );
}

/* --- view ------------------------------------------------------------------ */

/* --- uppbeat --------------------------------------------------------------- */

function EndpointsEditor() {
  let ta;
  onMount(function () {
    const cur = Config.get('uppbeatEndpoints');
    ta.value = cur ? JSON.stringify(cur, null, 2) : JSON.stringify(Uppbeat.DEFAULT_ENDPOINTS, null, 2);
  });

  function save() {
    const raw = ta.value.trim();
    if (!raw) { Config.set('uppbeatEndpoints', null); return; }
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
      Config.set('uppbeatEndpoints', parsed);
      Toast.ok('Endpoints saved', 'Uppbeat will use these paths from now on.');
    } catch (e) {
      Toast.err('Not saved', 'That is not valid JSON: ' + e.message);
    }
  }

  function resetEndpoints() {
    Config.set('uppbeatEndpoints', null);
    ta.value = JSON.stringify(Uppbeat.DEFAULT_ENDPOINTS, null, 2);
    Toast.info('Endpoints reset', 'Back to the shipped defaults.');
  }

  return (
    <Row label="API endpoints (advanced)"
      hint="Uppbeat's API is undocumented. If a search or download breaks with a 404, the path has moved — edit these (JSON) and press <b>Save</b>.">
      <textarea ref={ta} class="ps2-input" rows="5" spellcheck={false}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'Consolas, monospace', fontSize: '11px' }} />
      <div class="ps2-row-gap" style={{ marginTop: '6px' }}>
        <Btn size="sm" variant="primary" label="Save" onClick={save} />
        <Btn size="sm" variant="ghost" label="Reset to defaults" onClick={resetEndpoints} />
      </div>
    </Row>
  );
}

function UppbeatPanel() {
  const [browser] = useConfig('uppbeatBrowser');
  const s = Uppbeat.loadSession();
  const [signedIn, setSignedIn] = createSignal(!!s.signedIn);
  const [plan, setPlan] = createSignal(s.plan || 'free');

  Bus.on('uppbeat:session', function () {
    const cur = Uppbeat.session();
    setSignedIn(!!cur.signedIn);
    setPlan(cur.plan || 'free');
  });

  const premium = () => signedIn() && ['free', 'none'].indexOf(String(plan()).toLowerCase()) === -1;

  return (
    <Panel title="Uppbeat"
      badge={<Badge text={signedIn() ? (premium() ? 'premium · ' + plan() : 'free plan') : 'signed out'}
        kind={signedIn() ? (premium() ? 'ok' : 'warn') : 'mute'} />}>

      <div class="mr-claimwarn" style={{ marginBottom: '10px' }}>
        <span>ⓘ</span>
        <span innerHTML={
          'MediaRade never sees your Uppbeat password. You sign in at uppbeat.io in your own browser and ' +
          'MediaRade imports only the <b>uppbeat.io</b> session cookies — nothing from any other site is kept.'} />
      </div>

      <Toggle key="uppbeatEnabled" label="Show the Uppbeat tab" />

      <Row label="Sign in with this browser"
        hint={'Which browser holds your uppbeat.io session. <b>Sign in</b> opens the site there and MediaRade watches ' +
              'for the session. Chrome and Edge v127+ encrypt their cookies (App-Bound Encryption) and only release ' +
              'them when fully closed — a Firefox-family browser (Firefox, r3dfox, LibreWolf, Waterfox) is read ' +
              'while open, so it is the smoothest choice.'}>
        <Select options={Uppbeat.BROWSERS.map((b) => ({ value: b.id, label: b.label }))}
          value={browser()} onChange={(v) => Config.set('uppbeatBrowser', v)} />
      </Row>

      <Show when={(Uppbeat.BROWSERS.find((b) => b.id === browser()) || {}).family === 'fox'}>
        <Row label="Custom profile folder (optional)"
          hint="Only needed for portable / homebrew Firefox builds that keep their profile away from the normal location. \
                Leave blank to auto-detect. The chosen folder should be the one containing <code>profiles.ini</code>.">
          <TextInput key="uppbeatProfilePath" placeholder="e.g. D:\\r3dfox\\Profiles" />
        </Row>
      </Show>

      <div class="ps2-row-gap ps2-wrap" style={{ marginBottom: '10px' }}>
        <Btn size="sm" variant="primary" label="Sign in"
          title="Opens uppbeat.io in your browser and picks the session up automatically"
          onClick={() => {
            const n = Toast.show({ kind: 'info', title: 'Waiting for the browser…',
              text: 'Sign in at uppbeat.io — MediaRade will pick the session up automatically.', sticky: true });
            Uppbeat.signIn().then(function (cur) {
              n.close();
              setSignedIn(true); setPlan(cur.plan || 'free');
              Toast.ok('Signed in to Uppbeat', 'Plan: ' + (cur.plan || 'free'));
            }).catch(function (e) { n.close(); if (!e.cancelled) Toast.err('Sign-in failed', e.message); });
          }} />
        <Show when={signedIn()}>
          <Btn size="sm" variant="ghost" label="Sign out"
            onClick={() => { Uppbeat.clearSession(); setSignedIn(false); setPlan('free'); Toast.info('Signed out', 'Uppbeat session cleared.'); }} />
        </Show>
      </div>

      <Row label="Watch folder for assisted ingest"
        hint="Blank uses %USERPROFILE%\\Downloads — where your browser puts Uppbeat downloads.">
        <TextInput key="uppbeatWatchDir" placeholder="blank = your Downloads folder" />
      </Row>

      <Row label="Results per search"><NumInput key="uppbeatResultCount" min={10} max={100} /></Row>

      <EndpointsEditor />

      <div class={'mr-claimwarn' + (premium() ? ' mr-claimwarn--ok' : '')}>
        <span>{premium() ? '✓' : '⚠'}</span>
        <span innerHTML={premium()
          ? 'Premium plan detected. MediaRade still records the credit and the licence sidecar for every download.'
          : '<b>On the free plan the artist credit is mandatory.</b> Every download must show its Uppbeat credit ' +
            'wherever the track is used, or the licence does not apply. MediaRade writes it to ' +
            '<code>attribution.txt</code> and <code>CREDITS.md</code> and puts a <b>Copy credit</b> button on every track.'} />
      </div>
    </Panel>
  );
}

export function SettingsView() {
  const [tick, setTick] = createSignal(0);

  return (
    <div class="mr-view__body">
      <For each={[tick()]}>
        {() => (
          <>
            <LicensingPanel />
            <ToolsPanel />
            <UppbeatPanel />
            <DownloadsPanel />
            <PremierePanel />
            <StoragePanel />
            <DiagnosticsPanel />
            <AboutPanel onReset={() => setTick((t) => t + 1)} />
          </>
        )}
      </For>
    </div>
  );
}

export default SettingsView;
