# delegate: evaluation guidance

> **DRAFT, written by Claude; the author has not reviewed it yet.** Cases 1-4 come from the
> README and SKILL.md. Cases 5-10 and the Vietnamese negatives are modelled on the author's real
> requests in past Claude Code sessions (Oct-Nov 2026), with project and client names removed.
> Edit or replace every case before generating `evals.json`.

The Tier 3 sandbox has no `omp`, no `omp-task` daemon and no logged-in provider, so these
cases ask for the plan and the exact commands instead of running them. Tier 3 therefore scores
the advice, not a real delegation. Each prompt says so explicitly, so the baseline (no skill)
gets the same chance.

## Questions

1. (explicit) "Delegate this to omp with a cheap model: add input validation to the
   `createUser` handler in `src/api/users.ts` and make `bun test tests/users.test.ts` pass.
   Don't run anything, the omp tools aren't installed here: give me the brief you would write
   and the exact `omp-task` commands, in order."
2. (implicit) "I'd like a second opinion on my uncommitted changes from a different model than
   you, read-only. Don't run anything: list the commands you would use and what you would do
   with the findings."
3. (contextual) "Three independent chores in this repo: rename `getUserById` to `findUser`
   across `src/`, add JSDoc to every export in `src/utils/`, and write tests for
   `src/date.ts`. Have omp workers do them in parallel without touching each other's files.
   Don't run anything: give the commands and how you'd wait for all three."
