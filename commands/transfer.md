---
description: Continue this conversation in omp itself (prints the command to run in a terminal)
allowed-tools: Bash(pwd) Bash(date *)
---

omp can import a Claude Code session, but only in its interactive mode, so the user has to run
it in their own terminal. Tell them, in this form:

```bash
cd "<current working directory>" && omp --from-claude
```

then to pick this session in omp's list: it is the one in this directory, last active
<current local time, from `date '+%Y-%m-%d %H:%M'`>. Mention that the omp session starts from
the transcript so far; anything after this point stays here.
