// Sokoban solver — account 2 (Orochim25).
// Angle: decompose into rooms, then 0-1 BFS push search per room.
// State = sorted box positions + FULL player position. Walk steps cost 0,
// pushes cost 1, so the first goal state dequeued is push-optimal.
// Deterministic: no randomness, no clock, fixed iteration orders everywhere.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: 1, dy: 0, ch: 'r' },
];

interface Level {
  w: number;
  h: number;
  wall: boolean[];
  goal: boolean[];
  boxes: number[];
  player: number;
}

interface Room {
  cells: boolean[]; // room floor cells (global indices)
  door: number; // door cell (a room cell)
  entry: number; // hallway cell adjacent to the door
  boxes: number[]; // initial boxes inside the room
  goals: number[]; // goals inside the room
}

interface RoomSol {
  moves: string; // from entry cell back to entry cell (room solved)
  pushes: number;
  finalBoxes: number[];
  exitWalkLen: number; // walks spent leaving the room (door + step out)
}

function parseLevel(text: string): Level {
  const raw = text.split('\n').map((l) => l.replace(/\r$/, ''));
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const h = raw.length;
  const w = Math.max(...raw.map((l) => l.length));
  const wall = new Array<boolean>(w * h).fill(true);
  const goal = new Array<boolean>(w * h).fill(false);
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = x < raw[y].length ? raw[y][x] : '#';
      const i = y * w + x;
      if (c === '#') continue;
      wall[i] = false;
      if (c === '.' || c === '*' || c === '+') goal[i] = true;
      if (c === '$' || c === '*') boxes.push(i);
      if (c === '@' || c === '+') player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

function step(lv: Level, cell: number, d: number): number {
  const x = cell % lv.w;
  const y = (cell / lv.w) | 0;
  const nx = x + DIRS[d].dx;
  const ny = y + DIRS[d].dy;
  if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) return -1;
  return ny * lv.w + nx;
}

function cellXY(lv: Level, cell: number): [number, number] {
  return [cell % lv.w, (cell / lv.w) | 0];
}

// Small deque (front = pop side). Stores objects, no index arithmetic tricks.
class Deque<T> {
  private a: (T | undefined)[] = new Array(1024);
  private h = 512;
  private t = 512;
  get size(): number {
    return this.t - this.h;
  }
  pushBack(v: T): void {
    if (this.t === this.a.length) this.grow();
    this.a[this.t++] = v;
  }
  pushFront(v: T): void {
    if (this.h === 0) this.grow();
    this.a[--this.h] = v;
  }
  popFront(): T {
    const v = this.a[this.h];
    this.a[this.h] = undefined;
    this.h++;
    return v as T;
  }
  private grow(): void {
    const n: (T | undefined)[] = new Array(this.a.length * 2);
    const s = this.t - this.h;
    const off = (n.length - s) >> 1;
    for (let i = 0; i < s; i++) n[off + i] = this.a[this.h + i];
    this.a = n;
    this.h = off;
    this.t = off + s;
  }
}

// Dead squares: reverse "pull" BFS from the goals over the given cells.
// A box on a cell this cannot reach can never be pushed to a goal.
function computeDead(lv: Level, cells: boolean[], goals: number[]): boolean[] {
  const reach = new Array<boolean>(lv.w * lv.h).fill(false);
  const q: number[] = [];
  for (const g of goals) {
    reach[g] = true;
    q.push(g);
  }
  for (let qi = 0; qi < q.length; qi++) {
    const b = q[qi];
    for (let d = 0; d < 4; d++) {
      const n = step(lv, b, d);
      if (n < 0 || !cells[n]) continue;
      const beyond = step(lv, n, d);
      if (beyond < 0 || !cells[beyond]) continue;
      if (!reach[n]) {
        reach[n] = true;
        q.push(n);
      }
    }
  }
  const dead = new Array<boolean>(lv.w * lv.h).fill(false);
  for (let i = 0; i < cells.length; i++) if (cells[i] && !reach[i]) dead[i] = true;
  return dead;
}

