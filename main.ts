// Pintu — a doorway-decomposition Sokoban solver.
//
// Idea: every level is a 1-wide hallway with the player on it, plus 1-4
// small rooms hanging off the hallway through a single door each. A box
// pushed out of its room through the door can never come back, so every
// box stays in its own room and the whole level splits into independent
// per-room problems. Each room (3-4 boxes in a 6x6 slot) is solved exactly
// with an A* search over pushes, then the room solutions are stitched
// together with plain hallway walks. Push-optimal per room means
// push-optimal for the level, because the rooms never interact. The
// last room solved needs no exit — a room's optimum may end with the
// player inside it — so the solver tries each room as the last one
// (rightmost first) until a full replay verifies.
//
// The search itself is the classic push-space A*:
//   * state = sorted box cells + the player's canonical cell, where the
//     player is canonicalised to the lowest cell of the flood-fill region
//     they can reach without pushing (walking is free, only pushes cost);
//   * admissible heuristic = minimum-cost matching of boxes to goals
//     (brute-force permutations, at most 4 boxes) over BFS distances that
//     ignore boxes;
//   * static dead squares (corners, wall runs with no goal on them) plus
//     dynamic 2x2 frozen-block checks prune hopeless states;
//   * a binary heap, a transposition table keyed on the full state, and
//     fixed node-expansion budgets only — no wall clock anywhere, so two
//     runs on the same input write byte-identical output.
//
// Node 22 strips TypeScript types natively (erasable syntax only here),
// Node built-ins only, no dependencies, no network, no randomness.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed work budgets (node expansions). Deterministic: never a clock.
const ROOM_BUDGET = 1200000;
const ROOM_BUDGET_RETRY = 4000000;
const WHOLE_LEVEL_BUDGET = 400000;

const DIRS: { dx: number; dy: number; ch: string }[] = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

interface Push {
  box: number;
  dir: number; // index into DIRS
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(0, ...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

// Breadth-first flood fill over cells where open[i] is true, starting at
// `from`, with the cells in `blocked` treated as walls. Returns a Uint8Array
// marking the reachable region.
function flood(
  w: number,
  h: number,
  open: Uint8Array,
  blocked: Uint8Array | null,
  from: number,
): Uint8Array {
  const seen = new Uint8Array(w * h);
  if (from < 0 || !open[from] || (blocked !== null && blocked[from])) return seen;
  const queue: number[] = [from];
  seen[from] = 1;
  let head = 0;
  while (head < queue.length) {
    const c = queue[head++];
    const x = c % w;
    const y = (c / w) | 0;
    if (x > 0) {
      const n = c - 1;
      if (!seen[n] && open[n] && (!blocked || !blocked[n])) { seen[n] = 1; queue.push(n); }
    }
    if (x + 1 < w) {
      const n = c + 1;
      if (!seen[n] && open[n] && (!blocked || !blocked[n])) { seen[n] = 1; queue.push(n); }
    }
    if (y > 0) {
      const n = c - w;
      if (!seen[n] && open[n] && (!blocked || !blocked[n])) { seen[n] = 1; queue.push(n); }
    }
    if (y + 1 < h) {
      const n = c + w;
      if (!seen[n] && open[n] && (!blocked || !blocked[n])) { seen[n] = 1; queue.push(n); }
    }
  }
  return seen;
}

// Shortest walking path from `from` to `to` over cells where open[i] is true
// and blocked[i] is false. Returns the move string, or null if unreachable.
function findPath(
  w: number,
  h: number,
  open: Uint8Array,
  blocked: Uint8Array | null,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-2);
  const prevDir = new Int8Array(w * h);
  const queue: number[] = [from];
  prev[from] = -1;
  let head = 0;
  while (head < queue.length) {
    const c = queue[head++];
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d].dx;
      const ny = y + DIRS[d].dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (prev[n] !== -2 || !open[n] || (blocked !== null && blocked[n])) continue;
      prev[n] = c;
      prevDir[n] = d;
      if (n === to) {
        let out = '';
        let cur = n;
        while (cur !== from) {
          out = DIRS[prevDir[cur]].ch + out;
          cur = prev[cur];
        }
        return out;
      }
      queue.push(n);
    }
  }
  return null;
}

