#!/usr/bin/env bun
/**
 * omp-task: delegate coding tasks to the omp (oh-my-pi) agent and supervise them live.
 * Every command talks to the per-user daemon, which it starts when needed.
 *
 * Exit codes: 0 completed or a job needs the orchestrator (the WAKE: line says which),
 * 1 failed/cancelled/timeout/skipped/over_budget, 2 usage error or refused request,
 * 3 --max-wait expired, 5 the daemon could not be started or reached.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import EXAMPLE_CONFIG from "../../config.example.json";
import type {
	ApplyResponse,
	ControlResponse,
	DiffResponse,
	GroupSummary,
	Health,
	JobView,
	PlanResponse,
	WaitResponse,
	WaitView,
} from "../api/schema";
import { loadConfig } from "../core/config";
import type { JobOptions } from "../core/jobs";
import { COMPILED, configFile, ompBin, preambleFile, socketPath, stateDir } from "../core/paths";
import { orderPlan, readPlanFile } from "../core/plan";
import {
	ALL_STATUSES,
	type ApprovalDecision,
	type ControlRequest,
	isTerminal,
	type Job,
} from "../core/types";
import { errorText, parseDuration, UsageError } from "../core/util";
import { runDaemon } from "../daemon/server";
import { hookMain } from "../hooks/hooks";
import { VERSION } from "../version";
import { type Client, connect, DaemonError, existingDaemon } from "./client";
import { ATTENTION_FEED_KINDS, emitJob, formatFeed, out, pendingSummary } from "./render";

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_MAX_WAIT = 3;
const EXIT_DAEMON = 5;
/** The oldest omp whose RPC protocol (v2, `prompt_result`, host tools) omp-task was built on. */
const MIN_OMP = [18, 12] as const;

/** True when `omp --version` output ("omp/18.12.6") is at least MIN_OMP, or cannot be read. */
export function ompVersionOk(text: string): boolean {
	const m = /(\d+)\.(\d+)/.exec(text);
	if (!m) return true;
	const [major, minor] = [Number(m[1]), Number(m[2])];
	return major > MIN_OMP[0] || (major === MIN_OMP[0] && minor >= MIN_OMP[1]);
}

/** One long-poll request; the CLI asks again until its own --max-wait. */
const LONG_POLL_S = 25;

type Values = Record<string, string | boolean | string[] | undefined>;

const TASK_OPTIONS = {
	brief: { type: "string", short: "b" },
	model: { type: "string", short: "m" },
	preset: { type: "string", short: "p" },
	access: { type: "string", short: "a" },
	thinking: { type: "string", short: "t" },
	timeout: { type: "string" },
	"answer-timeout": { type: "string" },
	"approval-timeout": { type: "string" },
	cwd: { type: "string", short: "C" },
	"add-dir": { type: "string", multiple: true },
	file: { type: "string", short: "f", multiple: true },
	title: { type: "string" },
	"omp-args": { type: "string" },
	"no-preamble": { type: "boolean" },
	isolate: { type: "string" },
	"carry-dirty": { type: "boolean" },
	after: { type: "string", multiple: true },
	"after-any-outcome": { type: "boolean" },
	group: { type: "string", short: "g" },
	budget: { type: "string" },
	allow: { type: "string", multiple: true },
	deny: { type: "string", multiple: true },
	"stall-timeout": { type: "string" },
	detach: { type: "boolean", short: "d" },
	"max-wait": { type: "string" },
	json: { type: "boolean" },
} as const;

const MESSAGE_OPTIONS = { brief: { type: "string", short: "b" } } as const;

