---
description: Check the omp plugin setup, create the config file, turn the Stop review gate on or off
argument-hint: "[--stop-gate on|off]"
allowed-tools: Bash(omp-task *) Bash(bun --version) Bash(omp --version)
---

1. Run `omp-task setup $ARGUMENTS`. It creates the user config (the path the report prints;
   default `~/.config/claude-omp/config.json`) from the example when missing, applies `--stop-gate`, and prints the doctor report.
2. If Bun is missing (exit 5 mentioning Bun), offer the two ways out: run
   `omp-task install-binary` (downloads this version's release binary and checks its sha256), or
   install Bun with `curl -fsSL https://bun.sh/install | bash`. If omp is missing, point to
   https://github.com/can1357/oh-my-pi.
   If the doctor says omp is TOO OLD, tell the user to update omp (omp-task needs 18.12 or
   later). The doctor does not check that a provider is logged in: if jobs fail on the model,
   suggest `omp login` and `omp models`.
3. Report in a few lines: omp version, daemon state, presets, and whether the Stop gate is on.
   The Stop gate reviews uncommitted changes with a cheap model when Claude finishes a turn and
   blocks the stop on findings at or above `stop_gate.min_severity` (default high); it costs a
   review per changed turn (at most `stop_gate.max_per_session`, default 3) and lets the stop
   through when the review fails or times out. Keep `stop_gate.timeout` at 4m or less: the hook
   itself is cut off after 5 minutes. Turning it on or off applies from the next Stop hook, which may be the end of this turn.
