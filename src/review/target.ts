/**
 * What a review looks at: the diff of uncommitted changes (default), the staged changes, the
 * changes since a base ref, one commit, or a worktree job's changes.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitRoot } from "../core/git";
import type { Job } from "../core/types";
import { UsageError } from "../core/util";
import { worktreeCwd, worktreePatch } from "../isolation/worktree";

export type ReviewTarget =
	| { kind: "uncommitted" }
	| { kind: "staged" }
	| { kind: "base"; ref: string }
	| { kind: "commit"; ref: string }
	| { kind: "job"; job: Job };

export interface CollectedDiff {
	/** Human description, e.g. "changes since main (merge-base 1a2b3c4)". */
	label: string;
	diff: string;
	files: string[];
	/** Where the reviewer should read files: the repository, or the job's worktree. */
	cwd: string;
}

/** Untracked text files larger than this are listed but not inlined. */
const UNTRACKED_MAX_BYTES = 100_000;

function git(args: string[], cwd: string, okCodes = [0]): string {
	const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (!okCodes.includes(p.exitCode ?? -1)) {
		throw new UsageError(`git ${args.join(" ")}: ${p.stderr.toString().trim()}`);
	}
	return p.stdout.toString();
}

function hasCommit(root: string): boolean {
	return (
		Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd: root }).exitCode === 0
	);
}

/** HEAD, or the empty tree in a repository without commits. */
function headOrEmpty(root: string): string {
	return hasCommit(root) ? "HEAD" : git(["hash-object", "-t", "tree", "/dev/null"], root).trim();
}

function untrackedDiff(root: string): string {
	const files = git(["ls-files", "--others", "--exclude-standard", "-z"], root)
		.split("\0")
		.filter(Boolean);
	return files
		.map((f) => {
			const path = join(root, f);
			if (!existsSync(path) || statSync(path).size > UNTRACKED_MAX_BYTES) {
				return `diff --git a/${f} b/${f}\nnew file (not shown: too large)\n`;
			}
			// --no-index exits 1 when the files differ, which they always do here.
			return git(["diff", "--no-index", "--", "/dev/null", f], root, [0, 1]);
		})
		.join("");
}

export function changedFilesOf(diff: string): string[] {
	const files = new Set<string>();
	for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) files.add(m[2] as string);
	return [...files];
}

export function collectDiff(target: ReviewTarget, cwd: string): CollectedDiff {
	if (target.kind === "job") {
		const job = target.job;
		if (!job.worktreePath) {
			throw new UsageError(`job ${job.id} did not run in a worktree; review its checkout instead`);
		}
		const { patch, files } = worktreePatch(job);
		if (!files.length) throw new UsageError(`nothing to review: job ${job.id} changed no files`);
		return {
			label: `the changes of job ${job.id} (${job.title})`,
			diff: patch,
			files,
			cwd: worktreeCwd(job),
		};
	}
	const root = gitRoot(cwd);
	if (!root) throw new UsageError(`not a git repository: ${cwd}`);
	let label: string;
	let diff: string;
	switch (target.kind) {
		case "uncommitted":
			label = "the uncommitted changes";
			diff = git(["diff", headOrEmpty(root)], root) + untrackedDiff(root);
			break;
		case "staged":
			label = "the staged changes";
			diff = git(["diff", "--cached", headOrEmpty(root)], root);
			break;
		case "base": {
			const base = git(["merge-base", target.ref, "HEAD"], root).trim();
			label = `the changes since ${target.ref} (merge-base ${base.slice(0, 8)}), including uncommitted ones`;
			diff = git(["diff", base], root) + untrackedDiff(root);
			break;
		}
		case "commit": {
			const subject = git(["log", "-1", "--format=%h %s", target.ref], root).trim();
			label = `commit ${subject} (the files on disk may be newer than this commit)`;
			diff = git(["show", "--format=commit %H%nAuthor: %an%n%n%B", "--patch", target.ref], root);
			break;
		}
	}
	const files = changedFilesOf(diff);
	if (!files.length) throw new UsageError(`nothing to review: no changes in ${label}`);
	return { label, diff, files, cwd: root };
}
