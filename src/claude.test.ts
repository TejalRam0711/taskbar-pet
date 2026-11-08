import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySignal } from './claude.ts';

test('a prompt waits until its own tool finishes, whatever else finishes first', () => {
  const waiting = new Set<string>();
  assert.equal(applySignal(waiting, ['up', 'a', 'AskUserQuestion']), true);
  assert.equal(applySignal(waiting, ['up', 'a', 'AskUserQuestion']), false); // two hooks fire for one question
  applySignal(waiting, ['down', 'a', 'Agent']); // started alongside it
  applySignal(waiting, ['down', 'a', 'Glob']); // a subagent's
  applySignal(waiting, ['down', 'b', 'AskUserQuestion']); // another session's
  assert.equal(waiting.size, 1);
  applySignal(waiting, ['down', 'a', 'AskUserQuestion']);
  assert.equal(waiting.size, 0);
});

test('the fallback notification adds no second alert and goes with the tool', () => {
  const waiting = new Set<string>();
  applySignal(waiting, ['up', 'a', 'Bash']);
  assert.equal(applySignal(waiting, ['up', 'a']), false);
  applySignal(waiting, ['down', 'a', 'Bash']);
  assert.equal(waiting.size, 0);
});

test('each session alerts on its own', () => {
  const waiting = new Set<string>();
  assert.equal(applySignal(waiting, ['up', 'a', 'Bash']), true);
  assert.equal(applySignal(waiting, ['up', 'b', 'Bash']), true);
  applySignal(waiting, ['clear', 'a']);
  assert.deepEqual([...waiting], ['b Bash']);
});

test('a closing question outlasts the end of the turn, until you reply', () => {
  const waiting = new Set<string>();
  applySignal(waiting, ['up', 'a', 'asked']);
  applySignal(waiting, ['stop', 'a']);
  applySignal(waiting, ['down', 'a', 'Bash']);
  assert.equal(waiting.size, 1);
  applySignal(waiting, ['clear', 'a']);
  assert.equal(waiting.size, 0);
});

test('the end of a turn drops a prompt that was never answered', () => {
  const waiting = new Set<string>();
  applySignal(waiting, ['up', 'a', 'Bash']);
  applySignal(waiting, ['stop', 'a']);
  assert.equal(waiting.size, 0);
});
