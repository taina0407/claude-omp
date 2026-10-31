/**
 * The omp plugin's mod: shows the session's omp jobs in Claude Code (a band above the prompt, the
 * `omp-jobs` pane, toasts and notifications) and puts a worker's question or approval to the user
 * in Claude Code's own UI when it is theirs to decide (the `ask_user` tool, or by itself in the
 * `both` and `user` modes). See docs/plans/ui-visibility.md.
 *
 * The mod has no socket: it talks to the daemon through the plugin's own `omp-task` CLI. A
 * `ui-feed` child streams the session's snapshots while it has active jobs and ends with them, so
 * the UI never keeps an idle daemon alive. The token that stream hands over is what lets this
 * UI (and only it) answer as the user; it lives in this module's memory and reaches the CLI
 * through the environment only.
 */
import type { EngineInterface, Register } from "claude-code";
import { atom, read, update } from "claude-code";

import type { OmpDecider, OmpDialog, OmpJob, OmpPending, OmpSnapshot, OmpView } from "../types";
import {
	type AskCallResult,
	type AskPlan,
	paneAnswer,
	planPrompt,
	readAnswer,
	readLabel,
	shortId,
	suggestRule,
} from "./prompt-plan";

type $ = EngineInterface;

const LIST = "omp-jobs";
const DIALOG = "omp-dialog";
const TOOL = "ask_user";

const ACTIVE = new Set(["blocked", "queued", "starting", "running", "waiting"]);
const FAILED = new Set(["failed", "timeout", "over_budget", "interrupted"]);
const DECIDERS: readonly OmpDecider[] = ["claude", "both", "user"];
/** Seconds between `ui-state` checks while no stream is open (jobs started elsewhere). */
const POLL_MS = 60_000;
const RETRY_MS = [5_000, 15_000, 60_000];
/** One `await-ref` slice while a dialog is open: short, so a closed dialog is noticed. */
const SLICE_S = 5;
/** A job that ended longer ago than this when the UI first sees it is not toasted. */
const STALE_END_MS = 120_000;

const view = atom({ plugin: "omp", key: "view" } as const, null, { shape: "view-1" });
const feedState = atom({ plugin: "omp", key: "feedState" } as const, "idle");
const seen = atom({ plugin: "omp", key: "seen" } as const, {});
const dialog = atom({ plugin: "omp", key: "dialog" } as const, null, { shape: "dialog-1" });
const queue = atom({ plugin: "omp", key: "queue" } as const, []);
const bandHidden = atom({ plugin: "omp", key: "bandHidden" } as const, false);
const details = atom({ plugin: "omp", key: "details" } as const, null);
const confirmCancel = atom({ plugin: "omp", key: "confirmCancel" } as const, null);

// ---------------------------------------------------------------- module state (lost on reload)

let sessionId: string | null = null;
/**
 * Whether a person is at this session. A headless one (`claude -p`, the SDK) opens no UI stream:
 * an open stream counts as a connected UI, and in the `user` mode the daemon would then keep the
 * workers' requests from Claude, the only one there to answer them.
 */
let interactive = false;
/** The token of the open `ui-feed`; null while none is open. */
let token: string | null = null;
let feed: AsyncGenerator<unknown, unknown> | null = null;
/** Bumped to orphan a feed loop (a restart, a new session id). */
let feedGen = 0;
let retries = 0;
let retryTimer: { cancel: () => void } | null = null;
/** The last view, for timers (a render reads the state instead). */
let lastView: OmpView | null = null;
/**
 * The open dialog (job, ref, how), kept in module memory: a hook that holds a long dispatch
 * (ask_user) does not see `$.state` writes another dispatch makes (the pane's close), so the
 * logic reads this and only drawing reads the `dialog` state.
 */
let current: OmpDialog | null = null;
/** Questions this mod is asking through `$.ui.ask` → the dialog's raw result once seen. */
const asking = new Map<string, AskCallResult | null>();
/** `job:ref` items an ask_user call is waiting on. */
const awaited = new Set<string>();
/** Whether the open dialog's pane is drawn; false on a narrow terminal until [Review]. */
let dialogPlaced = true;

/** Runs work in the background; a failure there (the module reloading, say) is dropped. */
function bg(work: Promise<unknown>): void {
	work.catch(() => {});
}

// ---------------------------------------------------------------- the CLI

function bin($: $): string {
	return `${$.plugin.root}/bin/omp-task`;
}

