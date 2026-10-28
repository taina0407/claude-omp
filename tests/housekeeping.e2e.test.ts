/** Daemon housekeeping: importing omp-task 0.2 jobs, and deleting old finished jobs. */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argAfter, Sandbox } from "./helpers";

setDefaultTimeout(60_000);

let sb: Sandbox;

beforeEach(() => {
	sb = new Sandbox();
});

afterEach(async () => {
	await sb.dispose();
});

function legacyJob(id: string, meta: Record<string, unknown>, feed: unknown[] = []): string {
	const dir = join(sb.stateDir, "jobs", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "meta.json"),
		JSON.stringify({
			id,
			version: "0.2.0",
			status: "completed",
			created_at: "2026-10-26T12:19:21+00:00",
			finished_at: "2026-10-26T12:23:20+00:00",
			cwd: sb.repo,
			title: "Old job",
			access: "edit",
			model: "smol",
			timeout: "30m",
			answer_timeout: "20m",
			session_id: "old-session",
			model_used: "fake/fake-1",
			tools: { read: 3 },
			cost_usd: 0.04,
			tokens: 1200,
			changed_files: ["a.txt"],
			...meta,
		}),
	);
	writeFileSync(join(dir, "feed.jsonl"), feed.map((e) => JSON.stringify(e)).join("\n"));
	writeFileSync(join(dir, "result.md"), "## Summary\nold report\n");
	return id;
}

describe("omp-task 0.2 jobs", () => {
	test("are imported with their numbers, report and feed", async () => {
		const id = legacyJob("20261026-191921-a9de", {}, [
			{ ts: "2026-10-26T12:19:22+00:00", job: "x", kind: "started", text: "Old job" },
			{ ts: "2026-10-26T12:23:06+00:00", job: "x", kind: "tool", text: "write: a.txt" },
		]);
		const out = JSON.parse((await sb.cli(["status", id, "--json"])).stdout);
		expect(out).toMatchObject({
			status: "completed",
			title: "Old job",
			model_used: "fake/fake-1",
			cost_usd: 0.04,
			tools: { read: 3 },
			changed_files: ["a.txt"],
			session_id: "old-session",
			created_at: "2026-10-26T12:19:21+00:00",
		});
		expect(out.result).toContain("old report");
		const feed = (await sb.cli(["watch", id, "--from-start", "--verbose"])).stdout;
		expect(feed).toContain("12:23:06 20261026-191921-a9de TOOL: write: a.txt");
		expect(feed).toContain("imported from omp-task 0.2");
		expect(sb.daemonLog()).toContain("imported omp-task 0.2 jobs");
	});

	test("an unfinished one becomes failed, and a finished one can be continued", async () => {
		const stale = legacyJob("20261026-100000-0001", { status: "running", finished_at: null });
		const done = legacyJob("20261026-100000-0002", {});
		const s = JSON.parse((await sb.cli(["status", stale, "--json"])).stdout);
		expect(s.status).toBe("failed");
		expect(s.errors.join(" ")).toContain("supervisor is gone");
		writeFileSync(sb.env.FAKE_OMP_SESSIONS as string, "old-session\n");
		const child = JSON.parse((await sb.cli(["continue", done, "--json", "go on"])).stdout);
		expect(child.status).toBe("completed");
		expect(argAfter(sb.ompArgv(), "--resume")).toBe("old-session");
	});
});

describe("retention", () => {
	test("prune --jobs deletes old finished jobs and their files", async () => {
		const job = await sb.runJson(["hello"]);
		const dir = join(sb.stateDir, "jobs", job.id);
		expect(existsSync(dir)).toBe(true);
		await Bun.sleep(1_100);
		const dry = await sb.cli(["prune", "--jobs", "--older", "1", "--dry-run"]);
		expect(dry.stdout.trim()).toBe(job.id);
		expect(existsSync(dir)).toBe(true);
		await sb.cli(["prune", "--jobs", "--older", "1"]);
		expect(existsSync(dir)).toBe(false);
		expect((await sb.cli(["status", job.id], [2])).stderr).toContain("no job matching");
	});

	test("the daemon applies job_retention when it starts, but keeps worktree jobs", async () => {
		sb.commitAll();
		const plain = await sb.runJson(["hello"]);
		const isolated = await sb.runJson(["--isolate", "worktree", "WRITE w.txt"]);
		await sb.cli(["daemon", "stop"]);
		sb.writeConfig({ job_retention: "1s" });
		await Bun.sleep(1_100);
		await sb.cli(["list"]);
		expect(sb.job(plain.id)).toBeNull();
		expect(sb.job(isolated.id)?.status).toBe("completed");
		expect(sb.daemonLog()).toContain("deleted old jobs");
	});
});
