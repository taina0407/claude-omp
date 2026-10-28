# omp

A Claude Code plugin that makes Claude the **orchestrator** and [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi)
the **worker**. Claude writes a scoped brief and hands it to omp, which runs whatever model you
pick (GPT, Gemini, DeepSeek, Claude, local…). A per-user daemon supervises the job and wakes
Claude only when it is needed: a question, an approval, a checkpoint the worker reports, a
stalled worker, or the end. Claude then reviews the result (or has another model review it),
applies it from an isolated worktree, and iterates in the same omp session.

```
             brief · steer · reply · approve · cancel
you ─► Claude ──────────────────────────────► omp-task ──unix socket──► daemon ──RPC──► omp --mode rpc
         ▲                                                    │  scheduler · budgets · worktrees
         └─── wait returns only when Claude is needed ◄───────┘  approval rules · review gate
```

What it gives you:

- **Delegation without babysitting.** `omp-task wait` blocks in the background and returns only
  for something Claude must act on. Routine approvals are decided by rules (`--allow 'bun
  test*'`), plain progress notes never wake Claude, and the daemon itself notices a stalled
  worker. A 10-minute job typically costs Claude two or three turns.
- **Isolation.** `--isolate worktree` (the default for `--access full`) runs the job in a git
  worktree; `diff`, `apply` (checked first, `--3way` for conflicts) and `discard` bring the work
  over or drop it.
- **Fan-out.** Groups, `--after` dependencies with `skipped` propagation, result passing
  (`{{result:<job>}}`), concurrency limits, per-job/group/day budgets, and `plan apply` for a
  whole YAML DAG.
- **Structured review.** `omp-task review` (uncommitted, `--staged`, `--base`, `--commit`, or a
  worktree job) runs a read-only reviewer that must return a schema-checked verdict and
  findings. An opt-in Stop hook can run it on every changed turn and block on serious findings.
- **Crash safety.** Jobs survive a daemon restart as `interrupted` and `resume` in the same omp
  session.

## Requirements

