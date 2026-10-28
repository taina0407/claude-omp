/**
 * The per-user daemon: owns the job database, runs every job's JobRunner, and serves the CLI an
 * HTTP API on a unix socket. It starts on demand (the CLI spawns it), stops after a while with
 * nothing to do, and on start marks jobs it was running when it last stopped as `interrupted`.
 */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { Server } from "bun";
import type { z } from "zod";
import {
	type ApplyResponse,
	applyBody,
	type ControlResponse,
	controlBody,
	createJobBody,
	type DiffResponse,
	type FeedEvent,
	type Health,
	type JobView,
	type PruneResponse,
	pruneBody,
	shutdownBody,
	type WaitResponse,
} from "../api/schema";
import { loadConfig } from "../core/config";
import { createJob, NotFoundError, resolveJob } from "../core/jobs";
import { socketPath } from "../core/paths";
import { JobRunner } from "../core/runner";
import { Store } from "../core/store";
import { isActive, isTerminal, type Job } from "../core/types";
import { errorText, nowIso, parseDuration, stopOrphanWorker, UsageError } from "../core/util";
import { applyWorktree, removeWorktree, worktreePatch } from "../isolation/worktree";
import { VERSION } from "../version";
import { acquireLock, releaseLock } from "./lock";
import { log } from "./log";

const DEFAULT_IDLE_S = 15 * 60;
const IDLE_CHECK_MS = 1_000;
/** Longest a single `wait` request is held open; the CLI simply asks again. */
const MAX_LONG_POLL_S = 60;
const SSE_HEARTBEAT_MS = 15_000;

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		throw new HttpError(400, "request body must be JSON");
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success)
		throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
	return parsed.data;
}

function idleSeconds(): number {
	const env = process.env.OMP_TASK_DAEMON_IDLE;
	if (env) return Number(env);
	try {
		return parseDuration(loadConfig().daemon_idle_timeout ?? null) ?? DEFAULT_IDLE_S;
	} catch {
		return DEFAULT_IDLE_S;
	}
}

export class Daemon {
	readonly store = new Store();
	readonly #runners = new Map<string, JobRunner>();
	readonly #waiters = new Set<() => void>();
	readonly #startedAt = nowIso();
	#server: Server<undefined> | null = null;
	/** Open `wait` and `watch` requests: the daemon is not idle while anyone is listening. */
	#clients = 0;
	#lastActivity = performance.now();
	#idleTimer: ReturnType<typeof setInterval> | null = null;
	#stopping: Promise<void> | null = null;

	constructor() {
		this.store.onChange = () => {
			for (const wake of [...this.#waiters]) wake();
		};
	}

	/** Takes the lock and the socket; false when another daemon already serves this state dir. */
	start(): boolean {
		if (!acquireLock()) return false;
		const path = socketPath();
		if (existsSync(path)) unlinkSync(path); // we hold the lock, so it is a stale socket
		// idleTimeout 0: `wait` and `watch` hold requests open for long periods. Bun's types reject
		// the option next to `unix`, but the runtime honours it (without it requests die at 10s).
		const options = { unix: path, idleTimeout: 0, fetch: (req: Request) => this.#handle(req) };
		this.#server = Bun.serve(
			options as unknown as Parameters<typeof Bun.serve>[0],
		) as Server<undefined>;
		chmodSync(path, 0o600);
		log("info", "listening", { socket: path, version: VERSION });
		this.#recover();
		const idleMs = idleSeconds() * 1000;
		this.#idleTimer = setInterval(() => {
			const idle = this.#runners.size === 0 && this.#clients === 0;
			if (idle && performance.now() - this.#lastActivity > idleMs) {
				log("info", "idle, stopping");
				void this.stop("daemon idle").then(() => process.exit(0));
			}
		}, IDLE_CHECK_MS);
		return true;
	}

