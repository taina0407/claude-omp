---
description: Show omp jobs for this repository, or one job in detail
argument-hint: "[JOB | --group NAME]"
allowed-tools: Bash(omp-task *)
---

Show omp job status.

- With no arguments: `omp-task list -n 15` (every recent job; `-C <dir>` would keep only jobs
  started with exactly that working directory).
- With a job id or `--group NAME`: `omp-task status $ARGUMENTS`.

Summarise in a few lines: what is running, what waits on an answer or approval (and the exact
`omp-task reply`/`approve` command), what finished and what failed. Do not start `wait` or
`watch` unless the user asks.