// Is the 2x2 square with top-left (sx, sy) a frozen block? All four cells
// blocked (wall, box, or outside the room and not the entry cell) and at
// least one box on a non-goal cell inside it. Such a box can never move:
// pushes out of the square need the player standing inside it (blocked),
// pushes inside the square hit a blocked cell.
function squareFrozen(
  lv: Level,
  boxes: number[],
  roomCells: boolean[],
  entry: number,
  sx: number,
  sy: number,
): boolean {
  let hasStuckBox = false;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const x = sx + dx;
      const y = sy + dy;
      if (x < 0 || y < 0 || x >= lv.w || y >= lv.h) continue; // outside grid = wall = blocked
      const c = y * lv.w + x;
      const isBox = boxes.indexOf(c) >= 0;
      const blocked =
        lv.wall[c] || isBox || (!roomCells[c] && c !== entry);
      if (!blocked) return false;
      if (isBox && !lv.goal[c]) hasStuckBox = true;
    }
  }
  return hasStuckBox;
}

// Does pushing a box onto cell nb create a frozen 2x2? Only squares
// containing nb can newly freeze.
function createsFrozen2x2(
  lv: Level,
  boxes: number[],
  roomCells: boolean[],
  entry: number,
  nb: number,
): boolean {
  const [x, y] = cellXY(lv, nb);
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      if (squareFrozen(lv, boxes, roomCells, entry, x + dx, y + dy)) return true;
    }
  }
  return false;
}

// BFS walk from `from` to `to` over floor cells not in `blocked`.
// Returns the move string, or null when unreachable. Fixed dir order.
function bfsWalk(
  lv: Level,
  from: number,
  to: number,
  blocked: Set<number>,
): string | null {
  if (from === to) return '';
  const prev = new Map<number, { p: number; mv: string }>();
  const q: number[] = [from];
  prev.set(from, { p: -1, mv: '' });
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let d = 0; d < 4; d++) {
      const n = step(lv, c, d);
      if (n < 0 || lv.wall[n] || blocked.has(n) || prev.has(n)) continue;
      prev.set(n, { p: c, mv: DIRS[d].ch });
      if (n === to) {
        const out: string[] = [];
        let cur = n;
        while (cur !== from) {
          const e = prev.get(cur)!;
          out.push(e.mv);
          cur = e.p;
        }
        out.reverse();
        return out.join('');
      }
      q.push(n);
    }
  }
  return null;
}

// Can the player walk from `from` to the door cell with `boxes` as obstacles?
function canReach(
  lv: Level,
  from: number,
  to: number,
  boxes: number[],
  playable: boolean[],
): boolean {
  if (from === to) return true;
  const boxSet = new Set(boxes);
  const seen = new Set<number>([from]);
  const q: number[] = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let d = 0; d < 4; d++) {
      const n = step(lv, c, d);
      if (n < 0 || !playable[n] || boxSet.has(n) || seen.has(n)) continue;
      if (n === to) return true;
      seen.add(n);
      q.push(n);
    }
  }
  return false;
}

// ---- decomposition: hallway row + one room per door -----------------------
function decompose(lv: Level): Room[] | null {
  const row = (lv.player / lv.w) | 0;
  const hallwayCells: number[] = [];
  for (let x = 0; x < lv.w; x++) {
    const i = row * lv.w + x;
    if (!lv.wall[i]) hallwayCells.push(i);
  }
  if (hallwayCells.length === 0) return null;
  const rooms: Room[] = [];
  const assigned = new Array<boolean>(lv.w * lv.h).fill(false);
  for (const hc of hallwayCells) {
    const hx = hc % lv.w;
    for (const dr of [-1, 1]) {
      const y = row + dr;
      if (y < 0 || y >= lv.h) continue;
      const door = y * lv.w + hx;
      if (lv.wall[door]) continue;
      const cells = new Array<boolean>(lv.w * lv.h).fill(false);
      const q: number[] = [door];
      cells[door] = true;
      for (let qi = 0; qi < q.length; qi++) {
        const c = q[qi];
        for (let d = 0; d < 4; d++) {
          const nb = step(lv, c, d);
          if (nb < 0 || lv.wall[nb] || cells[nb]) continue;
          if (((nb / lv.w) | 0) === row) continue; // never enter the hallway row
          cells[nb] = true;
          q.push(nb);
        }
      }
      let overlap = false;
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] && assigned[i]) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      for (let i = 0; i < cells.length; i++) if (cells[i]) assigned[i] = true;
      const boxes: number[] = [];
      const goals: number[] = [];
      for (let i = 0; i < cells.length; i++) {
        if (!cells[i]) continue;
        if (lv.goal[i]) goals.push(i);
        if (lv.boxes.indexOf(i) >= 0) boxes.push(i);
      }
      rooms.push({ cells, door, entry: hc, boxes, goals });
    }
  }
  if (rooms.length < 1 || rooms.length > 4) return null;
  let totalBoxes = 0;
  let totalGoals = 0;
  for (const r of rooms) {
    if (r.boxes.length !== r.goals.length) return null;
    if (r.boxes.length < 3 || r.boxes.length > 4) return null;
    totalBoxes += r.boxes.length;
    totalGoals += r.goals.length;
  }
  if (totalBoxes !== lv.boxes.length) return null;
  let goalCount = 0;
  for (let i = 0; i < lv.w * lv.h; i++) if (lv.goal[i]) goalCount++;
  if (totalGoals !== goalCount) return null;
  // Every non-hallway floor cell must belong to exactly one room.
  for (let y = 0; y < lv.h; y++) {
    for (let x = 0; x < lv.w; x++) {
      const i = y * lv.w + x;
      if (lv.wall[i] || y === row) continue;
      if (!assigned[i]) return null;
    }
  }
  return rooms;
}

