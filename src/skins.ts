// The pet's drawing (viewBox 120×80, ground at y=78, body facing right) and its skins.
// Three rigs: "lie" (sleep, awake), "sitting" (when you click it) and "stand" (walk, play), all wearing the
// same face so it's always the same animal. styles.css animates the parts by class and colours them per skin
// (.skin-<id>), so a skin only swaps shapes and markings here and must keep the classes and joints.

export type SkinId = 'black' | 'orange' | 'tabby' | 'bunny' | 'ink' | 'doodle' | 'lcd';

type Rigs<T> = { lie?: T; sit?: T; stand?: T };
type Skin = {
  name: string;
  ears?: string; // face coordinates: origin at the middle of the skull
  earsIn?: string;
  skull?: string;
  face?: string; // markings on the face: muzzle patch, stripes
  body?: Rigs<string>; // a transform that fattens the body in each rig (legs and head stay put)
  marks?: Rigs<string>; // markings over the body in each rig
  bands?: boolean; // ringed tail
  puff?: Rigs<[number, number, number]>; // a cotton-ball tail (cx, cy, r) instead of a cat's tail
  defs?: string; // SVG filters the skin's styles use
  deco?: string; // drawn beside the pet, not part of it
  earTop: number; // y of the ear tips when sitting, so the speech bubble clears them
};

const scaleAbout = (x: number, y: number, sx: number, sy: number) =>
  `translate(${x} ${y}) scale(${sx} ${sy}) translate(${-x} ${-y})`;

const BELLY: Rigs<string> = {
  lie: `<path class="belly" d="M84 63 C87 64 89.5 68 89 72 C88 75 86 76.5 84 77Z"/>`,
  sit: `<path class="belly" d="M75.5 54 C73.5 60 74 68 76.5 73 L83.5 73 C86 68 86.5 60 84.5 54Z"/>`,
  stand: `<path class="belly" d="M60 60.5 C67 61.6 75 61.2 80 60 C84 59 86.5 56.5 87.5 53 C85 56 80 58 74 58.6 C68 59.2 63 59.4 60 60.5Z"/>`,
};
const STRIPES: Rigs<string> = {
  lie: `<path class="stripe" d="M46 60.5 Q47 64 46 67 M53 60 Q54 63.5 53 66.5 M60 59.8 Q61 63 60 66 M67 59.5 Q68 62.5 67 65.5"/>${BELLY.lie}`,
  sit: `${BELLY.sit}<path class="stripe" d="M70.5 60 Q72.5 61 73.5 63.5 M69.5 65 Q72 66 73 68.5 M89.5 60 Q87.5 61 86.5 63.5 M90.5 65 Q88 66 87 68.5"/>`,
  stand: `<path class="stripe" d="M56 45.5 Q57 48.5 56 51 M62 45 Q63 48 62 50.5 M68 44.5 Q69 47.5 68 50 M74 44 Q75 47 74 49.5"/>${BELLY.stand}`,
};
const MUZZLE = `<ellipse class="belly" cx="0" cy="6.1" rx="5" ry="3.5"/>`;

