import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, PhysicalPosition, PhysicalSize, primaryMonitor } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { bubbleText, defaultDue, renderList, renderNotes, speech } from './bubble';
import { createCat, type Mover } from './cat';
import { applySignal } from './claude';
import { dueReminders, moodFor, newTask, relDay, shortDate, type Stage, type Task } from './due';
import { byUpdated, newNoteId, type Note } from './notes';
import { addTask, loadNotes, saveNote, setStage, watchTasks } from './tasks';
import { SKINS, type SkinId } from './skins';
import { checkUse, clock, IDLE, startFocus, tick, type Focus, type Use } from './timers';

// The window is a small box around the cat, sitting on the taskbar. It slides along when the cat walks and
// grows up and to the left (bottom-right corner fixed) when the bubble opens. Small matters: WebView2
// redraws the whole window on every animation frame, so a full-width strip cost ~30% of a core per walk.
const COMPACT = { w: 270, h: 110 }, EXPANDED = { w: 460, h: 430 };
const CAT_LEFT = 100; // cat's left edge inside the compact window, leaving room for the hover and z z z bubbles

const win = getCurrentWindow();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const catEl = $('cat'), bubble = $('bubble'), panel = $('panel'), say = $('say'), list = $('list');
const addForm = $<HTMLFormElement>('add'), addTitle = $<HTMLInputElement>('add-title'), addDue = $<HTMLInputElement>('add-due');
const tabTodo = $('tab-todo'), tabNotes = $('tab-notes'), tabFocus = $('tab-focus');
const todoView = $('todo-view'), notesView = $('notes-view'), focusView = $('focus-view');
const focusSay = $('focus-say'), focusClock = $('focus-clock'), focusStart = $('focus-start'), focusStop = $('focus-stop');
const notes = $<HTMLTextAreaElement>('notes'), mic = $('mic'), notesStatus = $('notes-status'), micStatus = $('mic-status');
const notesMenu = $('notes-menu'), notesList = $('notes-list'), notesEmpty = $('notes-empty'), noteEditor = $('note-editor');

let wa = { x: 0, y: 0, w: 0, h: 0 }; // primary screen's work area, physical px
let scale = 1, catX = 0, winW = COMPACT.w; // catX = cat's left edge on screen, CSS px from the work area's left
let home = 0; // where you last put it (same units); it only wanders within ROAM of here
const ROAM = 200;

// Anywhere along the taskbar with the whole window on screen.
const bounds = (): [number, number] => [CAT_LEFT, wa.w / scale - (COMPACT.w - CAT_LEFT)];
const mover: Mover = {
  x: () => catX,
  range: () => [Math.max(bounds()[0], home - ROAM), Math.min(bounds()[1], home + ROAM)],
  async go(to, ms) {
    const arrived = await invoke<boolean>('walk_to', { x: wa.x + Math.round((to - CAT_LEFT) * scale), ms: Math.round(ms) });
    catX = arrived ? to : await catXFromWindow();
    return arrived;
  },
  halt: () => void invoke('halt'),
};
const catXFromWindow = async () => ((await win.outerPosition()).x - wa.x) / scale + CAT_LEFT;
const savedSkin = localStorage.getItem('skin');
let skin: SkinId = savedSkin && savedSkin in SKINS ? (savedSkin as SkinId) : 'black';
const cat = createCat(catEl, mover, skin);
document.body.dataset.skin = skin; // the bubble's ears follow the pet
const chip = catEl.querySelector<HTMLElement>('.chip')!; // part of the cat's markup, so only there now

let tasks: Task[] = [];
let loadError = '';
let snoozedUntil = 0;
let mode: 'todo' | 'notes' | 'focus' = 'todo';
let gameMode = false;
let focus: Focus = loadFocus();

// A focus session survives a restart of the app.
function loadFocus(): Focus {
  try {
    return { ...IDLE, ...JSON.parse(localStorage.getItem('focus') ?? '{}') };
  } catch {
    return IDLE;
  }
}
const fired = new Set<string>(loadFired());

