// Feature use read from the host's timeline state, which the relay validates
// and forwards anyway (extension/timeline.js): alignment, Play/Pause/Seek by
// who triggered them, realignment, interruptions, buffering and time played.
// Only the counters change; the room keeps its latest state until it closes.
export const FEATURE_LIMITS = Object.freeze({
  seekSeconds: 1.5, // a position jump that playback does not explain
  playingGapMs: 10_000 // hosts publish every second; a longer silence is not counted as played time
});

const actor = state => ['host', 'guest'].find(role => state.acknowledgedIntents?.[role]?.revision === state.revision) || 'other';

/** `state` is a normalized, valid host state (extension/protocol.js). */
export function observeHostState(room, state, now, counters) {
  const previous = room.timeline;
  room.timeline = { epoch: state.epoch, revision: state.revision, phase: state.phase, wantsPlay: state.wantsPlay,
    playing: state.playing, waiting: state.waiting, position: state.position, at: state.at, seen: now };
  if (state.phase === 'synced' && !room.aligned) { room.aligned = true; counters.rooms.aligned++; }
  if (state.playing && !room.played) { room.played = true; counters.rooms.played++; }
  if (!previous) return;
  if (previous.playing) counters.playingMs += Math.max(0, Math.min(now - previous.seen, FEATURE_LIMITS.playingGapMs));
  // Keepalive; buffering changes `playing` and `waiting` without a new revision.
  if (state.epoch === previous.epoch && state.revision === previous.revision && state.playing === previous.playing && state.waiting === previous.waiting) return;
  if (previous.phase === 'aligning' && state.phase === 'synced') counters.sync.alignments++;
  // A new epoch is a reset to alignment (Timeline.reset) or an interruption that keeps the scene (Timeline.suspend).
  if (state.epoch !== previous.epoch && previous.phase === 'synced') counters.sync[state.phase === 'aligning' ? 'realignments' : 'interruptions']++;
  if (state.phase !== 'synced' || previous.phase !== 'synced' || state.epoch !== previous.epoch) return;
  if (state.waiting && !previous.waiting) counters.sync.bufferingWaits++;
  const by = actor(state);
  if (state.wantsPlay !== previous.wantsPlay) counters.controls[state.wantsPlay ? 'play' : 'pause'][by]++;
  else {
    const expected = previous.position + (previous.playing ? Math.max(0, state.at - previous.at) / 1000 : 0);
    if (Math.abs(state.position - expected) > FEATURE_LIMITS.seekSeconds) counters.controls.seek[by]++;
  }
}