export const SKINS: Record<SkinId, Skin> = {
  black: { name: 'Black cat', earTop: 15 },
  orange: {
    name: 'Orange cat',
    // small rounded ears, fluffy cheeks, a round tummy and short legs
    ears: 'M-11 -4 Q-12.6 -12 -11 -17 Q-10.2 -18.6 -8.8 -17.6 Q-5.6 -14.5 -3.5 -11Z M11 -4 Q12.6 -12 11 -17 Q10.2 -18.6 8.8 -17.6 Q5.6 -14.5 3.5 -11Z',
    earsIn: 'M-10 -6 Q-10.8 -11.5 -9.8 -15 Q-7.2 -12.8 -5.6 -10.6Z M10 -6 Q10.8 -11.5 9.8 -15 Q7.2 -12.8 5.6 -10.6Z',
    skull: 'M-14 -1 C-14.5 -9 -7 -12.2 0 -12.2 C7 -12.2 14.5 -9 14 -1 L15.6 2 L13.4 3 L14.6 5.6 L11.8 6 C10 9.6 5.5 11 0 11 C-5.5 11 -10 9.6 -11.8 6 L-14.6 5.6 L-13.4 3 L-15.6 2Z',
    face: `${MUZZLE}<path class="stripe" d="M-3 -11.6 L-2.4 -8.4 M0 -12 L0 -8.6 M3 -11.6 L2.4 -8.4 M-13.6 -0.5 L-10.6 0.6 M13.6 -0.5 L10.6 0.6"/>`,
    body: {
      lie: scaleAbout(60, 78, 1.08, 1.32),
      sit: scaleAbout(80, 78, 1.42, 1.08),
      stand: scaleAbout(66, 45, 1.12, 1.45),
    },
    marks: STRIPES,
    bands: true,
    earTop: 20,
  },
  tabby: {
    name: 'Tabby cat',
    // the "M" on the forehead, cheek stripes, white muzzle, chest and paws
    face: `${MUZZLE}<path class="stripe" d="M-4.6 -6.2 L-3 -10.4 L-1.2 -7.2 L0 -10.8 L1.2 -7.2 L3 -10.4 L4.6 -6.2 M-12.4 0.8 L-9 1.8 M-12.2 3.4 L-9.2 4 M12.4 0.8 L9 1.8 M12.2 3.4 L9.2 4"/>`,
    marks: STRIPES,
    bands: true,
    earTop: 15,
  },
  bunny: {
    name: 'Bunny',
    // long ears with pink insides, a rounder face, a cotton-ball tail; it hops (styles.css)
    ears: 'M-7.5 -9.5 C-11 -18 -12 -31 -8.5 -35 C-5.5 -38 -3.5 -30 -3 -22 C-2.8 -16 -2.8 -12 -2.6 -10.5Z M7.5 -9.5 C11.5 -17 13.5 -29 10.5 -33.5 C7.5 -37 4.2 -29 3.4 -21 C3 -16 2.8 -12 2.6 -10.5Z',
    earsIn: 'M-6.6 -12 C-9 -19 -9.6 -28 -7.8 -32 C-6 -33.5 -5 -27 -4.6 -21 C-4.4 -16 -4.4 -13 -4.2 -12Z M6.6 -12 C9.4 -19 10.8 -27 9.4 -31 C7.6 -33 6 -26 5.2 -20.5 C4.8 -16 4.6 -13 4.4 -12Z',
    skull: 'M-11 0 C-11.5 -8 -6 -11 0 -11 C6 -11 11.5 -8 11 0 C10.8 5.5 6.5 9.5 0 9.7 C-6.5 9.5 -10.8 5.5 -11 0Z',
    face: MUZZLE,
    body: {
      lie: scaleAbout(60, 78, 1, 1.15),
      sit: scaleAbout(80, 78, 1.12, 1),
      stand: scaleAbout(66, 45, 1.02, 1.2),
    },
    puff: { lie: [35, 71, 5.2], sit: [64, 73, 4.6], stand: [45, 49, 5] },
    earTop: 1,
  },
  ink: {
    name: 'Ink cat',
    // sumi-e: a black cat in brush ink, the paper left bare for its chest, muzzle and paws; rough brush edges
    // (the filter) and the painter's red seal
    face: MUZZLE,
    marks: BELLY,
    defs: `<filter id="ink-edge" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" seed="7"/>
      <feDisplacementMap in="SourceGraphic" scale="1.6" xChannelSelector="R" yChannelSelector="G"/></filter>`,
    deco: `<g class="seal"><rect x="9" y="67" width="8" height="8" rx="0.6"/><path d="M11 69.3 H15 M13 68.8 V73.6 M11.2 71.4 H14.8 M11.3 73.4 L12.6 72.2 M14.7 73.4 L13.4 72.2"/></g>`,
    earTop: 15,
  },
  doodle: {
    name: 'Doodle cat',
    // a notebook doodle (Bongo Cat style): white, one thick black line, dot eyes; styles.css draws the lines.
    // Chubby: a wide round head, small rounded ears and a round body
    ears: 'M-11.5 -4 Q-13 -11.5 -11.6 -16.4 Q-10.8 -18 -9.4 -17 Q-6.2 -14 -4 -10.5Z M11.5 -4 Q13 -11.5 11.6 -16.4 Q10.8 -18 9.4 -17 Q6.2 -14 4 -10.5Z',
    earsIn: 'M-10.4 -6 Q-11.2 -11.4 -10.4 -14.6 Q-7.8 -12.4 -6 -10.2Z M10.4 -6 Q11.2 -11.4 10.4 -14.6 Q7.8 -12.4 6 -10.2Z',
    skull: 'M-14.5 0 C-15 -8.5 -8 -12 0 -12 C8 -12 15 -8.5 14.5 0 C14.3 6.6 7.8 10.8 0 10.9 C-7.8 10.8 -14.3 6.6 -14.5 0Z',
    face: '',
    body: {
      lie: scaleAbout(60, 78, 1.08, 1.3),
      sit: scaleAbout(80, 78, 1.4, 1.08),
      stand: scaleAbout(66, 45, 1.12, 1.42),
    },
    earTop: 18,
  },
  lcd: { name: 'LCD pet', earTop: 34 }, // its own drawing: drawLcd() below
};