function loadFired(): string[] {
  try {
    return JSON.parse(localStorage.getItem('fired') ?? '[]');
  } catch {
    return [];
  }
}

async function layout(expand: boolean) {
  const { w, h } = expand ? EXPANDED : COMPACT;
  const winX = expand ? Math.max(0, catX + COMPACT.w - CAT_LEFT - w) : catX - CAT_LEFT;
  winW = w;
  catEl.style.visibility = 'hidden'; // hide the frame where the window has moved but not yet resized
  await win.setPosition(new PhysicalPosition(wa.x + Math.round(winX * scale), wa.y + wa.h - Math.round(h * scale)));
  await win.setSize(new PhysicalSize(Math.round(w * scale), Math.round(h * scale)));
  catEl.style.left = `${catX - winX}px`;
  requestAnimationFrame(() => requestAnimationFrame(() => (catEl.style.visibility = '')));
  syncHits();
}

// Speech bubbles sit above the cat's head, kept inside the window, with the tail ending just right of its
// mouth. headAt = the head's x as a fraction of the cat box (sitting 0.67, lying 0.73).
function anchor(box: HTMLElement, headAt: number) {
  const head = parseFloat(catEl.style.left || `${CAT_LEFT}`) + catEl.offsetWidth * headAt;
  const w = box.offsetWidth;
  const left = Math.min(Math.max(head - w / 2, 8), winW - w - 8);
  box.style.left = `${left}px`;
  box.style.setProperty('--tail', `${Math.min(Math.max(head + 14 - left, 24), w - 30)}px`);
  // the open bubble clears the sitting pet's ear tips (a bunny's reach much higher than a cat's)
  if (box === panel) box.style.bottom = `${Math.round(catEl.offsetHeight * (1 - SKINS[skin].earTop / 80)) + 6}px`;
}

// The hover bubble: the focus countdown while a session runs, else the next due item.
function hoverText() {
  const left = clock(focus.endsAt - Date.now());
  if (focus.phase === 'focus') return `Focusing: ${left} left`;
  if (focus.phase === 'break') return `Break: ${left} left`;
  return loadError || bubbleText(tasks);
}

// A short message from the cat in the hover bubble (nudges, "kept it"); stays up for `ms`.
let flashTimer = 0;
function flash(msg: string, ms = 4000) {
  if (!panel.hidden) return;
  bubble.textContent = msg;
  bubble.hidden = false;
  anchor(bubble, 0.7);
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    flashTimer = 0;
    bubble.hidden = true;
    showInputNeeded();
  }, ms);
}

// Claude needs you (claude.ts has who and why): hand up and a bubble until it's over or you click the cat, and
// a small meow, unless the pet is hidden or snoozed, the mic would hear it, or it has only just meowed.
const INPUT_NEEDED = 'Input needed';
const waiting = new Set<string>();
let meowedAt = 0;
function showInputNeeded() {
  if (waiting.size) flash(INPUT_NEEDED, 86_400_000);
}
function claudeChanged() {
  cat.perk(waiting.size > 0 || dragging);
  showInputNeeded();
  if (!waiting.size && bubble.textContent === INPUT_NEEDED) {
    clearTimeout(flashTimer);
    flashTimer = 0;
    bubble.hidden = true;
  }
}
async function meow() {
  if (listening || Date.now() < snoozedUntil || Date.now() - meowedAt < 20_000 || !(await win.isVisible())) return;
  meowedAt = Date.now();
  invoke('play_meow').catch(console.error);
}
listen<string[]>('claude', ({ payload }) => {
  if (applySignal(waiting, payload)) meow();
  claudeChanged();
});
listen<string>('claude-link', ({ payload }) => flash(payload, 6000)); // Menu › Link to Claude: how it went

function refresh() {
  const now = new Date();
  const mood = moodFor(tasks, now);
  cat.setMood(mood === 'urgent' && now.getTime() < snoozedUntil ? 'alert' : mood);
  if (!flashTimer) bubble.textContent = hoverText();
  if (panel.hidden || mode !== 'todo') return;
  say.textContent = loadError || speech(tasks, now);
  renderList(list, tasks, now, onStage);
  anchor(panel, 0.67);
}

