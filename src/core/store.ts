/**
 * SQLite state shared by the CLI and the runners (WAL, so many processes can read while one
 * writes). Large artefacts (raw RPC frames, stderr, final text) live in each job's directory.
 */
import { Database } from "bun:sqlite";
import { dbFile } from "./paths";
import type { FeedEntry, Job, JobSpec, JobStatus, Notice, Pending } from "./types";
import { nowIso } from "./util";

/** Bump when the layout changes; a database with another (or no) version is reset. */
const SCHEMA_VERSION = "omp-task/1";

const SCHEMA = `
	CREATE TABLE jobs (
		id TEXT PRIMARY KEY,
		parent_id TEXT,
		title TEXT NOT NULL,
		status TEXT NOT NULL,
		cwd TEXT NOT NULL,
		access TEXT NOT NULL,
		model TEXT,
		thinking TEXT,
		timeout_s REAL,
		answer_timeout_s REAL,
		approval_timeout_s REAL,
		stall_timeout_s REAL,
		add_dirs TEXT NOT NULL DEFAULT '[]',
		files TEXT NOT NULL DEFAULT '[]',
		extra_args TEXT NOT NULL DEFAULT '[]',
		no_preamble INTEGER NOT NULL DEFAULT 0,
		resume_session TEXT,
		isolate TEXT NOT NULL DEFAULT 'none',
		carry_dirty INTEGER NOT NULL DEFAULT 0,
		worktree_path TEXT,
		base_ref TEXT,
		branch TEXT,
		repo_root TEXT,
		after TEXT NOT NULL DEFAULT '[]',
		after_any INTEGER NOT NULL DEFAULT 0,
		group_name TEXT,
		budget_usd REAL,
		allow TEXT NOT NULL DEFAULT '[]',
		deny TEXT NOT NULL DEFAULT '[]',
		review TEXT,
		claude_session TEXT,
		created_at TEXT NOT NULL,
		started_at TEXT,
		finished_at TEXT,
		duration_s REAL,
		runner_pid INTEGER,
		omp_pid INTEGER,
		session_id TEXT,
		model_resolved TEXT,
		model_used TEXT,
		stop_reason TEXT,
		cost_usd REAL NOT NULL DEFAULT 0,
		tokens INTEGER NOT NULL DEFAULT 0,
		tools TEXT NOT NULL DEFAULT '{}',
		tool_errors TEXT NOT NULL DEFAULT '{}',
		denied_tools TEXT NOT NULL DEFAULT '[]',
		errors TEXT NOT NULL DEFAULT '[]',
		notices TEXT NOT NULL DEFAULT '[]',
		changed_files TEXT,
		exit_code INTEGER
	);
	CREATE INDEX jobs_cwd ON jobs(cwd);
	CREATE INDEX jobs_group ON jobs(group_name);
	CREATE INDEX jobs_claude_session ON jobs(claude_session);
	CREATE TABLE pending (
		job_id TEXT NOT NULL,
		ref TEXT NOT NULL,
		kind TEXT NOT NULL,
		text TEXT NOT NULL,
		tool TEXT,
		options TEXT NOT NULL DEFAULT '[]',
		context TEXT,
		asked_at TEXT NOT NULL,
		PRIMARY KEY (job_id, ref)
	);
	CREATE TABLE feed (
		job_id TEXT NOT NULL,
		seq INTEGER NOT NULL,
		ts TEXT NOT NULL,
		kind TEXT NOT NULL,
		text TEXT NOT NULL,
		data TEXT NOT NULL DEFAULT '{}',
		PRIMARY KEY (job_id, seq)
	);
	CREATE TABLE groups (
		name TEXT PRIMARY KEY,
		max_concurrent INTEGER,
		budget_usd REAL
	);`;

/** Every table a database of this or an earlier layout may have; dropped on a reset. */
const TABLES = ["jobs", "pending", "feed", "groups", "commands"];

type Row = Record<string, unknown>;

