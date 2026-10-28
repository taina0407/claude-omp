/**
 * SQLite state shared by the CLI and the runners (WAL, so many processes can read while one
 * writes). Large artefacts (raw RPC frames, stderr, final text) live in each job's directory.
 */
import { Database } from "bun:sqlite";
import { dbFile } from "./paths";
import type {
	ApprovalDecision,
	CommandKind,
	CommandResult,
	FeedEntry,
	Job,
	JobSpec,
	JobStatus,
	Pending,
} from "./types";
import { nowIso } from "./util";

const MIGRATIONS: string[] = [
	`CREATE TABLE jobs (
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
		add_dirs TEXT NOT NULL DEFAULT '[]',
		files TEXT NOT NULL DEFAULT '[]',
		extra_args TEXT NOT NULL DEFAULT '[]',
		no_preamble INTEGER NOT NULL DEFAULT 0,
		resume_session TEXT,
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
		changed_files TEXT,
		exit_code INTEGER
	);
	CREATE INDEX jobs_cwd ON jobs(cwd);
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
	CREATE TABLE commands (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		payload TEXT NOT NULL DEFAULT '{}',
		created_at TEXT NOT NULL,
		handled_at TEXT,
		result TEXT
	);
	CREATE INDEX commands_open ON commands(job_id, handled_at);`,
];

type Row = Record<string, unknown>;

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
	return out as T;
}

function toColumn(key: string, value: unknown): unknown {
	if (JSON_COLUMNS.has(key)) return value === null ? null : JSON.stringify(value);
	if (typeof value === "boolean") return value ? 1 : 0;
	return value ?? null;
}

export interface CommandRow {
	id: number;
	jobId: string;
	kind: CommandKind;
	payload: { message?: string; ref?: string | null; decision?: ApprovalDecision };
	createdAt: string;
	handledAt: string | null;
	result: CommandResult | null;
}

export class Store {
	readonly db: Database;

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
		const row = this.db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
			value: string;
		} | null;
		let version = row ? Number(row.value) : 0;
		while (version < MIGRATIONS.length) {
			const sql = MIGRATIONS[version] as string;
			this.db.transaction(() => {
				this.db.run(sql);
				this.db.run(
					"INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
					[String(version + 1)],
				);
			})();
			version++;
		}
	}

	// ---------------------------------------------------------------- jobs

	createJob(id: string, spec: JobSpec): Job {
		this.db
			.query(
				`INSERT INTO jobs (id, parent_id, title, status, cwd, access, model, thinking, timeout_s,
				answer_timeout_s, approval_timeout_s, add_dirs, files, extra_args, no_preamble,
				resume_session, created_at)
			VALUES ($id, $parentId, $title, 'queued', $cwd, $access, $model, $thinking, $timeoutS,
				$answerTimeoutS, $approvalTimeoutS, $addDirs, $files, $extraArgs, $noPreamble,
				$resumeSession, $createdAt)`,
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
			});
		return this.getJob(id) as Job;
	}

	getJob(id: string): Job | null {
		const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as Row | null;
		return row ? fromRow<Job>(row) : null;
	}

	/** Exact id, or a unique prefix/suffix of one (v0.2 behaviour). */
	findJobIds(idPart: string): string[] {
		const exact = this.db.query("SELECT id FROM jobs WHERE id = ?").get(idPart) as Row | null;
		if (exact) return [String(exact.id)];
		const rows = this.db
			.query("SELECT id FROM jobs WHERE id LIKE ? OR id LIKE ? ORDER BY id")
			.all(`${idPart}%`, `%${idPart}`) as Row[];
		return rows.map((r) => String(r.id));
	}

	listJobs(opts: { limit: number; cwd?: string; status?: string }): Job[] {
		const where: string[] = [];
		const params: (string | number)[] = [];
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
	}

	/** Moves a job to `to` only if it is currently in one of `from`; returns whether it did. */
	transition(id: string, from: readonly JobStatus[], to: JobStatus): boolean {
		const placeholders = from.map(() => "?").join(", ");
		const res = this.db
			.query(`UPDATE jobs SET status = ? WHERE id = ? AND status IN (${placeholders})`)
			.run(to, id, ...from);
		return res.changes > 0;
	}

	// ---------------------------------------------------------------- pending questions/approvals

	addPending(p: Pending): void {
		this.db
			.query(
				`INSERT OR REPLACE INTO pending (job_id, ref, kind, text, tool, options, context, asked_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(p.jobId, p.ref, p.kind, p.text, p.tool, JSON.stringify(p.options), p.context, p.askedAt);
	}

	removePending(jobId: string, ref: string): boolean {
		return (
			this.db.query("DELETE FROM pending WHERE job_id = ? AND ref = ?").run(jobId, ref).changes > 0
		);
	}

	clearPending(jobId: string): void {
		this.db.query("DELETE FROM pending WHERE job_id = ?").run(jobId);
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
	): FeedEntry {
		const ts = nowIso();
		const seq = this.db.transaction(() => {
			const row = this.db
				.query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM feed WHERE job_id = ?")
				.get(jobId) as { next: number };
			this.db
				.query("INSERT INTO feed (job_id, seq, ts, kind, text, data) VALUES (?, ?, ?, ?, ?, ?)")
				.run(jobId, row.next, ts, kind, text, JSON.stringify(data));
			return row.next;
		})();
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

	// ---------------------------------------------------------------- control commands

	enqueueCommand(jobId: string, kind: CommandKind, payload: CommandRow["payload"]): number {
		const res = this.db
			.query("INSERT INTO commands (job_id, kind, payload, created_at) VALUES (?, ?, ?, ?)")
			.run(jobId, kind, JSON.stringify(payload), nowIso());
		return Number(res.lastInsertRowid);
	}

	openCommands(jobId: string): CommandRow[] {
		return (
			this.db
				.query("SELECT * FROM commands WHERE job_id = ? AND handled_at IS NULL ORDER BY id")
				.all(jobId) as Row[]
		).map((r) => fromRow<CommandRow>(r));
	}

	completeCommand(id: number, result: CommandResult): void {
		this.db
			.query("UPDATE commands SET handled_at = ?, result = ? WHERE id = ?")
			.run(nowIso(), JSON.stringify(result), id);
	}

	getCommand(id: number): CommandRow | null {
		const row = this.db.query("SELECT * FROM commands WHERE id = ?").get(id) as Row | null;
		return row ? fromRow<CommandRow>(row) : null;
	}
}