// BFS distances from `from` over cells where open[i] is true.
function bfsDistances(
  w: number,
  h: number,
  open: Uint8Array,
  from: number,
): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  const queue: number[] = [from];
  dist[from] = 0;
  let head = 0;
  while (head < queue.length) {
    const c = queue[head++];
    const x = c % w;
    const y = (c / w) | 0;
    const nd = dist[c] + 1;
    if (x > 0 && dist[c - 1] < 0 && open[c - 1]) { dist[c - 1] = nd; queue.push(c - 1); }
    if (x + 1 < w && dist[c + 1] < 0 && open[c + 1]) { dist[c + 1] = nd; queue.push(c + 1); }
    if (y > 0 && dist[c - w] < 0 && open[c - w]) { dist[c - w] = nd; queue.push(c - w); }
    if (y + 1 < h && dist[c + w] < 0 && open[c + w]) { dist[c + w] = nd; queue.push(c + w); }
  }
  return dist;
}

function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Uint8Array(n);
  const rec = (): void => {
    if (cur.length === n) { out.push(cur.slice()); return; }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = 1;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = 0;
    }
  };
  rec();
  return out;
}

// A binary min-heap of node indices, ordered by (f, h, insertion order).
class Heap {
  private items: number[] = [];
  private f: number[];
  private hh: number[];
  private seq: number[];
  constructor(f: number[], hh: number[], seq: number[]) {
    this.f = f;
    this.hh = hh;
    this.seq = seq;
  }
  get size(): number { return this.items.length; }
  private less(a: number, b: number): boolean {
    if (this.f[a] !== this.f[b]) return this.f[a] < this.f[b];
    if (this.hh[a] !== this.hh[b]) return this.hh[a] < this.hh[b];
    return this.seq[a] < this.seq[b];
  }
  push(idx: number): void {
    const items = this.items;
    items.push(idx);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(items[i], items[p])) break;
      const t = items[i]; items[i] = items[p]; items[p] = t;
      i = p;
    }
  }
  pop(): number {
    const items = this.items;
    const top = items[0];
    const last = items.pop() as number;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.less(items[l], items[m])) m = l;
        if (r < items.length && this.less(items[r], items[m])) m = r;
        if (m === i) break;
        const t = items[i]; items[i] = items[m]; items[m] = t;
        i = m;
      }
    }
    return top;
  }
}

interface SearchSpace {
  // Cells a box may ever occupy.
  boxCells: Uint8Array;
  // Cells the player may ever occupy.
  playerCells: Uint8Array;
  goals: number[];
  boxes: number[];
  startPlayer: number;
  // Cells the player must be able to reach once all boxes are on goals
  // (the room's door cells; empty means no exit is required).
  exitCells: number[];
}