async function cli(
	$: $,
	args: string[],
	opts: { asUser?: boolean; timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const init: { env?: Record<string, string>; timeoutMs: number } = {
		timeoutMs: opts.timeoutMs ?? 60_000,
	};
	if (opts.asUser && token) init.env = { OMP_TASK_UI_TOKEN: token };
	try {
		const r = await $.process.run([bin($), ...args], init);
		return { exitCode: r.exitCode, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
	} catch (e) {
		return { exitCode: 1, stdout: "", stderr: (e as Error).message };
	}
}

/** What a failed command said, for the person (its own words). */
function why(r: { stdout: string; stderr: string }): string {
	return (r.stderr || r.stdout || "omp-task failed").split("\n").slice(-3).join(" ");
}

type PendingState =
	| { state: "open" }
	| {
			state: "resolved";
			by: string;
			decision: string | null;
			rule: string | null;
			answerPreview: string | null;
			at: string;
	  }
	| { state: "gone" }
	/** The CLI failed (no such job, an old daemon, ...): its words. */
	| { state: "error"; message: string };

async function pendingState($: $, job: string, ref: string, waitS: number): Promise<PendingState> {
	const r = await cli($, ["await-ref", job, ref, "--max-wait", String(waitS), "--json"], {
		timeoutMs: (waitS + 30) * 1000,
	});
	try {
		return JSON.parse(r.stdout) as PendingState;
	} catch {
		return { state: "error", message: why(r) };
	}
}

// ---------------------------------------------------------------- data channel

function snapshotOf(v: OmpView | null): OmpSnapshot | null {
	return v && v.daemon === "up" ? v : null;
}

/** The jobs the UI shows: active ones, and ended ones for `ui.recent` after they ended. */
function visible(snap: OmpSnapshot): OmpJob[] {
	const cutoff = Date.now() - snap.ui.recentS * 1000;
	return snap.jobs.filter(
		(j) => ACTIVE.has(j.status) || !j.finishedAt || Date.parse(j.finishedAt) >= cutoff,
	);
}

/** One `ui-state`; opens the stream when the session has an active job. */
async function refresh($: $): Promise<void> {
	if (!interactive || !sessionId || feed) return;
	const r = await cli($, ["ui-state", "--session", sessionId, "--json", "--no-start"]);
	let v: OmpView;
	try {
		v = JSON.parse(r.stdout) as OmpView;
	} catch {
		await update($, feedState, () => "error");
		return;
	}
	await onView($, v);
	if (v.daemon === "down") await update($, feedState, () => "down");
	else if (v.daemon === "outdated") await update($, feedState, () => "outdated");
	else if (v.jobs.some((j) => ACTIVE.has(j.status))) startFeed($);
	else await update($, feedState, () => "idle");
}

function stopFeed(): void {
	feedGen++;
	token = null;
	retryTimer?.cancel();
	retryTimer = null;
	const f = feed;
	feed = null;
	void f?.return(undefined).catch(() => {});
}

function startFeed($: $): void {
	if (!interactive || feed || !sessionId) return;
	retryTimer?.cancel();
	retryTimer = null;
	const gen = ++feedGen;
	const stream = $.process.spawn({
		argv: [bin($), "ui-feed", "--session", sessionId, "--json-lines", "--no-start"],
	});
	feed = stream;
	bg(
		(async () => {
			let buf = "";
			let ended = false;
			try {
				for await (const chunk of stream) {
					if (gen !== feedGen) return;
					if (chunk.stream !== "stdout") continue;
					buf += chunk.text;
					let nl = buf.indexOf("\n");
					while (nl >= 0) {
						const line = buf.slice(0, nl).trim();
						buf = buf.slice(nl + 1);
						nl = buf.indexOf("\n");
						if (!line) continue;
						const msg = JSON.parse(line) as Record<string, unknown>;
						if (typeof msg.token === "string") {
							token = msg.token;
						} else if (msg.end === true) {
							ended = true;
						} else if (msg.daemon === "down" || msg.daemon === "outdated") {
							ended = true;
							await onView($, msg as OmpView);
							await update($, feedState, () => msg.daemon as "down" | "outdated");
						} else if (msg.daemon === "up") {
							retries = 0;
							await update($, feedState, () => "live");
							await onView($, msg as OmpSnapshot);
						}
					}
				}
			} catch {
				// the child could not start or died; handled below
			}
			if (gen !== feedGen) return;
			feed = null;
			token = null;
			if (ended) {
				const state = await read($, feedState);
				if (state === "live") await update($, feedState, () => "idle");
				return;
			}
			await update($, feedState, () => "error");
			const delay = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)] as number;
			retries++;
			retryTimer = $.clock.after(delay, () => {
				retryTimer = null;
				if (gen === feedGen) bg(refresh($));
			});
		})(),
	);
}

/** Starts over when the session's id changed (/clear, resume). */
async function checkSession($: $): Promise<void> {
	if (!sessionId) return;
	const id = await $.session.id();
	if (id && id !== sessionId) await boot($, id);
}

/** A new session id (startup, /clear, resume): forget the old session's UI and start over. */
async function boot($: $, id: string): Promise<void> {
	if (id === sessionId) return;
	stopFeed();
	sessionId = id;
	retries = 0;
	await update($, view, () => null);
	current = null;
	await update($, dialog, () => null);
	await update($, queue, () => []);
	await update($, details, () => null);
	await update($, confirmCancel, () => null);
	void $.ui.close({ id: DIALOG }).catch(() => {});
	await refresh($);
}

// ---------------------------------------------------------------- reacting to snapshots

/** The key `seen` keeps for an open item. */
function itemMark(job: string, p: OmpPending): string {
	return `${job}:${p.ref}:${p.askedAt}`;
}

/** Notes that the UI put this item to the user, so it is not opened by itself again. */
async function markOffered($: $, job: OmpJob, item: OmpPending): Promise<void> {
	const key = `offered:${itemMark(job.id, item)}`;
	await update($, seen, (m) => (m[key] ? m : { ...m, [key]: "1" }));
}

function findItem(
	v: OmpView | null,
	job: string,
	ref: string,
): { job: OmpJob; item: OmpPending } | null {
	const snap = snapshotOf(v);
	const j = snap?.jobs.find((x) => x.id === job || x.id.startsWith(job));
	const item = j?.pending.find((p) => p.ref === ref);
	return j && item ? { job: j, item } : null;
}