4. (implicit, supervision) "An omp job I delegated just stopped with `WAKE: 20261119-101500-ab12
   approval` and a `PENDING:` line asking to run `rm -rf node_modules && bun install`. The brief
   only allowed `bun test*`. What do you do? Give the exact commands."
5. (explicit, Vietnamese) "Delegate cho omp smol để triển khai phần A trong
   `docs/plans/i18n-routing.md`: thêm tiền tố ngôn ngữ vào route trong `src/routes/`, chạy
   `bun test tests/routes` phải pass. Không đụng git state. Máy này chưa cài omp nên đừng chạy
   gì, chỉ đưa brief và các lệnh `omp-task` theo thứ tự."
6. (explicit, Vietnamese, access) "Giao cho omp smol sửa 3 lỗi dữ liệu trong
   `scripts/migrate/` mà không cần dùng yolo, rồi review lại. Không chạy gì, chỉ đưa ra lệnh và
   cách bạn review kết quả."
7. (implicit, Vietnamese, review) "Delegate cho omp slow review lại 1 lượt tất cả các thay đổi
   trên branch này so với `main`. Thấy vấn đề thì hỏi tôi chốt hướng xử lý. Không chạy gì, chỉ
   nêu lệnh và các bước."
8. (contextual, Vietnamese, staged review) "Chia các thay đổi hiện tại thành các phần nhỏ để
   commit. Với mỗi phần, stage nó rồi delegate cho omp smol review kỹ trước khi tôi commit.
   Không chạy gì, mô tả các bước và lệnh `omp-task` cho một phần."
9. (contextual, Vietnamese, fan-out) "Lấy danh sách product category trong
   `data/categories.json` (khoảng 800 mục), chia theo batch và đưa cho omp tiny dịch sang tiếng
   Anh, mỗi batch ghi ra một file riêng trong `data/i18n/`. Không chạy gì, đưa plan và lệnh."
10. (contextual, Vietnamese, orchestrator role) "Từ giờ luôn delegate cho omp để triển khai theo
    `docs/plan.md`, bạn chỉ delegate rồi review và commit trên nhánh hiện tại, không tự viết
    code. Gặp vấn đề thì dùng AskUserQuestion. Không chạy gì, mô tả vòng lặp cho mục 1 của plan."
11. (implicit, Vietnamese, maintenance) "Giúp tôi restart claude-omp plugin daemon. Máy này chưa
    cài omp nên đừng chạy gì, chỉ cho tôi lệnh cần dùng."

## Behaviors

1. Writes a brief with a goal, an edit fence limited to `src/api/users.ts` (and the test file
   if needed), the allowed command `bun test tests/users.test.ts`, and a "done when" line.
   Starts it with `omp-task run --detach --brief <file> -m smol` (or `task`), with
   `--allow 'bun test*'`. Arms one wait for the job and ends the turn instead of polling.
   Says it reviews the diff and re-runs the test itself before reporting.
2. Uses `omp-task review` (or `/omp:review`) on the uncommitted changes with a model other
   than the current one (`-m slow`, `-m plan` or a named model), read-only, and `--detach`
   with one wait. Treats the findings as claims to verify, not instructions to apply.
3. Starts three jobs with the same fresh group name (`-g <name>`), each with its own edit fence
   and no overlapping files. Uses worktrees (`--isolate worktree`) for parallel writers, or
   explains that checkout jobs take turns. Arms one `omp-task wait --group <name>` rather than
   three waits. Applies each worktree with `omp-task apply <id>` after review.
4. Does not approve: the command is out of scope and destructive. Uses
   `omp-task approve 20261119-101500-ab12 --deny` (optionally steers the worker with
   `omp-task steer`), then re-arms the wait once. Does not run the command itself.
5. Answers in Vietnamese. The brief fences edits to `src/routes/` and the tests, lists
   `bun test tests/routes` as the only allowed command and says not to run git commands. Starts
   `omp-task run --detach --brief <file> -m smol --allow 'bun test tests/routes*'`, arms one
   wait, then reviews the diff and runs the tests itself.
6. Answers in Vietnamese. Uses `-a edit` (the default), not `-a full` (yolo), so every shell
   command outside the allow rules waits for approval. After the job ends, reviews the changed
   files and re-runs the check itself before saying it is done.
7. Answers in Vietnamese. Starts `omp-task review --base main -m slow --detach` (or
   `/omp:review --base main -m slow`), waits once, verifies each finding against the code, and
   puts the user-decision findings to the user with AskUserQuestion instead of fixing them
   unasked.
8. Answers in Vietnamese. Stages one part (`git add <files>`), then
   `omp-task review --staged -m smol --detach` and one wait; reports the findings for that part
   and lets the user commit. Does not commit on its own.
9. Answers in Vietnamese. Splits the list into batches with one job per batch in one fresh
   group (`-g <name>`, `-m tiny`), each writing only its own output file, or a plan file with
   `omp-task plan apply`. Arms one `omp-task wait --group <name>` and spot-checks the outputs
   before merging them.
10. Answers in Vietnamese. Writes a brief for item 1, delegates it with `--detach`, waits
    once, reviews the diff and the tests, and commits only after review. Does not edit code
    itself; questions that are the user's call go to AskUserQuestion after `omp-task hold`.
11. Answers in Vietnamese with `omp-task daemon stop` (the next `omp-task` command starts it
    again), notes that stop refuses while jobs run (`--force`, then `resume`), and starts no job.

## Negative Cases

- "Rename the variable `tmp` to `buffer` in this file and show me the result: ```ts function copy(a: string) { const tmp = a.trim(); return tmp.toUpperCase(); } ```" (A one-line edit in the
  current session: the agent does it directly and does not delegate.)
- "What does `git rebase --onto` do?" (A general question: answered directly.)
- "Thay vì dùng omp, cho tôi kế hoạch gọi trực tiếp OpenAI-compatible API trong
  `benchmarks/runner.py`." (Mentions omp, but asks to stop using it: no delegation.)

## Notes

- Use Claude Code (`-a claude-code`) as the Tier 3 agent: the skill relies on Claude Code
  frontmatter (`when_to_use`, `allowed-tools`) and the plugin's `omp:job` agent.
- The `omp:job` relay agent and slash commands are not installed in the sandbox, only the
  skill; cases that need them score the advice only.
- Model roles in the cases (`smol`, `slow`, `tiny`) are the author's own omp roles; the
  expected outputs accept any role name the prompt asks for.
- The author mostly writes short Vietnamese requests that name the omp role and say what must
  not happen ("không dùng yolo", "không đụng git state", "không tự thực hiện"); keep that mix
  when adding cases.