const HELP = `omp-task ${VERSION} — delegate tasks to omp and supervise them live

Usage: omp-task <command> [options]

Commands:
  run [text...]            start a task; waits until it finishes or needs you (unless --detach)
  continue <job> [text...] new job that resumes a finished job's omp session
  resume <job> [-d]        continue a job the daemon was running when it stopped
                           (-d/--detach, --max-wait, --json as for run)
  review [--staged|--base REF|--commit SHA|--job ID]  read-only review (see Review below)
  wait <job...>            block until jobs finish or one needs you; --group G, --max-wait S,
                           --no-checkpoint (checkpoints do not wake), --json
  watch <job...>           stream job events until all jobs end (piped: attention only);
                           --from-start, -v/--verbose (every event), -q/--quiet,
                           --last N (the last N events so far, then exit)
  steer <job> [text...]    redirect a running job mid-flight (-b FILE for a long message)
  reply <job> [text...]    answer a running job's question (--ref to pick one, else the oldest)
  approve <job>            approve the oldest pending request (--ref to pick one; --session:
                           also later calls of that tool; --deny)
  cancel <job>             cancel a running, waiting, queued, blocked or interrupted job
  status <job>             show a job's state (--group G: the same as summary G; --json)
  result <job>             print a job's result (--full, --json)
  diff <job> [--stat]      show a worktree job's patch (--stat: one changed file per line)
  apply <job> [--3way] [--keep]  bring a worktree's changes into the main checkout
  discard <job>            remove a job's worktree without applying it
  prune [--older 7d] [--dry-run]  remove worktrees of finished jobs older than this
  prune --jobs [--older 30d]      delete finished jobs and their files (also done daily)
  list                     list recent jobs (-n, -C, --status, --group, --json)
  summary <group>          status, cost and changed files of every job in a group (--json)
  plan apply <file>        create a group of jobs with dependencies from a YAML/JSON plan
                           (--dry-run: print the order only; --json)
  doctor                   check the omp install, the daemon and the configuration
  setup [--stop-gate on|off]  create the config file if missing; turn the Stop review gate on/off
  hook <name>              run a Claude Code hook (session-start, session-end, stop-gate)
  daemon [status|stop]     run the daemon in the foreground, show it, or stop it (--force)
  install-binary           download this version's release binary (checks its sha256)

Task options (run, continue):
  -b, --brief FILE      read the task from a file ('-' for stdin)
  -m, --model M         omp model or role (smol, slow, plan, 'openai/gpt-6-luna', ...)
  -p, --preset NAME     named preset from the config file
  -a, --access LEVEL    read | edit (default) | full
  -t, --thinking LEVEL  off|minimal|low|medium|high|xhigh|max|auto
  --timeout D           wall-clock limit, e.g. 600, 20m, 1h (default 30m)
  --answer-timeout D    how long a question waits for a reply (default 20m)
  --approval-timeout D  how long an approval waits before it is denied (default 20m)
  -C, --cwd DIR         directory omp works in (default: current)
  --add-dir DIR         extra workspace directory (repeatable)
  -f, --file FILE       file the worker should read first (repeatable)
  --title TEXT          short label for job listings
  --omp-args ARGS       extra raw omp flags, shell-quoted
  --no-preamble         skip the worker preamble system prompt
  --isolate MODE        auto (default) | worktree | none
  --carry-dirty         copy the checkout's uncommitted changes into the worktree
  --after JOB[,JOB]     start only after these jobs completed (repeatable)
  --after-any-outcome   with --after: start even if a dependency did not complete
  -g, --group NAME      add the job to a group (limits, summary, wait --group)
  --budget USD          stop the job as over_budget once it spends more
  --allow GLOB          approve matching commands without asking (repeatable; 'tool:NAME')
  --deny GLOB           deny matching commands without asking (repeatable)
  --stall-timeout D     wake you when the worker shows no activity this long (default 10m)
  -d, --detach          return the job id at once instead of waiting
  --max-wait SECONDS    without --detach: stop waiting after N seconds (exit 3)
  --json                machine-readable output

Review (always read-only; the worker must submit findings through submit_review):
  omp-task review                    the uncommitted changes (default)
  omp-task review --staged           the staged changes
  omp-task review --base main        everything since the merge-base with main
  omp-task review --commit SHA       one commit
  omp-task review --job JOB          a worktree job's changes, before you apply them
  --adversarial  try to break the change    --focus TEXT  what to look at hardest
  also: -m, -p, -t, --timeout, -C, -g, --budget, -d, --max-wait, --json

Waking up: wait (and run without --detach) returns only when every job ended or one needs you:
a question, an approval, an interrupted job, a checkpoint the worker reported, or a stalled
worker; progress never wakes you. The last line says which: \`WAKE: <job> <reason>\` (with a
\`PENDING:\` line per question or approval above it) or \`WAKE: done (...)\`.

Exit codes: 0 every job completed, or a job needs you (read the WAKE: line); 1 a job failed,
was cancelled, timed out, was skipped or went over budget; 2 usage error; 3 --max-wait expired;
5 the daemon is unavailable.`;

function parse(
	argv: string[],
	options: ParseArgsOptionsConfig,
): { values: Values; positionals: string[] } {
	try {
		const r = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
		return { values: r.values as Values, positionals: r.positionals };
	} catch (e) {
		throw new UsageError(errorText(e));
	}
}

