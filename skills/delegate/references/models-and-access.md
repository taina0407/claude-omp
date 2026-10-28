# Choosing a model and access level

## Models

`--model` is passed straight to omp, so it accepts anything `omp --model` does:

| Value                                                                      | Meaning                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| a role: `default`, `smol`, `slow`, `plan`, `task`, `designer`, `vision`, … | Whatever that role is bound to in the user's `~/.omp/agent/config.yml` (`modelRoles`). Portable across machines — prefer these. |
| a fuzzy name: `opus`, `gpt-6-luna`, `deepseek`                             | First matching model omp knows about.                                                                                           |
| an exact id: `openai/gpt-6-luna`, `opencode-go/deepseek-v4.1-flash:high`   | That model; a `:level` suffix sets thinking.                                                                                    |
| omitted                                                                    | The preset's or the config `defaults.model`, else omp's `default` role.                                                         |

See what this machine has with `omp models` (providers and ids) and
`omp config get modelRoles` (role bindings).

Rough guide:

- Mechanical edits, boilerplate, renames, test scaffolding → `smol` or `task`.
- Normal feature work with clear spec → `default`.
- Hard debugging, design trade-offs, review → `slow` or `plan`, usually with `--access read`.
- UI / visual work → `designer` (or `vision` when screenshots are attached with `-f`).

Users can also define named presets (model, thinking, access, timeout, isolate, allow/deny,
budget, stall_timeout) in the user config and select them with `--preset NAME`; flags you pass
override the preset. `omp-task doctor` prints the config path in use (default
`~/.config/claude-omp/config.json`; `$XDG_CONFIG_HOME` or `OMP_TASK_CONFIG` change it) and lists
the presets.

## Access levels

| `--access`       | omp flags                                                                                                 | Use for                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `read`           | only `read`, `grep`, `find`, `glob`, `web_search`, `todo`; no shell, no edits, so nothing to approve       | research, review, planning, second opinions                                            |
| `edit` (default) | `--approval-mode write`: file edits run freely; each `bash`/`eval` call waits for your `omp-task approve` | code changes; approve the test command, deny anything else                             |
| `full`           | `--approval-mode yolo`: everything incl. shell, no approvals                                              | tasks that run many commands themselves; use in a git worktree or a tree you can reset |

In `edit` mode an approval request pauses the worker and `omp-task wait` wakes you
(`WAKE: <id> approval`), unless an approval rule decides it. Unanswered approvals are denied
after `--approval-timeout` (default 20m). `ask_orchestrator` and `notify_orchestrator` work at
every level. Rules only decide requests omp sends: in `full` access nothing asks, so `--deny`
does not restrict it.

## Approval rules

`--allow GLOB` approves and `--deny GLOB` denies matching requests without waking you
(repeatable; also `allow`/`deny` in config defaults and presets, which add up). A rule matches
the command text (`bun test*`, `git diff*`), or a whole tool when written `tool:<name>`. Deny
wins. A command list joined with `&&`, `||` or `;` is approved only when every command in it
matches an allow rule (`mkdir -p src/x && cp a src/x/` with rules for both), so `bun test*`
cannot approve `bun test; rm -rf ~`; a deny rule matching any command denies the list. A
command-pattern rule never approves pipes, `&`, redirects or substitutions (`|`, `>`, `$(`).
The bash no-ops `true` and `:` are approved without a rule. A `tool:<name>` allow skips these
checks and approves every call of the tool, chained or not: treat it as a grant of the whole
tool.

`omp-task approve <id> --session` picks omp's "allow for this session" answer, which covers
**that tool** (e.g. every later `eval`) for the rest of the job, not every tool. A later request
for another tool (`bash` after `eval`) still asks.

## Isolation

`--isolate auto` (default) runs `--access full` jobs in a git worktree of the repo (branch
`omp/<job id>`) when the directory is a git repository with at least one commit; otherwise, and
for `read`/`edit` jobs, it runs in the checkout. `--isolate worktree` forces a worktree (needs a
commit), `none` forces the checkout. A worktree job leaves your checkout untouched: inspect with
`omp-task diff <id>`, bring it over with `omp-task apply <id>`, or `discard`. A worktree only
changes where the worker starts; it is not a sandbox: absolute paths (`-f` files, `--add-dir`)
still point at the original locations, so name the files it should edit in the brief relative
to the repository. `continue` keeps
working in the same worktree until it is applied (without `--keep`) or discarded. Use worktrees for `full` access and for parallel writers.

## Budgets and limits

`--budget USD` stops a job as `over_budget` once it spends more. Group budgets
(`groups.<name>.budget_usd` or a plan's `budget_usd`) and `daily_budget_usd` keep new jobs from
starting and stop running ones. `max_concurrent` (default 4) and `max_writers_per_repo`
(default 1) queue jobs; queued jobs start by themselves. An interrupted job keeps its slot until
it is resumed or cancelled.
