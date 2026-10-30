import { BaseDirectory, exists, mkdir, readTextFile, watch, writeTextFile } from '@tauri-apps/plugin-fs';
import type { Stage, Task } from './due';
import { newNoteId, putNote, type Note } from './notes';

// Documents/Pet/pet-tasks.json — Claude writes it, the cat reads it and ticks items off.
const DIR = 'Pet', FILE = 'Pet/pet-tasks.json', base = { baseDir: BaseDirectory.Document };

type TaskFile = { updated?: string; tasks: Task[] };

async function read(): Promise<TaskFile> {
  const data = JSON.parse(await readTextFile(FILE, base));
  if (!Array.isArray(data?.tasks)) throw new Error('pet-tasks.json has no "tasks" list');
  return data;
}

// Calls onChange now and whenever the file changes. A half-written or broken file keeps the last good list.
export async function watchTasks(onChange: (tasks: Task[]) => void) {
  if (!(await exists(FILE, base))) {
    await mkdir(DIR, { ...base, recursive: true });
    await writeTextFile(FILE, JSON.stringify({ updated: new Date().toISOString(), tasks: [] }, null, 2), base);
  }
  const load = () => read().then((d) => onChange(d.tasks), (e) => console.warn('pet-tasks.json not loaded:', e));
  await load();
  // Watch the folder, not the file: editors that save by replacing the file would drop a file watch.
  await watch(DIR, load, { ...base, delayMs: 300 });
}

// Re-reads right before writing so a Claude update since the last load isn't overwritten.
async function change(fn: (tasks: Task[]) => void) {
  const data = await read();
  fn(data.tasks);
  await writeTextFile(FILE, JSON.stringify(data, null, 2) + '\n', base);
}

export const setStage = (id: string, stage: Stage) =>
  change((tasks) => {
    const task = tasks.find((t) => t.id === id);
    if (task) Object.assign(task, { stage, done: stage === 'finished' });
  });

export const addTask = (task: Task) => change((tasks) => void tasks.push(task));

// Notes live in one JSON file next to the tasks, so Claude can read them too.
const NOTES = 'Pet/pet-notes.json', OLD_NOTES = 'Pet/pet-notes.md';

export async function loadNotes(): Promise<Note[]> {
  if (await exists(NOTES, base)) {
    const data = JSON.parse(await readTextFile(NOTES, base));
    if (!Array.isArray(data?.notes)) throw new Error('pet-notes.json has no "notes" list');
    return data.notes;
  }
  // First run after single-page notes: that page becomes the first note (the old file is left as it is).
  const old = (await exists(OLD_NOTES, base)) ? await readTextFile(OLD_NOTES, base) : '';
  return old.trim() ? [{ id: newNoteId(), text: old, updated: new Date().toISOString() }] : [];
}

// Re-reads before writing so an edit made elsewhere to another note isn't lost.
export async function saveNote(note: Note): Promise<Note[]> {
  const notes = putNote(await loadNotes(), note);
  await writeTextFile(NOTES, JSON.stringify({ notes }, null, 2) + '\n', base);
  return notes;
}
