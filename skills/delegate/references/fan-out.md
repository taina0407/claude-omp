# Fanning out: groups, dependencies, plan files

`omp-task plan apply plan.yaml` creates a whole group of jobs at once. Paths in `brief:` and
`files:` are relative to the plan file; `cwd:` is relative to where you run the command. `after`
names other tasks (or existing job ids). `{{result:<task>}}` in a prompt or brief is replaced
by that task's report when the dependent task starts.

```yaml
group: auth-refactor        # default: the file name
max_concurrent: 2           # this group's limit (global default 4)
budget_usd: 2.00            # once spent: no new jobs start, running ones stop
defaults: { model: smol, access: edit, isolate: worktree, allow: ["bun test*"] }
tasks:
  - name: schema
    brief: briefs/schema.md
  - name: api
    brief: briefs/api.md
    after: [schema]
  - name: ui
    prompt: "Build the settings page against this API: {{result:api}}"
    model: designer
    after: [api]
  - name: docs
    prompt: "Document the new endpoints."
    after: [api]
    after_any: true          # run even if api did not complete
```

Check the graph first with `omp-task plan apply plan.yaml --dry-run`. Then apply it, run
`omp-task wait --group auth-refactor` in the background and end your turn.
`omp-task summary auth-refactor` shows status, cost and changed files of every job. Review and
`apply` each worktree job as usual, in dependency order. `after` only orders the runs: a
dependent worktree task starts from `HEAD`, without the earlier tasks' unapplied changes, so
pass what it needs through `{{result:<task>}}` (or run the chain in the checkout).

Task keys: `name`, `prompt` or `brief` (exactly one), `title`, `after`, `after_any`, plus the
same settings as `defaults`: `model`, `preset`, `access`, `thinking`, `timeout`, `isolate`,
`carry_dirty`, `budget` (per job; the group's is the top-level `budget_usd`), `allow`, `deny`,
`stall_timeout`, `cwd`, `omp_args`, `files`. Any other key is an error.

`group` defaults to the plan file's name, and a group name covers every job ever created under
it (`wait --group`, `summary`, budget): give each run of a plan a fresh `group`.

Limits come from the user's config, the plan file and the flags you pass; a plan's
`max_concurrent`/`budget_usd` override the config's limits for that group. omp-task never reads
settings from the repository itself, but a plan file inside a repository is code you run:
read it before applying it.
