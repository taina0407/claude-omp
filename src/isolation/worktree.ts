/**
 * Worktree isolation: a job can run in a private checkout of the user's git repo (under the state
 * dir), so its changes stay out of the main checkout until `omp-task apply` (or `discard`).
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { gitRoot } from "../core/git";
import { stateDir } from "../core/paths";
import type { Job } from "../core/types";

interface GitResult {
	ok: boolean;
	out: Buffer;
	err: string;
}

function git(args: string[], cwd: string, input?: Uint8Array): GitResult {
	const p = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		...(input ? { stdin: input } : {}),
	});
	return { ok: p.exitCode === 0, out: p.stdout, err: p.stderr.toString() };
}

/** The repo's HEAD commit, or null when it has none yet. */
function head(repoRoot: string): string | null {
	const r = git(["rev-parse", "--verify", "HEAD"], repoRoot);
	return r.ok ? r.out.toString().trim() : null;
}

/** Whether `cwd` is in a git repo with a commit: only then can `auto` pick a worktree. */
export function canIsolate(cwd: string): boolean {
	const root = gitRoot(cwd);
	return root !== null && head(root) !== null;
}

/** The same relative position inside the worktree as `job.cwd` has inside `repoRoot`. */
export function worktreeCwd(job: Job): string {
	if (!job.worktreePath || !job.repoRoot) return job.cwd;
	return sameSpot(job.repoRoot, job.worktreePath, job.cwd);
}

function sameSpot(root: string, worktree: string, cwd: string): string {
	const rel = relative(root, cwd);
	return rel ? join(worktree, rel) : worktree;
}

export interface Worktree {
	path: string;
	branch: string;
	baseRef: string;
	repoRoot: string;
	/** Where the worker should start: `job.cwd`'s place inside the worktree. */
	cwd: string;
}

export function createWorktree(job: Job): Worktree {
	const repoRoot = gitRoot(job.cwd);
	if (!repoRoot) throw new Error(`not a git repository: ${job.cwd}`);
	const baseRef = head(repoRoot);
	if (!baseRef) throw new Error(`${repoRoot} has no commits; a worktree needs at least one`);
	const path = join(stateDir(), "worktrees", job.id);
	const branch = `omp/${job.id}`;
	mkdirSync(dirname(path), { recursive: true });
	const add = git(["worktree", "add", "-b", branch, path, baseRef], repoRoot);
	if (!add.ok) throw new Error(`git worktree add failed: ${add.err.trim()}`);
	if (job.carryDirty) carryDirty(repoRoot, path);
	return { path, branch, baseRef, repoRoot, cwd: sameSpot(repoRoot, path, job.cwd) };
}

/** Brings the main checkout's uncommitted changes into the worktree: tracked and untracked. */
function carryDirty(repoRoot: string, path: string): void {
	const diff = git(["diff", "--binary", "HEAD"], repoRoot);
	if (!diff.ok) throw new Error(`git diff failed: ${diff.err.trim()}`);
	if (diff.out.length) {
		const applied = git(["apply", "--binary"], path, diff.out);
		if (!applied.ok) throw new Error(`git apply failed: ${applied.err.trim()}`);
	}
	const others = git(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot);
	if (!others.ok) throw new Error(`git ls-files failed: ${others.err.trim()}`);
	for (const rel of others.out.toString().split("\0").filter(Boolean)) {
		const dest = join(path, rel);
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(join(repoRoot, rel), dest);
	}
}

/** Stages everything in the worktree and returns its diff against the base commit. */
function patchBytes(job: Job): { bytes: Buffer; files: string[] } {
	const path = job.worktreePath;
	if (!path) throw new Error(`job ${job.id} has no worktree`);
	if (!job.baseRef) throw new Error(`job ${job.id} has no base commit`);
	const staged = git(["add", "-A"], path);
	if (!staged.ok) throw new Error(`git add failed: ${staged.err.trim()}`);
	const diff = git(["diff", "--cached", "--binary", job.baseRef], path);
	if (!diff.ok) throw new Error(`git diff failed: ${diff.err.trim()}`);
	const names = git(["diff", "--cached", "--name-only", job.baseRef], path);
	if (!names.ok) throw new Error(`git diff --name-only failed: ${names.err.trim()}`);
	return {
		bytes: diff.out,
		files: names.out.toString().split("\n").filter(Boolean),
	};
}

/** The worktree's changes as a binary-safe patch (untracked and binary files included). */
export function worktreePatch(job: Job): { patch: string; files: string[] } {
	const { bytes, files } = patchBytes(job);
	return { patch: bytes.toString(), files };
}

export interface ApplyResult {
	ok: boolean;
	files: string[];
	error?: string;
	/** With --3way: files left with conflict markers in the main checkout. */
	conflicts?: string[];
}

/**
 * Applies the worktree's changes to the main checkout. Checks first, so a patch that does not
 * apply leaves the main checkout untouched.
 */
export function applyWorktree(job: Job, opts: { threeWay: boolean }): ApplyResult {
	const repoRoot = job.repoRoot;
	if (!repoRoot) return { ok: false, files: [], error: `job ${job.id} has no repository root` };
	const { bytes, files } = patchBytes(job);
	if (!bytes.length) return { ok: true, files: [] };
	const file = join(tmpdir(), `omp-task-${job.id}-${crypto.randomUUID()}.patch`);
	writeFileSync(file, bytes);
	const flags = ["apply", "--binary", ...(opts.threeWay ? ["--3way"] : [])];
	try {
		const check = git([...flags, "--check", file], repoRoot);
		if (!check.ok) return { ok: false, files, error: check.err.trim() || check.out.toString() };
		const applied = git([...flags, file], repoRoot);
		if (applied.ok) return { ok: true, files };
		// A plain apply that passed --check does not fail half-way. A --3way one does, on purpose:
		// `--check` passes with merge conflicts, and the real apply leaves conflict markers in place.
		const unmerged = git(["diff", "--name-only", "--diff-filter=U"], repoRoot);
		const conflicts = unmerged.out.toString().split("\n").filter(Boolean);
		if (!conflicts.length) return { ok: false, files, error: applied.err.trim() };
		return {
			ok: false,
			files,
			conflicts,
			error:
				`applied with conflicts in ${conflicts.join(", ")}: resolve the markers and \`git add\` ` +
				`them, or undo with \`git checkout HEAD -- ${conflicts.join(" ")}\``,
		};
	} finally {
		rmSync(file, { force: true });
	}
}

/** Removes the worktree and its branch; safe to call twice. */
export function removeWorktree(job: Job): void {
	const path = job.worktreePath;
	if (!path) return;
	const repoRoot = job.repoRoot ?? gitRoot(job.cwd);
	if (!repoRoot) return;
	git(["worktree", "remove", "--force", path], repoRoot); // already gone: git says so, we ignore it
	if (job.branch) git(["branch", "-D", job.branch], repoRoot);
	git(["worktree", "prune"], repoRoot);
	rmSync(path, { recursive: true, force: true });
}
