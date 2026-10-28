/** Text and JSON output. Formats and JSON keys match v0.2 so existing skills keep working. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jobDir } from "../core/paths";
import type { FeedEntry, Job, Pending } from "../core/types";

export const RESULT_CHAR_LIMIT = 12_000;

export function out(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function pendingJson(p: Pending) {
	return {
		id: p.ref,
		kind: p.kind,
		text: p.text,
		tool: p.tool,
		options: p.options,
		context: p.context,
		asked_at: p.askedAt,
	};
}

export function jobJson(job: Job, pending: Pending[], full = false) {
	const file = join(jobDir(job.id), "result.md");
	let result = existsSync(file) ? readFileSync(file, "utf8") : "";
	let truncated = false;
	if (!full && result.length > RESULT_CHAR_LIMIT) {
		result = result.slice(0, RESULT_CHAR_LIMIT);
		truncated = true;
	}
	return {
		id: job.id,
		status: job.status,
		title: job.title,
		cwd: job.cwd,
		access: job.access,
		model: job.model,
		model_used: job.modelUsed,
		session_id: job.sessionId,
		parent: job.parentId,
		duration_s: job.durationS,
		cost_usd: job.costUsd,
		tokens: job.tokens,
		tools: job.tools,
		tool_errors: job.toolErrors,
		changed_files: job.changedFiles,
		denied_tools: job.deniedTools,
		errors: job.errors,
		created_at: job.createdAt,
		finished_at: job.finishedAt,
		pending: pending.map(pendingJson),
		result,
		result_truncated: truncated,
		job_dir: jobDir(job.id),
	};
}

export function printPending(jobId: string, pending: Pending[]): void {
	for (const p of pending) {
		if (p.kind === "question") {
			out(`QUESTION from worker (ref ${p.ref}): ${p.text}`);
			if (p.context) out(`  context: ${p.context}`);
			for (const o of p.options) out(`  - option: ${o}`);
			out(`  answer:  omp-task reply ${jobId} "<answer>"`);
		} else {
			out(`APPROVAL needed (ref ${p.ref}): ${p.tool} — ${p.text}`);
			out(`  decide:  omp-task approve ${jobId} [--session | --deny]`);
		}
	}
}

const counts = (m: Record<string, number>) =>
	Object.entries(m)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}×${v}`)
		.join(", ");

export function emitJob(job: Job, pending: Pending[], asJson: boolean, full = false): void {
	const data = jobJson(job, pending, full);
	if (asJson) {
		out(JSON.stringify(data, null, 2));
		return;
	}
	out(`## omp job ${job.id} — ${job.status.toUpperCase()}`);
	out(`- title: ${job.title}`);
	out(`- cwd: ${job.cwd}  access: ${job.access}`);
	const model = job.modelUsed ?? job.modelResolved ?? job.model ?? "(omp default)";
	out(`- model: ${model}  session: ${job.sessionId ?? "-"}`);
	if (job.durationS !== null) {
		out(`- duration: ${job.durationS}s  tokens: ${job.tokens}  cost: $${job.costUsd.toFixed(4)}`);
	}
	if (Object.keys(job.tools).length) out(`- tools: ${counts(job.tools)}`);
	if (Object.keys(job.toolErrors).length) {
		out(`- tool calls that returned an error: ${counts(job.toolErrors)}`);
	}
	if (job.changedFiles !== null) {
		out(`- changed files: ${job.changedFiles.length ? job.changedFiles.join(", ") : "(none)"}`);
	}
	if (job.deniedTools.length) out(`- denied: ${job.deniedTools.join(", ")}`);
	for (const e of job.errors) out(`- error: ${e}`);
	if (pending.length) {
		out();
		printPending(job.id, pending);
		return;
	}
	out();
	out(data.result || "(no final message)");
	if (data.result_truncated) out(`\n[truncated — full text: omp-task result ${job.id} --full]`);
}

export function formatFeed(e: Pick<FeedEntry, "jobId" | "ts" | "kind" | "text" | "data">): string {
	const ts = e.ts.slice(11, 19);
	let line = `${ts} ${e.jobId} ${e.kind.toUpperCase()}: ${e.text}`;
	if (e.kind === "question") {
		const opts = Array.isArray(e.data.options) ? (e.data.options as string[]) : [];
		if (opts.length) line += `  [options: ${opts.join(" | ")}]`;
		line += `  → omp-task reply ${e.jobId} "..."`;
	} else if (e.kind === "approval") {
		line += `  → omp-task approve ${e.jobId} [--session|--deny]`;
	} else if (e.kind === "done") {
		const cf = e.data.changed_files;
		if (Array.isArray(cf)) line += `  changed: ${cf.join(", ") || "(none)"}`;
		line += `  → omp-task result ${e.jobId}`;
	}
	return line;
}