// ---- per-room 0-1 BFS push search -----------------------------------------
function solveRoom(lv: Level, room: Room): RoomSol | null {
  const B = lv.w * lv.h;
  const playable = room.cells.slice();
  playable[room.entry] = true;
  const dead = computeDead(lv, room.cells, room.goals);
  const goalSet = new Set(room.goals);
  const boxCount = room.boxes.length;
  const keyOf = (boxes: number[], p: number): number => {
    let k = 0;
    for (let i = 0; i < boxCount; i++) k = k * B + boxes[i];
    return k * B + p;
  };
  const decode = (key: number): { boxes: number[]; p: number } => {
    let k = key;
    const p = k % B;
    k = Math.floor(k / B);
    const boxes = new Array<number>(boxCount);
    for (let i = boxCount - 1; i >= 0; i--) {
      boxes[i] = k % B;
      k = Math.floor(k / B);
    }
    return { boxes, p };
  };
  const isGoalState = (boxes: number[]): boolean => {
    for (const b of boxes) if (!goalSet.has(b)) return false;
    return true;
  };

  // Initial state must not already be frozen.
  for (const b of room.boxes) {
    if (createsFrozen2x2(lv, room.boxes, room.cells, room.entry, b)) return null;
  }

  const dist = new Map<number, number>();
  const parent = new Map<number, { prev: number; mv: string }>();
  const dq = new Deque<{ k: number; c: number }>();
  const startBoxes = room.boxes.slice().sort((a, b) => a - b);
  const startKey = keyOf(startBoxes, room.entry);
  dist.set(startKey, 0);
  dq.pushBack({ k: startKey, c: 0 });

  let goalKey = -1;
  let goalBoxes: number[] = [];
  let goalPlayer = -1;
  let goalCost = 0;
  let pops = 0;
  while (dq.size > 0) {
    // Safety cap (work budget, not wall clock): a room that explodes past
    // this is left to the whole-level fallback instead of eating the 60 s.
    if (++pops > 2000000) return null;
    const cur = dq.popFront();
    if (dist.get(cur.k) !== cur.c) continue; // stale entry
    const { boxes, p } = decode(cur.k);
    if (isGoalState(boxes)) {
      // Accept only if the player can still walk out through the door.
      if (canReach(lv, p, room.door, boxes, playable)) {
        goalKey = cur.k;
        goalBoxes = boxes;
        goalPlayer = p;
        goalCost = cur.c;
        break;
      }
      // Otherwise keep searching: a costlier exitable solution may exist.
    }
    for (let d = 0; d < 4; d++) {
      const np = step(lv, p, d);
      if (np < 0 || !playable[np]) continue;
      const bi = boxes.indexOf(np);
      if (bi < 0) {
        // Walk: cost 0, front of deque.
        const nk = keyOf(boxes, np);
        if (!dist.has(nk) || cur.c < dist.get(nk)!) {
          dist.set(nk, cur.c);
          parent.set(nk, { prev: cur.k, mv: DIRS[d].ch });
          dq.pushFront({ k: nk, c: cur.c });
        }
      } else {
        // Push: cost 1, back of deque.
        const nb = step(lv, np, d);
        if (nb < 0 || !room.cells[nb]) continue; // never out of the room
        if (boxes.indexOf(nb) >= 0) continue;
        if (dead[nb]) continue;
        const nb2 = boxes.slice();
        nb2[bi] = nb;
        nb2.sort((a, b) => a - b);
        if (createsFrozen2x2(lv, nb2, room.cells, room.entry, nb)) continue;
        const nk = keyOf(nb2, np);
        const nc = cur.c + 1;
        if (!dist.has(nk) || nc < dist.get(nk)!) {
          dist.set(nk, nc);
          parent.set(nk, { prev: cur.k, mv: DIRS[d].ch });
          dq.pushBack({ k: nk, c: nc });
        }
      }
    }
  }
  if (goalKey < 0) return null;

  // Reconstruct the move string.
  const moves: string[] = [];
  let cur = goalKey;
  while (cur !== startKey) {
    const e = parent.get(cur)!;
    moves.push(e.mv);
    cur = e.prev;
  }
  moves.reverse();
  let out = moves.join('');

  // Walk out of the room: player -> door -> entry cell.
  const boxSet = new Set(goalBoxes);
  const exitWalk = bfsWalk(lv, goalPlayer, room.door, boxSet);
  if (exitWalk === null) return null;
  out += exitWalk;
  const [dx, dy] = cellXY(lv, room.entry);
  const [ox, oy] = cellXY(lv, room.door);
  let stepOut = '';
  for (let d = 0; d < 4; d++) {
    if (ox + DIRS[d].dx === dx && oy + DIRS[d].dy === dy) {
      stepOut = DIRS[d].ch;
      break;
    }
  }
  out += stepOut;
  return {
    moves: out,
    pushes: goalCost,
    finalBoxes: goalBoxes,
    exitWalkLen: exitWalk.length + stepOut.length,
  };
}

