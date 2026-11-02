---
description: Show or set how Claude waits on omp jobs - the omp:job agent (one row per job) or a background Bash wait
argument-hint: "[subagent|bash]"
allowed-tools: Bash(omp-task mode*)
---

Run `omp-task mode $ARGUMENTS` and report its first line in one sentence.

- `subagent` (the default): Claude waits on each job through the plugin's `omp:job` agent,
  started in the background. Each job gets a row in the agent panel of Claude Code and Orca, with
  its state, model, time, cost and what it waits on; a cheap model (haiku) relays the job's
  wake-ups, about $0.001 each.
- `bash`: Claude waits with a background `omp-task wait` Bash command, as before 1.6. No agent
  rows, no haiku cost.

A change applies to jobs started from now on; jobs Claude already waits on keep their way of
waiting. Do not start, wait on or re-arm any job here.
