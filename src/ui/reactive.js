/* =============================================================================
   reactive.js — tiny Solid bindings for the non-store state (Config, events).
   MediaRade by sgtsilicon
   ========================================================================== */
import { createSignal, onCleanup } from 'solid-js';
import Bus from '../core/bus.js';
import Config from '../core/config.js';

/**
 * A reactive signal mirroring a Config key. Config.set() emits a 'config'
 * event carrying the patch, which keeps this in step with external writes.
 */
export function useConfig(key) {
  const [get, set] = createSignal(Config.get(key));
  const off = Bus.on('config', function (patch) {
    if (key in patch) set(patch[key]);
  });
  onCleanup(off);
  return [get, set];
}

/**
 * Subscribe to a Bus event and expose the latest payload as a signal.
 * @param {string} evt
 * @param {Function} pick  (args...) => value
 */
export function useBusValue(evt, initial, pick) {
  const [get, set] = createSignal(initial);
  const off = Bus.on(evt, function () {
    const v = pick ? pick.apply(null, arguments) : arguments[0];
    set(v);
  });
  onCleanup(off);
  return get;
}
