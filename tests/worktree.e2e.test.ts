/**
 * Worktree isolation: a worker writes in its own checkout under the state dir, and the
 * orchestrator inspects, applies, discards or prunes it afterwards.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type JobJson, Sandbox } from "./helpers";

setDefaultTimeout(60_000);

let sb: Sandbox;

beforeEach(() => {
	sb = new Sandbox();
});

afterEach(async () => {
	await sb.dispose();
});

describe("worktree isolation", () => {
	test("a worktree job leaves the main checkout untouched and reports its own changes", async () => {
		sb.commitAll();
		const out = await sb.runJson(["--isolate", "worktree", "WRITE new.txt please"]);
		expect(out.status).toBe("completed");
		expect(out.isolate).toBe("worktree");
		expect(out.changed_files).toEqual(["new.txt"]);
		expect(out.worktree).toBe(join(sb.stateDir, "worktrees", out.id));
		expect(existsSync(join(sb.repo, "new.txt"))).toBe(false);
		expect(existsSync(join(out.worktree as string, "new.txt"))).toBe(true);

		const { stdout } = await sb.cli(["diff", out.id, "--stat"]);
		expect(stdout.trim().split("\n")).toContain("new.txt");
		const patch = await sb.cli(["diff", out.id]);
		expect(patch.stdout).toContain("new.txt");
	});

	test("apply brings the changes into the main checkout and removes the worktree", async () => {
		sb.commitAll();
		const out = await sb.runJson(["--isolate", "worktree", "WRITE new.txt please"]);
		const path = out.worktree as string;
		const applied = await sb.cli(["apply", out.id]);
		expect(applied.stdout).toContain("applied 1 file(s)");
		expect(applied.stdout).toContain("new.txt");
		expect(readFileSync(join(sb.repo, "new.txt"), "utf8")).toBe("written by fake omp\n");
		expect(existsSync(path)).toBe(false);
		expect(sb.job(out.id)?.worktreePath).toBeNull();
	});

	test("access full alone picks a worktree; the default access does not", async () => {
		sb.commitAll();
		const full = await sb.runJson(["-a", "full", "WRITE auto.txt please"]);
		expect(full.isolate).toBe("worktree");
		expect(existsSync(join(sb.repo, "auto.txt"))).toBe(false);

		const plain = await sb.runJson(["WRITE plain.txt please"]);
		expect(plain.isolate).toBe("none");
		expect(existsSync(join(sb.repo, "plain.txt"))).toBe(true);
	});

	test("a conflicting main-checkout change makes apply fail and changes nothing", async () => {
		sb.commitAll();
		const out = await sb.runJson(["--isolate", "worktree", "WRITE existing.txt please"]);
		writeFileSync(join(sb.repo, "existing.txt"), "main edit\n");
		const applied = await sb.cli(["apply", out.id], [1]);
		expect(applied.stdout).toContain("error:");
		expect(readFileSync(join(sb.repo, "existing.txt"), "utf8")).toBe("main edit\n");
		expect(existsSync(out.worktree as string)).toBe(true);
	});

	test("--3way on a committed conflict leaves markers and names the conflicted files", async () => {
		sb.commitAll();
		const out = await sb.runJson(["--isolate", "worktree", "WRITE existing.txt please"]);
		writeFileSync(join(sb.repo, "existing.txt"), "main edit\n");
		sb.commitAll("main edit");
		const applied = await sb.cli(["apply", out.id, "--3way"], [1]);
		expect(applied.stdout).toContain("conflicts in existing.txt");
		expect(readFileSync(join(sb.repo, "existing.txt"), "utf8")).toContain("<<<<<<<");
		expect(existsSync(out.worktree as string)).toBe(true); // kept: nothing was applied cleanly
	});

	test("a binary file applies byte-for-byte", async () => {
		sb.commitAll();
		const out = await sb.runJson(["--isolate", "worktree", "hello"]);
		const bytes = Buffer.from([0, 1, 2, 255, 254, 10]);
		writeFileSync(join(out.worktree as string, "blob.bin"), bytes);
		const applied = await sb.cli(["apply", out.id]);
		expect(applied.stdout).toContain("blob.bin");
		expect([...readFileSync(join(sb.repo, "blob.bin"))]).toEqual([...bytes]);
	});

	test("--carry-dirty brings uncommitted changes into the worktree", async () => {
		sb.commitAll();
		writeFileSync(join(sb.repo, "dirty.txt"), "dirty\n");
		writeFileSync(join(sb.repo, "existing.txt"), "dirty tracked\n");
		const out = await sb.runJson(["--isolate", "worktree", "--carry-dirty", "hello"]);
		const worktree = out.worktree as string;
		expect(readFileSync(join(worktree, "dirty.txt"), "utf8")).toBe("dirty\n");
		expect(readFileSync(join(worktree, "existing.txt"), "utf8")).toBe("dirty tracked\n");
		expect(out.changed_files).toEqual([]);
		// Only the worker's own changes come back: the carried ones are already in the checkout.
		writeFileSync(join(worktree, "worker.txt"), "worker\n");
		expect((await sb.cli(["diff", out.id, "--stat"])).stdout.trim()).toBe("worker.txt");
		await sb.cli(["apply", out.id]);
		expect(readFileSync(join(sb.repo, "worker.txt"), "utf8")).toBe("worker\n");
		expect(readFileSync(join(sb.repo, "existing.txt"), "utf8")).toBe("dirty tracked\n");
	});

	test("--isolate worktree in a non-git directory is a usage error", async () => {
		const plain = join(sb.base, "plain");
		mkdirSync(plain);
		const r = await sb.cli(["run", "--isolate", "worktree", "-C", plain, "hello"], [2]);
		expect(r.stderr).toContain("needs a git repository");
	});

	test("--isolate worktree in a repo without commits is a usage error", async () => {
		const r = await sb.cli(["run", "--isolate", "worktree", "hello"], [2]);
		expect(r.stderr).toContain("at least one commit");
	});

	test("continue runs in the parent's worktree", async () => {
		sb.commitAll();
		const parent = await sb.runJson(["--isolate", "worktree", "WRITE a.txt please"]);
		const child = JSON.parse(
			(await sb.cli(["continue", parent.id, "--json", "WRITE b.txt please"])).stdout,
		) as JobJson;
		expect(child.worktree).toBe(parent.worktree as string);
		expect(child.changed_files).toEqual(["b.txt"]);
		expect(existsSync(join(child.worktree as string, "b.txt"))).toBe(true);
		expect(existsSync(join(sb.repo, "b.txt"))).toBe(false);
	});

	test("discard removes the worktree without touching the checkout", async () => {
		sb.commitAll();
		const out = await sb.runJson(["--isolate", "worktree", "WRITE gone.txt please"]);
		const path = out.worktree as string;
		const r = await sb.cli(["discard", out.id]);
		expect(r.stdout).toContain("worktree removed");
		expect(existsSync(path)).toBe(false);
		expect(sb.job(out.id)?.worktreePath).toBeNull();
		expect(existsSync(join(sb.repo, "gone.txt"))).toBe(false);
	});

	test("prune --older 0 removes finished jobs' worktrees", async () => {
		sb.commitAll();
		const out = await sb.runJson(["--isolate", "worktree", "WRITE old.txt please"]);
		const dry = await sb.cli(["prune", "--older", "0", "--dry-run"]);
		expect(dry.stdout).toContain(out.id);
		expect(existsSync(out.worktree as string)).toBe(true);

		const r = await sb.cli(["prune", "--older", "0"]);
		expect(r.stdout).toContain(out.id);
		expect(existsSync(out.worktree as string)).toBe(false);
	});
});