function remind() {
  const now = new Date();
  if (now.getTime() < snoozedUntil) return; // held reminders fire when the snooze ends
  const due = dueReminders(tasks, now, fired);
  for (const { task, keys } of due) {
    sendNotification({ title: task.title, body: `Due ${relDay(task.due, now)}, ${shortDate(task.due)}` });
    keys.forEach((k) => fired.add(k));
  }
  if (due.length) localStorage.setItem('fired', JSON.stringify([...fired]));
}

// Optimistic: show the change now, put it back if the file can't be written.
function save(next: Task[], write: Promise<void>, failMsg: string) {
  const before = tasks;
  tasks = next;
  refresh();
  return write.catch((e) => {
    console.error(e);
    tasks = before;
    refresh();
    say.textContent = failMsg;
    throw e;
  });
}

function onStage(id: string, stage: Stage) {
  const next = tasks.map((t) => (t.id === id ? { ...t, stage, done: stage === 'finished' } : t));
  if (stage === 'finished') cat.cheer();
  save(next, setStage(id, stage), "Couldn't save that, try again?").catch(() => {});
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const due = new Date(addDue.value);
  if (!addTitle.value.trim() || Number.isNaN(due.getTime())) return;
  const task = newTask(addTitle.value, due);
  save([...tasks, task], addTask(task), "Couldn't add that one.").then(() => {
    addTitle.value = '';
    addDue.value = defaultDue(new Date());
    cat.cheer();
  }, () => {});
});

// ---- notes: a menu of notes, + starts a new one. A note saves as you type and on Save; saving it empty
// deletes it. The mic dictates into the open note with Windows' speech recogniser. ----

let editing: Note | null = null, dirty = false, saveTimer = 0, listening = false;
let micNote: Note | null = null; // the note the mic was started in
// Words Whisper is still hearing, shown in the note until it's finished them; not saved until then.
let live: { at: number; text: string } | null = null;
const liveShown = () => !!live && notes.value.slice(live.at, live.at + live.text.length) === live.text;

// true if saved (or nothing to save); on failure the note stays open so nothing typed is lost
async function flushNote() {
  clearTimeout(saveTimer);
  if (!editing || !dirty) return true;
  const text = liveShown() ? notes.value.slice(0, live!.at) + notes.value.slice(live!.at + live!.text.length) : notes.value;
  editing = { ...editing, text, updated: new Date().toISOString() };
  if (micNote?.id === editing.id) micNote = editing;
  dirty = false;
  try {
    await saveNote(editing);
    notesStatus.textContent = 'Saved';
    return true;
  } catch (e) {
    console.error(e);
    dirty = true;
    notesStatus.textContent = "Couldn't save!";
    return false;
  }
}

async function showNotesMenu() {
  setListening(false);
  if (!(await flushNote())) return;
  editing = null;
  noteEditor.hidden = true;
  notesMenu.hidden = false;
  try {
    const list = byUpdated(await loadNotes());
    notesEmpty.textContent = 'No notes yet. Press + to start one.';
    notesEmpty.hidden = list.length > 0;
    renderNotes(notesList, list, new Date(), openNote);
  } catch (e) {
    console.error(e);
    notesList.replaceChildren();
    notesEmpty.textContent = "Couldn't open Documents/Pet/pet-notes.json";
    notesEmpty.hidden = false;
  }
  anchor(panel, 0.67);
  syncHits();
}

function openNote(note: Note | null) {
  editing = note ?? { id: newNoteId(), text: '', updated: new Date().toISOString() };
  dirty = false;
  live = null;
  notes.value = editing.text;
  notesStatus.textContent = '';
  micStatus.textContent = '';
  notesMenu.hidden = true;
  noteEditor.hidden = false;
  anchor(panel, 0.67);
  syncHits();
  notes.focus();
  notes.setSelectionRange(notes.value.length, notes.value.length);
}
$('note-new').addEventListener('click', () => openNote(null));
$('note-back').addEventListener('click', showNotesMenu);
$('note-save').addEventListener('click', showNotesMenu);

