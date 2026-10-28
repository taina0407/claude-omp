# Changelog

## Unreleased: v1 (M0: spike + scaffold)

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
