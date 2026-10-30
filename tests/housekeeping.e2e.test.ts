/** Daemon housekeeping: deleting old finished jobs, and how much of each job is kept. */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Sandbox } from "./helpers";

setDefaultTimeout(60_000);

let sb: Sandbox;

beforeEach(() => {
	sb = new Sandbox();
});

afterEach(async () => {
	await sb.dispose();
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

describe("event log", () => {
	test("keeps the protocol frames by default, and none with event_log off", async () => {
		const logged = await sb.runJson(["hello"]);
		expect(existsSync(join(sb.stateDir, "jobs", logged.id, "events.jsonl"))).toBe(true);
		await sb.cli(["daemon", "stop"]);
		sb.writeConfig({ event_log: "off" });
		const quiet = await sb.runJson(["hello"]);
		expect(quiet.status).toBe("completed");
		expect(existsSync(join(sb.stateDir, "jobs", quiet.id, "events.jsonl"))).toBe(false);
	});
});