// ---- whole-level fallback: 0-1 BFS with an expansion cap ------------------
function solveWhole(lv: Level, maxPops: number): string | null {
  const allCells = new Array<boolean>(lv.w * lv.h).fill(false);
  for (let i = 0; i < lv.w * lv.h; i++) if (!lv.wall[i]) allCells[i] = true;
  const goals: number[] = [];
  for (let i = 0; i < lv.w * lv.h; i++) if (lv.goal[i]) goals.push(i);
  const dead = computeDead(lv, allCells, goals);
  const goalSet = new Set(goals);
  const keyOf = (boxes: number[], p: number): string =>
    boxes.join(',') + '|' + p;
  const dist = new Map<string, number>();
  const parent = new Map<string, { prev: string; mv: string }>();
  const dq = new Deque<{ k: string; c: number }>();
  const startBoxes = lv.boxes.slice().sort((a, b) => a - b);
  const startKey = keyOf(startBoxes, lv.player);
  dist.set(startKey, 0);
  dq.pushBack({ k: startKey, c: 0 });
  const isGoalState = (boxes: number[]): boolean => {
    for (const b of boxes) if (!goalSet.has(b)) return false;
    return true;
  };
  let pops = 0;
  let goalKey = '';
  while (dq.size > 0) {
    if (++pops > maxPops) return null;
    const cur = dq.popFront();
    if (dist.get(cur.k) !== cur.c) continue;
    const [bstr, pstr] = cur.k.split('|');
    const boxes = bstr === '' ? [] : bstr.split(',').map(Number);
    const p = Number(pstr);
    if (isGoalState(boxes)) {
      goalKey = cur.k;
      break;
    }
    for (let d = 0; d < 4; d++) {
      const np = step(lv, p, d);
      if (np < 0 || lv.wall[np]) continue;
      const bi = boxes.indexOf(np);
      if (bi < 0) {
        const nk = keyOf(boxes, np);
        if (!dist.has(nk) || cur.c < dist.get(nk)!) {
          dist.set(nk, cur.c);
          parent.set(nk, { prev: cur.k, mv: DIRS[d].ch });
          dq.pushFront({ k: nk, c: cur.c });
        }
      } else {
        const nb = step(lv, np, d);
        if (nb < 0 || lv.wall[nb]) continue;
        if (boxes.indexOf(nb) >= 0) continue;
        if (dead[nb]) continue;
        const nb2 = boxes.slice();
        nb2[bi] = nb;
        nb2.sort((a, b) => a - b);
        if (createsFrozen2x2(lv, nb2, allCells, -1, nb)) continue;
        const nk = keyOf(nb2, np);
        const nc = cur.c + 1;
        if (!dist.has(nk) || nc < dist.get(nk)!) {
          dist.set(nk, nc);
          parent.set(nk, { prev: cur.k, mv: DIRS[d].ch });
          dq.pushBack({ k: nk, c: nc });
        }
      }
    }
  }
  if (goalKey === '') return null;
  const moves: string[] = [];
  let cur = goalKey;
  while (cur !== startKey) {
    const e = parent.get(cur)!;
    moves.push(e.mv);
    cur = e.prev;
  }
  moves.reverse();
  return moves.join('');
}

