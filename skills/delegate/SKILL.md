---
name: delegate
description: Delegate a coding, research or review task to the omp (oh-my-pi) agent running a model of your choice, then review and iterate on its result while you stay the orchestrator. Use when the user asks to hand work to omp, another model, a cheaper/faster model, GPT, Gemini, DeepSeek, or "a worker"; to get a second opinion from a different model; or to run several well-scoped tasks in parallel.
when_to_use: Triggers include "delegate this to omp", "let omp do it", "use deepseek/gpt/gemini for this", "get a second opinion from another model", "run these in parallel with omp", "/delegate".
argument-hint: "[task description]"
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/omp-task *)
license: MIT
compatibility: Requires the omp CLI (oh-my-pi) on PATH and Python 3.9+.
---

# Delegate to omp

You are the orchestrator. omp is a worker: it runs headless with one model, does one well-scoped
task, and returns a report. You own the plan, the brief, the review and what you tell the user.

The tool is `${CLAUDE_SKILL_DIR}/scripts/omp-task`. Run `${CLAUDE_SKILL_DIR}/scripts/omp-task --help`
(or `<command> --help`) for every flag. First use on a machine: run `... omp-task doctor`.

## When delegating pays off

Delegate when the task is self-contained, the spec fits in a page, and checking the result is
cheaper than doing it: boilerplate, mechanical refactors, test scaffolding, a bounded feature with
a clear "done", a read-only investigation, or a review by a different model. Keep it yourself when
it needs this conversation's nuance, touches many files you are also editing, or is a one-liner.

## Workflow

1. **Scope.** Decide the exact files the worker may edit. Two writers must never touch the same
   files: do not edit those files yourself while a job runs, and give parallel jobs disjoint
   scopes. If the user has uncommitted work in those files, say so before delegating.

2. **Write the brief** to a file in your scratchpad (or a temp dir), following
   [references/brief-template.md](references/brief-template.md): goal, context the worker cannot
   discover cheaply, an explicit edit fence, requirements, and a "done when" with the exact
   verification command. The worker does not see this conversation — the brief is all it knows.

3. **Pick model and access** — see [references/models-and-access.md](references/models-and-access.md).
   Prefer omp role names (`smol`, `task`, `default`, `slow`, `plan`, `designer`) over hard-coded
   ids so the skill works on any machine. Default access is `edit` (files yes, shell no). Use
   `full` only in a git worktree, a throwaway tree, or when the user agreed. Use `read` for
   research and review. If the user named a model, use it.

4. **Run.**
   - Short task (well under 10 minutes):
     `${CLAUDE_SKILL_DIR}/scripts/omp-task run --brief <file> --model <m> --access <a> --cwd <repo>`
   - Long or parallel tasks: add `--detach` to each `run` (it prints a job id at once), then
     `${CLAUDE_SKILL_DIR}/scripts/omp-task wait <id> [<id>...] --max-wait 540`; repeat `wait` while it
     exits 3 (still running). Use `status <id>` for a progress peek, `cancel <id>` to stop.
   - Set `--timeout` (omp's own limit, default 30m) to match the task.

5. **Review — never skip.** The run prints status, model, cost, tools used, the files that changed
   and the worker's report. Then:
   - read the actual diff of the changed files (`git diff -- <files>`; new files: read them);
   - check nothing outside the fence changed;
   - run the "done when" verification yourself;
   - treat the worker's claims ("tests pass") as unverified until you have seen them.

6. **Iterate in the same session** when something is off — the worker keeps its context:
   `${CLAUDE_SKILL_DIR}/scripts/omp-task continue <id> "<specific feedback>"` (accepts the same
   `--model/--access/--brief` flags). After two failed rounds, fix it yourself or re-scope.

7. **Report to the user**: what was delegated, to which model, what changed, what you verified,
   cost, and anything left open. Do not commit the worker's changes unless the user asked you to.

## Status meanings

`completed` — worker finished (still review it). `failed` — omp errored; read `errors` and
`omp-task result <id> --full`. `timeout` — hit `--timeout`; continue with a narrower ask or a
longer timeout. `cancelled` — stopped by `cancel`.

## Housekeeping

`omp-task list [--cwd <dir>]` shows recent jobs. Each job keeps `prompt.md`, `events.jsonl`
(omp's raw stream), `result.md` and `meta.json` under `~/.local/state/claude-omp/jobs/<id>/` —
point the user there when they want the full transcript. Add `--json` to any command for
structured output.