function num(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) throw new UsageError(`${name} must be a number of seconds`);
	return n;
}

function readText(values: Values, positionals: string[]): string {
	const parts: string[] = [];
	const brief = values.brief as string | undefined;
	if (brief) parts.push(brief === "-" ? readFileSync(0, "utf8") : readFileSync(brief, "utf8"));
	if (positionals.length) parts.push(positionals.join(" "));
	const text = parts
		.map((p) => p.trim())
		.filter(Boolean)
		.join("\n\n");
	if (!text) {
		throw new UsageError(
			"no text given: pass it as arguments, or --brief FILE (use '-' for stdin)",
		);
	}
	return text;
}

function jobOptions(values: Values, prompt: string): JobOptions {
	const opts: JobOptions = { prompt, clientCwd: process.cwd() };
	if (process.env.OMP_TASK_CLAUDE_SESSION) opts.claudeSession = process.env.OMP_TASK_CLAUDE_SESSION;
	const str = (k: string) => values[k] as string | undefined;
	if (str("model")) opts.model = str("model");
	if (str("preset")) opts.preset = str("preset");
	if (str("access")) opts.access = str("access");
	if (str("thinking")) opts.thinking = str("thinking");
	if (str("timeout")) opts.timeout = str("timeout");
	if (str("answer-timeout")) opts.answerTimeout = str("answer-timeout");
	if (str("approval-timeout")) opts.approvalTimeout = str("approval-timeout");
	if (str("cwd")) opts.cwd = resolve(str("cwd") as string);
	if (values["add-dir"]) opts.addDirs = values["add-dir"] as string[];
	if (values.file) opts.files = values.file as string[];
	if (str("title")) opts.title = str("title");
	if (str("omp-args")) opts.ompArgs = str("omp-args");
	if (values["no-preamble"]) opts.noPreamble = true;
	if (str("isolate")) opts.isolate = str("isolate");
	if (values["carry-dirty"]) opts.carryDirty = true;
	if (values.after) {
		opts.after = (values.after as string[]).flatMap((a) => a.split(",")).filter(Boolean);
	}
	if (values["after-any-outcome"]) opts.afterAny = true;
	if (str("group")) opts.group = str("group");
	if (str("budget")) opts.budget = str("budget");
	if (values.allow) opts.allow = values.allow as string[];
	if (values.deny) opts.deny = values.deny as string[];
	if (str("stall-timeout")) opts.stallTimeout = str("stall-timeout");
	return opts;
}

/** `--older` takes parseDuration forms plus days ('7d'); default a week. */
function pruneSeconds(value: unknown): number {
	if (value === undefined) return 7 * 24 * 3600;
	const days = /^(\d+(?:\.\d+)?)d$/.exec(value as string);
	return days ? Number(days[1]) * 86_400 : (parseDuration(value as string) ?? 0);
}

const jobPath = (ref: string) => `/v1/jobs/${encodeURIComponent(ref)}`;

async function getJob(client: Client, ref: string): Promise<JobView> {
	return client.call<JobView>("GET", jobPath(ref));
}

// ---------------------------------------------------------------- waiting

/** Why a job woke the orchestrator: its pending items, an interruption, delivered notices. */
function wakeReasons(v: WaitView): string[] {
	const reasons = new Set<string>(v.pending.map((p) => p.kind));
	if (v.job.status === "interrupted") reasons.add("interrupted");
	for (const n of v.delivered) reasons.add(n.kind);
	return [...reasons];
}

/** Lines of a finished job's report shown when `wait` returns; `result` has the rest. */
const WAKE_RESULT_LINES = 40;