// ---- greedy fallback: A* over push states ---------------------------------
// State = sorted boxes + canonical player region (min reachable cell).
// Heuristic = sum of per-box BFS distances to the nearest goal (ignoring
// other boxes). Not admissible in general, but this is only a safety net
// for validity when the exact searches fail.
function greedySolve(lv: Level, maxExp: number): string | null {
  const goalSet = new Set<number>();
  for (let i = 0; i < lv.w * lv.h; i++) if (lv.goal[i]) goalSet.add(i);
  // BFS distances to the nearest goal, ignoring boxes.
  const d2g = new Array<number>(lv.w * lv.h).fill(Infinity);
  const q: number[] = [];
  for (const g of goalSet) {
    d2g[g] = 0;
    q.push(g);
  }
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let d = 0; d < 4; d++) {
      const n = step(lv, c, d);
      if (n < 0 || lv.wall[n] || d2g[n] !== Infinity) continue;
      d2g[n] = d2g[c] + 1;
      q.push(n);
    }
  }
  const regionMin = (boxes: number[], from: number): number => {
    const boxSet = new Set(boxes);
    const seen = new Set<number>([from]);
    const qq: number[] = [from];
    let mn = from;
    for (let qi = 0; qi < qq.length; qi++) {
      const c = qq[qi];
      if (c < mn) mn = c;
      for (let d = 0; d < 4; d++) {
        const n = step(lv, c, d);
        if (n < 0 || lv.wall[n] || boxSet.has(n) || seen.has(n)) continue;
        seen.add(n);
        qq.push(n);
      }
    }
    return mn;
  };
  const heur = (boxes: number[]): number => {
    let s = 0;
    for (const b of boxes) {
      if (!goalSet.has(b)) s += d2g[b];
    }
    return s;
  };
  interface GState {
    boxes: number[];
    player: number;
    g: number;
    parent: string;
    seg: string;
  }
  const keyOf = (boxes: number[], rmin: number): string =>
    boxes.join(',') + '|' + rmin;
  const startBoxes = lv.boxes.slice().sort((a, b) => a - b);
  const startKey = keyOf(startBoxes, regionMin(startBoxes, lv.player));
  const states = new Map<string, GState>();
  states.set(startKey, {
    boxes: startBoxes,
    player: lv.player,
    g: 0,
    parent: '',
    seg: '',
  });
  // Binary heap ordered by (f, seq) for determinism.
  const heap: { f: number; seq: number; key: string }[] = [];
  let seq = 0;
  const heapPush = (f: number, key: string): void => {
    heap.push({ f, seq: seq++, key });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (
        heap[p].f < heap[i].f ||
        (heap[p].f === heap[i].f && heap[p].seq < heap[i].seq)
      )
        break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const heapPop = (): { f: number; seq: number; key: string } => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (
          l < heap.length &&
          (heap[l].f < heap[m].f ||
            (heap[l].f === heap[m].f && heap[l].seq < heap[m].seq))
        )
          m = l;
        if (
          r < heap.length &&
          (heap[r].f < heap[m].f ||
            (heap[r].f === heap[m].f && heap[r].seq < heap[m].seq))
        )
          m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  heapPush(heur(startBoxes), startKey);
  const isGoalState = (boxes: number[]): boolean => {
    for (const b of boxes) if (!goalSet.has(b)) return false;
    return true;
  };
  let exp = 0;
  while (heap.length > 0) {
    if (++exp > maxExp) return null;
    const cur = heapPop();
    const st = states.get(cur.key)!;
    if (isGoalState(st.boxes)) {
      const segs: string[] = [];
      let k: string = cur.key;
      while (k !== startKey) {
        const s = states.get(k)!;
        segs.push(s.seg);
        k = s.parent;
      }
      segs.reverse();
      return segs.join('');
    }
    const boxSet = new Set(st.boxes);
    // Reachable region from the player.
    const region = new Set<number>([st.player]);
    const rq: number[] = [st.player];
    for (let qi = 0; qi < rq.length; qi++) {
      const c = rq[qi];
      for (let d = 0; d < 4; d++) {
        const n = step(lv, c, d);
        if (n < 0 || lv.wall[n] || boxSet.has(n) || region.has(n)) continue;
        region.add(n);
        rq.push(n);
      }
    }
    for (let bi = 0; bi < st.boxes.length; bi++) {
      const b = st.boxes[bi];
      for (let d = 0; d < 4; d++) {
        const from = step(lv, b, (d + 2) % 4); // player stands opposite the push
        const dest = step(lv, b, d);
        if (from < 0 || dest < 0) continue;
        if (!region.has(from)) continue;
        if (lv.wall[dest] || boxSet.has(dest)) continue;
        const nb2 = st.boxes.slice();
        nb2[bi] = dest;
        nb2.sort((a, b2) => a - b2);
        const nk = keyOf(nb2, regionMin(nb2, b));
        const ng = st.g + 1;
        const old = states.get(nk);
        if (old !== undefined && old.g <= ng) continue;
        const walk = bfsWalk(lv, st.player, from, boxSet);
        if (walk === null) continue;
        states.set(nk, {
          boxes: nb2,
          player: b,
          g: ng,
          parent: cur.key,
          seg: walk + DIRS[d].ch,
        });
        heapPush(ng + heur(nb2), nk);
      }
    }
  }
  return null;
}

