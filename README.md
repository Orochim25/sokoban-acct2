# Sokoban Solver — 0-1 BFS per Room

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Orochim25/sokoban-acct2/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Orochim25/sokoban-acct2/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A Sokoban solver for the make.fun bounty
[Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121).

## Approach

Levels are a 1-wide hallway plus 1–4 rooms off it, each with one door.
A box pushed into the hallway can never come back, so every box stays in
its own room and the level optimum is the sum of the rooms' optima.

1. Parse the XSB grid, find the hallway (the row with `@`) and each room
   (connected floor beyond each door).
2. Solve each room independently with an **exact push-optimal 0-1 BFS**:
   state = sorted box positions + full player position, walk steps cost 0,
   pushes cost 1, so the first goal state dequeued is push-optimal.
   Pruning (all provably safe): dead squares from reverse pull BFS from
   the goals, and 2x2 freeze deadlock detection. Boxes are never pushed
   out through the door; other rooms' boxes are walls.
3. Combine rooms in the visiting order that minimizes walking
   (all permutations, ≤ 24; walking costs no pushes).
4. Self-verify by replaying the full move string before writing it out;
   generic whole-level 0-1 BFS and a greedy A* fallback if the room
   structure ever fails to hold.

Deterministic: no randomness, no clock, fixed iteration orders — two runs
produce byte-identical outputs.

## Practice results (pushes vs P*)

| level | pushes | P* |
|-------|--------|----|
| i001  | 13     | 13 |
| i002  | 16     | 16 |
| i003  | 29     | 29 |
| i004  | 47     | 47 |
| i005  | 60     | 60 |

Total runtime on the practice set: ~3 s (limit 60 s).

## Run

```sh
MAKEFUN_INPUT_DIR=<input dir> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

Node 22, standard library only, no installs.
