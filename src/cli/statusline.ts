/**
 * `omp-task statusline`: Claude Code's `subagentStatusLine` command (hidden, wired in the
 * plugin's settings.json through the shim the SessionStart hook writes).
 *
 * Claude Code runs it about every 5 s while its agent panel shows subagent rows, with the rows as
 * JSON on stdin (`tasks`: id, agentType, status, description, label, ...). It prints one JSON line
 * `{"id","content"}` per row it decorates; `content` replaces that row's label. Rows it prints
 * nothing for keep Claude Code's own rendering, so only the omp job relays are touched: rows of an
 * `omp:job` agent (any plugin's `job` agent, for --plugin-dir copies) whose description starts
 * with `omp <job>:` or `omp group <name>:`.
 *
 * It must be fast and harmless: it never starts the daemon, prints nothing when the daemon is not
 * running or anything fails, and gives up before Claude Code's 5 s limit.
 */
import type { GroupSummary, JobView } from "../api/schema";
import type { Job, Pending } from "../core/types";
import { errorText } from "../core/util";
import { type Client, existingDaemon } from "./client";

export interface StatusTask {
	id: string;
	agentType?: string;
	status?: string;
	description?: string;
	label?: string;
}

export interface StatusInput {
	session_id?: string;
	columns?: number;
	tasks?: StatusTask[];
}

export type RowTarget = { kind: "job"; ref: string } | { kind: "group"; name: string };

/** Description of a relay row: `omp <job>: <title> [<model>]` or `omp group <name>: ...`. */
const JOB_ROW = /^omp ([0-9a-f][\w-]{3,}):/;
const GROUP_ROW = /^omp group ([^\s:]+):/;

/** The job or group a subagent row relays, or null for any other row (left as it is). */
export function rowTarget(task: StatusTask): RowTarget | null {
	if (!task.agentType || !/(^|:)job$/.test(task.agentType)) return null;
	const text = (task.description || task.label || "").trim();
	const group = GROUP_ROW.exec(text);
	if (group?.[1]) return { kind: "group", name: group[1] };
	const job = JOB_ROW.exec(text);
	return job?.[1] ? { kind: "job", ref: job[1] } : null;
}

/** 75s → "1m15s", 3700s → "1h01m". */
export function elapsed(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

function shortModel(job: Job): string {
	const model = job.modelUsed ?? job.modelResolved ?? job.model ?? "default";
	return model.split("/").at(-1) || model;
}

function since(iso: string | null, now: number): number {
	const t = iso ? Date.parse(iso) : Number.NaN;
	return Number.isNaN(t) ? 0 : (now - t) / 1000;
}

function jobElapsed(job: Job, now: number): string {
	if (job.durationS !== null) return elapsed(job.durationS);
	return elapsed(since(job.startedAt ?? job.createdAt, now));
}

/** One pending item, on one line: `approval bash: make test`, `question: Which table?`. */
export function pendingText(p: Pending): string {
	const first =
		p.text
			.trim()
			.split("\n")[0]
			?.replace(/^Command: /, "") ?? "";
	return p.kind === "approval" ? `approval ${p.tool ?? "tool"}: ${first}` : `question: ${first}`;
}

/** What a job waits on, or null when it waits on nothing. */
export function needsText(view: Pick<JobView, "job" | "pending">): string | null {
	const open = view.pending.filter((p) => !p.heldUntil);
	const held = view.pending.filter((p) => p.heldUntil);
	const more = (n: number) => (n > 1 ? ` (+${n - 1})` : "");
	if (open[0]) return `needs: ${pendingText(open[0])}${more(open.length)}`;
	if (held[0]) return `held for user: ${pendingText(held[0])}${more(held.length)}`;
	if (view.job.status === "interrupted") return "needs: resume (the daemon restarted)";
	return null;
}

/** The status part of a job row: state, model, elapsed, cost and what it waits on. */
export function jobStatusText(view: Pick<JobView, "job" | "pending">, now: number): string {
	const { job } = view;
	const parts = [
		`${job.status} ${jobElapsed(job, now)}`,
		shortModel(job),
		`$${job.costUsd.toFixed(4)}`,
	];
	const needs = needsText(view);
	if (needs) parts.push(needs);
	else if (job.status === "blocked" && job.after.length) {
		parts.push(`after ${job.after.map((id) => id.slice(-4)).join(",")}`);
	}
	return parts.join(" · ");
}

/** The status part of a group row: counts per status, cost, the first thing it waits on. */
export function groupStatusText(jobs: Job[], firstWaiting: JobView | null): string {
	const counts = new Map<string, number>();
	for (const j of jobs) counts.set(j.status, (counts.get(j.status) ?? 0) + 1);
	const order = ["waiting", "interrupted", "running", "starting", "queued", "blocked"];
	const keys = [...counts.keys()].sort((a, b) => {
		const [x, y] = [order.indexOf(a), order.indexOf(b)];
		return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || a.localeCompare(b);
	});
	const cost = jobs.reduce((sum, j) => sum + j.costUsd, 0);
	const parts = [keys.map((k) => `${counts.get(k)} ${k}`).join(", "), `$${cost.toFixed(4)}`];
	const needs = firstWaiting && needsText(firstWaiting);
	if (needs) parts.push(`${firstWaiting.job.id.slice(-4)} ${needs}`);
	return parts.join(" · ");
}

/** The row's label without the `[model]` Claude put at its end (the row shows the real model). */
function rowLabel(task: StatusTask): string {
	return (task.description || task.label || "").replace(/\s*\[[^\]]*\]\s*$/, "").trim();
}