async function onView($: $, v: OmpView): Promise<void> {
	lastView = v;
	await update($, view, () => v);
	const snap = snapshotOf(v);
	if (!snap) return;
	const marks = await read($, seen);
	const fresh: Record<string, string> = {};
	const newItems: string[] = [];
	for (const j of snap.jobs) {
		const statusKey = `${j.id}:status`;
		if (!ACTIVE.has(j.status) && marks[statusKey] !== j.status) {
			fresh[statusKey] = j.status;
			// A job that ended long before this UI saw it (a resumed session) gets no toast.
			const endedAt = j.finishedAt ? Date.parse(j.finishedAt) : Date.now();
			if (Date.now() - endedAt < STALE_END_MS) jobEnded($, snap, j);
		}
		for (const p of j.pending) {
			// askedAt too: a resumed job's omp may use the same ref again.
			const mark = itemMark(j.id, p);
			if (marks[mark]) continue;
			fresh[mark] = p.kind;
			newItems.push(mark);
		}
	}
	if (Object.keys(fresh).length) await update($, seen, (m) => ({ ...m, ...fresh }));
	if (newItems.length) await update($, bandHidden, () => false);
	const open = new Set(snap.jobs.flatMap((j) => j.pending.map((p) => `${j.id}:${p.ref}`)));
	await update($, queue, (q) => q.filter((k) => open.has(k)));
	if (snap.decider !== "claude") {
		// Every open item the UI has not put to the user yet, including those that were open
		// before the session switched to `both` or `user` (the daemon then hides them from Claude).
		const all = await read($, seen);
		const cur = current;
		const due = snap.jobs.flatMap((j) =>
			j.pending
				.filter((p) => !all[`offered:${itemMark(j.id, p)}`] && !same(cur, j.id, p.ref))
				.map((p) => `${j.id}:${p.ref}`),
		);
		if (due.length) await update($, queue, (q) => [...q, ...due.filter((k) => !q.includes(k))]);
	}
	// A dialog for an item settled elsewhere closes (the pane), or at least frees the slot (the
	// engine's dialog, whose late answer then sends nothing); the next one opens.
	const d = current;
	if (d && !open.has(`${d.job}:${d.ref}`)) await closeDialog($, d);
	await pump($);
}

function jobEnded($: $, snap: OmpSnapshot, j: OmpJob): void {
	const name = `${shortId(j.id)}${j.title ? ` ${j.title}` : ""}`;
	if (j.status === "completed") {
		$.ui.toast(`✓ ${name} completed${cost(j)}`);
	} else if (FAILED.has(j.status)) {
		$.ui.toast(`✗ ${name} ${j.status}${cost(j)}`);
		notify($, snap, `job ${name} ${j.status}`);
	}
}

function notify($: $, snap: OmpSnapshot | null, text: string): void {
	if (snap && !snap.ui.notify) return;
	void $.ui.notify(text, { title: "omp" }).catch(() => {});
}

// ---------------------------------------------------------------- dialogs

function same(d: OmpDialog | null, job: string, ref: string): boolean {
	return !!d && d.job === job && d.ref === ref;
}

async function closeDialog($: $, d: OmpDialog): Promise<void> {
	if (!same(current, d.job, d.ref)) return;
	current = null;
	await update($, dialog, (cur) => (same(cur, d.job, d.ref) ? null : cur));
	if (d.via === "pane") {
		dialogPlaced = true;
		await $.ui.close({ id: DIALOG }).catch(() => {});
	}
}

/** Opens the next queued item when no dialog is open (the `both` and `user` modes). */
async function pump($: $): Promise<void> {
	if (current) return;
	const q = await read($, queue);
	const v = await read($, view);
	for (const key of q) {
		const [job, ...rest] = key.split(":");
		const ref = rest.join(":");
		await update($, queue, (all) => all.filter((k) => k !== key));
		if (!job || !findItem(v, job, ref)) continue;
		bg(present($, job, ref, { note: null, wait: false, fromUser: false }));
		return;
	}
}

/** Waits (outside the hook's budget: through the CLI) until no other dialog is open. */
/**
 * Waits for the dialog slot. `turn`: free (or already this request's); otherwise how this request
 * was settled while it waited (it then has nothing to show), or `aborted`.
 */
async function waitTurn(
	$: $,
	job: string,
	ref: string,
	signal?: AbortSignal,
): Promise<"turn" | "aborted" | Exclude<PendingState, { state: "open" }>> {
	while (!signal?.aborted) {
		const d = current;
		if (!d || same(d, job, ref)) return "turn";
		// Blocks only while the other dialog's request is still open.
		const other = await pendingState($, d.job, d.ref, 3);
		if (other.state !== "open") await closeDialog($, d); // settled elsewhere: free the slot
		const mine = await pendingState($, job, ref, 0);
		if (mine.state !== "open") return mine;
	}
	return "aborted";
}

function describe(st: PendingState, job: string, mine: boolean): string {
	// Claude reads this and runs commands with the id: the full one.
	const id = job;
	if (st.state === "gone") {
		return `gone: job ${id} ended or the worker withdrew the request; nothing to answer.`;
	}
	if (st.state === "open") return "open";
	if (st.state === "error") return `error: ${st.message}`;
	const at = hhmm(st.at);
	const what = st.decision
		? `${st.decision === "approve" ? "approve" : st.decision === "session" ? "approve --session" : "deny"}${st.rule ? ` --rule '${st.rule}'` : ""}`
		: st.answerPreview !== null
			? `answer: "${st.answerPreview}"`
			: "answered";
	if (st.by === "aborted") return `gone: job ${id} ended before anyone answered.`;
	if (st.by === "expired") {
		return `expired: nobody answered in time (job ${id}); omp continued without the answer or denied the request.`;
	}
	if (st.by === "user" && mine) return `answered by user: ${what} (job ${id}). Re-arm your wait.`;
	return `already_resolved: settled by ${st.by} at ${at} (${what}). Re-arm your wait.`;
}

interface PresentOptions {
	/** The one line Claude passed to ask_user. */
	note: string | null;
	/** ask_user: hold until the item is settled or the dialog closed. Otherwise return once shown. */
	wait: boolean;
	/** The person asked for it ([Review]): no notification, and the pane is placed at any width. */
	fromUser: boolean;
	signal?: AbortSignal;
}

/**
 * Puts one item to the user and resolves with one line for Claude: a question through the
 * engine's dialog (2-4 options) or the pane, an approval always through the pane.
 */