notes.addEventListener('input', () => {
  cat.scribble();
  dirty = true;
  notesStatus.textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushNote, 700);
});

function micUi(on: boolean, status = on ? 'Listening…' : '') {
  listening = on;
  mic.setAttribute('aria-pressed', String(on));
  mic.classList.toggle('live', on);
  micStatus.textContent = status;
}
function setListening(on: boolean) {
  if (on === listening) return;
  if (on) micNote = editing;
  // Words for Whisper to expect, so names come out spelled your way: your to-dos and the note so far.
  const hint = [...tasks.slice(0, 15).map((t) => t.title), notes.value.slice(0, notes.selectionStart).slice(-200)];
  invoke('dictate', { on, hint: hint.filter(Boolean).join('. ') }).catch(console.error);
  micUi(on);
}
// Esc while dictating: stops, and nothing still being written goes in the note.
function cancelDictation() {
  if (liveShown()) notes.setRangeText('', live!.at, live!.at + live!.text.length, 'end');
  live = null;
  invoke('dictate', { on: false, keep: false }).catch(console.error);
  micUi(false, 'Cancelled');
}
mic.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the note
mic.addEventListener('click', () => {
  notes.focus();
  setListening(!listening);
});
// Heard words as they go after `before`: after a space, or a line break when Whisper starts a new paragraph
// (its words then start with one).
const spaced = (before: string, words: string) =>
  (words && /\S$/.test(before) ? (words.startsWith('\n') ? '\n' : ' ') : '') + words.trimStart();
// Puts words at the caret, as if typed, or in place of the words still being heard if they're still there.
function putHeard(words: string) {
  const at = liveShown() ? live!.at : notes.selectionStart;
  const end = liveShown() ? live!.at + live!.text.length : notes.selectionEnd;
  const text = spaced(notes.value.slice(0, at), words);
  notes.setRangeText(text, at, end, 'end');
  return { at, text };
}
// While you talk, the words so far show at the caret (they can still change); each phrase then lands in their
// place once Whisper has finished it. It finishes the last one after you stop, so if that note is closed by
// then, the phrase is added to the end of it instead of being lost.
listen<string>('dictation-partial', ({ payload }) => {
  if (micNote && editing?.id === micNote.id && payload) live = putHeard(payload);
});
listen<string>('dictation', async ({ payload }) => {
  if (!micNote) return;
  if (editing?.id !== micNote.id) {
    live = null;
    if (!payload) return;
    micNote = { ...micNote, text: micNote.text + spaced(micNote.text, payload), updated: new Date().toISOString() };
    await saveNote(micNote).catch(console.error);
    if (!panel.hidden && mode === 'notes' && !editing) showNotesMenu();
    return;
  }
  if (!payload && !liveShown()) return; // only noise, and nothing shown for it
  putHeard(payload);
  live = null;
  notes.dispatchEvent(new Event('input'));
});
// Stopped by itself: a minute without a phrase, or a failure such as no microphone.
listen<string | null>('dictation-end', ({ payload }) => micUi(false, payload ? `Mic stopped: ${payload}` : ''));

// ---- focus timer: 25 or 50 min at its desk, then a 5 or 10 min nap; a countdown chip sits by the cat ----

let focusMin = focus.focusMin, focusTicker = 0;

function setFocus(f: Focus) {
  focus = f;
  localStorage.setItem('focus', JSON.stringify(f));
  cat.setFocus(f.phase === 'focus' ? 'work' : f.phase === 'break' ? 'nap' : null);
}

function renderFocus() {
  const running = focus.phase !== 'idle';
  const left = clock(focus.endsAt - Date.now());
  chip.hidden = !running;
  chip.textContent = left;
  chip.dataset.phase = focus.phase;
  focusClock.textContent = running ? left : `${focusMin}:00`;
  focusSay.textContent = focus.phase === 'focus' ? "Focusing. I'll be at my desk."
    : focus.phase === 'break' ? 'Break time. Stretch, have some water.' : 'How long shall we focus?';
  focusStart.hidden = running;
  focusStop.hidden = !running;
  focusStop.textContent = focus.phase === 'break' ? 'Skip break' : 'Stop';
  for (const b of focusView.querySelectorAll<HTMLButtonElement>('[data-min]')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.min) === focusMin));
    b.disabled = running;
  }
  if (!flashTimer) bubble.textContent = hoverText();
}

