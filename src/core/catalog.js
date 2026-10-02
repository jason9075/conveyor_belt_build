// Static data: belt, the one item (logistics box), buildings.
// Building footprints are simplified.

export const ITEM_SPACING = 1.2; // m between logistics boxes
export const MAX_BELT_LENGTH = 56.001; // m, maximum belt segment length
export const PORT_HEIGHT = 1.0; // m above the building base

// One belt type for everything: 60 boxes/min.
export const BELT = { name: '輸送帶', rate: 60, color: '#d9a441' };
/** Belt speed in m/s: items/min ÷ 60 × spacing. */
export const BELT_SPEED = (BELT.rate / 60) * ITEM_SPACING;

// Everything on the belts is a logistics box.
export const ITEM = { name: '物流箱', color: '#c9a46a' };

export const WALL_THICKNESS = 0.5;
export const FLOOR_HEIGHT = 4; // one storey: a new wall's height, and what stacking a wall adds
export const POLE_MIN = 0.5; // lowest conveyor-pole connector height
export const POLE_STACK = 2; // m added by each stacked pole

// Facilities. Local frame: rot = 0 means the building's front faces +z. Ports: local [x, z] on the footprint edge,
// `y` above the building base (default PORT_HEIGHT), normal points outward. `dir` is the box flow direction relative to the building.
//   source (供箱口)  boxes enter the conveyor network here: receiving dock, upstream line…
//   sink   (收箱口)  boxes leave it: packing station, shipping dock, storage inlet…
export const BUILDINGS = {
  source: {
    name: '供箱口',
    short: '供',
    kind: 'source',
    size: [2, 1, 2.4],
    color: '#c46a2b',
    ports: [{ local: [0, 0.5], normal: [0, 1], dir: 'out', clearance: 0.3 }],
    defaults: { rate: 60 },
  },
  sink: {
    name: '收箱口',
    short: '收',
    kind: 'sink',
    size: [2, 1, 2.4],
    color: '#2f8f6a',
    ports: [{ local: [0, 0.5], normal: [0, 1], dir: 'in', clearance: 0.3 }],
    defaults: { rate: 0 },
  },
  splitter: {
    name: '分流器',
    short: '分',
    kind: 'splitter',
    size: [2, 2, 1.6],
    color: '#c9a227',
    stackOn: ['splitter', 'merger'], // can sit on top of these, as a second layer
    ports: [
      { local: [0, -1], normal: [0, -1], dir: 'in', clearance: 0 },
      { local: [0, 1], normal: [0, 1], dir: 'out', clearance: 0 },
      { local: [-1, 0], normal: [-1, 0], dir: 'out', clearance: 0 },
      { local: [1, 0], normal: [1, 0], dir: 'out', clearance: 0 },
    ],
    defaults: {},
  },
  merger: {
    name: '集合器',
    short: '集',
    kind: 'merger',
    size: [2, 2, 1.6],
    color: '#3d8fc9',
    stackOn: ['splitter', 'merger'],
    ports: [
      { local: [0, -1], normal: [0, -1], dir: 'in', clearance: 0 },
      { local: [-1, 0], normal: [-1, 0], dir: 'in', clearance: 0 },
      { local: [1, 0], normal: [1, 0], dir: 'in', clearance: 0 },
      { local: [0, 1], normal: [0, 1], dir: 'out', clearance: 0 },
    ],
    defaults: {},
  },
  // Conveyor pole: a belt connector held up at `height`; belts pass through it (one in, one out).
  pole: {
    name: '貨架',
    short: '架',
    kind: 'pole',
    size: [0.8, 0.8, 2], // height comes from config.height; see buildingSize / portDefs
    color: '#7d8894',
    stackOn: ['pole'],
    ports: [],
    defaults: { height: 2 },
  },
  wall: {
    name: '牆壁',
    short: '牆',
    kind: 'wall',
    // size and ports come from the config (length, height, holes); see buildingSize / portDefs
    size: [8, WALL_THICKNESS, FLOOR_HEIGHT],
    color: '#8d949c',
    stackOn: ['wall'], // another storey on top
    ports: [],
    defaults: { length: 8, height: FLOOR_HEIGHT, holes: [] },
  },
};

