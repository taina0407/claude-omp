# Changelog

## Unreleased: v1

### M1: core and omp-rpc backend

- `src/cli/main.ts`: the v1 `omp-task` CLI with every v0.2 command (`run`, `continue`, `wait`,
  `watch`, `steer`, `reply`, `approve`, `cancel`, `status`, `result`, `list`, `doctor`), the same
  flags, exit codes, text output and `--json` keys. Run it with `bun src/cli/main.ts`.
- Job state lives in SQLite (`state.db` in the state dir, WAL). Control commands are queued in
  the database and picked up by the job's runner, so no per-job socket is needed.
- `JobRunner` (`src/core/runner.ts`) drives one job; the omp-rpc backend is split into a pure
  protocol state machine (replayed against the M0 fixtures in tests) and a process wrapper.
- Behaviour changes from v0.2, all from the M0 recordings:
  - jobs end on omp's `prompt_result`, so long histories elided from `agent_end` no longer
    matter;
  - protocol v2 is negotiated, so frames over 1 MB arrive whole instead of truncated;
  - a brief over 900 KB is handed to omp as a file (omp rejects longer input lines);
  - job cost includes subagents (`get_session_stats` leaves them out);
  - a final message with `stopReason: "error"` fails the job.
- Tests: a TypeScript fake omp that speaks the recorded protocol, the v0.2 end-to-end suite
  ported to `bun test`, plus unit tests for the core.

### M0: spike + scaffold

- Start of v1: a TypeScript/Bun rewrite with a per-user daemon.
- Bun project scaffold: `package.json` (pinned deps), strict `tsconfig.json`, Biome, CI workflow
  (`bun test`, typecheck, lint, the v0.2 Python tests, `claude plugin validate --strict`).
- `src/backends/omp-rpc/framing.ts`: JSONL splitting and protocol-v2 `rpc_chunk` reassembly.
- RPC recorder (`bun run record`) and 10 recorded omp 18.12 RPC fixtures in `tests/fixtures/rpc/`,
  with invariant tests.
- Probes: `scripts/probes/omp-flags.ts` (which session flags work in RPC mode),
  `scripts/probes/unix-serve.ts` (HTTP/SSE over a unix socket with Bun).
- The v0.2 Python CLI and plugin are unchanged.

## 0.2.1 — 2026-10-27

- Fix: long jobs were reported as FAILED ("supervisor exited without recording a result")
  because the supervisor crashed on the string marker omp inserts when it elides
  `agent_end` history.

## 0.2.0 — 2026-10-25

- Jobs now run under a detached supervisor that drives `omp --mode rpc` instead of `omp -p`.
- New `ask_orchestrator` / `notify_orchestrator` host tools: the worker can ask a question and
  wait for the answer, or post progress notes.
- `edit` access forwards shell/eval approval requests to the orchestrator
  (`omp-task approve [--session|--deny]`) instead of silently denying them.
- New commands: `steer`, `reply`, `approve`, `watch` (one line per event, for Claude's Monitor).
- `wait` (and `run` without `--detach`) return with exit 4 as soon as a job needs an answer or
  approval; unanswered items expire (`--answer-timeout`, `--approval-timeout`).
- `--timeout` is enforced by the supervisor with an RPC abort.
- Skill workflow: start detached, background `wait` to be woken, no polling loops.

## 0.1.0 — 2026-10-25

- `delegate` skill: brief → run → review → continue workflow for Claude as orchestrator.
- `omp-task` CLI: run / continue / status / wait / result / list / cancel / doctor, job records,
  changed-file detection, presets, read/edit/full access levels.
- `install.sh` with plugin, dev-link and CLI-only modes.