// Once a second while a session runs (a single small repaint), otherwise not at all.
function focusTick() {
  const before = focus;
  const { focus: next, ended } = tick(focus, Date.now());
  const fresh = Date.now() - before.endsAt < 120_000; // don't announce parts that ended while the app was closed
  if (ended === 'focus' && fresh) {
    sendNotification({ title: 'Focus done', body: `Take ${before.breakMin} minutes. I'll nap too.` });
  }
  if (ended === 'break' && fresh) {
    sendNotification({ title: "Break's over", body: 'Ready for another round?' });
    cat.nudge();
  }
  if (next !== before) setFocus(next);
  renderFocus();
  if (focus.phase === 'idle') {
    clearInterval(focusTicker);
    focusTicker = 0;
  } else if (!focusTicker) focusTicker = window.setInterval(focusTick, 1000);
}

for (const b of focusView.querySelectorAll<HTMLButtonElement>('[data-min]')) {
  b.addEventListener('click', () => {
    focusMin = Number(b.dataset.min);
    renderFocus();
  });
}
focusStart.addEventListener('click', () => {
  setFocus(startFocus(focus, Date.now(), focusMin));
  focusTick();
});
focusStop.addEventListener('click', () => {
  setFocus({ ...focus, phase: 'idle', endsAt: 0 });
  focusTick();
});

// ---- drop to save: text, a link or files dropped on the cat (or its bubble) become a note ----

let dragging = false;
const intoField = (e: DragEvent) => e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
function dragOver(on: boolean) {
  if (on === dragging) return;
  dragging = on;
  cat.perk(on || waiting.size > 0);
  if (on) flash("Drop it on me, I'll keep it as a note", 60_000);
  else if (flashTimer) flash('', 0);
}
document.addEventListener('dragover', (e) => {
  if (intoField(e)) return; // dropping into a note or the to-do box works as normal
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
  dragOver(true);
});
document.addEventListener('dragleave', (e) => !e.relatedTarget && dragOver(false)); // left the window
document.addEventListener('drop', async (e) => {
  if (intoField(e)) return;
  e.preventDefault();
  cat.caught();
  dragOver(false);
  const dt = e.dataTransfer!;
  const text = dt.getData('text/plain').trim();
  const url = dt.getData('text/uri-list').split(/\r?\n/).find((l) => l && !l.startsWith('#'))?.trim();
  // Web views only get file names, not where the files are.
  const files = [...dt.files].map((f) => f.name);
  const body = [text, url && url !== text ? url : '', files.length ? `Files: ${files.join(', ')}` : '']
    .filter(Boolean).join('\n');
  if (!body) return;
  try {
    await saveNote({ id: newNoteId(), text: body, updated: new Date().toISOString() });
    cat.cheer();
    flash('Kept it in your notes');
    if (!panel.hidden && mode === 'notes' && !editing) showNotesMenu();
  } catch (err) {
    console.error(err);
    flash("Couldn't save that");
  }
});

// ---- stretch nudges: after an hour of use with no 5-minute break, the cat sits up and says so ----

let use: Use = { activeSince: 0, nudgedAt: 0 }, nudgeNo = 0;
const NUDGES = ['Stretch break! Stand up a minute.', 'Time for a glass of water.', 'Rest your eyes: look far away.'];

async function checkStretch() {
  const now = Date.now();
  if (focus.phase !== 'idle') {
    use = { activeSince: now, nudgedAt: 0 }; // the focus break covers it
    return;
  }
  const r = checkUse(use, now, await invoke<number>('idle_ms'));
  if (r.nudge && gameMode) return; // hold it until the game is over
  use = r.use;
  if (!r.nudge) return;
  const msg = NUDGES[nudgeNo++ % NUDGES.length];
  sendNotification({ title: 'A word from your cat', body: msg });
  cat.nudge();
  flash(msg, 8000);
}