// Push-optimal A* over one search space. Returns the push list, or null
// when the fixed expansion budget runs out (or no solution exists).
function solvePushes(lv: Level, sp: SearchSpace, budget: number): Push[] | null {
  const { w, h } = lv;
  const n = sp.boxes.length;
  const goalSet = new Uint8Array(w * h);
  for (const g of sp.goals) goalSet[g] = 1;
  const exitSet = new Uint8Array(w * h);
  for (const e of sp.exitCells) exitSet[e] = 1;

  // ---- static dead squares -------------------------------------------
  // A non-goal cell is dead when a box there can never reach a goal.
  // Computed by reverse "pull" reachability: start from the goals, and
  // walk backwards along pushes. A forward push moves a box from b to
  // t = b + d with the player stepping from b - d to b; so from a live
  // cell t, the predecessor b = t - d is live whenever the player could
  // step back to s = t - 2d, i.e. s is a non-wall cell. This
  // over-approximates the live cells (the player's reach to s is
  // ignored), so a cell it leaves unmarked is truly dead; corners and
  // goal-less wall runs fall out of it naturally. Door cells are exempt
  // on top: a box on a door can always be pushed back into the room
  // from the hallway side.
  const dead = new Uint8Array(w * h);
  const live = new Uint8Array(w * h);
  const liveQueue: number[] = [];
  for (const g of sp.goals) {
    live[g] = 1;
    liveQueue.push(g);
  }
  let lhead = 0;
  while (lhead < liveQueue.length) {
    const t = liveQueue[lhead++];
    const tx = t % w;
    const ty = (t / w) | 0;
    for (let d = 0; d < 4; d++) {
      const bx = tx - DIRS[d].dx;
      const by = ty - DIRS[d].dy;
      if (bx < 0 || bx >= w || by < 0 || by >= h) continue;
      const b = by * w + bx;
      if (!sp.boxCells[b] || live[b]) continue;
      const sx = tx - 2 * DIRS[d].dx;
      const sy = ty - 2 * DIRS[d].dy;
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
      if (lv.wall[sy * w + sx]) continue;
      live[b] = 1;
      liveQueue.push(b);
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (sp.boxCells[i] && !live[i] && !goalSet[i] && !exitSet[i]) dead[i] = 1;
  }

  // ---- heuristic: min-cost box->goal matching -------------------------
  // distGoal[g][cell] = BFS distance from goal g through box cells.
  const distGoal: Int32Array[] = sp.goals.map((g) => bfsDistances(w, h, sp.boxCells, g));
  const perms = permutations(n);
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let sum = 0;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const d = distGoal[p[i]][boxes[i]];
        if (d < 0) { ok = false; break; }
        sum += d;
      }
      if (ok && sum < best) best = sum;
    }
    return best;
  };

  // ---- dynamic deadlock: 2x2 frozen blocks ---------------------------
  const frozen = (boxes: number[]): boolean => {
    const boxSet = new Uint8Array(w * h);
    for (const b of boxes) boxSet[b] = 1;
    const solid = (c: number): boolean => {
      if (c < 0 || c >= w * h) return true;
      return lv.wall[c] === 1 || boxSet[c] === 1;
    };
    for (const b of boxes) {
      if (goalSet[b]) continue;
      const x = b % w;
      const y = (b / w) | 0;
      for (let dy = -1; dy <= 0; dy++) {
        for (let dx = -1; dx <= 0; dx++) {
          const x0 = x + dx;
          const y0 = y + dy;
          if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
          const a = y0 * w + x0;
          const cells = [a, a + 1, a + w, a + w + 1];
          let allSolid = true;
          let hasBox = false;
          for (const c of cells) {
            if (!solid(c)) { allSolid = false; break; }
            if (boxSet[c]) hasBox = true;
          }
          if (allSolid && hasBox) return true;
        }
      }
    }
    return false;
  };

  const canonical = (boxes: number[], player: number): number => {
    const boxBlocked = new Uint8Array(w * h);
    for (const b of boxes) boxBlocked[b] = 1;
    const region = flood(w, h, sp.playerCells, boxBlocked, player);
    for (let i = 0; i < w * h; i++) if (region[i]) return i;
    return player;
  };

  const keyOf = (boxes: number[], canon: number): string =>
    boxes.join(',') + '|' + canon;

  // ---- A* -------------------------------------------------------------
  const startBoxes = sp.boxes.slice().sort((a, b) => a - b);
  for (const b of startBoxes) if (dead[b]) return null;
  const startCanon = canonical(startBoxes, sp.startPlayer);
  const startH = heuristic(startBoxes);
  if (startH === Infinity) return null;

  const nodeBoxes: number[][] = [startBoxes];
  const nodePlayer: number[] = [startCanon];
  const nodeG: number[] = [0];
  const nodeF: number[] = [startH];
  const nodeH: number[] = [startH];
  const nodeSeq: number[] = [0];
  const nodeParent: number[] = [-1];
  const nodePush: (Push | null)[] = [null];
  const closed = new Map<string, number>();
  closed.set(keyOf(startBoxes, startCanon), 0);
  const heap = new Heap(nodeF, nodeH, nodeSeq);
  heap.push(0);
  let seq = 1;
  let expansions = 0;

  while (heap.size > 0) {
    const idx = heap.pop();
    const boxes = nodeBoxes[idx];
    const g = nodeG[idx];
    const canon = nodePlayer[idx];
    const key = keyOf(boxes, canon);
    if ((closed.get(key) ?? Infinity) < g) continue; // stale entry
    expansions++;
    if (expansions > budget) return null;

    // Goal test: every box on a goal and the player can reach an exit.
    let solved = true;
    for (const b of boxes) if (!goalSet[b]) { solved = false; break; }
    if (solved) {
      if (sp.exitCells.length > 0) {
        const boxBlocked = new Uint8Array(w * h);
        for (const b of boxes) boxBlocked[b] = 1;
        const region = flood(w, h, sp.playerCells, boxBlocked, canon);
        let canExit = false;
        for (const e of sp.exitCells) if (region[e]) { canExit = true; break; }
        if (!canExit) solved = false;
      }
      if (solved) {
        const pushes: Push[] = [];
        let cur = idx;
        while (nodeParent[cur] >= 0) {
          pushes.push(nodePush[cur] as Push);
          cur = nodeParent[cur];
        }
        pushes.reverse();
        return pushes;
      }
    }

    // Player's reachable region (boxes are walls).
    const boxBlocked = new Uint8Array(w * h);
    for (const b of boxes) boxBlocked[b] = 1;
    const region = flood(w, h, sp.playerCells, boxBlocked, canon);

    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi];
      const bx = b % w;
      const by = (b / w) | 0;
      for (let d = 0; d < 4; d++) {
        const sx = bx - DIRS[d].dx;
        const sy = by - DIRS[d].dy;
        const tx = bx + DIRS[d].dx;
        const ty = by + DIRS[d].dy;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        const stance = sy * w + sx;
        const target = ty * w + tx;
        if (!sp.playerCells[stance] || !region[stance]) continue;
        if (!sp.boxCells[target] || boxBlocked[target]) continue;
        const nextBoxes = boxes.slice();
        nextBoxes[bi] = target;
        nextBoxes.sort((a, b2) => a - b2);
        if (dead[target]) continue;
        if (frozen(nextBoxes)) continue;
        const nextH = heuristic(nextBoxes);
        if (nextH === Infinity) continue;
        const nextCanon = canonical(nextBoxes, b);
        const ng = g + 1;
        const nkey = keyOf(nextBoxes, nextCanon);
        if ((closed.get(nkey) ?? Infinity) <= ng) continue;
        closed.set(nkey, ng);
        nodeBoxes.push(nextBoxes);
        nodePlayer.push(nextCanon);
        nodeG.push(ng);
        nodeF.push(ng + nextH);
        nodeH.push(nextH);
        nodeSeq.push(seq++);
        nodeParent.push(idx);
        nodePush.push({ box: b, dir: d });
        heap.push(nodeBoxes.length - 1);
      }
    }
  }
  return null;
}

