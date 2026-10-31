/** Text and JSON output of the CLI. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jobDir } from "../core/paths";
import type { FeedEntry, Job, Notice, Pending, ResolvedItem } from "../core/types";
import { isTerminal } from "../core/types";

export const RESULT_CHAR_LIMIT = 12_000;

/** Feed lines worth waking the orchestrator for; a piped `watch` shows only these. */
export const ATTENTION_FEED_KINDS: ReadonlySet<string> = new Set([
	"question",
	"approval",
	"checkpoint",
	"stalled",
	"error",
	"timeout",
	"over_budget",
	"interrupted",
	"done",
]);

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

/** A review job's validated review (result.json), or null. */
function reviewOf(job: Job): unknown {
	const file = join(jobDir(job.id), "result.json");
	return job.review && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export function jobJson(job: Job, pending: Pending[], full = false, shellReads = 0) {
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
		other_changes: job.otherChanges,
		denied_tools: job.deniedTools,
		shell_reads_auto_approved: shellReads,
		errors: job.errors,
		isolate: job.isolate,
		worktree: job.worktreePath,
		branch: job.branch,
		base_ref: job.baseRef,
		group: job.groupName,
		after: job.after,
		after_any_outcome: job.afterAny,
		budget_usd: job.budgetUsd,
		notices: job.notices,
		review_of: job.review,
		claude_session: job.claudeSession,
		review: reviewOf(job),
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
			out(`  decide:  omp-task approve ${jobId} [--same | --rule GLOB | --session | --deny]`);
		}
	}
}

/** One line per pending item, repeated next to `WAKE:` so a long approval does not bury it. */
export function pendingSummary(p: Pending): string {
	const [first = "", ...rest] = p.text.trim().split("\n");
	const head = first.length > 80 ? `${first.slice(0, 79)}…` : first;
	const more = rest.length ? ` (+${rest.length} lines)` : "";
	const what = p.kind === "approval" ? `approval ${p.tool}: ${head}` : `question: ${head}`;
	return `PENDING: ${p.jobId} ${what}${more} (ref ${p.ref})`;
}

/** How an approval was decided, as the `approve` flags that would give the same decision. */
function decisionText(r: ResolvedItem): string {
	if (r.kind === "question") return "answered";
	if (r.by === "rule") return `${r.decision ?? "deny"} by rule ${r.rule ?? "?"}`;
	if (r.rule) return `approve --rule '${r.rule}'`;
	return r.decision === "session"
		? "approve --session"
		: r.decision === "deny"
			? "approve --deny"
			: "approve";
}

/** `RESOLVED:` line of `wait`: an item it reported that someone else settled since. */
export function resolvedSummary(r: ResolvedItem): string {
	return `RESOLVED: ${r.jobId} ${r.ref} by ${r.by} (${decisionText(r)})`;
}

const RESOLVER: Record<ResolvedItem["by"], string> = {
	claude: "the orchestrator",
	user: "the user",
	rule: "a rule",
	expired: "its timeout",
	aborted: "the job's end",
};

/** Why `reply`/`approve` had nothing to do: the item was settled already. */
export function alreadyResolvedText(r: ResolvedItem): string {
	const at = new Date(r.resolvedAt);
	const hhmm = Number.isNaN(at.getTime())
		? r.resolvedAt
		: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	const verb = r.kind === "question" ? "answered" : "decided";
	const how =
		r.kind === "question" && r.answerPreview !== null
			? `answer: ${JSON.stringify(r.answerPreview.length > 60 ? `${r.answerPreview.slice(0, 59)}…` : r.answerPreview)}`
			: decisionText(r);
	return `already ${verb} by ${RESOLVER[r.by]} at ${hhmm} (${how}); nothing to do: re-arm your wait`;
}