// ---- low battery: under 20% and not charging, the cat yawns and asks for the charger, once per discharge ----

type Battery = EventTarget & { level: number; charging: boolean };
let battery: Battery | undefined, batteryWarned = false;

function checkBattery() {
  if (!battery || battery.charging || battery.level > 0.2) return void (batteryWarned = false);
  if (batteryWarned || gameMode) return; // a game holds it until it's over
  batteryWarned = true;
  const msg = `Battery's at ${Math.round(battery.level * 100)}%. Time for the charger?`;
  sendNotification({ title: 'A word from your cat', body: msg });
  cat.nudge(true);
  flash(msg, 8000);
}
(navigator as Navigator & { getBattery?: () => Promise<Battery> }).getBattery?.().then((b) => {
  battery = b;
  b.addEventListener('levelchange', checkBattery);
  b.addEventListener('chargingchange', checkBattery);
  checkBattery();
});

function showMode(m: typeof mode) {
  mode = m;
  todoView.hidden = m !== 'todo';
  notesView.hidden = m !== 'notes';
  focusView.hidden = m !== 'focus';
  tabTodo.setAttribute('aria-selected', String(m === 'todo'));
  tabNotes.setAttribute('aria-selected', String(m === 'notes'));
  tabFocus.setAttribute('aria-selected', String(m === 'focus'));
  panel.classList.toggle('notes-mode', m === 'notes');
  cat.setNotes(m === 'notes');
  if (m === 'notes') showNotesMenu();
  else {
    setListening(false);
    flushNote();
  }
  if (m === 'focus') renderFocus();
  refresh();
  anchor(panel, 0.67);
  syncHits();
}
tabTodo.addEventListener('click', () => showMode('todo'));
tabNotes.addEventListener('click', () => showMode('notes'));
tabFocus.addEventListener('click', () => showMode('focus'));

// ---- opening and closing ----

async function openPanel() {
  bubble.hidden = true;
  cat.wake(); // stops a walk where it is
  catX = await catXFromWindow();
  await layout(true);
  panel.hidden = false;
  addDue.value ||= defaultDue(new Date());
  showMode(mode);
}
async function closePanel() {
  if (panel.hidden) return;
  panel.hidden = true;
  setListening(false);
  flushNote();
  cat.setNotes(false);
  cat.rest();
  await layout(false);
  showInputNeeded();
}

// Drag it along the taskbar: Rust carries the window with the cursor until you let go. It stays there
// (wandering only nearby), and the click that ends a drag doesn't open the bubble.
let pressX: number | null = null, dragged = false;
catEl.addEventListener('pointerdown', (e) => {
  dragged = false;
  pressX = e.button === 0 && panel.hidden ? e.screenX : null;
});
window.addEventListener('pointerup', () => (pressX = null));
catEl.addEventListener('pointermove', async (e) => {
  if (pressX === null || Math.abs(e.screenX - pressX) < 5) return;
  pressX = null;
  dragged = true;
  bubble.hidden = true;
  cat.carry(true);
  const [min, max] = bounds().map((x) => wa.x + Math.round((x - CAT_LEFT) * scale));
  try {
    home = catX = ((await invoke<number>('drag', { min, max })) - wa.x) / scale + CAT_LEFT;
    localStorage.setItem('home', String(home));
  } catch (err) {
    console.error(err);
    catX = await catXFromWindow();
  }
  cat.carry(false);
});
catEl.addEventListener('click', () => {
  if (dragged) dragged = false;
  else if (waiting.size) {
    waiting.clear(); // "got it"
    claudeChanged();
  } else panel.hidden ? openPanel() : closePanel();
});
// Pet it: stroke the mouse back and forth over it (no button) and every fourth quick turn it purrs.
let strokeDir = 0, strokeFrom = 0, strokeAt = 0, strokes = 0;
catEl.addEventListener('pointermove', (e) => {
  const dir = Math.sign(e.movementX);
  if (e.buttons || !dir || dir === strokeDir) return;
  const now = Date.now(), long = Math.abs(e.screenX - strokeFrom) >= 12;
  strokes = long ? (now - strokeAt < 800 ? strokes + 1 : 1) : strokes;
  [strokeDir, strokeFrom, strokeAt] = [dir, e.screenX, now];
  if (strokes < 4) return;
  strokes = 0;
  cat.purr();
  flash('prrr…', 1500);
});
// Right-click: the tray icon's menu (pet, hide, snooze, game mode, quit), since Windows tucks new tray icons away.
catEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  invoke('pet_menu').catch(console.error);
});
catEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') panel.hidden ? openPanel() : closePanel();
});
catEl.addEventListener('mouseenter', () => {
  if (!panel.hidden || flashTimer) return;
  bubble.textContent = hoverText();
  bubble.hidden = false;
  anchor(bubble, 0.73);
});
catEl.addEventListener('mouseleave', () => flashTimer || (bubble.hidden = true));
window.addEventListener('keydown', (e) => e.key === 'Escape' && (listening ? cancelDictation() : closePanel()));
// Click away to close, except while dictating (the Windows voice typing bar can take focus).
window.addEventListener('blur', () => listening || closePanel());

