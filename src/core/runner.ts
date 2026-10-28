/**
 * Runs one job to completion: starts the backend session, turns its events into job state, feed
 * lines and pending questions/approvals, executes control commands queued by the CLI, and
 * enforces timeouts. In M1 each runner is its own detached process; the daemon (M2) will host
 * many of them.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_PROMPT_BYTES } from "../backends/omp-rpc/protocol";
import { ompRpcBackend } from "../backends/omp-rpc/session";
import type { Backend, BackendEvent, BackendSession } from "../backends/types";
import { changedFiles, type Snapshot, snapshot, withoutDir } from "./git";
import { jobDir, PREAMBLE_FILE, stateDir } from "./paths";
import type { CommandRow, Store } from "./store";
import type { Job, JobStatus, PendingKind, TerminalStatus } from "./types";
import { nowIso } from "./util";

/** Tools whose calls are worth a feed line: they change things or start sub-work. */
const FEED_TOOLS = new Set(["write", "edit", "bash", "eval", "task"]);
const TICK_MS = 100;
/** After an abort, how long omp gets to wind down before the job is closed anyway. */
const ABORT_GRACE_MS = 15_000;
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
	#gitBefore: Snapshot | null = null;
	#tick: ReturnType<typeof setInterval> | null = null;
	#done: Promise<Job>;
	#resolveDone!: (job: Job) => void;

	// Accumulated from backend events.
	#tools: Record<string, number> = {};
	#toolErrors: Record<string, number> = {};
	#denied = new Set<string>();
	#errors: string[] = [];
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
		this.#done = new Promise((resolve) => {
			this.#resolveDone = resolve;
		});
	}

	/** Starts the job; resolves with the final record once it has ended. */
	run(): Promise<Job> {
		const job = this.#job;
		this.#gitBefore = snapshot(job.cwd);
		const dir = jobDir(job.id);
		this.#store.updateJob(job.id, {
			status: "starting",
			startedAt: nowIso(),
			runnerPid: process.pid,
		});
		this.#session = this.#backend.start(
			{
				cwd: job.cwd,
				access: job.access,
				model: job.model,
				thinking: job.thinking,
				resumeSession: job.resumeSession,
				systemPromptFile: job.noPreamble || !existsSync(PREAMBLE_FILE) ? null : PREAMBLE_FILE,
				addDirs: job.addDirs,
				extraArgs: job.extraArgs,
				prompt: promptText(job),
				rawLogPath: join(dir, "events.jsonl"),
				stderrPath: join(dir, "stderr.log"),
			},
			(e) => this.#onEvent(e),
		);
		this.#tick = setInterval(() => this.#onTick(), TICK_MS);
		return this.#done;
	}

	/** Asks the job to stop, as `omp-task cancel` does. */
	cancel(): void {
		if (!this.#finished && !this.#abortReason) {
			this.#feed("abort", "cancel requested");
			this.#abort("cancelled");
		}
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
				break;
			case "subagent": {
				if (e.costUsd !== null) this.#subagentCost.set(e.id, e.costUsd);
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
		for (const cmd of this.#store.openCommands(this.#jobId)) {
			this.#store.completeCommand(cmd.id, this.#onCommand(cmd));
		}
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

	#onCommand(cmd: CommandRow): { ok: boolean; error?: string; ref?: string } {
		if (this.#finished) return { ok: false, error: "job already ended" };
		const session = this.#session;
		if (!session) return { ok: false, error: "job has not started" };
		switch (cmd.kind) {
			case "steer": {
				const message = cmd.payload.message ?? "";
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
				const ref = cmd.payload.ref ?? null;
				const match = [...this.#pending.entries()].find(
					([r, p]) => p.kind === kind && (!ref || r === ref),
				);
				if (!match) {
					return { ok: false, error: `no pending ${kind}${ref ? ` with ref ${ref}` : ""}` };
				}
				const [r, item] = match;
				if (cmd.kind === "reply") {
					const message = cmd.payload.message ?? "";
					this.#resolvePending(r, message);
					this.#feed("answered", message.slice(0, 300), { ref: r });
				} else {
					const decision = cmd.payload.decision ?? "approve";
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
		const subagentCost = [...this.#subagentCost.values()].reduce((a, b) => a + b, 0);
		const allErrors = [...this.#errors, ...errors].slice(-5);
		const changed = withoutDir(changedFiles(this.#gitBefore, after), job.cwd, stateDir());
		const costUsd = Math.round((this.#costUsd + subagentCost) * 1e6) / 1e6;
		writeFileSync(join(jobDir(job.id), "result.md"), this.#finalText);
		this.#store.clearPending(job.id);
		// Commands that arrived too late still get an answer.
		for (const cmd of this.#store.openCommands(job.id)) {
			this.#store.completeCommand(cmd.id, { ok: false, error: `job already ${status}` });
		}
		this.#store.updateJob(job.id, {
			status,
			finishedAt: nowIso(),
			durationS: Math.round((performance.now() - this.#started) / 100) / 10,
			modelUsed: this.#modelUsed,
			stopReason: this.#stopReason,
			tools: this.#tools,
			toolErrors: this.#toolErrors,
			deniedTools: [...this.#denied].sort(),
			errors: allErrors,
			changedFiles: changed,
			costUsd,
			tokens: this.#tokens,
			exitCode,
			runnerPid: null,
		});
		this.#feed("done", status, { changed_files: changed, cost_usd: costUsd });
		this.#resolveDone(this.#store.getJob(job.id) as Job);
	}
}