const counts = (m: Record<string, number>) =>
	Object.entries(m)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}×${v}`)
		.join(", ");

function printNotices(jobId: string, notices: Notice[]): void {
	for (const n of notices) out(`${n.kind.toUpperCase()}: ${n.text}`);
	if (notices.some((n) => n.kind === "stalled")) {
		out(`  look:   omp-task watch ${jobId} --verbose --last 40`);
		out(`  act:    omp-task steer ${jobId} "<new direction>"   or   omp-task cancel ${jobId}`);
	} else {
		out(`  look:   omp-task status ${jobId}   redirect: omp-task steer ${jobId} "..."`);
	}
	out("  then:   re-run the same `omp-task wait` (same ids or --group) in the background");
}

export function emitJob(
	job: Job,
	pending: Pending[],
	asJson: boolean,
	opts: {
		full?: boolean;
		notices?: Notice[];
		maxResultLines?: number;
		shellReads?: number | undefined;
		/** wait: requests it showed earlier that someone else settled (JSON only). */
		resolved?: ResolvedItem[];
	} = {},
): void {
	const data = jobJson(job, pending, opts.full, opts.shellReads);
	if (asJson) {
		out(
			JSON.stringify(opts.resolved?.length ? { ...data, resolved: opts.resolved } : data, null, 2),
		);
		return;
	}
	out(`## omp job ${job.id} — ${job.status.toUpperCase()}`);
	out(`- title: ${job.title}`);
	out(`- cwd: ${job.cwd}  access: ${job.access}`);
	out(`- files: ${jobDir(job.id)} (prompt, events.jsonl, result)`);
	if (job.worktreePath) {
		out(`- worktree: ${job.worktreePath} (branch ${job.branch ?? "-"})`);
	}
	if (job.groupName || job.after.length) {
		const after = job.after.length
			? `after: ${job.after.join(", ")}${job.afterAny ? " (any outcome)" : ""}`
			: "";
		out(`- ${[job.groupName ? `group: ${job.groupName}` : "", after].filter(Boolean).join("  ")}`);
	}
	if (job.budgetUsd !== null) out(`- budget: $${job.budgetUsd}`);
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
	if (job.otherChanges?.length) {
		out(
			`- not changed by the worker's edit/write tools: ${job.otherChanges.join(", ")}` +
				" (its shell commands, or someone else in this checkout, such as another session:" +
				" check before you revert or delete them)",
		);
	}
	if (job.deniedTools.length) out(`- denied: ${job.deniedTools.join(", ")}`);
	if (opts.shellReads) {
		out(
			`- shell reads auto-approved: ${opts.shellReads} (read-only commands the worker ran in` +
				" bash instead of its read/grep/find tools)",
		);
	}
	for (const e of job.errors) out(`- error: ${e}`);
	if (job.status === "interrupted") {
		out();
		out(`INTERRUPTED: the omp-task daemon stopped while this job ran.`);
		out(
			`  continue it: omp-task resume ${job.id} --detach    or give up: omp-task cancel ${job.id}`,
		);
		return;
	}
	if (pending.length || opts.notices?.length) {
		out();
		printPending(job.id, pending);
		if (opts.notices?.length) printNotices(job.id, opts.notices);
		return;
	}
	if (!isTerminal(job.status)) return; // blocked, queued or running: no report yet
	out();
	let result = data.result || "(no final message)";
	let truncated = data.result_truncated;
	const lines = result.split("\n");
	// A review is the whole point of a review job: never cut it.
	if (opts.maxResultLines && !job.review && lines.length > opts.maxResultLines) {
		result = lines.slice(0, opts.maxResultLines).join("\n");
		truncated = true;
	}
	out(result);
	if (truncated) out(`\n[truncated — full text: omp-task result ${job.id} --full]`);
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
		const other = e.data.other_changes;
		if (Array.isArray(other) && other.length) line += `  not by worker edits: ${other.join(", ")}`;
		line += `  → omp-task result ${e.jobId}`;
	}
	return line;
}
