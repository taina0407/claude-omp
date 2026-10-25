# omp-delegate

A Claude Code plugin that makes Claude the **orchestrator** and [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi)
the **worker**. Claude writes a scoped brief and hands it to omp, which runs whatever model you
pick (GPT, Gemini, DeepSeek, Claude, local…). While the job runs, Claude supervises it live:
it answers the worker's questions, approves shell commands, and can steer or abort the job.
Afterwards it reviews the diff and sends follow-ups into the same omp session until the result
is right. Claude is woken up by events instead of polling.

```
             brief · steer · reply · approve · abort
you ─► Claude ─────────────────────────────────────► supervisor ──RPC──► omp --mode rpc (any model)
         ▲          (unix socket per job)                │   ▲ ask_orchestrator / notify_orchestrator
         └──── wait (exit 0/1/4) · watch feed ◄──────────┘   └ approval requests for shell commands
```

It has two parts:

- **`delegate` skill** (`skills/delegate/SKILL.md`). It covers when to delegate, how to write a
  brief and pick a model and access level, how to supervise a job without polling, and how to
  review the result.
- **`omp-task` CLI** (`skills/delegate/scripts/omp-task`). It is one Python file with no
  dependencies. It starts a detached supervisor per job that drives `omp --mode rpc`. It records
  everything and returns a compact result: status, model, cost, tools used, changed files and
  the worker's report. You can also use it on its own from a shell, and other agents can drive
  it.

## Requirements