// Clicks pass through the window except over the cat and its open bubble. Rust does the cursor check;
// this tells it where those are when they change.
let lastHits = '';
function syncHits() {
  const areas = [catEl, panel].filter((el) => !el.hidden).map((el) => {
    const r = el.getBoundingClientRect();
    return [r.left - 6, r.top - 6, r.width + 12, r.height + 12];
  });
  const key = JSON.stringify(areas);
  if (key === lastHits) return;
  lastHits = key;
  invoke('set_hit_areas', { areas }).catch(console.error);
}

// On the primary screen's taskbar, where you last put it; at first above the clock.
async function placeAboveTaskbar() {
  const mon = await primaryMonitor();
  if (mon) {
    const { position: p, size: s } = mon.workArea;
    wa = { x: p.x, y: p.y, w: s.width, h: s.height };
    scale = mon.scaleFactor;
    const [lo, hi] = bounds();
    home = catX = Math.min(Math.max(Number(localStorage.getItem('home')) || hi, lo), hi);
    await layout(false);
  }
  await win.show();
}

listen('snooze', () => {
  snoozedUntil = Date.now() + 3_600_000;
  refresh();
});
// Tray › Pet: swap the drawing and remember it.
listen<string>('skin', ({ payload }) => {
  if (!(payload in SKINS)) return;
  skin = payload as SkinId;
  cat.setSkin(skin);
  document.body.dataset.skin = skin;
  localStorage.setItem('skin', skin);
  if (!panel.hidden) anchor(panel, 0.67);
  cat.cheer();
});
// Menu › "Hide during games / fullscreen": remembered here and handed back to Rust at start.
listen<boolean>('game-mode-setting', ({ payload }) => localStorage.setItem('gameMode', String(payload)));
invoke('set_game_mode', { on: localStorage.getItem('gameMode') !== 'false' }).catch(console.error);
// Game mode (Rust hides the window while something is fullscreen): no walks, and the bubble closes.
listen<boolean>('game-mode', ({ payload }) => {
  gameMode = payload;
  cat.hold(payload);
  if (payload) closePanel();
  else {
    checkBattery();
    if (waiting.size) meow();
  }
});

await placeAboveTaskbar();
setInterval(syncHits, 250);
if (!(await isPermissionGranted())) await requestPermission();
try {
  await watchTasks((t) => {
    tasks = t;
    refresh();
    remind();
  });
} catch (e) {
  console.error(e);
  loadError = "Can't open Documents/Pet/pet-tasks.json";
  refresh();
}
setFocus(focus); // picks up a session that was running before a restart
focusTick();
setInterval(() => {
  refresh();
  remind();
  checkStretch().catch(console.error);
}, 60_000);
