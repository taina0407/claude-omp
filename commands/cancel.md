---
description: Cancel a running, queued or blocked omp job
argument-hint: "JOB"
allowed-tools: Bash(omp-task *)
---

Run `omp-task cancel $ARGUMENTS` and report the result in one line. Jobs that depend on it
(`--after`) are skipped unless they were started with `--after-any-outcome`; if the job is in a
group, `omp-task status --group <group>` shows which.