/** Cuts a line to the row's width. */
export function fit(line: string, columns: number | undefined): string {
	const flat = line.replace(/\s+/g, " ").trim();
	if (!columns || columns < 10 || flat.length <= columns) return flat;
	return `${flat.slice(0, columns - 1)}…`;
}

async function jobView(client: Client, ref: string, session: string | undefined): Promise<JobView> {
	try {
		return await client.call<JobView>("GET", `/v1/jobs/${encodeURIComponent(ref)}`);
	} catch (e) {
		// A short id several jobs end with: this session's newest one.
		const { jobs } = await client.call<{ jobs: Job[] }>("GET", "/v1/jobs?limit=200");
		const hits = jobs.filter((j) => j.id.endsWith(ref) || j.id.startsWith(ref));
		const job = hits.find((j) => session && j.claudeSession === session) ?? hits[0];
		if (!job) throw e;
		return client.call<JobView>("GET", `/v1/jobs/${encodeURIComponent(job.id)}`);
	}
}

async function rowContent(
	client: Client,
	task: StatusTask,
	target: RowTarget,
	input: StatusInput,
	now: number,
): Promise<string> {
	const session = input.session_id;
	let status: string;
	if (target.kind === "job") {
		status = jobStatusText(await jobView(client, target.ref, session), now);
	} else {
		const summary = await client.call<GroupSummary>(
			"GET",
			`/v1/groups/${encodeURIComponent(target.name)}`,
		);
		// `wait --group` covers this session's jobs only; so does the row, when it can tell.
		const mine = summary.jobs.filter((j) => session && j.claudeSession === session);
		const jobs = mine.length ? mine : summary.jobs;
		const waiting = jobs.find((j) => j.status === "waiting" || j.status === "interrupted");
		const first = waiting ? await jobView(client, waiting.id, session) : null;
		status = groupStatusText(jobs, first);
	}
	return fit(`${rowLabel(task)} · ${status}`, input.columns);
}

/** The JSON lines for the omp rows of `input`; rows it cannot describe are left out. */
export async function statusLines(
	input: StatusInput,
	client: Client,
	now = Date.now(),
): Promise<string[]> {
	const rows = (input.tasks ?? [])
		.map((task) => ({ task, target: rowTarget(task) }))
		.filter((r): r is { task: StatusTask; target: RowTarget } => r.target !== null);
	const lines = await Promise.all(
		rows.map(async ({ task, target }) => {
			try {
				const content = await rowContent(client, task, target, input, now);
				return JSON.stringify({ id: task.id, content });
			} catch {
				return null; // an unknown job (pruned, another state dir): Claude Code's own label
			}
		}),
	);
	return lines.filter((l): l is string => l !== null);
}

/** Claude Code stops the command after 5 s; give up well before that. */
const DEADLINE_MS = 3_000;

/** Entry point of `omp-task statusline`: always exits 0, prints only what it is sure of. */
export async function statuslineMain(): Promise<number> {
	try {
		const raw = await Bun.stdin.text();
		const input = (raw.trim() ? JSON.parse(raw) : {}) as StatusInput;
		if (!(input.tasks ?? []).some((t) => rowTarget(t))) return 0;
		const work = (async () => {
			const daemon = await existingDaemon(); // never start one for a status line
			return daemon ? statusLines(input, daemon.client) : [];
		})();
		const timeout = new Promise<string[]>((r) => setTimeout(() => r([]), DEADLINE_MS).unref());
		for (const line of await Promise.race([work, timeout])) process.stdout.write(`${line}\n`);
	} catch (e) {
		process.stderr.write(`omp-task statusline: ${errorText(e)}\n`);
	}
	return 0;
}
