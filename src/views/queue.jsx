/* =============================================================================
   views/queue.jsx — download queue. MediaRade by siliconran
   ========================================================================== */
import { For, Show, createMemo } from 'solid-js';
import Bus, { state } from '../core/bus.js';
import Queue from '../core/queue.js';
import Library from '../core/library.js';
import Premiere from '../core/premiere.js';
import U from '../core/util.js';
import { CEP } from '../core/cep.js';
import Acquire from '../ui/acquire.js';
import DnD from '../ui/dragdrop.js';
import Toast from '../ui/toast.js';
import Place from '../ui/place.js';
import { Badge, Btn, Empty, LicenseBadge, Progress } from '../ui/components.jsx';

export function QueueView() {
  const counts = createMemo(function () {
    const c = { queued: 0, running: 0, done: 0, error: 0, canceled: 0 };
    state.jobs.forEach(function (j) { c[j.state] = (c[j.state] || 0) + 1; });
    c.active = c.queued + c.running;
    return c;
  });

  function importMedia() {
    Premiere.pickMedia().then(function (res) {
      const files = (res && res.files) || [];
      if (!files.length) return;
      let ok = 0;
      files.forEach(function (f) {
        try {
          Library.addManual(f);
          ok++;
        } catch (e) { Toast.err('Import failed', e.message); }
      });
      Toast.ok('Imported', ok + ' file(s) added to the media library.');
    }).catch(function (e) { Toast.err('Import failed', e.message); });
  }

  return (
    <div>
      <div class="mr-view__toolbar">
        <div class="ps2-row-gap ps2-wrap">
          <Badge text={counts().running + ' running'} kind={counts().running ? 'info' : 'mute'} />
          <Badge text={counts().queued + ' queued'} kind="mute" />
          <Badge text={counts().done + ' done'} kind={counts().done ? 'ok' : 'mute'} />
          {counts().error ? <Badge text={counts().error + ' failed'} kind="crit" /> : null}
          <span class="ps2-panel__spacer" style={{ flex: 1 }} />
          <Btn size="sm" label="Import media…"
            title="Pick local video/audio files to add to the media library without downloading"
            onClick={importMedia} />
          <Btn size="sm" label="Clear finished" onClick={() => Queue.clearFinished()} />
          {counts().active ? (
            <Btn size="sm" variant="danger" label="Stop all"
              onClick={() => { Queue.cancelAll(); Toast.info('Stopped', 'All active downloads were cancelled.'); }} />
          ) : null}
        </div>
      </div>

      <div class="mr-view__body">
        <Show
          when={state.jobs.length > 0}
          fallback={
            <Empty title="The queue is empty"
              hint="Downloads you start from <b>Browse</b> or <b>Video</b> appear here with live progress." />
          }
        >
          <div>
            <For each={state.jobs}>
              {(job) => <JobRow job={job} />}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

function JobRow(props) {
  const job = () => props.job;

  const isRunning = () => job().state === 'running';
  const indeterminate = () => isRunning() &&
    (job().percent === null || job().percent === undefined || job().phase === 'processing');

  const stats = createMemo(function () {
    const j = job();
    if (j.state === 'running') {
      const bits = [];
      if (j.phase && j.phase !== 'processing') bits.push(j.phase + '…');
      else if (j.phase === 'processing') bits.push('post-processing…');
      if (j.percent) bits.push(j.percent.toFixed(1) + '%');
      if (j.total) bits.push(U.bytes(j.downloaded || 0) + ' / ' + U.bytes(j.total));
      if (j.speed) bits.push(U.bytes(j.speed) + '/s');
      if (j.eta) bits.push('eta ' + U.hhmmss(j.eta));
      return bits;
    }
    if (j.state === 'done') return [j.file || 'complete'];
    if (j.state === 'error') return [];
    return [j.state];
  });

  const donePayload = createMemo(function () {
    const j = job();
    if (j.state !== 'done' || !j.file) return null;
    const entry = Library.byVideo(j.videoId).filter(function (e) { return e.file === j.file; })[0];
    return entry ? Acquire.payload(entry) : {
      kind: j.kind, title: j.title, file: j.file, report: j.report,
      thumb: j.thumb || (j.videoId ? U.thumb(j.videoId) : null)
    };
  });

  return (
    <div class="mr-job" data-state={job().state} data-id={job().id}>
      <div
        class="mr-job__thumb"
        style={{ backgroundImage: 'url("' + job().thumb + '")' }}
        ref={(el) => DnD.native(el, function () { return donePayload(); })}
        title={job().state === 'done' ? 'Drag the thumbnail onto Premiere\'s timeline — or use Place' : job().title}
      />
      <div class="mr-job__body">
        <div class="ps2-row-gap">
          <span class="ps2-truncate ps2-grow" style={{ fontSize: '12px' }} title={job().title}>{job().title}</span>
          <Badge text={job().kind} kind="mute" />
          {job().override ? <Badge text="override" kind="crit" /> : <LicenseBadge report={job().report} />}
        </div>
        <Progress percent={job().percent || 0} indeterminate={indeterminate()} />
        <div class="mr-job__stats">
          <Show when={job().state === 'error'}>
            <span style={{ color: 'var(--ps2-crit)' }}>{job().error}</span>
          </Show>
          <Show when={job().state !== 'error'}>
            <span class="ps2-truncate" title={job().file || ''}>{stats().join(' · ') || job().state}</span>
          </Show>
        </div>
      </div>
      <div class="ps2-row-gap">
        <JobActions job={job()} />
      </div>
    </div>
  );
}

function JobActions(props) {
  const job = () => props.job;

  if (job().state === 'running' || job().state === 'queued') {
    return <Btn size="sm" variant="danger" label="Stop" onClick={() => Queue.cancel(job().id)} />;
  }

  if (job().state === 'done' && job().file) {
    const entry = Library.byVideo(job().videoId).filter(function (e) { return e.file === job().file; })[0];
    const payload = entry ? Acquire.payload(entry) : {
      kind: job().kind, title: job().title, file: job().file, report: job().report,
      thumb: job().thumb || (job().videoId ? U.thumb(job().videoId) : null)
    };

    return (
      <>
        <div class="mr-grip" style={{ minHeight: '30px' }} title="Drag onto Premiere's timeline or project panel"
          ref={(el) => DnD.native(el, function () { return payload; })} />
        <Btn size="sm" variant="primary" label="Place"
          ref={(el) => DnD.native(el, function () { return payload; })}
          title="Insert at the configured target — or drag this button straight onto Premiere's timeline"
          onClick={() => Place.quick(payload)} />
        <Btn size="sm" label="⤴" title="Reveal in Explorer"
          onClick={() => CEP.revealInExplorer(job().file)} />
      </>
    );
  }

  return (
    <>
      <Btn size="sm" label="Retry" onClick={() => Queue.retry(job().id)} />
      <Btn size="sm" variant="ghost" label="✕" onClick={() => Queue.remove(job().id)} />
    </>
  );
}

export default QueueView;