async function present($: $, jobRef: string, ref: string, o: PresentOptions): Promise<string> {
	const { note, signal } = o;
	let found = findItem(await read($, view), jobRef, ref);
	if (!found) {
		const st = await pendingState($, jobRef, ref, 0);
		if (st.state !== "open") return describe(st, jobRef, false);
		await refresh($);
		found = findItem(await read($, view), jobRef, ref);
		if (!found) return `gone: no open request ${ref} in job ${jobRef} of this session.`;
	}
	const { job, item } = found;
	while (!same(current, job.id, ref)) {
		const turn = await waitTurn($, job.id, ref, signal);
		if (turn === "aborted") return dismissed(job.id);
		if (turn !== "turn") return describe(turn, job.id, false);
		const st = await pendingState($, job.id, ref, 0);
		if (st.state !== "open") return describe(st, job.id, false);
		const plan = planPrompt(item, job.id, note ?? undefined);
		const d: OmpDialog = {
			job: job.id,
			ref,
			via: plan.ui === "ask" ? "ask" : "pane",
			note,
			error: null,
			rule: null,
			message: null,
		};
		// Another dialog may have opened while the CLI ran: then wait for that one too.
		const got = await claim($, d);
		if (got === "taken") break;
		if (got === "busy") continue;
		await markOffered($, job, item);
		await update($, queue, (q) => q.filter((k) => k !== `${job.id}:${ref}`));
		if (plan.ui === "ask") {
			if (!o.fromUser) {
				const what = item.kind === "approval" ? "needs an approval" : "asks";
				notify(
					$,
					snapshotOf(await read($, view)),
					`job ${shortId(job.id)} ${what}: ${cut(item.text, 120)}`,
				);
			}
			return askInDialog($, d, plan, o.wait, signal);
		}
		await openDialogPane($, o.fromUser);
		break;
	}
	return o.wait ? awaitDialog($, job.id, ref, signal) : "shown";
}

/** Makes `d` the open dialog unless another one is open; whether it did. */
/**
 * Makes `d` the open dialog if no dialog is open: `acquired`. `taken`: another caller already
 * shows this same request (join its wait, never open a second dialog); `busy`: another request.
 */
async function claim($: $, d: OmpDialog): Promise<"acquired" | "taken" | "busy"> {
	if (current) return same(current, d.job, d.ref) ? "taken" : "busy";
	current = d;
	await update($, dialog, () => d);
	return "acquired";
}

function dismissed(job: string, why = "the user closed the dialog"): string {
	return `dismissed: ${why}; request in job ${job} is still pending. Decide it yourself or leave it.`;
}

/** Asks a question through the engine's dialog (`d`, already claimed) and sends the answer. */
async function askInDialog(
	$: $,
	d: OmpDialog,
	plan: AskPlan,
	forClaude: boolean,
	signal?: AbortSignal,
): Promise<string> {
	asking.set(plan.question, null);
	try {
		let answer: string | null = null;
		let refused: string | null = null;
		try {
			answer = await $.ui.ask(plan.question, { options: plan.labels, header: plan.header });
		} catch (e) {
			refused = (e as Error).message || "dismissed";
		}
		if (signal?.aborted) return dismissed(d.job);
		// The dialog's own result, when our AskUserQuestion hook saw it: it alone tells an answer the
		// user gave from one the dialog gave by itself while they were away.
		const raw = asking.get(plan.question) ?? null;
		const outcome = raw
			? readAnswer(plan, raw)
			: answer !== null
				? readLabel(plan, answer)
				: ({ kind: "dismissed", reason: `the dialog closed (${refused})` } as const);
		if (outcome.kind === "dismissed") {
			return dismissed(d.job, outcome.reason);
		}
		return await sendReply($, d.job, d.ref, outcome.value, forClaude);
	} finally {
		asking.delete(plan.question);
		await closeDialog($, d);
		bg(pump($));
	}
}

/** Sends the user's answer, unless the item was settled meanwhile (then says by whom). */
/** `quiet`: Claude learns the outcome from ask_user, so `wait` must not report it again. */
async function sendReply(
	$: $,
	job: string,
	ref: string,
	value: string,
	quiet: boolean,
): Promise<string> {
	const st = await pendingState($, job, ref, 0);
	if (st.state !== "open") return describe(st, job, false);
	await ensureToken($, job, ref);
	const r = await cli($, replyArgs(job, ref, value, quiet), { asUser: true });
	if (r.exitCode === 0) {
		return `answered by user: "${value.slice(0, 200)}" (job ${job}). Re-arm your wait.`;
	}
	if (r.stdout.startsWith("already ")) return `already_resolved: ${r.stdout}`;
	return `error: ${why(r)}`;
}

/** Holds until the item is settled or its pane dialog closed (checked every few seconds). */
async function awaitDialog($: $, job: string, ref: string, signal?: AbortSignal): Promise<string> {
	const key = `${job}:${ref}`;
	awaited.add(key);
	try {
		return await holdDialog($, job, ref, signal);
	} finally {
		awaited.delete(key);
	}
}

async function holdDialog($: $, job: string, ref: string, signal?: AbortSignal): Promise<string> {
	while (true) {
		if (signal?.aborted) {
			const d = current;
			if (same(d, job, ref) && d) await closeDialog($, d);
			bg(pump($));
			return dismissed(job);
		}
		const st = await pendingState($, job, ref, SLICE_S);
		if (st.state !== "open") return describe(st, job, true);
		if (!same(current, job, ref)) {
			const last = await pendingState($, job, ref, 0);
			return last.state === "open" ? dismissed(job) : describe(last, job, true);
		}
	}
}

async function openDialogPane($: $, asked: boolean): Promise<void> {
	const d = current;
	if (d?.via !== "pane") return;
	const found = findItem(await read($, view), d.job, d.ref);
	const title = found?.item.kind === "approval" ? "omp approval" : "omp question";
	const opened = await $.ui
		.open({ id: DIALOG, title, focus: true, closeOnEscape: true, holdToasts: true })
		.catch(() => ({ isPlaced: false as const }));
	dialogPlaced = opened.isPlaced;
	$.ui.invalidate("ui.render");
	if (asked) return;
	const kind = found?.item.kind === "approval" ? "needs an approval" : "asks";
	const text = opened.isPlaced
		? `job ${shortId(d.job)} ${kind}: ${cut(found?.item.text ?? "", 120)}`
		: `job ${shortId(d.job)} ${kind}: press [Review] above the prompt`;
	notify($, snapshotOf(await read($, view)), text);
}