const EARS = 'M-11.6 -4 Q-14 -14 -12.6 -20.5 Q-12 -22.6 -10.4 -21.2 Q-6.5 -17 -3.5 -11Z M11.6 -4 Q14 -14 12.6 -20.5 Q12 -22.6 10.4 -21.2 Q6.5 -17 3.5 -11Z';
const EARS_IN = 'M-10.5 -6.5 Q-12 -13.5 -11.4 -18 Q-7.8 -15 -5.6 -11Z M10.5 -6.5 Q12 -13.5 11.4 -18 Q7.8 -15 5.6 -11Z';
const SKULL = 'M-12.5 -1 C-13 -9 -6.5 -12 0 -12 C6.5 -12 13 -9 12.5 -1 C12.3 5 7 9.8 0 10 C-7 9.8 -12.3 5 -12.5 -1Z';

// The face, looking at you.
const head = (s: Skin) => `
  <g class="head">
    <path class="fur ears" d="${s.ears ?? EARS}"/>
    <path class="ear-in ears" d="${s.earsIn ?? EARS_IN}"/>
    <path class="fur" d="${s.skull ?? SKULL}"/>
    ${s.face ?? ''}
    <ellipse class="blush" cx="-8" cy="5" rx="2.4" ry="1.2"/>
    <ellipse class="blush" cx="8" cy="5" rx="2.4" ry="1.2"/>
    <g class="eyes-open">
      <ellipse class="iris" cx="-5.2" cy="-0.5" rx="3.9" ry="4.7"/>
      <ellipse class="iris" cx="5.2" cy="-0.5" rx="3.9" ry="4.7"/>
      <ellipse class="pupil" cx="-4.9" cy="-0.2" rx="2.1" ry="3.7"/>
      <ellipse class="pupil" cx="5.5" cy="-0.2" rx="2.1" ry="3.7"/>
      <circle class="glint" cx="-3.9" cy="-2.6" r="1"/>
      <circle class="glint" cx="6.5" cy="-2.6" r="1"/>
      <circle class="glint" cx="-6.3" cy="1.8" r="0.45"/>
      <circle class="glint" cx="4.1" cy="1.8" r="0.45"/>
    </g>
    <path class="eyes-shut" d="M-9 0 Q-5.2 2.8 -1.4 0 M1.4 0 Q5.2 2.8 9 0"/>
    <path class="nose" d="M-1 4.6 L1 4.6 L0 5.7Z"/>
    <path class="mouth" d="M-1.6 6.6 Q-0.8 7.6 0 6.8 Q0.8 7.6 1.6 6.6"/>
    <ellipse class="mouth-open" cx="0" cy="7.6" rx="1.7" ry="1.4"/>
    <path class="whiskers" d="M-3 5.5 L-14 4 M-3 6.4 L-14.5 7.6 M-3.2 7.2 L-13 10.5 M3 5.5 L14 4 M3 6.4 L14.5 7.6 M3.2 7.2 L13 10.5"/>
    <g class="specs"><circle cx="-5.3" cy="-0.4" r="5"/><circle cx="5.3" cy="-0.4" r="5"/><path d="M-0.4 -1.2 Q0 -2 0.4 -1.2 M-10.3 -1 L-12.4 -2.4 M10.3 -1 L12.4 -2.4"/></g>
  </g>`;

