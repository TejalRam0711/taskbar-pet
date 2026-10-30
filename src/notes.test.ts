import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byUpdated, newNoteId, noteTitle, putNote, type Note } from './notes.ts';

const note = (id: string, text: string, updated = '2026-10-29T10:00:00Z'): Note => ({ id, text, updated });

test('noteTitle is the first non-empty line', () => {
  assert.equal(noteTitle(note('a', '\n  Groceries \nmilk\neggs')), 'Groceries');
  assert.equal(noteTitle(note('a', '   \n ')), 'Untitled');
});

test('putNote adds new notes to the top, replaces edited ones, drops emptied ones', () => {
  const list = [note('a', 'A'), note('b', 'B')];
  assert.deepEqual(putNote(list, note('c', 'C')).map((n) => n.id), ['c', 'a', 'b']);
  assert.deepEqual(putNote(list, note('b', 'B2')).map((n) => n.text), ['B2', 'A']);
  assert.deepEqual(putNote(list, note('a', '  ')).map((n) => n.id), ['b']);
  assert.deepEqual(putNote([], note('x', '')), []);
});

test('byUpdated sorts newest first without touching the input', () => {
  const list = [note('old', 'o', '2026-10-01T00:00:00Z'), note('new', 'n', '2026-10-29T00:00:00Z')];
  assert.deepEqual(byUpdated(list).map((n) => n.id), ['new', 'old']);
  assert.equal(list[0].id, 'old');
});

test('newNoteId is stable for a given time', () => {
  assert.equal(newNoteId(new Date(0)), 'n-0');
});
