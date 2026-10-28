---
description: Show omp jobs for this repository, or one job in detail
argument-hint: "[JOB | --group NAME]"
allowed-tools: Bash(omp-task *)
---

Show omp job status.

- With no arguments: `omp-task list -C "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" -n 15`.
- With a job id: `omp-task status $ARGUMENTS`.
- With `--group NAME`: `omp-task summary NAME`.

Summarise in a few lines: what is running, what waits on an answer or approval (and the exact
`omp-task reply`/`approve` command), what finished and what failed. Do not start `wait` or
`watch` unless the user asks.
