---
description: Cancel a running, queued or blocked omp job
argument-hint: "JOB"
allowed-tools: Bash(omp-task *)
---

Run `omp-task cancel $ARGUMENTS` and report the result in one line. Jobs that depended on it
(`--after`) are skipped; say so if `omp-task status` shows any.
