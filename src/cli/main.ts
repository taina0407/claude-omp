#!/usr/bin/env bun
/**
 * omp-task: delegate coding tasks to the omp (oh-my-pi) agent and supervise them live.
 * Every command talks to the per-user daemon, which it starts when needed.
 *
 * Exit codes: 0 completed, 1 failed/cancelled/timeout, 2 usage error, 3 --max-wait expired,
 * 4 a job needs the orchestrator (a question, an approval, or an interrupted job to resume),
 * 5 the daemon could not be started or reached.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { ControlResponse, Health, JobView, WaitResponse } from "../api/schema";
import { loadConfig } from "../core/config";
import type { JobOptions } from "../core/jobs";
import { configFile, ompBin, PREAMBLE_FILE, socketPath, stateDir } from "../core/paths";
import {
	ALL_STATUSES,
	type ApprovalDecision,
	type ControlRequest,
	isTerminal,
	type Job,
} from "../core/types";
import { errorText, UsageError } from "../core/util";
import { runDaemon } from "../daemon/server";
import { VERSION } from "../version";
import { type Client, connect, DaemonError, existingDaemon } from "./client";
import { emitJob, formatFeed, out } from "./render";

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_MAX_WAIT = 3;
const EXIT_ATTENTION = 4;
const EXIT_DAEMON = 5;
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
  resume <job>             continue a job the daemon was running when it stopped
  wait <job...>            block until jobs finish or one needs you (exit 4)
  watch <job...>           stream one line per job event until all jobs end (for Monitor)
  steer <job> [text...]    redirect a running job mid-flight
  reply <job> [text...]    answer a running job's question (--ref to pick one)
  approve <job>            approve a pending shell command (--session, --deny, --ref)
  cancel <job>             abort a running job
  status <job>             show a job's state
  result <job>             print a job's result (--full, --json)
  list                     list recent jobs (-n, -C, --status, --json)
  doctor                   check the omp install, the daemon and the configuration
  daemon [status|stop]     run the daemon in the foreground, show it, or stop it (--force)

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
  -d, --detach          return the job id at once instead of waiting
  --max-wait SECONDS    without --detach: stop waiting after N seconds (exit 3)
  --json                machine-readable output

Exit codes: 0 completed, 1 failed/cancelled/timeout, 2 usage error, 3 --max-wait expired,
4 a job needs you (question, approval, or interrupted), 5 the daemon is unavailable.`;

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
	return opts;
}

const jobPath = (ref: string) => `/v1/jobs/${encodeURIComponent(ref)}`;

async function getJob(client: Client, ref: string): Promise<JobView> {
	return client.call<JobView>("GET", jobPath(ref));
}

// ---------------------------------------------------------------- waiting

async function waitJobs(
	client: Client,
	ids: string[],
	opts: { maxWaitS: number | undefined; json: boolean; attention: boolean },
): Promise<number> {
	const deadline = opts.maxWaitS !== undefined ? performance.now() + opts.maxWaitS * 1000 : null;
	while (true) {
		const remaining = deadline === null ? LONG_POLL_S : (deadline - performance.now()) / 1000;
		const q = new URLSearchParams({
			ids: ids.join(","),
			attention: opts.attention ? "1" : "0",
			timeout: String(Math.max(0, Math.min(LONG_POLL_S, remaining))),
		});
		const res = await client.call<WaitResponse>("GET", `/v1/wait?${q}`);
		if (res.reason === "attention") {
			const needs = res.jobs.filter((v) => v.pending.length || v.job.status === "interrupted");
			for (const v of needs) {
				emitJob(v.job, v.pending, opts.json);
				out();
			}
			for (const v of res.jobs.filter((x) => !needs.includes(x))) {
				out(`(job ${v.job.id} is ${v.job.status})`);
			}
			return EXIT_ATTENTION;
		}
		if (res.reason === "done") {
			for (const v of res.jobs) {
				emitJob(v.job, [], opts.json);
				out();
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
			out(`job ${job.id} ${verb}`);
			out(`  wake me when it needs me: omp-task wait ${job.id}   (run it in the background)`);
			out(`  live feed for Monitor:    omp-task watch ${job.id}`);
		}
		return 0;
	}
	return waitJobs(client, [job.id], {
		maxWaitS: num(values["max-wait"], "--max-wait"),
		json: Boolean(values.json),
		attention: true,
	});
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

	async wait(argv) {
		const { values, positionals } = parse(argv, {
			interval: { type: "string" }, // accepted for v0.2 compatibility; waiting is push-based now
			"max-wait": { type: "string" },
			"no-attention": { type: "boolean" },
			json: { type: "boolean" },
		});
		if (!positionals.length) throw new UsageError("wait needs at least one job id");
		const client = await connect();
		const ids = await Promise.all(positionals.map(async (p) => (await getJob(client, p)).job.id));
		return waitJobs(client, ids, {
			maxWaitS: num(values["max-wait"], "--max-wait"),
			json: Boolean(values.json),
			attention: !values["no-attention"],
		});
	},

	async watch(argv) {
		const { values, positionals } = parse(argv, {
			"from-start": { type: "boolean" },
			quiet: { type: "boolean", short: "q" },
			interval: { type: "string" }, // accepted for v0.2 compatibility
		});
		if (!positionals.length) throw new UsageError("watch needs at least one job id");
		const hidden = new Set(values.quiet ? ["tool", "progress", "steer", "subagent"] : []);
		const client = await connect();
		for await (const event of client.feed(positionals, Boolean(values["from-start"]))) {
			if (event.type === "end") return 0;
			if (!hidden.has(event.entry.kind)) out(formatFeed(event.entry));
		}
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
		const { values, positionals } = parse(argv, { json: { type: "boolean" } });
		const [ref] = positionals;
		if (!ref) throw new UsageError("status needs a job id");
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
		emitJob(job, pending, Boolean(values.json), Boolean(values.full));
		return 0;
	},

	async list(argv) {
		const { values } = parse(argv, {
			limit: { type: "string", short: "n" },
			cwd: { type: "string", short: "C" },
			status: { type: "string" },
			json: { type: "boolean" },
		});
		const status = values.status as string | undefined;
		if (status && !(ALL_STATUSES as readonly string[]).includes(status)) {
			throw new UsageError(`--status must be one of ${ALL_STATUSES.join(", ")}`);
		}
		const q = new URLSearchParams({ limit: String(num(values.limit, "--limit") ?? 20) });
		if (values.cwd) q.set("cwd", resolve(values.cwd as string));
		if (status) q.set("status", status);
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

	async doctor() {
		const bin = ompBin();
		out(`omp binary:   ${bin ?? "NOT FOUND"}`);
		if (bin) {
			const p = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
			out(`omp version:  ${p.stdout.toString().trim()}`);
		}
		out(`omp-task:     ${VERSION} (bun ${Bun.version})`);
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
		out(`preamble:     ${PREAMBLE_FILE} (${existsSync(PREAMBLE_FILE) ? "ok" : "missing"})`);
		return bin ? 0 : EXIT_FAILED;
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