async function waitJobs(
	client: Client,
	target: { ids: string[]; group?: string | undefined },
	opts: {
		maxWaitS: number | undefined;
		json: boolean;
		attention: boolean;
		checkpoint?: boolean;
	},
): Promise<number> {
	const deadline = opts.maxWaitS !== undefined ? performance.now() + opts.maxWaitS * 1000 : null;
	while (true) {
		const remaining = deadline === null ? LONG_POLL_S : (deadline - performance.now()) / 1000;
		const q = new URLSearchParams({
			ids: target.ids.join(","),
			attention: opts.attention ? "1" : "0",
			checkpoint: opts.checkpoint === false ? "0" : "1",
			timeout: String(Math.max(0, Math.min(LONG_POLL_S, remaining))),
		});
		if (target.group) q.set("group", target.group);
		const res = await client.call<WaitResponse>("GET", `/v1/wait?${q}`);
		if (res.reason === "attention") {
			const needs = res.jobs.filter((v) => wakeReasons(v).length);
			for (const v of needs) {
				emitJob(v.job, v.pending, opts.json, { notices: v.delivered });
				out();
			}
			for (const v of res.jobs.filter((x) => !needs.includes(x))) {
				out(`(job ${v.job.id} is ${v.job.status})`);
			}
			// Last, so the job blocks keep starting with their "## omp job" header.
			if (!opts.json) {
				for (const v of needs) for (const p of v.pending) out(pendingSummary(p));
				out(`WAKE: ${needs.map((v) => `${v.job.id} ${wakeReasons(v).join("+")}`).join("; ")}`);
			}
			return 0;
		}
		if (res.reason === "done") {
			for (const v of res.jobs) {
				emitJob(v.job, [], opts.json, { maxResultLines: WAKE_RESULT_LINES });
				out();
			}
			if (!opts.json) {
				const counts = new Map<string, number>();
				for (const v of res.jobs) counts.set(v.job.status, (counts.get(v.job.status) ?? 0) + 1);
				out(`WAKE: done (${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")})`);
			}
			return res.jobs.every((v) => v.job.status === "completed") ? 0 : EXIT_FAILED;
		}
		if (deadline !== null && performance.now() >= deadline) {
			for (const v of res.jobs) out(`${v.job.id} ${v.job.status}`);
			return EXIT_MAX_WAIT;
		}
	}
}

async function afterStart(client: Client, job: Job, values: Values, verb: string): Promise<number> {
	if (values.detach) {
		if (values.json) out(JSON.stringify({ id: job.id, status: job.status }));
		else {
			const waiting = job.status === "blocked" || job.status === "queued";
			out(`job ${job.id} ${verb}${waiting ? ` (${job.status})` : ""}`);
			out(`  next: run \`omp-task wait ${job.id}\` in the background and end your turn;`);
			out("  it returns only when the job ends or needs you.");
		}
		return 0;
	}
	return waitJobs(
		client,
		{ ids: [job.id] },
		{
			maxWaitS: num(values["max-wait"], "--max-wait"),
			json: Boolean(values.json),
			attention: true,
		},
	);
}

/** `summary <group>` and `status --group <group>`. */
async function printSummary(group: string, json: boolean): Promise<number> {
	const s = await (await connect()).call<GroupSummary>(
		"GET",
		`/v1/groups/${encodeURIComponent(group)}`,
	);
	if (json) {
		out(JSON.stringify(s, null, 2));
		return 0;
	}
	const limits = [
		s.maxConcurrent !== null ? `max ${s.maxConcurrent} at once` : null,
		s.budgetUsd !== null ? `budget $${s.budgetUsd}` : null,
	].filter(Boolean);
	const suffix = limits.length ? ` (${limits.join(", ")})` : "";
	out(`## group ${s.group}: ${s.jobs.length} job(s), spent $${s.spentUsd.toFixed(4)}${suffix}`);
	for (const j of s.jobs) {
		const files = j.changedFiles === null ? "-" : String(j.changedFiles.length);
		const after = j.after.length ? `  after ${j.after.join(",")}` : "";
		out(
			`${j.id}  ${j.status.padEnd(11)}  $${j.costUsd.toFixed(4)}  files ${files.padStart(2)}  ${j.title.slice(0, 50)}${after}`,
		);
		for (const e of j.errors.slice(-1)) out(`    ${e}`);
	}
	return 0;
}

async function control(client: Client, ref: string, req: ControlRequest): Promise<number> {
	const res = await client.call<ControlResponse>("POST", `${jobPath(ref)}/control`, req);
	const okText =
		req.kind === "steer"
			? "steer sent"
			: req.kind === "reply"
				? "answer sent"
				: `${req.decision ?? "approve"} sent`;
	out(res.ok ? okText : `error: ${res.error}`);
	return res.ok ? 0 : EXIT_FAILED;
}

// ---------------------------------------------------------------- commands

type Command = (argv: string[]) => Promise<number>;