	/** Interrupts running jobs (resumable), closes the socket and releases the lock. */
	stop(reason: string): Promise<void> {
		this.#stopping ??= (async () => {
			if (this.#idleTimer) clearInterval(this.#idleTimer);
			this.#server?.stop(true);
			await Promise.all([...this.#runners.values()].map((r) => r.interrupt(reason)));
			try {
				unlinkSync(socketPath());
			} catch {
				// already gone
			}
			this.store.close();
			releaseLock();
			log("info", "stopped", { reason });
		})();
		return this.#stopping;
	}

	/** Jobs this daemon's predecessor was running when it died are interrupted, not lost. */
	#recover(): void {
		const autoResume = (() => {
			try {
				return loadConfig().auto_resume === true;
			} catch {
				return false;
			}
		})();
		const stale = this.store.listJobs({ limit: 10_000 }).filter((j) => isActive(j.status));
		for (const job of stale) {
			if (job.status === "queued") {
				this.#start(job, false);
				continue;
			}
			// omp does not exit when its stdin closes mid-turn; stop it before anyone resumes the session.
			if (stopOrphanWorker(job.ompPid)) {
				log("warn", "stopped an orphaned omp worker", { job: job.id, pid: job.ompPid });
			}
			this.store.clearPending(job.id);
			this.store.updateJob(job.id, { status: "interrupted", runnerPid: null, ompPid: null });
			this.store.appendFeed(job.id, "interrupted", "the daemon stopped while this job ran");
			log("warn", "job interrupted by a daemon restart", { job: job.id });
			if (autoResume) this.#resume(job);
		}
	}

