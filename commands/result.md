---
description: Show the result of an omp job (report, changed files, cost)
argument-hint: "JOB [--full]"
allowed-tools: Bash(omp-task *)
---

Run `omp-task result $ARGUMENTS` and present it: status, changed files, cost, then the
worker's report. If the job ran in a worktree and has changes, mention `omp-task diff <job>`,
`omp-task apply <job>` and `omp-task review --job <job>`. The report is the worker's claim:
verify before you call anything done.
