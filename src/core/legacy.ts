/**
 * Jobs left by omp-task 0.2, which kept each job as `jobs/<id>/meta.json` in the same state dir.
 * The daemon imports them once so `list`, `status`, `result` and `continue` see them. A 0.2 job
 * that never finished cannot be resumed (its supervisor is gone) and is imported as failed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jobsDir } from "./paths";
import type { Store } from "./store";
import { ACCESS_LEVELS, type Access, isTerminal, type JobStatus } from "./types";
import { parseDuration } from "./util";

type Meta = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const counts = (v: unknown): Record<string, number> =>
	v && typeof v === "object" ? (v as Record<string, number>) : {};
const seconds = (v: unknown): number | null => {
	try {
		return parseDuration(typeof v === "number" || typeof v === "string" ? v : null);
	} catch {
		return null;
	}
};

/** Imports every 0.2 job the database does not know yet; returns their ids. */
export function importLegacyJobs(store: Store): string[] {
	const imported: string[] = [];
	const dir = jobsDir();
	for (const id of readdirSync(dir)) {
		const file = join(dir, id, "meta.json");
		if (!existsSync(file) || store.getJob(id)) continue;
		let meta: Meta;
		try {
			meta = JSON.parse(readFileSync(file, "utf8")) as Meta;
		} catch {
			continue;
		}
		if (meta.id !== id) continue;
		importOne(store, id, meta);
		imported.push(id);
	}
	return imported;
}

function importOne(store: Store, id: string, meta: Meta): void {
	const access = (ACCESS_LEVELS as readonly string[]).includes(String(meta.access))
		? (meta.access as Access)
		: "edit";
	store.createJob(id, {
		title: str(meta.title) ?? "(0.2 job)",
		cwd: str(meta.cwd) ?? "/",
		access,
		model: str(meta.model),
		thinking: str(meta.thinking),
		timeoutS: seconds(meta.timeout),
		answerTimeoutS: seconds(meta.answer_timeout),
		approvalTimeoutS: seconds(meta.approval_timeout),
		addDirs: list(meta.add_dirs),
		files: list(meta.files),
		extraArgs: list(meta.extra_args),
		noPreamble: meta.no_preamble === true,
		parentId: str(meta.parent),
		resumeSession: str(meta.resume_session),
	});
	const status = String(meta.status);
	const finished = isTerminal(status);
	const errors = list(meta.errors);
	if (!finished) errors.push(`omp-task 0.2 job left ${status}; its supervisor is gone`);
	store.updateJob(id, {
		status: (finished ? status : "failed") as JobStatus,
		startedAt: str(meta.started_at),
		finishedAt: str(meta.finished_at) ?? str(meta.created_at),
		durationS: typeof meta.duration_s === "number" ? meta.duration_s : null,
		sessionId: str(meta.session_id),
		modelResolved: str(meta.model_resolved),
		modelUsed: str(meta.model_used),
		stopReason: str(meta.stop_reason),
		costUsd: num(meta.cost_usd),
		tokens: num(meta.tokens),
		tools: counts(meta.tools),
		toolErrors: counts(meta.tool_errors),
		deniedTools: list(meta.denied_tools),
		errors,
		changedFiles: Array.isArray(meta.changed_files) ? list(meta.changed_files) : null,
		exitCode: typeof meta.exit_code === "number" ? meta.exit_code : null,
	});
	const created = str(meta.created_at);
	if (created) store.updateJob(id, { createdAt: created });
	const feedFile = join(jobsDir(), id, "feed.jsonl");
	if (existsSync(feedFile)) {
		for (const line of readFileSync(feedFile, "utf8").split("\n")) {
			try {
				const e = JSON.parse(line) as Meta;
				const kind = str(e.kind);
				if (kind) store.appendFeed(id, kind, String(e.text ?? ""), {}, str(e.ts) ?? undefined);
			} catch {
				// skip a torn line
			}
		}
	}
	store.appendFeed(id, "info", "imported from omp-task 0.2");
}