	#start(job: Job, resume: boolean): void {
		const runner = new JobRunner(this.store, job.id);
		this.#runners.set(job.id, runner);
		log("info", resume ? "resuming job" : "starting job", { job: job.id });
		runner
			.run({ resume })
			.catch((e) => log("error", "runner crashed", { job: job.id, error: errorText(e) }))
			.finally(() => {
				this.#runners.delete(job.id);
				this.#lastActivity = performance.now();
				log("info", "job ended", { job: job.id, status: this.store.getJob(job.id)?.status });
			});
	}

	#resume(job: Job): Job {
		this.store.appendFeed(
			job.id,
			"resumed",
			job.sessionId ? "continuing the omp session" : "starting over",
		);
		this.#start(job, true);
		return this.store.getJob(job.id) as Job;
	}

	#view(job: Job): JobView {
		return { job, pending: this.store.listPending(job.id) };
	}

	/** Resolves on the next change to any job, or after `ms`. */
	#nextChange(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				this.#waiters.delete(wake);
				resolve();
			};
			const timer = setTimeout(wake, ms);
			this.#waiters.add(wake);
		});
	}

	// ---------------------------------------------------------------- HTTP

	async #handle(req: Request): Promise<Response> {
		this.#lastActivity = performance.now();
		const url = new URL(req.url);
		try {
			return await this.#route(req, url);
		} catch (e) {
			if (e instanceof HttpError) return json({ error: e.message }, e.status);
			if (e instanceof NotFoundError) return json({ error: e.message }, 404);
			if (e instanceof UsageError) return json({ error: e.message }, 400);
			log("error", "request failed", { path: url.pathname, error: errorText(e) });
			return json({ error: `daemon error: ${errorText(e)}` }, 500);
		}
	}

	async #route(req: Request, url: URL): Promise<Response> {
		const parts = url.pathname.split("/").filter(Boolean); // ["v1", ...]
		if (parts[0] !== "v1") throw new HttpError(404, `no route ${url.pathname}`);
		const [, resource, ref, action] = parts;
		const method = req.method;

		if (resource === "health" && method === "GET") {
			const health: Health = {
				ok: true,
				version: VERSION,
				pid: process.pid,
				startedAt: this.#startedAt,
				activeJobs: this.#runners.size,
			};
			return json(health);
		}
		if (resource === "shutdown" && method === "POST") {
			const { force } = await body(req, shutdownBody);
			if (this.#runners.size && !force) {
				throw new HttpError(
					409,
					`${this.#runners.size} job(s) running; use --force to interrupt them`,
				);
			}
			setTimeout(() => void this.stop("stopped by request").then(() => process.exit(0)), 10);
			return json({ ok: true });
		}
		if (resource === "wait" && method === "GET") return this.#wait(url);
		if (resource === "feed" && method === "GET") return this.#feed(url);
		if (resource === "prune" && method === "POST") return this.#prune(await body(req, pruneBody));

		if (resource === "jobs") {
			if (!ref) {
				if (method === "GET") {
					const status = url.searchParams.get("status");
					const cwd = url.searchParams.get("cwd");
					const opts: { limit: number; cwd?: string; status?: string } = {
						limit: Number(url.searchParams.get("limit") ?? 20),
					};
					if (cwd) opts.cwd = cwd;
					if (status) opts.status = status;
					return json({ jobs: this.store.listJobs(opts) });
				}
				if (method === "POST") return this.#create(await body(req, createJobBody));
			}
			if (ref && !action && method === "GET") return json(this.#view(resolveJob(this.store, ref)));
			if (ref && action === "control" && method === "POST") {
				return this.#control(resolveJob(this.store, ref), await body(req, controlBody));
			}
			if (ref && action === "diff" && method === "GET") return this.#diff(ref);
			if (ref && action === "apply" && method === "POST") {
				return this.#apply(ref, await body(req, applyBody));
			}
			if (ref && action === "discard" && method === "POST") return this.#discard(ref);
			if (ref && action === "resume" && method === "POST") {
				const job = resolveJob(this.store, ref);
				if (job.status !== "interrupted") {
					throw new HttpError(409, `job ${job.id} is ${job.status}; only interrupted jobs resume`);
				}
				return json(this.#view(this.#resume(job)));
			}
		}
		throw new HttpError(404, `no route ${method} ${url.pathname}`);
	}

	#create(b: z.infer<typeof createJobBody>): Response {
		let parent: Job | null = null;
		if (b.parent) {
			parent = resolveJob(this.store, b.parent);
			if (!isTerminal(parent.status)) {
				throw new HttpError(
					409,
					`job ${parent.id} is still ${parent.status}; use steer/reply/approve, or wait for it`,
				);
			}
			if (!parent.sessionId) {
				throw new HttpError(409, `job ${parent.id} has no omp session to continue`);
			}
		}
		const job = createJob(this.store, b.options, parent);
		this.#start(job, false);
		return json(this.#view(this.store.getJob(job.id) as Job), 201);
	}

	#control(job: Job, b: z.infer<typeof controlBody>): Response {
		const runner = this.#runners.get(job.id);
		if (!runner) {
			if (job.status === "interrupted" && b.kind === "abort") {
				this.store.updateJob(job.id, { status: "cancelled", finishedAt: nowIso() });
				this.store.appendFeed(job.id, "done", "cancelled", {
					changed_files: job.changedFiles,
					cost_usd: job.costUsd,
				});
				const res: ControlResponse = { ok: true };
				return json(res);
			}
			throw new HttpError(409, `job ${job.id} is ${job.status}, not running`);
		}
		const res: ControlResponse = runner.control(b);
		return json(res);
	}

	/** A job whose worktree can be inspected: it must have ended and have one. */
	#worktreeJob(ref: string): Job {
		const job = resolveJob(this.store, ref);
		if (isActive(job.status)) throw new HttpError(409, `job ${job.id} is still ${job.status}`);
		if (!job.worktreePath) throw new HttpError(409, `job ${job.id} has no worktree`);
		return job;
	}

	#diff(ref: string): Response {
		const job = this.#worktreeJob(ref);
		const res: DiffResponse = worktreePatch(job);
		return json(res);
	}

	#apply(ref: string, b: z.infer<typeof applyBody>): Response {
		const job = this.#worktreeJob(ref);
		const res: ApplyResponse = applyWorktree(job, { threeWay: b.threeWay === true });
		if (res.ok && !b.keep) {
			removeWorktree(job);
			this.store.updateJob(job.id, { worktreePath: null, branch: null });
			this.store.appendFeed(
				job.id,
				"info",
				`applied ${res.files.length} file(s); worktree removed`,
			);
		}
		return json(res);
	}

	#discard(ref: string): Response {
		const job = this.#worktreeJob(ref);
		removeWorktree(job);
		this.store.updateJob(job.id, { worktreePath: null, branch: null });
		this.store.appendFeed(job.id, "info", "worktree removed");
		return json({ ok: true });
	}

	/** Removes worktrees of finished jobs older than `olderS` (default a week). */
	#prune(b: z.infer<typeof pruneBody>): Response {
		const cutoff = Date.now() - (b.olderS ?? 7 * 24 * 3600) * 1000;
		const removed: string[] = [];
		for (const job of this.store.listJobs({ limit: 10_000 })) {
			if (isActive(job.status) || !job.worktreePath) continue;
			// Interrupted jobs never got a finishedAt; measure them from their creation.
			const done = Date.parse(job.finishedAt ?? job.createdAt);
			if (!Number.isFinite(done) || done > cutoff) continue;
			if (!b.dryRun) {
				removeWorktree(job);
				this.store.updateJob(job.id, { worktreePath: null, branch: null });
			}
			removed.push(job.id);
		}
		const res: PruneResponse = { removed };
		return json(res);
	}

	async #wait(url: URL): Promise<Response> {
		const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
		if (!ids.length) throw new HttpError(400, "ids is required");
		const attention = url.searchParams.get("attention") !== "0";
		const timeoutS = Math.min(Number(url.searchParams.get("timeout") ?? 25), MAX_LONG_POLL_S);
		const deadline = performance.now() + timeoutS * 1000;
		const jobIds = ids.map((r) => resolveJob(this.store, r).id);
		this.#clients++;
		try {
			while (true) {
				const views = jobIds.map((id) => this.#view(this.store.getJob(id) as Job));
				const needs = views.some((v) => v.pending.length > 0 || v.job.status === "interrupted");
				let reason: WaitResponse["reason"] | null = null;
				if (attention && needs) reason = "attention";
				else if (views.every((v) => isTerminal(v.job.status))) reason = "done";
				else if (performance.now() >= deadline) reason = "timeout";
				if (reason) {
					const res: WaitResponse = { reason, jobs: views };
					return json(res);
				}
				await this.#nextChange(deadline - performance.now());
			}
		} finally {
			this.#clients--;
			this.#lastActivity = performance.now();
		}
	}

	/** Server-sent events: one `feed` event per feed line, then `end` once every job has ended. */
	#feed(url: URL): Response {
		const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
		if (!ids.length) throw new HttpError(400, "ids is required");
		const fromStart = url.searchParams.get("from") === "start";
		const jobIds = ids.map((r) => resolveJob(this.store, r).id);
		const seq = new Map(jobIds.map((id) => [id, fromStart ? 0 : this.store.lastFeedSeq(id)]));
		const encoder = new TextEncoder();
		const daemon = this;
		let closed = false;
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				daemon.#clients++;
				const send = (event: FeedEvent) =>
					controller.enqueue(
						encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
					);
				try {
					if (!fromStart) {
						// Surface anything already waiting on the orchestrator, so a late watcher sees it.
						for (const id of jobIds) {
							for (const p of daemon.store.listPending(id)) {
								send({
									type: "feed",
									entry: {
										jobId: id,
										seq: 0,
										ts: p.askedAt,
										kind: p.kind,
										text: p.text,
										data: { options: p.options, ref: p.ref },
									},
								});
							}
						}
					}
					let lastBeat = performance.now();
					while (!closed) {
						for (const id of jobIds) {
							for (const entry of daemon.store.feedSince(id, seq.get(id) ?? 0)) {
								seq.set(id, entry.seq);
								send({ type: "feed", entry });
							}
						}
						const jobs = jobIds.map((id) => daemon.store.getJob(id) as Job);
						const ended = jobs.every((j) => isTerminal(j.status) || j.status === "interrupted");
						const drained = jobIds.every(
							(id) => (seq.get(id) ?? 0) >= daemon.store.lastFeedSeq(id),
						);
						if (ended && drained) {
							send({ type: "end", jobs: jobs.map((j) => ({ id: j.id, status: j.status })) });
							break;
						}
						if (performance.now() - lastBeat > SSE_HEARTBEAT_MS) {
							controller.enqueue(encoder.encode(": keep-alive\n\n"));
							lastBeat = performance.now();
						}
						await daemon.#nextChange(SSE_HEARTBEAT_MS);
					}
					controller.close();
				} catch {
					// the client went away
				} finally {
					daemon.#clients--;
					daemon.#lastActivity = performance.now();
				}
			},
			cancel() {
				closed = true;
			},
		});
		return new Response(stream, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
		});
	}
}

/** Entry point of `omp-task daemon`: serve until stopped. Returns false if one already runs. */
export async function runDaemon(): Promise<boolean> {
	const daemon = new Daemon();
	if (!daemon.start()) return false;
	const stop = (signal: string) => {
		log("info", "signal", { signal });
		void daemon.stop(`daemon stopped (${signal})`).then(() => process.exit(0));
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
	process.on("uncaughtException", (e) => {
		log("error", "uncaught exception", { error: errorText(e), stack: (e as Error).stack });
	});
	await new Promise(() => {}); // until a signal, an idle stop or a shutdown request
	return true;
}
