// Due-date math: no I/O, so it can be tested with `npm test`.
export const STAGES = ['starting', 'thinking', 'in-progress', 'finished'] as const;
export type Stage = (typeof STAGES)[number];
export type Task = {
  id: string;
  title: string;
  due: string;
  remind?: string[];
  priority?: string;
  stage?: Stage;
  done?: boolean; // kept in step with stage === 'finished' for older readers of the file
};
export type Mood = 'idle' | 'sleep' | 'alert' | 'urgent';

export const stageOf = (t: Task): Stage =>
  t.done ? 'finished' : STAGES.includes(t.stage as Stage) ? (t.stage as Stage) : 'starting';

// A to-do typed into the cat's add box.
export function newTask(title: string, due: Date, now = new Date()): Task {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return {
    id: `${slug || 'task'}-${now.getTime().toString(36)}`,
    title: title.trim(),
    due: due.toISOString(),
    remind: ['1d', '1h'],
    stage: 'starting',
    done: false,
  };
}

const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const UNIT: Record<string, number> = { m: MIN, h: H, d: D, w: 7 * D };

// "1d" → ms; anything unparseable → NaN, so that reminder never fires.
export function offsetMs(s: string): number {
  const m = /^(\d+)([mhdw])$/.exec(s.trim());
  return m ? Number(m[1]) * UNIT[m[2]] : NaN;
}

// Unfinished tasks with a valid due date, soonest first.
export function upcoming(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => stageOf(t) !== 'finished' && !Number.isNaN(Date.parse(t.due)))
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
}

export function moodFor(tasks: Task[], now: Date): Mood {
  const next = upcoming(tasks)[0];
  const left = next ? Date.parse(next.due) - now.getTime() : Infinity;
  if (left <= H) return 'urgent';
  if (left <= D) return 'alert';
  if (left > 3 * D || now.getHours() < 6) return 'sleep';
  return 'idle';
}

// Tasks with a reminder whose time has passed (and the task isn't due yet) that hasn't fired.
// keys = every passed reminder of that task, so a late start sends one notification, not several.
export function dueReminders(tasks: Task[], now: Date, fired: Set<string>): { task: Task; keys: string[] }[] {
  const t = now.getTime();
  return upcoming(tasks)
    .map((task) => {
      const due = Date.parse(task.due);
      const keys = (task.remind ?? [])
        .filter((r) => due - offsetMs(r) <= t && t < due)
        .map((r) => `${task.id}|${task.due}|${r}`);
      return { task, keys };
    })
    .filter((x) => x.keys.some((k) => !fired.has(k)));
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function relDay(due: string, now: Date): string {
  const ms = Date.parse(due) - now.getTime();
  if (ms < 0) return 'overdue';
  if (ms < H) return `in ${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < D) return `in ${Math.round(ms / H)} h`;
  const days = Math.round((dayStart(new Date(due)) - dayStart(now)) / D);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

// "Mon 16 Nov"
export const shortDate = (due: string) =>
  new Date(due).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
