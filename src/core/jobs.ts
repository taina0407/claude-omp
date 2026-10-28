/** Creating jobs, starting their runners, and keeping their records honest. */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPreset, loadConfig, pickSetting, type Settings } from "./config";
import { CLI_ENTRY, jobDir } from "./paths";
import type { Store } from "./store";
import { ACCESS_LEVELS, type Access, isActive, type Job, type JobSpec } from "./types";
import {
	firstLine,
	newJobId,
	nowIso,
	parseDuration,
	pidAlive,
	shellSplit,
	UsageError,
} from "./util";

export interface JobOptions {
	prompt: string;
	model?: string | undefined;
	preset?: string | undefined;
	access?: string | undefined;
	thinking?: string | undefined;
	timeout?: string | undefined;
	answerTimeout?: string | undefined;
	approvalTimeout?: string | undefined;
	cwd?: string | undefined;
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
	const cwd = resolve(opts.cwd ?? parent?.cwd ?? process.cwd());
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
		addDirs: (opts.addDirs ?? []).map((d) => resolve(d)),
		files: (opts.files ?? []).map((f) => resolve(f)),
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

/** Starts the detached runner process for a queued job; returns its pid. */
export function spawnRunner(store: Store, job: Job): number {
	const log = openSync(join(jobDir(job.id), "runner.log"), "a");
	const child = spawn(process.execPath, [CLI_ENTRY, "_run", job.id], {
		detached: true,
		stdio: ["ignore", log, log],
		env: process.env,
	});
	closeSync(log);
	child.unref();
	const pid = child.pid ?? 0;
	store.updateJob(job.id, { status: "starting", runnerPid: pid });
	return pid;
}

/** A job whose runner died without finishing it is reported as failed (v0.2 behaviour). */
export function refreshStatus(store: Store, job: Job): Job {
	if (isActive(job.status) && job.status !== "queued" && !pidAlive(job.runnerPid)) {
		// The runner may have finished between our read and the pid check.
		const latest = store.getJob(job.id) ?? job;
		if (!isActive(latest.status)) return latest;
		store.clearPending(job.id);
		store.updateJob(job.id, {
			status: "failed",
			finishedAt: nowIso(),
			errors: [...latest.errors, "runner exited without recording a result"].slice(-5),
			runnerPid: null,
		});
		store.appendFeed(job.id, "done", "failed", {
			changed_files: latest.changedFiles,
			cost_usd: latest.costUsd,
		});
		return store.getJob(job.id) as Job;
	}
	return job;
}

export function resolveJob(store: Store, idPart: string): Job {
	const ids = store.findJobIds(idPart);
	if (ids.length === 0) throw new UsageError(`no job matching '${idPart}'`);
	if (ids.length > 1)
		throw new UsageError(`'${idPart}' is ambiguous: ${ids.slice(0, 5).join(", ")}`);
	return refreshStatus(store, store.getJob(ids[0] as string) as Job);
}