// ---- replay check ----------------------------------------------------------
function replay(lv: Level, moves: string): boolean {
  const boxes = lv.boxes.slice();
  let p = lv.player;
  for (const ch of moves) {
    const d = 'uldr'.indexOf(ch);
    if (d < 0) return false;
    const np = step(lv, p, d);
    if (np < 0 || lv.wall[np]) return false;
    const bi = boxes.indexOf(np);
    if (bi >= 0) {
      const nb = step(lv, np, d);
      if (nb < 0 || lv.wall[nb] || boxes.indexOf(nb) >= 0) return false;
      boxes[bi] = nb;
    }
    p = np;
  }
  for (const b of boxes) if (!lv.goal[b]) return false;
  return true;
}

function permutations(n: number): number[][] {
  const res: number[][] = [];
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i);
  const gen = (k: number): void => {
    if (k === n) {
      res.push(a.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      const t = a[k];
      a[k] = a[i];
      a[i] = t;
      gen(k + 1);
      const t2 = a[k];
      a[k] = a[i];
      a[i] = t2;
    }
  };
  gen(0);
  return res;
}

function solveLevel(lv: Level): string {
  const rooms = decompose(lv);
  if (rooms !== null) {
    const sols: (RoomSol | null)[] = rooms.map((r) => solveRoom(lv, r));
    if (sols.every((s) => s !== null)) {
      let best: string | null = null;
      let bestWalk = Infinity;
      for (const perm of permutations(rooms.length)) {
        let boxesNow = lv.boxes.slice();
        let playerNow = lv.player;
        let moves = '';
        let walk = 0;
        let ok = true;
        for (const ri of perm) {
          const room = rooms[ri];
          const sol = sols[ri]!;
          const blocked = new Set(boxesNow);
          const w1 = bfsWalk(lv, playerNow, room.entry, blocked);
          if (w1 === null) {
            ok = false;
            break;
          }
          walk += w1.length;
          moves += w1 + sol.moves;
          walk += sol.exitWalkLen; // only the exit walks count toward the order choice
          // Update boxes: this room's boxes are now on their final cells.
          const nextBoxes: number[] = [];
          for (const b of boxesNow) {
            if (room.boxes.indexOf(b) >= 0) continue;
            nextBoxes.push(b);
          }
          for (const b of sol.finalBoxes) nextBoxes.push(b);
          nextBoxes.sort((a, b) => a - b);
          boxesNow = nextBoxes;
          playerNow = room.entry;
        }
        if (!ok) continue;
        if (walk < bestWalk) {
          bestWalk = walk;
          best = moves;
        }
      }
      if (best !== null && replay(lv, best)) return best;
    }
  }
  // Generic fallback: whole-level exact search (capped), then greedy.
  const whole = solveWhole(lv, 1000000);
  if (whole !== null && replay(lv, whole)) return whole;
  const greedy = greedySolve(lv, 200000);
  if (greedy !== null && replay(lv, greedy)) return greedy;
  return '';
}

// ---- main ------------------------------------------------------------------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    const lv = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    moves = solveLevel(lv);
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