/** A token arrives with the stream: make sure one is open before answering as the user. */
async function ensureToken($: $, job: string, ref: string): Promise<void> {
	if (token) return;
	if (!feed) startFeed($);
	for (let i = 0; i < 10 && !token; i++) await pendingState($, job, ref, 1);
}

/** Runs a reply/approve/steer as the user from the dialog; a refusal stays on the dialog. */
async function answerAsUser($: $, d: OmpDialog, args: string[], then?: string[]): Promise<void> {
	await ensureToken($, d.job, d.ref);
	const r = await cli($, args, { asUser: true });
	if (r.exitCode !== 0 && !r.stdout.startsWith("already ")) {
		await update($, dialog, (cur) =>
			same(cur, d.job, d.ref) && cur ? { ...cur, error: why(r) } : cur,
		);
		return;
	}
	if (then && r.exitCode === 0) {
		const s = await cli($, then);
		if (s.exitCode !== 0) $.ui.toast(`steer failed: ${why(s)}`);
	}
	await closeDialog($, d);
	await pump($);
}

/** Whether an ask_user call waits on this item (it then tells Claude the outcome itself). */
function quiet(job: string, ref: string): boolean {
	return awaited.has(`${job}:${ref}`);
}

function approveArgs(d: OmpDialog, extra: string[]): string[] {
	const q = quiet(d.job, d.ref) ? ["--quiet"] : [];
	return ["approve", "--ref", d.ref, "--by", "user", ...q, ...extra, "--", d.job];
}

/** `--` first: an answer may start with "-" and must not be read as a flag. */
function replyArgs(job: string, ref: string, value: string, isQuiet: boolean): string[] {
	const q = isQuiet ? ["--quiet"] : [];
	return ["reply", "--ref", ref, "--by", "user", ...q, "--", job, value];
}

// ---------------------------------------------------------------- formatting

function cost(j: OmpJob): string {
	return j.costUsd > 0 ? ` ($${j.costUsd.toFixed(2)})` : "";
}

