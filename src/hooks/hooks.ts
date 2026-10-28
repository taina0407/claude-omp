/**
 * Claude Code hooks (`omp-task hook <name>`, wired in hooks/hooks.json). Each reads the hook's
 * JSON from stdin. A hook must never get in Claude's way: any failure is logged to stderr and
 * the hook exits 0 without output.
 *
 *   session-start  remembers the session id for later omp-task calls (CLAUDE_ENV_FILE)
 *   session-end    cancels the session's jobs when `on_session_end` is "cancel"
 *   stop-gate      opt-in: reviews uncommitted changes and blocks the stop on serious findings
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobView, WaitResponse } from "../api/schema";
import { connect, existingDaemon } from "../cli/client";
import { type Config, loadConfig } from "../core/config";
import { jobDir, stateDir } from "../core/paths";
import { isTerminal } from "../core/types";
import { errorText, parseDuration } from "../core/util";
import { renderReview } from "../review/render";
import { type Review, SEVERITIES } from "../review/schema";
import { collectDiff } from "../review/target";

export interface HookInput {
	session_id?: string;
	cwd?: string;
	stop_hook_active?: boolean;
	reason?: string;
}

export interface HookResult {
	stdout?: string;
}

const STOP_GATE_DEFAULTS = { model: "smol", timeout: "3m", maxPerSession: 3 };
/** The gate waits a little longer than the review's own time limit before giving up. */
const STOP_GATE_GRACE_S = 30;

function config(): Config {
	try {
		return loadConfig();
	} catch {
		return {};
	}
}

export async function runHook(name: string, input: HookInput): Promise<HookResult> {
	switch (name) {
		case "session-start":
			return sessionStart(input);
		case "session-end":
			return sessionEnd(input);
		case "stop-gate":
			return stopGate(input);
		default:
			throw new Error(`unknown hook ${name}`);
	}
}

function sessionStart(input: HookInput): HookResult {
	const envFile = process.env.CLAUDE_ENV_FILE;
	const id = input.session_id;
	if (envFile && id && /^[\w-]+$/.test(id)) {
		appendFileSync(envFile, `export OMP_TASK_CLAUDE_SESSION=${id}\n`);
	}
	return {};
}

async function sessionEnd(input: HookInput): Promise<HookResult> {
	const id = input.session_id;
	if (!id || config().on_session_end !== "cancel") return {};
	const daemon = await existingDaemon(); // nothing runs without a daemon; do not start one
	if (!daemon) return {};
	await daemon.client.call("POST", `/v1/sessions/${encodeURIComponent(id)}/end`, { cancel: true });
	return {};
}

interface GateState {
	reviews: number;
	lastDiff: string | null;
}

async function stopGate(input: HookInput): Promise<HookResult> {
	const gate = config().stop_gate;
	if (!gate?.enabled || input.stop_hook_active || !input.cwd) return {};
	let diff: string;
	try {
		diff = collectDiff({ kind: "uncommitted" }, input.cwd).diff;
	} catch {
		return {}; // not a repository, or nothing changed
	}
	// Review each state of the tree once, and only a few times per session.
	const session = (input.session_id ?? "unknown").replace(/[^\w-]/g, "_");
	const dir = join(stateDir(), "stop-gate");
	const file = join(dir, `${session}.json`);
	const state: GateState = existsSync(file)
		? (JSON.parse(readFileSync(file, "utf8")) as GateState)
		: { reviews: 0, lastDiff: null };
	const hash = new Bun.CryptoHasher("sha256").update(diff).digest("hex");
	const max = gate.max_per_session ?? STOP_GATE_DEFAULTS.maxPerSession;
	if (state.lastDiff === hash || state.reviews >= max) return {};
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, JSON.stringify({ reviews: state.reviews + 1, lastDiff: hash }));

	const client = await connect();
	const timeout = String(gate.timeout ?? STOP_GATE_DEFAULTS.timeout);
	const { job } = await client.call<JobView>("POST", "/v1/reviews", {
		target: { kind: "uncommitted" },
		mode: "standard",
		focus: gate.focus ?? null,
		options: {
			clientCwd: input.cwd,
			model: gate.model ?? STOP_GATE_DEFAULTS.model,
			timeout,
			title: "stop gate review",
			...(input.session_id ? { claudeSession: input.session_id } : {}),
		},
	});
	const deadline = performance.now() + ((parseDuration(timeout) ?? 180) + STOP_GATE_GRACE_S) * 1000;
	let status = job.status as string;
	while (!isTerminal(status) && performance.now() < deadline) {
		const q = new URLSearchParams({ ids: job.id, attention: "0", timeout: "25" });
		const res = await client.call<WaitResponse>("GET", `/v1/wait?${q}`);
		status = res.jobs[0]?.job.status ?? status;
	}
	const reviewFile = join(jobDir(job.id), "result.json");
	if (status !== "completed" || !existsSync(reviewFile)) {
		process.stderr.write(`omp stop gate: review ${job.id} ended ${status}; not blocking\n`);
		return {};
	}
	const review = JSON.parse(readFileSync(reviewFile, "utf8")) as Review;
	const limit = SEVERITIES.indexOf(gate.min_severity ?? "high");
	const blocking = review.findings.filter((f) => SEVERITIES.indexOf(f.severity) <= limit);
	if (!blocking.length) return {};
	const shown = renderReview({ ...review, findings: blocking }, "your uncommitted changes");
	const reason = [
		`An omp review of your uncommitted changes found ${blocking.length} issue(s) at ` +
			`${gate.min_severity ?? "high"} severity or above. Fix them, or tell the user why they ` +
			"are not real problems, before you finish.",
		"",
		shown.trim(),
		"",
		`Full review: omp-task result ${job.id}`,
	].join("\n");
	return { stdout: JSON.stringify({ decision: "block", reason }) };
}

/** Entry point of `omp-task hook <name>`: never fails Claude's turn. */
export async function hookMain(name: string | undefined): Promise<number> {
	try {
		if (!name) throw new Error("usage: omp-task hook <session-start|session-end|stop-gate>");
		const raw = await Bun.stdin.text();
		const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
		const res = await runHook(name, input);
		if (res.stdout) process.stdout.write(`${res.stdout}\n`);
	} catch (e) {
		process.stderr.write(`omp-task hook ${name ?? ""}: ${errorText(e)}\n`);
	}
	return 0;
}
