import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, moodFor, newTask, offsetMs, relDay, stageOf, upcoming, type Task } from './due.ts';

const now = new Date(2026, 9, 29, 13, 0); // Thu 29 Oct 2026, 13:00 local
const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
const H = 3_600_000, D = 24 * H;
const task = (id: string, dueIn: number, extra: Partial<Task> = {}): Task => ({ id, title: id, due: at(dueIn), ...extra });

test('offsetMs', () => {
  assert.equal(offsetMs('1d'), D);
  assert.equal(offsetMs('30m'), 30 * 60_000);
  assert.ok(Number.isNaN(offsetMs('soon')));
});

test('upcoming skips finished and undated tasks, soonest first', () => {
  const list = [
    task('b', 2 * D, { stage: 'in-progress' }),
    task('a', D),
    task('x', H, { done: true }),
    task('z', H, { stage: 'finished' }),
    { id: 'y', title: 'y', due: 'tbd' },
  ];
  assert.deepEqual(upcoming(list).map((t) => t.id), ['a', 'b']);
});

test('stageOf defaults to starting and honours done from older files', () => {
  assert.equal(stageOf(task('a', D)), 'starting');
  assert.equal(stageOf(task('a', D, { stage: 'thinking' })), 'thinking');
  assert.equal(stageOf(task('a', D, { done: true })), 'finished');
  assert.equal(stageOf(task('a', D, { stage: 'bogus' as never })), 'starting');
});

test('newTask makes a unique id and default reminders', () => {
  const t = newTask('  Call the bank!  ', new Date(now.getTime() + D), now);
  assert.match(t.id, /^call-the-bank-[a-z0-9]+$/);
  assert.equal(t.title, 'Call the bank!');
  assert.equal(t.stage, 'starting');
  assert.deepEqual(t.remind, ['1d', '1h']);
});

test('moodFor by time to the next due item', () => {
  assert.equal(moodFor([task('a', 30 * 60_000)], now), 'urgent');
  assert.equal(moodFor([task('a', -H)], now), 'urgent'); // overdue
  assert.equal(moodFor([task('a', 5 * H)], now), 'alert');
  assert.equal(moodFor([task('a', 2 * D)], now), 'idle');
  assert.equal(moodFor([task('a', 4 * D)], now), 'sleep');
  assert.equal(moodFor([], now), 'sleep');
  assert.equal(moodFor([task('a', 2 * D)], new Date(2026, 9, 29, 2, 0)), 'sleep'); // late at night
});

test('dueReminders fires once per task, even when several reminders have passed', () => {
  const t = task('paper', 12 * H, { remind: ['7d', '1d', '1h'] });
  const fired = new Set<string>();
  const out = dueReminders([t], now, fired);
  assert.equal(out.length, 1);
  assert.equal(out[0].keys.length, 2); // 7d and 1d passed, 1h not yet
  out[0].keys.forEach((k) => fired.add(k));
  assert.equal(dueReminders([t], now, fired).length, 0);
  assert.equal(dueReminders([t], new Date(now.getTime() + 11.5 * H), fired).length, 1); // 1h reminder
  assert.equal(dueReminders([t], new Date(now.getTime() + 13 * H), fired).length, 0); // past due: no pre-reminder
});

test('relDay', () => {
  assert.equal(relDay(at(-1), now), 'overdue');
  assert.equal(relDay(at(20 * 60_000), now), 'in 20 min');
  assert.equal(relDay(at(5 * H), now), 'in 5 h');
  assert.equal(relDay(at(D), now), 'tomorrow');
  assert.equal(relDay(at(3 * D), now), 'in 3 days');
});
