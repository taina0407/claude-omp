# omp-delegate

A Claude Code plugin that makes Claude the **orchestrator** and [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi)
the **worker**. Claude writes a scoped brief, hands it to omp running whatever model you pick
(GPT, Gemini, DeepSeek, Claude, local…), reviews the diff, and sends follow-ups into the same
omp session until it is right.

```
you ──► Claude (plan, brief, review) ──omp-task──► omp -p --mode json (any model)
                ▲                                         │
                └──── status · changed files · report ◄───┘
```

It has two parts:

- **`delegate` skill** (`skills/delegate/SKILL.md`): when to delegate, how to write a brief and
  pick a model and access level, and how to review the result.
- **`omp-task` CLI** (`skills/delegate/scripts/omp-task`): one Python file with no dependencies.
  It wraps `omp`, records every run as a job, and returns a compact result: status, model, cost,
  tools used, changed files and the worker's report. It also works on its own from a shell, and
  other agents can drive it.

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

You can also just ask: *"let omp do the test scaffolding with a cheap model"*, or *"get a second
opinion on this design from gpt via omp, read-only"*.

From a shell:

```bash
omp-task doctor
```

```bash
omp-task run --brief task.md --model smol --access edit --cwd ~/code/app
```

```bash
omp-task continue 20261025-1142-ab12 "tests in orders.spec.ts still fail: …"
```

```bash
omp-task run --detach --preset reviewer "review src/auth for injection risks"
```

```bash
omp-task wait <id> <id> --max-wait 540
```

```bash
omp-task list --cwd .
```

Every command takes `--json`. Run `omp-task <command> --help` for the full list of flags.

### Models

`--model` is passed through to `omp --model`, so it accepts:

- **role names** (`smol`, `task`, `default`, `slow`, `plan`, `designer`, `vision`). These resolve
  through `modelRoles` in `~/.omp/agent/config.yml`, which keeps briefs portable between machines.
- **fuzzy names** (`opus`, `deepseek`)
- **exact ids** (`openai/gpt-6-luna:high`)

### Access levels

| `--access` | Worker can | omp flags |
|---|---|---|
| `read` | read and search only | `--tools read,grep,find,glob,web_search,todo` |
| `edit` (default) | edit files, no shell | `--approval-mode write` |
| `full` | everything, shell included | `--approval-mode yolo` |

The worker runs headless, so any action outside its access level is denied rather than prompted.
Use `full` only in a git worktree or in a tree you can reset.

### Presets

Presets are named bundles of `model`, `access`, `thinking`, `timeout` and `omp_args`. Define them
in `~/.config/claude-omp/config.json` (see `config.example.json`) and select one with
`--preset NAME`. The `defaults` block in the same file applies to every run.

## How a job works

1. `omp-task` stores the prompt in a job folder: `~/.local/state/claude-omp/jobs/<id>/`.
2. It takes a git snapshot of the dirty files in the repo.
3. It runs `omp -p --mode json` with the access flags, the chosen model and `--max-time`. On a
   new session it also appends the worker preamble (`skills/delegate/prompts/worker-preamble.md`),
   which tells omp to stay inside the brief's edit fence, not commit, and end with a fixed report
   format.
4. It parses omp's event stream (`events.jsonl`) into `meta.json` (status, session id, model,
   tokens, cost, tools, errors), saves the final message to `result.md`, and compares a second
   git snapshot with the first to list the changed files.
5. `continue` starts a child job that runs `omp --resume <session>`, so the worker keeps its
   context.

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