- [Claude Code](https://code.claude.com)
- `omp` on `PATH`, with at least one provider logged in (`omp login`, then check with `omp models`)
- Python 3.9 or later
- git (optional; needed for changed-file detection)

## Install

### As a plugin (recommended, works on any machine)

From GitHub:

```bash
claude plugin marketplace add taina0407/claude-omp
```

```bash
claude plugin install omp-delegate@omp-tools
```

From a local checkout (`git clone https://github.com/taina0407/claude-omp`):

```bash
./install.sh
```

`install.sh` adds this checkout as the `omp-tools` marketplace, installs the plugin at user
scope, links `omp-task` into `~/.local/bin`, and creates `~/.config/claude-omp/config.json` from
`config.example.json` if it doesn't exist yet.

### Dev mode (edits apply live)

```bash
./install.sh --link
```

This symlinks the checkout to `~/.claude/skills/omp-delegate`, where Claude Code loads it as
`omp-delegate@skills-dir`. Run `/reload-plugins` after each change.

Other options: `./install.sh --cli` installs only the CLI, and `./install.sh --uninstall`
removes everything.

## Use

In Claude Code:

```
/omp-delegate:delegate add pagination to the orders endpoint, use deepseek
```

You can also just ask: _"let omp do the test scaffolding with a cheap model"_, or _"get a second
opinion on this design from gpt via omp, read-only"_.

From a shell:

```bash
omp-task doctor
```

Start a job; this prints the job id at once:

```bash
omp-task run --detach --brief task.md --model smol --cwd ~/code/app
```

Block until the job is done or needs you. Exit 4 means it is waiting on you:

```bash
omp-task wait <id>
```

Answer the worker's question, or decide on a shell command it wants to run:

```bash
omp-task reply <id> "use the existing pagination helper"
```

```bash
omp-task approve <id> --session
```

Redirect a running job, or stop it:

```bash
omp-task steer <id> "skip the docs, focus on the endpoint"
```

```bash
omp-task cancel <id>
```

Stream one line per event (handy with Claude's Monitor tool):

```bash
omp-task watch <id> --quiet
```

Send a follow-up into the same omp session after the job ends:

```bash
omp-task continue <id> "tests in orders.spec.ts still fail: …"
```

Without `--detach`, `run` waits like `wait` does. `status`, `result` and `list` report on
jobs. Every command takes `--json`. Run `omp-task <command> --help` for all flags.

### Exit codes

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| 0    | all jobs completed                            |
| 1    | a job failed, was cancelled, or timed out     |
| 2    | usage error                                   |
| 3    | `--max-wait` expired                          |
| 4    | a job is waiting for an answer or an approval |

### Supervising without polling (Claude Code)

The skill tells Claude to:

1. start jobs with `run --detach`;
2. run `omp-task wait <ids>` as a **background** command. Claude is notified when that command
   exits, which happens when all jobs are done or one needs an answer;
3. optionally also run `omp-task watch <ids>` under the **Monitor** tool. Each feed line
   (question, approval, edit, shell command, progress, end) then reaches Claude as it happens,
   so Claude can steer early.

Questions and approvals that nobody answers expire (`--answer-timeout`, `--approval-timeout`,
default 20m each). When a question expires, the worker carries on with a stated assumption.
When an approval expires, the command is denied.

### Models

`--model` is passed through to `omp --model`, so it accepts:

- **role names** (`smol`, `task`, `default`, `slow`, `plan`, `designer`, `vision`). These resolve
  through `modelRoles` in `~/.omp/agent/config.yml`, which keeps briefs portable between machines.
- **fuzzy names** (`opus`, `deepseek`)
- **exact ids** (`openai/gpt-6-luna:high`)

### Access levels

| `--access`       | Worker can                                                       | omp flags                                     |
| ---------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| `read`           | read and search only                                             | `--tools read,grep,find,glob,web_search,todo` |
| `edit` (default) | edit files; each shell/eval command waits for `omp-task approve` | `--approval-mode write`                       |
| `full`           | everything, shell included, no approvals                         | `--approval-mode yolo`                        |

Use `full` only in a git worktree or in a tree you can reset. The `ask_orchestrator` and
`notify_orchestrator` tools are available at every level.

### Presets

Presets are named bundles of `model`, `access`, `thinking`, `timeout` and `omp_args`. Define them
in `~/.config/claude-omp/config.json` (see `config.example.json`) and select one with
`--preset NAME`. The `defaults` block in the same file applies to every run.

## How a job works

1. `omp-task` stores the prompt in a job folder, `~/.local/state/claude-omp/jobs/<id>/`, and
   starts a detached **supervisor** process for the job.
2. The supervisor takes a git snapshot of the dirty files in the repo. Then it starts
   `omp --mode rpc` with the access flags and the chosen model. For a new session it also
   appends the worker preamble (`skills/delegate/prompts/worker-preamble.md`), which tells omp
   to stay inside the brief's edit fence, ask rather than guess, not commit, and end with a
   fixed report format.
3. Over RPC, the supervisor registers two host tools in omp, `ask_orchestrator` and
   `notify_orchestrator`, reads the session id, and sends the prompt.
4. It listens on a unix socket in the job folder for `steer`, `abort`, `reply` and `approve`.
   omp's approval prompts for shell commands become pending approvals, and `ask_orchestrator`
   calls become pending questions. Both set the job to `waiting`.
5. It appends one compact line per event to `feed.jsonl`, which `watch` streams, and stores
   omp's raw frames in `events.jsonl`. It enforces `--timeout` by sending omp an RPC `abort`.
6. When omp's agent loop ends, the supervisor closes omp and writes the results. `meta.json`
   gets status, session id, model, tokens, cost, tools, denied tools and errors. `result.md`
   gets the final message. A second git snapshot is compared with the first to list the
   changed files.
7. `continue` starts a child job with `omp --resume <session>`, so the worker keeps its context.

Environment overrides: `OMP_TASK_HOME` (state dir), `OMP_TASK_CONFIG` (config file),
`OMP_TASK_OMP_BIN` (omp binary).

## Develop

The tests use a fake `omp` binary, so they need no provider access and cost nothing:

```bash
python3 -m unittest discover tests
```

```bash
claude plugin validate . --strict
```

## License

MIT
