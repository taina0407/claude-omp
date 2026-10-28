---
description: Check the omp plugin setup, create the config file, turn the Stop review gate on or off
argument-hint: "[--stop-gate on|off]"
allowed-tools: Bash(omp-task *) Bash(bun --version) Bash(omp --version)
---

1. Run `omp-task setup $ARGUMENTS`. It creates `~/.config/claude-omp/config.json` from the
   example when missing, applies `--stop-gate`, and prints the doctor report.
2. If Bun is missing (exit 5 mentioning Bun), give the install command
   `curl -fsSL https://bun.sh/install | bash` and stop. If omp is missing, point to
   https://github.com/can1357/oh-my-pi.
3. Report in a few lines: omp version, daemon state, presets, and whether the Stop gate is on.
   The Stop gate reviews uncommitted changes with a cheap model when Claude finishes a turn and
   blocks the stop on high-severity findings; it costs a review per changed turn (at most
   `stop_gate.max_per_session`, default 3). Turning it on or off applies from the next turn.
