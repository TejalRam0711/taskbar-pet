import type { Mood } from './due';
import { drawPet, type SkinId } from './skins';

// What the pet does and when. The drawing and its skins are in skins.ts.

// The z z z bubble and the focus countdown chip sit next to the drawing (outside it, so a skin swap keeps them).
const EXTRAS = `<div class="zzz-bubble" aria-hidden="true"><span>z</span><span>z</span><span>z</span></div>
<div class="chip" role="timer" hidden></div>`;

// While a CSS animation runs, Chromium repaints the SVG on every display frame: 120 times a second on a
// 120 Hz screen, and in software here, which cost ~35% of a core per walk. So the walk and play motions are
// generated as keyframes sampled at 30 fps (same eased curves, held between samples). The rules that use
// these names, and their durations, are in styles.css.
const FPS = 30;
const easeInOut = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);
const easeOut = (t: number) => Math.sin((Math.PI * t) / 2);
const easeIn = (t: number) => 1 - Math.cos((Math.PI * t) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
// Piecewise: [[p, value], ...] with an easing per segment (default ease-in-out).
const curve = (pts: [number, number][], ease: ((t: number) => number)[] = []) => (p: number) => {
  const i = Math.max(0, pts.findIndex(([q], k) => k > 0 && p <= q) - 1);
  const [[p0, v0], [p1, v1]] = [pts[i], pts[i + 1]];
  return lerp(v0, v1, (ease[i] ?? easeInOut)((p - p0) / (p1 - p0)));
};
// Same-shape SVG paths blended number by number.
const blendPath = (a: string, b: string, t: number) => {
  const nb = b.match(/-?[\d.]+/g)!.map(Number);
  let i = 0;
  return a.replace(/-?[\d.]+/g, (n) => lerp(Number(n), nb[i++], t).toFixed(2));
};
const stride = curve([[0, -20], [0.6, 20], [1, -20]], [(t) => t]); // stance linear: planted paw keeps pace with the ground
const knee = curve([[0, 0], [0.55, 0], [0.78, 40], [1, 0]], [(t) => t, easeOut, easeIn]);
const swipe = curve([[0, 0], [0.45, 0], [0.6, -62], [0.75, -10], [1, 0]]);
const rollX = curve([[0, 0], [0.58, 0], [0.78, 7], [1, 0]]), rollR = curve([[0, 0], [0.58, 0], [0.78, 140], [1, 0]]);
const TAIL = ['M48 53 C41 51 38 44 40 37 C41.5 31 38 27 34.5 28.5 C32 29.5 32.5 32.5 35 32',
  'M48 53 C40 52 36 45 37 38 C38 32 34.5 28 31 29.5 C28.5 30.5 29 34 31.5 33.5'];
const sampled = (name: string, seconds: number, at: (p: number) => string) => {
  const n = Math.round(seconds * FPS);
  const frames = Array.from({ length: n + 1 }, (_, i) =>
    `${((i / n) * 100).toFixed(2)}% { ${at(i / n)}; animation-timing-function: step-end; }`);
  return `@keyframes ${name} { ${frames.join(' ')} }`;
};
document.head.append(Object.assign(document.createElement('style'), {
  textContent: [
    sampled('stride', 0.62, (p) => `transform: rotate(${stride(p).toFixed(2)}deg)`),
    sampled('knee', 0.62, (p) => `transform: rotate(${knee(p).toFixed(2)}deg)`),
    sampled('bob', 0.62, (p) => `transform: translateY(${(-1.3 * Math.sin(2 * Math.PI * p) ** 2).toFixed(2)}px)`),
    sampled('nod', 0.62, (p) => `transform: rotate(${(-3 * Math.sin(2 * Math.PI * p) ** 2).toFixed(2)}deg)`),
    sampled('swish', 1.24, (p) => `d: path("${blendPath(TAIL[0], TAIL[1], easeInOut(p))}")`),
    sampled('swipe', 1.3, (p) => `transform: rotate(${swipe(p).toFixed(2)}deg)`),
    sampled('roll', 1.3, (p) => `transform: translateX(${rollX(p).toFixed(2)}px) rotate(${rollR(p).toFixed(1)}deg)`),
    sampled('hop', 0.62, (p) => `transform: translateY(${(-5 * Math.sin(Math.PI * p)).toFixed(2)}px)`), // the bunny
    // picked up: a slow swing from the scruff, body stretched a little
    sampled('dangle', 1.6, (p) => `transform: rotate(${(5 * Math.sin(2 * Math.PI * p)).toFixed(2)}deg) scaleY(1.06)`),
    // something dragged over it: up on tiptoe, paws grabbing at it in turn
    sampled('tiptoe', 0.5, (p) => `transform: translateY(${(-2.5 * Math.abs(Math.sin(2 * Math.PI * p))).toFixed(2)}px) scaleY(1.06)`),
    sampled('grab', 0.5, (p) => `transform: rotate(${(-8 * Math.sin(2 * Math.PI * p)).toFixed(2)}deg)`),

  ].join('\n'),
}));

type Activity = 'sleep' | 'awake' | 'sit' | 'walk' | 'play';

// Walking moves the whole (small) window, so the cat asks main.ts to do it. Positions are the cat's
// left edge on screen in CSS px.
export type Mover = {
  x: () => number;
  range: () => [number, number];
  go: (to: number, ms: number) => Promise<boolean>; // false if halted on the way
  halt: () => void;
};

const SPEED = 32; // px per second when walking; matches the stride in styles.css so paws don't slide
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createCat(el: HTMLElement, mover: Mover, skin: SkinId = 'black') {
  el.innerHTML = drawPet(skin) + EXTRAS;
  let svg = el.querySelector('svg')!;
  let activity: Activity = 'sleep', mood: Mood = 'sleep', engaged = false;
  let walking = false, timer = 0, scribbleTimer = 0, nudgeTimer = 0;
  let focus: 'work' | 'nap' | null = null, notesOpen = false, perked = false, nudging = false, held = false;
  let carried = false, catching = false, catchTimer = 0, purrTimer = 0;

  const show = (a: Activity) => {
    activity = a;
    for (const c of ['sleep', 'awake', 'sit', 'walk', 'play']) svg.classList.toggle(c, c === a);
  };
  // Glasses, shirt and tie: while the notes are open, or while it works at its desk in a focus session.
  const dress = () => svg.classList.toggle('notes', notesOpen || focus === 'work');
  // What the cat does when nothing is going on: sitting up while you're talking to it (or carrying it, or
  // something is dragged over it, or it's nudging you), at its desk during focus, napping on a break, awake while
  // something is due within 24 h, else asleep. Coming from sitting or walking it lies down first,
  // then lowers its head, so you see it settle rather than jump.
  const settle = () => {
    clearTimeout(timer);
    if (walking) {
      walking = false;
      mover.halt();
    }
    svg.classList.remove('left', 'lying-down', 'glance', 'landed');
    const next: Activity =
      engaged || carried || perked || catching || nudging || focus === 'work' ? 'sit'
      : focus === 'nap' ? 'sleep'
      : mood === 'urgent' || mood === 'alert' ? 'awake'
      : 'sleep';
    if (next === 'sit' || activity === 'sleep' || activity === 'awake') return show(next);
    show('awake');
    svg.classList.add('lying-down');
    timer = window.setTimeout(() => {
      svg.classList.remove('lying-down');
      show(next);
    }, 800);
  };

  async function stroll(to: number) {
    walking = true;
    show('walk');
    svg.classList.toggle('left', to < mover.x());
    const walkTo = async (x: number) => walking && (await mover.go(x, (Math.abs(x - mover.x()) / SPEED) * 1000));
    // Half the time it stops partway, tilts its head at you with a slow blink, then carries on.
    if (Math.random() < 0.5) {
      if (!(await walkTo(Math.round(mover.x() + (to - mover.x()) * rand(0.3, 0.7))))) return;
      svg.classList.add('glance');
      await sleep(1800);
      if (!walking) return; // you clicked it meanwhile
      svg.classList.remove('glance');
    }
    if (!(await walkTo(to))) return;
    walking = false;
    settle();
  }

  // Every so often, if left alone: stroll along the taskbar, play with the yarn, or sit up and look around.
  function wander() {
    const night = new Date().getHours() < 6;
    const busy = engaged || carried || focus || held || perked || nudging;
    if (busy || (activity !== 'sleep' && activity !== 'awake') || mood === 'urgent' || night) return;
    if (Math.random() > (mood === 'sleep' ? 0.3 : 0.5)) return;
    const roll = Math.random();
    if (roll < 0.45) {
      const [min, max] = mover.range();
      const to = Math.round(rand(min, max));
      if (Math.abs(to - mover.x()) >= 120) stroll(to);
    } else {
      show(roll < 0.8 ? 'play' : 'awake');
      timer = window.setTimeout(settle, rand(10_000, 18_000));
    }
  }
  setInterval(wander, 40_000);

  // Sleep, sit-awake and the urgent hop can last hours, so they run off this 2.5 fps tick instead of CSS
  // animations: the page only repaints when a pose changes. (Walk, play and talk are short and use CSS.)
  let n = 0;
  setInterval(() => {
    const d = svg.dataset;
    n++;
    d.breath = String(Math.floor(n / 4) % 2);
    d.z = String(Math.floor((n % 8) / 2)); // z, z z, z z z, hold
    d.hop = String(n % 2);
    d.twitch = n % 20 === 0 ? '1' : '0';
    if (n % 12 === 0) {
      d.blink = '1';
      setTimeout(() => (d.blink = '0'), 150);
    }
  }, 400);

  return {
    // Swap the drawing for another skin, keeping what the pet is doing (its state is in the classes).
    setSkin(id: SkinId) {
      const t = document.createElement('template');
      t.innerHTML = drawPet(id);
      const next = t.content.querySelector('svg')!;
      next.setAttribute('class', svg.getAttribute('class')!.replace(/skin-\w+/, `skin-${id}`));
      svg.replaceWith(next);
      svg = next;
    },
    setMood(m: Mood) {
      mood = m;
      svg.classList.toggle('urgent', m === 'urgent');
      if (activity === 'sleep' || activity === 'awake') settle();
    },
    // Clicked: stop whatever it was doing, get up, sit and talk for a moment.
    wake() {
      engaged = true;
      settle();
      svg.classList.add('talking');
      timer = window.setTimeout(() => svg.classList.remove('talking'), 1800);
    },
    rest() {
      engaged = false;
      svg.classList.remove('talking');
      settle();
    },
    cheer() {
      svg.classList.add('happy');
      setTimeout(() => svg.classList.remove('happy'), 2200);
    },
    // Notes mode: glasses, shirt and tie, writing on a sheet of paper; scribbles faster while you type.
    setNotes(on: boolean) {
      notesOpen = on;
      dress();
    },
    // Focus timer: works at its desk during focus, naps on the break.
    setFocus(f: 'work' | 'nap' | null) {
      focus = f;
      dress();
      settle();
    },
    // Picked up: it stops what it was doing and dangles until put down, then lands sitting with a little
    // squash before settling as usual.
    carry(on: boolean) {
      carried = on;
      svg.classList.toggle('carried', on);
      if (on) return settle();
      svg.classList.add('landed');
      clearTimeout(timer);
      timer = window.setTimeout(settle, 600);
    },
    // Something is being dragged over it: up on its hind legs, reaching for it like a cartoon cat after a toy.
    perk(on: boolean) {
      if (on === perked) return;
      perked = on;
      svg.classList.toggle('reaching', on);
      settle();
    },
    // Dropped on it: it catches it and hugs it to its chest for a moment.
    caught() {
      perked = false;
      catching = true;
      svg.classList.remove('reaching');
      svg.classList.add('caught');
      settle();
      clearTimeout(catchTimer);
      catchTimer = window.setTimeout(() => {
        catching = false;
        svg.classList.remove('caught');
        settle();
      }, 1800);
    },
    // Stretch reminder: sit up and say something for a few seconds. Low battery: a big yawn instead.
    nudge(yawn = false) {
      nudging = true;
      settle();
      svg.classList.add(yawn ? 'yawning' : 'talking');
      clearTimeout(nudgeTimer);
      nudgeTimer = window.setTimeout(() => {
        nudging = false;
        svg.classList.remove('talking', 'yawning');
        settle();
      }, 3000);
    },
    // Petted: eyes closed, a heart and a little purring shiver, whatever pose it's in.
    purr() {
      svg.classList.add('happy', 'purring');
      clearTimeout(purrTimer);
      purrTimer = window.setTimeout(() => svg.classList.remove('happy', 'purring'), 2200);
    },
    // Game mode: hidden, so no walks.
    hold(on: boolean) {
      held = on;
      if (on && walking) settle();
    },
    scribble() {
      svg.classList.add('scribbling');
      clearTimeout(scribbleTimer);
      scribbleTimer = window.setTimeout(() => svg.classList.remove('scribbling'), 700);
    },
  };
}
