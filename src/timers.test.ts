import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUse, clock, IDLE, startFocus, tick } from './timers.ts';

const MIN = 60_000;

test('focus runs 25 min, then a 5 min break, then stops', () => {
  let f = startFocus(IDLE, 0);
  assert.equal(f.phase, 'focus');
  assert.deepEqual(tick(f, 24 * MIN).ended, null);
  let r = tick(f, 25 * MIN);
  assert.equal(r.ended, 'focus');
  f = r.focus;
  assert.equal(f.phase, 'break');
  assert.equal(f.endsAt, 30 * MIN); // break counts from when focus ended, not from the late tick
  r = tick(f, 31 * MIN);
  assert.equal(r.ended, 'break');
  assert.equal(r.focus.phase, 'idle');
});

test('a 50 min focus gets a 10 min break', () => {
  const f = startFocus(IDLE, 0, 50);
  assert.equal(tick(f, 50 * MIN).focus.endsAt, 60 * MIN);
});

test('clock', () => {
  assert.equal(clock(25 * MIN), '25:00');
  assert.equal(clock(61_001), '1:02');
  assert.equal(clock(-5), '0:00');
});

test('nudge after an hour of continuous use, not before; an idle gap resets it', () => {
  const t0 = 1000;
  let { use } = checkUse({ activeSince: 0, nudgedAt: 0 }, t0, 0); // first check starts the clock
  assert.equal(checkUse(use, t0 + 59 * MIN, 1000).nudge, false);
  const r = checkUse(use, t0 + 60 * MIN, 1000);
  assert.equal(r.nudge, true);
  use = r.use;
  assert.equal(checkUse(use, t0 + 61 * MIN, 1000).nudge, false); // not again right away
  assert.equal(checkUse(use, t0 + 120 * MIN, 1000).nudge, true); // an hour after the last nudge
  const reset = checkUse(use, t0 + 70 * MIN, 6 * MIN); // away 6 min = took a break
  assert.equal(reset.nudge, false);
  assert.equal(checkUse(reset.use, t0 + 129 * MIN, 0).nudge, false);
});