export const BUILDING_ORDER = ['source', 'sink', 'splitter', 'merger', 'pole', 'wall'];

// ------------------------------------------------------------------ walls & holes
//
// A wall is a straight slab along its local x axis. Each hole sits on one face (`side` +1 = front/+z,
// −1 = back) at `offset` metres from the centre and `y` metres above the wall's base (the belt height
// there), and works like a source (dir 'out': rate) or a sink (dir 'in': rate
// limit, 0 = unlimited). Port index i of a wall is hole i.

export const WALL_MIN_LENGTH = 1;
export const WALL_MAX_LENGTH = 60;
export const HOLE_WIDTH = 1.2; // also the minimum spacing between hole centres
export const HOLE_MARGIN = HOLE_WIDTH / 2; // hole centre to wall end
export const HOLE_HEIGHT = 1.2; // minimum vertical spacing between stacked holes
export const HOLE_MIN_Y = 0.5; // lowest belt height of a hole above the wall base
export const HOLE_TOP = 0.7; // opening above the belt height; the wall must reach y + HOLE_TOP
export const holeY = (h) => h.y ?? PORT_HEIGHT;
export const holeSide = (h) => h.side ?? 1;

/** Palette tools that punch a hole into a wall. */
export const HOLE_TOOLS = [
  { dir: 'out', name: '供箱洞口', short: '供', color: '#c46a2b' },
  { dir: 'in', name: '收箱洞口', short: '收', color: '#2f8f6a' },
];

/** What a hole does, in warehouse terms: 'out' puts boxes onto a belt, 'in' takes them off. */
export const HOLE_LABEL = { out: '供箱', in: '收箱' };

export function newHole(dir, offset = 0, y = PORT_HEIGHT, side = 1) {
  return { dir, offset, y, side, rate: dir === 'out' ? 60 : 0 };
}

/** Footprint [width x, depth z, height y] of a building instance ({ type, config }). */
export function buildingSize(b) {
  const def = BUILDINGS[b.type];
  if (def.kind === 'pole') return [def.size[0], def.size[1], b.config?.height ?? def.defaults.height];
  if (def.kind !== 'wall') return def.size;
  const c = { ...def.defaults, ...b.config };
  // `length` runs between the two clicked end points along the centreline; the slab reaches half a
  // thickness past each end, so two walls meeting at a corner close it without a notch.
  return [c.length + WALL_THICKNESS, WALL_THICKNESS, c.height];
}

/** Local port definitions of a building instance. */
export function portDefs(b) {
  const def = BUILDINGS[b.type];
  if (def.kind === 'pole') {
    const y = b.config?.height ?? def.defaults.height;
    return [
      { local: [0, -0.4], y, normal: [0, -1], dir: 'in', clearance: 0 },
      { local: [0, 0.4], y, normal: [0, 1], dir: 'out', clearance: 0 },
    ];
  }
  if (def.kind !== 'wall') return def.ports;
  return (b.config?.holes ?? []).map((h) => {
    const side = holeSide(h);
    return { local: [h.offset, (side * WALL_THICKNESS) / 2], y: holeY(h), normal: [0, side], dir: h.dir, clearance: 0.3 };
  });
}

/** Holes of a source, sink or wall (index = port index); null for other buildings. */
export function holesOf(b) {
  const kind = BUILDINGS[b.type].kind;
  if (kind === 'source') return [{ dir: 'out', rate: b.config.rate }];
  if (kind === 'sink') return [{ dir: 'in', rate: b.config.rate }];
  if (kind === 'wall') return b.config.holes;
  return null;
}

/** Changes whenever a building's mesh has to be rebuilt. */
export function shapeKey(b) {
  if (BUILDINGS[b.type].kind === 'pole') return `pole|${b.config?.height}`;
  if (BUILDINGS[b.type].kind !== 'wall') return b.type;
  const c = b.config;
  return `wall|${c.length}|${c.height}|${c.holes.map((h) => `${h.offset}:${holeY(h)}:${holeSide(h)}${h.dir}`).join(',')}`;
}