const commands: Record<string, Command> = {
	async run(argv) {
		const { values, positionals } = parse(argv, TASK_OPTIONS);
		const options = jobOptions(values, readText(values, positionals));
		const client = await connect();
		const { job } = await client.call<JobView>("POST", "/v1/jobs", { options });
		return afterStart(client, job, values, "started");
	},

	async continue(argv) {
		const { values, positionals } = parse(argv, TASK_OPTIONS);
		const [parent, ...rest] = positionals;
		if (!parent) throw new UsageError("continue needs a job id");
		const options = jobOptions(values, readText(values, rest));
		const client = await connect();
		const { job } = await client.call<JobView>("POST", "/v1/jobs", { options, parent });
		return afterStart(client, job, values, "started");
	},

	async resume(argv) {
		const { values, positionals } = parse(argv, {
			detach: { type: "boolean", short: "d" },
			"max-wait": { type: "string" },
			json: { type: "boolean" },
		});
		const [ref] = positionals;
		if (!ref) throw new UsageError("resume needs a job id");
		const client = await connect();
		const { job } = await client.call<JobView>("POST", `${jobPath(ref)}/resume`, {});
		return afterStart(client, job, values, "resumed");
	},

	async review(argv) {
		const { values, positionals } = parse(argv, {
			base: { type: "string" },
			staged: { type: "boolean" },
			commit: { type: "string" },
			job: { type: "string" },
			adversarial: { type: "boolean" },
			focus: { type: "string" },
			model: { type: "string", short: "m" },
			preset: { type: "string", short: "p" },
			thinking: { type: "string", short: "t" },
			timeout: { type: "string" },
			cwd: { type: "string", short: "C" },
			group: { type: "string", short: "g" },
			budget: { type: "string" },
			title: { type: "string" },
			detach: { type: "boolean", short: "d" },
			"max-wait": { type: "string" },
			json: { type: "boolean" },
		});
		if (positionals.length)
			throw new UsageError(`review takes no arguments: ${positionals.join(" ")}`);
		const picked = (["base", "staged", "commit", "job"] as const).filter((k) => values[k]);
		if (picked.length > 1) throw new UsageError(`pick one of --${picked.join(", --")}`);
		const target =
			values.base !== undefined
				? { kind: "base", ref: values.base }
				: values.commit !== undefined
					? { kind: "commit", ref: values.commit }
					: values.job !== undefined
						? { kind: "job", ref: values.job }
						: { kind: values.staged ? "staged" : "uncommitted" };
		const { prompt: _, ...options } = jobOptions(values, "-");
		const client = await connect();
		const { job } = await client.call<JobView>("POST", "/v1/reviews", {
			target,
			mode: values.adversarial ? "adversarial" : "standard",
			focus: (values.focus as string | undefined) ?? null,
			options,
		});
		return afterStart(client, job, values, "started");
	},

	async wait(argv) {
		const { values, positionals } = parse(argv, {
			"max-wait": { type: "string" },
			"no-attention": { type: "boolean" },
			"no-checkpoint": { type: "boolean" },
			group: { type: "string", short: "g" },
			json: { type: "boolean" },
		});
		const group = values.group as string | undefined;
		if (!positionals.length && !group) throw new UsageError("wait needs job ids or --group");
		const client = await connect();
		const ids = await Promise.all(positionals.map(async (p) => (await getJob(client, p)).job.id));
		return waitJobs(
			client,
			{ ids, group },
			{
				maxWaitS: num(values["max-wait"], "--max-wait"),
				json: Boolean(values.json),
				attention: !values["no-attention"],
				checkpoint: !values["no-checkpoint"],
			},
		);
	},

	async watch(argv) {
		const { values, positionals } = parse(argv, {
			"from-start": { type: "boolean" },
			quiet: { type: "boolean", short: "q" },
			verbose: { type: "boolean", short: "v" },
			last: { type: "string" },
		});
		if (!positionals.length) throw new UsageError("watch needs at least one job id");
		// Piped (Monitor, scripts): only what needs the orchestrator, so every line is worth a wake-up.
		const quiet = values.quiet || (!values.verbose && !process.stdout.isTTY);
		// --last N: the job's last N events so far, then exit (safe on a job that still runs).
		const last = num(values.last, "--last");
		const client = await connect();
		const lines: string[] = [];
		for await (const event of client.feed(
			positionals,
			last !== undefined || Boolean(values["from-start"]),
			last === undefined,
		)) {
			if (event.type === "end") break;
			if (quiet && !ATTENTION_FEED_KINDS.has(event.entry.kind)) continue;
			if (last === undefined) out(formatFeed(event.entry));
			else lines.push(formatFeed(event.entry));
		}
		if (last !== undefined) for (const line of lines.slice(-last)) out(line);
		return 0;
	},

	async steer(argv) {
		const { values, positionals } = parse(argv, MESSAGE_OPTIONS);
		const [ref, ...rest] = positionals;
		if (!ref) throw new UsageError("steer needs a job id");
		const message = readText(values, rest);
		return control(await connect(), ref, { kind: "steer", message });
	},

	async reply(argv) {
		const { values, positionals } = parse(argv, { ...MESSAGE_OPTIONS, ref: { type: "string" } });
		const [ref, ...rest] = positionals;
		if (!ref) throw new UsageError("reply needs a job id");
		const message = readText(values, rest);
		return control(await connect(), ref, {
			kind: "reply",
			message,
			ref: (values.ref as string | undefined) ?? null,
		});
	},

	async approve(argv) {
		const { values, positionals } = parse(argv, {
			session: { type: "boolean" },
			deny: { type: "boolean" },
			ref: { type: "string" },
		});
		const [ref] = positionals;
		if (!ref) throw new UsageError("approve needs a job id");
		if (values.session && values.deny) throw new UsageError("--session and --deny are exclusive");
		const decision: ApprovalDecision = values.deny
			? "deny"
			: values.session
				? "session"
				: "approve";
		return control(await connect(), ref, {
			kind: "approve",
			decision,
			ref: (values.ref as string | undefined) ?? null,
		});
	},

	async cancel(argv) {
		const { positionals } = parse(argv, {});
		const [ref] = positionals;
		if (!ref) throw new UsageError("cancel needs a job id");
		const client = await connect();
		const { job } = await getJob(client, ref);
		if (isTerminal(job.status)) {
			out(`job ${job.id} already ${job.status}`);
			return 0;
		}
		const res = await client.call<ControlResponse>("POST", `${jobPath(job.id)}/control`, {
			kind: "abort",
		});
		out(res.ok ? `cancel requested for job ${job.id}` : `error: ${res.error}`);
		return res.ok ? 0 : EXIT_FAILED;
	},

	async status(argv) {
		const { values, positionals } = parse(argv, {
			group: { type: "string", short: "g" },
			json: { type: "boolean" },
		});
		const [ref] = positionals;
		if (values.group) {
			if (ref) throw new UsageError("status takes a job id or --group, not both");
			return printSummary(values.group as string, Boolean(values.json));
		}
		if (!ref) throw new UsageError("status needs a job id (or --group NAME)");
		const { job, pending } = await getJob(await connect(), ref);
		if (isTerminal(job.status) || job.status === "interrupted" || pending.length) {
			emitJob(job, pending, Boolean(values.json));
			return 0;
		}
		if (values.json) {
			out(
				JSON.stringify(
					{
						id: job.id,
						status: job.status,
						title: job.title,
						started_at: job.startedAt,
						tools_so_far: job.tools,
						cost_usd_so_far: job.costUsd,
						session_id: job.sessionId,
					},
					null,
					2,
				),
			);
		} else {
			const tools = Object.entries(job.tools)
				.map(([k, v]) => `${k}×${v}`)
				.join(", ");
			out(`${job.id} ${job.status} — ${job.title} — tools so far: ${tools || "none"}`);
		}
		return 0;
	},

	async result(argv) {
		const { values, positionals } = parse(argv, {
			full: { type: "boolean" },
			json: { type: "boolean" },
		});
		const [ref] = positionals;
		if (!ref) throw new UsageError("result needs a job id");
		const { job, pending } = await getJob(await connect(), ref);
		emitJob(job, pending, Boolean(values.json), { full: Boolean(values.full) });
		return 0;
	},

	async diff(argv) {
		const { values, positionals } = parse(argv, { stat: { type: "boolean" } });
		const [ref] = positionals;
		if (!ref) throw new UsageError("diff needs a job id");
		const client = await connect();
		const { patch, files } = await client.call<DiffResponse>("GET", `${jobPath(ref)}/diff`);
		if (values.stat) for (const f of files) out(f);
		else out(patch);
		return 0;
	},

	async apply(argv) {
		const { values, positionals } = parse(argv, {
			"3way": { type: "boolean" },
			keep: { type: "boolean" },
		});
		const [ref] = positionals;
		if (!ref) throw new UsageError("apply needs a job id");
		const client = await connect();
		const res = await client.call<ApplyResponse>("POST", `${jobPath(ref)}/apply`, {
			threeWay: Boolean(values["3way"]),
			keep: Boolean(values.keep),
		});
		if (!res.ok) {
			out(`error: ${res.error ?? "the patch does not apply"}`);
			return EXIT_FAILED;
		}
		out(`applied ${res.files.length} file(s)`);
		for (const f of res.files) out(f);
		return 0;
	},

	async discard(argv) {
		const { positionals } = parse(argv, {});
		const [ref] = positionals;
		if (!ref) throw new UsageError("discard needs a job id");
		await (await connect()).call("POST", `${jobPath(ref)}/discard`);
		out("worktree removed");
		return 0;
	},

	async prune(argv) {
		const { values } = parse(argv, {
			older: { type: "string" },
			"dry-run": { type: "boolean" },
			jobs: { type: "boolean" },
		});
		const client = await connect();
		const { removed } = await client.call<{ removed: string[] }>("POST", "/v1/prune", {
			olderS: values.jobs && values.older === undefined ? 30 * 86_400 : pruneSeconds(values.older),
			dryRun: Boolean(values["dry-run"]),
			jobs: Boolean(values.jobs),
		});
		for (const id of removed) out(id);
		return 0;
	},

	async list(argv) {
		const { values } = parse(argv, {
			limit: { type: "string", short: "n" },
			cwd: { type: "string", short: "C" },
			status: { type: "string" },
			group: { type: "string", short: "g" },
			json: { type: "boolean" },
		});
		const status = values.status as string | undefined;
		if (status && !(ALL_STATUSES as readonly string[]).includes(status)) {
			throw new UsageError(`--status must be one of ${ALL_STATUSES.join(", ")}`);
		}
		const q = new URLSearchParams({ limit: String(num(values.limit, "--limit") ?? 20) });
		if (values.cwd) q.set("cwd", resolve(values.cwd as string));
		if (status) q.set("status", status);
		if (values.group) q.set("group", values.group as string);
		const { jobs } = await (await connect()).call<{ jobs: Job[] }>("GET", `/v1/jobs?${q}`);
		if (values.json) {
			out(
				JSON.stringify(
					jobs.map((j) => ({
						id: j.id,
						status: j.status,
						title: j.title,
						cwd: j.cwd,
						model_used: j.modelUsed,
						cost_usd: j.costUsd,
						parent: j.parentId,
						group: j.groupName,
					})),
					null,
					2,
				),
			);
			return 0;
		}
		for (const j of jobs)
			out(`${j.id}  ${j.status.padEnd(11)}  ${j.title.slice(0, 60)}  [${j.cwd}]`);
		if (!jobs.length) out("(no jobs)");
		return 0;
	},

	async summary(argv) {
		const { values, positionals } = parse(argv, { json: { type: "boolean" } });
		const [group] = positionals;
		if (!group) throw new UsageError("summary needs a group name");
		return printSummary(group, Boolean(values.json));
	},

	async plan(argv) {
		const { values, positionals } = parse(argv, {
			"dry-run": { type: "boolean" },
			json: { type: "boolean" },
		});
		const [sub, file] = positionals;
		if (sub !== "apply" || !file) {
			throw new UsageError("usage: omp-task plan apply <file> [--dry-run] [--json]");
		}
		const body = readPlanFile(file, process.cwd());
		if (values["dry-run"]) {
			// Without the daemon, `after` entries that are not task names are assumed to be jobs.
			for (const t of orderPlan(body.tasks, () => true)) {
				const after = t.after.length ? `  after ${t.after.join(", ")}` : "";
				out(`${t.name}${after}  ${t.options.title ?? ""}`);
			}
			return 0;
		}
		const res = await (await connect()).call<PlanResponse>("POST", "/v1/plans", body);
		if (values.json) {
			out(JSON.stringify(res, null, 2));
			return 0;
		}
		out(`group ${res.group}: ${res.jobs.length} job(s)`);
		for (const j of res.jobs) out(`  ${j.name.padEnd(16)} ${j.id}  ${j.status}`);
		out(`  next: run \`omp-task wait --group ${res.group}\` in the background and end your turn.`);
		return 0;
	},

	async setup(argv) {
		const { values } = parse(argv, { "stop-gate": { type: "string" } });
		const gate = values["stop-gate"] as string | undefined;
		if (gate !== undefined && gate !== "on" && gate !== "off") {
			throw new UsageError("--stop-gate takes on or off");
		}
		const file = configFile();
		if (!existsSync(file)) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`);
			out(`created ${file} from config.example.json`);
		}
		if (gate) {
			loadConfig(file); // refuse to rewrite a file that does not parse
			const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			const current = (raw.stop_gate ?? {}) as Record<string, unknown>;
			raw.stop_gate = { ...current, enabled: gate === "on" };
			writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
			out(`stop gate ${gate === "on" ? "enabled" : "disabled"} in ${file}`);
		}
		out();
		return commands.doctor?.([]) ?? 0;
	},

	async "install-binary"() {
		// Handled by the plugin launcher (bin/omp-task) before any runtime is needed.
		throw new UsageError(
			"run install-binary through the plugin launcher: bin/omp-task install-binary",
		);
	},

	async hook(argv) {
		return hookMain(argv[0]);
	},

	async doctor() {
		const bin = ompBin();
		let failed = !bin;
		out(`omp binary:   ${bin ?? "NOT FOUND"}`);
		if (bin) {
			const p = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
			const version = p.stdout.toString().trim();
			const ok = ompVersionOk(version);
			out(
				`omp version:  ${version}${ok ? "" : ` (TOO OLD: omp-task needs omp ${MIN_OMP.join(".")} or later)`}`,
			);
			if (!ok) failed = true;
		}
		out(`omp-task:     ${VERSION} (bun ${Bun.version}${COMPILED ? ", compiled" : ""})`);
		out(`state dir:    ${stateDir()}`);
		const daemon = await existingDaemon();
		out(
			`daemon:       ${
				daemon
					? `running, pid ${daemon.health.pid}, ${daemon.health.version}, ${daemon.health.activeJobs} active job(s)`
					: "not running (starts on demand)"
			}`,
		);
		out(`socket:       ${socketPath()}`);
		const cfg = configFile();
		out(`config:       ${cfg} (${existsSync(cfg) ? "present" : "absent, using defaults"})`);
		const presets = Object.keys(loadConfig().presets ?? {});
		if (presets.length) out(`presets:      ${presets.join(", ")}`);
		out(`preamble:     ${preambleFile()}`);
		const gate = loadConfig().stop_gate;
		out(
			`stop gate:    ${gate?.enabled ? `on (${gate.model ?? "smol"})` : "off (omp-task setup --stop-gate on)"}`,
		);
		out(
			`claude:       ${process.env.OMP_TASK_CLAUDE_SESSION ? `session ${process.env.OMP_TASK_CLAUDE_SESSION}` : "no session id (hooks not active)"}`,
		);
		return failed ? EXIT_FAILED : 0;
	},

	async daemon(argv) {
		const { values, positionals } = parse(argv, {
			force: { type: "boolean" },
			json: { type: "boolean" },
		});
		const [sub] = positionals;
		if (!sub) {
			if (!(await runDaemon())) {
				process.stderr.write("omp-task: a daemon already serves this state dir\n");
			}
			return 0;
		}
		const daemon = await existingDaemon();
		if (sub === "status") {
			if (values.json) out(JSON.stringify(daemon?.health ?? { ok: false }, null, 2));
			else if (daemon) {
				const h: Health = daemon.health;
				out(
					`running: pid ${h.pid}, ${h.version}, since ${h.startedAt}, ${h.activeJobs} active job(s)`,
				);
			} else out("not running");
			return daemon ? 0 : EXIT_FAILED;
		}
		if (sub === "stop") {
			if (!daemon) {
				out("not running");
				return 0;
			}
			await daemon.client.call("POST", "/v1/shutdown", { force: Boolean(values.force) });
			const deadline = performance.now() + 30_000;
			while ((await daemon.client.health()) && performance.now() < deadline) await Bun.sleep(50);
			out("stopped");
			return 0;
		}
		throw new UsageError(`unknown daemon command '${sub}' (status, stop)`);
	},
};

export async function main(argv: string[]): Promise<number> {
	const [name, ...rest] = argv;
	if (!name || name === "-h" || name === "--help" || name === "help") {
		out(HELP);
		return name ? 0 : EXIT_USAGE;
	}
	if (name === "--version" || name === "-V") {
		out(`omp-task ${VERSION}`);
		return 0;
	}
	const command = commands[name];
	if (!command) {
		process.stderr.write(`omp-task: unknown command '${name}' (see omp-task --help)\n`);
		return EXIT_USAGE;
	}
	try {
		return await command(rest);
	} catch (e) {
		if (e instanceof UsageError) {
			process.stderr.write(`omp-task: ${e.message}\n`);
			return EXIT_USAGE;
		}
		if (e instanceof DaemonError) {
			process.stderr.write(`omp-task: ${e.message}\n`);
			return EXIT_DAEMON;
		}
		throw e;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
