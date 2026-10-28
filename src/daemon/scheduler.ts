/**
 * Decides which waiting jobs move on: a `blocked` job is released (or skipped) once its
 * dependencies end, and a `queued` job starts when the global, group and per-checkout limits
 * leave room, unless its group or the day has already spent its budget. An interrupted job keeps
 * its slot until it is resumed or cancelled, so a daemon restart does not hand it to a queued job.
 */
import type { Config } from "../core/config";
import { gitRoot } from "../core/git";
import type { Store } from "../core/store";
import type { Job, JobStatus } from "../core/types";
import { isTerminal } from "../core/types";
import { isoAt } from "../core/util";

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_WRITERS_PER_REPO = 1;

export type Decision =
	| { action: "release"; job: Job }
	| { action: "start"; job: Job }
	| { action: "skip"; job: Job; reason: string }
	| { action: "over_budget"; job: Job; reason: string };

export interface GroupLimits {
	maxConcurrent: number | null;
	budgetUsd: number | null;
}

/** Limits of a group: those stored by `plan apply` win over the config's `groups` block. */
export function groupLimits(store: Store, config: Config, name: string): GroupLimits {
	const stored = store.getGroup(name);
	const configured = config.groups?.[name];
	return {
		maxConcurrent: stored?.maxConcurrent ?? configured?.max_concurrent ?? null,
		budgetUsd: stored?.budgetUsd ?? configured?.budget_usd ?? null,
	};
}

/** Start of the current local day, in the store's timestamp format. */
export function startOfToday(now = new Date()): string {
	return isoAt(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
}

/**
 * Why a job may not spend more: its group or the day reached its budget. `starting` is true
 * before a job runs (reaching the limit is enough), false while it runs (exceeding it is).
 */
export function budgetBlock(
	store: Store,
	config: Config,
	job: Job,
	starting: boolean,
): string | null {
	const over = (spent: number, limit: number) => (starting ? spent >= limit : spent > limit);
	if (job.groupName) {
		const limit = groupLimits(store, config, job.groupName).budgetUsd;
		const spent = limit !== null ? store.spentUsd({ group: job.groupName }) : 0;
		if (limit !== null && over(spent, limit)) {
			return `group ${job.groupName} spent $${spent.toFixed(4)} of its $${limit} budget`;
		}
	}
	const daily = config.daily_budget_usd;
	if (daily !== undefined) {
		const spent = store.spentUsd({ sinceIso: startOfToday() });
		if (over(spent, daily))
			return `today's jobs spent $${spent.toFixed(4)} of the $${daily} daily budget`;
	}
	return null;
}

/** A job that edits the user's checkout directly; such jobs take turns per checkout. */
function isWriter(job: Job): boolean {
	return job.isolate === "none" && job.access !== "read";
}

/** The decisions for one pass, in job order; `running` are the jobs the daemon runs now. */
export function schedule(store: Store, config: Config, running: Job[]): Decision[] {
	const decisions: Decision[] = [];
	const status = new Map<string, JobStatus>();
	const statusOf = (id: string) => status.get(id) ?? store.getJob(id)?.status ?? null;
	const repoCache = new Map<string, string>();
	const repoOf = (job: Job) => {
		if (job.repoRoot) return job.repoRoot;
		let root = repoCache.get(job.cwd);
		if (root === undefined) {
			root = gitRoot(job.cwd) ?? job.cwd;
			repoCache.set(job.cwd, root);
		}
		return root;
	};
	const ids = new Set(running.map((j) => j.id));
	const interrupted = store
		.listJobs({ limit: 10_000, status: "interrupted" })
		.filter((j) => !ids.has(j.id));
	const active = [...running, ...interrupted];
	const maxConcurrent = config.max_concurrent ?? DEFAULT_MAX_CONCURRENT;
	const maxWriters = config.max_writers_per_repo ?? DEFAULT_MAX_WRITERS_PER_REPO;

	// Ids sort by creation and dependencies exist before their dependents, so one pass in id
	// order also carries a skip down a chain.
	for (const job of store.unfinishedJobs()) {
		if (job.status === "blocked") {
			const deps = job.after.map((id) => ({ id, status: statusOf(id) }));
			const missing = deps.find((d) => d.status === null);
			if (missing) {
				decisions.push({
					action: "skip",
					job,
					reason: `dependency ${missing.id} no longer exists`,
				});
				status.set(job.id, "skipped");
				continue;
			}
			if (!deps.every((d) => isTerminal(d.status as string))) continue;
			const bad = deps.find((d) => d.status !== "completed");
			if (bad && !job.afterAny) {
				decisions.push({ action: "skip", job, reason: `dependency ${bad.id} ended ${bad.status}` });
				status.set(job.id, "skipped");
				continue;
			}
			decisions.push({ action: "release", job });
			status.set(job.id, "queued");
		}
		const budget = budgetBlock(store, config, job, true);
		if (budget) {
			decisions.push({ action: "over_budget", job, reason: budget });
			status.set(job.id, "over_budget");
			continue;
		}
		if (active.length >= maxConcurrent) continue;
		if (job.groupName) {
			const limit = groupLimits(store, config, job.groupName).maxConcurrent;
			const inGroup = active.filter((j) => j.groupName === job.groupName).length;
			if (limit !== null && inGroup >= limit) continue;
		}
		if (isWriter(job)) {
			const repo = repoOf(job);
			const writers = active.filter((j) => isWriter(j) && repoOf(j) === repo).length;
			if (writers >= maxWriters) continue;
		}
		decisions.push({ action: "start", job });
		status.set(job.id, "starting");
		active.push(job);
	}
	return decisions;
}
