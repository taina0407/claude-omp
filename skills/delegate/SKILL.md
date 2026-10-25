---
name: delegate
description: Delegate a coding, research or review task to the omp (oh-my-pi) agent running a model of your choice, supervise it live (answer its questions, approve shell commands, steer or abort it), then review and iterate while you stay the orchestrator. Use when the user asks to hand work to omp, another model, a cheaper/faster model, GPT, Gemini, DeepSeek, or "a worker"; to get a second opinion from a different model; or to run several well-scoped tasks in parallel.
when_to_use: Triggers include "delegate this to omp", "let omp do it", "use deepseek/gpt/gemini for this", "get a second opinion from another model", "run these in parallel with omp", "/delegate".
argument-hint: "[task description]"
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/omp-task *)
license: MIT
compatibility: Requires the omp CLI (oh-my-pi) on PATH and Python 3.9+.
---

# Delegate to omp

You are the orchestrator. omp is a worker: it runs one model on one well-scoped task under a
supervisor process that pushes events to you. You own the plan, the brief, the answers to the
worker's questions, the review and what you tell the user.

The tool is `${CLAUDE_SKILL_DIR}/scripts/omp-task` (below: `omp-task`). `omp-task --help` and
`omp-task <command> --help` list every flag. First use on a machine: `omp-task doctor`.

## When delegating pays off

Delegate when the task is self-contained, the spec fits in a page, and checking the result is
cheaper than doing it: boilerplate, mechanical refactors, test scaffolding, a bounded feature with
a clear "done", a read-only investigation, or a review by a different model. Keep it yourself when
it needs this conversation's nuance, touches many files you are also editing, or is a one-liner.

## Workflow

1. **Scope.** Decide the exact files the worker may edit. Two writers must never touch the same
   files: do not edit them yourself while a job runs, and give parallel jobs disjoint scopes. If
   the user has uncommitted work in those files, say so before delegating.

2. **Write the brief** to a file in your scratchpad, following
   [references/brief-template.md](references/brief-template.md): goal, context the worker cannot
   discover cheaply, an explicit edit fence, requirements, and a "done when" with the exact
   verification command. The worker does not see this conversation; it can ask you questions,
   but a good brief means it rarely needs to.

3. **Pick model and access**: see [references/models-and-access.md](references/models-and-access.md).
   Prefer omp role names (`smol`, `task`, `default`, `slow`, `plan`, `designer`) over hard-coded
   ids. Default access `edit` lets the worker edit files and asks _you_ before any shell command;
   `full` runs shell freely (worktree, throwaway tree, or user agreed); `read` is for research and
   review. If the user named a model, use it.

4. **Start, then let it wake you. Never poll or sleep-loop.**
   - Start: `omp-task run --detach --brief <file> --model <m> --access <a> --cwd <repo>`.
     It prints the job id at once.
   - Arm the wake-up: run `omp-task wait <id> [<id>...]` **as a background command**
     (Bash `run_in_background`). It returns, and you are notified, when every job has finished
     or as soon as one needs you: a question or an approval (exit 4). One command, no timeouts
     to tune. Meanwhile keep working or end your turn.
   - Optional live view: for long jobs where you want to course-correct early, also start the
     Monitor tool on `omp-task watch <id> --quiet` (questions, approvals, errors, end) or without
     `--quiet` (plus each edit/shell command and the worker's progress notes). Monitor watches
     expire after 30 minutes at most; re-arm if the job is still running.

5. **When woken with exit 4**, the output shows the question or command and the exact reply
   syntax:
   - Question → answer from the brief, the code and this conversation:
     `omp-task reply <id> "<answer>"`. If only the user can decide, ask them first.
   - Approval → read the command. Approve what the brief needs (tests, linters, builds):
     `omp-task approve <id>`; use `--session` to approve that tool for the rest of the job;
     `--deny` for anything destructive, out of scope or touching the network/global state.
   - Then re-arm `omp-task wait <id>` in the background.
   - Unanswered questions and approvals expire (default 20m): the worker then proceeds on its
     own assumption, or the command is denied.

6. **Course-correct while it runs** if the feed shows it drifting:
   `omp-task steer <id> "<new direction>"` (delivered mid-run, no restart);
   `omp-task cancel <id>` to stop it.

7. **Review. Never skip this.** The final output lists status, model, cost, tools, changed files,
   denied tools and the worker's report. Then read the real diff (`git diff -- <files>`; new
   files: read them), check nothing outside the fence changed, and run the "done when"
   verification yourself. A worker saying "tests pass" is a claim, not evidence.

8. **Iterate in the same omp session** when something is off:
   `omp-task continue <id> --detach "<specific feedback>"`, then `wait` again. After two failed
   rounds, fix it yourself or re-scope.

9. **Report to the user**: what was delegated, to which model, the questions you answered, what
   changed, what you verified, cost, and anything left open. Do not commit the worker's changes
   unless the user asked you to.

## Status and exit codes

`starting`/`running` = working. `waiting` = it needs a reply or an approval. `completed` = done
(still review it). `failed` = omp errored; read `errors` and `omp-task result <id> --full`.
`timeout` = hit `--timeout` (default 30m). `cancelled` = stopped by `cancel`.
`wait`/`run` exit with 0 when all jobs completed, 1 when any failed, was cancelled or timed out,
3 when `--max-wait` expired, and 4 when a job needs you.

## Housekeeping

`omp-task status <id>` shows one job, and `omp-task list [--cwd <dir>]` shows recent jobs.
Each job keeps `prompt.md`, `events.jsonl` (raw omp RPC frames), `feed.jsonl`, `result.md` and
`meta.json` under `~/.local/state/claude-omp/jobs/<id>/`. Point the user there for the full
transcript. Add `--json` to any reporting command for structured output.
