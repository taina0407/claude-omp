/**
 * Housekeeping: finished jobs older than the retention period are deleted with their files.
 * Jobs that still own a worktree are kept until it is applied, discarded or pruned.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { jobDir, stateDir } from "../core/paths";
import type { Store } from "../core/store";
import { isTerminal } from "../core/types";

export const DEFAULT_RETENTION_S = 30 * 86_400;

/** Deletes finished jobs that ended more than `olderS` ago; returns their ids. */
export function collectGarbage(store: Store, olderS: number, dryRun = false): string[] {
	const cutoff = Date.now() - olderS * 1000;
	const removed: string[] = [];
	for (const job of store.listJobs({ limit: 1_000_000 })) {
		if (!isTerminal(job.status) || job.worktreePath) continue;
		const ended = Date.parse(job.finishedAt ?? job.createdAt);
		if (!Number.isFinite(ended) || ended > cutoff) continue;
		if (!dryRun) {
			store.deleteJob(job.id);
			rmSync(jobDir(job.id), { recursive: true, force: true });
		}
		removed.push(job.id);
	}
	if (!dryRun) {
		// Stop-gate bookkeeping (one small file per Claude session).
		const dir = join(stateDir(), "stop-gate");
		try {
			for (const f of readdirSync(dir)) {
				const path = join(dir, f);
				if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
			}
		} catch {
			// no stop-gate state yet
		}
	}
	return removed;
}
