# Changelog

## Unreleased: v1

### M6: plugin layer

- The plugin is now called **`omp`** (was `omp-delegate`): `/omp:delegate`, `/omp:review`,
  `/omp:adversarial-review`, `/omp:status`, `/omp:result`, `/omp:cancel`, `/omp:transfer`,
  `/omp:setup`. Uninstall `omp-delegate@omp-tools` when upgrading.
- `bin/omp-task` puts the v1 CLI on Claude's PATH (Claude Code 2.1.91+). It runs on Bun and
  installs its runtime dependency on first use. The v0.2 Python CLI and its tests are gone;
  Python is no longer needed.
- Hooks: SessionStart tags jobs with the Claude session id (`claude_session` in `--json`);
  SessionEnd cancels the session's jobs when `on_session_end` is `cancel` (default `keep`); the
  opt-in Stop gate (`stop_gate` in the config, `omp-task setup --stop-gate on`) reviews the
  uncommitted changes with a cheap model when Claude finishes a turn and blocks the stop on
  findings at `min_severity` (default high) or above. It reviews each state of the tree once,
  at most `max_per_session` times, and never when a stop hook is already active.
- `omp-task setup [--stop-gate on|off]` creates the config from the example and toggles the
  gate; `omp-task hook <name>` runs a hook; `doctor` shows the gate and the Claude session.
- The `delegate` skill is rewritten for v1 around one rule: start detached, `wait` in the
  background, end the turn. New reference `fan-out.md` for groups, dependencies and plan files.
- `install.sh` installs with Bun and removes the old plugin; CI drops the Python job.

### M5: structured review

- `omp-task review` runs a read-only job that must hand in its review through the
  `submit_review` host tool: a verdict (`approve`, `approve_with_comments`, `request_changes`), a
  summary, and findings with severity, file, line, title, detail, suggestion and confidence. The
  payload is checked against a zod schema; an invalid one goes back to the worker with the fields
  to fix (twice at most), and a worker that never hands in a valid review fails the job.
- Targets: uncommitted changes including untracked files (default), `--staged`, `--base <ref>`
  (since the merge-base, uncommitted changes included), `--commit <sha>`, and `--job <id>` for a
  worktree job's changes before `apply`. `--adversarial` switches to a prompt that tries to break
  the change; `--focus` says what to look at hardest. Model, preset, timeout, group and budget
  work as for `run`.
- The diff is saved as `review.diff` in the job directory and pasted into the prompt when under
  150 KB; larger diffs are referenced with the list of files.
- `result`/`wait` print the review as markdown (never cut short); `--json` adds `review` (the
  validated object) and `review_of` (mode, target, focus).
- Backends can now offer extra host tools per session.

### M4: scheduler, dependencies, budgets, and waking the orchestrator less

- Attention: the orchestrator is woken only when it has something to do. `wait` returns (exit 4)
  for a question, an approval, an interrupted job, a **checkpoint** (the worker calls
  `notify_orchestrator` with `checkpoint: true`; plain progress notes never wake) or a
  **stalled** worker (no activity for `--stall-timeout`, default 10m; five failing tool calls in a
  row; or the same call failing three times). Notices are delivered once. The last output line
  says why: `WAKE: <job> checkpoint` or `WAKE: done (3 completed, 1 skipped)`. A finished job's
  report is cut to 40 lines there (`result --full` has it all). `wait --no-checkpoint` ignores
  checkpoints.
- `watch` piped (Monitor, scripts) prints only lines that need the orchestrator (questions,
  approvals, checkpoints, stalls, errors, the end); `--verbose` prints everything. `run --detach`
  no longer suggests a Monitor feed, only a background `wait`.
- Approval rules: `--allow GLOB` / `--deny GLOB` (repeatable, also `allow`/`deny` in config
  defaults and presets; they add up) decide matching approvals without asking. `tool:<name>`
  matches a whole tool. Deny wins; an allow rule never matches a command that chains, pipes or
  redirects. Decisions show in the feed as `AUTO-APPROVE`/`AUTO-DENY`.
- Dependencies: `--after <job>[,<job>]` keeps a job `blocked` until they end; it is `skipped` if
  one did not complete (down the whole chain), unless `--after-any-outcome`.
  `{{result:<job>}}` in a prompt is replaced by that job's report when the job starts.
- Groups: `-g/--group NAME`, `wait --group`, `list --group`, `summary <group>`.
- Concurrency: `max_concurrent` (default 4), per group (`groups.<name>.max_concurrent` or the
  plan), and `max_writers_per_repo` (default 1) for jobs that edit a checkout without a worktree.
  Waiting jobs are `queued`. `cancel` works on blocked and queued jobs.
- Budgets: `--budget USD` (or `budget` in a preset) stops a job as `over_budget`;
  `groups.<name>.budget_usd` and `daily_budget_usd` stop running jobs and keep new ones from
  starting.
- `plan apply <file.yaml|json> [--dry-run]`: a group of tasks with `after`, defaults, briefs
  relative to the plan file and `{{result:<task>}}`; checked for unknown names and cycles before
  anything is created.
- Limits come from the user config and plan files only; a repository cannot raise them.

### M3: worktree isolation

- `--isolate auto|worktree|none` on `run` (also an `isolate` config setting). `auto`, the default,
  runs `--access full` jobs in a git worktree of the repo when it has a commit; other jobs keep
  running in the checkout. Worktrees live under the state dir on branch `omp/<job id>`;
  `--carry-dirty` copies the checkout's uncommitted changes into it. `continue` keeps working in
  the parent's worktree. Changed files are reported relative to the worktree.
- New commands: `diff <job> [--stat]`, `apply <job> [--3way] [--keep]` (checks first, so a patch
  that does not apply changes nothing; with `--3way` conflicts are left as markers and named),
  `discard <job>`, `prune [--older 7d] [--dry-run]`. Text and `--json` output show the worktree.
- Implemented by an omp worker (`smol`) from a written brief, reviewed and adjusted here.

### M2: per-user daemon

- A daemon now owns the job database and runs every job. The CLI talks to it over HTTP on a
  unix socket (one daemon per state dir) and starts it on demand; concurrent CLIs on a cold start
  still end up with exactly one daemon (`O_EXCL` lock file plus pid check).
- `wait` long-polls and `watch` streams server-sent events, so neither polls the database.
- Crash recovery: jobs the daemon was running when it died or was stopped become `interrupted`.
  `omp-task resume <job>` continues the job in its omp session under the same job id (omp's
  `--restore` does not work in RPC mode); if omp had not saved the session yet, the job starts
  over. With `"auto_resume": true` in the config the daemon resumes them by itself. `wait`
  returns exit 4 for an interrupted job; `cancel` gives it up.
- omp keeps working on its turn after its stdin closes, so on recovery the daemon stops a worker
  that outlived its daemon before anyone resumes the session.
- Cost, tokens and tool counts are saved as they change, so an interruption loses none of them.
- The daemon stops after 15 minutes with no jobs and no clients (`daemon_idle_timeout`), and
  restarts by itself when idle and the CLI is a different version.
- New commands: `resume`, `daemon` (foreground), `daemon status`, `daemon stop [--force]`.
  `doctor` shows the daemon. New exit code 5: the daemon could not be started or reached.

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