- [Claude Code](https://code.claude.com) 2.1.91 or later (plugin `bin/` on PATH)
- [Bun](https://bun.sh) 1.3 or later (`curl -fsSL https://bun.sh/install | bash`)
- `omp` on `PATH`, with at least one provider logged in (`omp login`, then check `omp models`)
- git (for worktrees, reviews and changed-file detection)

## Install

### As a plugin

```bash
claude plugin marketplace add taina0407/claude-omp
```

```bash
claude plugin install omp@omp-tools
```

Then run `/omp:setup` in Claude Code. It installs the CLI's dependencies on first use, creates
`~/.config/claude-omp/config.json` from [config.example.json](config.example.json) and checks
omp. Upgrading from 0.2: the plugin was renamed from `omp-delegate`; uninstall that one
(`claude plugin uninstall omp-delegate@omp-tools`).

### From a checkout

```bash
./install.sh
```

This installs dependencies, links `omp-task` into `~/.local/bin`, creates the config and
installs the plugin from the checkout. `./install.sh --cli` does everything except the plugin.

## Use

Ask Claude in plain words ("delegate the pagination to omp with deepseek", "have another model
review my changes", "run these three refactors in parallel"), or use the commands:

| Command | What it does |
|---|---|
| `/omp:delegate <task>` | The delegate skill: brief → run → wait → answer → review → apply → report |
| `/omp:review [--staged \| --base REF \| --commit SHA \| --job ID] [--focus …]` | Read-only review with structured findings |
| `/omp:adversarial-review …` | The same, with a reviewer that tries to break the change |
| `/omp:status [JOB \| --group G]` | Jobs of this repository, one job, or a group |
| `/omp:result JOB` | A job's report, changed files and cost |
| `/omp:cancel JOB` | Cancel a job (dependents are skipped) |
| `/omp:transfer` | The command to continue this conversation in omp itself |
| `/omp:setup [--stop-gate on\|off]` | Check the setup, create the config, toggle the Stop gate |

### The CLI

`omp-task` works on its own too (from a shell, a script, another agent):

```bash
omp-task run --detach -m smol --allow 'bun test*' --brief brief.md
```

```bash
omp-task wait 20261028-143002-ab12
```

| Command | |
|---|---|
| `run [text]`, `continue <job> [text]` | Start a task / continue a finished job's omp session |
| `wait <job…> \| --group G` | Block until done or a job needs you (exit 4) |
| `reply`, `approve [--session\|--deny]`, `steer`, `cancel` | Talk to a running job |
| `resume <job>` | Continue a job interrupted by a daemon restart |
| `status`, `result [--full]`, `list [-C dir] [--group G]`, `summary <group>` | Look at jobs |
| `diff`, `apply [--3way] [--keep]`, `discard`, `prune` | Worktree jobs |
| `review […]` | Structured read-only review |
| `plan apply <file> [--dry-run]` | A group of jobs with dependencies from YAML/JSON |
| `watch <job…> [--verbose]` | Event stream (piped: attention lines only) |
| `doctor`, `setup`, `daemon [status\|stop]`, `hook <name>` | Housekeeping |

Every reporting command takes `--json`. `omp-task --help` lists all flags.

Exit codes: 0 completed · 1 failed, cancelled, timeout, skipped or over budget · 2 usage error ·
3 `--max-wait` expired · 4 a job needs you · 5 the daemon is unavailable.

### Access, isolation, rules

| `--access` | omp runs with | Use for |
|---|---|---|
| `read` | read/search tools only | research, review, planning |
| `edit` (default) | file edits free; each shell command waits for `approve` or a rule | code changes |
| `full` | everything, no approvals (in a worktree by default) | tasks that run many commands |

`--allow GLOB` / `--deny GLOB` decide approvals without asking (`tool:<name>` for a whole
tool). Deny wins, and an allow rule never matches a command that chains, pipes or redirects.

### Configuration

`~/.config/claude-omp/config.json` (see [config.example.json](config.example.json)):

- `defaults` and named `presets` (`--preset NAME`): model, access, thinking, timeout, isolate,
  allow/deny, budget, stall_timeout.
- `max_concurrent` (4), `max_writers_per_repo` (1), `groups.<name>.{max_concurrent,budget_usd}`,
  `daily_budget_usd`.
- `auto_resume`, `daemon_idle_timeout` (15m), `on_session_end` (`keep` or `cancel` the
  session's jobs).
- `stop_gate`: `enabled`, `model` (smol), `timeout` (3m), `min_severity` (high),
  `max_per_session` (3), `focus`.

Limits and rules come only from this file and from plan files; a repository cannot raise them.
Environment overrides: `OMP_TASK_HOME` (state dir), `OMP_TASK_CONFIG` (config file),
`OMP_TASK_OMP_BIN` (omp binary), `OMP_TASK_DAEMON_IDLE` (seconds).

## How it works

- `omp-task` is a thin client. It talks HTTP over a unix socket to a per-user daemon, starting
  it on demand; the daemon stops after 15 idle minutes and restarts itself when the CLI is a
  newer version.
- The daemon keeps jobs in SQLite (`~/.local/state/claude-omp/state.db`) and runs each one as
  `omp --mode rpc` with the access flags and model, plus the worker preamble
  ([src/prompts/worker-preamble.md](src/prompts/worker-preamble.md)): stay inside the edit
  fence, ask rather than guess, do not commit, end with a fixed report.
- Over RPC it registers host tools in omp (`ask_orchestrator`, `notify_orchestrator`, and
  `submit_review` for reviews), turns omp's approval prompts into pending approvals (or decides
  them by rule), records cost and tools as they change, and enforces timeouts and budgets.
- Each job keeps its prompt, raw RPC frames (`events.jsonl`), result and review under
  `~/.local/state/claude-omp/jobs/<id>/`.
- The plugin's hooks remember the Claude session id for jobs (SessionStart), optionally cancel
  them when the session ends (SessionEnd), and run the opt-in review gate (Stop).

## Develop

```bash
bun install
```

```bash
bun run check
```

The tests drive the real CLI and daemon against a fake `omp` (`tests/fake-omp`) and replay
recorded omp RPC transcripts (`tests/fixtures/rpc`), so they need no provider access and cost
nothing. `bun run record` re-records the transcripts against a real omp.

```bash
claude plugin validate . --strict
```

## License

MIT
