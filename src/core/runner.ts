/**
 * Runs one job to completion inside the daemon: starts the backend session, turns its events
 * into job state, feed lines and pending questions/approvals, applies the orchestrator's control
 * requests, and enforces timeouts. A job can be run again with `resume` after the daemon stopped
 * under it; its counters carry over.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_PROMPT_BYTES } from "../backends/omp-rpc/protocol";
import { ompRpcBackend } from "../backends/omp-rpc/session";
import type { Backend, BackendEvent, BackendSession } from "../backends/types";
import { createWorktree, worktreeCwd } from "../isolation/worktree";
import { renderReview } from "../review/render";
import {
	MAX_REVIEW_RETRIES,
	type Review,
	reviewIssues,
	reviewSchema,
	SUBMIT_REVIEW,
	SUBMIT_REVIEW_TOOL,
} from "../review/schema";
import { changedFiles, type Snapshot, snapshot, withoutDir } from "./git";
import { jobDir, preambleFile, stateDir } from "./paths";
import { decideApproval } from "./policy";
import type { Store } from "./store";
import type {
	ApprovalDecision,
	CommandResult,
	ControlRequest,
	Job,
	JobStatus,
	NoticeKind,
	PendingKind,
	TerminalStatus,
} from "./types";
import { errorText, nowIso } from "./util";

/** Tools whose calls are worth a feed line: they change things or start sub-work. */
const FEED_TOOLS = new Set(["write", "edit", "bash", "eval", "task"]);
const TICK_MS = 100;
/** After an abort, how long omp gets to wind down before the job is closed anyway. */
const ABORT_GRACE_MS = 15_000;
/** Sent when a job is resumed after an interruption (omp does not persist an aborted turn). */
export const RESUME_PROMPT =
	"Your previous turn was interrupted before it finished (the supervising process restarted). " +
	"Check what you already did, then continue the task from where you stopped and end with the " +
	"report the task asks for.";
/** A streak of failing tool calls this long, or one call failing this often, is "stalled". */
const STALL_ERROR_STREAK = 5;
const STALL_SAME_FAILURES = 3;
/** Longest dependency result pasted into a prompt by `{{result:<job>}}`. */
const RESULT_INJECT_CHARS = 12_000;
const QUESTION_EXPIRED_ANSWER =
	"No answer from the orchestrator in time. Make the most reasonable assumption, continue, " +
	"and list the assumption under Open issues.";

interface LivePending {
	kind: PendingKind;
	tool: string | null;
	text: string;
	since: number;
}

/** Replaces `{{result:<job>}}` with that job's final report (for jobs run `--after` it). */
export function expandResults(text: string, store: Store): string {
	return text.replace(/\{\{result:([\w.-]+)\}\}/g, (whole, ref: string) => {
		const ids = store.findJobIds(ref);
		const file = ids.length === 1 ? join(jobDir(ids[0] as string), "result.md") : null;
		if (!file || !existsSync(file)) return whole;
		const result = readFileSync(file, "utf8");
		return result.length > RESULT_INJECT_CHARS
			? `${result.slice(0, RESULT_INJECT_CHARS)}\n[truncated; full report: ${file}]`
			: result;
	});
}

export function promptText(job: Job, store?: Store): string {
	const raw = readFileSync(join(jobDir(job.id), "prompt.md"), "utf8");
	let text = store ? expandResults(raw, store) : raw;
	if (text !== raw) writeFileSync(join(jobDir(job.id), "prompt-sent.md"), text);
	if (job.files.length) {
		text += `\n\nAttached files (read them first):\n${job.files.map((f) => `- ${f}`).join("\n")}`;
	}
	if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
		// omp rejects input lines over 1 MB; hand the brief over as a file instead.
		const file = join(jobDir(job.id), "prompt-full.md");
		writeFileSync(file, text);
		text = `Your task is too long to send inline. Read it in full from ${file} before doing anything else.`;
	}
	return text;
}

