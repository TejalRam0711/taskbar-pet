// Notes: plain data, no I/O, so it can be tested with `npm test`.
export type Note = { id: string; text: string; updated: string };

export const newNoteId = (now = new Date()) => `n-${now.getTime().toString(36)}`;

// First line, trimmed, as the note's name in the menu.
export const noteTitle = (n: Note) => n.text.trim().split('\n')[0].trim().slice(0, 60) || 'Untitled';

// Save one note into the list: replace it, or add it to the top. A note saved empty is removed.
export function putNote(list: Note[], note: Note): Note[] {
  const rest = list.filter((n) => n.id !== note.id);
  return note.text.trim() ? [note, ...rest] : rest;
}

// Most recently edited first.
export const byUpdated = (list: Note[]) => [...list].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
