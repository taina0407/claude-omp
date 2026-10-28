# Choosing a model and access level

## Models

`--model` is passed straight to omp, so it accepts anything `omp --model` does:

| Value                                                                      | Meaning                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| a role: `default`, `smol`, `slow`, `plan`, `task`, `designer`, `vision`, … | Whatever that role is bound to in the user's `~/.omp/agent/config.yml` (`modelRoles`). Portable across machines — prefer these. |
| a fuzzy name: `opus`, `gpt-6-luna`, `deepseek`                             | First matching model omp knows about.                                                                                           |
| an exact id: `openai/gpt-6-luna`, `opencode-go/deepseek-v4.1-flash:high`   | That model; a `:level` suffix sets thinking.                                                                                    |
| omitted                                                                    | omp's `default` role.                                                                                                           |

See what this machine has with `omp models` (providers and ids) and
`omp config get modelRoles` (role bindings).

Rough guide:

- Mechanical edits, boilerplate, renames, test scaffolding → `smol` or `task`.
- Normal feature work with clear spec → `default`.
- Hard debugging, design trade-offs, review → `slow` or `plan`, usually with `--access read`.
- UI / visual work → `designer` (or `vision` when screenshots are attached with `-f`).

Users can also define named presets (model + thinking + access + timeout) in
`~/.config/claude-omp/config.json` and select them with `--preset NAME`. Run
`omp-task doctor` to list them.

## Access levels

| `--access`       | omp flags                                                                                                 | Use for                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `read`           | only read/search tools                                                                                    | research, review, planning, second opinions                                            |
| `edit` (default) | `--approval-mode write`: file edits run freely; each `bash`/`eval` call waits for your `omp-task approve` | code changes; approve the test command, deny anything else                             |
| `full`           | `--approval-mode yolo`: everything incl. shell, no approvals                                              | tasks that run many commands themselves; use in a git worktree or a tree you can reset |

In `edit` mode an approval request pauses the worker and `omp-task wait` returns with exit 4,
unless an approval rule decides it. Unanswered approvals are denied after `--approval-timeout`
(default 20m). `ask_orchestrator` and `notify_orchestrator` work at every level.

## Approval rules

`--allow GLOB` approves and `--deny GLOB` denies matching requests without waking you
(repeatable; also `allow`/`deny` in config defaults and presets, which add up). A rule matches
the command text (`bun test*`, `git diff*`), or a whole tool when written `tool:<name>`. Deny
wins. An allow rule never matches a command that chains, pipes or redirects (`;`, `&&`, `|`,
`>`, `$(`), so `bun test*` cannot approve `bun test; rm -rf ~`.

## Isolation

`--isolate auto` (default) runs `--access full` jobs in a git worktree of the repo (branch
`omp/<job id>`) and others in the checkout. `--isolate worktree` forces a worktree (needs a
commit), `none` forces the checkout. A worktree job leaves your checkout untouched: inspect with
`omp-task diff <id>`, bring it over with `omp-task apply <id>`, or `discard`. `continue` keeps
working in the same worktree. Use worktrees for `full` access and for parallel writers.

## Budgets and limits

`--budget USD` stops a job as `over_budget` once it spends more. Group budgets
(`groups.<name>.budget_usd` or a plan's `budget_usd`) and `daily_budget_usd` keep new jobs from
starting and stop running ones. `max_concurrent` (default 4) and `max_writers_per_repo`
(default 1) queue jobs; queued jobs start by themselves.
