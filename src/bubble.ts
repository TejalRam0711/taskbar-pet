import { relDay, shortDate, STAGES, stageOf, upcoming, type Stage, type Task } from './due';
import { noteTitle, type Note } from './notes';

const STAGE_LABEL: Record<Stage, string> = {
  starting: 'Starting',
  thinking: 'Thinking',
  'in-progress': 'In progress',
  finished: 'Finished',
};

// Hover bubble: the next due item.
export function bubbleText(tasks: Task[]): string {
  const next = upcoming(tasks)[0];
  return next ? `${next.title}: ${shortDate(next.due)}` : 'Nothing due';
}

// What the cat says when it wakes up.
export function speech(tasks: Task[], now: Date): string {
  const next = upcoming(tasks)[0];
  if (!next) return 'Nothing due. Back to my nap?';
  const when = relDay(next.due, now);
  return when === 'overdue' ? `${next.title} is overdue!` : `${next.title} is due ${when}.`;
}

// The list: next 5 items, each with a day count and a stage picker. Picking "Finished" takes it off the list.
export function renderList(list: HTMLElement, tasks: Task[], now: Date, onStage: (id: string, s: Stage) => void) {
  const next = upcoming(tasks).slice(0, 5);
  list.replaceChildren(...next.map((t) => {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = title.title = t.title;
    const when = document.createElement('span');
    when.className = Date.parse(t.due) - now.getTime() <= 86_400_000 ? 'when soon' : 'when';
    when.textContent = relDay(t.due, now);
    when.title = shortDate(t.due);
    const stage = document.createElement('select');
    stage.className = 'stage';
    stage.setAttribute('aria-label', `Stage of ${t.title}`);
    stage.append(...STAGES.map((s) => new Option(STAGE_LABEL[s], s)));
    stage.value = stage.dataset.stage = stageOf(t);
    stage.onchange = () => {
      stage.dataset.stage = stage.value;
      onStage(t.id, stage.value as Stage);
    };
    li.append(title, when, stage);
    return li;
  }));
}

// Notes menu: each note's first line and when it was last edited (time if today, else date); click to open.
export function renderNotes(ul: HTMLElement, list: Note[], now: Date, onOpen: (n: Note) => void) {
  ul.replaceChildren(...list.map((n) => {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = noteTitle(n);
    const when = document.createElement('span');
    when.className = 'when';
    const d = new Date(n.updated);
    when.textContent = d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    open.append(title, when);
    open.onclick = () => onOpen(n);
    li.append(open);
    return li;
  }));
}

// Tomorrow 09:00 in the format <input type="datetime-local"> wants.
export function defaultDue(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
}
