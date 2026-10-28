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
import { changedFiles, type Snapshot, snapshot, withoutDir } from "./git";
import { jobDir, PREAMBLE_FILE, stateDir } from "./paths";
import type { Store } from "./store";
import type {
	ApprovalDecision,
	CommandResult,
	ControlRequest,
	Job,
	JobStatus,
	PendingKind,
	TerminalStatus,
} from "./types";
import { nowIso } from "./util";

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
const QUESTION_EXPIRED_ANSWER =
	"No answer from the orchestrator in time. Make the most reasonable assumption, continue, " +
	"and list the assumption under Open issues.";

interface LivePending {
	kind: PendingKind;
	tool: string | null;
	text: string;
	since: number;
}

export function promptText(job: Job): string {
	let text = readFileSync(join(jobDir(job.id), "prompt.md"), "utf8");
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
	#abortReason: "cancelled" | "timeout" | null = null;
	#abortDeadline: number | null = null;
	#finished = false;
	#started = performance.now();
	/** Duration of earlier runs of this job (before an interruption). */
	readonly #baseDurationS: number;
	#gitBefore: Snapshot | null = null;
	/** The omp session this run resumed after an interruption, if any. */
	#resumedSession: string | null = null;
	/** Whether omp got as far as reporting its session (it never does when --resume fails). */
	#sawStart = false;
	#tick: ReturnType<typeof setInterval> | null = null;
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

	constructor(store: Store, jobId: string, backend: Backend = ompRpcBackend) {
		this.#store = store;
		this.#backend = backend;
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
		this.#modelUsed = job.modelUsed;
		this.#done = new Promise((resolve) => {
			this.#resolveDone = resolve;
		});
	}

	/**
	 * Starts the job; resolves with the final record once it has ended. With `resume`, an
	 * interrupted job goes on in its omp session (or starts over if it never got one).
	 */
	run(opts: { resume?: boolean } = {}): Promise<Job> {
		const job = this.#job;
		this.#gitBefore = this.#loadGitBefore(job);
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
			this.#startSession(job.resumeSession, promptText(job));
		}
		this.#tick = setInterval(() => this.#onTick(), TICK_MS);
		return this.#done;
	}

	#startSession(resumeSession: string | null, prompt: string): void {
		const job = this.#job;
		const dir = jobDir(job.id);
		this.#session = this.#backend.start(
			{
				cwd: job.cwd,
				access: job.access,
				model: job.model,
				thinking: job.thinking,
				resumeSession,
				systemPromptFile: job.noPreamble || !existsSync(PREAMBLE_FILE) ? null : PREAMBLE_FILE,
				addDirs: job.addDirs,
				extraArgs: job.extraArgs,
				prompt,
				rawLogPath: join(dir, "events.jsonl"),
				stderrPath: join(dir, "stderr.log"),
			},
			(e) => this.#onEvent(e),
		);
	}

	/** The dirty-file snapshot from the job's first run, so a resumed job reports all its changes. */
	#loadGitBefore(job: Job): Snapshot | null {
		const file = join(jobDir(job.id), "git-before.json");
		if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Snapshot | null;
		const snap = snapshot(job.cwd);
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

	#onEvent(e: BackendEvent): void {
		if (this.#finished) return;
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
				this.#feed("progress", e.text.slice(0, 300));
				break;
			case "tool_start":
				this.#tools[e.name] = (this.#tools[e.name] ?? 0) + 1;
				this.#store.updateJob(this.#jobId, { tools: this.#tools }); // for `status` while running
				if (FEED_TOOLS.has(e.name)) this.#feed("tool", `${e.name}: ${e.detail.slice(0, 160)}`);
				break;
			case "tool_end":
				if (e.isError) {
					if (/requires approval|denied/i.test(e.text)) this.#denied.add(e.name);
					// Usually a non-zero exit, e.g. a failing test run: normal work, not a job error.
					else this.#toolErrors[e.name] = (this.#toolErrors[e.name] ?? 0) + 1;
				}
				break;
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
				break;
			case "subagent": {
				if (e.costUsd !== null && e.costUsd !== this.#subagentCost.get(e.id)) {
					this.#subagentCost.set(e.id, e.costUsd);
					this.#store.updateJob(this.#jobId, this.#progress());
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
			case "approval":
				this.#addPending(e.ref, "approval", e.detail, e.tool, e.options, null);
				this.#feed("approval", `${e.tool}: ${e.detail}`.slice(0, 300), {
					ref: e.ref,
					tool: e.tool,
				});
				break;
			case "warning":
				this.#feed("info", e.text.slice(0, 300));
				break;
			case "end":
				void this.#finishFromEnd(e);
				break;
		}
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
			this.#startSession(this.#job.resumeSession, promptText(this.#job));
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

	#abort(reason: "cancelled" | "timeout"): void {
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
		const after = this.#gitBefore ? snapshot(job.cwd) : null;
		this.#errors.push(...errors);
		const changed = withoutDir(changedFiles(this.#gitBefore, after), job.cwd, stateDir());
		const progress = this.#progress();
		writeFileSync(join(jobDir(job.id), "result.md"), this.#finalText);
		this.#store.clearPending(job.id);
		this.#store.updateJob(job.id, {
			...progress,
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