// A cat's tail (with rings if the skin has them), or nothing for a skin with a cotton-ball tail.
const tail = (s: Skin, cls: string, d: string) =>
  s.puff ? '' : `<path class="tail ${cls}" d="${d}"/>${s.bands ? `<path class="tail ${cls} band" d="${d}"/>` : ''}`;
const puff = (s: Skin, rig: keyof Rigs<unknown>) => {
  const p = s.puff?.[rig];
  return p ? `<circle class="fur puff" cx="${p[0]}" cy="${p[1]}" r="${p[2]}"/>` : '';
};

// ---- LCD pet: a pixel cat on a 32×16-dot LCD like a Tamagotchi's, with the "off" dots showing. It has no
// rig: each pose is two frames of dots, and showLcdFrame() (on cat.ts's 2.5 fps tick) shows the one that matches
// the pet's state classes, flipping between the two like the toy does. ----

const LCD = { pitch: 2.6, dot: 2.2, x: 18.6, y: 35.8 }; // x centres the screen on 60, where .flip mirrors
type Part = [string[], number, number]; // rows ('#' on, '-' turns off what's under it), column, row

const pxHead = (eyes: string[], mid: string, mouth: string) =>
  ['#...........#', '##.........##', '#.#.......#.#', '#..#######..#', '#...........#', ...eyes, mid, mouth, '..#########..'];
const OPEN = ['#..##...##..#', '#..##...##..#'], SHUT = ['#...........#', '#.###...###.#'], HAPPY = ['#...#...#...#', '#..#.#.#.#..#'];
const NOSE = '#.....#.....#', WIDE = '#....###....#', SMILE = '.#...#.#...#.', AH = '.#...###...#.';
const SIT = ['..#.......#..', '.#.........#.', '.#..#...#..#.', '.#..#...#..#.', '..##.###.##..'];
const HUG = ['..#.......#..', '.#.#######.#.', '.##.......##.', '.#.#######.#.', '..##.###.##..'];
const DANGLE = ['..#.......#..', '.#.........#.', '..#.#...#.#..', '..#.#...#.#..', '...#.....#...'];
const LOAF = ['..###############..', '.#...............#.', '#.................#', '#.................#', '#.................#', '.#################.'];
const TAIL = ['...#', '..#.', '.#..', '#...'], WAG = ['..#.', '..#.', '.#..', '#...'];
const Z = ['###', '.#.', '###'], BALL = ['.#.', '#.#', '.#.'], HEART = ['.#.#.', '#####', '.###.', '..#..'];
const PAPER = ['####', '#..#', '####'], BANG = ['#', '#', '#', '.', '#'];

const X = 13; // the cat's left column
const sitting = (h: string[], body = SIT, tail: string[] | null = TAIL, dy = 0): Part[] =>
  [[h, X, 1 + dy], [body, X, 11 + dy], ...(tail ? [[tail, X + 12, 11 + dy] as Part] : [])];
const lying = (h: string[]): Part[] =>
  [[LOAF, X - 3, 10], [Array(6).fill('-'.repeat(13)), X, 10], [h, X, 6], [['.##', '#..'], X + 16, 13]];
const awake = pxHead(OPEN, NOSE, SMILE), asleep = pxHead(SHUT, NOSE, SMILE), oh = pxHead(OPEN, NOSE, AH);
const reach = (lift: number): Part[] =>
  [...sitting(oh), [['#..', '.#.', '..#'], X - 2, 8 - lift], [['..#', '.#.', '#..'], X + 12, 8 - lift], [['#', '#'], X - 2, 7 - lift], [['#', '#'], X + 14, 7 - lift]];

