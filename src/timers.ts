// Focus timer and stretch nudges: plain state, no I/O, so they can be tested with `npm test`.

export type Phase = 'idle' | 'focus' | 'break';
export type Focus = { phase: Phase; endsAt: number; focusMin: number; breakMin: number };

const MIN = 60_000;
export const IDLE: Focus = { phase: 'idle', endsAt: 0, focusMin: 25, breakMin: 5 };

export const startFocus = (f: Focus, now: number, focusMin = f.focusMin): Focus => ({
  ...f,
  phase: 'focus',
  focusMin,
  breakMin: focusMin >= 50 ? 10 : 5,
  endsAt: now + focusMin * MIN,
});

// Move on when the current part is over: focus → break → idle. `ended` says which part just finished.
export function tick(f: Focus, now: number): { focus: Focus; ended: Phase | null } {
  if (f.phase === 'idle' || now < f.endsAt) return { focus: f, ended: null };
  if (f.phase === 'focus') return { focus: { ...f, phase: 'break', endsAt: f.endsAt + f.breakMin * MIN }, ended: 'focus' };
  return { focus: { ...f, phase: 'idle', endsAt: 0 }, ended: 'break' };
}

// "12:05"
export const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Stretch nudges: count time in continuous use; 5 minutes idle counts as a break and resets it.
export type Use = { activeSince: number; nudgedAt: number };
export const NUDGE_AFTER = 60 * MIN, BREAK_IDLE = 5 * MIN;

export function checkUse(u: Use, now: number, idleMs: number): { use: Use; nudge: boolean } {
  if (idleMs >= BREAK_IDLE || !u.activeSince) return { use: { activeSince: now, nudgedAt: 0 }, nudge: false };
  const since = Math.max(u.activeSince, u.nudgedAt);
  return now - since >= NUDGE_AFTER ? { use: { ...u, nudgedAt: now }, nudge: true } : { use: u, nudge: false };
}