function hhmm(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? iso
		: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function span(s: number): string {
	const t = Math.max(0, Math.round(s));
	if (t < 60) return `${t}s`;
	if (t < 3600) return `${Math.floor(t / 60)}m${String(t % 60).padStart(2, "0")}s`;
	return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m`;
}

function elapsed(j: OmpJob): string {
	if (j.durationS !== null) return span(j.durationS);
	if (!j.startedAt) return "";
	return span((Date.now() - Date.parse(j.startedAt)) / 1000);
}

function ago(iso: string): string {
	return `${span((Date.now() - Date.parse(iso)) / 1000)} ago`;
}

function icon(status: string): string {
	if (status === "running" || status === "starting") return "●";
	if (status === "queued" || status === "blocked") return "◌";
	if (status === "waiting") return "?";
	if (status === "completed") return "✓";
	if (status === "interrupted") return "!";
	return "✗";
}

function cut(text: string, n: number): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, Math.max(1, n - 1))}…` : one;
}

/** Whether the band should flag an item for the user rather than for Claude. */
function forUser(snap: OmpSnapshot, d: OmpDialog | null): boolean {
	return snap.decider !== "claude" || (!!d && d.via === "pane");
}

// ---------------------------------------------------------------- register

export const register: Register = (on) => {
	on("session.start", async ($, e, next) => {
		const started = await next(e);
		interactive = e.isInteractive;
		await $.command.register({
			name: "omp-jobs",
			description: "Show this session's omp jobs in a pane",
			// Runs while Claude's turn is busy (ask_user holds it until the user answers).
			immediate: true,
		});
		await $.command.register({
			name: "omp-mode",
			description: "Who decides omp workers' questions here: claude, both, user, or default",
			argumentHint: "[claude|both|user|default]",
			immediate: true,
		});
		if (e.isInteractive) {
			await $.tool.register({
				name: TOOL,
				description:
					"Put one pending question or approval of an omp worker to the user in Claude Code's own UI " +
					"(a question dialog, or the approval pane) and wait for the outcome. Use it only when the " +
					"decision belongs to the user; pass `job` and `ref` from the PENDING: line of `omp-task wait`, " +
					"and optionally a one-line `note` for the user. Never build an AskUserQuestion for a worker's " +
					"question yourself. Call it BEFORE re-arming your wait. It returns one line: `answered by user: " +
					"...` or `already_resolved: ...` (re-arm your wait), `dismissed: ...` (decide yourself or leave " +
					"it), `expired: ...`, or `gone: ...`.",
				inputSchema: {
					type: "object",
					properties: {
						job: { type: "string", description: "The job id (from PENDING:)." },
						ref: { type: "string", description: "The request's ref (from PENDING:)." },
						note: {
							type: "string",
							description: "Optional: one line for the user to read with it.",
						},
					},
					required: ["job", "ref"],
				},
				isDeferred: false,
			});
		}
		await boot($, await $.session.id());
		$.clock.every(POLL_MS, () => {
			bg(
				(async () => {
					await checkSession($);
					if (!feed && !retryTimer) await refresh($);
				})(),
			);
		});
		// Durations, "last: ... ago" and the `recent` window move with the clock.
		$.clock.every(5_000, () => {
			if (snapshotOf(lastView)?.jobs.length) $.ui.invalidate("ui.render");
			// A dialog pane that waited unplaced (narrow terminal) may be drawn now: drop [Review].
			if (current?.via === "pane" && !dialogPlaced) {
				bg(
					$.ui.panes().then((panes) => {
						if (panes.some((p) => p.id === DIALOG && p.isPlaced)) {
							dialogPlaced = true;
							$.ui.invalidate("ui.render");
						}
					}),
				);
			}
		});
		return started;
	});

	// /clear and resume start a new session id; the engine raises no session.start for them.
	// /clear raises session.end and no session.start; the next id shows a moment later.
	on("session.end", async ($, e, next) => {
		const r = await next(e);
		if (e.reason === "clear") {
			stopFeed();
			$.clock.after(1_000, () => bg(checkSession($)));
		}
		return r;
	}).catch((_$, e, next) => next(e));

	on("prompt.submit", async ($, e, next) => {
		bg(checkSession($));
		return next(e);
	}).catch((_$, e, next) => next(e));

	// The classic SessionStart hook carries the new id at once (when no plugin above skips it).
	on("classic.SessionStart", async ($, e, next) => {
		const r = await next(e);
		const id =
			typeof e.session_id === "string" && e.session_id ? e.session_id : await $.session.id();
		await boot($, id);
		return r;
	}).catch((_$, e, next) => next(e));

	// `$.ui.ask` runs AskUserQuestion through this plugin's other hooks: keep the dialog's own result
	// for a question this mod asked (the answer `$.ui.ask` resolves to cannot tell an AFK answer).
	on("tool.call", { tool: "AskUserQuestion" }, async (_$, e, next) => {
		const ran = await next(e);
		const q = (e as unknown as { questions?: { question?: unknown }[] }).questions?.[0]?.question;
		if (typeof q === "string" && asking.has(q)) asking.set(q, ran as AskCallResult);
		return ran;
	}).catch((_$, e, next) => next(e));

	// A job Claude just started (or answered) shows at once.
	on("tool.call", { tool: "Bash" }, async ($, e, next) => {
		const ran = await next(e);
		// Awaited (one short `ui-state`), so the band shows the new job as the call returns.
		if (e.command.includes("omp-task")) await refresh($).catch(() => {});
		return ran;
	}).catch((_$, e, next) => next(e));

	on("tool.call", { tool: "mcp__omp__ask_user" }, async ($, e, next) => {
		const input = e as unknown as { job?: unknown; ref?: unknown; note?: unknown };
		if (typeof input.job !== "string" || typeof input.ref !== "string") {
			return { result: "error: ask_user needs the job id and the ref from a PENDING: line." };
		}
		const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
		if (!feed) await refresh($);
		const text = await present($, input.job, input.ref, {
			note,
			wait: true,
			fromUser: false,
			signal: next.signal,
		});
		return { result: text };
	}).catch(() => ({ result: "error: the omp UI failed; decide the request yourself." }));

	on("command.run", { command: "omp-jobs" }, async ($) => {
		await update($, details, () => null);
		if (!feed) await refresh($);
		await $.ui.open({ id: LIST, title: "omp jobs" });
		const d = current;
		if (d?.via === "pane" && !dialogPlaced) await openDialogPane($, true);
		const snap = snapshotOf(await read($, view));
		const jobs = snap ? visible(snap) : [];
		const by = new Map<string, number>();
		for (const j of jobs) by.set(j.status, (by.get(j.status) ?? 0) + 1);
		const summary = jobs.length
			? `${jobs.length} job(s): ${[...by].map(([st, n]) => `${n} ${st}`).join(", ")}`
			: snap
				? "no jobs in this session"
				: "no omp daemon running";
		return { text: `jobs pane opened (${summary}).` };
	});

	on("command.run", { command: "omp-mode" }, async ($, e) => {
		const arg = e.args.trim();
		const v = await read($, view);
		const snap = snapshotOf(v);
		if (!arg) {
			const now = snap
				? `${snap.decider} (${snap.deciderSource})`
				: v
					? `${v.ui.decider} (config; no omp daemon running)`
					: "unknown";
			return { text: `decider: ${now}. Use /omp-mode claude|both|user|default.` };
		}
		return { text: await setMode($, arg) };
	});

	on("ui.close", { id: DIALOG }, async ($, e, next) => {
		const closed = await next(e);
		if (e.origin.kind === "person") {
			// Esc or the close mark: the request stays open for Claude (or a later [Review]).
			const d = current;
			if (d?.via === "pane") await closeDialog($, d);
			bg(pump($));
		}
		return closed;
	}).catch((_$, e, next) => next(e));

	// ---- the band above the prompt

	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		if (e.props.hasSurvey) return next(e);
		const v = await read($, view);
		if (!v) return next(e);
		const settings = v.ui;
		if (settings.band === "off") return next(e);
		const { Box, Button, Text } = $.ui.resolve(e);
		if (v.daemon === "outdated") {
			return (
				<Box>
					<Text dimColor>omp: daemon {v.version} busy; live view resumes after its jobs end</Text>
				</Box>
			);
		}
		const snap = snapshotOf(v);
		const jobs = snap ? visible(snap) : [];
		if (!jobs.length && settings.band !== "always") return next(e);
		const d = await read($, dialog);
		const items = jobs.flatMap((j) => j.pending);
		const hidden = await read($, bandHidden);
		if (hidden && !items.length) return next(e);
		const count = (s: string[]) => jobs.filter((j) => s.includes(j.status)).length;
		const running = count(["running", "starting", "waiting"]);
		const queued = count(["queued", "blocked"]);
		const failed = jobs.filter((j) => FAILED.has(j.status)).length;
		const total = jobs.reduce((s, j) => s + j.costUsd, 0);
		const userItems = snap ? forUser(snap, d) : false;
		const parts: string[] = [];
		if (running) parts.push(`${running} running`);
		if (queued) parts.push(`${queued} queued`);
		if (!running && !queued && jobs.length) parts.push(`${jobs.length} done`);
		if (failed) parts.push(`${failed} failed`);
		if (!snap) parts.push("daemon not running");
		const needs = items.length
			? userItems
				? `⚠ ${items.length} needs you`
				: `${items.length} waiting on Claude`
			: "";
		const color = failed ? "error" : items.length && userItems ? "warning" : undefined;
		const review = d?.via === "pane" && !dialogPlaced;
		return (
			<Box flexDirection="row" gap={1}>
				<Text color={color} wrap="truncate-end">
					omp ▸ {parts.join(" · ")}
					{needs ? ` · ${needs}` : ""}
					{total > 0 ? ` · $${total.toFixed(2)}` : ""}
					{review ? ` · ⚠ ${d ? shortId(d.job) : ""}` : ""}
				</Text>
				{review && (
					<Button
						key="review"
						label="Review"
						variant="primary"
						onPress={async () => {
							await openDialogPane($, true);
						}}
					/>
				)}
				<Button
					key="jobs"
					label="Jobs"
					onPress={async () => {
						await $.ui.open({ id: LIST, title: "omp jobs" });
					}}
				/>
				<Button key="hide" label="Hide" onPress={() => update($, bandHidden, () => true)} />
			</Box>
		);
	});

	// ---- the jobs pane

	on("ui.render", { component: "Pane", requestId: LIST }, async ($, e) => {
		const { Box, Button, Text } = $.ui.resolve(e);
		const v = await read($, view);
		const state = await read($, feedState);
		const shown = await read($, details);
		const width = e.props.bodyColumns;
		if (shown) {
			return (
				<Box flexDirection="column">
					<Box flexDirection="row" gap={1}>
						<Text bold>Job {shortId(shown.job)}</Text>
						<Button key="back" label="Back" onPress={() => update($, details, () => null)} />
					</Box>
					<Text>{shown.text}</Text>
				</Box>
			);
		}
		const snap = snapshotOf(v);
		const d = await read($, dialog);
		const pendingCancel = await read($, confirmCancel);
		if (!snap) {
			const why =
				v?.daemon === "outdated"
					? `daemon ${v.version} busy; live view resumes after its jobs end`
					: "no omp daemon running; no jobs in this session";
			return <Text dimColor>{why}</Text>;
		}
		return (
			<Box flexDirection="column">
				{visible(snap).length === 0 && <Text dimColor>No omp jobs in this session.</Text>}
				{visible(snap).map((j) => (
					<Box key={`job-${j.id}`} flexDirection="column" marginBottom={1}>
						<Text wrap="truncate-end">
							<Text
								color={
									FAILED.has(j.status) || j.status === "cancelled"
										? "error"
										: j.status === "completed"
											? "success"
											: j.status === "waiting"
												? "warning"
												: undefined
								}
							>
								{icon(j.status)}
							</Text>{" "}
							<Text bold>{shortId(j.id)}</Text>{" "}
							{cut(j.title ?? "(untitled)", Math.max(12, width - 60))}{" "}
							<Text dimColor>
								{j.status} · {j.model ?? "?"} · {j.access}
								{j.worktreePath ? " · worktree" : ""} · {elapsed(j)}
								{j.costUsd > 0 ? ` · $${j.costUsd.toFixed(2)}` : ""}
							</Text>
						</Text>
						{j.queueReason && <Text dimColor> └ queued: {cut(j.queueReason, width - 12)}</Text>}
						{j.lastActivity && (
							<Text dimColor wrap="truncate-end">
								└ last: {cut(j.lastActivity.text, width - 20)} ({ago(j.lastActivity.ts)})
							</Text>
						)}
						{j.pending.map((p) => (
							<Box key={`p-${j.id}-${p.ref}`} flexDirection="row" gap={1}>
								<Text color="warning" wrap="truncate-end">
									⚠ {p.kind} {p.tool ? `${p.tool}: ` : ""}
									{cut(p.text, Math.max(10, width - 30))}
								</Text>
								<Button
									key={`review-${j.id}-${p.ref}`}
									label={same(d, j.id, p.ref) ? "Open" : "Review"}
									onPress={async () => {
										const cur = current;
										if (same(cur, j.id, p.ref)) {
											await openDialogPane($, true);
										} else if (cur) {
											const key = `${j.id}:${p.ref}`;
											await update($, queue, (q) => [key, ...q.filter((k) => k !== key)]);
											$.ui.toast("another request is open; this one is next");
										} else {
											await present($, j.id, p.ref, { note: null, wait: false, fromUser: true });
										}
									}}
								/>
							</Box>
						))}
						<Box flexDirection="row" gap={1}>
							<Text> </Text>
							{ACTIVE.has(j.status) || j.status === "interrupted" ? (
								pendingCancel === j.id ? (
									<>
										<Text color="error">Cancel job {shortId(j.id)}?</Text>
										<Button
											key={`cancel-yes-${j.id}`}
											label="Yes, cancel"
											onPress={async () => {
												await update($, confirmCancel, () => null);
												const r = await cli($, ["cancel", j.id]);
												$.ui.toast(r.exitCode === 0 ? r.stdout : why(r));
												bg(refresh($));
											}}
										/>
										<Button
											key={`cancel-no-${j.id}`}
											label="Keep"
											onPress={() => update($, confirmCancel, () => null)}
										/>
									</>
								) : (
									<Button
										key={`cancel-${j.id}`}
										label="Cancel"
										onPress={() => update($, confirmCancel, () => j.id)}
									/>
								)
							) : null}
							<Button
								key={`details-${j.id}`}
								label="Details"
								onPress={async () => {
									const r = await cli($, ["status", j.id]);
									await update($, details, () => ({
										job: j.id,
										text: r.exitCode === 0 ? r.stdout : why(r),
									}));
								}}
							/>
						</Box>
					</Box>
				))}
				<Box flexDirection="row" gap={1}>
					<Text dimColor>
						decider: {snap.decider} ({snap.deciderSource}) · feed {state}
					</Text>
					{DECIDERS.filter((m) => m !== snap.decider).map((m) => (
						<Button
							key={`mode-${m}`}
							label={m}
							plain
							dimColor
							onPress={async () => $.ui.toast(await setMode($, m))}
						/>
					))}
					{snap.deciderSource === "session" && (
						<Button
							key="mode-default"
							label="default"
							plain
							dimColor
							onPress={async () => $.ui.toast(await setMode($, "default"))}
						/>
					)}
				</Box>
			</Box>
		);
	});

	// ---- the dialog pane (approvals, and questions the engine's dialog cannot show)

	on("ui.render", { component: "Pane", requestId: DIALOG }, async ($, e) => {
		const els = $.ui.resolve(e);
		const { Box, Button, Text } = els;
		const Input = "Input" in els ? els.Input : undefined;
		const d = await read($, dialog);
		const found = d ? findItem(await read($, view), d.job, d.ref) : null;
		if (d?.via !== "pane" || !found) return <Text dimColor>Nothing to decide.</Text>;
		const { job, item } = found;
		const header = (
			<Box flexDirection="column" marginBottom={1}>
				<Text bold>
					omp job {shortId(job.id)}
					{job.title ? ` · ${job.title}` : ""}
				</Text>
				<Text dimColor>
					{job.model ?? "?"} · {job.access} · {job.cwd}
				</Text>
				{d.note && <Text color="claude">Claude: {d.note}</Text>}
			</Box>
		);
		const error = d.error ? <Text color="error">{d.error}</Text> : null;
		if (item.kind === "question") {
			const plan = planPrompt(item, job.id, d.note ?? undefined);
			const options = plan.ui === "pane" ? plan.options : [];
			return (
				<Box flexDirection="column">
					{header}
					<Text>{item.text}</Text>
					{item.context && <Text dimColor>{item.context}</Text>}
					{options.map((o, i) => (
						<Button
							key={`opt-${i}`}
							plain
							onPress={() => answerAsUser($, d, replyArgs(d.job, d.ref, o, quiet(d.job, d.ref)))}
						>
							{`${i + 1}. ${o}`}
						</Button>
					))}
					{Input ? (
						<Input
							key="answer"
							autoFocus
							label={options.length ? "Number or your own answer" : "Your answer"}
							submitLabel="Send"
							onSubmit={(value) => {
								const answer = paneAnswer(options, value);
								if (answer === null) return;
								bg(answerAsUser($, d, replyArgs(d.job, d.ref, answer, quiet(d.job, d.ref))));
							}}
						/>
					) : (
						<Text dimColor>Answer this one in the terminal or the desktop app.</Text>
					)}
					{error}
				</Box>
			);
		}
		const canRule = !item.shortened;
		if (d.rule !== null && Input) {
			return (
				<Box flexDirection="column">
					{header}
					<Text>
						{item.tool ?? "tool"}: {item.subject}
					</Text>
					<Input
						key="rule"
						autoFocus
						label="Allow commands matching (glob)"
						value={d.rule}
						submitLabel="Allow"
						onSubmit={(value) => {
							const rule = value.trim();
							if (!rule) return;
							bg(answerAsUser($, d, approveArgs(d, ["--rule", rule])));
						}}
					/>
					<Button
						key="rule-back"
						label="Back"
						onPress={() => update($, dialog, (c) => (c ? { ...c, rule: null, error: null } : c))}
					/>
					{error}
				</Box>
			);
		}
		if (d.message !== null && Input) {
			return (
				<Box flexDirection="column">
					{header}
					<Text>
						{item.tool ?? "tool"}: {item.subject}
					</Text>
					<Input
						key="message"
						autoFocus
						label="Deny, and tell the worker"
						submitLabel="Deny"
						onSubmit={(value) => {
							const message = value.trim();
							if (!message) return;
							bg(answerAsUser($, d, approveArgs(d, ["--deny"]), ["steer", "--", d.job, message]));
						}}
					/>
					<Button
						key="message-back"
						label="Back"
						onPress={() => update($, dialog, (c) => (c ? { ...c, message: null, error: null } : c))}
					/>
					{error}
				</Box>
			);
		}
		return (
			<Box flexDirection="column">
				{header}
				<Text bold>{item.tool ?? "tool"} wants to run:</Text>
				<Text>{item.subject}</Text>
				{item.shortened && (
					<Text dimColor>omp shortened this command, so no rule can vouch for it.</Text>
				)}
				<Box flexDirection="column" marginTop={1}>
					<Button
						key="a"
						hotkey="a"
						label="Allow once"
						variant="primary"
						onPress={() => answerAsUser($, d, approveArgs(d, []))}
					/>
					{canRule && (
						<Button
							key="s"
							hotkey="s"
							label="Allow this exact command"
							onPress={() => answerAsUser($, d, approveArgs(d, ["--same"]))}
						/>
					)}
					{canRule && Input && (
						<Button
							key="r"
							hotkey="r"
							label="Allow rule…"
							onPress={() =>
								update($, dialog, (c) =>
									c ? { ...c, rule: suggestRule(item.subject), error: null } : c,
								)
							}
						/>
					)}
					<Button
						key="t"
						hotkey="t"
						label={`Allow ${item.tool ?? "this tool"} for the session`}
						onPress={() => answerAsUser($, d, approveArgs(d, ["--session"]))}
					/>
					<Button
						key="d"
						hotkey="d"
						label="Deny"
						onPress={() => answerAsUser($, d, approveArgs(d, ["--deny"]))}
					/>
					{Input && (
						<Button
							key="m"
							hotkey="m"
							label="Deny with message…"
							onPress={() => update($, dialog, (c) => (c ? { ...c, message: "", error: null } : c))}
						/>
					)}
				</Box>
				{error}
			</Box>
		);
	});
};

async function setMode($: $, mode: string): Promise<string> {
	if (mode !== "default" && !DECIDERS.includes(mode as OmpDecider)) {
		return `unknown mode '${mode}'; use claude, both, user or default.`;
	}
	if (!sessionId) return "no session yet.";
	if (!token) {
		if (!feed) await refresh($);
		if (!token) startFeed($);
		for (let i = 0; i < 20 && !token && feed; i++)
			await $.process.run(["sleep", "0.1"]).catch(() => {});
	}
	if (!token) {
		return "the mode is set while the session has omp jobs running (set ui.decider in the config for a default).";
	}
	const r = await cli($, ["ui-mode", "--session", sessionId, mode], { asUser: true });
	bg(refresh($));
	return r.exitCode === 0 ? r.stdout : why(r);
}
