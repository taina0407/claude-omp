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

omp runs in RPC mode under a supervisor. In `edit` mode an approval request pauses the worker,
and `omp-task wait` returns with exit 4 so you can decide. Approvals left unanswered are denied
after `--approval-timeout` (default 20m). `ask_orchestrator` and `notify_orchestrator` are
available at every level.
