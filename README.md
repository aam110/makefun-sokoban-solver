# Pintu — the doorway Sokoban solver

**Pintu** (Indonesian for *door*) solves Sokoban the way the levels are
built: through their doors. Every level in this competition is a one-square
hallway with the player on it, plus one to four small rooms hanging off the
hallway, each opening through a single door. A box pushed out of its room
through the door can never be pushed back — so every box stays in its own
room, and the whole level splits into independent per-room puzzles. Pintu
solves each room exactly, then stitches the rooms together with plain
hallway walks.

Entry for the make.fun bounty
[Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121)
— see the competition page for the rules, the practice set and the
leaderboard.

## How it works

**1. Decomposition.** The level is parsed from XSB. The hallway is the
row the player starts on; every connected component of open floor off
that row is a room, with its door cell (the one touching the hallway)
and its entry cell (the hallway cell beside the door). A level that does
not have this shape falls back to a whole-level push search.

**2. Per-room push-optimal A\*.** Each room (3–4 boxes in a 6×6 slot) is
solved on its own, from its door, as an A\* search over *pushes*:

- **State** — the sorted box cells plus the player's canonical cell.
  After every push the player is canonicalised to the lowest cell of
  the flood-fill region they can reach without pushing, because
  walking is free and only pushes cost.
- **Heuristic** — the minimum-cost matching of boxes to goals
  (brute-force permutations, at most 4 boxes) over BFS distances that
  ignore boxes. Admissible, so the first solution A\* pops is
  push-optimal.
- **Dead squares** — reverse "pull" reachability from the goals: a cell
  is dead when no sequence of pulls could ever bring a box from it to a
  goal. Corners and goal-less wall runs fall out of this naturally.
  Dynamic 2×2 frozen-block checks prune hopeless states as they arise.
- **Exactness** — a binary-heap priority queue, a transposition table
  keyed on the full state, fixed node-expansion budgets, and a goal
  test that also requires the player to be able to walk back out
  through the door (except in the room solved last — a room's optimum
  may end with the player inside it).

**3. Stitching.** Rooms are solved left to right by door column. The
player walks the hallway (BFS, boxes never enter the hallway) to each
door, enters, executes the room's push sequence — each push expanded
into player steps by BFS between pushes — walks back out through the
door, and moves on. The solver tries each room as the last one
(rightmost first) until a full replay of the stitched moves verifies
against the level. Every candidate answer is replayed internally
before it is written; a failed replay writes an empty answer instead
of an illegal one.

**4. Determinism.** No wall clock anywhere, no randomness, no
environment-dependent variation: fixed budgets, sorted iteration
order, deterministic tie-breaking. Two runs on the same set write
byte-identical `solution.txt` files (verified with `diff -r`).

## Practice results

Run on the kit's practice set
(`MAKEFUN_INPUT_DIR=<kit>/practice/input node repo/main.ts`):

| Instance | Rooms | P\* | Pushes | Points |
|----------|-------|-----|--------|--------|
| i001 | 1 × 3 boxes | 13 | 13 | 1000 |
| i002 | 1 × 4 boxes | 16 | 16 | 1000 |
| i003 | 2 rooms | 29 | 29 | 1000 |
| i004 | 3 rooms | 47 | 47 | 1000 |
| i005 | 4 × 4 boxes | 60 | 60 | 1000 |
| **Total** | | | | **score 1,000,000** |

Verified with the kit's own scorer (`node cli/makefun.mjs grade-local
--kit . --bot repo/ --driver process`): **score 1,000,000, passed 1,
answered 5, 5000 of 5000 points, L1 regrade reproduced byte for byte.**

Total runtime for the whole set: ~0.8 s on this machine — far inside
the 60 s budget, with large fixed-budget headroom for unseen rooms.

## Layout

- `main.ts` — the whole solver in one file: parsing, decomposition,
  push A\*, stitching, replay verification. Plain TypeScript with
  erasable syntax only, Node built-ins only, no dependencies.
- `README.md` — this file.
- `LICENSE` — MIT.

## Usage

```sh
# Local run on the practice set:
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
# Graded run (the sandbox runs this):
node /bot/main.ts   # reads /input, writes /output/<id>/solution.txt
```

One run answers all five instances (`i001`–`i005`) and always writes a
`solution.txt` for each, even when a level cannot be solved (an empty
file, worth 0, rather than a crash or a missing file).