interface Room {
  cells: number[];
  cellSet: Uint8Array;
  goals: number[];
  boxes: number[];
  doors: number[];
  entries: number[];
}

// Split a level into hallway + rooms. Returns null when the level does not
// have the expected hallway-and-rooms shape.
function decompose(lv: Level): { hallway: Uint8Array; rooms: Room[] } | null {
  const { w, h } = lv;
  if (lv.player < 0) return null;
  const hy = (lv.player / w) | 0;
  const hallway = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const c = hy * w + x;
    if (!lv.wall[c]) hallway[c] = 1;
  }
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  for (let i = 0; i < w * h; i++) {
    if (lv.wall[i] || hallway[i] || seen[i]) continue;
    // One connected component of non-hallway open floor = one room.
    const cells: number[] = [];
    const queue: number[] = [i];
    seen[i] = 1;
    let head = 0;
    while (head < queue.length) {
      const c = queue[head++];
      cells.push(c);
      const x = c % w;
      const y = (c / w) | 0;
      const nb = [
        x > 0 ? c - 1 : -1,
        x + 1 < w ? c + 1 : -1,
        y > 0 ? c - w : -1,
        y + 1 < h ? c + w : -1,
      ];
      for (const n2 of nb) {
        if (n2 >= 0 && !lv.wall[n2] && !hallway[n2] && !seen[n2]) {
          seen[n2] = 1;
          queue.push(n2);
        }
      }
    }
    const cellSet = new Uint8Array(w * h);
    for (const c of cells) cellSet[c] = 1;
    const goals: number[] = [];
    const boxes: number[] = [];
    const doors: number[] = [];
    const entries: number[] = [];
    for (const c of cells) {
      if (lv.goal[c]) goals.push(c);
      if (lv.boxes.includes(c)) boxes.push(c);
      const x = c % w;
      const y = (c / w) | 0;
      const nb = [
        x > 0 ? c - 1 : -1,
        x + 1 < w ? c + 1 : -1,
        y > 0 ? c - w : -1,
        y + 1 < h ? c + w : -1,
      ];
      for (const n2 of nb) if (n2 >= 0 && hallway[n2]) doors.push(c);
    }
    // Entries: hallway cells touching this room.
    const entrySet = new Set<number>();
    for (const c of cells) {
      const x = c % w;
      const y = (c / w) | 0;
      const nb = [
        x > 0 ? c - 1 : -1,
        x + 1 < w ? c + 1 : -1,
        y > 0 ? c - w : -1,
        y + 1 < h ? c + w : -1,
      ];
      for (const n2 of nb) if (n2 >= 0 && hallway[n2]) entrySet.add(n2);
    }
    for (const e of entrySet) entries.push(e);
    rooms.push({ cells, cellSet, goals, boxes, doors, entries });
  }
  if (rooms.length === 0) return null;
  for (const r of rooms) {
    if (r.boxes.length === 0 || r.goals.length !== r.boxes.length) return null;
    if (r.doors.length === 0 || r.entries.length === 0) return null;
  }
  // Fixed order: left to right by door column, then by row.
  rooms.sort((a, b) => {
    const ax = Math.min(...a.doors.map((c) => c % w));
    const bx = Math.min(...b.doors.map((c) => c % w));
    if (ax !== bx) return ax - bx;
    const ay = Math.min(...a.doors.map((c) => (c / w) | 0));
    const by = Math.min(...b.doors.map((c) => (c / w) | 0));
    return ay - by;
  });
  return { hallway, rooms };
}

