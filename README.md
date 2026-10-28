**English** | [Tiếng Việt](README.vi.md)

# omp

[![CI](https://github.com/taina0407/claude-omp/actions/workflows/ci.yml/badge.svg)](https://github.com/taina0407/claude-omp/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/taina0407/claude-omp)](https://github.com/taina0407/claude-omp/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Claude Code plugin that makes Claude the **orchestrator** and
[omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) the **worker**. Claude scopes a task,
chooses a model, and supervises execution through `omp-task`. A per-user daemon manages jobs
and wakes Claude for questions, approvals, checkpoints, stalls, or completion—not routine
progress. Claude checks the result, integrates worktree changes when isolation is used, and
can request another iteration. The repository is `claude-omp`; the installed plugin is
`omp@omp-tools`; the worker executable is `omp`.

```text
You → Claude ── brief / answers / approvals ──→ omp-task
       ↑                                         │ Unix socket
       │                                     per-user daemon
       └── attention or completion ←─────────────┤
                                                 └── RPC → omp worker
                                                      chosen model
```

[Quick start](#quick-start) · [Commands](#claude-code-commands) ·
[CLI](#cli-reference) · [Safety](#access-isolation-and-approval-rules) ·
[Troubleshooting](#troubleshooting-and-faq)

## Highlights

- **Attention-driven supervision.** Background waits return when Claude needs to act or jobs
  finish. Approval rules handle known commands without another conversation turn.
- **Access and isolation.** Choose read, edit, or full access; use a Git worktree to inspect,
  apply, or discard changes separately from your checkout.
- **Parallel work.** Groups, dependencies, result passing, concurrency limits, and spending
  budgets coordinate independent or ordered jobs.
- **Structured reviews.** Standard and adversarial reviewers return validated findings. An
  optional Stop hook can review changes before Claude finishes a turn.
- **Persistent jobs.** Inspect saved results, resume interrupted jobs, or continue a finished
  job's omp session with specific feedback.

## Quick start

### Requirements

- [Claude Code](https://code.claude.com) **2.1.91+** for plugin `bin/` support on the Bash
  tool's PATH.
- [Bun](https://bun.sh) **1.3+**, or a matching release binary for `omp-task`. Upstream omp
  still needs its own working installation.
- `omp` **18.12+** on PATH with an authenticated provider. Follow the
  [upstream setup](https://github.com/can1357/oh-my-pi), use `omp login`, and inspect `omp models`.
- Git for reviews, changed-file detection, and worktrees. A worktree requires a repository
  with at least one commit.

Release builds target Linux and macOS on x64 and arm64; native Windows binaries are not built.

### Install the plugin

Run these in your terminal:

```bash
claude plugin marketplace add taina0407/claude-omp
```

```bash
claude plugin install omp@omp-tools
```

In an existing Claude Code session, reload plugins:

```text
/reload-plugins
```

Then run setup:

```text
/omp:setup
```

The source launcher installs runtime dependencies on first use. Setup creates
`~/.config/claude-omp/config.json` from [config.example.json](config.example.json) if missing;
it preserves an existing file and prints diagnostics. Confirm that omp is found and the config
is present. `daemon: not running (starts on demand)` is normal. These diagnostics do not test
provider authentication.

### Delegate your first task

With prerequisites ready, aim to start this first job in under five minutes. Model completion
time depends on the provider. From this checkout, ask Claude:

```text
/omp:delegate Use the default model with read-only access to explain how
src/core/policy.ts resolves allow and deny rules. Include the tool: exception.
Do not change files.
```

**Illustrative conversation—not a recorded run:**

```text
Claude: I'll start a scoped read-only job and wait in the background.
        [The job finishes and the background wait returns.]
Claude: Deny rules win. Command-pattern allows reject pipes and redirects;
        tool-wide allows bypass that check. No files changed.
        The report includes the resolved model, recorded cost, and my checks.
```

Actual model names and costs come from job metadata, not this illustration. For another
repository, substitute a small file or question relevant to it. `/omp:status` shows jobs;
when a worker asks a question or needs approval, Claude handles that item and waits again.

### Other installation paths

From a checkout, install the plugin and link the CLI into `~/.local/bin`:

```bash
./install.sh
```

Or install only the CLI, dependencies, and user config:

```bash
./install.sh --cli
```

These installer paths require Bun. Plugin installation makes `omp-task` available to Claude's
Bash tool; it does not add it to your ordinary terminal PATH. The checkout installer creates
that link; ensure `~/.local/bin` is on PATH.

To use a release binary instead of the Bun source runtime, run this through Claude's Bash tool
or a terminal where the launcher is available:

```bash
omp-task install-binary
```

The launcher downloads its own version's binary, verifies SHA-256 against `SHA256SUMS`, and
prefers it afterward. Binary installation requires `curl` and `sha256sum` or `shasum`.

## When to use it

### Good fits—and when to keep the task in Claude

Delegate self-contained work with a clear edit boundary and a result that is cheaper to check
than to produce: mechanical refactors, bounded features, research, or another model's review.
Independent tasks can run in parallel when their changes do not overlap.

Keep one-line edits, conversation-dependent decisions, and files Claude is already editing in
the current session. Delegation adds briefing and review work, plus worker-provider usage;
choosing another model does not guarantee lower total cost. Claude remains responsible for
checking the actual diff and the brief's acceptance command before reporting success.

### Compared with running omp directly

| Workflow | Choose it when |
|---|---|
| Claude alone | The task depends on the current conversation or needs no separate worker. |
| omp directly | You want to interact with the worker yourself. |
| This plugin | Claude should own the brief, answers, review, and integration while omp executes. |
| `/omp:transfer` | You want to continue the transcript in interactive omp instead. |

Transfer prints `omp --from-claude` for you to run in your terminal and select the session.
It is not an automatic handoff; later Claude messages stay in Claude.

## Claude Code commands

Ask in plain words or invoke a namespaced command. `delegate` is a
[skill](skills/delegate/SKILL.md); the other entries come from [commands/](commands/).

| Command | Outcome |
|---|---|
| `/omp:delegate <task>` | Scope, brief, start, wait, answer, review, integrate, and report. |
| `/omp:review [--staged \| --base REF \| --commit SHA \| --job ID] [--focus TEXT] [-m MODEL]` | Read-only review; no target means uncommitted changes, including untracked files. |
| `/omp:adversarial-review …` | Same targets; asks the reviewer to try to break the change. |
| `/omp:status [JOB \| --group NAME]` | This repository's jobs, one job, or a group summary. |
| `/omp:result JOB` | Report, changed files, and recorded cost. |
| `/omp:cancel JOB` | Cancel a job; unsuccessful dependencies cause dependent jobs to be skipped by default. |
| `/omp:transfer` | Print the command for continuing this transcript in interactive omp. |
| `/omp:setup [--stop-gate on\|off]` | Create missing config, print diagnostics, and optionally toggle the Stop gate. |

Review commands report findings without changing code. Claude checks the cited scenarios;
findings remain claims to evaluate, not instructions to follow. The Stop gate is off unless
you enable it.

## CLI reference

### Task lifecycle

`omp-task` also works from a shell, script, or another agent. Write a brief with the goal,
allowed files, constraints, and acceptance command; then start it:

```bash
omp-task run --detach --model default --access edit --isolate worktree --timeout 20m --allow 'bun test*' --brief brief.md
```

Replace `JOB` below with the returned ID:

```bash
omp-task wait JOB
```

Without `--detach`, `run` waits itself. In Claude, the skill backgrounds `wait` and ends the
turn; terminal users can wait in the foreground. Do not poll status to emulate waiting.

| Commands | Purpose |
|---|---|
| `run [text]`, `continue JOB [text]`, `resume JOB` | Start; create a new job using a finished job's session; resume an interrupted job under its existing ID. |
| `wait JOB…`, `wait --group NAME`, `watch JOB…` | Wait for attention/completion, or stream events. |
| `reply JOB TEXT`, `approve JOB [--session\|--deny]`, `steer JOB TEXT`, `cancel JOB` | Answer, approve/deny, redirect, or abort. |
| `status JOB`, `status --group NAME`, `result JOB [--full]`, `list [-C DIR] [--group NAME]`, `summary NAME` | Inspect state, reports, recent jobs, and group spending. |
| `doctor`, `setup`, `daemon [status\|stop]`, `hook NAME`, `install-binary` | Diagnostics, configuration, daemon control, plugin hooks, and binary installation. |

### Worktrees, reviews, and parallel plans

For a finished worktree job: inspect `omp-task diff JOB`, check the changes, optionally run
`omp-task review --job JOB`, then `omp-task apply JOB` or `omp-task discard JOB`.
A successful apply removes the worktree unless you pass `--keep`.

Reviews accept `--staged`, `--base REF` (since the merge-base), `--commit SHA`, or `--job ID`;
add `--adversarial` or `--focus TEXT`. Verdicts and findings are schema-checked.

For fan-out, use `--group NAME`, `--after JOB`, and `{{result:JOB}}` in briefs. Failed
dependencies propagate `skipped` unless `--after-any-outcome` is set. Dependencies order
execution; they do not merge worktree changes. Apply dependent worktrees in dependency order.
For YAML/JSON graphs, use `omp-task plan apply plan.yaml --dry-run` before applying the plan;
see the [fan-out guide](skills/delegate/references/fan-out.md).

`prune` removes old worktrees; `prune --jobs` deletes finished job records and files. Both
support `--older` and `--dry-run`. Preview removals before deleting work you might need.

### Output and exit codes

`--json` is accepted by `run`, `continue`, `resume`, `review`, `wait`, `status`, `result`,
`list`, `summary`, `plan apply`, and `daemon status`. It is not universal: `diff`, `watch`,
and `doctor` do not produce JSON. `plan apply --dry-run` prints a text preview even with
`--json`.

`wait` limits ordinary completed reports to 40 lines and 12,000 characters. Use `result --full`
for the complete report, not a conversation transcript. For reviews, `result --json` also
includes the validated review object. Piped `watch` defaults to attention-related events;
`--verbose` includes routine events too.

| Exit | Meaning for `wait` or a task command waiting for completion |
|---|---|
| 0 | All watched jobs completed, or one needs attention: question, approval, checkpoint, stall, or interruption. |
| 1 | Failure, cancellation, timeout, skipped dependency, or exceeded budget. |
| 2 | Usage or configuration error. |
| 3 | `--max-wait` expired; this stops waiting, not the job. |
| 5 | Daemon unavailable or source runtime could not start. |

Exit 0 does not mean done: read the last line. `WAKE: done (…)` means every job ended;
`WAKE: <job> <reason>` means one needs you, with a `PENDING:` line per open question or
approval just above it. Handle the item and wait again. A detached start returns 0 when submitted, not when the task completes. For
the complete flag inventory, run `omp-task --help`.

## Access, isolation, and approval rules

### Access modes

| `--access` | Worker permissions | Typical use |
|---|---|---|
| `read` | Restricted read/search tools, web search, and task tracking; no shell or file-edit tools. | Research and review. |
| `edit` (default) | File edits run freely; approval-required execution is forwarded to Claude or decided by rules. | Scoped code changes. |
| `full` | omp's `yolo` approval mode: no approval prompts. | Trusted tasks needing shell execution. |

Approval rules only decide requests omp sends. A deny rule is not an execution restriction
when the worker runs without approval prompts. A brief's edit fence and a worktree are not
operating-system sandboxes: do not treat them as protection against untrusted code or models.

### Worktree isolation

The default, `--isolate auto`, chooses a worktree only for full-access jobs in a Git repository
with a commit. Otherwise the job uses the checkout—including full-access jobs outside such a
repository. Edit access does not automatically isolate. Use explicit `--isolate worktree`
when isolation is required; it rejects an unsuitable repository. `--isolate none` forces
the checkout.

Worktrees start from HEAD under the state directory, on branch `omp/JOB`. Existing dirty
changes are absent unless `--carry-dirty` copies them, including untracked non-ignored files;
they are committed on the job's branch as its starting point, so `diff` and `apply` show only
the worker's changes. `continue` inherits its parent's isolation and worktree while that
worktree remains available: iterate before a plain `apply` or `discard` removes it.

Plain `apply` checks the patch before applying it. **`apply --3way` can leave conflict markers
and unmerged files in your main checkout**, even after its check passes. Inspect and resolve
those files before proceeding. `discard` and worktree pruning remove the worker's changes
without applying them; neither is an undo command for changes already applied.

### Approval rules

Repeatable `--allow GLOB` and `--deny GLOB` match the whole approval subject: `*` matches any
text and `?` one character. Deny wins. A command list joined with `&&`, `||` or `;` is split
into its commands (separators inside quotes do not count): a command-pattern allow such as
`--allow 'bun test*'` approves it only when every command matches an allow rule, and a deny rule
that matches any one of them denies it. Command-pattern allows never approve pipes, background
`&`, redirects, command substitutions, backticks, or newlines. The bash no-ops `true` and `:`
are approved without a rule.

**Whole-tool allows such as `--allow 'tool:bash'` bypass that filter.** Use narrow
command patterns unless you intend to grant the entire tool. Rules do not inspect what a
permitted script does internally.

`approve JOB` approves one pending request; `--session` allows that same tool for the rest of
the job (a request for another tool still asks), and `--deny` rejects it. Questions and approvals expire after 20 minutes by default, controlled
by `--answer-timeout` and `--approval-timeout`. Expired approvals are denied; expired questions
release the worker to proceed on an assumption.

## Configuration

### Config location and presets

The default file is `~/.config/claude-omp/config.json`, or
`$XDG_CONFIG_HOME/claude-omp/config.json`. `OMP_TASK_CONFIG` overrides the full path.
[config.example.json](config.example.json) contains the setup values and named presets.
For example, its `cheap` preset is:

```json
{
  "model": "smol",
  "access": "edit",
  "timeout": "20m"
}
```

Select it with `--preset cheap`. Model roles such as `default`, `smol`, and `slow` resolve
through omp's own configuration; inspect them with `omp config get modelRoles`. A preset
combines task settings; it is not itself a model role.

Scalar task settings generally resolve as flags → preset → parent job for `continue` → user
`defaults` → built-in fallback. Access defaults to `edit`, timeout to `30m`, and stall
notification to `10m` (`stall_timeout: 0` disables inactivity notifications). Approval lists
merge across defaults, preset, parent, and flags. Continuation inherits isolation rather
than replacing it through that precedence chain.

### Concurrency, spending, and lifecycle

`max_concurrent` defaults to 4. `max_writers_per_repo` defaults to 1 for jobs editing the same
checkout directly; isolated writers do not share that writer slot. Groups support
`max_concurrent` and `budget_usd`; per-job `budget`/`--budget` and `daily_budget_usd` also limit
spending. Jobs exceeding a budget stop as `over_budget`; budgets are not prepaid hard caps.

Setup seeds a $10 daily budget. Without that configuration, there is no built-in daily cap.
No repository-local config is loaded automatically, but explicit flags affect task settings,
and selected plan files can override configured group limits. These are not immutable
administrator policies; review plans before running them.

`auto_resume` is off unless enabled. The daemon idles out after 15 minutes without jobs or
clients. `on_session_end` defaults to `keep`; `cancel` stops that Claude session's jobs.
Finished jobs and their files expire after `job_retention` (30 days); `0` disables automatic
retention deletion. Jobs owning worktrees are retained until those worktrees are removed.

The optional `stop_gate` defaults to model `smol`, timeout `3m`, minimum severity `high`, and
at most 3 review attempts per Claude session. Enable it with `/omp:setup --stop-gate on`;
use `off` to disable it. It skips an unchanged diff and recursive Stop hooks. **It fails open:**
a failed, timed-out, or otherwise incomplete review does not block Claude. Each review uses
provider resources; reaching the cap does not certify subsequent changes.

### Environment overrides

| Variable | Purpose |
|---|---|
| `OMP_TASK_HOME` | State directory, including database, jobs, and worktrees. |
| `OMP_TASK_CONFIG` | User configuration file path. |
| `OMP_TASK_OMP_BIN` | Worker executable path or name. |
| `OMP_TASK_DAEMON_IDLE` | Daemon idle timeout in seconds. |

`XDG_STATE_HOME` changes the default state base; `XDG_RUNTIME_DIR` changes the socket location.
The daemon is long-lived and inherits its launch environment: changing a variable in a new
client shell does not reconfigure the already-running process.

## How it works

### From brief to result

`omp-task` talks HTTP over a Unix socket to one daemon per state directory, starting it on
demand. The daemon owns SQLite job state, schedules work, and launches `omp --mode rpc` with
the selected access flags, model, and [worker preamble](src/prompts/worker-preamble.md).
Workers can ask through `ask_orchestrator`, report through `notify_orchestrator`, and submit
structured reviews through `submit_review`. The daemon tracks tool activity and cost,
forwards approvals, and enforces timeouts and budgets.

The preamble instructs workers to stay in scope, ask rather than guess, and avoid commits.
Claude still checks the real changes and acceptance criteria; a worker's final report is not
proof of correctness. Committing is not part of the default delegation workflow.

### State, hooks, and recovery

State defaults to `~/.local/state/claude-omp/`: `state.db`, `jobs/JOB/`, worktrees, and daemon
logs. Job artifacts include prompts, raw RPC events (`events.jsonl`), results, and review
material. They can contain source code and sensitive task context; redact before sharing.

SessionStart records the Claude session ID, SessionEnd optionally cancels its jobs, and Stop
runs the opt-in review gate. Interrupted jobs normally resume their saved omp session using
`resume`; if omp never saved the session, the task can restart instead. `continue` is for
feedback on a finished job and creates a new job record.

On a client connection, an idle daemon with a different version is replaced—not only when
the client is newer. Active jobs prevent that replacement; a later connection can replace
it after they finish. The daemon also stops after its idle timeout.

## Troubleshooting and FAQ

### Setup and discovery

| Symptom | Action |
|---|---|
| Slash commands are missing | Confirm installation with `claude plugin list`, then `/reload-plugins` in Claude. |
| `omp-task` works in Claude but not a terminal | Plugin PATH is scoped to Claude's Bash tool. Use the checkout CLI installer and check `~/.local/bin` on PATH. |
| Bun is missing | Install Bun, or run `omp-task install-binary` through the plugin launcher. |
| omp or the selected model fails | Run `omp-task doctor`, then check `omp login`, `omp models`, and role bindings. Doctor does not verify provider credentials. |

### Jobs, worktrees, and reviews

An apparently quiet `wait` is normal: routine progress does not wake it. `WAKE: <job> <reason>`
means answer with `reply`, decide an `approve` request, inspect a checkpoint/stall, or
`resume JOB --detach` an interrupted job; then re-run the same `wait`. `watch JOB --verbose
--last 40` prints the latest events and exits, even while the job runs; a plain `watch` follows
it until it ends.

For `queued` jobs, inspect concurrency and writer limits. `blocked` waits for dependencies;
`skipped` means a required dependency did not complete. For `over_budget`, inspect the job,
group, and daily spending using `status`, `result`, and `summary` before retrying.

If `apply` fails, inspect `diff` and the error before changing your checkout. Do not blindly
retry with `--3way`: it can leave merge conflicts. A silent Stop gate may be disabled, skipping
a repeated diff, capped for the session, or failing open—not necessarily approving the code.

For daemon connection failures, inspect `daemon.out` and `daemon.log` under the state
directory. Report reproducible problems in [GitHub issues](https://github.com/taina0407/claude-omp/issues)
with CLI/omp versions, diagnostics, and redacted errors. Do not upload unreviewed job artifacts.

## Development

### Local checks

From this checkout:

```bash
bun install
```

```bash
bun run check
```

```bash
claude plugin validate . --strict
```

`check` runs TypeScript checking, Biome, and the test suite. Ordinary tests drive the real CLI
and daemon against fake omp and replay recorded RPC fixtures, so they need no provider access.
Real-provider contract tests are skipped unless explicitly enabled.

### Real-provider checks and release builds

Run contract tests against your installed omp and the `smol` role:

```bash
bun run contract
```

Or choose another contract model:

```bash
OMP_CONTRACT_MODEL=task bun run contract
```

These invoke real providers and can incur charges. To refresh recorded RPC transcripts:

```bash
bun run record
```

Build self-contained binaries and `SHA256SUMS` in `dist/`:

```bash
bun run build
```

Pushing a matching `v*` version tag runs checks, builds binaries, and publishes a release;
see the [release workflow](.github/workflows/release.yml). The
[brief template](skills/delegate/references/brief-template.md),
[model/access guide](skills/delegate/references/models-and-access.md), and
[fan-out guide](skills/delegate/references/fan-out.md) contain detailed delegation examples.
Use `omp-task --help` for flags and the config example for settings rather than duplicating
those references here.

## Upgrading and uninstalling

### Upgrading

Read [CHANGELOG.md](CHANGELOG.md) for release-specific changes. Upgrade the installed plugin:

```bash
claude plugin update omp@omp-tools
```

Reload plugins in open sessions. When a release changes the job database layout, the daemon
resets the database on its first start: earlier job records are dropped, while job files and
worktrees on disk stay until you remove them. Setup preserves existing configuration,
so compare it with the current example when adopting new settings. A release binary from
another version is ignored; run `omp-task install-binary` again if you use that runtime.

### Uninstalling

Remove the plugin:

```bash
claude plugin uninstall omp@omp-tools
```

For a checkout installation, use its uninstaller instead:

```bash
./install.sh --uninstall
```

The checkout uninstaller removes the CLI symlink and plugin and forcibly stops the daemon,
interrupting active jobs. It keeps user config and state. Removing retained data is a separate,
destructive choice; uninstalling does not erase it automatically.

## License

[MIT](LICENSE). Built around [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi).
