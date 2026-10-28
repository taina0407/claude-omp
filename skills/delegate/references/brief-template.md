# <Task title>

## Goal
What should be true when this is done, in one or two sentences.

## Context
Only what the worker cannot discover quickly itself: decisions already made, the relevant
module, links between files, gotchas found so far. Point at files instead of pasting them.

## Scope
- May edit: `path/one.ts`, `path/two/` (be explicit — the worker treats this as a fence)
- May read: anything
- Must not touch: `path/three/`, generated files, lockfiles

## Allowed commands
The shell commands the worker may run, e.g. `bun test path/to/spec`, `bun run typecheck`. Start
the job with a matching `--allow` for each (`--allow 'bun test*' --allow 'bun run typecheck'`),
so they never wake you. Anything else asks for approval; for a docs or research task, say
"none: verify with the read/search tools".

## Requirements
1. ...
2. ...

## Checkpoint (optional, at most one or two)
After <the schema / the plan / the first migration> is done, call `notify_orchestrator` with
`checkpoint: true` and a one-line summary, then carry on without waiting.

## Done when
- [ ] Behaviour X works (how to see it)
- [ ] `bun test path/to/spec` passes (the exact command to run)
- [ ] No unrelated files changed
