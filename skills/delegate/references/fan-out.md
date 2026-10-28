# Fanning out: groups, dependencies, plan files

`omp-task plan apply plan.yaml` creates a whole group of jobs at once. Paths in `brief:` and
`files:` are relative to the plan file; `cwd:` is relative to where you run the command. `after`
names other tasks (or existing job ids). `{{result:<task>}}` in a prompt or brief is replaced
by that task's report when the dependent task starts.

```yaml
group: auth-refactor        # default: the file name
max_concurrent: 2           # this group's limit (global default 4)
budget_usd: 2.00            # the group stops starting jobs once it spent this
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

Then: `omp-task wait --group auth-refactor` in the background and end your turn. Check the
graph first with `--dry-run`. `omp-task summary auth-refactor` shows status, cost and changed
files of every job. Review and `apply` each worktree job as usual, in dependency order.

Limits (concurrency, budgets, approval rules) come only from the user's config and plan files;
a repository cannot raise them.
