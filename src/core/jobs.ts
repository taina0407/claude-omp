/** Creating jobs and finding them by (partial) id. */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPreset, loadConfig, pickSetting, type Settings } from "./config";
import { jobDir } from "./paths";
import type { Store } from "./store";
import { ACCESS_LEVELS, type Access, type Job, type JobSpec } from "./types";
import { firstLine, newJobId, parseDuration, shellSplit, UsageError } from "./util";

export interface JobOptions {
	prompt: string;
	model?: string | undefined;
	preset?: string | undefined;
	access?: string | undefined;
	thinking?: string | undefined;
	timeout?: string | undefined;
	answerTimeout?: string | undefined;
	approvalTimeout?: string | undefined;
	/** Absolute; defaults to the parent's cwd for `continue`, then to `clientCwd`. */
	cwd?: string | undefined;
	/** The CLI's working directory (the daemon runs elsewhere). */
	clientCwd: string;
	addDirs?: string[] | undefined;
	files?: string[] | undefined;
	title?: string | undefined;
	ompArgs?: string | undefined;
	noPreamble?: boolean | undefined;
}

function settingsOf(job: Job): Settings {
	const s: Settings = { access: job.access };
	if (job.model) s.model = job.model;
	if (job.thinking) s.thinking = job.thinking;
	if (job.timeoutS) s.timeout = job.timeoutS;
	if (job.answerTimeoutS) s.answer_timeout = job.answerTimeoutS;
	if (job.approvalTimeoutS) s.approval_timeout = job.approvalTimeoutS;
	return s;
}

/** Resolves flags, preset, parent and config defaults into a new queued job. */
export function createJob(store: Store, opts: JobOptions, parent: Job | null = null): Job {
	const config = loadConfig();
	const preset = opts.preset ? getPreset(config, opts.preset) : {};
	const pick = <K extends keyof Settings>(
		key: K,
		flag: Settings[K] | undefined,
		fallback?: Settings[K],
	): Settings[K] | undefined =>
		pickSetting(
			key,
			{
				flag,
				preset,
				parent: parent ? settingsOf(parent) : undefined,
				defaults: config.defaults ?? {},
			},
			fallback,
		);

	const access = pick("access", opts.access as Access | undefined, "edit");
	if (!ACCESS_LEVELS.includes(access as Access)) {
		throw new UsageError(`access must be one of ${ACCESS_LEVELS.join(", ")}`);
	}
	const cwd = resolve(opts.clientCwd, opts.cwd ?? parent?.cwd ?? ".");
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
		throw new UsageError(`cwd does not exist: ${cwd}`);
	}
	const spec: JobSpec = {
		title: opts.title ?? firstLine(opts.prompt),
		cwd,
		access: access as Access,
		model: pick("model", opts.model) ?? null,
		thinking: pick("thinking", opts.thinking) ?? null,
		timeoutS: parseDuration(pick("timeout", opts.timeout, "30m")),
		answerTimeoutS: parseDuration(pick("answer_timeout", opts.answerTimeout, "20m")),
		approvalTimeoutS: parseDuration(pick("approval_timeout", opts.approvalTimeout, "20m")),
		addDirs: (opts.addDirs ?? []).map((d) => resolve(opts.clientCwd, d)),
		files: (opts.files ?? []).map((f) => resolve(opts.clientCwd, f)),
		extraArgs: shellSplit(pick("omp_args", opts.ompArgs, "") ?? ""),
		noPreamble: Boolean(opts.noPreamble),
		parentId: parent?.id ?? null,
		resumeSession: parent?.sessionId ?? null,
	};
	const id = newJobId();
	mkdirSync(jobDir(id), { recursive: true });
	writeFileSync(join(jobDir(id), "prompt.md"), opts.prompt);
	return store.createJob(id, spec);
}

export class NotFoundError extends UsageError {}

export function resolveJob(store: Store, idPart: string): Job {
	const ids = store.findJobIds(idPart);
	if (ids.length === 0) throw new NotFoundError(`no job matching '${idPart}'`);
	if (ids.length > 1) {
		throw new UsageError(`'${idPart}' is ambiguous: ${ids.slice(0, 5).join(", ")}`);
	}
	return store.getJob(ids[0] as string) as Job;
}
