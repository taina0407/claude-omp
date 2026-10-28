#!/usr/bin/env bun
/**
 * omp-task: delegate coding tasks to the omp (oh-my-pi) agent and supervise them live.
 *
 * Exit codes: 0 completed, 1 failed/cancelled/timeout, 2 usage error, 3 --max-wait expired,
 * 4 a job is waiting for an answer or approval.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { loadConfig } from "../core/config";
import { createJob, type JobOptions, refreshStatus, resolveJob, spawnRunner } from "../core/jobs";
import { configFile, ompBin, PREAMBLE_FILE, stateDir } from "../core/paths";
import { JobRunner } from "../core/runner";
import { Store } from "../core/store";
import {
	ACTIVE_STATUSES,
	type ApprovalDecision,
	type CommandKind,
	type CommandResult,
	isTerminal,
	type Job,
	TERMINAL_STATUSES,
} from "../core/types";
import { errorText, pidAlive, UsageError } from "../core/util";
import { emitJob, formatFeed, out } from "./render";

export const VERSION = "1.0.0-alpha.0";

const EXIT_FAILED = 1;
const EXIT_MAX_WAIT = 3;
const EXIT_ATTENTION = 4;
/** How long a control command waits for the runner to pick it up. */
const CONTROL_TIMEOUT_MS = 15_000;

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
  wait <job...>            block until jobs finish or one needs an answer/approval (exit 4)
  watch <job...>           stream one line per job event until all jobs end (for Monitor)
  steer <job> [text...]    redirect a running job mid-flight
  reply <job> [text...]    answer a running job's question (--ref to pick one)
  approve <job>            approve a pending shell command (--session, --deny, --ref)
  cancel <job>             abort a running job
  status <job>             show a job's state
  result <job>             print a job's result (--full, --json)
  list                     list recent jobs (-n, -C, --status, --json)
  doctor                   check the omp install and configuration

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
4 a job is waiting for an answer or approval.`;

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
	return {
		prompt,
		model: values.model as string | undefined,
		preset: values.preset as string | undefined,
		access: values.access as string | undefined,
		thinking: values.thinking as string | undefined,
		timeout: values.timeout as string | undefined,
		answerTimeout: values["answer-timeout"] as string | undefined,
		approvalTimeout: values["approval-timeout"] as string | undefined,
		cwd: values.cwd as string | undefined,
		addDirs: values["add-dir"] as string[] | undefined,
		files: values.file as string[] | undefined,
		title: values.title as string | undefined,
		ompArgs: values["omp-args"] as string | undefined,
		noPreamble: values["no-preamble"] as boolean | undefined,
	};
}

// ---------------------------------------------------------------- waiting

async function waitJobs(
	store: Store,
	ids: string[],
	opts: { intervalS: number; maxWaitS: number | undefined; json: boolean; attention: boolean },
): Promise<number> {
	const deadline = opts.maxWaitS ? performance.now() + opts.maxWaitS * 1000 : null;
	let jobs: Job[] = [];
	while (true) {
		jobs = ids.map((id) => refreshStatus(store, store.getJob(id) as Job));
		if (opts.attention) {
			const needs = jobs.filter((j) => store.listPending(j.id).length > 0);
			if (needs.length) {
				for (const j of needs) {
					emitJob(j, store.listPending(j.id), opts.json);
					out();
				}
				for (const j of jobs.filter((x) => !needs.includes(x))) out(`(job ${j.id} is ${j.status})`);
				return EXIT_ATTENTION;
			}
		}
		if (jobs.every((j) => isTerminal(j.status))) break;
		if (deadline && performance.now() > deadline) {
			for (const j of jobs) out(`${j.id} ${j.status}`);
			return EXIT_MAX_WAIT;
		}
		await Bun.sleep(opts.intervalS * 1000);
	}
	for (const j of jobs) {
		emitJob(j, [], opts.json);
		out();
	}
	return jobs.every((j) => j.status === "completed") ? 0 : EXIT_FAILED;
}

async function launch(store: Store, job: Job, values: Values): Promise<number> {
	const pid = spawnRunner(store, job);
	if (values.detach) {
		if (values.json) out(JSON.stringify({ id: job.id, status: "starting", pid }));
		else {
			out(`job ${job.id} started (runner pid ${pid})`);
			out(`  wake me when it needs me: omp-task wait ${job.id}   (run it in the background)`);
			out(`  live feed for Monitor:    omp-task watch ${job.id}`);
		}
		return 0;
	}
	return waitJobs(store, [job.id], {
		intervalS: 0.5,
		maxWaitS: num(values["max-wait"], "--max-wait"),
		json: Boolean(values.json),
		attention: true,
	});
}

// ---------------------------------------------------------------- control

async function control(
	store: Store,
	job: Job,
	kind: CommandKind,
	payload: { message?: string; ref?: string | null; decision?: ApprovalDecision },
): Promise<CommandResult> {
	if (isTerminal(job.status)) throw new UsageError(`job ${job.id} is ${job.status}, not running`);
	const id = store.enqueueCommand(job.id, kind, payload);
	const deadline = performance.now() + CONTROL_TIMEOUT_MS;
	while (performance.now() < deadline) {
		const cmd = store.getCommand(id);
		if (cmd?.result) return cmd.result;
		await Bun.sleep(50);
	}
	return { ok: false, error: "the job's runner did not respond" };
}

function reportControl(result: CommandResult, okText: string): number {
	out(result.ok ? okText : `error: ${result.error}`);
	return result.ok ? 0 : EXIT_FAILED;
}

// ---------------------------------------------------------------- commands

type Command = (store: Store, argv: string[]) => Promise<number> | number;

const commands: Record<string, Command> = {
	async run(store, argv) {
		const { values, positionals } = parse(argv, TASK_OPTIONS);
		const job = createJob(store, jobOptions(values, readText(values, positionals)));
		return launch(store, job, values);
	},

	async continue(store, argv) {
		const { values, positionals } = parse(argv, TASK_OPTIONS);
		const [ref, ...rest] = positionals;
		if (!ref) throw new UsageError("continue needs a job id");
		const parent = resolveJob(store, ref);
		if (!isTerminal(parent.status)) {
			throw new UsageError(
				`job ${parent.id} is still ${parent.status}; use steer/reply/approve, or wait for it`,
			);
		}
		if (!parent.sessionId) throw new UsageError(`job ${parent.id} has no omp session to continue`);
		const job = createJob(store, jobOptions(values, readText(values, rest)), parent);
		return launch(store, job, values);
	},

	async wait(store, argv) {
		const { values, positionals } = parse(argv, {
			interval: { type: "string" },
			"max-wait": { type: "string" },
			"no-attention": { type: "boolean" },
			json: { type: "boolean" },
		});
		if (!positionals.length) throw new UsageError("wait needs at least one job id");
		const ids = positionals.map((p) => resolveJob(store, p).id);
		return waitJobs(store, ids, {
			intervalS: num(values.interval, "--interval") ?? 1,
			maxWaitS: num(values["max-wait"], "--max-wait"),
			json: Boolean(values.json),
			attention: !values["no-attention"],
		});
	},

	async watch(store, argv) {
		const { values, positionals } = parse(argv, {
			"from-start": { type: "boolean" },
			quiet: { type: "boolean", short: "q" },
			interval: { type: "string" },
		});
		if (!positionals.length) throw new UsageError("watch needs at least one job id");
		const ids = positionals.map((p) => resolveJob(store, p).id);
		const interval = (num(values.interval, "--interval") ?? 0.5) * 1000;
		const hidden = new Set(values.quiet ? ["tool", "progress", "steer", "subagent"] : []);
		const seq = new Map<string, number>();
		for (const id of ids) {
			seq.set(id, values["from-start"] ? 0 : store.lastFeedSeq(id));
			if (!values["from-start"]) {
				// Surface anything already waiting on us, so a late watcher does not miss it.
				for (const p of store.listPending(id)) {
					out(
						formatFeed({
							jobId: id,
							ts: p.askedAt,
							kind: p.kind,
							text: p.text,
							data: { options: p.options },
						}),
					);
				}
			}
		}
		while (true) {
			for (const id of ids) {
				for (const e of store.feedSince(id, seq.get(id) ?? 0)) {
					seq.set(id, e.seq);
					if (!hidden.has(e.kind)) out(formatFeed(e));
				}
			}
			const jobs = ids.map((id) => refreshStatus(store, store.getJob(id) as Job));
			if (jobs.every((j) => isTerminal(j.status))) {
				// Drain once more: the done line may have landed after the last read.
				if (ids.every((id) => (seq.get(id) ?? 0) >= store.lastFeedSeq(id))) return 0;
				continue;
			}
			await Bun.sleep(interval);
		}
	},

	async steer(store, argv) {
		const { values, positionals } = parse(argv, MESSAGE_OPTIONS);
		const [ref, ...rest] = positionals;
		if (!ref) throw new UsageError("steer needs a job id");
		const job = resolveJob(store, ref);
		const result = await control(store, job, "steer", { message: readText(values, rest) });
		return reportControl(result, "steer sent");
	},

	async reply(store, argv) {
		const { values, positionals } = parse(argv, { ...MESSAGE_OPTIONS, ref: { type: "string" } });
		const [ref, ...rest] = positionals;
		if (!ref) throw new UsageError("reply needs a job id");
		const job = resolveJob(store, ref);
		const result = await control(store, job, "reply", {
			message: readText(values, rest),
			ref: (values.ref as string | undefined) ?? null,
		});
		return reportControl(result, "answer sent");
	},

	async approve(store, argv) {
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
		const job = resolveJob(store, ref);
		const result = await control(store, job, "approve", {
			decision,
			ref: (values.ref as string | undefined) ?? null,
		});
		return reportControl(result, `${decision} sent`);
	},

	async cancel(store, argv) {
		const { positionals } = parse(argv, {});
		const [ref] = positionals;
		if (!ref) throw new UsageError("cancel needs a job id");
		const job = resolveJob(store, ref);
		if (isTerminal(job.status)) {
			out(`job ${job.id} already ${job.status}`);
			return 0;
		}
		const result = await control(store, job, "abort", {});
		if (result.ok) {
			out(`cancel requested for job ${job.id}`);
			return 0;
		}
		// The runner is unresponsive: stop its process group (omp included) directly.
		for (const pid of [job.runnerPid, job.ompPid]) {
			if (!pidAlive(pid)) continue;
			try {
				process.kill(-(pid as number), "SIGTERM");
			} catch {
				try {
					process.kill(pid as number, "SIGTERM");
				} catch {
					// already gone
				}
			}
		}
		out(`job ${job.id} killed`);
		return 0;
	},

	status(store, argv) {
		const { values, positionals } = parse(argv, { json: { type: "boolean" } });
		const [ref] = positionals;
		if (!ref) throw new UsageError("status needs a job id");
		const job = resolveJob(store, ref);
		const pending = store.listPending(job.id);
		if (isTerminal(job.status) || pending.length) {
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

	result(store, argv) {
		const { values, positionals } = parse(argv, {
			full: { type: "boolean" },
			json: { type: "boolean" },
		});
		const [ref] = positionals;
		if (!ref) throw new UsageError("result needs a job id");
		const job = resolveJob(store, ref);
		emitJob(job, store.listPending(job.id), Boolean(values.json), Boolean(values.full));
		return 0;
	},

	list(store, argv) {
		const { values } = parse(argv, {
			limit: { type: "string", short: "n" },
			cwd: { type: "string", short: "C" },
			status: { type: "string" },
			json: { type: "boolean" },
		});
		const status = values.status as string | undefined;
		const known = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES] as string[];
		if (status && !known.includes(status)) {
			throw new UsageError(`--status must be one of ${known.join(", ")}`);
		}
		const opts: { limit: number; cwd?: string; status?: string } = {
			limit: num(values.limit, "--limit") ?? 20,
		};
		if (values.cwd) opts.cwd = resolve(values.cwd as string);
		if (status) opts.status = status;
		const rows = store.listJobs(opts).map((j) => refreshStatus(store, j));
		if (values.json) {
			out(
				JSON.stringify(
					rows.map((j) => ({
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
		for (const j of rows)
			out(`${j.id}  ${j.status.padEnd(9)}  ${j.title.slice(0, 60)}  [${j.cwd}]`);
		if (!rows.length) out("(no jobs)");
		return 0;
	},

	doctor() {
		const bin = ompBin();
		out(`omp binary:   ${bin ?? "NOT FOUND"}`);
		if (bin) {
			const p = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
			out(`omp version:  ${p.stdout.toString().trim()}`);
		}
		out(`bun:          ${Bun.version}`);
		out(`state dir:    ${stateDir()}`);
		const cfg = configFile();
		const present = existsSync(cfg);
		out(`config:       ${cfg} (${present ? "present" : "absent, using defaults"})`);
		const presets = Object.keys(loadConfig().presets ?? {});
		if (presets.length) out(`presets:      ${presets.join(", ")}`);
		const preamble = existsSync(PREAMBLE_FILE);
		out(`preamble:     ${PREAMBLE_FILE} (${preamble ? "ok" : "missing"})`);
		return bin ? 0 : EXIT_FAILED;
	},

	/** Internal: the detached runner for one job. */
	async _run(store, argv) {
		const [id] = argv;
		if (!id) throw new UsageError("_run needs a job id");
		const runner = new JobRunner(store, id);
		process.on("SIGTERM", () => runner.cancel());
		process.on("SIGINT", () => runner.cancel());
		await runner.run();
		return 0;
	},
};

export async function main(argv: string[]): Promise<number> {
	const [name, ...rest] = argv;
	if (!name || name === "-h" || name === "--help" || name === "help") {
		out(HELP);
		return name ? 0 : 2;
	}
	if (name === "--version" || name === "-V") {
		out(`omp-task ${VERSION}`);
		return 0;
	}
	const command = commands[name];
	if (!command) {
		process.stderr.write(`omp-task: unknown command '${name}' (see omp-task --help)\n`);
		return 2;
	}
	const store = new Store();
	try {
		return await command(store, rest);
	} catch (e) {
		if (e instanceof UsageError) {
			process.stderr.write(`omp-task: ${e.message}\n`);
			return 2;
		}
		throw e;
	} finally {
		store.close();
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
