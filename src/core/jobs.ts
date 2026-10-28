/** Creating jobs and finding them by (partial) id. */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canIsolate } from "../isolation/worktree";
import type { ReviewSpec } from "../review/schema";
import { getPreset, loadConfig, pickSetting, type Settings } from "./config";
import { gitRoot } from "./git";
import { jobDir } from "./paths";
import type { Store } from "./store";
import {
	ACCESS_LEVELS,
	type Access,
	ISOLATE_MODES,
	type IsolateMode,
	type Isolation,
	type Job,
	type JobSpec,
} from "./types";
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
	/** auto (default) | worktree | none; `continue` inherits the parent's instead. */
	isolate?: string | undefined;
	carryDirty?: boolean | undefined;
	/** Jobs (ids or unique parts of ids) that must end before this one starts. */
	after?: string[] | undefined;
	/** Start once the dependencies end, even if one did not complete. */
	afterAny?: boolean | undefined;
	group?: string | undefined;
	/** USD; the job is stopped as `over_budget` when it spends more. */
	budget?: string | number | undefined;
	allow?: string[] | undefined;
	deny?: string[] | undefined;
	stallTimeout?: string | undefined;
	/** Makes this a review job (set by `omp-task review`, not by `run`). */
	review?: ReviewSpec | undefined;
	/**
	 * Files written into the job directory before the job starts (name → content). The job dir
	 * is then readable by the worker, and `{{job_dir}}` in the prompt names it.
	 */
	attachments?: Record<string, string> | undefined;
	/** Set by the CLI from OMP_TASK_CLAUDE_SESSION (written by the SessionStart hook). */
	claudeSession?: string | undefined;
}

function settingsOf(job: Job): Settings {
	const s: Settings = { access: job.access };
	if (job.model) s.model = job.model;
	if (job.thinking) s.thinking = job.thinking;
	if (job.timeoutS) s.timeout = job.timeoutS;
	if (job.answerTimeoutS) s.answer_timeout = job.answerTimeoutS;
	if (job.approvalTimeoutS) s.approval_timeout = job.approvalTimeoutS;
	if (job.stallTimeoutS) s.stall_timeout = job.stallTimeoutS;
	if (job.budgetUsd) s.budget = job.budgetUsd;
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
	const isolate = resolveIsolation(pick, opts, parent, cwd, access as Access);
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
		isolate,
		carryDirty: Boolean(opts.carryDirty),
		after: [...new Set((opts.after ?? []).map((ref) => resolveJob(store, ref).id))],
		afterAny: Boolean(opts.afterAny),
		groupName: opts.group ?? parent?.groupName ?? null,
		budgetUsd: parseBudget(pick("budget", undefined) ?? null, opts.budget),
		// Rules add up: config defaults, the preset, the parent job's rules, then the flags.
		allow: unique([
			...(config.defaults?.allow ?? []),
			...(preset.allow ?? []),
			...(parent?.allow ?? []),
			...(opts.allow ?? []),
		]),
		deny: unique([
			...(config.defaults?.deny ?? []),
			...(preset.deny ?? []),
			...(parent?.deny ?? []),
			...(opts.deny ?? []),
		]),
		stallTimeoutS: parseDuration(pick("stall_timeout", opts.stallTimeout, "10m")),
	};
	if (spec.groupName && !/^[\w.-]{1,64}$/.test(spec.groupName)) {
		throw new UsageError("group names use letters, digits, '.', '-' and '_' (at most 64)");
	}
	if (opts.review) spec.review = opts.review;
	spec.claudeSession = opts.claudeSession ?? parent?.claudeSession ?? null;
	const id = newJobId();
	const dir = jobDir(id);
	mkdirSync(dir, { recursive: true });
	let prompt = opts.prompt;
	if (opts.attachments) {
		for (const [name, content] of Object.entries(opts.attachments)) {
			if (name.includes("/") || name.startsWith("."))
				throw new UsageError(`bad attachment ${name}`);
			writeFileSync(join(dir, name), content);
		}
		prompt = prompt.replaceAll("{{job_dir}}", dir);
		spec.addDirs = [...spec.addDirs, dir];
	}
	writeFileSync(join(dir, "prompt.md"), prompt);
	const job = store.createJob(id, spec);
	if (!parent) return job;
	// A continued job keeps working in the parent's worktree, so it sees the parent's changes.
	store.updateJob(id, {
		worktreePath: parent.worktreePath,
		baseRef: parent.baseRef,
		branch: parent.branch,
		repoRoot: parent.repoRoot,
	});
	return store.getJob(id) as Job;
}

const unique = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** `--budget` wins over the preset/default `budget`; both are USD amounts. */
function parseBudget(fallback: number | null, flag: string | number | undefined): number | null {
	if (flag === undefined || flag === "") return fallback;
	const n = Number(String(flag).replace(/^\$/, ""));
	if (!Number.isFinite(n) || n <= 0) throw new UsageError("--budget must be a positive USD amount");
	return n;
}

function resolveIsolation(
	pick: <K extends keyof Settings>(
		key: K,
		flag: Settings[K] | undefined,
		fallback?: Settings[K],
	) => Settings[K] | undefined,
	opts: JobOptions,
	parent: Job | null,
	cwd: string,
	access: Access,
): Isolation {
	if (parent) return parent.isolate;
	const requested = pick("isolate", opts.isolate as IsolateMode | undefined, "auto") ?? "auto";
	if (!ISOLATE_MODES.includes(requested as IsolateMode)) {
		throw new UsageError(`isolate must be one of ${ISOLATE_MODES.join(", ")}`);
	}
	if (requested === "none") return "none";
	if (requested === "worktree") {
		if (!gitRoot(cwd)) throw new UsageError("--isolate worktree needs a git repository");
		if (!canIsolate(cwd)) {
			throw new UsageError("--isolate worktree needs a git repository with at least one commit");
		}
		return "worktree";
	}
	// auto: a full-access run in a repo with a commit gets its own checkout.
	return access === "full" && canIsolate(cwd) ? "worktree" : "none";
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