/** Limits stored for a group (by `plan apply`); the config's `groups` block gives defaults. */
export interface GroupSettings {
	name: string;
	maxConcurrent: number | null;
	budgetUsd: number | null;
}

const JSON_COLUMNS = new Set([
	"add_dirs",
	"files",
	"extra_args",
	"tools",
	"tool_errors",
	"denied_tools",
	"errors",
	"changed_files",
	"options",
	"payload",
	"result",
	"data",
	"after",
	"allow",
	"deny",
	"notices",
	"review",
]);

function camel(key: string): string {
	return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function snake(key: string): string {
	return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function fromRow<T>(row: Row): T {
	const out: Row = {};
	for (const [k, v] of Object.entries(row)) {
		out[camel(k)] = JSON_COLUMNS.has(k) && typeof v === "string" ? JSON.parse(v) : v;
	}
	if ("noPreamble" in out) out.noPreamble = Boolean(out.noPreamble);
	if ("carryDirty" in out) out.carryDirty = Boolean(out.carryDirty);
	if ("afterAny" in out) out.afterAny = Boolean(out.afterAny);
	return out as T;
}

function toColumn(key: string, value: unknown): unknown {
	if (JSON_COLUMNS.has(key)) return value === null ? null : JSON.stringify(value);
	if (typeof value === "boolean") return value ? 1 : 0;
	return value ?? null;
}

export class Store {
	readonly db: Database;
	/** Called after any change to a job, its feed or its pending items (the daemon wakes waiters). */
	onChange: (jobId: string) => void = () => {};

	constructor(path = dbFile()) {
		this.db = new Database(path, { create: true, strict: true });
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run("PRAGMA busy_timeout = 5000");
		this.db.run("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	close(): void {
		this.db.close();
	}

	private migrate(): void {
		this.db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const row = this.db.query("SELECT value FROM meta WHERE key = 'schema'").get() as {
			value: string;
		} | null;
		if (row?.value === SCHEMA_VERSION) return;
		this.db.transaction(() => {
			for (const table of TABLES) this.db.run(`DROP TABLE IF EXISTS ${table}`);
			this.db.run(SCHEMA);
			this.db.run("DELETE FROM meta");
			this.db.run("INSERT INTO meta (key, value) VALUES ('schema', ?)", [SCHEMA_VERSION]);
		})();
	}

	// ---------------------------------------------------------------- jobs

	createJob(id: string, spec: JobSpec): Job {
		this.db
			.query(
				`INSERT INTO jobs (id, parent_id, title, status, cwd, access, model, thinking, timeout_s,
				answer_timeout_s, approval_timeout_s, add_dirs, files, extra_args, no_preamble,
				resume_session, created_at, isolate, carry_dirty, after, after_any, group_name,
				budget_usd, allow, deny, stall_timeout_s, review, claude_session)
			VALUES ($id, $parentId, $title, $status, $cwd, $access, $model, $thinking, $timeoutS,
				$answerTimeoutS, $approvalTimeoutS, $addDirs, $files, $extraArgs, $noPreamble,
				$resumeSession, $createdAt, $isolate, $carryDirty, $after, $afterAny, $groupName,
				$budgetUsd, $allow, $deny, $stallTimeoutS, $review, $claudeSession)`,
			)
			.run({
				id,
				parentId: spec.parentId,
				title: spec.title,
				cwd: spec.cwd,
				access: spec.access,
				model: spec.model,
				thinking: spec.thinking,
				timeoutS: spec.timeoutS,
				answerTimeoutS: spec.answerTimeoutS,
				approvalTimeoutS: spec.approvalTimeoutS,
				addDirs: JSON.stringify(spec.addDirs),
				files: JSON.stringify(spec.files),
				extraArgs: JSON.stringify(spec.extraArgs),
				noPreamble: spec.noPreamble ? 1 : 0,
				resumeSession: spec.resumeSession,
				createdAt: nowIso(),
				isolate: spec.isolate ?? "none",
				carryDirty: spec.carryDirty ? 1 : 0,
				status: spec.after?.length ? "blocked" : "queued",
				after: JSON.stringify(spec.after ?? []),
				afterAny: spec.afterAny ? 1 : 0,
				groupName: spec.groupName ?? null,
				budgetUsd: spec.budgetUsd ?? null,
				allow: JSON.stringify(spec.allow ?? []),
				deny: JSON.stringify(spec.deny ?? []),
				stallTimeoutS: spec.stallTimeoutS ?? null,
				review: spec.review ? JSON.stringify(spec.review) : null,
				claudeSession: spec.claudeSession ?? null,
			});
		return this.getJob(id) as Job;
	}

	getJob(id: string): Job | null {
		const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as Row | null;
		return row ? fromRow<Job>(row) : null;
	}

	/** Exact id, or a unique prefix/suffix of one. */
	findJobIds(idPart: string): string[] {
		const exact = this.db.query("SELECT id FROM jobs WHERE id = ?").get(idPart) as Row | null;
		if (exact) return [String(exact.id)];
		const rows = this.db
			.query("SELECT id FROM jobs WHERE id LIKE ? OR id LIKE ? ORDER BY id")
			.all(`${idPart}%`, `%${idPart}`) as Row[];
		return rows.map((r) => String(r.id));
	}

	listJobs(opts: {
		limit: number;
		cwd?: string;
		status?: string;
		group?: string;
		claudeSession?: string;
	}): Job[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (opts.claudeSession) {
			where.push("claude_session = ?");
			params.push(opts.claudeSession);
		}
		if (opts.group) {
			where.push("group_name = ?");
			params.push(opts.group);
		}
		if (opts.cwd) {
			where.push("cwd = ?");
			params.push(opts.cwd);
		}
		if (opts.status) {
			where.push("status = ?");
			params.push(opts.status);
		}
		const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
		return (this.db.query(sql).all(...params, opts.limit) as Row[]).map((r) => fromRow<Job>(r));
	}

	updateJob(id: string, fields: Partial<Omit<Job, "id">>): void {
		const keys = Object.keys(fields);
		if (keys.length === 0) return;
		const sets = keys.map((k) => `${snake(k)} = ?`).join(", ");
		const values = keys.map((k) => toColumn(snake(k), (fields as Row)[k]));
		this.db.query(`UPDATE jobs SET ${sets} WHERE id = ?`).run(...(values as never[]), id);
		this.onChange(id);
	}

	/** Moves a job to `to` only if it is currently in one of `from`; returns whether it did. */
	transition(id: string, from: readonly JobStatus[], to: JobStatus): boolean {
		const placeholders = from.map(() => "?").join(", ");
		const res = this.db
			.query(`UPDATE jobs SET status = ? WHERE id = ? AND status IN (${placeholders})`)
			.run(to, id, ...from);
		if (res.changes > 0) this.onChange(id);
		return res.changes > 0;
	}

	/** Removes a job with its feed and pending items (its directory is the caller's). */
	deleteJob(id: string): void {
		this.db.transaction(() => {
			for (const table of ["feed", "pending"]) {
				this.db.query(`DELETE FROM ${table} WHERE job_id = ?`).run(id);
			}
			this.db.query("DELETE FROM jobs WHERE id = ?").run(id);
		})();
	}

	/** Jobs that are not finished yet, oldest first (the scheduler's view). */
	unfinishedJobs(): Job[] {
		const rows = this.db
			.query("SELECT * FROM jobs WHERE status IN ('blocked', 'queued') ORDER BY id")
			.all() as Row[];
		return rows.map((r) => fromRow<Job>(r));
	}

	/** Total cost of a group's jobs, or of every job created since `sinceIso`. */
	spentUsd(filter: { group: string } | { sinceIso: string }): number {
		const row = (
			"group" in filter
				? this.db
						.query("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM jobs WHERE group_name = ?")
						.get(filter.group)
				: this.db
						.query("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM jobs WHERE created_at >= ?")
						.get(filter.sinceIso)
		) as { s: number };
		return row.s;
	}

	// ---------------------------------------------------------------- notices

	addNotice(jobId: string, notice: Notice): void {
		const job = this.getJob(jobId);
		if (job) this.updateJob(jobId, { notices: [...job.notices, notice] });
	}

	/** Removes and returns a job's notices of the given kinds (what `wait` delivered). */
	takeNotices(jobId: string, kinds: readonly string[]): Notice[] {
		const job = this.getJob(jobId);
		if (!job) return [];
		const taken = job.notices.filter((n) => kinds.includes(n.kind));
		if (taken.length) {
			this.updateJob(jobId, { notices: job.notices.filter((n) => !kinds.includes(n.kind)) });
		}
		return taken;
	}

	// ---------------------------------------------------------------- groups

	getGroup(name: string): GroupSettings | null {
		const row = this.db.query("SELECT * FROM groups WHERE name = ?").get(name) as Row | null;
		return row ? fromRow<GroupSettings>(row) : null;
	}

	/** Creates or updates a group's limits; null leaves a limit as it was. */
	setGroup(
		name: string,
		limits: { maxConcurrent?: number | null; budgetUsd?: number | null },
	): void {
		this.db
			.query(
				`INSERT INTO groups (name, max_concurrent, budget_usd) VALUES (?, ?, ?)
				ON CONFLICT(name) DO UPDATE SET
					max_concurrent = COALESCE(excluded.max_concurrent, max_concurrent),
					budget_usd = COALESCE(excluded.budget_usd, budget_usd)`,
			)
			.run(name, limits.maxConcurrent ?? null, limits.budgetUsd ?? null);
	}

	// ---------------------------------------------------------------- pending questions/approvals

	addPending(p: Pending): void {
		this.db
			.query(
				`INSERT OR REPLACE INTO pending (job_id, ref, kind, text, tool, options, context, asked_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(p.jobId, p.ref, p.kind, p.text, p.tool, JSON.stringify(p.options), p.context, p.askedAt);
		this.onChange(p.jobId);
	}

	removePending(jobId: string, ref: string): boolean {
		const removed =
			this.db.query("DELETE FROM pending WHERE job_id = ? AND ref = ?").run(jobId, ref).changes > 0;
		if (removed) this.onChange(jobId);
		return removed;
	}

	clearPending(jobId: string): void {
		if (this.db.query("DELETE FROM pending WHERE job_id = ?").run(jobId).changes > 0) {
			this.onChange(jobId);
		}
	}

	listPending(jobId: string): Pending[] {
		return (
			this.db
				.query("SELECT * FROM pending WHERE job_id = ? ORDER BY asked_at, rowid")
				.all(jobId) as Row[]
		).map((r) => fromRow<Pending>(r));
	}

	// ---------------------------------------------------------------- feed

	appendFeed(
		jobId: string,
		kind: string,
		text = "",
		data: Record<string, unknown> = {},
		ts = nowIso(),
	): FeedEntry {
		const seq = this.db.transaction(() => {
			const row = this.db
				.query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM feed WHERE job_id = ?")
				.get(jobId) as { next: number };
			this.db
				.query("INSERT INTO feed (job_id, seq, ts, kind, text, data) VALUES (?, ?, ?, ?, ?, ?)")
				.run(jobId, row.next, ts, kind, text, JSON.stringify(data));
			return row.next;
		})();
		this.onChange(jobId);
		return { jobId, seq, ts, kind, text, data };
	}

	feedSince(jobId: string, afterSeq: number): FeedEntry[] {
		return (
			this.db
				.query("SELECT * FROM feed WHERE job_id = ? AND seq > ? ORDER BY seq")
				.all(jobId, afterSeq) as Row[]
		).map((r) => fromRow<FeedEntry>(r));
	}

	lastFeedSeq(jobId: string): number {
		const row = this.db
			.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM feed WHERE job_id = ?")
			.get(jobId) as { seq: number };
		return row.seq;
	}
}