export class JobRunner {
	readonly #store: Store;
	readonly #backend: Backend;
	readonly #jobId: string;
	#job: Job;
	#session: BackendSession | null = null;
	#pending = new Map<string, LivePending>();
	#abortReason: "cancelled" | "timeout" | "over_budget" | null = null;
	#abortDeadline: number | null = null;
	#finished = false;
	#started = performance.now();
	/** Duration of earlier runs of this job (before an interruption). */
	readonly #baseDurationS: number;
	/** Where the worker and the git snapshots run: the worktree, or the user's cwd. */
	#workCwd: string;
	#gitBefore: Snapshot | null = null;
	/** The omp session this run resumed after an interruption, if any. */
	#resumedSession: string | null = null;
	/** Whether omp got as far as reporting its session (it never does when --resume fails). */
	#sawStart = false;
	#tick: ReturnType<typeof setInterval> | null = null;
	/** Group and daily limits, checked by the daemon; returns why the job must stop, or null. */
	readonly #overLimit: (job: Job) => string | null;
	#lastActivity = performance.now();
	#idleNoticed = false;
	#errorStreak = 0;
	#failures = new Map<string, number>();
	#toolDetail = new Map<string, string>();
	/** Review jobs: the accepted review, and how many submissions were rejected. */
	#review: Review | null = null;
	#rejectedReviews = 0;
	#done: Promise<Job>;
	#resolveDone!: (job: Job) => void;

	// Accumulated from backend events.
	#tools: Record<string, number> = {};
	#toolErrors: Record<string, number> = {};
	#denied = new Set<string>();
	#errors: string[] = [];
	/** Cost recorded by earlier runs of this job; this run's cost is added on top. */
	readonly #baseCostUsd: number;
	#costUsd = 0;
	#subagentCost = new Map<string, number>();
	#subagentStatus = new Map<string, string>();
	#tokens = 0;
	#modelUsed: string | null = null;
	#stopReason: string | null = null;
	#finalText = "";