const FRAMES: Record<string, [Part[], Part[]]> = {
  sleep: [[...lying(asleep), [Z, X + 14, 5]], [...lying(asleep), [Z, X + 14, 5], [Z, X + 16, 1]]],
  awake: [lying(awake), lying(awake)],
  urgent: [[...lying(awake), [BANG, X + 16, 3]], lying(awake)],
  sit: [sitting(awake), sitting(awake, SIT, WAG)],
  talk: [sitting(awake), sitting(oh)],
  notes: [[...sitting(awake), [PAPER, X - 5, 13], [['.#', '#.'], X - 2, 12]], [...sitting(awake), [PAPER, X - 5, 13], [['##'], X - 2, 12]]],
  walk: [sitting(awake), sitting(awake, SIT, WAG, -1)],
  play: [[...sitting(awake), [BALL, X - 4, 13]], [...sitting(awake, SIT, WAG), [BALL, X - 6, 12]]],
  reach: [reach(0), reach(2)],
  yawn: [sitting(pxHead(SHUT, WIDE, AH)), sitting(pxHead(SHUT, WIDE, AH))],
  happy: [[...sitting(pxHead(HAPPY, NOSE, SMILE)), [HEART, X + 14, 1]], [...sitting(pxHead(HAPPY, NOSE, SMILE), SIT, WAG), [HEART, X + 14, 0]]],
  hug: [sitting(awake, HUG), sitting(awake, HUG, WAG)],
  carried: [sitting(oh, DANGLE, null), sitting(oh, DANGLE, null).map(([r, x, y]): Part => [r, x + 1, y])],
};

// One path of square dots per frame.
const dots = (parts: Part[]) => {
  const on = new Set<string>();
  for (const [rows, x, y] of parts)
    rows.forEach((row, j) => [...row].forEach((c, i) => (c === '#' ? on.add(`${x + i},${y + j}`) : c === '-' && on.delete(`${x + i},${y + j}`))));
  return [...on]
    .map((k) => k.split(',').map(Number))
    .filter(([i, j]) => i >= 0 && i < 32 && j >= 0 && j < 16)
    .map(([i, j]) => `M${(LCD.x + i * LCD.pitch).toFixed(1)} ${(LCD.y + j * LCD.pitch).toFixed(1)}h${LCD.dot}v${LCD.dot}h-${LCD.dot}Z`)
    .join('');
};

const drawLcd = () => {
  const w = 31 * LCD.pitch + LCD.dot, h = 15 * LCD.pitch + LCD.dot;
  const frames = Object.entries(FRAMES).flatMap(([name, pair]) => pair.map((parts, k) => `<path class="px" data-f="${name}-${k}" d="${dots(parts)}"/>`));
  return `
<svg viewBox="0 0 120 80" class="cat sleep skin-lcd" aria-hidden="true">
  <defs><pattern id="lcd-off" x="${LCD.x}" y="${LCD.y}" width="${LCD.pitch}" height="${LCD.pitch}" patternUnits="userSpaceOnUse"><rect width="${LCD.dot}" height="${LCD.dot}"/></pattern></defs>
  <rect class="screen" x="${LCD.x - 2}" y="${LCD.y - 2}" width="${w + 4}" height="${h + 4}" rx="3"/>
  <rect class="off-dots" x="${LCD.x}" y="${LCD.y}" width="${w}" height="${h}" fill="url(#lcd-off)"/>
  <g class="flip">${frames.join('')}</g>
</svg>`;
};

// The frame for the pet's state: what it's doing, then what it's feeling; n flips between the two frames.
const lcdFrame = (c: DOMTokenList, n: number) => {
  const pose = c.contains('carried') ? 'carried' : c.contains('caught') ? 'hug' : c.contains('reaching') ? 'reach'
    : c.contains('yawning') ? 'yawn' : c.contains('happy') ? 'happy' : c.contains('sleep') ? 'sleep'
    : c.contains('walk') ? 'walk' : c.contains('play') ? 'play'
    : c.contains('sit') ? (c.contains('notes') ? 'notes' : c.contains('talking') ? 'talk' : 'sit')
    : c.contains('urgent') ? 'urgent' : 'awake';
  return `${pose}-${n % 2}`;
};
export function showLcdFrame(svg: SVGSVGElement, n: number) {
  const want = svg.querySelector(`[data-f="${lcdFrame(svg.classList, n)}"]`);
  svg.querySelectorAll('.px.on').forEach((p) => p !== want && p.classList.remove('on'));
  want?.classList.add('on');
}

