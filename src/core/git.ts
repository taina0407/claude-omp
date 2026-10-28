/**
 * Changed-file detection: snapshot the dirty files (path → blob hash) before and after a job and
 * compare. Works without commits and without touching the index.
 */
import { existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type Snapshot = Record<string, string>;

function git(args: string[], cwd: string): { ok: boolean; out: string } {
	const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
	return { ok: p.exitCode === 0, out: p.stdout.toString() };
}

export function gitRoot(cwd: string): string | null {
	const r = git(["rev-parse", "--show-toplevel"], cwd);
	return r.ok ? r.out.trim() : null;
}

export function snapshot(cwd: string): Snapshot | null {
	const root = gitRoot(cwd);
	if (!root) return null;
	const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root).out;
	const entries = status.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i] as string;
		if (entry.length <= 3) continue;
		paths.push(entry.slice(3));
		if (entry[0] === "R" || entry[0] === "C") i++; // rename/copy: next entry is the source
	}
	const snap: Snapshot = {};
	const files = paths.filter((p) => {
		const full = join(root, p);
		return existsSync(full) && statSync(full).isFile();
	});
	for (const p of paths) snap[p] = "<deleted>";
	if (files.length) {
		const hashes = git(["hash-object", "--", ...files], root)
			.out.trim()
			.split("\n");
		files.forEach((p, i) => {
			snap[p] = hashes[i] ?? "";
		});
	}
	return snap;
}

export function changedFiles(before: Snapshot | null, after: Snapshot | null): string[] | null {
	if (!before || !after) return null;
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys].filter((k) => before[k] !== after[k]).sort();
}

/** Drops our own state files when the state dir happens to live inside the repo. */
export function withoutDir(files: string[] | null, cwd: string, dir: string): string[] | null {
	const root = gitRoot(cwd);
	if (!files || !root) return files;
	const rel = relative(resolve(root), resolve(dir));
	if (rel.startsWith("..") || rel === "") return files;
	return files.filter((f) => !f.startsWith(`${rel}/`));
}