	constructor(
		store: Store,
		jobId: string,
		opts: { backend?: Backend; overLimit?: (job: Job) => string | null } = {},
	) {
		this.#store = store;
		this.#backend = opts.backend ?? ompRpcBackend;
		this.#overLimit = opts.overLimit ?? (() => null);
		this.#jobId = jobId;
		const job = store.getJob(jobId);
		if (!job) throw new Error(`no job ${jobId}`);
		this.#job = job;
		this.#tools = { ...job.tools };
		this.#toolErrors = { ...job.toolErrors };
		this.#denied = new Set(job.deniedTools);
		this.#errors = [...job.errors];
		this.#tokens = job.tokens;
		this.#baseCostUsd = job.costUsd;
		this.#baseDurationS = job.durationS ?? 0;
		this.#workCwd = worktreeCwd(job);
		this.#modelUsed = job.modelUsed;
		const reviewFile = join(jobDir(job.id), "result.json");
		if (job.review && existsSync(reviewFile)) {
			// Accepted before an interruption: a resumed review job keeps it.
			this.#review = JSON.parse(readFileSync(reviewFile, "utf8")) as Review;
		}
		this.#done = new Promise((resolve) => {
			this.#resolveDone = resolve;
		});
	}

	/**
	 * Starts the job; resolves with the final record once it has ended. With `resume`, an
	 * interrupted job goes on in its omp session (or starts over if it never got one).
	 */
	run(opts: { resume?: boolean } = {}): Promise<Job> {
		if (this.#job.isolate === "worktree" && !this.#job.worktreePath) {
			try {
				const wt = createWorktree(this.#job);
				this.#store.updateJob(this.#job.id, {
					worktreePath: wt.path,
					baseRef: wt.baseRef,
					branch: wt.branch,
					repoRoot: wt.repoRoot,
				});
				this.#job = this.#store.getJob(this.#job.id) as Job;
				this.#workCwd = wt.cwd;
				this.#feed("info", `working in worktree ${wt.path} (branch ${wt.branch})`);
			} catch (e) {
				void this.#finish("failed", [errorText(e)], null);
				return this.#done;
			}
		}
		const job = this.#job;
		this.#gitBefore = this.#loadGitBefore();
		this.#store.updateJob(job.id, {
			status: "starting",
			startedAt: job.startedAt ?? nowIso(),
			finishedAt: null,
			runnerPid: process.pid,
		});
		if (opts.resume && job.sessionId) {
			this.#resumedSession = job.sessionId;
			this.#startSession(job.sessionId, RESUME_PROMPT);
		} else {
			this.#startSession(job.resumeSession, promptText(job, this.#store));
		}
		this.#tick = setInterval(() => this.#onTick(), TICK_MS);
		return this.#done;
	}

	#startSession(resumeSession: string | null, prompt: string): void {
		const job = this.#job;
		const dir = jobDir(job.id);
		this.#session = this.#backend.start(
			{
				cwd: this.#workCwd,
				access: job.access,
				model: job.model,
				thinking: job.thinking,
				resumeSession,
				systemPromptFile: job.noPreamble ? null : preambleFile(),
				addDirs: job.addDirs,
				extraArgs: job.extraArgs,
				prompt,
				rawLogPath: join(dir, "events.jsonl"),
				stderrPath: join(dir, "stderr.log"),
				hostTools: job.review ? [SUBMIT_REVIEW_TOOL] : [],
			},
			(e) => this.#onEvent(e),
		);
	}

	/** The dirty-file snapshot from the job's first run, so a resumed job reports all its changes. */
	#loadGitBefore(): Snapshot | null {
		const file = join(jobDir(this.#job.id), "git-before.json");
		if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Snapshot | null;
		const snap = snapshot(this.#workCwd);
		writeFileSync(file, JSON.stringify(snap));
		return snap;
	}

	get finished(): boolean {
		return this.#finished;
	}

	/** Asks the job to stop, as `omp-task cancel` does. */
	cancel(): void {
		if (!this.#finished && !this.#abortReason) {
			this.#feed("abort", "cancel requested");
			this.#abort("cancelled");
		}
	}

	/** Ends the job as interrupted (the daemon is shutting down); `resume` can continue it. */
	async interrupt(reason: string): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		if (this.#tick) clearInterval(this.#tick);
		await this.#session?.close();
		this.#store.clearPending(this.#jobId);
		this.#store.updateJob(this.#jobId, {
			...this.#progress(),
			status: "interrupted",
			runnerPid: null,
			ompPid: null,
		});
		this.#feed("interrupted", reason);
		this.#resolveDone(this.#store.getJob(this.#jobId) as Job);
	}

	/** Counters that are saved as they change, so an interruption loses nothing. */
	#progress() {
		const subagentCost = [...this.#subagentCost.values()].reduce((a, b) => a + b, 0);
		return {
			costUsd: Math.round((this.#baseCostUsd + this.#costUsd + subagentCost) * 1e6) / 1e6,
			tokens: this.#tokens,
			tools: this.#tools,
			toolErrors: this.#toolErrors,
			deniedTools: [...this.#denied].sort(),
			errors: this.#errors.slice(-5),
			modelUsed: this.#modelUsed,
			durationS:
				Math.round(this.#baseDurationS * 10 + (performance.now() - this.#started) / 100) / 10,
		};
	}

	#feed(kind: string, text = "", data: Record<string, unknown> = {}): void {
		this.#store.appendFeed(this.#jobId, kind, text, data);
	}

	#setStatus(status: JobStatus): void {
		if (this.#finished) return;
		this.#store.updateJob(this.#jobId, { status });
	}

	#syncWaiting(): void {
		if (this.#finished) return;
		const current = this.#store.getJob(this.#jobId)?.status;
		if (current === "starting" && this.#pending.size === 0) return;
		this.#setStatus(this.#pending.size ? "waiting" : "running");
	}

	// ---------------------------------------------------------------- backend → job

	/** Records something the orchestrator should look at; `wait` returns for it. */
	#notice(kind: NoticeKind, text: string): void {
		this.#feed(kind, text);
		this.#store.addNotice(this.#jobId, { kind, text, at: nowIso() });
	}

	#onEvent(e: BackendEvent): void {
		if (this.#finished) return;
		this.#lastActivity = performance.now();
		this.#idleNoticed = false;
		switch (e.kind) {
			case "spawned":
				this.#store.updateJob(this.#jobId, { ompPid: e.pid });
				break;
			case "started":
				this.#sawStart = true;
				this.#store.updateJob(this.#jobId, { sessionId: e.sessionId, modelResolved: e.model });
				this.#setStatus(this.#pending.size ? "waiting" : "running");
				this.#feed("started", this.#job.title, {
					model: this.#job.model,
					access: this.#job.access,
				});
				break;
			case "progress":
				if (e.checkpoint) this.#notice("checkpoint", e.text.slice(0, 300));
				else this.#feed("progress", e.text.slice(0, 300));
				break;
			case "tool_start":
				this.#toolDetail.set(e.id, `${e.name}: ${e.detail.slice(0, 160)}`);
				this.#tools[e.name] = (this.#tools[e.name] ?? 0) + 1;
				this.#store.updateJob(this.#jobId, { tools: this.#tools }); // for `status` while running
				if (FEED_TOOLS.has(e.name)) this.#feed("tool", `${e.name}: ${e.detail.slice(0, 160)}`);
				break;
			case "tool_end": {
				const call = this.#toolDetail.get(e.id) ?? e.name;
				this.#toolDetail.delete(e.id);
				if (!e.isError) {
					this.#errorStreak = 0;
				} else if (/requires approval|denied/i.test(e.text)) {
					this.#denied.add(e.name);
				} else {
					// Usually a non-zero exit, e.g. a failing test run: normal work, not a job error.
					this.#toolErrors[e.name] = (this.#toolErrors[e.name] ?? 0) + 1;
					this.#onToolFailure(call);
				}
				break;
			}
			case "assistant":
				this.#costUsd += e.costUsd;
				this.#tokens += e.tokens;
				if (e.model) this.#modelUsed = e.model;
				this.#stopReason = e.stopReason;
				if (e.text) this.#finalText = e.text;
				if (e.error && e.stopReason !== "aborted") {
					this.#errors.push(e.error);
					this.#feed("error", e.error.slice(0, 300));
				}
				this.#store.updateJob(this.#jobId, this.#progress());
				this.#checkBudget();
				break;
			case "subagent": {
				if (e.costUsd !== null && e.costUsd !== this.#subagentCost.get(e.id)) {
					this.#subagentCost.set(e.id, e.costUsd);
					this.#store.updateJob(this.#jobId, this.#progress());
					this.#checkBudget();
				}
				const before = this.#subagentStatus.get(e.id);
				if (e.status && e.status !== before) {
					this.#subagentStatus.set(e.id, e.status);
					this.#feed("subagent", `${e.id} ${e.status}${e.description ? `: ${e.description}` : ""}`);
				}
				break;
			}
			case "question":
				this.#addPending(e.ref, "question", e.question, null, e.options, e.context);
				this.#feed("question", e.question, { ref: e.ref, options: e.options, context: e.context });
				break;
			case "question_withdrawn":
				if (this.#pending.delete(e.ref)) {
					this.#store.removePending(this.#jobId, e.ref);
					this.#feed("info", "worker withdrew its question");
					this.#syncWaiting();
				}
				break;
			case "approval": {
				const rule = decideApproval(e.tool, e.detail, this.#job);
				if (rule) {
					if (rule.decision === "deny") this.#denied.add(e.tool);
					this.#session?.decide(e.ref, rule.decision);
					this.#feed(`auto-${rule.decision}`, `${e.tool}: ${e.detail}`.slice(0, 200), {
						rule: rule.rule,
					});
					break;
				}
				this.#addPending(e.ref, "approval", e.detail, e.tool, e.options, null);
				this.#feed("approval", `${e.tool}: ${e.detail}`.slice(0, 300), {
					ref: e.ref,
					tool: e.tool,
				});
				break;
			}
			case "tool_call":
				if (e.name === SUBMIT_REVIEW && this.#job.review) this.#onReview(e.ref, e.args);
				else this.#session?.answer(e.ref, `unknown host tool ${e.name}`, true);
				break;
			case "warning":
				this.#feed("info", e.text.slice(0, 300));
				break;
			case "end":
				void this.#finishFromEnd(e);
				break;
		}
	}

	/** Validates a submitted review; a bad one goes back to the worker with what to fix. */
	#onReview(ref: string, args: Record<string, unknown>): void {
		const parsed = reviewSchema.safeParse(args);
		if (parsed.success) {
			this.#review = parsed.data;
			writeFileSync(join(jobDir(this.#jobId), "result.json"), JSON.stringify(parsed.data, null, 2));
			const n = parsed.data.findings.length;
			this.#feed("review", `${parsed.data.verdict}, ${n} finding(s)`);
			this.#session?.answer(ref, "Review recorded. End your turn now with one short line.");
			return;
		}
		this.#rejectedReviews++;
		const issues = reviewIssues(parsed.error);
		if (this.#rejectedReviews > MAX_REVIEW_RETRIES) {
			this.#errors.push(`review rejected ${this.#rejectedReviews} times:\n${issues}`);
			this.#feed("error", "the worker kept submitting invalid reviews");
			this.#session?.answer(ref, "Rejected again. Stop now and end your turn.", true);
			return;
		}
		this.#feed("info", `invalid review submission ${this.#rejectedReviews}; sent back`);
		this.#session?.answer(
			ref,
			`submit_review rejected; nothing was recorded. Fix these fields and call submit_review again:\n${issues}`,
			true,
		);
	}

	/** A run of failures, or the same call failing again and again, means the worker is stuck. */
	#onToolFailure(call: string): void {
		this.#errorStreak++;
		const times = (this.#failures.get(call) ?? 0) + 1;
		this.#failures.set(call, times);
		if (this.#errorStreak === STALL_ERROR_STREAK) {
			this.#notice("stalled", `${STALL_ERROR_STREAK} tool calls in a row failed (last: ${call})`);
		} else if (times === STALL_SAME_FAILURES) {
			this.#notice("stalled", `the same call failed ${times} times: ${call}`);
		}
	}

	#checkBudget(): void {
		if (this.#abortReason || this.#finished) return;
		const job = this.#store.getJob(this.#jobId) as Job;
		const reason =
			job.budgetUsd !== null && job.costUsd > job.budgetUsd
				? `spent $${job.costUsd.toFixed(4)} of its $${job.budgetUsd} budget`
				: this.#overLimit(job);
		if (!reason) return;
		this.#errors.push(`over budget: ${reason}`);
		this.#feed("over_budget", reason);
		this.#abort("over_budget");
	}

	#addPending(
		ref: string,
		kind: PendingKind,
		text: string,
		tool: string | null,
		options: string[],
		context: string | null,
	): void {
		this.#pending.set(ref, { kind, tool, text, since: performance.now() });
		this.#store.addPending({
			jobId: this.#jobId,
			ref,
			kind,
			text,
			tool,
			options,
			context,
			askedAt: nowIso(),
		});
		this.#syncWaiting();
	}

	#finishFromEnd(e: Extract<BackendEvent, { kind: "end" }>): Promise<void> {
		if (
			this.#resumedSession &&
			!this.#sawStart &&
			!this.#abortReason &&
			e.outcome === "failed" &&
			/session .* not found/i.test(e.error ?? "")
		) {
			// Interrupted before omp saved anything: there is no session to go back to.
			this.#resumedSession = null;
			this.#feed("info", "omp had not saved the session before the interruption; starting over");
			this.#startSession(this.#job.resumeSession, promptText(this.#job, this.#store));
			return Promise.resolve();
		}
		if (this.#abortReason) return this.#finish(this.#abortReason, [], e.exitCode);
		if (e.outcome === "completed") {
			return this.#finish(this.#stopReason === "error" ? "failed" : "completed", [], e.exitCode);
		}
		if (e.outcome === "aborted") return this.#finish("failed", ["omp aborted the run"], e.exitCode);
		return this.#finish("failed", e.error ? [e.error] : [], e.exitCode);
	}

	// ---------------------------------------------------------------- orchestrator → job

	#onTick(): void {
		if (this.#finished) return;
		const now = performance.now();
		const timeout = this.#job.timeoutS;
		if (timeout && !this.#abortReason && now - this.#started > timeout * 1000) {
			this.#feed("timeout", `hit --timeout ${timeout}s; aborting`);
			this.#abort("timeout");
		}
		const stallS = this.#job.stallTimeoutS;
		if (
			stallS &&
			!this.#abortReason &&
			!this.#idleNoticed &&
			this.#pending.size === 0 &&
			now - this.#lastActivity > stallS * 1000
		) {
			this.#idleNoticed = true;
			this.#notice("stalled", `no worker activity for ${Math.round(stallS)}s`);
		}
		if (this.#abortDeadline && now > this.#abortDeadline) {
			void this.#finish(this.#abortReason ?? "cancelled", [], null);
			return;
		}
		this.#expirePending(now);
	}

	/** Applies a control request from the orchestrator (steer, abort, reply, approve). */
	control(cmd: ControlRequest): CommandResult {
		if (this.#finished) return { ok: false, error: "job already ended" };
		const session = this.#session;
		if (!session) return { ok: false, error: "job has not started" };
		this.#lastActivity = performance.now();
		this.#idleNoticed = false;
		switch (cmd.kind) {
			case "steer": {
				const message = cmd.message ?? "";
				session.steer(message);
				this.#feed("steer", message.slice(0, 300));
				return { ok: true };
			}
			case "abort":
				this.cancel();
				return { ok: true };
			case "reply":
			case "approve": {
				const kind: PendingKind = cmd.kind === "reply" ? "question" : "approval";
				const ref = cmd.ref ?? null;
				const match = [...this.#pending.entries()].find(
					([r, p]) => p.kind === kind && (!ref || r === ref),
				);
				if (!match) {
					return { ok: false, error: `no pending ${kind}${ref ? ` with ref ${ref}` : ""}` };
				}
				const [r, item] = match;
				if (cmd.kind === "reply") {
					const message = cmd.message ?? "";
					this.#resolvePending(r, message);
					this.#feed("answered", message.slice(0, 300), { ref: r });
				} else {
					const decision: ApprovalDecision = cmd.decision ?? "approve";
					this.#resolvePending(r, null, decision);
					this.#feed(`approval-${decision}`, item.text.slice(0, 200), { ref: r });
				}
				return { ok: true, ref: r };
			}
		}
		return { ok: false, error: `unknown command ${String(cmd.kind)}` };
	}

	#resolvePending(
		ref: string,
		answer: string | null,
		decision?: "approve" | "session" | "deny",
	): void {
		const item = this.#pending.get(ref);
		if (!item) return;
		this.#pending.delete(ref);
		this.#store.removePending(this.#jobId, ref);
		if (item.kind === "question") this.#session?.answer(ref, answer ?? "");
		else {
			const d = decision ?? "deny";
			if (d === "deny" && item.tool) this.#denied.add(item.tool);
			this.#session?.decide(ref, d);
		}
		this.#syncWaiting();
	}

	#expirePending(now: number): void {
		const limits: Record<PendingKind, number | null> = {
			question: this.#job.answerTimeoutS,
			approval: this.#job.approvalTimeoutS,
		};
		for (const [ref, item] of this.#pending) {
			const limit = limits[item.kind];
			if (!limit || now - item.since <= limit * 1000) continue;
			if (item.kind === "question") this.#resolvePending(ref, QUESTION_EXPIRED_ANSWER);
			else this.#resolvePending(ref, null, "deny");
			this.#feed("info", `${item.kind} ${ref} expired without a reply`);
		}
	}

	#abort(reason: "cancelled" | "timeout" | "over_budget"): void {
		this.#abortReason = reason;
		this.#abortDeadline = performance.now() + ABORT_GRACE_MS;
		this.#session?.abort();
		for (const [ref, item] of [...this.#pending]) {
			if (item.kind === "question") this.#resolvePending(ref, "Task aborted by orchestrator.");
			else this.#resolvePending(ref, null, "deny");
		}
	}

	// ---------------------------------------------------------------- end

	async #finish(status: TerminalStatus, errors: string[], exitCode: number | null): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		if (this.#tick) clearInterval(this.#tick);
		await this.#session?.close();
		const job = this.#job;
		const after = this.#gitBefore ? snapshot(this.#workCwd) : null;
		this.#errors.push(...errors);
		const changed = withoutDir(changedFiles(this.#gitBefore, after), this.#workCwd, stateDir());
		if (job.review) {
			if (this.#review) {
				this.#finalText = renderReview(this.#review, job.review.target);
			} else if (status === "completed") {
				status = "failed";
				this.#errors.push("the worker ended without submitting a valid review");
			}
		}
		const progress = this.#progress();
		writeFileSync(join(jobDir(job.id), "result.md"), this.#finalText);
		this.#store.clearPending(job.id);
		this.#store.updateJob(job.id, {
			...progress,
			notices: [],
			status,
			finishedAt: nowIso(),
			stopReason: this.#stopReason,
			changedFiles: changed,
			exitCode,
			runnerPid: null,
			ompPid: null,
		});
		this.#feed("done", status, { changed_files: changed, cost_usd: progress.costUsd });
		this.#resolveDone(this.#store.getJob(job.id) as Job);
	}
}