export function drawPet(id: SkinId): string {
  if (id === 'lcd') return drawLcd();
  const s = SKINS[id];
  const h = head(s);
  return `
<svg viewBox="0 0 120 80" class="cat sleep skin-${id}" aria-hidden="true">
  ${s.defs ?? ''}
  <g class="flip">
    <g class="rig lie">
      ${tail(s, 'tail-lie', 'M36 73 C26 79 42 81 58 80 C65 79.5 70 79 75 77.5')}
      <g transform="${s.body?.lie ?? ''}">
        <path class="fur body-lie" d="M34 77 C30 68 40 60.5 54 60 C63 59.6 70 59 76 59 C84 59 89 63 90 69 C90.8 74.5 87.5 77.8 83 78 L38 78 C35.5 78 34 77.8 34 77Z"/>
        ${s.marks?.lie ?? ''}
        <path class="rim" d="M42 63 C51 61 62 60.5 73 60.5"/>
      </g>
      ${puff(s, 'lie')}
      <clipPath id="above-ground"><rect x="-60" y="-60" width="120" height="85.2"/></clipPath>
      <g transform="translate(87 49) scale(1.15)" clip-path="url(#above-ground)"><g class="head-lie">
        <path class="fur" d="M-16 20 C-13 13 -11 4 -9 -3 L4 5 C4 11 3 16 2 20Z"/>
        ${h}
      </g></g>
      <ellipse class="fur paw" cx="86" cy="77.4" rx="5.5" ry="2"/>
      <ellipse class="fur paw" cx="93" cy="77" rx="6" ry="2.3"/>
    </g>
    <g class="rig sitting">
      ${tail(s, 'tail-sit', 'M70 74 C60 76 57 70 60.5 64 C63 59.5 59.5 55.5 56 56.5')}
      <g class="legs-hang">
        <path d="M74 74 L72.6 81.5"/><ellipse class="fur paw" cx="72.4" cy="82" rx="2.8" ry="1.6"/>
        <path d="M86 74 L87.4 81.5"/><ellipse class="fur paw" cx="87.6" cy="82" rx="2.8" ry="1.6"/>
      </g>
      <g transform="${s.body?.sit ?? ''}">
        <ellipse class="fur" cx="80" cy="70.5" rx="15" ry="7.5"/>
        <path class="fur" d="M69.5 73 C67.5 66 70.5 59 74.5 52.5 L85.5 52.5 C89.5 59 92.5 66 90.5 73Z"/>
        ${s.marks?.sit ?? ''}
        <path class="rim" d="M71 68 C71 63 72.5 58 75.5 54"/>
      </g>
      ${puff(s, 'sit')}
      <g class="legs-sit">
        <path d="M76.5 60 L76.3 76.6"/>
        <ellipse class="fur paw" cx="76" cy="77.2" rx="3" ry="1.5"/>
        <g class="leg-r"><path d="M83.5 60 L83.7 76.6"/><ellipse class="fur paw" cx="84" cy="77.2" rx="3" ry="1.5"/></g>
      </g>
      <path class="rim faint" d="M80 63 L80 76.5"/>
      <g class="outfit">
        <path class="shirt" d="M74.8 53 L85.2 53 L82.6 64.5 L80 66.5 L77.4 64.5Z"/>
        <path class="collar" d="M74.6 52.6 L80 56.4 L77.2 58.6Z M85.4 52.6 L80 56.4 L82.8 58.6Z"/>
        <path class="tie" d="M78.9 55.8 L81.1 55.8 L80.8 57.8 L79.2 57.8Z M79.2 57.8 L80.8 57.8 L81.9 65 L80 67.4 L78.1 65Z"/>
      </g>
      <g class="arms-up">
        <g class="arm-l"><path d="M74.5 55 L60.5 24"/><ellipse class="fur paw" cx="60" cy="22.6" rx="2.6" ry="3"/></g>
        <g class="arm-r"><path d="M85.5 55 L99.5 24"/><ellipse class="fur paw" cx="100" cy="22.6" rx="2.6" ry="3"/></g>
      </g>
      <g transform="translate(80 41) scale(1.15)"><g class="head-sit">${h}</g></g>
      <g class="hug">
        <path class="paper" d="M73.6 57.5 L86.2 56.6 L86.8 67.4 L74.2 68.2Z"/>
        <path class="scrawl" d="M76 60.5 L84 60 M76.2 63 L83 62.6 M76.4 65.5 L81 65.3"/>
        <ellipse class="fur paw" cx="74.2" cy="63" rx="2.7" ry="2.3"/>
        <ellipse class="fur paw" cx="86.4" cy="62.4" rx="2.7" ry="2.3"/>
      </g>
      <g class="desk">
        <path class="paper" d="M62 79.6 L92 79.6 L95 74.6 L66 74.6Z"/>
        <path class="scrawl" d="M69 77.8 L77 77.8 M70.5 76.3 L80.5 76.3 M68 79 L73 79"/>
        <path class="arm" d="M83.5 60 Q86.5 65 87.5 70.5"/>
        <g class="writing-paw">
          <path class="pencil" d="M88.6 70.2 L93 64"/>
          <path class="pencil-tip" d="M88.6 70.2 L87.9 71.6"/>
          <ellipse class="fur paw" cx="87.6" cy="71.4" rx="2.8" ry="1.8"/>
        </g>
      </g>
    </g>
    <g class="rig stand">
      ${tail(s, 'tail-stand', 'M48 53 C41 51 38 44 40 37 C41.5 31 38 27 34.5 28.5 C32 29.5 32.5 32.5 35 32')}
      <g class="leg leg-fb"><path d="M56 58 L58 67"/><g class="shin"><path d="M58 67 L56.8 76.3"/><ellipse cx="58.3" cy="77.1" rx="2.8" ry="1.5"/></g></g>
      <g class="leg leg-ff"><path d="M78 58 L78 67.5"/><g class="shin"><path d="M78 67.5 L78.5 76.3"/><ellipse cx="80.1" cy="77.1" rx="2.8" ry="1.5"/></g></g>
      <g class="torso">
        <g transform="${s.body?.stand ?? ''}">
          <path class="fur" d="M47 55 C45 48.5 50 45 58 45 C66 45 74 44.5 80 43.5 C85 43 89 45 89.5 49 C90 54 86 59.5 79 60.5 C71 61.5 62 61 55 61 C50 61 47.5 59 47 55Z"/>
          ${s.marks?.stand ?? ''}
          <path class="rim" d="M50 49 C55 46 64 45.5 72 45"/>
        </g>
        ${puff(s, 'stand')}
        <g transform="translate(88 36) scale(1.15)"><g class="head-stand">${h}</g></g>
      </g>
      <g class="leg near leg-nb"><ellipse class="fur" cx="52" cy="58" rx="5.5" ry="6"/><path d="M52 58 L54 67"/><g class="shin"><path d="M54 67 L52.8 76.3"/><ellipse class="fur paw" cx="54.3" cy="77.1" rx="2.8" ry="1.5"/></g></g>
      <g class="leg near leg-nf"><ellipse class="fur" cx="82" cy="58" rx="4" ry="5"/><path d="M82 58 L82 67.5"/><g class="shin"><path d="M82 67.5 L82.6 76.3"/><ellipse class="fur paw" cx="84.2" cy="77.1" rx="2.8" ry="1.5"/></g></g>
      <g class="yarn">
        <path class="strand" d="M98.5 75.5 C94 79 90 77 87 78"/>
        <g class="ball">
          <circle cx="104" cy="72" r="6"/>
          <path d="M99 69 Q104 74 109 70 M98.5 73 Q104 77 109.5 74 M101 67 Q106 71 107 77"/>
        </g>
      </g>
    </g>
  </g>
  ${s.deco ?? ''}
  <text class="bang" x="104" y="34">!</text>
  <path class="heart" d="M100 30 c-2 -3 -6 -1 -4 2 l4 4 l4 -4 c2 -3 -2 -5 -4 -2Z"/>
</svg>`;
}