// Expand one room's push list into player moves, starting with the player
// at `entry`. Mutates `boxes` (the room's live box cells) and returns the
// move string, or null when a push cannot be reached (should not happen).
function expandRoom(
  lv: Level,
  room: Room,
  entry: number,
  pushes: Push[],
  boxes: number[],
): string | null {
  const { w, h } = lv;
  const playerCells = room.cellSet.slice();
  playerCells[entry] = 1;
  let player = entry;
  let out = '';
  for (const p of pushes) {
    const boxSet = new Uint8Array(w * h);
    for (const b of boxes) boxSet[b] = 1;
    const stance = p.box - (DIRS[p.dir].dy * w + DIRS[p.dir].dx);
    const path = findPath(w, h, playerCells, boxSet, player, stance);
    if (path === null) return null;
    out += path;
    player = stance;
    out += DIRS[p.dir].ch;
    const bi = boxes.indexOf(p.box);
    if (bi < 0) return null;
    boxes[bi] = p.box + (DIRS[p.dir].dy * w + DIRS[p.dir].dx);
    player = p.box;
  }
  return out;
}

// Replay a move string on the level; returns true only if it is legal and
// leaves every box on a goal.
function replay(lv: Level, moves: string): boolean {
  const { w } = lv;
  const box = new Uint8Array(w * lv.h);
  for (const b of lv.boxes) box[b] = 1;
  let player = lv.player;
  for (const ch of moves) {
    const d = DIRS.find((dd) => dd.ch === ch);
    if (!d) return false;
    const next = player + (d.dy * w + d.dx);
    if (lv.wall[next]) return false;
    if (box[next]) {
      const beyond = next + (d.dy * w + d.dx);
      if (lv.wall[beyond] || box[beyond]) return false;
      box[next] = 0;
      box[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !lv.goal[i]) return false;
  return true;
}

function goalCellsOf(lv: Level): number[] {
  const out: number[] = [];
  for (let i = 0; i < lv.goal.length; i++) if (lv.goal[i]) out.push(i);
  return out;
}

function solveWholeLevel(lv: Level): string | null {
  const all = new Uint8Array(lv.w * lv.h);
  for (let i = 0; i < all.length; i++) if (!lv.wall[i]) all[i] = 1;
  const pushes = solvePushes(
    lv,
    { boxCells: all, playerCells: all, goals: goalCellsOf(lv), boxes: lv.boxes.slice(), startPlayer: lv.player, exitCells: [] },
    WHOLE_LEVEL_BUDGET,
  );
  if (pushes === null) return null;
  // Expand pushes into moves on the whole board.
  const boxes = lv.boxes.slice();
  let player = lv.player;
  let out = '';
  for (const p of pushes) {
    const boxSet = new Uint8Array(lv.w * lv.h);
    for (const b of boxes) boxSet[b] = 1;
    const stance = p.box - (DIRS[p.dir].dy * lv.w + DIRS[p.dir].dx);
    const path = findPath(lv.w, lv.h, all, boxSet, player, stance);
    if (path === null) return null;
    out += path;
    player = stance;
    out += DIRS[p.dir].ch;
    const bi = boxes.indexOf(p.box);
    if (bi < 0) return null;
    boxes[bi] = p.box + (DIRS[p.dir].dy * lv.w + DIRS[p.dir].dx);
    player = p.box;
  }
  return out;
}

// One attempt at stitching a level: solve the rooms in `order`, requiring
// the player to walk back out through the door of every room except the
// last one in the order. The last room needs no exit — a room's
// push-optimal solution may end with the player inside it — so the room
// solved last is the one whose optimum is taken without an exit
// constraint, exactly as the level's P* is built from per-room optima.
// Returns the full move string, or null when any step fails.
function attemptSolve(
  lv: Level,
  hallway: Uint8Array,
  rooms: Room[],
  lastIdx: number,
): string | null {
  const { w, h } = lv;
  const order = rooms.filter((_, i) => i !== lastIdx);
  order.push(rooms[lastIdx]);
  let player = lv.player;
  let moves = '';
  for (let oi = 0; oi < order.length; oi++) {
    const room = order[oi];
    const isLast = oi === order.length - 1;
    // Walk the hallway to the entry cell nearest the player.
    let bestEntry = -1;
    let bestPath: string | null = null;
    for (const e of room.entries) {
      const path = findPath(w, h, hallway, null, player, e);
      if (path !== null && (bestPath === null || path.length < bestPath.length)) {
        bestPath = path;
        bestEntry = e;
      }
    }
    if (bestEntry < 0 || bestPath === null) return null;
    const playerCells = room.cellSet.slice();
    playerCells[bestEntry] = 1;
    const space = {
      boxCells: room.cellSet,
      playerCells,
      goals: room.goals,
      boxes: room.boxes.slice(),
      startPlayer: bestEntry,
      exitCells: isLast ? [] : room.doors,
    };
    let pushes = solvePushes(lv, space, ROOM_BUDGET);
    if (pushes === null) pushes = solvePushes(lv, space, ROOM_BUDGET_RETRY);
    if (pushes === null) return null;
    const roomBoxes = room.boxes.slice();
    const roomMoves = expandRoom(lv, room, bestEntry, pushes, roomBoxes);
    if (roomMoves === null) return null;
    moves += bestPath;
    player = bestEntry;
    moves += roomMoves;
    player = pushes.length > 0 ? pushes[pushes.length - 1].box : bestEntry;
    if (isLast) break; // Level complete; the player stays in the last room.
    // Walk out of the room through its door back to the hallway.
    const boxSet = new Uint8Array(w * h);
    for (const b of roomBoxes) boxSet[b] = 1;
    const exitCells = room.cellSet.slice();
    exitCells[bestEntry] = 1;
    let exitPath: string | null = null;
    let exitDoor = -1;
    for (const door of room.doors) {
      const path = findPath(w, h, exitCells, boxSet, player, door);
      if (path !== null && (exitPath === null || path.length < exitPath.length)) {
        exitPath = path;
        exitDoor = door;
      }
    }
    if (exitPath === null || exitDoor < 0) return null;
    moves += exitPath;
    const dx = (bestEntry % w) - (exitDoor % w);
    const dy = ((bestEntry / w) | 0) - ((exitDoor / w) | 0);
    const step = DIRS.find((d) => d.dx === dx && d.dy === dy);
    if (!step) return null;
    moves += step.ch;
    player = bestEntry;
  }
  return replay(lv, moves) ? moves : null;
}

function solveLevel(text: string): string {
  let lv: Level;
  try {
    lv = parseLevel(text);
  } catch {
    return '';
  }
  if (lv.player < 0 || lv.boxes.length === 0) return '';

  const dec = decompose(lv);
  if (dec !== null) {
    const { hallway, rooms } = dec;
    // First try the natural order (rightmost room last), then every other
    // room as the last one — a room whose optimum ends with the player
    // trapped inside can only be solved last.
    const lastOrder = [rooms.length - 1];
    for (let i = 0; i < rooms.length; i++) {
      if (i !== rooms.length - 1) lastOrder.push(i);
    }
    for (const lastIdx of lastOrder) {
      const moves = attemptSolve(lv, hallway, rooms, lastIdx);
      if (moves !== null) return moves;
    }
    return '';
  }

  // Fallback: whole-level push A* (only when the level has no clean
  // hallway-and-rooms shape).
  const whole = solveWholeLevel(lv);
  if (whole !== null && replay(lv, whole)) return whole;
  return '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    const text = readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8');
    moves = solveLevel(text);
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
